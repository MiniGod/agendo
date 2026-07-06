// Thin wrapper around the tmux CLI. The launcher owns a naming convention
// (`cl-…`) so it can tell whether a given agent already has a live tmux target
// and navigate to it. A managed agent runs as either a tmux *session* (when the
// launcher was started outside tmux) or a *window* in the current session (when
// started inside tmux) — see launch.ts for which path is chosen.
//
// The `--tmux` CLI flag bootstraps a single canonical session (LAUNCHER_SESSION)
// whose first window runs the menu, so every agent ends up as a tab next to it.
import { spawnSync } from "child_process";
import type { AgentSession } from "./types.ts";

/**
 * The default host session the `--tmux` flag creates/attaches when the launcher
 * is unscoped (bare `agendo`). Path-scoped launchers derive their own host
 * session name (see context.ts), so every launcher-session helper below takes an
 * explicit session param defaulting to this — keeping the bare-`agendo` path
 * byte-identical to before.
 */
export const LAUNCHER_SESSION = "agendo";

/**
 * tmux *session* option storing the absolute path a launcher host session is
 * scoped to. Set once when the session is created; read to detect basename
 * collisions (two different roots wanting the same host session name).
 */
export const ROOT_OPTION = "@cl_root";

/**
 * tmux *window* user-option that flags a restored-but-unopened placeholder
 * window (see restore.ts). Set on the window when a lazy tab is recreated and
 * cleared by the placeholder's own script the moment it resumes for real, so
 * `refreshLiveTmux` can keep an idle placeholder out of the live set even though
 * its window carries the canonical `cl-<source>-<id>` name.
 */
export const PLACEHOLDER_OPTION = "@cl_placeholder";

export function tmuxAvailable(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
}

export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

/** The short, tmux-safe slice of a session id used in every managed name. */
export function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

/** Deterministic tmux session/window name for an agent session. */
export function sessionName(s: Pick<AgentSession, "source" | "id">): string {
  return `cl-${s.source}-${shortId(s.id)}`;
}

/**
 * How a managed tmux target was launched, inferred from its name prefix. Lets
 * the UI badge sessions and the model attribute live windows back to a session.
 * `cl-free-` is the pre-rename manual prefix, still recognized so older windows
 * keep working.
 */
export type SessionKind = "background" | "new" | "workitem" | "pr" | "resumed";

/** Name prefixes for the two id-bearing launcher flows. */
const KIND_PREFIX = { background: "cl-bg-", new: "cl-new-" } as const;

/** tmux target name for a background (agent-spawned) or manual new session. */
export function kindName(kind: "background" | "new", id: string): string {
  return KIND_PREFIX[kind] + shortId(id);
}

/** Classify a managed (`cl-…`) target name by its prefix, or null if unknown. */
export function managedKind(name: string): SessionKind | null {
  if (name.startsWith(KIND_PREFIX.background)) return "background";
  if (name.startsWith(KIND_PREFIX.new) || name.startsWith("cl-free-")) return "new";
  if (name.startsWith("cl-wi-")) return "workitem";
  if (name.startsWith("cl-pr-")) return "pr";
  if (name.startsWith("cl-claude-") || name.startsWith("cl-copilot-")) return "resumed";
  return null;
}

/**
 * A live managed target whose name embeds this session short id under any
 * id-bearing kind prefix (`cl-claude-`, `cl-copilot-`, `cl-bg-`, `cl-new-`) — so
 * attach can navigate to the *actual* window a session runs in, whatever name it
 * was launched under, instead of creating a duplicate. Work-item / PR targets
 * embed an item id rather than a session id, so they're intentionally excluded.
 */
export function liveTargetForShortId(sid: string): string | null {
  for (const name of liveTargets()) {
    const m = name.match(/^cl-(?:claude|copilot|bg|new)-(.+)$/);
    if (m && m[1] === sid) return name;
  }
  return null;
}

/** Raw visible text of a target's active pane, including SGR escape codes. */
export function capturePane(target: string): string {
  const r = spawnSync("tmux", ["capture-pane", "-p", "-e", "-t", target], { encoding: "utf-8" });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

/** Strip ANSI SGR escape sequences, for plain-text display / matching. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Type `text` into a target pane and submit it. Uses a bracketed paste so the
 * claude TUI receives multi-line text as one paste (newlines don't submit
 * early), then a single Enter to send.
 */
export function sendToPane(target: string, text: string): void {
  tmuxQuiet(["set-buffer", "-b", "cl-send", "--", text]);
  tmuxQuiet(["paste-buffer", "-p", "-d", "-b", "cl-send", "-t", target]);
  tmuxQuiet(["send-keys", "-t", target, "Enter"]);
}

/** Whether a captured claude TUI pane can accept a freshly-sent prompt. */
export type Readiness = "ready" | "busy" | "compacting" | "queued" | "dialog" | "unknown";

/**
 * Real (user-typed) text on the claude input line, ignoring the `❯` marker and
 * any gray/dim *suggestion* placeholder. The TUI renders a suggestion in faint
 * (`\e[2m`) / gray, and real text in the default color — so we count only
 * non-faint, non-gray glyphs. Expects the raw line *with* SGR escapes; returns
 * "" when the input is effectively empty (blank or only a suggestion).
 */
function inputRealText(line: string): string {
  const after = line.split("❯")[1] ?? "";
  let faint = false;
  let gray = false;
  let out = "";
  const re = /\x1b\[([0-9;]*)m|([^\x1b]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(after))) {
    if (m[1] !== undefined) {
      const codes = m[1].split(";");
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === "0" || c === "") faint = gray = false;
        else if (c === "2") faint = true;
        else if (c === "22") faint = false;
        else if (c === "39") gray = false;
        else if (c === "90") gray = true;
        else if ((c === "38" || c === "48") && codes[i + 1] === "5") {
          // 256-color: consume `38;5;n` so the `5` selector isn't read as faint.
          if (c === "38") {
            const n = Number(codes[i + 2]);
            gray = n === 8 || (n >= 236 && n <= 250);
          }
          i += 2;
        } else if ((c === "38" || c === "48") && codes[i + 1] === "2") {
          // truecolor: consume `38;2;r;g;b` so the `2` selector isn't read as faint.
          if (c === "38") {
            const r = Number(codes[i + 2]);
            const g = Number(codes[i + 3]);
            const b = Number(codes[i + 4]);
            gray = r === g && g === b && r >= 90 && r <= 200;
          }
          i += 4;
        } else if (/^(3[0-7]|9[0-6])$/.test(c)) gray = false;
      }
    } else if (m[2] && !faint && !gray) {
      out += m[2];
    }
  }
  return out.trim();
}

/**
 * Classify a captured claude TUI pane to decide whether it's safe to send a
 * prompt. Conservative: only "ready" is auto-sendable; everything else (a turn
 * generating → "busy", conversation being compacted → "compacting", unsent text
 * already in the box → "queued", an open question/menu → "dialog", or an
 * unrecognized screen → "unknown") is left for the caller to handle. Calibrated
 * against the real TUI:
 *  - Generating: a live spinner shows a time/token counter, e.g.
 *    `✢ Tinkering… (58s · ↓ 3.9k tokens)` — the counter (not an "esc to
 *    interrupt" hint, which this version omits) is the reliable busy signal.
 *  - The input box is drawn between two long `─` rules with a `❯` prompt; the
 *    *last* two rules in the capture are its borders. We anchor on those rather
 *    than a fixed offset, because sub-agent status lines (`● main`, `◯ …`) can
 *    render below the mode bar. The box can be empty even while busy, so busy is
 *    checked first and independently.
 * `raw` must include SGR escapes (see `capturePane`). Busy/dialog use specific,
 * transient markers so scanning the whole visible screen is safe: claude's prose
 * questions don't match them, and while a *finished* turn keeps a token count in
 * its result summary (`✔ Goal achieved (1m · 1 turn · 4.6k tokens)`), that
 * summary never carries the live counter's directional ↑/↓ arrow — which the
 * busy check requires — so an idle post-turn pane isn't mistaken for a live one.
 */
export function paneReadiness(raw: string): Readiness {
  const plain = stripAnsi(raw);
  // Compacting the conversation — a distinct, blocking state. Must be checked
  // *before* the input-box read below: compaction shows no token counter and no
  // "esc to interrupt" hint, and leaves the box empty, so it would otherwise
  // fall through every busy/dialog check and misclassify as "ready" — letting a
  // prompt be sent mid-compaction. The spinner verb line reads
  // `✻ Compacting conversation…` above a `▰▰▱▱ N%` progress bar.
  if (/compacting conversation/i.test(plain)) return "compacting";
  // Actively generating — a live token/time counter (or an interrupt hint).
  // The counter always wears a directional ↑/↓ arrow (bytes flowing this turn):
  // `✢ Tinkering… (58s · ↓ 3.9k tokens)`. That arrow is the load-bearing
  // distinction from a FINISHED-turn *result* summary — `✔ Goal achieved (1m ·
  // 1 turn · 4.6k tokens)` — which wears the identical `(<time> · … tokens)`
  // shape (and leads with a ✔/✗ glyph + an "N turn(s)" count) but never an
  // arrow. So both checks REQUIRE the arrow: matching the bare parenthesized
  // shape alone read an idle, done-with-its-turn pane as "busy" and blocked
  // `agendo send`.
  if (
    /[↑↓]\s*[\d.,]+\s*k?\s*tokens?\b/i.test(plain) ||
    /\(\s*\d[^)]*[↑↓][^)]*\btokens?\b[^)]*\)/i.test(plain) ||
    /esc to interrupt/i.test(plain)
  )
    return "busy";
  // An open interactive menu / confirmation (not mere prose — these footers and
  // the numbered selection cursor only appear in real dialogs).
  if (/Enter to confirm|Esc to (reject|cancel|go back)|Press Enter to continue/i.test(plain) || /^\s*❯\s*\d+\.\s/m.test(plain))
    return "dialog";
  // Read the input box: the lines between the last two horizontal rules.
  const lines = raw.replace(/\r/g, "").split("\n");
  const rules = lines.flatMap((l, i) => (/─{20,}/.test(l) ? [i] : []));
  if (rules.length === 0) return "unknown";
  const bottom = rules[rules.length - 1];
  const top = rules.length >= 2 ? rules[rules.length - 2] : bottom - 2;
  const input = lines.slice(top + 1, bottom).join("\n");
  if (!input.includes("❯")) return "unknown";
  return inputRealText(input) === "" ? "ready" : "queued";
}

/**
 * Number of background shells the session has running, read from the TUI's
 * `· N shell(s) ·` indicator (the footer's clickable "view background shells"
 * button, also echoed in the turn summary as `N shell still running`). This is
 * orthogonal to readiness — a session can be busy *or* idle while a background
 * shell keeps working, most notably a monitor (an `until` loop that re-wakes
 * claude). Anchored on the leading middot `·` (U+00B7, the TUI's separator —
 * never the bullet `•`) so prose mentioning "shell" doesn't count.
 * Returns 0 when none are shown.
 */
export function paneShells(raw: string): number {
  let max = 0;
  const re = /·\s*(\d+)\s+shells?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripAnsi(raw)))) max = Math.max(max, Number(m[1]));
  return max;
}

function tmuxLines(args: string[]): string[] {
  const r = spawnSync("tmux", args, { encoding: "utf-8" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Names of all currently live tmux sessions (empty if no server running). */
export function liveSessions(): Set<string> {
  return new Set(tmuxLines(["list-sessions", "-F", "#{session_name}"]));
}

/** Names of all windows across all sessions. */
export function liveWindows(): Set<string> {
  return new Set(tmuxLines(["list-windows", "-a", "-F", "#{window_name}"]));
}

/** Union of live session and window names — every managed target that's live. */
export function liveTargets(): Set<string> {
  const s = liveSessions();
  for (const w of liveWindows()) s.add(w);
  return s;
}

/**
 * Every live managed (`cl-…`) target paired with the working directory of its
 * pane. A pane contributes its session name and/or window name, whichever is a
 * managed target. Used to attribute fresh-launch targets — named after a work
 * item / PR (`cl-wi-…`, `cl-pr-…`) rather than a session id — back to the
 * session actually running in them, so they register as running.
 */
export function liveManagedPaths(): { name: string; cwd: string; placeholder: boolean }[] {
  const out: { name: string; cwd: string; placeholder: boolean }[] = [];
  for (const line of tmuxLines([
    "list-panes",
    "-a",
    "-F",
    `#{session_name}\t#{window_name}\t#{pane_current_path}\t#{?${PLACEHOLDER_OPTION},1,0}`,
  ])) {
    const [session, window, cwd, placeholder] = line.split("\t");
    if (!cwd) continue;
    // The marker is a *window* option, so it only attributes to the window name
    // (a restored placeholder is always a window); a managed session name is
    // never a placeholder.
    for (const [name, isPlaceholder] of [[session, false], [window, placeholder === "1"]] as const) {
      if (name?.startsWith("cl-")) out.push({ name, cwd, placeholder: isPlaceholder });
    }
  }
  return out;
}

export function hasSession(name: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", name]).status === 0;
}

/** The tmux session the caller is currently inside, or null (outside tmux). */
export function currentSessionName(): string | null {
  if (!insideTmux()) return null;
  const r = spawnSync("tmux", ["display-message", "-p", "#{session_name}"], { encoding: "utf-8" });
  const name = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return name || null;
}

/** The absolute root a launcher host session is scoped to (`@cl_root`), or null. */
export function sessionRoot(session: string): string | null {
  const r = spawnSync("tmux", ["show-options", "-t", session, "-v", ROOT_OPTION], { encoding: "utf-8" });
  const v = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return v || null;
}

/** Record the absolute root a launcher host session is scoped to (`@cl_root`). */
export function setSessionRoot(session: string, root: string): void {
  tmuxQuiet(["set-option", "-t", session, ROOT_OPTION, root]);
}

/** Kill the window/target `name` (no-op if it doesn't exist). Used to clear a
 *  dormant restore placeholder before a headless resume recreates it for real. */
export function killWindow(name: string): void {
  tmuxQuiet(["kill-window", "-t", name]);
}

/**
 * Live windows of a launcher host session, each paired with the working
 * directory of its active pane. Dead windows (a `remain-on-exit` corpse) are
 * skipped. Empty if the session isn't running. Used to snapshot the open agent
 * tabs for browser-style restore (see restore.ts).
 */
export function launcherWindowPaths(session: string = LAUNCHER_SESSION): { name: string; cwd: string }[] {
  const out: { name: string; cwd: string }[] = [];
  for (const line of tmuxLines([
    "list-windows",
    "-t",
    session,
    "-F",
    "#{window_name}\t#{pane_current_path}\t#{pane_dead}",
  ])) {
    const [name, cwd, dead] = line.split("\t");
    if (dead === "1" || !cwd) continue;
    out.push({ name, cwd });
  }
  return out;
}

/** `session:window_index` of the first window named `name`, or null. */
export function windowLocation(name: string): string | null {
  for (const line of tmuxLines(["list-windows", "-a", "-F", "#{session_name}:#{window_index}\t#{window_name}"])) {
    const [loc, wname] = line.split("\t");
    if (wname === name) return loc;
  }
  return null;
}

/**
 * Create a detached tmux session named `name` running `argv` in `cwd`.
 * No-op if it already exists. Used when the launcher runs outside tmux.
 */
export function newDetached(name: string, cwd: string, argv: string[]): void {
  if (hasSession(name)) return;
  spawnSync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, "--", ...argv], { stdio: "inherit" });
}

/**
 * Flag a window as an unloaded restore placeholder via the `@cl_placeholder`
 * window option (see PLACEHOLDER_OPTION). `target` is a `session:window` ref.
 */
export function markPlaceholder(target: string): void {
  tmuxQuiet(["set-option", "-w", "-t", target, PLACEHOLDER_OPTION, "1"]);
}

/** Pin a window's name so neither tmux nor the program inside can rename it. */
function pinName(target: string): void {
  tmuxQuiet(["set-window-option", "-t", target, "automatic-rename", "off"]);
  tmuxQuiet(["set-window-option", "-t", target, "allow-rename", "off"]);
}

/**
 * Run a tmux control command silently. Safe to call while Ink owns the terminal
 * (we don't inherit stdio), so the menu can open windows without unmounting.
 */
export function tmuxQuiet(args: string[]): void {
  spawnSync("tmux", args, { stdio: "ignore" });
}

/**
 * Create a detached window named `name` in the current session running `argv`
 * in `cwd`, and pin its name (disable tmux's automatic/program renaming) so the
 * launcher can still recognize it later. Used when running inside tmux.
 */
export function newWindow(name: string, cwd: string, argv: string[]): void {
  tmuxQuiet(["new-window", "-d", "-n", name, "-c", cwd, "--", ...argv]);
  pinName(name);
}

/**
 * Like `newWindow`, but targets a specific (named) session rather than the
 * current one — needed when restoring tabs into the canonical session from the
 * `--tmux` bootstrap process, which isn't itself inside that session.
 */
export function newWindowIn(session: string, name: string, cwd: string, argv: string[]): void {
  tmuxQuiet(["new-window", "-d", "-t", session, "-n", name, "-c", cwd, "--", ...argv]);
  pinName(`${session}:${name}`);
}

/**
 * Whether a launcher host session currently has a live window running the menu.
 * The menu window is pinned to the name "launcher"; tmux destroys a window when
 * its program exits (default `remain-on-exit off`), so a missing — or dead, if a
 * config kept it around — "launcher" window means the menu isn't running.
 */
export function launcherWindowLive(session: string = LAUNCHER_SESSION): boolean {
  for (const line of tmuxLines(["list-windows", "-t", session, "-F", "#{window_name}\t#{pane_dead}"])) {
    const [name, dead] = line.split("\t");
    if (name === "launcher" && dead !== "1") return true;
  }
  return false;
}

/**
 * (Re)create the menu window inside a launcher host session, preferring index 0
 * so it sits at the front the way the original first window did; if 0 is taken,
 * let tmux pick the next free index. Any leftover (dead) "launcher" window is
 * cleared first so we never end up with two. Detached — the caller selects/
 * attaches after.
 */
function spawnLauncherWindow(session: string, cwd: string, launcherArgv: string[]): void {
  tmuxQuiet(["kill-window", "-t", `${session}:launcher`]); // no-op if none exists
  const at0 = spawnSync(
    "tmux",
    ["new-window", "-d", "-t", `${session}:0`, "-n", "launcher", "-c", cwd, "--", ...launcherArgv],
    { stdio: "ignore" },
  );
  if (at0.status !== 0) {
    spawnSync(
      "tmux",
      ["new-window", "-d", "-t", session, "-n", "launcher", "-c", cwd, "--", ...launcherArgv],
      { stdio: "ignore" },
    );
  }
  pinName(`${session}:launcher`);
}

/**
 * Bring the user into a launcher host session, creating it (with its first
 * window running `launcherArgv`) if it doesn't exist yet. Backs the `--tmux`
 * flag. Outside tmux this attaches (blocks until you detach); inside tmux it
 * switches the current client to the host session. Defaults to the canonical
 * `agendo` session (bare `agendo`); a path-scoped launcher passes its own name.
 *
 * If the session exists but its menu window is gone (e.g. the user quit the
 * launcher while agent windows kept the session alive), the menu is recreated —
 * so `--tmux` is always a way *back into* the launcher, not just an attach to a
 * launcher-less session. The client always lands on the menu window itself.
 *
 * When the session is created fresh and `root` is non-null (a path-scoped
 * launcher), the absolute root is recorded as `@cl_root` so a later attach can
 * detect a basename collision.
 *
 * `onFreshCreate` runs once, only when the session is created from scratch — the
 * moment to lazily restore previously-open agent tabs (see restore.ts). It's
 * skipped when attaching to an existing session, whose windows are already live.
 * Kept as a callback so tmux.ts stays free of a restore.ts import (restore.ts
 * depends on tmux.ts).
 */
export function enterLauncherSession(
  session: string,
  root: string | null,
  cwd: string,
  launcherArgv: string[],
  onFreshCreate?: () => void,
): void {
  if (!hasSession(session)) {
    spawnSync(
      "tmux",
      ["new-session", "-d", "-s", session, "-n", "launcher", "-c", cwd, "--", ...launcherArgv],
      { stdio: "inherit" },
    );
    pinName(`${session}:launcher`);
    if (root) setSessionRoot(session, root);
    onFreshCreate?.();
  } else if (!launcherWindowLive(session)) {
    spawnLauncherWindow(session, cwd, launcherArgv);
  }
  // Land on the menu window specifically, not whatever window was last active.
  tmuxQuiet(["select-window", "-t", `${session}:launcher`]);
  const verb = insideTmux() ? ["switch-client"] : ["attach-session"];
  spawnSync("tmux", [...verb, "-t", session], { stdio: "inherit" });
}

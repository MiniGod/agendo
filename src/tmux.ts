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
import { isUsageLimited, isLimitDialog } from "./usageLimit.ts";

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

/** Name prefixes for the two kind-tagged launcher flows. */
const KIND_PREFIX = { background: "cl-bg-", new: "cl-new-" } as const;

/**
 * Managed names that carry a session short id.
 *
 * The suffix must be short-id SHAPED — `shortId` strips every non-alphanumeric
 * character and caps at 12, so a real id can only ever be `[a-zA-Z0-9]{1,12}`.
 * Anchoring on that is what lets `kindName` mint a deliberately ID-LESS fresh
 * name (see its `tag` parameter): the extra `<tag>-` segment contains a dash, so
 * the name falls out of this pattern and attribution takes the cwd route that
 * `cl-wi-…`/`cl-pr-…` already use. Shared with restore.ts's ID_BEARING.
 */
export const ID_BEARING_NAME = /^cl-(?:claude|copilot|codex|bg|new)-([a-zA-Z0-9]{1,12})$/;

/**
 * tmux target name for a background (agent-spawned) or manual new session.
 *
 * `tag`, when given, inserts a `<tag>-` segment before the id and thereby makes
 * the name id-LESS as far as `ID_BEARING_NAME` is concerned. That's for agents
 * whose CLI can't be told a session id up front (Codex): the id we mint is only
 * a uniquifier for the window, and must not be mistaken for a resumable session
 * id — the real one is discovered from disk and matched by cwd instead.
 */
export function kindName(kind: "background" | "new", id: string, tag?: string): string {
  return KIND_PREFIX[kind] + (tag ? `${tag}-` : "") + shortId(id);
}

/** Classify a managed (`cl-…`) target name by its prefix, or null if unknown. */
export function managedKind(name: string): SessionKind | null {
  if (name.startsWith(KIND_PREFIX.background)) return "background";
  if (name.startsWith(KIND_PREFIX.new) || name.startsWith("cl-free-")) return "new";
  if (name.startsWith("cl-wi-")) return "workitem";
  if (name.startsWith("cl-pr-")) return "pr";
  if (name.startsWith("cl-claude-") || name.startsWith("cl-copilot-") || name.startsWith("cl-codex-")) return "resumed";
  return null;
}

/**
 * A live managed target: the bare `name` it is known and attributed by, and the
 * fully-qualified `target` that addresses it from ANY host session.
 *
 * These are NOT interchangeable, and conflating them is what #39 was: tmux
 * resolves a bare window-name target only inside the caller's own session, so
 * with several launcher hosts live, every read of a window in another host
 * failed and readiness fell through to `unknown` — `list`/`status` reported a
 * whole host's sessions as unknown, and `close`/`unblock` refused targets they
 * "could not read".
 *
 * `name` stays the attribution and display key (`windowLocations`,
 * `killManagedTarget`, `openTarget`, restore snapshots and user-facing output
 * are all written against it); `target` is the only form that may be handed to
 * tmux as `-t`. Carrying both makes a caller say which it means.
 */
export interface LiveTarget {
  name: string;
  target: string;
}

/** A `LiveTarget` paired with the working directory of the pane running in it. */
export interface ManagedTarget extends LiveTarget {
  cwd: string;
  placeholder: boolean;
}

/**
 * A live managed target whose name embeds this session short id under any
 * id-bearing kind prefix (`cl-claude-`, `cl-copilot-`, `cl-codex-`, `cl-bg-`,
 * `cl-new-`) — so attach can navigate to the *actual* window a session runs in,
 * whatever name it was launched under, instead of creating a duplicate.
 * Work-item / PR targets embed an item id rather than a session id, and tagged
 * id-less fresh names carry no session id at all, so both are excluded.
 */
export function liveTargetForShortId(sid: string): LiveTarget | null {
  for (const [name, target] of liveTargets()) {
    const m = name.match(ID_BEARING_NAME);
    if (m && m[1] === sid) return { name, target };
  }
  return null;
}

/**
 * Raw visible text of a target's active pane, or null when tmux could not read
 * it at all (unresolvable target, a pane that exited between the listing and
 * this call, a server too busy to answer). That is NOT the same as a pane that
 * is simply blank, and a caller about to do something destructive has to tell
 * the two apart — see `readPaneState`.
 */
function capturePaneRaw(target: string): string | null {
  const r = spawnSync("tmux", ["capture-pane", "-p", "-e", "-t", target], { encoding: "utf-8" });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

/** Raw visible text of a target's active pane, including SGR escape codes. */
export function capturePane(target: string): string {
  return capturePaneRaw(target) ?? "";
}

/**
 * Where a pane's caret sits, in pane-relative cells: row 0 is the top visible
 * row — the same origin `capture-pane` uses for its first output line — so `y`
 * indexes straight into a capture's lines.
 */
export interface PaneCursor {
  x: number;
  y: number;
}

/**
 * Cursor position of a target's active pane, or null when tmux can't report it
 * (no such target, or a stub/older tmux that doesn't answer the format). Callers
 * treat null as "no cursor evidence" and fall back to the color-based read — see
 * `inputEmpty`.
 */
function paneCursor(target: string): PaneCursor | null {
  const r = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{cursor_x} #{cursor_y}"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const m = (r.stdout ?? "").trim().match(/^(\d+)\s+(\d+)$/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/** A pane's visible text paired with the caret position captured alongside it. */
export interface PaneSnapshot {
  /** `capture-pane -p -e` output — SGR escapes intact. */
  raw: string;
  /** Caret position, or null when tmux couldn't report one. */
  cursor: PaneCursor | null;
}

/**
 * Snapshot a pane: its visible text plus its caret. Every call site that judges
 * readiness should use this rather than a bare `capturePane`, since the caret is
 * half the evidence (see `inputEmpty`).
 *
 * Two separate tmux reads, so the halves can be skewed by whatever the pane did
 * in between — including a paint in progress, which parks the grid cursor
 * wherever the TUI's output stream has reached rather than where it will rest.
 * That makes the caret a BEST-EFFORT signal, not a proof: `inputEmpty` accepts it
 * only at the exact resting column of an untouched prompt, which is the narrowest
 * test that still recognizes a suggestion, not an airtight one. tmux can serve
 * both reads in one invocation (`display-message … \; capture-pane …`); kept as
 * two calls because `display-message` is a cheap one-line read next to dumping
 * the whole screen, and the combined form's output shape is one more thing to get
 * wrong.
 */
export function capturePaneState(target: string): PaneSnapshot {
  return { raw: capturePane(target), cursor: paneCursor(target) };
}

/**
 * `capturePaneState`, but null when tmux could not read the pane AT ALL rather
 * than an empty snapshot.
 *
 * The distinction only matters where a missing read is dangerous. Readiness is
 * classified from the screen, and an empty screen classifies as `unknown` — fine
 * for a caller that only reports it, wrong for one that acts on it: `agendo
 * close` treats `unknown` as "nothing in flight", so a read that merely FAILED
 * would silently disarm the guard and kill a session mid-turn. Callers that just
 * display a state keep using `capturePaneState`.
 */
export function readPaneState(target: string): PaneSnapshot | null {
  const raw = capturePaneRaw(target);
  return raw === null ? null : { raw, cursor: paneCursor(target) };
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

/**
 * The tmux `send-keys` argv sequence that nudges a usage-limited session to
 * resume: press Escape, type `continue`, then Enter. `-l` forces "continue" to be
 * sent as literal characters, not looked up as a key name. Split from the runner
 * (`sendResume`) so it can be asserted directly in tests without touching a real
 * tmux server.
 *
 * VERIFIED against the live limited pane, one keystroke at a time: on the numbered
 * limit DIALOG a single Escape dismisses the menu and drops back to an empty input
 * box (revealing the "resets <time>" text as a ⎿ result above it); the literal
 * `continue` then lands in that box; Enter sends it. The leading Escape is thus
 * load-bearing for the dialog form (dismiss the modal before typing) and harmless
 * for the plain text form (clears any stray partial input).
 */
export function resumeKeystrokes(target: string): string[][] {
  return [
    ["send-keys", "-t", target, "Escape"],
    ["send-keys", "-t", target, "-l", "continue"],
    ["send-keys", "-t", target, "Enter"],
  ];
}

/**
 * Gap between the resume keystrokes. Sent back-to-back, the three `send-keys`
 * writes coalesce in the pane's pty and the TUI reads `ESC` + `c` in ONE chunk —
 * which every terminal input parser means Alt+c — so the `c` was eaten and the
 * pane received "ontinue" (observed live on the first real auto-resume fire).
 * Any real gap makes the reads distinct; 150ms is imperceptible next to the
 * seconds-scale poll cadence.
 */
export const RESUME_KEY_DELAY_MS = 150;

/** Synchronous sleep that works under both bun and node (the sender is sync). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Send the resume keystrokes (`<esc>continue<enter>`) to a target pane, with a
 * RESUME_KEY_DELAY_MS pause between them (see above — Escape must arrive in its
 * own read or it turns the following `c` into Alt+c).
 */
export function sendResume(target: string): void {
  resumeKeystrokes(target).forEach((argv, i) => {
    if (i > 0) sleepSync(RESUME_KEY_DELAY_MS);
    tmuxQuiet(argv);
  });
}

/**
 * The `send-keys` argv for the dialog-reveal nudge: a SINGLE Escape. On the
 * numbered limit dialog this dismisses the menu and reveals the "resets <time>"
 * notice (verified live) — the timestamp the dialog itself hides — so the next
 * poll can parse and freeze a reset instant and the normal auto-resume machinery
 * can fire. Deliberately just Escape: no `continue` is sent on the reveal tick.
 * Split from the runner so it can be asserted directly in tests.
 */
export function dialogRevealKeystrokes(target: string): string[][] {
  return [["send-keys", "-t", target, "Escape"]];
}

/** Send the dialog-reveal nudge (a single `<esc>`) to a target pane. */
export function sendDialogReveal(target: string): void {
  for (const argv of dialogRevealKeystrokes(target)) tmuxQuiet(argv);
}

/** Whether a captured agent TUI pane can accept a freshly-sent prompt. */
export type Readiness = "ready" | "busy" | "compacting" | "queued" | "dialog" | "limited" | "unknown";

/** The glyph each agent's TUI draws in front of its input line. */
const CLAUDE_PROMPT = "❯";
const CODEX_PROMPT = "›"; // U+203A — also codex's list cursor, see codexInputBox

/**
 * The readiness states that mean the agent is actively working right now.
 * Canonical here (next to the type) because two unrelated features key off the
 * same distinction: `agendo wait`'s default "still busy" predicate (see
 * wait.ts) and the stalled-session qualifier (see idle.ts), neither of which may
 * ever treat a session that is simply mid-turn as finished.
 */
const WORKING_READINESS: ReadonlySet<Readiness> = new Set<Readiness>(["busy", "compacting"]);

/**
 * States the settled test refuses, even though neither is "busy":
 *  - `unknown` — a pane we couldn't read. Treating it as settled reports a false
 *    success off a blank or not-yet-drawn screen: `agendo wait` would return
 *    "done" for a session it merely failed to read, and the stall qualifier would
 *    pass a verdict on a session it never saw. Absence of evidence that a session
 *    is working is not evidence that it has stopped.
 *  - `limited` — a session parked at its usage cap. It has stopped, but it is not
 *    DONE: it resumes when the cap lifts (auto-resume) or when someone unblocks
 *    it, and its work is still unfinished. `wait` exiting 0 there would tell an
 *    orchestrator "finished" about work that is merely paused; the stall marker
 *    would call it hung when it is waiting on a quota reset whose time `list`
 *    prints right next to it. `wait` doesn't wait it out in silence — it wakes on
 *    a capped target at once with `woke: "blocked"` and a non-zero exit — and an
 *    explicit `--state limited` still treats the cap as the success condition.
 */
const NOT_SETTLED: ReadonlySet<Readiness> = new Set<Readiness>(["unknown", "limited"]);

/**
 * Whether a state is *known, settled and unblocked*: not working, not unreadable,
 * not parked at a usage cap.
 *
 * This is the READINESS half of the question only, and module-private for that
 * reason. Everything that really wants "has this session stopped working?" asks
 * `sessionFinished` below instead: readiness alone stopped answering it when #44
 * split the flag, because the main agent can be back at its prompt while a
 * subagent it spawned runs on.
 *
 * Note `wait` also admits its synthetic `exited` state through this (neither
 * working nor in NOT_SETTLED), which is correct: a session whose window is gone is
 * as settled as it will ever get.
 */
function isSettledReadiness(r: Readiness): boolean {
  return !WORKING_READINESS.has(r) && !NOT_SETTLED.has(r);
}

/**
 * Whether a session has stopped working — the whole question, both halves.
 *
 * Readiness describes the MAIN agent, and after #44 that is deliberately all it
 * describes: a session whose subagent is still running reads `ready`, because the
 * prompt genuinely is accepting input and `agendo send` must reach it. It is not
 * finished, though. Two callers ask exactly this question and so ask it here,
 * rather than each pairing readiness with its own lookalike count check:
 *
 *  - `agendo wait`'s default predicate (wait.ts) — whether to settle.
 *  - the stalled-session qualifier (idle.ts) — whether to print `⚠stalled`.
 *
 * `agendo close`'s work-in-flight guard is a THIRD consumer of the same count but
 * deliberately not a caller of this: it asks "would ending this lose something?",
 * which is a different question with a different state set (it refuses `queued`
 * and `dialog`, which both of the above consider done). It pairs its own states
 * with the same `paneBackgroundAgents` read — see UNSAFE_CLOSE_STATES. Missing it
 * on the first pass would have hard-killed a session whose subagent was mid-write,
 * which is the most expensive way for these three to disagree.
 */
export function sessionFinished(r: Readiness, backgroundAgents: number): boolean {
  return isSettledReadiness(r) && backgroundAgents === 0;
}

/**
 * Real (user-typed) text on an input line, ignoring the prompt `marker` and any
 * gray/dim *placeholder*. Both TUIs render their placeholder faint (`\e[2m`) or
 * gray and real text in the default color — claude an autocomplete suggestion,
 * codex a rotating example prompt — so we count only non-faint, non-gray
 * glyphs. Expects the raw line *with* SGR escapes; returns "" when the input is
 * effectively empty (blank or only a placeholder).
 */
function inputRealText(line: string, marker: string = CLAUDE_PROMPT): string {
  const after = line.split(marker)[1] ?? "";
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
 * Classify a captured agent TUI pane to decide whether it's safe to send a
 * prompt. Codex panes are recognised and handed to `codexReadiness`; the rest
 * of this function is the claude classifier.
 *
 * Conservative: only "ready" is auto-sendable; everything else (a turn
 * generating → "busy", conversation being compacted → "compacting", unsent text
 * already in the box → "queued", an open question/menu → "dialog", or an
 * unrecognized screen → "unknown") is left for the caller to handle. The one
 * exception, checked before all of those, is the CLI's own resume dialog: it
 * reports "ready" without an input box behind it (see paneResumeDialogActive and
 * paneAcceptsPaste). Calibrated
 * against the real TUI:
 *  - Generating: a live spinner shows a time/token counter, e.g.
 *    `✢ Tinkering… (58s · ↓ 3.9k tokens)` — the counter (not an "esc to
 *    interrupt" hint, which this version omits) is the reliable busy signal.
 *  - The input box is drawn between two long `─` rules with a `❯` prompt; the
 *    *last* two rules in the capture are its borders. We anchor on those rather
 *    than a fixed offset, because sub-agent status lines (`● main`, `◯ …`) can
 *    render below the mode bar. The box can be empty even while busy, so busy is
 *    checked first and independently.
 * `raw` must include SGR escapes (see `capturePane`), and `cursor` — the caret
 * captured alongside it (see `capturePaneState`) — is the second, color-blind
 * signal for "is anything typed?"; omitting it falls back to the color read alone
 * (see `inputEmpty`).
 *
 * Every marker below is read POSITIONALLY, from the region of the screen that
 * actually carries the state it claims to prove — the compacting/busy markers from
 * the CLI's live status region (`liveStatusLines`), the limit notice from the last
 * content block above the box (`paneUsageLimited`), a dialog from the bottom-most
 * content (`isDialog`). Scanning the whole visible screen was tried and is wrong:
 * the transcript is history, so a turn that merely *quotes* a marker put an idle
 * session into a state that `send` refuses. This mirrors `paneResumeDialogActive`
 * (#30) and carries the same bias — a false "not ready" that blocks a send costs
 * more than a missed detect.
 */
export function paneReadiness(raw: string, cursor?: PaneCursor | null): Readiness {
  // Codex first: its TUI is recognised from the pane's own content (see
  // codexPane) and classified separately. It must come before every claude check
  // because it shares one of their markers — codex also prints "esc to
  // interrupt" — while sharing none of the structure they'd then rely on: no `─`
  // rules around its input box, so `inputBox` (and with it `liveStatusLines`)
  // finds nothing to anchor on and would fall back to scanning the whole pane.
  // Codex gets the same positional treatment against its own chrome instead.
  const codex = codexPane(raw);
  if (codex) return codexReadiness(codex, cursor);
  // The claude CLI's OWN startup prompt about *how* to resume this session — not
  // the agent asking anything about the work, so from a caller's point of view
  // the session is available and we report it as "ready".
  //
  // Checked FIRST, before busy/limited/dialog. Everything above the dialog is
  // the PREVIOUS run's replayed transcript, which routinely ends in the very
  // notice that made the user resume — "You've hit your session limit …" — or in
  // an interrupted spinner's token counter. Judged in the usual order, such a
  // pane read "limited"/"busy" (verified on the real capture with a limit notice
  // spliced into its tail): `status` would print a stale reset time and
  // `agendo wait` would never settle, i.e. the exact blocked-forever reporting
  // this exists to fix, just wearing a different label. Nothing in that
  // scrollback is the CURRENT state: no turn has run yet.
  //
  // NB this is the one "ready" that does NOT mean "there's an empty input box to
  // paste into" — the dialog replaces the box — which is why every sender must
  // re-check `paneResumeDialogActive` and answer the dialog first (see
  // `answerResumeDialog`) instead of pasting on the strength of "ready".
  if (paneResumeDialogActive(raw)) return "ready";
  // WHERE the next two checks look: the CLI's own live status region, NOT the
  // whole screen (see liveStatusLines). Both markers below are transient facts
  // about the current instant, and the transcript above the box is history — a
  // session whose turn output merely *describes* a marker is not in that state.
  // Live specimen: a session documenting agendo's own detection layer printed a
  // comparison table whose cell read `inferred (esc to interrupt, token counter)`,
  // and `agendo list` called the finished, idle session "busy" — which makes
  // `send` refuse and leaves it unreachable until the text scrolls off.
  const { above, below } = liveStatusRegions(raw);
  const status = [...above, ...below].join("\n");
  // Compacting the conversation — a distinct, blocking state. Must be checked
  // *before* the input-box read below: compaction shows no token counter and no
  // "esc to interrupt" hint, and leaves the box empty, so it would otherwise
  // fall through every busy/dialog check and misclassify as "ready" — letting a
  // prompt be sent mid-compaction. The spinner verb line reads
  // `✻ Compacting conversation…` above a `▰▰▱▱ N%` progress bar — both inside the
  // status region, directly above the box's top rule.
  if (/compacting conversation/i.test(status)) return "compacting";
  // Actively generating — a live token/time counter (or an interrupt hint).
  // The counter always wears a directional ↑/↓ arrow (bytes flowing this turn):
  // `✢ Tinkering… (58s · ↓ 3.9k tokens)`. That arrow is the load-bearing
  // distinction from a FINISHED-turn *result* summary — `✔ Goal achieved (1m ·
  // 1 turn · 4.6k tokens)` — which wears the identical `(<time> · … tokens)`
  // shape (and leads with a ✔/✗ glyph + an "N turn(s)" count) but never an
  // arrow. So both checks REQUIRE the arrow: matching the bare parenthesized
  // shape alone read an idle, done-with-its-turn pane as "busy" and blocked
  // `agendo send`. The arrow is a *content* guard on top of the positional one,
  // and still needed: the status region legitimately holds a finished turn's
  // summary between turns.
  //
  // WHICH BAND each check reads is the other half of the positional guard, and it
  // is what #44 got wrong. The counter is only ever a LIVE counter above the box.
  // Below the box the same shape means something else entirely: a subagent row's
  // `↓ 99.9k tokens` is that agent's running TOTAL and outlives the agent, and the
  // row above it is the user's `statusLine` script, which may print anything —
  // claude hands those scripts the session's own duration and token counts, so
  // `1m 30s · ↓ 12.4k tokens` is a perfectly ordinary thing for one to say. Read
  // as the live counter, either pinned the pane to `busy` with nothing to clear
  // it: `wait` never settled and `send` refused a prompt sitting there idle.
  //
  // The interrupt hint keeps the whole region, but it does NOT get to appear just
  // anywhere in a line. Below the box the text is model- and user-authored — a
  // subagent's task description, the user's status line — and this repo is full of
  // agents whose task is literally "fix the esc to interrupt hint". A row like
  //   ◯ general-purpose  Fix the esc to interrupt hint   5m 39s · ↓ 9k tokens
  // outlives the agent it names, so reading the phrase there is #44 again, exactly:
  // busy forever, `wait` never settles, `send` refused. So the phrase must sit
  // where the TUI puts a HINT — opening the line, or after the separator its
  // footers and spinner parens use (`(58s · esc to interrupt)`), never mid-sentence.
  // Note `|` is deliberately NOT a separator here: `·` is what the TUI's own
  // footers use, `|` is what status-line scripts use, and `repo | esc to
  // interrupt: off | Opus 5` is a status line describing a keybinding, not a
  // session generating.
  // That asymmetry — numbers from above, hints from anywhere — is
  // deliberately not a test of what a panel row LOOKS like. Trying to recognize
  // the panel by its glyph swallowed the interrupt hint under any status line
  // starting with `●`; trying to recognize it by its trailing token column missed
  // every panel row whose column was worded or wrapped differently, and still
  // matched a status line that printed one. There is nothing to recognize: the
  // band simply does not carry this kind of evidence.
  //
  // Evidence rather than assertion, as far as it goes: across every capture in
  // e2e/fixtures, no CLAUDE pane has any busy evidence at all below its box, and
  // the only below-box matches for the counter shape are agent-panel rows. (Two
  // codex captures do carry the interrupt phrase below the box, but they return
  // from the codex branch above and never reach this check, so they are not
  // evidence for this decision either way.) A corpus is not a proof: if claude
  // ever draws a live counter under the box, this reads it as ready.
  const live = above.join("\n");
  if (
    /[↑↓]\s*[\d.,]+\s*k?\s*tokens?\b/i.test(live) ||
    /\(\s*\d[^)]*[↑↓][^)]*\btokens?\b[^)]*\)/i.test(live) ||
    /(?:^|[·•(]\s*)esc to interrupt\b/im.test(status)
  )
    return "busy";
  // Usage/token window exhausted — the 5-hour or weekly cap. Only when the notice
  // is the *active* bottom-most content (not stale scrollback from a session that
  // already resumed — see paneUsageLimited). Checked after busy (a session
  // generating again must read "busy") but before the input-box read: an active
  // notice sits just above the otherwise-idle box, so it would otherwise read
  // "ready" and invite a doomed send. See usageLimit.ts for the matched wording.
  if (paneUsageLimited(raw)) return "limited";
  // An open interactive menu / confirmation (not mere prose, and not a numbered
  // list left in scrollback — only the ACTIVE bottom-most dialog).
  if (isDialog(raw)) return "dialog";
  // Read the input box: the lines between the last two horizontal rules.
  const input = inputBox(raw);
  if (input === null) return "unknown";
  return inputEmpty(input, cursor) ? "ready" : "queued";
}

/**
 * Whether the pane shows an ACTIVE interactive dialog — an open menu/confirmation
 * awaiting a keypress — rather than a dialog footer or numbered list left in
 * scrollback above a now-idle input box. A real dialog REPLACES the input box, so
 * (mirroring isActiveLimitDialog) its signature must be the bottom-most content
 * with NO input-box rule (`─{20,}`) below it. Signatures: a confirmation footer
 * (`Enter to confirm`, `Esc to cancel/reject/go back`, `Press Enter to continue`)
 * or a numbered selection cursor (`❯ 1.`). Without the "nothing below it" guard,
 * an idle pane whose scrollback merely contained `❯ 1.`/`2.` lines read as
 * `dialog` and wrongly blocked `agendo send`. `raw` may include SGR escapes.
 */
function isDialog(raw: string): boolean {
  const lines = raw.replace(/\r/g, "").split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = stripAnsi(lines[i]);
    if (
      /Enter to confirm|Esc to (reject|cancel|go back)|Press Enter to continue/i.test(l) ||
      /^\s*❯\s*\d+\.\s/.test(l)
    ) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return false;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/─{20,}/.test(lines[i])) return false;
  }
  return true;
}

// ── the CLI's own "how should I resume?" dialog ───────────────────────────────
// Resuming a large session, the claude CLI asks — before any turn runs — how to
// reload it:
//
//   This session is 1h 14m old and 249.4k tokens.
//
//   Resuming the full session will consume a substantial portion of your usage
//   limits. We recommend resuming from a summary.
//
//   ❯ 1. Resume from summary (recommended)
//     2. Resume full session as-is
//     3. Don't ask me again
//
//   Enter to confirm · Esc to cancel
//
// Structurally that IS a dialog — numbered options under a rule, no input box —
// so `isDialog` (correctly, and load-bearingly for auto-resume safety) fires on
// it and the session sat blocked forever. But nothing is waiting on a human
// decision about the *work*: it's a startup prompt agendo can answer itself. So
// it gets its own narrow detector rather than any loosening of `isDialog`.
//
// Anchored on the literal OPTION LABELS, not the header: the header carries a
// variable age and token count and reads like prose, so it's the likelier of the
// two to churn between CLI versions. Both resume labels are required, which no
// genuine agent question offers.

/** `1. Resume from summary (recommended)` — the option Claude marks recommended. */
const RESUME_SUMMARY_RE = /^resume from summary\b/i;
/** `2. Resume full session as-is` — reload the whole transcript. */
const RESUME_AS_IS_RE = /^resume full session as-is\b/i;
/**
 * `3. Don't ask me again` — deliberately NEVER selectable by agendo: it flips
 * the user's global claude CLI behaviour permanently, for every future session
 * in every project, which is not agendo's call to make. Matched only so it can
 * be filtered out of the choosable set (including from the `(recommended)`
 * fallback, should the marker ever land on it).
 */
const RESUME_DONT_ASK_RE = /^don['’]?t ask me again\b/i;

/** One numbered option of an open menu, as printed by the TUI. */
export interface ResumeDialogOption {
  /** The number the TUI prints — the key that selects it (`2` in `2. Resume …`). */
  number: number;
  /** Option text with the number stripped, e.g. `Resume from summary (recommended)`. */
  label: string;
  /** Whether the label carries claude's own `(recommended)` marker. */
  recommended: boolean;
  /** Whether the `❯` cursor currently highlights this option. */
  selected: boolean;
}

/**
 * The pane's ACTIVE menu region: the lines below the last horizontal rule,
 * ANSI-stripped. Anchoring below the last `─{20,}` is the same "nothing below
 * it" structure `isDialog`/`isActiveLimitDialog` use: an open dialog replaces the
 * input box, so once it's dismissed a rule appears beneath the (now historical)
 * option lines and they stop counting.
 */
function activeMenuLines(raw: string): string[] {
  const lines = raw.replace(/\r/g, "").split("\n").map(stripAnsi);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/─{20,}/.test(lines[i])) return lines.slice(i + 1);
  }
  return lines;
}

/**
 * The `N. label` options among `lines`. The TUI paints the number and the label
 * in different colours, so the lines must already be ANSI-stripped (see
 * activeMenuLines).
 */
function menuOptions(lines: string[]): ResumeDialogOption[] {
  const out: ResumeDialogOption[] = [];
  for (const line of lines) {
    // The selection cursor `❯` marks whichever option is highlighted.
    const m = line.match(/^\s*(❯\s*)?(\d+)\.\s+(\S.*?)\s*$/);
    if (m) {
      out.push({
        number: Number(m[2]),
        label: m[3],
        recommended: /\(recommended\)/i.test(m[3]),
        selected: !!m[1],
      });
    }
  }
  return out;
}

/** The dialog's own footer — the affordance that proves a menu is really OPEN. */
const DIALOG_FOOTER_RE = /Enter to confirm|Esc to cancel/i;

/**
 * Whether the pane is sitting on the claude CLI's own resume-choice dialog (see
 * the block comment above). Four conditions, all within the active menu region:
 * BOTH resume option labels, the confirm/cancel footer, and a `❯` selection
 * cursor on one of the options.
 *
 * The footer and cursor are not redundant. A false positive here is
 * fail-DANGEROUS in a way `isDialog`'s is not: `isDialog` only ever costs a
 * refusal, whereas this verdict makes `send` press keys into the pane. With the
 * labels alone, turn output merely *quoting* them ("the CLI asked: 1. Resume
 * from summary … 2. Resume full session as-is") matched whenever no input-box
 * rule happened to sit below it — a mid-paint capture, say. Requiring the two
 * affordances only a live menu draws costs the real capture nothing, and the
 * cursor is needed to answer the dialog anyway (see answerResumeDialog).
 *
 * Known limit: on a pane narrow enough to WRAP an option label the anchors don't
 * match and the dialog reads as a plain `dialog` again — the pre-fix behaviour,
 * i.e. it fails safe (and `paneResumeMenuSuspect` keeps a forced send from
 * pasting into it regardless). `raw` may include SGR escapes (see capturePane).
 */
export function paneResumeDialogActive(raw: string): boolean {
  const lines = activeMenuLines(raw);
  if (!lines.some((l) => DIALOG_FOOTER_RE.test(l))) return false;
  const opts = menuOptions(lines);
  // EXACTLY one cursor. When the pane has no rule at all, the "active menu" is
  // the whole capture, and claude echoes user prompts with a bare `❯` — so a
  // replayed line like `❯ 1. rerun the failing spec` could add a second
  // "selected" option and leave the walk anchored on a highlight that isn't the
  // real one. Ambiguity here means we cannot know where a move would land.
  if (opts.filter((o) => o.selected).length !== 1) return false;
  return opts.some((o) => RESUME_SUMMARY_RE.test(o.label)) && opts.some((o) => RESUME_AS_IS_RE.test(o.label));
}

/**
 * The WEAK signal: a pane with NO input box whose active menu carries a resume
 * option label, whether or not the full detector fires. Used only to refuse a
 * *forced* paste (`send --force`) into a menu that looks like this one but didn't
 * fully match — a wrapped label, a reworded footer, a future option set. Without
 * it, `--force` (which `--help` and the agent guide both offer as the way past a
 * refusal) would type the message straight into the menu, where its digits pick
 * options and the trailing Enter confirms one.
 *
 * The cost to everything else is nil, because "active menu" means *below the last
 * `─` rule*: a session whose own output quotes these labels — one working on this
 * very feature, say — has them above its input box, so they're not in the region
 * at all and `--force` behaves there exactly as before. The explicit no-input-box
 * condition is belt-and-braces on top of that (if there's a box, there's somewhere
 * safe to paste, whatever the lines below it say). "Don't ask me again" is
 * deliberately NOT among the labels checked: it's generic enough to head a
 * numbered option in an unrelated CLI's menu.
 */
export function paneResumeMenuSuspect(raw: string): boolean {
  if (inputBox(raw) !== null) return false;
  // Matched on the label's HEAD, not the whole phrase: a pane narrow enough to
  // wrap BOTH labels leaves only "Resume from" / "Resume full" on the numbered
  // lines, and that is precisely the case this signal exists for.
  return menuOptions(activeMenuLines(raw)).some((o) => /^resume (from|full)\b/i.test(o.label));
}

/** Which resume option agendo picks for the user (see Config.resumeDialogChoice). */
export type ResumeDialogChoice = "summary" | "as-is";

/**
 * The option to select on the resume dialog for `choice`, or null if the pane
 * isn't showing one. "Don't ask me again" is filtered out first and can never be
 * returned (see RESUME_DONT_ASK_RE).
 *
 * The default ("summary") resolves by claude's own `(recommended)` MARKER rather
 * than by option index or position — the marker is what "recommended" actually
 * means, and the option could move — falling back to the literal
 * `Resume from summary` label if a future version drops the marker.
 */
export function resumeDialogOption(raw: string, choice: ResumeDialogChoice): ResumeDialogOption | null {
  // Only ever choose on a pane the detector fully vouches for — never on a
  // numbered menu that merely happens to carry one of the labels.
  if (!paneResumeDialogActive(raw)) return null;
  const opts = menuOptions(activeMenuLines(raw)).filter((o) => !RESUME_DONT_ASK_RE.test(o.label));
  if (choice === "as-is") return opts.find((o) => RESUME_AS_IS_RE.test(o.label)) ?? null;
  return opts.find((o) => o.recommended) ?? opts.find((o) => RESUME_SUMMARY_RE.test(o.label)) ?? null;
}

/**
 * The option the `❯` cursor currently highlights, or null when that can't be read
 * unambiguously (no cursor, or more than one — see paneResumeDialogActive).
 */
export function resumeDialogSelection(raw: string): ResumeDialogOption | null {
  const selected = menuOptions(activeMenuLines(raw)).filter((o) => o.selected);
  return selected.length === 1 ? selected[0] : null;
}

/**
 * The single `send-keys` argv for one step of answering the dialog: Enter when
 * the cursor already sits on the option we want, otherwise one move toward it.
 * Pure, so the key choice can be asserted without a tmux server.
 *
 * Arrow keys, deliberately, rather than typing the option's NUMBER. A digit may
 * activate an option outright in some CLI versions and merely select it in
 * others — an ambiguity with no safe resolution: send Enter as well and it can
 * land on whatever screen the reloading session draws next (accepting ITS
 * default); don't, and a dialog whose footer says "Enter to confirm" is never
 * answered at all. Up/Down only ever move the highlight, so Enter's meaning is
 * unambiguous — and the caller re-reads the cursor after every step, so nothing
 * is ever confirmed on an assumption about where the selection ended up.
 */
export function resumeDialogStep(target: string, at: number, want: number): string[] {
  const key = at === want ? "Enter" : at < want ? "Down" : "Up";
  return ["send-keys", "-t", target, key];
}

/**
 * Gap between the pane reads that answer the dialog. Its own constant, NOT
 * RESUME_KEY_DELAY_MS: that one is a pty-write-coalescing gap ("any real gap"),
 * whereas this is a repaint budget for an Ink TUI that is also reloading a
 * quarter-million-token session. Comfortably larger than the coalescing gap, so
 * it satisfies that constraint too.
 */
const RESUME_DIALOG_STEP_MS = 250;

/**
 * How many pane reads to spend answering the dialog before giving up. A move
 * costs two reads to settle plus however many frames the pane needs to show it,
 * so this covers any reachable distance in a three-option menu with room for a
 * slow repaint. The bound only matters when the pane stops responding to the
 * arrows, in which case we must not loop forever.
 */
const RESUME_DIALOG_LOOKS = 16;

/**
 * Answer the resume dialog on `target` with `option`: walk the `❯` cursor onto it
 * with arrow keys, then press Enter. Returns whether Enter was actually sent.
 *
 * The pane is re-read RESUME_DIALOG_STEP_MS apart, and three rules together make
 * a lagging repaint harmless — the whole hazard being that the option one past
 * the target is "Don't ask me again", which flips the user's global claude CLI
 * behaviour permanently and must never be pressed:
 *
 *  1. After a move, every frame that still shows the selection we moved FROM is
 *     discarded — the key isn't on screen yet, and acting on it would issue a
 *     second move the menu never needed. This is the load-bearing one: "the same
 *     selection twice running" alone does not mean "settled", because a display
 *     that is uniformly N frames behind is perfectly stable frame to frame.
 *  2. Only a selection seen twice running is acted on at all, so a half-drawn
 *     frame between two states isn't mistaken for either.
 *  3. Enter goes out only when that settled selection's LABEL is the one we
 *     chose — not its number, not a count of the moves we've made — and the
 *     target is re-resolved by label from every capture, so a menu that gains,
 *     drops or reorders an option moves the target with it.
 *
 * A pane that never shows the move therefore receives exactly ONE arrow and then
 * gives up, rather than walking the highlight down the menu and abandoning it on
 * the option we must never press. (Rule 1 covers lag that our OWN moves induce.
 * A pane whose very first capture is already stale — because something else moved
 * the cursor — is outside what any of this can see, and nothing short of a probe
 * keypress into the menu could establish where the highlight really is.)
 *
 * Anything unexpected — the dialog gone, an unreadable cursor, arrows with no
 * effect — returns false, having sent only arrows. Those are harmless while the
 * menu is up. If it closes underneath us (a human answered it) the pane can
 * receive one stray arrow: Down is a no-op in the restored input box, Up recalls
 * history into it. `waitForInputBox` then reads that as a draft and refuses to
 * paste over it, so the message is never delivered blind — but note the Enter
 * that follows a *successful* walk could, in that same window, submit it.
 *
 * Answering is all this does. It does NOT verify the input box came back — the
 * caller must re-capture and check that before pasting anything (see runSend).
 */
export function answerResumeDialog(target: string, option: ResumeDialogOption): boolean {
  let seen: number | null = null;
  let times = 0;
  let movedFrom: number | null = null;
  for (let i = 0; i < RESUME_DIALOG_LOOKS; i++) {
    if (i > 0) sleepSync(RESUME_DIALOG_STEP_MS);
    const raw = capturePane(target);
    // Gone (someone answered it, or it was never really there): nothing to confirm.
    if (!paneResumeDialogActive(raw)) return false;
    const at = resumeDialogSelection(raw);
    // Belt-and-braces: paneResumeDialogActive already required exactly one
    // cursor on this same capture, so this can't be null today.
    if (at === null) return false; // can't read the cursor — never guess where it is
    // Rule 1: the frame predates our last move. Wait for one that doesn't.
    if (movedFrom !== null && at.number === movedFrom) continue;
    movedFrom = null;
    // Where the option we chose sits in the menu AS IT IS NOW. Re-resolved by
    // label every look, so a menu that gains, drops or reorders an option
    // between frames moves the target with it instead of aiming at a number
    // that now belongs to something else.
    const want = menuOptions(activeMenuLines(raw)).find((o) => o.label === option.label);
    if (!want) return false; // our option is no longer on the menu
    times = at.number === seen ? times + 1 : 1;
    seen = at.number;
    if (times < 2) continue; // not a settled frame yet — look again
    if (at.label === option.label) {
      tmuxQuiet(resumeDialogStep(target, at.number, at.number)); // Enter
      return true;
    }
    tmuxQuiet(resumeDialogStep(target, at.number, want.number));
    movedFrom = at.number; // ignore frames still showing this until the move lands
    seen = null; // whatever the next frame shows must settle again before we act
    times = 0;
  }
  return false;
}

/**
 * Whether a captured pane is genuinely at an empty input box — i.e. "ready"
 * MINUS the single case where that word doesn't imply a box behind it: the CLI's
 * own resume dialog (see paneResumeDialogActive). `sendToPane` is keystroke
 * injection, not a queue, so this must be checked on a FRESH capture immediately
 * before pasting; a message pasted into a numbered menu picks an option.
 */
export function paneAcceptsPaste(raw: string, cursor?: PaneCursor | null): boolean {
  return !paneResumeDialogActive(raw) && paneReadiness(raw, cursor) === "ready";
}

/**
 * CEILING on the wait for the input box after answering the resume dialog — an
 * error deadline, NOT a latency anyone pays. waitForInputBox polls every
 * RESUME_DIALOG_POLL_MS and returns the moment it gets two consecutive good
 * reads, so the ordinary cost is about half a second; the full 120s elapses only
 * when the box never comes back at all, i.e. the session is already broken.
 *
 * Generous on purpose, and lowering it buys nothing but a faster failure on that
 * broken session: the dialog only appears for BIG sessions (the captured one was
 * 249.4k tokens), and "resume from summary" — the shipped default — makes the
 * CLI build and load that summary before it draws a box, reading busy or unknown
 * throughout. A tighter deadline would abort those legitimate loads.
 * Overridable per call with `send --timeout`.
 */
export const RESUME_DIALOG_WAIT_MS = 120_000;

/** Poll cadence while waiting for that input box to appear. */
export const RESUME_DIALOG_POLL_MS = 250;

/** The claude input box, located inside a capture. */
interface InputBox {
  /** The box's lines (SGR escapes intact), joined — what `inputRealText` reads. */
  text: string;
  /** Index of the `❯` prompt line *in the full capture* = its pane row. */
  promptRow: number;
  /** Index of the same line within `text` (the box's own rows). */
  promptOffset: number;
  /** Column of the first input cell, one past the `❯ ` marker. */
  inputCol: number;
}

/**
 * A claude input box, which is BOUNDED BY TWO `─` RULES — the anchor every
 * positional read above and below the box measures from.
 *
 * Split from `InputBox` because codex's box has no rules at all (it is a
 * background-colour band, see codexInputBox) and would have to fabricate these
 * three fields to satisfy the type. A fabricated rule index is exactly the thing
 * `topRuleFound` exists to warn about, so codex gets the ruleless base type and
 * anchors its own region on the prompt row instead.
 */
interface RuledInputBox extends InputBox {
  /** Capture line index of the box's top `─` rule (may be < 0, see inputBox). */
  topRule: number;
  /**
   * Whether a second rule was found at all. False when only one was and the top had
   * to be fabricated (`bottom - 2`), in which case the index points at whatever
   * happens to sit two rows up — a transcript line, not a boundary. Callers that
   * reason about the region ABOVE the box must not trust `topRule` without it.
   *
   * A weaker guarantee than "the box's top rule is on screen": with the real top
   * rule scrolled off and a table drawing `─{20,}` back in the scrollback, two rules
   * are found and this is true while `topRule` still points into the transcript.
   * Nothing observed does that (the box sits at the bottom of the pane, so its own
   * rule scrolls off only when the box body is taller than the screen), but the flag
   * is the cheap half of the test, not the whole of it.
   */
  topRuleFound: boolean;
  /** Capture line index of the box's bottom `─` rule. */
  bottomRule: number;
}

/**
 * The input-box region — the lines between the last two horizontal rules, which
 * bound the `❯` prompt — or null if there's no recognizable box. `raw` must keep
 * its SGR escapes (inputRealText reads them to tell real text from a suggestion).
 *
 * The prompt's row/column are reported alongside the text so `inputEmpty` can
 * line the pane's caret up against them. The row is a capture line index, which
 * IS the pane row (`capture-pane`'s first line is row 0, the origin `#{cursor_y}`
 * uses); the column is counted on the ANSI-stripped line, so it's a cell offset
 * (the prompt line carries only spaces before the `❯`, one cell each).
 */
function inputBox(raw: string): RuledInputBox | null {
  const lines = raw.replace(/\r/g, "").split("\n");
  const rules = lines.flatMap((l, i) => (/─{20,}/.test(l) ? [i] : []));
  if (rules.length === 0) return null;
  const bottom = rules[rules.length - 1];
  const top = rules.length >= 2 ? rules[rules.length - 2] : bottom - 2;
  const body = lines.slice(Math.max(top + 1, 0), bottom);
  const promptOffset = body.findIndex((l) => l.includes("❯"));
  if (promptOffset === -1) return null;
  const promptRow = Math.max(top + 1, 0) + promptOffset;
  return {
    text: body.join("\n"),
    promptRow,
    promptOffset,
    // `❯ ` — the marker plus the single space separating it from the input.
    inputCol: stripAnsi(lines[promptRow]).indexOf("❯") + 2,
    topRule: top,
    topRuleFound: rules.length >= 2,
    bottomRule: bottom,
  };
}

/**
 * How many contiguous lines above the input box's top rule can be the CLI's live
 * status line, once the blanks, the right-aligned hints and the task panel between
 * it and the box have been skipped (see liveStatusLines). One is the common case
 * (`✢ Tinkering… (58s · ↓ 3.9k tokens)`, or the idle `✻ Churned for 11m 13s` it
 * turns into); compaction draws two (the verb line plus its `▰▰▱▱ 42%` bar). Three
 * leaves a line of slack without letting the walk run on into the transcript, and
 * it truncates the far end, so the row nearest the box always survives.
 */
const STATUS_ABOVE_MAX_LINES = 3;

/**
 * The pane's LIVE STATUS region, ANSI-stripped and trimmed: the parts of the
 * screen that show what the CLI is doing *right now*, as opposed to the
 * transcript, which is history.
 *
 * Two disjoint bands, both anchored on the input box:
 *
 *  - ABOVE its top rule: the CLI's own status line — the spinner. `blockAbove`
 *    descends from the rule past everything the TUI parks in the gap beneath that
 *    row — blank lines, the right-aligned hints (`isBoxSideHint`), and the standing
 *    `N tasks (…)` panel (`taskPanelLines` for the structural match, plus
 *    `looksLikeTaskPanel` so one unrecognized row can't end the walk; its item
 *    titles are the user's own words and must never be read as CLI state) — and
 *    returns the run that follows. Skipping all of it is not cosmetic: every one of
 *    those lines sits between the status row and the rule on a long session, so
 *    collecting one would end the walk at the next blank and the live spinner above
 *    would never be seen — a busy pane reading `ready`, the direction that lets
 *    `send` paste into a running turn and `close` kill it.
 *  - BELOW its bottom rule: the footer, the mode bar, the user's own `statusLine`
 *    script and the sub-agent panel
 *    (`❯ ◯ general-purpose  Review …  5m 39s · ↓ 99.9k tokens`). Nothing below the
 *    box is ever transcript, so the whole band counts.
 *
 * The two bands are returned separately by `liveStatusRegions` because they do not
 * carry the same KIND of evidence, and one caller needs to tell them apart: there
 * is no live turn counter below the box. The counter lives on the spinner row
 * above it; a `↓ 99.9k tokens` below the box is either a subagent's running total
 * on a panel row or a number the user's own status line chose to print. Reading
 * either as the live counter is #44 — it pinned every session that had ever
 * spawned a subagent to `busy` forever, so `wait` never settled and `send`
 * refused an idle prompt. Below the box the busy signal is a PHRASE (`esc to
 * interrupt`), never a number. See `paneReadiness`.
 *
 * Two cases fall back to returning the WHOLE capture — the pre-existing behaviour —
 * and they are not equally free:
 *
 *  - No input box at all. Free: by the time this runs the one boxless "ready" (the
 *    CLI's own resume dialog) has already been answered above, so every remaining
 *    boxless verdict — dialog, limited, unknown, and the boxless `compacting` that
 *    `agendo send` relies on — is un-sendable either way. Narrowing instead against
 *    rules that may not bound a box at all (a table in scrollback draws `─` too)
 *    would guess at a region rather than find one.
 *  - A box whose top rule is off screen, so `inputBox` fabricated one and
 *    `topRuleFound` is false. NOT free: that pane has a working input box and could
 *    be perfectly ready, so scanning it whole is a live false-busy path — the thing
 *    this change exists to remove, in the one place it is still possible. Taken
 *    anyway because the alternative is worse: measuring a band from a fabricated
 *    boundary reads the transcript as status, which fails the other way (a busy pane
 *    reading ready) on a pane we cannot see enough of to check. It needs a box body
 *    taller than the screen to happen at all.
 *
 * `raw` may include SGR escapes (see capturePane).
 *
 * Two known limits, in opposite directions. A pane whose transcript butts directly
 * against the box — no blank, no status row between them — contributes up to
 * STATUS_ABOVE_MAX_LINES transcript lines, so a marker QUOTED there still reads
 * busy; that is a far narrower target than the whole screen (the capture this
 * exists for matched ~35 lines up, inside a table) and it fails safe. Conversely, a
 * status line pushed further from the box than the walk survives is MISSED, and
 * that one fails dangerous — a busy pane reading `ready`. Anything unrecognized in
 * the gap does it: more than STATUS_ABOVE_MAX_LINES rows of status line, a new hint
 * the TUI starts drawing there, or the shapeless tail of a WRAPPED panel row on a
 * narrow pane (pinned in the detection suite; closing it needs a real narrow-pane
 * capture). New chrome in that gap therefore belongs in `isBoxSideHint` or
 * `looksLikeTaskPanel`, not in the bound — widening the bound trades the miss for
 * the false positive this exists to remove.
 */
/**
 * The input box, but only when it is BOUNDED — both rules on screen, so the band
 * above it is a measured region and not a guess. One definition, because two
 * callers depend on the same condition (`liveStatusRegions` decides whether it has
 * a region at all; `paneBackgroundAgents` refuses to read the whole capture) and a
 * copy of the rule that drifted would silently un-guard the second one.
 */
function boundedBox(raw: string): RuledInputBox | null {
  const box = inputBox(raw);
  return box === null || !box.topRuleFound ? null : box;
}

function liveStatusRegions(raw: string): { above: string[]; below: string[] } {
  const lines = raw.replace(/\r/g, "").split("\n");
  const plain = lines.map((l) => stripAnsi(l).trim());
  const box = boundedBox(raw);
  if (box === null) return { above: plain, below: [] };
  const taskPanel = taskPanelLines(plain, LOOSE_TASK_PANEL_HEADER_RE);
  const above = blockAbove(
    plain,
    box.topRule,
    STATUS_ABOVE_MAX_LINES,
    (line, i) => line === "" || isBoxSideHint(line) || taskPanel.has(i) || looksLikeTaskPanelRow(line),
  );
  return { above, below: plain.slice(box.bottomRule + 1) };
}

/** The two bands joined, for the callers that don't care which is which. */
function liveStatusLines(raw: string): string[] {
  const { above, below } = liveStatusRegions(raw);
  return [...above, ...below];
}

/**
 * Whether the input box holds nothing the user typed — the check that gates both
 * `agendo send` and auto-resume. Two independent discriminators, either of which
 * is enough to call the box empty:
 *
 *  1. COLOR (`inputRealText`): the TUI draws an autocomplete *suggestion* faint
 *     (`\e[2m`) or gray and real text in the default color, so a box whose only
 *     glyphs are faint/gray holds no typed text. Precise when it applies, but
 *     it's a palette heuristic — it can only recognize the grays it enumerates,
 *     and it needs a capture that kept its escapes.
 *  2. CARET (`cursor`): a suggestion is rendered *at* the caret, waiting for Tab;
 *     typed text pushes the caret to its end. So a caret still resting at the
 *     prompt column means nothing was typed, whatever color the box is drawn in —
 *     no palette knowledge, no escapes needed. Accepted only at EXACTLY the
 *     prompt's row and column: the caret is sampled by a second tmux read (see
 *     capturePaneState), and a pane caught mid-paint parks its cursor wherever the
 *     output stream reached — column 0 of a row it is only passing through, say —
 *     so anything short of the resting position is treated as no evidence.
 *
 * They're OR'd because the bug being fixed is a FALSE dirty read: a ghost
 * suggestion that (1) can't recognize — an unenumerated gray, a theme that draws
 * suggestions without dim, a capture stripped of escapes — makes `agendo send`
 * refuse and, worse, makes `paneResumeSafe` refuse, so a usage-limited session
 * never resumes hands-off however long it waits.
 *
 * The OR is not free, and signal 1 does NOT backstop signal 2 — the moment the
 * caret says empty, the color read is discarded. The way that clobbers a real
 * draft: the user types something, then moves the caret back to the prompt column
 * (Home / Ctrl-A, or `0`/`^` under vim bindings) and leaves it there across a
 * poll, at which point a `send`/auto-resume can overwrite the draft. We take that
 * trade knowingly: it needs a caret deliberately moved off the text and left
 * there in an unattended session, versus a suggestion — which the TUI offers
 * constantly, unprompted — silently disabling hands-off resume. `onlyPromptRow`
 * below keeps the trade as narrow as it can be made: the caret may only speak for
 * a box whose other rows are blank, so a multi-row draft (whose caret was moved
 * back up to the prompt row) is never overruled.
 */
function inputEmpty(box: InputBox, cursor?: PaneCursor | null, marker: string = CLAUDE_PROMPT): boolean {
  if (inputRealText(box.text, marker) === "") return true;
  return (
    !!cursor && cursor.y === box.promptRow && cursor.x === box.inputCol && onlyPromptRow(box)
  );
}

/**
 * Whether the input box's content is confined to the prompt row — every other row
 * blank. Bounds what the caret is allowed to vouch for (see `inputEmpty`): the
 * caret proves nothing about rows it isn't on, so a box with content elsewhere
 * keeps the (conservative) color verdict. Costs the caret signal on a suggestion
 * long enough to WRAP onto a second row, which is the safe direction to fail.
 */
function onlyPromptRow(box: InputBox): boolean {
  return box.text
    .split("\n")
    .every((l, i) => i === box.promptOffset || stripAnsi(l).trim() === "");
}

// ── Codex CLI panes ──────────────────────────────────────────────────────────
// Codex's TUI shares no structure with claude's, so it gets its own classifier
// (`codexReadiness`) that `paneReadiness` dispatches to. Calibrated against real
// captures of a 67-second turn (see e2e/fixtures/codex-*.ansi). The differences
// that matter:
//   • The input box has NO border rules — it's a background-colour band — so
//     claude's "between the last two `─{20,}` rules" anchor finds nothing.
//   • Its prompt glyph is `›`, not `❯`.
//   • The caret NEVER moves: it sat at the prompt column for all 289 samples of
//     a busy turn, so it says nothing about busy-ness (it still says plenty
//     about whether the box holds a draft).
//   • The box keeps showing its dim example placeholder while the model works,
//     and codex accepts typing mid-turn (it queues), so an empty-looking box is
//     NOT permission to send.
// What's left is the status bar, and one status line above the input — both read
// POSITIVELY and POSITIONALLY, from codex's own live status region
// (`codexLiveStatus`) rather than from anywhere in the pane, for exactly the
// reason the claude side moved that way in #33.
//
// Known limitation, deliberate: codex compaction is not a state of its own here.
// `codexReadiness` never returns "compacting", so a compacting codex pane reads
// "busy" off its run-state field — blocked, which is the answer that matters, but
// without the progress `paneCompactionPercent` gives a claude pane (#34). Both of
// that function's callers gate on `readiness === "compacting"`, so it is never
// reached with a codex capture and never measures codex's bar with claude's
// rule-anchored region. Closing this needs a real capture of codex mid-compaction
// to calibrate against; guessing at the marker would be the fail-dangerous
// direction, since a wrong "compacting" is still un-sendable but a wrong percent
// would be a claim the screen never made.
//
// Why scrape at all, when claude gets read over its control socket: codex has no
// per-process socket to connect to. It does have a local control plane — an
// [experimental] `codex app-server daemon`, WebSocket JSON-RPC over
// `$CODEX_HOME/app-server-control/app-server-control.sock`, whose `thread/read`
// reports a richer status than anything here (idle vs active vs
// waitingOnApproval vs waitingOnUserInput). But a thread is only reachable
// there if its TUI was started as `codex --remote unix://`, i.e. as a client of
// that daemon; a plain `codex`/`codex resume` is invisible to it (it shows up in
// `thread/list` from the on-disk rollouts, but always `notLoaded`, never
// controllable). So it can never cover sessions the user launched themselves,
// and adopting it means changing how agendo launches codex — worth revisiting
// once the protocol settles, not a drop-in for this.

/**
 * Codex's run-state word, read from its footer status bar. The bar is a ` · `
 * separated list whose fields are user-configurable (`/statusline`), so the
 * word is matched as a WHOLE field at any position rather than by offset — and
 * matching a whole field is also what stops the word "Working" in transcript
 * prose from counting. `Thinking` is documented by the `/statusline` dialog
 * ("Compact session run-state text (Ready, Working, Thinking)") alongside the
 * two we captured live.
 */
const CODEX_RUN_STATES = { Ready: "ready", Working: "busy", Thinking: "busy" } as const;

/**
 * Codex's mid-turn status line, rendered directly above the input box:
 * `• Working (25s • esc to interrupt)`. Independent of the footer, so it still
 * works when `/statusline` has the run-state field switched off; across a
 * captured 67-second turn it was present in every one of the 154 busy frames.
 *
 * The VERB varies and must not be matched on — `--approve-for-me` swaps it for
 * `• Reviewing approval request (6s • esc to interrupt)` while its automatic
 * review runs, and other sub-steps may use others again. What's invariant is
 * the shape: a `•` bullet, a parenthesised elapsed counter, and the interrupt
 * hint. Requiring the counter is what keeps finished-turn prose out — the
 * completion marker is `─ Worked for 1m 06s ───…`, which carries no hint.
 *
 * The counter restarts at each sub-step (it ran 0→33s, reset, ran again), so it
 * is not a turn timer and nothing should read it as one.
 */
const CODEX_BUSY_LINE = /^[ \t]*•[^\n]*\(\s*\d+s\b[^\n]*\besc to interrupt\b/im;

/** What a codex pane's footer says, when we can find and read one. */
interface CodexFooter {
  /** Index of the status-bar line in the capture. */
  row: number;
  /** The run-state field, or null when `/statusline` has it switched off. */
  state: Readiness | null;
}

/**
 * Locate codex's footer status bar — the last non-empty line — and read its
 * run-state field. Returns null when the line doesn't look like a status bar at
 * all (too few ` · ` fields), which is how a non-codex pane is rejected.
 */
function codexFooter(lines: string[]): CodexFooter | null {
  let row = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (stripAnsi(lines[i]).trim()) {
      row = i;
      break;
    }
  }
  if (row === -1) return null;
  const fields = stripAnsi(lines[row]).split(" · ").map((f) => f.trim());
  // A single field is any old line of prose; the bar always carries at least
  // the model and the cwd, so two is the floor for calling this a status bar.
  if (fields.length < 2) return null;
  for (const [word, state] of Object.entries(CODEX_RUN_STATES)) {
    if (fields.includes(word)) return { row, state };
  }
  return { row, state: null };
}

/**
 * Codex's input box: the `›` prompt line just above the footer, plus the blank
 * padding row between them. There are no rules to anchor on, so we scan a short
 * way up from the footer — which also keeps a `›` appearing in transcript prose
 * out of reach, and (more importantly) the `›` codex uses as the SELECTION
 * CURSOR inside its dialogs, which is the same glyph.
 *
 * A draft long enough to wrap past the search window yields null. That costs
 * more than it used to: the prompt row is also what anchors the live status
 * region (see codexLiveStatus), so without it the pane is read from its footer
 * alone. Both consequences point the safe way — "unknown", so `agendo send`
 * refuses rather than overwriting the draft it couldn't measure.
 */
const CODEX_BOX_SEARCH_ROWS = 4;

function codexInputBox(lines: string[], footerRow: number): InputBox | null {
  for (let i = footerRow - 1; i >= 0 && i >= footerRow - CODEX_BOX_SEARCH_ROWS; i--) {
    if (!lines[i].includes(CODEX_PROMPT)) continue;
    return {
      text: lines.slice(i, footerRow).join("\n"),
      promptRow: i,
      promptOffset: 0,
      // `› ` — the marker plus the single space separating it from the input.
      inputCol: stripAnsi(lines[i]).indexOf(CODEX_PROMPT) + 2,
    };
  }
  return null;
}

/**
 * How many contiguous non-blank rows above codex's input box count as its live
 * status region. Two is the observed maximum: the busy line alone
 * (`• Working (25s • esc to interrupt)`), or that line plus the `└ /bin/bash -lc
 * "…"` detail row that `--approve-for-me` draws under it while its reviewer runs.
 * Three leaves a row of slack, matching STATUS_ABOVE_MAX_LINES on the claude side.
 */
const CODEX_STATUS_ABOVE_MAX_LINES = 3;

/**
 * The codex pane's LIVE STATUS region — the counterpart of `liveStatusLines` for
 * a TUI that draws no rules, and it exists for the same reason (#33): the
 * transcript above the box is HISTORY, so a turn that merely *quotes* a marker is
 * not evidence of the state that marker names. Scanning the whole pane is what
 * put an idle session documenting agendo's own detection layer into `busy` and
 * left `send` refusing until the text scrolled off; codex is if anything more
 * exposed, since its own busy line is the sort of string that gets pasted around.
 *
 * Two bands, anchored on the `›` prompt row rather than on rules:
 *  - ABOVE it: the status block, reached with the shared `blockAbove` walk past
 *    the blank padding rows codex leaves between the transcript and the box.
 *  - BELOW it: the footer status bar and the blanks around it. Nothing below the
 *    box is ever transcript, so the whole band counts.
 *
 * `plain` must be ANSI-stripped and trimmed.
 */
function codexLiveStatus(plain: string[], promptRow: number): string {
  const above = blockAbove(plain, promptRow, CODEX_STATUS_ABOVE_MAX_LINES, (line) => line === "");
  return [...above, ...plain.slice(promptRow + 1)].join("\n");
}

/**
 * Classify a codex pane. Conservative in one specific direction: it only ever
 * answers "ready" on the POSITIVE evidence of the footer saying `Ready`.
 *
 * That matters because the run-state field is optional — `/statusline` can
 * switch it off. With it off, the busy line still catches most of a turn, and
 * everything else degrades to "unknown" (send refuses, and the user can be told
 * why) instead of to a confident, wrong "ready" that would inject a prompt into
 * a working session. So run-state is a soft requirement for `send`/`wait`
 * rather than something we silently guess around.
 */
function codexReadiness(pane: CodexPane, cursor?: PaneCursor | null): Readiness {
  // An open dialog replaces the input box; codex's own confirmation footer
  // ("enter to confirm and close; esc to close") matches the shared signature.
  // Checked first: a dialog can coexist with a footer still reading `Ready`.
  if (isDialog(pane.raw)) return "dialog";
  // Both busy signals are positional: the run-state field is a whole field of
  // the footer line, and the status line is read from `pane.status` — never from
  // the transcript (see codexLiveStatus).
  if (pane.footer.state === "busy" || CODEX_BUSY_LINE.test(pane.status)) return "busy";
  // No positive `Ready` → we genuinely don't know (see the doc comment above).
  if (pane.footer.state !== "ready") return "unknown";
  if (pane.box === null) return "unknown";
  return inputEmpty(pane.box, cursor, CODEX_PROMPT) ? "ready" : "queued";
}

/** A recognised codex pane, with everything the classifier reads located once. */
interface CodexPane {
  /** The capture as handed in, for the checks that want it whole (`isDialog`). */
  raw: string;
  footer: CodexFooter;
  /** Codex's input box, or null when there is none to anchor on. */
  box: InputBox | null;
  /** The live status region (see codexLiveStatus); "" when there is no box. */
  status: string;
}

/**
 * Whether this capture is a codex TUI. Sniffed from the pane CONTENT rather than
 * the tmux window name: the name only carries the agent for codex's own windows
 * (`cl-codex-…`, `cl-bg-codex-…`), never for a `cl-wi-…`/`cl-pr-…` one, and
 * `paneReadiness`'s callers have only the text.
 *
 * Requires either the run-state field or the busy line — the two markers no
 * other TUI produces — and reads BOTH positionally, so a claude pane whose
 * transcript quotes one of them is not mistaken for codex. With no input box
 * there is nothing to anchor the status region on, so recognition then rests on
 * the footer's run-state field alone rather than on a whole-pane search.
 *
 * A codex pane with run-state switched off and no turn running is therefore not
 * recognised, and falls through to the claude path, which finds no input box and
 * answers "unknown". Same safe verdict, reached the long way round.
 */
function codexPane(raw: string): CodexPane | null {
  const lines = raw.replace(/\r/g, "").split("\n");
  const footer = codexFooter(lines);
  if (footer === null) return null;
  const box = codexInputBox(lines, footer.row);
  const status = box === null ? "" : codexLiveStatus(lines.map((l) => stripAnsi(l).trim()), box.promptRow);
  if (footer.state === null && !CODEX_BUSY_LINE.test(status)) return null;
  return { raw, footer, box, status };
}

/**
 * How many contiguous non-blank lines above the input box count as the "active"
 * block — the usage-limit notice must render here to be the current state.
 */
const LIMIT_ACTIVE_MAX_LINES = 12;

/**
 * The spinner's own row, in the shape it wears BETWEEN turns: a turn summary,
 * `✻ Crunched for 0s` / `✻ Worked for 4m 54s` (the glyph and verb vary per
 * frame/turn). Captured live on v2.1.224. Expects an ANSI-stripped, trimmed line.
 *
 * Chrome to one scan and content to the other, which is why it is its own
 * predicate: `paneUsageLimited` looks for the last *conversation* block and must
 * skip past this to find it, while `liveStatusLines` is looking for this very row —
 * it is the same screen position the live `✢ Tinkering… (58s · ↓ 3.9k tokens)`
 * counter occupies while a turn runs.
 */
function isSpinnerSummary(line: string): boolean {
  return /^[✻✢✳✶✽·∗+*]\s+\S+\s+for\s+\d+[smhd]/.test(line);
}

/**
 * The right-aligned hints the TUI parks in the gap between the spinner row and the
 * box's top rule (both captured live on v2.1.224):
 *   - the effort/mode hint: `● high · /effort`;
 *   - the context-pressure hint: `new task? /clear to save 293k tokens` (captured
 *     on a live limited pane, where it hid the notice from detection).
 * Expects an ANSI-stripped, trimmed line.
 *
 * Chrome to BOTH scans above the box, and skipping it is load-bearing for each: it
 * is neither conversation content nor CLI state, but it physically separates the
 * spinner row from the box — so a scan that collected it would stop at the very
 * next blank and never reach the row it came for.
 */
function isBoxSideHint(line: string): boolean {
  return /^●\s+\S+\s+·\s+\/[\w-]+$/.test(line) || /^new task\?\s+\/clear to save\b/i.test(line);
}

/**
 * A line SHAPED like a task-panel item row — a checkbox glyph, or the elision
 * footer — with no header-then-run licence behind it. The unlicensed backstop to
 * `liveStatusLines`' licensed `taskPanelLines` skip: it covers the panel whose
 * header has scrolled off the top of the pane, where there is no header to license
 * anything. (It deliberately does NOT test the header itself: the call site already
 * runs `taskPanelLines` over the same lines with the same loose header, which marks
 * every header line it could match.)
 *
 * Nothing ENFORCES that this only ever sees the gap between the status row and the
 * box: when the status row is absent the walk keeps descending and applies this to
 * the conversation, so it has to be safe there too. Hence a glyph set deliberately
 * NARROWER than TASK_PANEL_ROW_RE's — the checkbox glyphs `◼◻◐◌☐☑` only, never
 * `●○✔✓✗`. Those five are what ordinary turn output is bulleted with (`● Agent "…"
 * failed`, `✔ Goal achieved (1m · 1 turn · 4.6k tokens)`), and skipping them
 * unlicensed let the walk climb an arbitrarily long run of transcript bullets and
 * read a marker quoted above them — the very false positive this whole change
 * removes. `✔` is a real done-row glyph, so dropping it here costs a real skip; the
 * loose header hands that case back positionally instead, which is the safe way to
 * buy it (see LOOSE_TASK_PANEL_HEADER_RE). Both regressions are pinned in the
 * detection suite.
 */
function looksLikeTaskPanelRow(line: string): boolean {
  return /^[◼◻◐◌☐☑]\s+\S/.test(line) || /^…\s*\+\d+\b/.test(line);
}

/**
 * UI chrome the TUI renders between the last content block and the input box —
 * lines that carry no conversation content and so must NOT count as "the session
 * moved on" when locating the active block. Deliberately narrow: a turn-output
 * bullet (`● Build 123456 now: SUCCEEDED`) or a typed `❯ continue` is content,
 * and correctly demotes any notice above it to history.
 */
function isPaneChrome(line: string): boolean {
  return isSpinnerSummary(line) || isBoxSideHint(line);
}

/**
 * The contiguous block of interesting lines directly above `top`, nearest-first
 * from the caller's point of view: descend from `top - 1`, skipping whatever `skip`
 * rejects until something is collected, then stop at the first rejected line after
 * that. Bounded by `max`, which truncates the FAR (upper) end — the nearest lines
 * to the box are the ones both callers care most about.
 *
 * `max` bounds what is COLLECTED, not how far the descent goes: a run of skipped
 * lines is walked through however long it is. That is what lets both callers reach
 * past a tall task panel, and equally what makes a too-permissive `skip` dangerous —
 * it tunnels into the transcript instead of stopping at it.
 *
 * Shared by the two scans that ask "what is directly above the input box?" —
 * `paneUsageLimited` (which content block is current?) and `liveStatusLines` (what
 * is the CLI doing?). They differ only in `skip` and `max`, and deliberately so:
 * the spinner row is chrome to the first and the whole point of the second (see
 * isSpinnerSummary). `plain` must be ANSI-stripped and trimmed.
 */
function blockAbove(plain: string[], top: number, max: number, skip: (line: string, i: number) => boolean): string[] {
  const out: string[] = [];
  for (let i = top - 1; i >= 0 && out.length < max; i--) {
    if (skip(plain[i], i)) {
      if (out.length) break; // reached the gap above the block
      continue; // still below it — keep descending
    }
    out.unshift(plain[i]);
  }
  return out;
}

/**
 * The task panel's header line, e.g. `7 tasks (3 done, 1 in progress, 3 open)`
 * (also `1 task (…)`). Requires at least one of the TUI's own status words inside
 * the parens so ordinary prose ("3 tasks (see below)") can't open a panel.
 */
const TASK_PANEL_HEADER_RE = /^\d+\s+tasks?\s+\([^)]*\b(?:done|in progress|open|pending)\b[^)]*\)$/i;

/**
 * The same header with the vocabulary and the closing `)` dropped — the SHAPE only.
 * Used solely by `liveStatusLines`, which needs to get *past* a panel rather than
 * decide whether one exists, and which pays a fail-dangerous price for a header it
 * fails to recognize: an unmarked panel row ends the walk before the status row and
 * a generating pane reads `ready`. This shape survives a reworded count
 * (`(2 completed, 3 remaining)`) and a header wrapped on a narrow pane, neither of
 * which the strict form does.
 *
 * `paneUsageLimited` keeps the strict form on purpose: over-marking there hides an
 * active limit notice, so its error has the opposite sign.
 *
 * The cost, stated: dropping the wording test lets PROSE open a run — a sentence
 * like `3 tasks (one per repo):` — and the rows under it are then matched by the
 * permissive TASK_PANEL_ROW_RE, `●` and `✔` included. A marker quoted above such a
 * run can therefore be reached. It needs the status row to be absent, the prose line
 * to be digit-led, and a contiguous bullet run directly beneath it with no blank
 * between; and it fails in the false-busy direction this file accepts. Anchoring the
 * loose form on the closing `)` would not help: that is exactly what a header
 * wrapped on a narrow pane loses. Pinned in the detection suite as a known limit,
 * with the two controls that close it.
 */
const LOOSE_TASK_PANEL_HEADER_RE = /^\d+\s+tasks?\s+\(/i;

/**
 * A row *inside* an already-opened task panel: a status-glyph item line
 * (`◼ WebRTC session…` in progress, `◻ UI: pair code…` open, `✔ Gradle skeleton…`
 * done) or the elision footer (`… +2 completed`). Only ever applied to the
 * contiguous run directly beneath a matched header (see taskPanelLines), so the
 * glyph set can stay permissive without swallowing turn output that happens to
 * start with `✔`.
 */
const TASK_PANEL_ROW_RE = /^(?:[◼◻◐◌●○☐☑✔✓✗]\s+\S|…\s*\+\d+\b)/;

/**
 * Indices of the lines belonging to the TUI's TASK PANEL — the persistent
 * `N tasks (…)` summary plus its item rows, which Claude Code renders directly
 * above the input box while a task list exists. It is standing UI, not
 * conversation content: it stays on screen unchanged across turns, so counting it
 * as "the last content block" hid an active usage-limit notice sitting just above
 * it and made a blocked session read `ready` (the field miss this exists for).
 *
 * Found structurally — a header line, then the contiguous run of rows beneath it —
 * rather than by matching item glyphs anywhere on screen, so a turn-output line
 * that merely starts with one of those glyphs is still content. That header is what
 * LICENSES the permissive glyph set: `●`, `✔` and `✗` are also how ordinary turn
 * output is bulleted, and marking them unlicensed reads the conversation as UI.
 *
 * `header` is which header opens a run, and both callers pass it explicitly — there
 * is no sensible default, because the two scans need OPPOSITE strictness: a header
 * `paneUsageLimited` wrongly accepts hides an active limit notice, while one
 * `liveStatusLines` wrongly rejects hides a live spinner. `lines` are ANSI-stripped
 * and trimmed.
 */
function taskPanelLines(lines: string[], header: RegExp): Set<number> {
  const marked = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    marked.add(i);
    for (let j = i + 1; j < lines.length && TASK_PANEL_ROW_RE.test(lines[j]); j++) marked.add(j);
  }
  return marked;
}

/**
 * Whether the numbered limit dialog is the *active* bottom-most content — not the
 * same text lingering in scrollback after it was dismissed. The dialog replaces
 * the input box while it's up (there's no `❯ ` prompt line, hence no `─` rule,
 * below it); once dismissed the session drops back to an input box, so a `─{20,}`
 * rule appears beneath the (now historical) dialog text. So: find the last line
 * carrying the dialog's option wording and treat it as active only when no input-
 * box rule sits below it. `lines` are raw (SGR escapes intact) — we strip per
 * line before matching. Note the dialog can render `─` rules *above* it (e.g. a
 * table in scrollback); only rules *below* the dialog demote it.
 */
function isActiveLimitDialog(lines: string[]): boolean {
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isLimitDialog(stripAnsi(lines[i]))) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return false;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/─{20,}/.test(lines[i])) return false;
  }
  return true;
}

/**
 * Whether a captured pane is showing the ACTIVE numbered limit dialog (the
 * public, raw-string form of isActiveLimitDialog). Exposed so callers — the
 * auto-resume poll in particular — can key the dialog-reveal nudge off the same
 * structural check the readiness classifier uses, rather than re-deriving it.
 * `raw` may include SGR escapes (see capturePane).
 */
export function paneLimitDialogActive(raw: string): boolean {
  return isActiveLimitDialog(raw.replace(/\r/g, "").split("\n"));
}

/**
 * Whether the pane is CURRENTLY at a usage limit — the notice is the active,
 * bottom-most content, not a stale line left in scrollback after the session
 * resumed. The message persists in history once the user continues, so a plain
 * whole-screen match would keep flagging a recovered, idle session as limited.
 *
 * When an input box is present we look only at the LAST CONTENT BLOCK above it —
 * the contiguous run of non-blank lines nearest the box's top rule (bounded by
 * LIMIT_ACTIVE_MAX_LINES), skipping past blank lines AND pane chrome (the
 * spinner's `✻ Crunched for 0s` summary, the `● high · /effort` mode hint — see
 * isPaneChrome — plus the standing `N tasks (…)` panel, see taskPanelLines). An active
 * limit renders its notice as that block; a recovered session has a later
 * completed turn (and its typed `❯ continue`) between the old notice and the
 * box, so the nearest content block is that turn's tail, not the notice. With
 * no input box to anchor on, fall back to scanning the whole capture
 * (permissive — better to flag than to miss). `raw` must include SGR escapes
 * (see capturePane).
 */
export function paneUsageLimited(raw: string): boolean {
  const lines = raw.replace(/\r/g, "").split("\n");
  // The numbered limit dialog — the primary interactive limit state (form A in
  // usageLimit.ts). It has no reset time and no input box of its own, so the
  // text-block heuristic below can't see it; detect it structurally instead.
  if (isActiveLimitDialog(lines)) return true;
  const rules = lines.flatMap((l, i) => (/─{20,}/.test(l) ? [i] : []));
  if (rules.length === 0) return isUsageLimited(stripAnsi(raw));
  const top = rules.length >= 2 ? rules[rules.length - 2] : rules[rules.length - 1] - 2;
  const plainLines = lines.map((l) => stripAnsi(l).trim());
  const taskPanel = taskPanelLines(plainLines, TASK_PANEL_HEADER_RE);
  const block = blockAbove(
    plainLines,
    top,
    LIMIT_ACTIVE_MAX_LINES,
    (line, i) => line === "" || isPaneChrome(line) || taskPanel.has(i),
  );
  return isUsageLimited(block.join(" "));
}

/**
 * Whether it's safe to auto-send the resume keystrokes to a captured pane:
 * still *actively* at the usage limit (so a recovered session — notice only in
 * scrollback — is never clobbered), with no open dialog (Escape would dismiss
 * it) and an *empty* input box (so a draft the user queued for after reset isn't
 * wiped). Stricter than `paneReadiness` alone, which reports "limited" even over
 * a lingering dialog / queued text because the limit check outranks both. `raw`
 * must include SGR escapes (see capturePane); pass the caret captured with it
 * (see capturePaneState) so a greyed-out autocomplete *suggestion* sitting in the
 * box doesn't read as a draft and veto the resume — a false-dirty read here is
 * silent and permanent: auto-resume simply never fires for that limit window.
 *
 * The numbered limit dialog is the one dialog we DO fire into: the resume
 * keystrokes lead with Escape, which dismisses it (verified live), and the dialog
 * has no input box holding a user draft. Every *other* open dialog still blocks —
 * Escape would dismiss it too, but that's not what the user wants.
 */
export function paneResumeSafe(raw: string, cursor?: PaneCursor | null): boolean {
  if (!paneUsageLimited(raw)) return false;
  // Never fire into the CLI's own resume dialog. Its replayed transcript can
  // still carry the limit notice that stopped the previous run (so the check
  // above can be true), and the resume keystrokes lead with Escape — which here
  // is the dialog's own "Esc to cancel", i.e. cancelling the resume. Stated
  // explicitly rather than left to the isDialog check below, since this is the
  // one dialog whose *other* consumers now treat the pane as available.
  if (paneResumeDialogActive(raw)) return false;
  const lines = raw.replace(/\r/g, "").split("\n");
  if (isActiveLimitDialog(lines)) return true;
  if (isDialog(raw)) return false;
  const input = inputBox(raw);
  return input !== null && inputEmpty(input, cursor);
}

/**
 * The compaction progress bar's percentage — `42` for `▰▰▰▱▱▱ 42%` — or null when
 * the pane isn't showing one. Read from the live status region (`liveStatusLines`),
 * the same band `paneReadiness` takes the "compacting" verdict from, so a transcript
 * that merely quotes a bar can't produce a reading.
 *
 * Anchored on the bar's own `▰`/`▱` blocks rather than on `%`, and that anchor is
 * load-bearing: the status region deliberately includes everything below the input
 * box, and the TUI's footer there is full of percentages — `29% ctx | 5h: 9% (3h 9m)
 * | 7d: 63%` — any of which a bare `\d+%` would happily return as the compaction
 * progress. The bar glyphs appear nowhere else.
 *
 * Deliberately NOT gated on the pane being compacting: callers that display it pair
 * it with the readiness they already have (see `rowCompactionPercent` in index.tsx),
 * which keeps this a pure read of one thing. Returns null rather than 0 when there
 * is no bar — "no reading" and "0% done" are different claims, and a compaction that
 * has genuinely just started does print `0%`.
 */
export function paneCompactionPercent(raw: string): number | null {
  const m = liveStatusLines(raw).join("\n").match(/[▰▱]+\s*(\d{1,3})\s*%/);
  if (!m) return null;
  const pct = Number(m[1]);
  // A bar that reports something impossible is a misread, not a datum.
  return pct >= 0 && pct <= 100 ? pct : null;
}

/**
 * How many background AGENTS the session is currently waiting on, read from the
 * TUI's own words: `✻ Waiting for 1 background agent to finish`.
 *
 * This is the signal `busy` used to stand in for, and the two are not the same
 * thing (#44). A running subagent means the session IS working — so `agendo wait`
 * must not settle — while the main agent is idle at its prompt, so `agendo send`
 * must still deliver. One flag could not say both. Monitors and background shells
 * are a third case again: legitimately long-running (a dev server, an armed
 * watcher), so they hold neither — `wait` would never return for anyone running
 * one. They need no counter of their own for that: they simply never produce this
 * sentence, so a session running one settles.
 *
 * Read from the live status region, NOT the whole pane: this phrase is ordinary
 * English and a session whose transcript merely *discusses* background agents (a
 * pane documenting this very detection layer, say) would otherwise be held open
 * forever. The panel's own rows are deliberately not counted — they persist after
 * their agents finish, so they say "this session once spawned agents", not "an
 * agent is running now".
 *
 * Matched on the TUI's exact wording, and on its exact POSITION, which is the weak
 * point. It reads 0 — `wait` settles, `⚠stalled` becomes possible — whenever the
 * sentence is reworded ("Waiting on", "background-agents"), truncated on a narrow
 * pane, pushed further than STATUS_ABOVE_MAX_LINES rows above the box, separated
 * from the box by a chrome row `blockAbove` doesn't recognize, prefixed by more
 * than a one-character glyph, or followed on the same row by anything that is not
 * TUI chrome (a right-aligned `/clear to save 172.1k tokens` hint would do it). Neither
 * direction of a misread is safe: an over-count holds `wait` to its timeout on a
 * finished session, an under-count settles it on one that is still working. So it
 * is worth re-checking against a real capture whenever claude's status line
 * changes, rather than loosened into something that would match prose.
 *
 * One shape would break the split rather than this function: if the TUI ever drew
 * a live counter on this same row (`✻ Waiting for 1 background agent to finish
 * (2m · ↓ 4.2k tokens)`), the pane would read `busy` AND count 1, and `send` would
 * refuse a prompt that is idle. Today's captures carry no counter there.
 *
 * Returns 0 when the TUI is not waiting on any.
 */
export function paneBackgroundAgents(raw: string): number {
  // Without a bounded box `liveStatusLines` falls back to the WHOLE capture, and
  // this phrase is ordinary English — a resume dialog (which replaces the box,
  // and which `paneReadiness` calls settled) over a transcript discussing
  // background agents would hold `agendo wait` open until its timeout, on a
  // session that is finished. Read nothing rather than read the transcript.
  if (boundedBox(raw) === null) return 0;
  let max = 0;
  // The ABOVE band only: this sentence is part of the turn status the TUI draws
  // over the box, and the band below it holds a panel whose rows carry model- and
  // user-authored text (a subagent's task title, the user's status line).
  for (const line of liveStatusRegions(raw).above) {
    // The sentence has to BE the whole line, past at most a one-character spinner
    // glyph: anchored at both ends, and with the assistant's own bullet (`●`/`⏺`)
    // excluded up front. A transcript line CAN reach this band — `blockAbove`
    // collects up to STATUS_ABOVE_MAX_LINES rows when the transcript butts against
    // the box — and the sentence is ordinary English that an orchestrator narrating
    // its own fan-out will print verbatim. Three separate holes were closed here:
    // `\W*` admitted `## Waiting for 3…` and `> "Waiting for 2…"`, a bare `\S\s+`
    // admitted `● Waiting for 3…`, and no end anchor admitted `● Waiting for 3
    // background agents to finish before I commit.`
    // The tail is the other half of that: the sentence may be followed by the
    // TUI's own chrome — an ellipsis, or a parenthesized/middot-led suffix like
    // `(3m 12s)` or `· esc to interrupt`, which claude's spinner rows habitually
    // carry — but never by more words. `…to finish, then I'll commit.` is prose
    // and reads 0; `…to finish (2m · ↓ 4.2k tokens)` is the TUI and reads the
    // count. An anchor that admitted neither under-counted, which is the
    // destructive direction: `wait` settles and `close` kills a working session.
    const m = line.match(
      /^(?!●|⏺)(?:\S\s+)?waiting for\s+(\d+)\s+background\s+agents?\s+to\s+finish(?:\s*[.…]+)?(?:\s*[(·•].*)?$/i,
    );
    // Two lines both claiming a count is not a shape the TUI produces; if it
    // ever does, the higher number is the survivable misread — an over-count
    // wakes late and loudly (a timeout, non-zero exit), an under-count wakes
    // early and silently on a session that is still working.
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
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

/**
 * Every live window across all sessions, bare name → addressable target (#39).
 *
 * tmux allows duplicate window names and this launcher creates them BY DESIGN: a
 * restored-but-unopened placeholder tab carries the canonical `cl-…` name in one
 * host while the real agent window runs under it in another. So a name can have
 * several locations, and they are not interchangeable — a placeholder is an idle
 * bash waiting on a keypress (see restore.ts), not the session's pane.
 *
 * A REAL window therefore always wins over a placeholder, whichever order tmux
 * lists them in. Getting this wrong is worse than the bug this function exists to
 * fix: `liveTargetForShortId` feeds `send` and `unblock`, which WRITE to the pane
 * they resolve — pasting a prompt into a placeholder wakes it into a second agent
 * on the same transcript, and `unblock`'s leading Escape closes the tab outright.
 * `reconcileLive` skips placeholders for the same reason; these two must agree.
 *
 * Among several REAL windows of one name the first sighting wins, which is a
 * genuine ambiguity this cannot resolve — `close` is the caller that must not
 * guess, and it enumerates `windowLocations` and refuses instead.
 */
export function liveWindows(): Map<string, string> {
  const out = new Map<string, string>();
  const provisional = new Set<string>(); // names whose target came from a placeholder
  for (const line of tmuxLines([
    "list-windows",
    "-a",
    "-F",
    `#{session_name}\t#{window_name}\t#{?${PLACEHOLDER_OPTION},1,0}`,
  ])) {
    const [session, window, placeholder] = line.split("\t");
    if (!window) continue;
    const isPlaceholder = placeholder === "1";
    // Keep what we have unless this is a real window displacing a placeholder.
    if (out.has(window) && (isPlaceholder || !provisional.has(window))) continue;
    // No session reported is not a case tmux produces, but the fallback is the
    // pre-#39 bare name: still correct for a single host, and never worse.
    out.set(window, session ? windowTarget(session, window) : exactTarget(window));
    if (isPlaceholder) provisional.add(window);
    else provisional.delete(window);
  }
  return out;
}

/**
 * Every live session and window name → the target that addresses it. A session
 * addresses itself; a window needs its host session as qualifier. A session name
 * wins over a window of the same name, as it did when this returned a set.
 */
export function liveTargets(): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of liveSessions()) out.set(s, exactTarget(s));
  for (const [name, target] of liveWindows()) if (!out.has(name)) out.set(name, target);
  return out;
}

/**
 * Every live managed (`cl-…`) target paired with the working directory of its
 * pane. A pane contributes its session name and/or window name, whichever is a
 * managed target. Used to attribute fresh-launch targets — named after a work
 * item / PR (`cl-wi-…`, `cl-pr-…`) rather than a session id — back to the
 * session actually running in them, so they register as running.
 */
export function liveManagedPaths(): ManagedTarget[] {
  const out: ManagedTarget[] = [];
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
    //
    // Each name carries the target that ADDRESSES it alongside it (see
    // `LiveTarget`): a session addresses itself, a window needs its host session
    // as qualifier or it is unreadable from anywhere else (#39).
    for (const [name, isWindow, isPlaceholder] of [
      [session, false, false],
      [window, true, placeholder === "1"],
    ] as const) {
      // Built only for a name we keep: `exactTarget("")` is `=`, which tmux reads
      // as the `{mouse}` target — it would silently address wherever the pointer
      // last was rather than fail.
      if (!name?.startsWith("cl-")) continue;
      const target = isWindow && session ? windowTarget(session, name) : exactTarget(name);
      out.push({ name, target, cwd, placeholder: isPlaceholder });
    }
  }
  return out;
}

/**
 * Force tmux to resolve `-t <name>` by EXACT match only. Without the leading `=`,
 * tmux resolves a target by exact → unique-prefix → fnmatch, so a bare name that
 * is a *prefix* of a longer live name silently binds to the wrong target — our
 * managed names are prefixes of each other (`agendo`⊂`agendo-work`, `cl-pr-5`⊂
 * `cl-pr-50`, `cl-wi-512`⊂`cl-wi-5120`). The `=` prefix (documented tmux target
 * syntax) pins resolution to the literal name, and for a compound `session:window`
 * target it applies to the session portion (the only ambiguous part here).
 */
export function exactTarget(name: string): string {
  return `=${name}`;
}

/**
 * Exact-pinned `session:window` target — the form that addresses a window from
 * any host session, and the one this file hands to `capture-pane`.
 *
 * BOTH halves are pinned: host names are prefixes of each other (`agendo` ⊂
 * `agendo-agendo` ⊂ `agendo-mc-applications`) and so are managed window names
 * (`cl-pr-5` ⊂ `cl-pr-50`), so an unpinned half lets tmux's prefix/fnmatch
 * fallback bind it to the wrong thing — the `exactTarget` hazard, twice over.
 */
export function windowTarget(session: string, window: string): string {
  return `${exactTarget(session)}:${exactTarget(window)}`;
}

export function hasSession(name: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", exactTarget(name)]).status === 0;
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
  const r = spawnSync("tmux", ["show-options", "-t", exactTarget(session), "-v", ROOT_OPTION], { encoding: "utf-8" });
  const v = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return v || null;
}

/** Record the absolute root a launcher host session is scoped to (`@cl_root`). */
export function setSessionRoot(session: string, root: string): void {
  tmuxQuiet(["set-option", "-t", exactTarget(session), ROOT_OPTION, root]);
}

/**
 * Kill the window/target `name` (no-op if it doesn't exist). Used to clear a
 * dormant restore placeholder before a headless resume recreates it for real,
 * and by `agendo close` to end a managed session's window.
 *
 * EXACT-targeted (see `exactTarget`): a bare `-t <name>` resolves by exact →
 * unique-prefix → fnmatch, so killing `cl-pr-5` while `cl-pr-50` is the only
 * live match would destroy the WRONG session's window. Every kill in this file
 * pins its target with the leading `=` for that reason.
 *
 * A managed agent runs as either a window in a host session or a session of its
 * own (see the file header); `kill-window` covers both, since tmux resolves a
 * bare session name to that session's current window — and a managed session has
 * exactly the one. Nothing outside tmux is touched: the agent's git worktree,
 * branch and commits are left on disk.
 */
export function killWindow(target: string): void {
  tmuxQuiet(["kill-window", "-t", exactKillTarget(target)]);
}

/**
 * Pin a kill target to an exact match on BOTH halves of a `session:window` ref
 * (or on a bare name).
 *
 * The `=` prefix is PER-COMPONENT: `=host:name` pins only the session, and
 * blindly prefixing the whole string instead yields `==host:name` — a session
 * literally named `=host`, which matches nothing. Under `tmuxQuiet` that
 * mismatch is silent, so callers passing an already-pinned session (see
 * `refreshPlaceholder`) would kill nothing and never hear about it. Both halves
 * are therefore normalized before being re-pinned.
 *
 * A numeric window half is left bare on purpose: `man tmux` looks a window up as
 * an INDEX before a name, so `=3` would ask for a window whose name is "3"
 * rather than window 3 — and `session:index` is exactly what `killManagedTarget`
 * resolves its target to.
 */
function exactKillTarget(target: string): string {
  const colon = target.indexOf(":");
  const unpin = (s: string) => (s.startsWith("=") ? s.slice(1) : s);
  if (colon === -1) return exactTarget(unpin(target));
  const session = unpin(target.slice(0, colon));
  const window = unpin(target.slice(colon + 1));
  return `${exactTarget(session)}:${/^\d+$/.test(window) ? window : exactTarget(window)}`;
}

/** Kill the tmux SESSION `name` outright (exact-targeted; no-op if absent). */
export function killSession(name: string): void {
  tmuxQuiet(["kill-session", "-t", exactTarget(name)]);
}

/**
 * End a live managed target — the window it names, or the whole session when the
 * name IS a session of its own (how an agent launched outside tmux runs). Backs
 * `agendo close`. Reports how it addressed the target and whether tmux still
 * lists the name afterwards.
 *
 * ADDRESSING is the subtle part. `man tmux`: a target-window is `session:window`
 * and "if a session is omitted, the current session is used if available; if no
 * current session is available, the most recently used is chosen". So a bare
 * window name is looked up inside ONE session — whichever the caller happens to
 * be in, or an arbitrary one when the CLI runs outside tmux — and a launcher tab
 * addressed from anywhere else simply isn't found. `tmuxQuiet` throws the exit
 * status away, so that failure would be invisible. We therefore resolve the
 * window to its unambiguous `session:index` location first (`windowLocation`)
 * and target that; a target with no such window is a session and is killed as
 * one. Both forms are `=`-pinned (see `exactTarget`), which drops tmux's
 * prefix/fnmatch fallback — the one that would bind `cl-pr-5` to `cl-pr-50` if
 * the exact target died between the listing and this call.
 *
 * `location` defaults to the lookup and is accepted explicitly so a caller that
 * already resolved it (to READ the same pane, which needs the identical
 * unambiguous target) can prove both operations addressed one window.
 *
 * The post-check is deliberate: every write here goes through `tmuxQuiet`, so
 * "we asked" is not "it's gone" — callers report what actually happened rather
 * than assuming success. Nothing outside tmux is touched either way: the agent's
 * git worktree, branch and commits stay on disk.
 */
export function killManagedTarget(
  name: string,
  location: string | null = windowLocation(name),
): { how: "window" | "session" | "moved" | "none"; gone: boolean } {
  if (location) {
    // Re-read the name at that location first. A window index is not a stable
    // handle: with `renumber-windows on` (a common setting) every index above a
    // closing window shifts down, and an agent tab exiting on its own is routine
    // here — so between the lookup and this call `agendo:3` can come to mean a
    // different window, up to and including the launcher's own menu. Cheap
    // re-check, and it closes the only gap where this command could hit a window
    // nobody asked it to.
    if (windowNameAt(location) !== name) return { how: "moved", gone: false };
    // Confirm by COUNT, not by whether the location string still appears. The
    // same renumbering the check above guards against can move a surviving window
    // off `agendo:3` — so "the location no longer holds it" is satisfied by a
    // kill that failed while some other window happened to close alongside it,
    // and we would print "closed" over a live agent. One fewer window carrying
    // the name is the only evidence that stays true under renumbering.
    const before = windowLocations(name).length;
    killWindow(location);
    return { how: "window", gone: windowLocations(name).length < before };
  }
  if (liveSessions().has(name)) {
    killSession(name);
    return { how: "session", gone: !liveSessions().has(name) };
  }
  return { how: "none", gone: !liveTargets().has(name) };
}

/** The window name currently at a `session:index` location, or null. */
function windowNameAt(location: string): string | null {
  const r = spawnSync("tmux", ["display-message", "-p", "-t", exactTarget(location), "#{window_name}"], {
    encoding: "utf-8",
  });
  const name = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return name || null;
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
    exactTarget(session),
    "-F",
    "#{window_name}\t#{pane_current_path}\t#{pane_dead}",
  ])) {
    const [name, cwd, dead] = line.split("\t");
    if (dead === "1" || !cwd) continue;
    out.push({ name, cwd });
  }
  return out;
}

/**
 * Whether `name` is a live, still-unopened restore PLACEHOLDER window in
 * `session` — an idle bash awaiting a keypress, not a running agent.
 *
 * Existence and the `@cl_placeholder` flag come from ONE query scoped to that
 * host session, deliberately: the same canonical window name can exist in two
 * host sessions (one session tabbed in two path-scoped launchers), so reading the
 * flag from a global window list could authorize an action against a window whose
 * own flag has since been cleared — i.e. one the user is now working in. A dead
 * window (a `remain-on-exit` corpse) is never a placeholder.
 */
export function isPlaceholderWindow(session: string, name: string): boolean {
  for (const line of tmuxLines([
    "list-windows",
    "-t",
    exactTarget(session),
    "-F",
    `#{window_name}\t#{?${PLACEHOLDER_OPTION},1,0}\t#{pane_dead}`,
  ])) {
    const [wname, placeholder, dead] = line.split("\t");
    if (wname === name) return placeholder === "1" && dead !== "1";
  }
  return false;
}

/**
 * `session:window_index` of EVERY live window named `name`, across all sessions.
 * tmux allows duplicate window names, and this launcher creates them — two host
 * sessions (the global `agendo` and a path-scoped one) can each hold a tab for
 * the same session, the same collision `isPlaceholderWindow` above scopes around.
 * So a caller that is about to do something destructive has to see all of them,
 * not just the first (see `windowLocation`).
 */
export function windowLocations(name: string): string[] {
  const out: string[] = [];
  for (const line of tmuxLines(["list-windows", "-a", "-F", "#{session_name}:#{window_index}\t#{window_name}"])) {
    const [loc, wname] = line.split("\t");
    if (wname === name) out.push(loc);
  }
  return out;
}

/** `session:window_index` of the first window named `name`, or null. */
export function windowLocation(name: string): string | null {
  return windowLocations(name)[0] ?? null;
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
  tmuxQuiet(["new-window", "-d", "-t", exactTarget(session), "-n", name, "-c", cwd, "--", ...argv]);
  pinName(`${exactTarget(session)}:${name}`);
}

/**
 * Whether a launcher host session currently has a live window running the menu.
 * The menu window is pinned to the name "launcher"; tmux destroys a window when
 * its program exits (default `remain-on-exit off`), so a missing — or dead, if a
 * config kept it around — "launcher" window means the menu isn't running.
 */
export function launcherWindowLive(session: string = LAUNCHER_SESSION): boolean {
  for (const line of tmuxLines(["list-windows", "-t", exactTarget(session), "-F", "#{window_name}\t#{pane_dead}"])) {
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
  tmuxQuiet(["kill-window", "-t", `${exactTarget(session)}:launcher`]); // no-op if none exists
  const at0 = spawnSync(
    "tmux",
    ["new-window", "-d", "-t", `${exactTarget(session)}:0`, "-n", "launcher", "-c", cwd, "--", ...launcherArgv],
    { stdio: "ignore" },
  );
  if (at0.status !== 0) {
    spawnSync(
      "tmux",
      ["new-window", "-d", "-t", exactTarget(session), "-n", "launcher", "-c", cwd, "--", ...launcherArgv],
      { stdio: "ignore" },
    );
  }
  pinName(`${exactTarget(session)}:launcher`);
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
    pinName(`${exactTarget(session)}:launcher`);
    if (root) setSessionRoot(session, root);
    onFreshCreate?.();
  } else if (!launcherWindowLive(session)) {
    spawnLauncherWindow(session, cwd, launcherArgv);
  }
  // Land on the menu window specifically, not whatever window was last active.
  tmuxQuiet(["select-window", "-t", `${exactTarget(session)}:launcher`]);
  const verb = insideTmux() ? ["switch-client"] : ["attach-session"];
  spawnSync("tmux", [...verb, "-t", exactTarget(session)], { stdio: "inherit" });
}

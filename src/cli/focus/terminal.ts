// Opening a terminal on a tmux session when no client is attached to move —
// strictly opt-in, through `focusTerminal` in ~/.agendo/config.json:
//
//     "focusTerminal": "x-terminal-emulator -e tmux attach -t {session}"
//
// The template is split on whitespace into an argv and run WITHOUT a shell, so
// neither it nor the session name substituted into it can be reinterpreted. The
// cost is that a word with a space in it cannot be expressed; a wrapper script
// is the way to need one.
import { spawn } from "child_process";
import { loadConfig } from "../../app/config.ts";

/** The configured template, or null when the feature is off (the default). */
export function focusTerminalTemplate(raw: unknown = loadConfig().focusTerminal): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * The argv to run: the template's words, with `{session}` replaced by the tmux
 * session to attach to. The session is pinned exactly (`=name`) wherever it
 * stands alone as a word, since tmux would otherwise resolve it by prefix.
 */
export function terminalArgv(template: string, session: string): string[] {
  return template
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "{session}" ? `=${session}` : w.split("{session}").join(session)));
}

/** Start the configured terminal detached from us; whether it could be started at all. */
export function openTerminal(template: string, session: string): boolean {
  const [cmd, ...args] = terminalArgv(template, session);
  if (!cmd) return false;
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}

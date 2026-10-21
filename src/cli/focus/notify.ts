// Telling the human what happened when there may be no terminal to tell it on.
//
// `agendo focus` is usually started by a browser through the agendo:// handler,
// with stdout and stderr going nowhere anyone reads. A desktop notification is
// the only channel that reaches the person who clicked, so every failure on this
// path goes out both ways: stderr for a caller in a terminal, `notify-send` for
// one who clicked a button.
import { spawnSync } from "child_process";

let beforeNotify: (() => void) | null = null;

/**
 * Run `hook` as each notification this process shows is decided — before it is
 * sent, so a link refused meanwhile already finds the floor `agendo url`
 * stamps with it taken (see throttle.ts).
 */
export function onNotify(hook: () => void): void {
  beforeNotify = hook;
}

/**
 * Body markup is interpreted by many notification servers (a subset of HTML),
 * so the three characters that open markup are escaped. Text reaching here is
 * already validated or agendo's own, but a notification is no place to find out.
 */
export function notifyBody(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Show a desktop notification. Best-effort: `notify-send` being missing, or no
 * notification server running, is not worth failing over — the stderr line has
 * already said the same thing. argv only, never a shell.
 */
export function notify(text: string): void {
  beforeNotify?.();
  try {
    spawnSync("notify-send", ["--app-name=agendo", "agendo", notifyBody(text)], { stdio: "ignore", timeout: 5_000 });
  } catch {
    // nothing to do: the message is on stderr already
  }
}

/** Say `text` on stderr and as a notification, then exit with `code`. */
export function failLoudly(text: string, code = 1): never {
  console.error(`focus: ${text}`);
  notify(text);
  process.exit(code);
}

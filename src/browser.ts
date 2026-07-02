// Opens a URL in the user's default browser. Spawned detached so the Ink menu
// keeps running (unlike session-open, which hands the terminal over to tmux).
import { spawn } from "child_process";

/** Platform-appropriate opener command. */
function opener(): { cmd: string; args: string[] } {
  if (process.platform === "darwin") return { cmd: "open", args: [] };
  // `start` is a cmd built-in; the empty "" is the (ignored) window title arg.
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", ""] };
  return { cmd: "xdg-open", args: [] };
}

/**
 * Open `url` in the default browser without blocking the caller. `onError` is
 * invoked asynchronously if the opener can't be launched (e.g. no xdg-open on a
 * headless host) so the UI can surface it instead of crashing.
 */
export function openUrl(url: string, onError?: (e: Error) => void): void {
  try {
    const { cmd, args } = opener();
    const child = spawn(cmd, [...args, url], { detached: true, stdio: "ignore" });
    child.on("error", (e) => onError?.(e as Error));
    child.unref();
  } catch (e) {
    onError?.(e as Error);
  }
}

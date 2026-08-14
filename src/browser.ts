// Opens a URL in the user's default browser. Spawned detached so the Ink menu
// keeps running (unlike session-open, which hands the terminal over to tmux).
import { spawn } from "child_process";

/** Platform-appropriate opener command. `AGENDO_BROWSER` overrides it, for hosts
 *  where the platform default isn't the right one (containers, WSL, a kiosk).
 *  It names a single executable — the URL is its only argument, so no flags. */
function opener(): { cmd: string; args: string[] } {
  const override = process.env.AGENDO_BROWSER;
  if (override) return { cmd: override, args: [] };
  if (process.platform === "darwin") return { cmd: "open", args: [] };
  // `start` is a cmd built-in; the empty "" is the (ignored) window title arg.
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", ""] };
  return { cmd: "xdg-open", args: [] };
}

/**
 * Open `url` in the default browser, resolving once the opener process has
 * actually started and rejecting when it couldn't be launched (e.g. no xdg-open
 * on a headless host). Never waits for the browser itself: the child is detached
 * and unref'd, so the caller may exit immediately after this resolves.
 *
 * Failure to exec shows up in one of three ways depending on the runtime — a
 * synchronous throw, a pid-less child that emits "error" on the next tick, or
 * (success) a pid plus a "spawn" event — so all three are handled and the
 * promise always settles.
 */
export function openUrlAsync(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const { cmd, args } = opener();
      child = spawn(cmd, [...args, url], { detached: true, stdio: "ignore" });
    } catch (e) {
      reject(e as Error);
      return;
    }
    // Two success signals and one failure signal can each arrive first depending
    // on the runtime, so latch on whichever does.
    let settled = false;
    const started = () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    };
    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e as Error);
    });
    child.once("spawn", started);
    if (child.pid !== undefined) started();
  });
}

/**
 * Fire-and-forget `openUrlAsync` for the Ink UI, which can't await: `onError` is
 * invoked asynchronously if the opener can't be launched, so the menu surfaces
 * the failure instead of crashing.
 */
export function openUrl(url: string, onError?: (e: Error) => void): void {
  openUrlAsync(url).catch((e) => onError?.(e as Error));
}

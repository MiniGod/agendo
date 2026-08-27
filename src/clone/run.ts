// Running `git clone`: asynchronously, with live progress, with no possibility
// of an interactive prompt hanging the TUI, and with the partial directory
// cleaned up on failure or cancellation.
import { spawn } from "child_process";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";

/** How agendo reads a clone failure — decides which explanation is offered. */
export type CloneFailure = "hostkey" | "auth" | "missing" | "other";

export interface CloneOutcome {
  ok: boolean;
  /** One-line failure reason, git's own words where it had any. */
  error?: string;
  /** agendo's reading of `error` (absent when the clone succeeded). */
  failure?: CloneFailure;
  /** The user cancelled (esc) rather than git failing. */
  canceled?: boolean;
}

export interface CloneRun {
  done: Promise<CloneOutcome>;
  /**
   * Kill the clone and remove the partial directory.
   *
   * The plain form is the user's esc: SIGTERM, and cleanup deferred to the
   * child's exit (git removes its own junk on a signal, and it may still be
   * writing). `immediate` is for teardown, where nothing will ever observe that
   * exit: it kills hard and cleans up synchronously.
   *
   * Safe to call repeatedly. A repeat soft cancel does nothing; a repeat
   * `immediate` still escalates, since it can follow a soft cancel that the
   * child hasn't answered yet.
   */
  cancel(opts?: { immediate?: boolean }): void;
}

// Checked BEFORE auth, because it is a consequence of our own BatchMode: ssh
// normally *asks* whether to trust an unknown host, and we've turned that off.
// So the first-ever clone from a host the user hasn't reached over SSH before
// (ssh.dev.azure.com, for anyone who has only used ADO over HTTPS) fails here —
// and "check your SSH agent" would send them looking in the wrong place.
const HOSTKEY_RE =
  /host key verification failed|no matching host key|remote host identification has changed|no ed25519 host key is known/i;

// Git's vocabulary for "you are not authenticated / not allowed", across the
// transports and hosts we clone from.
const AUTH_RE =
  /authentication failed|could not read (?:username|password)|permission denied \(publickey|terminal prompts disabled|no such identity|403 forbidden|invalid username or (?:password|token)|access denied|tf401019|authorization failed|host key verification failed/i;

// Distinct from AUTH_RE on purpose. GitHub answers an unauthorized *private*
// repo with a 404, so "not found" genuinely means "doesn't exist, OR you can't
// see it" — telling the user flatly to check their credentials would be a
// confident wrong answer for the (likelier) typo. The message covers both.
//
// AUTH_RE is tested FIRST, and that order is load-bearing: git ends every failed
// SSH handshake with "fatal: Could not read from remote repository." — including
// the one whose real cause is on the line above it
// ("git@github.com: Permission denied (publickey).") — so matching this pattern
// first would classify every SSH credentials failure as a missing repo. Nothing
// in AUTH_RE appears in a genuine 404, so the reverse mix-up can't happen.
const MISSING_RE = /repository .*not found|could not read from remote repository|does not (?:exist|appear to be a git repository)|project does not exist/i;

// Tried in this order; the first match names the failure. `other` has no
// pattern — it's what's left when none of them matched.
const FAILURE_RE: Partial<Record<CloneFailure, RegExp>> = {
  hostkey: HOSTKEY_RE,
  auth: AUTH_RE,
  missing: MISSING_RE,
};

/**
 * The child environment for `git clone`. agendo never prompts for credentials
 * and never stores any — it uses whatever the user's git is already configured
 * with. But git blocking on `Username:` would freeze the TUI on a stdin it
 * doesn't own, so every interactive path is closed off and a missing credential
 * becomes a fast, legible failure instead of a hang. Agent-held SSH keys (the
 * normal case) are unaffected by BatchMode.
 */
function cloneEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  // APPEND rather than only-set-if-unset: ssh reads passphrases straight from
  // /dev/tty, not stdin, so a user's own `GIT_SSH_COMMAND` (`ssh -i ~/.ssh/…`,
  // a wrapper script) would prompt into the terminal the TUI is drawing on and
  // hang the clone screen. Their command is preserved — the later `-o` simply
  // adds BatchMode to it.
  env.GIT_SSH_COMMAND = `${env.GIT_SSH_COMMAND ?? "ssh"} -o BatchMode=yes`;
  return env;
}

/**
 * The most informative line of git's stderr.
 *
 * Preferring a `fatal:` line alone is not good enough: git's summary line for a
 * failed SSH handshake is the generic "Could not read from remote repository.",
 * while the line that actually says what went wrong
 * ("git@github.com: Permission denied (publickey).") carries no prefix at all
 * and would be thrown away. So the line matching the classification wins, and
 * the `fatal:` line is only the fallback.
 */
function failureLine(stderr: string, failure: CloneFailure): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const specific = FAILURE_RE[failure] ?? null;
  return (
    (specific && lines.find((l) => specific.test(l))) ||
    [...lines].reverse().find((l) => /^(?:fatal|error|remote):/i.test(l)) ||
    lines[lines.length - 1] ||
    "git clone failed"
  );
}

/**
 * Clone `remote` into `dest`, asynchronously so the TUI keeps rendering. Each
 * progress line git writes (it emits them to stderr even without a TTY, given
 * `--progress`) is handed to `onProgress`.
 *
 * `--` guards the arguments: a remote can never be read as a flag, even though
 * parseRepoUrl already refuses anything that isn't an anchored host URL.
 *
 * On failure or cancellation the partial clone is removed — but only if we
 * created the directory. A directory that already existed (the empty-directory
 * case) is left in place; git cleans up its own contents, and deleting a folder
 * the user made isn't ours to do.
 */
export function startClone(
  remote: string,
  dest: string,
  onProgress: (line: string) => void,
): CloneRun {
  const preExisted = existsSync(dest);
  let canceled = false;

  // A directory we created goes entirely; one that was already there (which
  // freeCloneDest only ever hands back when it is EMPTY) is emptied instead —
  // the same distinction git draws for itself. Skipping it would be a real leak:
  // `git clone` writes `remote.origin.url` into the config before it fetches
  // anything, so a killed clone leaves behind a `.git` with an origin and no
  // refs — which findMatchingCheckout would then happily report as "already
  // cloned" and launch a session in.
  const rm = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  const cleanup = () => {
    try {
      if (!existsSync(dest)) return;
      if (!preExisted) {
        rm(dest);
        return;
      }
      for (const entry of readdirSync(dest)) rm(join(dest, entry));
    } catch {
      // Best-effort: a leftover directory is reported by the next attempt's
      // collision handling rather than being worth failing over here.
    }
  };

  const child = spawn("git", ["clone", "--progress", "--", remote, dest], {
    env: cloneEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    // Progress is carriage-return-delimited; show the newest non-empty line.
    const lines = chunk.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) onProgress(last);
  });

  const done = new Promise<CloneOutcome>((resolve) => {
    child.on("error", (e) => {
      cleanup();
      resolve({ ok: false, failure: "other", error: `could not run git: ${e.message}` });
    });
    child.on("close", (code) => {
      if (canceled) {
        cleanup();
        resolve({ ok: false, canceled: true, error: "cancelled" });
        return;
      }
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      cleanup();
      // Order matters — see the comments on HOSTKEY_RE and MISSING_RE.
      const failure =
        (Object.keys(FAILURE_RE) as CloneFailure[]).find((k) => FAILURE_RE[k]!.test(stderr)) ?? "other";
      resolve({ ok: false, failure, error: failureLine(stderr, failure) });
    });
  });

  return {
    done,
    cancel(opts) {
      const immediate = !!opts?.immediate;
      // A repeat cancel is a no-op — EXCEPT an immediate one, which must still
      // escalate. esc (soft cancel) followed by the app going down is a real
      // sequence: git may not have exited yet, the `close` handler that owns the
      // deferred cleanup will never run once the process is gone, and returning
      // here would leave both the child and its half-written directory behind.
      if (canceled && !immediate) return;
      canceled = true;
      try {
        // SIGKILL on teardown: SIGTERM leaves git a window to keep writing, and
        // there is no later tick in which to notice it finished.
        child.kill(immediate ? "SIGKILL" : "SIGTERM");
      } catch {
        // Already gone — the close handler still runs the cleanup.
      }
      // Normally the close handler owns cleanup (git may still be writing). On
      // teardown that handler will never run, so do it here instead — twice,
      // because SIGKILL delivery is asynchronous and an already-issued write can
      // land after the first pass. What must not survive is a `.git` carrying an
      // origin and no refs, which the next run would read as "already cloned".
      if (immediate) {
        cleanup();
        if (existsSync(dest)) cleanup();
      }
    },
  };
}


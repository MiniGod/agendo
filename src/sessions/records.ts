// Claude Code's own record of which of its processes is running which session.
//
// Every interactive `claude` writes `<configDir>/sessions/<pid>.json` for as
// long as it runs: the session id it is on, the cwd it was started in, and —
// when it runs inside tmux — the `session:@window.%pane` it sits in. It is the
// same file Claude reads to find its peers, and it is the only thing on disk
// that says "THIS pane is THAT session" outright.
//
// That is what window adoption (src/app/model/adopt.ts) needs and what a
// transcript cannot give it. A hand-typed `claude` gets no `--session-id`, so
// the id it assigns itself is discoverable only after the fact; the transcript
// route — pane cwd → project dir → "the newest file" — is a guess that gets
// worse with every second session in the same directory, and a wrong guess
// here is a window `agendo close` will later kill. The record is claude's own
// statement, keyed by a pane id that tmux never reuses while the server lives.
//
// Read only. Nothing here writes to a config dir.
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { claudeBaseDirs } from "./provider.ts";

/** One live Claude process, as its record describes it. */
export interface ClaudeProcessRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  /** The tmux session and pane id the process runs in; absent outside tmux. */
  tmux?: { session: string; pane: string };
  /** The profile (`~/.claude`, `~/.claude-work`) whose sessions dir held it. */
  configDir: string;
}

/**
 * The tmux location claude records: `<session>:@<window id>.%<pane id>`. Only
 * the session name and the pane id are read back — the pane id is the stable,
 * server-unique handle everything downstream addresses, and the session name
 * is what scopes adoption to the launcher's own host session.
 */
export function parseTmuxLocation(raw: string): { session: string; pane: string } | undefined {
  const m = /^(.+):@\d+\.(%\d+)$/.exec(raw);
  return m ? { session: m[1], pane: m[2] } : undefined;
}

/**
 * One record file's text as a `ClaudeProcessRecord`, or undefined when it is
 * not one this code should act on.
 *
 * Only an INTERACTIVE process counts. A `claude -p` one-shot writes a record
 * too, and it may well run in a pane — but it is not a session anyone attaches
 * to, sends to or resumes, so adopting its window would manage nothing. Every
 * other field is validated for the same reason the window tag's are: this is
 * a file another program writes, and a malformed one must degrade to "no
 * record", never to a confident wrong answer.
 */
export function parseClaudeProcessRecord(raw: string, configDir: string): ClaudeProcessRecord | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const r = data as Record<string, unknown>;
  const pid = r.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (typeof r.sessionId !== "string" || !r.sessionId || typeof r.cwd !== "string" || !r.cwd) return undefined;
  if (r.kind !== "interactive") return undefined;
  const tmux = typeof r.tmux === "string" ? parseTmuxLocation(r.tmux) : undefined;
  return { pid, sessionId: r.sessionId, cwd: r.cwd, tmux, configDir };
}

/**
 * Whether a process with this pid exists. Signal 0 delivers nothing and only
 * asks the kernel whether it could; EPERM means the process is there but not
 * ours, which for a record in OUR config dir is not a case worth adopting.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every record of a LIVE interactive claude across all Claude profiles.
 *
 * Liveness is checked here rather than trusted: a claude that crashes, or a
 * machine that reboots, leaves its record behind, and a stale record names a
 * pid the kernel has long since handed to something else. The pid is the file
 * name, so a dead one costs a stat-free `kill(0)` and no read.
 *
 * `alive` is injectable for the same reason `buildTabs` takes `now`: the e2e
 * suite cannot conjure a dead pid on demand, but a unit test can pass a
 * predicate.
 */
export async function readClaudeProcessRecords(alive: (pid: number) => boolean = pidAlive): Promise<ClaudeProcessRecord[]> {
  const out: ClaudeProcessRecord[] = [];
  await Promise.all(
    (await claudeBaseDirs()).map(async ({ configDir }) => {
      const dir = join(configDir, "sessions");
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        const m = /^(\d+)\.json$/.exec(f);
        if (!m || !alive(Number(m[1]))) continue;
        const raw = await readFile(join(dir, f), "utf-8").catch(() => null);
        const rec = raw === null ? undefined : parseClaudeProcessRecord(raw, configDir);
        if (rec && rec.pid === Number(m[1])) out.push(rec);
      }
    }),
  );
  return out;
}

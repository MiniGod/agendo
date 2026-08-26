// How agendo names and re-invokes ITSELF.
//
// Every background session agendo starts has to be able to run `agendo …` again
// from inside a tmux pane, and the command that works there is not always the
// one the user typed: a `bunx github:…` invocation resolves to a cached path,
// a `bun run src/index.tsx` to a repo path, an installed binary to its own name.
// `SELF_CMD` is that resolved form, and `AGENDO_SELF_CMD` overrides it.
//
// Split out of launch.ts because the launcher prompt and the guide both quote
// it, and it must not import either of them back.
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";

/** Is `cmd` resolvable as an executable on the current PATH? */
function onPath(cmd: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, cmd)));
}

/** The npm/bun binary name this package installs. */
const BIN = "agendo";

/**
 * Environment variable carrying the launcher's own invocation into every session
 * it spawns (and on into the sessions THOSE spawn). A chain of sessions therefore
 * all drives the same build — the one the human started the chain with.
 *
 * Propagating beats leaving each process to work it out for itself. What survives
 * of the original invocation is thin and runner-specific (`bunx` happens to leave
 * its spec in `npm_lifecycle_script`; `npx` leaves only the bin name), and it is
 * inherited indiscriminately, so a process that merely DESCENDS from a runner looks
 * exactly like one the runner started. Nor does the environment travel by itself:
 * a session's window is spawned by the tmux SERVER, which has whatever environment
 * it was started with, not ours — hence an explicit `env` prefix on the argv.
 *
 * Getting it wrong is worse than a version mismatch: a session launched from a PR
 * build would read its `--llm` instructions from — and run every list/send/wait/
 * close through — the published release, against on-disk state this build wrote.
 */
export const SELF_CMD_ENV = "AGENDO_SELF_CMD";

/**
 * The literal package-runner spec this process was started from, if the runner
 * exposes one. Measured against bun 1.3 / npm 11 rather than assumed:
 *
 *  - `bunx <spec>` sets `npm_lifecycle_script` to the spec EXACTLY as typed —
 *    `github:minigod/agendo#HEAD`, `agendo@0.1.0`, a bare `agendo`. That is the
 *    one string that reproduces this build, so it is what we reuse.
 *  - `npx <spec>` sets it to the resolved command line instead (`"agendo"`,
 *    quoted, with any arguments), which names the bin, not the spec — the
 *    original is simply not recoverable there. Callers fall back to argv.
 *
 * Two guards, because the variable is INHERITED by every child process: a spec
 * left behind by an unrelated runner further up the tree must not be adopted as
 * ours. npm's command form is rejected by its whitespace/quotes, and any spec
 * that doesn't name this package is rejected outright.
 */
function runnerSpec(): string | null {
  const script = (process.env.npm_lifecycle_script ?? "").trim();
  if (!script || /[\s"']/.test(script)) return null;
  return script.includes(BIN) ? script : null;
}

/**
 * `argv[1]` when it sits inside a package runner's own cache — `bunx`'s
 * `/tmp/bunx-<uid>-<pkg>@…/` staging dir or npm's `<cache>/_npx/<hash>/`. Verified
 * against bun 1.3 / npm 11; any other layout simply falls through to the ordinary
 * argv branch below, which names the same build anyway.
 *
 * This is also what says we are REALLY running under a runner, which the
 * environment alone cannot: `npm_config_user_agent` and `npm_lifecycle_script` are
 * inherited by every descendant, so a plain `agendo` (or a `bun run src/index.tsx`)
 * started from a shell inside a bunx-launched session sees both and would otherwise
 * claim to be a build it is not.
 */
function runnerCacheArgv(): string | null {
  const argv1 = process.argv[1] ?? "";
  return /(^|\/)(bunx-[^/]*|_npx)\//.test(argv1) ? argv1 : null;
}

/**
 * How to re-invoke this launcher from a shell when nothing was propagated to us —
 * someone ran `agendo` themselves. Injected into agent prompts, so it must keep
 * working minutes/hours later, not just at spawn time:
 *
 *  1. Running out of a package runner's cache (`npx`, `bunx`/`bun x`): reuse the
 *     literal spec the runner was handed when it exposes one (`runnerSpec`) — that
 *     is the only form that reproduces a non-default build such as
 *     `github:owner/agendo#pull/8/head`. `npm_config_user_agent` names the runner
 *     to prefix it with; check bun first, as its user-agent also contains a bare
 *     `npm/?`, so match npm only when followed by a digit. With no spec (npx never
 *     exposes one) fall back to the cached copy itself: a bare `npx agendo` would
 *     re-resolve the PUBLISHED package instead of the one running.
 *  2. Otherwise `argv[1]` is a stable location. If a global install (`npm i -g`,
 *     `bun add -g`, pnpm, …) put `agendo` on PATH, the bare name is the cleanest
 *     invocation — no absolute path baked in. Otherwise fall back to the literal
 *     argv (covers `bun run src/index.tsx` dev and odd layouts).
 */
function derivedSelfCmd(): string {
  const cached = runnerCacheArgv();
  if (cached) {
    const ua = process.env.npm_config_user_agent ?? "";
    const runner = /\bbun\//i.test(ua) ? "bunx" : /\bnpm\/\d/i.test(ua) ? "npx" : null;
    const spec = runnerSpec();
    if (runner && spec) return `${runner} ${spec}`;
    return `${process.argv[0]} ${cached}`;
  }
  if (onPath(BIN)) return BIN;
  const argv1 = process.argv[1];
  return argv1 ? `${process.argv[0]} ${argv1}` : BIN;
}

/**
 * The command every agent-facing string tells agents to run: what our own
 * launcher was invoked as, propagated down (`SELF_CMD_ENV`), or derived from this
 * process when we are the start of the chain.
 */
export const SELF_CMD = process.env[SELF_CMD_ENV]?.trim() || derivedSelfCmd();

/**
 * The next step after any "session is not running" refusal — every command that
 * needs a live tmux window prints it (`send`, `unblock`, `wait`).
 *
 * It exists because the bare refusal reads as a death notice: an orchestrator that
 * hit it concluded the session could not be revived and relaunched the whole task
 * in a fresh worktree, abandoning the branch and commits the original had already
 * made. `resume` is the one command that answers it, so the refusal has to name it.
 *
 * `then` completes "…brings the session back, <then>" with whatever the caller was
 * trying to do.
 */
export function notRunningHint(token: string, then: string): string {
  return [
    `  It is NOT lost: its worktree, branch, commits and transcript are all still on disk.`,
    `  Bring it back with \`${SELF_CMD} resume ${token}\`, ${then}. Do not relaunch the work in`,
    `  a new session — that abandons this one's branch and commits.`,
  ].join("\n");
}

/**
 * Prefix `argv` with the `env` assignments a spawned session needs. tmux execs
 * the argv directly (no shell), so `env` is how a variable reaches the agent —
 * and from the agent, every command it runs.
 *
 * `SELF_CMD` always rides along, so the session drives the same build we are.
 * Extra vars (claude's config dir) are merged into the same prefix rather than
 * stacking a second `env`.
 */
export function withSelfCmdEnv(argv: string[], vars: Record<string, string> = {}): string[] {
  const assignments = Object.entries({ [SELF_CMD_ENV]: SELF_CMD, ...vars }).map(([k, v]) => `${k}=${v}`);
  return ["env", ...assignments, ...argv];
}

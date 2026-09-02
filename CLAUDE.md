# agendo

Terminal UI (bun + Ink) to launch/resume Claude, Copilot and Codex agent sessions as attachable tmux windows, keyed off Azure DevOps work items.

## Commits & releases

- **Commits follow [Conventional Commits](https://www.conventionalcommits.org/).** A `commit-msg` git hook (commitlint) blocks bad messages, a `pre-push` hook backstops direct pushes to master, and PR titles are validated in CI (squash-merge uses the PR title as the commit subject).
- **Releases are manual.** Trigger the **Release** GitHub Action (`workflow_dispatch`): it bumps the version from the conventional-commit log since the last tag (`commit-and-tag-version`), updates `CHANGELOG.md`, tags `vX.Y.Z`, publishes to npm, and cuts a GitHub release. The very first release uses the workflow's `first-release` input to ship the current `0.1.0` as-is.

## Tests

Two suites, and the split is deliberate.

`bun run test:e2e` (Playwright, `e2e/`) drives the real TUI and the real CLI
against fixture backends. It is the suite that catches behaviour, and it is
blocking in CI.

`bun run test` (bun's runner, `test/`) covers the pure helpers that e2e
structurally cannot reach. The width and approval logic in `src/ui/format.ts` is
the standing example: every fixture value that reaches a table cell is ASCII, and
ASCII is exactly the input class for which a correct and an incorrect cell
measure agree. Three separate bugs there were found by review rather than by a
green suite. Unit tests live in `test/` rather than beside the source because
`package.json` ships `src/` to npm, and the script is scoped to `test/` so bun
does not try to execute the Playwright specs, which it would otherwise match on
`*.spec.ts`.

A fix to a pure function belongs in `test/`. A fix to something the user can see
belongs in `e2e/`. If a bug was invisible to both, say so in the PR rather than
letting a green run imply coverage that does not exist.

`test/gitrefsReach.test.ts` is the other thing `test/` is for: an ARCHITECTURAL
invariant, walked rather than spot-checked. `e2e/cli.spec.ts` pins a proxy for it
— a filename whitelist of who may import `src/gitrefs.ts` — and that proxy is one
hop deep, so it both false-alarms on a type-only import and says nothing about
what the whitelisted file is itself reachable from. The unit test walks the real
import graph from the rescan roots. **When the two disagree, the unit test is the
one describing the bug.**

## Linting — a ratchet, not a style guide

`bun run lint` (oxlint, config in `.oxlintrc.json`) runs in CI as a **blocking**
job. Beyond the usual correctness rules it enforces size and complexity limits
on `src/**`, pinned to values that already hold — never once globally at the
worst file in the tree, because that shape lets every other file grow up to it.
Most of `src/` shares one budget; the files that blow it carry their own named
blocks. A file creeping toward the shared cap gets its own tighter block, not a
raised budget.

The shared `max-lines` budget is **486**, and **nothing in `src/` is above it**.
Getting there took the run from 1036 down through `tmux.ts`, `App.tsx`,
`launch.ts`, `ado.ts`, `sessions.ts`, `wait.ts`, `clone.ts`, `format.ts`,
`restore.ts`, `model.ts` and finally `index.tsx`, each of which became a facade
or an entrypoint over a directory of its own parts. The budget is pinned at the
worst remaining file rather than at the round 500, for the reason above: slack
in a cap is room every other file can grow into.

**There is no headroom, and that is deliberate.** 486 is where `src/activity.ts`
already sits, so a new 490-line file fails lint on the day it lands. That is not
the ratchet misfiring — it is the whole mechanism. The answer is to split the
file, never to raise the number. If a genuinely irreducible file ever needs more,
it gets its own named block with the argument in the PR, and the shared budget
stays where it is.

**No file carries a whole-file exemption any more.** What is left are per-FUNCTION
blocks — `src/ui/App.tsx`, `src/cli/send.ts`, `src/cli/close.ts` — and one
`max-params` block. Those are the next targets, and the same one-directional
contract applies to them.

Read an exemption block precisely: it replaces only the rules it NAMES, and every
other rule falls through to the shared budget. A file with a `max-lines`
carve-out was still measured on complexity.

The contract is one-directional:

- **A PR that makes a threshold achievable lowers it in that same PR.**
- **A lowered threshold never goes back up.** Raising one — or adding a file to
  the exemption list — is the only change in that file that needs an argument in
  the PR description.
- Never add a blanket disable to get under a threshold. If a limit can't be met
  honestly, leave it where it is and say so.

`react-hooks/rules-of-hooks` and `import/no-cycle` are hard errors at zero. Ink
drives a real React reconciler, so those rules mean exactly what they mean in the
DOM. `react-hooks/exhaustive-deps` and `react/no-array-index-key` are warnings
capped by `--max-warnings` in the `lint` script — the same ratchet, expressed as
a total count. **That cap is now 0.** They stay warnings rather than errors so a
careless new instance arrives as something to judge, not as a wall to climb with
a blanket disable; but nothing uncounted is left, so any new one fails CI.

**One escape hatch, deliberately narrow.** Some rules can't tell a deliberate
pattern from a careless one. `react-hooks/exhaustive-deps` is the standing
example: `src/ui/hooks/useAuthProbe.ts` and
`src/ui/hooks/useActivityWatchers.ts` each have an effect keyed to a narrower
dependency on purpose, and both carry a `-- <why>` saying so.
`react/no-array-index-key` is the other: `src/ui/components.tsx` and
`src/ui/screens/CloneScreen.tsx` render lists where the index genuinely IS the
identity and the obvious alternative key is not unique. A single-line
`// eslint-disable-line <rule> -- <why>` is the sanctioned way to say "I meant
this."

It is **not** fine for getting under a size threshold, and it is **never** fine
without the reason. A bare disable is a bug report with the text deleted.

### The linter runs the moment a file is written

`.claude/settings.json` registers a `PostToolUse` hook on `Write|Edit`
(`.claude/hooks/lint-written-file.sh`) that runs `oxlint` on the file Claude
Code just wrote and, on a violation, hands the output straight back with exit 2.

The hook has **no opinion of its own**. It does not know what the line limit is,
or that there is one — it shells out to the same `oxlint` binary CI runs, reading
the same `.oxlintrc.json`. So the two can never disagree, and adding a rule,
lowering a threshold or granting a file its own override changes what the hook
enforces for free.

That is also why the predicate is "does this file pass the linter" rather than
"is this file over N lines". The ratchet already encodes *block growth, allow
shrink*: every number in the config is pinned where the file already is, so a
file sitting at its cap still passes while an edit that grows it does not. A
naive size check would refuse every edit to a file that is already over — the
edits that make it smaller included, which is the whole of the work that got the
budget down to 486.

Two limits, stated rather than papered over:

- The matcher covers `Write` and `Edit`. A file rewritten through `Bash` — `sed`,
  a heredoc, a codemod — does not trigger it. **CI remains the backstop**; the
  hook exists to shorten the loop, not to replace it.
- It needs `jq` and an installed `node_modules`. Without either it exits quietly
  rather than failing every edit.

`bun run doctor` runs [react-doctor](https://react.doctor) — not a CI gate, a
periodic read on React/effect health.

## CRAP score — the same ratchet, one level down

The size limits above say how big a function may be. `bun run crap` says how
risky it is to change, per function, with the CRAP score (Change Risk
Anti-Patterns):

    CRAP(m) = cc(m)² · (1 − cov(m))³ + cc(m)

`cc` is cyclomatic complexity, `cov` the fraction of the function's own
statements the test suites executed. A fully covered function scores its
complexity; an uncovered one scores roughly its complexity squared. **The target
is CRAP ≤ 7 for every function in `src/`** — cc 7 fully covered, or cc 2 with
nothing — and the gate that drives there is a **blocking CI job** (`CRAP score`
in `.github/workflows/ci.yml`) that fails when any function scores above its pin
in `.craprc.jsonc`.

The pins follow exactly the contract of `.oxlintrc.json`, so read that section
first. Restated for this file:

- **Every number in `.craprc.jsonc` holds today.** `max` is the shared budget,
  pinned at the worst function not carrying a named override; the `overrides`
  list names the outliers that would otherwise set it, each with its own pin.
  Not one global number at the worst function in the tree, for the reason the
  linting section gives: slack in a cap is room every other function can grow
  into.
- **A PR that makes a pin achievable lowers it in that same PR.** The report
  says so in as many words: `NOTE shared max is N but the worst function it
  covers is … — lower it`, and `NOTE … is inside the shared max — its override
  can go`. Treat both as failures you happen to be allowed to fix in the same
  commit.
- **A lowered pin never goes back up.** Raising `max`, raising an override, or
  adding a new override is the one change to that file that needs an argument in
  the PR description. Editing the tool to score more kindly is the same change
  wearing a different hat.
- **An override for a function that no longer exists fails the run.** A pin
  nothing answers to is slack, not history — delete it.
- Overrides name a function by file and by the name oxlint gives it. A function
  oxlint reports anonymously shows up as `(anonymous L<line>)`, which moves
  whenever the file above it does; the fix for an anonymous outlier is to give
  it a name, not to pin a line number.

### How the two inputs are measured

**Complexity comes from oxlint, not from a second implementation.** `scripts/crap/cc.ts`
runs the same `complexity` rule `.oxlintrc.json` enforces, with its threshold at
0 so every function is reported, and reads the number and the span out of
`--format json`. The `complexity` line in the lint config and the `cc` column in
the CRAP table are therefore the same figure by construction.

**Coverage comes from the real suites, including e2e.** `bun --coverage` only
exists for `bun test`, and the behaviour suite is Playwright driving `bun run
src/index.tsx` as a child process. So `scripts/crap/preload.ts` is a Bun runtime
plugin that instruments `src/**` with istanbul as bun loads each module, and
writes the counters out when the process ends — on `exit`, and on the SIGHUP /
SIGTERM the harness kills the TUI and the CLI with, re-raising the signal
afterwards so the process still dies of it. `bun run crap` puts a `bun` shim on
`PATH` that adds the preload to `bun run` (the harness builds its environment
from scratch, and `PATH` is the only channel that reaches the app under test
without editing `e2e/`), runs `bun test` and `playwright test`, merges every
dump, and scores. Instrumented text is cached by content hash under
`coverage/crap/.cache/`, because the suite starts the app several hundred times.

Nothing in `src/` knows any of this exists. The package ships `src/` only; the
preload, the shim and the scorer live in `scripts/crap/`, and the product binary
is byte-for-byte what it was.

### Running it

    bun run crap                  # both suites under coverage, then score + gate
    bun run crap -- --workers 2   # anything after the flags goes to playwright
    bun run crap --report-only    # re-score the counters from the last run

The full table lands in `coverage/crap/report.json` (gitignored); the summary is
the top of it. Locally the e2e suite wants `--workers 2`, same as always.

### What it does and does not tell you

- **`cov` is per statement, per function.** Statements inside a nested function
  belong to that function, the same way eslint's `complexity` does not charge an
  outer function for an inner one's branches. A function with no statements of
  its own is covered iff it was entered.
- **A function no test ever reaches scores at cov 0**, whether or not its file
  was loaded. That is the honest number, not a gap in the tool: on the first
  measured run every file in `src/` was imported by some test, and 133 of the
  1164 functions were still never entered — almost all of `src/activity.ts`'s
  codex and copilot readers among them.
- **Coverage is not perfectly deterministic.** Retried e2e attempts add
  coverage; timing-dependent branches (a poll that does or does not loop) can
  differ between runs. The gate compares the two-decimal value the table prints,
  and the pins sit at the worst observed value, so a function riding exactly at
  its pin can in principle cross it on noise. When that happens, the fix is a
  test that makes the branch deterministic, not a raised pin.
- **The `PostToolUse` lint hook does not run this.** It needs the whole e2e
  suite, so it is a CI gate and a `bun run`, not a per-edit check. The math and
  the gate contract are covered in `test/crap.test.ts`; the measurement itself
  is only exercised by running it.

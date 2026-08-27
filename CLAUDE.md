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

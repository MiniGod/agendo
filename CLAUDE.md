# agendo

Terminal UI (bun + Ink) to launch/resume Claude, Copilot and Codex agent sessions as attachable tmux windows, keyed off Azure DevOps work items.

## Commits & releases

- **Commits follow [Conventional Commits](https://www.conventionalcommits.org/).** A `commit-msg` git hook (commitlint) blocks bad messages, a `pre-push` hook backstops direct pushes to master, and PR titles are validated in CI (squash-merge uses the PR title as the commit subject).
- **Releases are manual.** Trigger the **Release** GitHub Action (`workflow_dispatch`): it bumps the version from the conventional-commit log since the last tag (`commit-and-tag-version`), updates `CHANGELOG.md`, tags `vX.Y.Z`, publishes to npm, and cuts a GitHub release. The very first release uses the workflow's `first-release` input to ship the current `0.1.0` as-is.

## Linting — a ratchet, not a style guide

`bun run lint` (oxlint, config in `.oxlintrc.json`) runs in CI as a **blocking**
job. Beyond the usual correctness rules it enforces size and complexity limits
on `src/**`, pinned to values that already hold — never once globally at the
worst file in the tree, because that shape lets every other file grow up to it.
Most of `src/` shares one budget; the files that blow it carry their own named
blocks. A file creeping toward the shared cap gets its own tighter block, not a
raised budget.

`src/ui/App.tsx`, `src/index.tsx` and `src/tmux.ts` carry named, temporary
exemptions above that budget. They are the three files the refactor effort is
dismantling, and each exemption shrinks or disappears as its PR lands.

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
a total count.

**One escape hatch, deliberately narrow.** Some rules can't tell a deliberate
pattern from a careless one. `react-hooks/exhaustive-deps` is the standing
example: `src/ui/hooks/useAuthProbe.ts` and
`src/ui/hooks/useActivityWatchers.ts` each have an effect keyed to a narrower
dependency on purpose, and both carry a `-- <why>` saying so. A single-line
`// eslint-disable-line <rule> -- <why>` is the sanctioned way to say "I meant
this."

It is **not** fine for getting under a size threshold, and it is **never** fine
without the reason. A bare disable is a bug report with the text deleted.

`bun run doctor` runs [react-doctor](https://react.doctor) — not a CI gate, a
periodic read on React/effect health.

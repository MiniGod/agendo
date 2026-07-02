# clops

Terminal UI (bun + Ink) to launch/resume Claude and Copilot agent sessions as attachable tmux windows, keyed off Azure DevOps work items.

## Commits & releases

- **Commits follow [Conventional Commits](https://www.conventionalcommits.org/).** A `commit-msg` git hook (commitlint) blocks bad messages, a `pre-push` hook backstops direct pushes to master, and PR titles are validated in CI (squash-merge uses the PR title as the commit subject).
- **Releases are manual.** Trigger the **Release** GitHub Action (`workflow_dispatch`): it bumps the version from the conventional-commit log since the last tag (`commit-and-tag-version`), updates `CHANGELOG.md`, tags `vX.Y.Z`, publishes to npm, and cuts a GitHub release. The very first release uses the workflow's `first-release` input to ship the current `0.1.0` as-is.

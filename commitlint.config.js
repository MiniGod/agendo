// Conventional Commits ruleset. Consumed by:
//   - the `commit-msg` git hook (blocks bad messages before they're created),
//   - the `pre-push` git hook (backstops direct pushes to master),
//   - CI (`Lint commit messages` job on PRs).
// package.json is `type: module`, so this file is ESM.
export default {
  extends: ["@commitlint/config-conventional"],
};

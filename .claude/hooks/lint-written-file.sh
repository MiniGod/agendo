#!/usr/bin/env bash
#
# PostToolUse hook: lint the file Claude Code just wrote, with the repo's own
# linter and the repo's own config.
#
# The point is that this hook has NO opinion of its own. It does not know what
# the line limit is, or that there is one. It shells out to oxlint, which reads
# .oxlintrc.json — so the hook and CI can never disagree, because they are the
# same program run on the same config. Adding a rule, lowering a threshold or
# granting a file its own override changes what this hook enforces, for free.
#
# That is also why the predicate is "does this file pass the linter" and not
# "is this file over N lines". The ratchet already encodes "block growth, allow
# shrink": every number in .oxlintrc.json is pinned where the file already is,
# so a file at its cap still passes and an edit that grows it does not. A naive
# size check would refuse every edit to a file that is already over — including
# the edits that make it smaller, which is exactly the work this repo has been
# doing.
#
# Exit 2 is the one that matters: PostToolUse cannot block a tool that has
# already run, but exit 2 feeds stderr back to Claude, so the failure arrives as
# something to fix now rather than as a CI mail in ten minutes.
#
# Known gap, stated rather than papered over: the matcher only covers Write and
# Edit. A file rewritten through Bash (sed, a heredoc, a codemod) does not
# trigger this. CI remains the backstop; the hook is there to shorten the loop,
# not to replace it.
set -uo pipefail

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

# Nothing to lint: a tool call without a path, or one whose file is already gone.
[ -n "$file" ] && [ -f "$file" ] || exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts) ;;
  *) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

oxlint=./node_modules/.bin/oxlint
# No install yet (a fresh clone before `bun install`) — say nothing rather than
# failing every edit until someone runs it.
[ -x "$oxlint" ] || exit 0

if ! out=$("$oxlint" --max-warnings 0 -- "$file" 2>&1); then
  printf 'oxlint rejected the file you just wrote:\n\n%s\n' "$out" >&2
  exit 2
fi

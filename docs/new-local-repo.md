# Creating a repo that exists nowhere yet

[Cloning](cloning.md) covers a repo the user has somewhere else. This covers the
one they don't have anywhere: a new project, started from agendo, in the same
motion as starting the session that will work on it.

The repo picker — reached from all three entry points: a work item (`1`), a PR
whose repo isn't on disk (`2`), a new or orchestrator session (`3`) — carries a
second action row beside **＋ Clone from URL…**:

```
New session — pick a repo
Pick a repo  ·  ↑/↓ move · enter select · esc back · c clone · i new repo

❯ agendo                  12 sessions (12 claude, 0 copilot)  ~/git/agendo
  appweb                   3 sessions (3 claude, 0 copilot)   ~/git/appweb
  ＋ Clone from URL…        clone into ~/git
  ＋ New local repo…        git init a fresh repo where you say
```

`i` jumps straight to it. Three screens follow, and then the flow is the
ordinary one: the new repo is handed to the very same `chooseRepo` the picker's
enter key calls, so it reaches the worktree-vs-checkout dialog, the branch
prompt or the PR checkout exactly as a repo that was already on disk would.

## 1. The name

```
New local repo — name
Folder name for the new repo  ·  enter next · esc back

name: my-project▮
  → git init a new repo in a folder named my-project — next: where to put it
```

A single folder name. A slash, `.` or `..` is refused on enter with the reason;
control characters never make it into the field. Nothing else is judged — the
name is the folder's name, and git has no opinion on those.

## 2. Where it goes

```
New local repo — where should my-project go?
Parent folders of the repos you already have  ·  ↑/↓ move · enter create · esc back

❯ /home/k/git/my-project
  /home/k/work/my-project
  ＋ Other path…  type an absolute path (~/… works)
```

The list is **the parent folders of every checkout agendo knows about** —
from session history, from the path scan a scoped launcher does, and from
anything cloned or created this run — deduplicated and ranked by how many
checkouts sit in each (`rankParentDirs`). Someone with twelve repos in `~/git`
and one in `~/work` gets `~/git` first. Only real checkouts count: a session
run in a plain folder yields a repo entry too, and its parent is noise.

When the launcher is scoped to a folder that is a folder *of* checkouts rather
than one itself (`agendo ~/git`, not `agendo ~/git/agendo`), that folder goes
first regardless of the count — scoping there is a statement about where the
user is working today.

Each row shows the exact folder enter would create, parent bold and name dim,
so nothing lands anywhere unannounced.

The last row always exists and is the reason the list exists at all: absolute
paths are a chore to type, so the common ones are offered — but any path must
remain possible. **＋ Other path…** opens a one-line prompt:

```
New local repo — parent folder for my-project
Absolute path, ~/… works  ·  enter create · esc back

path: ~/src/experiments▮
  → creates /home/k/src/experiments/my-project
```

`~` and `~/…` expand to the home directory. A relative path is refused: it
would resolve against the launcher's cwd, which the user cannot see. When there
are no known repos at all — a first run — there is nothing to list, and the
name prompt goes straight to this screen; the free-text choice is the one that
is always there, so first-run works.

## 3. What happens on enter

The destination is inspected before anything is written, and every refusal
lands back on the same screen with the reason:

| at `<parent>/<name>` | result |
| --- | --- |
| nothing | created |
| an empty folder | used — `git init` runs in it |
| a folder that is already a repo (has `.git`) | **offered as-is**: `… is already a git repo — enter again to use it as-is, esc back`. A second enter adopts it; moving the cursor or editing withdraws the offer. |
| a folder with anything else in it | **refused**: `… already exists and is not empty — pick another name or folder.` Nothing is touched. |
| a file | refused |
| the parent is a file | refused |
| the parent does not exist | created along the way (`mkdir -p`), and the note says so |

Creation is `mkdir -p <dest>` then `git -C <dest> init --quiet`, in that order,
so "couldn't create the folder" and "git refused" stay distinct failures. If
git fails, a folder this step created is removed again; an empty folder the
user already had only loses the `.git` git may have started writing.

**One empty initial commit follows.** Everything downstream assumes a repo with
history: the work-item and PR flows' only route is `git worktree add -b <branch>
<path> HEAD`, which fails outright on an unborn HEAD — so a bare `git init`
would hand the user a repo the very next screen cannot use. The commit runs
with signing turned off for that one command, hooks skipped and every prompt
disabled, because a pinentry or a hook waiting on the terminal the TUI is
drawing on would hang the screen. It is best-effort: with no `user.name`
configured it fails, the repo still exists, and the note carries git's reason
(`· no initial commit: …`) rather than the init failing.

Then the hand-off. The new repo becomes a zero-session picker entry and is fed
into `chooseRepo` — `wtchoice` for a free session, `branch` for a work item,
`startCheckout` for a PR — carrying a note the next screens show as a `✓` line:

```
✓ created new repo at ~/git/my-project
✓ created new repo at ~/src/experiments/my-project (its parent folder didn't exist — created it too)
✓ using the existing repo at ~/git/my-project
```

Until the next reload discovers it through a session's cwd, the repo is held in
the same local state as a fresh clone and merged into the picker in both the
scoped and global views, so backing out with esc still leaves it selectable.

## Why it is not gated like cloning

The clone row appears only when the launcher is scoped to a directory, because
agendo must never guess where to write. Here the user names the parent folder
explicitly on every path through the flow, so there is nothing to guess — the
row is offered from a bare `agendo` and from inside a checkout alike. What it
shares with cloning is everything after: the hand-off, the note, the picker
merge. `src/initRepo.ts` knows nothing about sessions, worktrees or tmux, and
`src/ui/initActions.ts` is `cloneActions.ts` with `git init` where `git clone`
was.

## What is deliberately not here

- **No `git remote add`, no `gh repo create`.** The repo is local; publishing
  it is the agent's job or the user's, later, with the tools they already use.
- **No branch-name choice.** `git init` follows the user's `init.defaultBranch`.
- **No guard against nesting.** A typed path inside an existing checkout is
  accepted: the candidate list can never produce one, and refusing an explicit
  path would rule out setups (a dotfiles repo at `~`, a monorepo of repos) that
  are the user's to have.

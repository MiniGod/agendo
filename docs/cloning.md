# Cloning a repo you don't have locally

agendo could only ever start a session in a checkout that already existed on
disk. Someone who works across many repos — most of them not cloned — had no way
in: the new-session picker offered exactly the repos their past sessions were
already in.

This adds one step in front of that picker: **paste a repo URL, agendo clones
it, and from that point the clone is an ordinary repo row.** Nothing downstream
of the picker changes — the same worktree / in-place rules, the same launch path.

## Gate: only when the launcher is scoped to a directory

The clone entry appears **only when agendo was given a target directory**
(`agendo ~/git`) and the scope is active (`a` hasn't toggled to global view).
That's `scoped` in `App.tsx` — the same condition the scope line renders under.

Cloning writes to the filesystem, so agendo must never have to guess *where*.
A bare `agendo` has no answer to that question and therefore doesn't offer to
clone; the picker looks exactly as it does today.

**And the directory must not be inside a git checkout.** Scoping supports
`agendo .` and paths under a repo, but the clone lands as a *direct child* of
the target — so cloning from inside a checkout would drop a nested repository
into that repo's working tree, where it becomes untracked clutter forever.
Cloning belongs in a folder *of* checkouts, not in one, so the row is absent
there too (checked through `repoRootForCwd`, so a path deep inside a repo is
caught, not just its root).

## Where the clone lands

As a **direct child of the target directory** — a sibling of the checkouts
already discovered there:

```
~/git/                 ← agendo ~/git
├── agendo/            ← discovered
├── appweb/            ← discovered
└── new-repo/          ← cloned here
```

The directory name is the repo name from the URL, sanitized to
`[A-Za-z0-9._-]` (`cloneDirName`) with leading dots stripped, so an ADO repo
named `My Repo` lands in `My-Repo` and nothing can produce a hidden directory or
a literal `.git`.

Never nested, never `~/src/…`, never next to agendo itself: the user named a
directory, and that directory is the only place cloning is allowed to write.

## Where the URL is entered

In the existing repo picker, as a last row below the real repos:

```
New session — pick a repo
Pick a repo  ·  ↑/↓ move · enter select · esc back · c clone

❯ git                    (no sessions yet)         ~/git
  agendo                  12 sessions (12 claude, 0 copilot)  ~/git/agendo
  appweb                   3 sessions (3 claude, 0 copilot)   ~/git/appweb
  ＋ Clone from URL…        clone into ~/git
```

`c` jumps straight to it. Enter opens a one-line prompt (the same editable input
the branch prompt uses — arrows, ctrl-a/e, backspace):

```
Clone a repo into ~/git
Paste a GitHub or Azure DevOps repo URL  ·  enter clone · esc back

  https://github.com/owner/repo▮

  → github  owner/repo   →  ~/git/repo
```

The third line is **live feedback while typing**: the parsed host, the identity
agendo derived, and the exact directory it will create. A URL that doesn't parse
shows `not a recognizable GitHub or Azure DevOps repo URL` instead, in yellow,
and enter is inert — you never start a clone you can't predict.

## What is accepted

`parseRepoUrl` in `src/clone.ts`. Query strings and fragments are dropped first
(ADO web URLs carry `?path=/x&version=GBmain`), as are surrounding quotes and
angle brackets, so a URL pasted out of a chat client works.

**GitHub** — reuses `parseGithubRemote` from `src/github.ts`, which is
host-anchored (`github.com` must sit right after the scheme `//`, an SSH `@`, or
the string start) and port-aware. That function is extended here to stop at the
repo segment, so a *web* URL with trailing path works; a look-alike host is
still rejected:

| input | → |
| --- | --- |
| `https://github.com/owner/repo` | `owner/repo` |
| `https://github.com/owner/repo.git` / `…/` | `owner/repo` |
| `https://github.com/owner/repo/tree/main/src` | `owner/repo` |
| `https://github.com/owner/repo/pull/12` | `owner/repo` |
| `git@github.com:owner/repo.git` | `owner/repo` |
| `ssh://git@ssh.github.com:443/owner/repo` | `owner/repo` |
| `https://mygithub.com/owner/repo` | **rejected** |
| `https://github.com.evil.org/owner/repo` | **rejected** |
| `https://github.com/owner` | **rejected** (no repo) |
| `https://github.com/orgs/anthropics/repositories` | **rejected** (reserved route) |
| `https://github.com/features/copilot` | **rejected** (reserved route) |

That last pair is why `GITHUB_RESERVED` exists: a GitHub *site page* is
structurally `owner/repo` and parses happily, and the user only finds out when
git reports "not found" for something that was never a repository. GitHub
reserves those names, so rejecting them can't shadow a real owner.

**Azure DevOps** — the messy ones. The host must again sit at the very start
(after an optional scheme and `user@` userinfo), so `https://evil.example/dev.azure.com/x`
and `https://dev.azure.com@evil.example/x` are both rejected. The repo is the
segment right after `_git`, so any trailing web path (`/pullrequest/42`,
`/commit/abc`) falls away:

| input | org / project / repo |
| --- | --- |
| `https://dev.azure.com/org/proj/_git/repo` | `org` / `proj` / `repo` |
| `https://org@dev.azure.com/org/proj/_git/repo` | same (userinfo preserved in the remote) |
| `https://dev.azure.com/org/proj/_git/repo/pullrequest/42` | same |
| `https://dev.azure.com/org/_git/repo` | `org` / `repo` / `repo` (project omitted ⇒ named after the repo) |
| `https://org.visualstudio.com/proj/_git/repo` | `org` / `proj` / `repo` |
| `https://org.visualstudio.com/DefaultCollection/proj/_git/repo` | same (collection segment ignored) |
| `git@ssh.dev.azure.com:v3/org/proj/repo` | `org` / `proj` / `repo` |
| `ssh://git@ssh.dev.azure.com:22/v3/org/proj/repo` | same |
| `org@vs-ssh.visualstudio.com:v3/org/proj/repo` | same |
| `https://dev.azure.com/org/proj` | **rejected** (no `_git`) |

Percent-encoding is decoded for the identity and the directory name
(`My%20Project` → `My Project`) but the **remote keeps its encoded form**, since
that's what git has to send.

ADO hands out clone URLs with the credentials embedded
(`https://org:<PAT>@dev.azure.com/…`), and people paste them. The token stays in
`remote` — dropping it would break a clone the user explicitly authenticated,
and it reaches git's argv either way, exactly as it would from their shell — but
the UI renders `displayRemote`, in which credentials are masked. A pasted PAT
must not end up in terminal scrollback.

`user:secret@` is the easy case (mask the half after the colon, keep the name).
A **bare** `something@` is the hard one, because the two things it can be are
structurally identical: ADO's own Clone-button URL puts the *org* there, and a
token pasted without a username looks exactly the same. So bare userinfo is
masked unless it's a name we can vouch for — `git` (the SSH user in every scp
form) or the org the URL itself parsed to. Masking a real username costs
nothing; printing a PAT does not.

The clone URL agendo actually runs is canonical, not the pasted string: HTTPS
input → `https://…/_git/repo` (ADO) or `https://github.com/owner/repo.git`;
SSH input → the SSH clone form. But everything about the pasted URL that is part
of the user's **access path** is carried over, because rewriting it away turns a
URL that works in their shell into one that fails in agendo:

- **the scheme family** — HTTPS and SSH are different credential setups;
- **embedded credentials** — `https://x-access-token:TOKEN@github.com/acme/private`
  keeps its userinfo (see the redaction note below), same as the ADO form;
- **an alternate SSH host and port** — `ssh://git@ssh.github.com:443/owner/repo`
  is what you use when your network blocks port 22; collapsing it to
  `git@github.com:` would hang until the TCP connect timed out. That one needs
  the explicit `ssh://` form, since the scp-like form can't carry a port (its
  `:` is the path separator). The ADO SSH path makes the same call for the same
  reason; an explicit `:22` collapses back to the scp form, being the default.

The prompt accepts a **pasted** URL, which arrives as a single chunk and usually
carries the trailing newline of the line it was copied from. Control characters
are stripped and the rest is inserted — but the paste is deliberately *not*
treated as a submit, because the destination preview only means something if the
user gets to read it before pressing enter.

Anything else — a bare path, `file://`, a GitLab remote, junk text, a leading
`-` — is rejected, and `git clone` is invoked with `--` before its arguments so
a remote can never be read as a flag.

## Collisions

Checked in this order, against `parseRepoUrl`'s canonical key
(`github:owner/repo`, `ado:org/project/repo`, lowercased):

1. **An existing checkout of the same repo** — the target directory itself and
   each direct child that is a *main* checkout are asked for their `origin`; the
   first whose origin parses to the same key **is reused**. No second clone, no
   second copy. ("Main" means `.git` is a directory: a linked worktree has a
   `.git` file but reports the same origin, and handing one back as a repo root
   would nest a worktree inside a worktree.) The picker jumps straight on with a
   notice:
   `already cloned — using ~/git/repo`. This is the case that matters most: the
   tester pastes a URL for something he cloned last month under a different
   folder name, and gets his existing checkout.
2. **The destination doesn't exist, or exists and is empty** — clone into it.
3. **The destination exists with something else in it** — try `repo-2`,
   `repo-3`, … up to `repo-20`, and say where it landed
   (`cloned into ~/git/repo-2`). Failing outright would strand a user whose
   folder name merely collides; landing somewhere unannounced would be worse, so
   it lands and reports. After 20 tries it gives up with a legible error rather
   than inventing a name.

Note the asymmetry: a *same-repo* checkout is reused wherever it sits in the
target directory, but a *name* collision only ever shifts the new directory.

## Auth

agendo invents no credential path. It runs `git clone` and lets the user's own
git resolve credentials — SSH agent, credential helper, `gh auth setup-git`,
Git Credential Manager. Whatever `git clone` works with in their shell works
here.

What it *does* do is refuse to hang. A private repo with no credentials makes
git block on a `Username:` prompt — on a stdin agendo doesn't own, which would
freeze the TUI with no way out. So the clone runs with:

- `GIT_TERMINAL_PROMPT=0` — no terminal prompting,
- `GIT_ASKPASS` / `SSH_ASKPASS` removed from the child env — no GUI prompt,
- `-o BatchMode=yes` **appended** to `GIT_SSH_COMMAND` — no passphrase prompt.
  Appended rather than set-only-when-unset: `ssh` reads passphrases straight
  from `/dev/tty`, not stdin, so a user's own `GIT_SSH_COMMAND` (`ssh -i …`, a
  wrapper script) would prompt into the terminal the TUI is drawing on and hang
  the clone screen. Their command is preserved; the extra `-o` just adds the
  guarantee. Agent-held keys, which is how SSH auth normally works, are
  unaffected by BatchMode.

Failures get one of three readings, and each shows agendo's interpretation *and*
git's own words, on separate lines — git's line is the half that identifies the
real problem, so it must not be the half a narrow terminal truncates:

| stderr looks like | reported as |
| --- | --- |
| host key verification failed / no matching host key | `Unknown SSH host — agendo runs git non-interactively, so it can't accept a new host key for you. Run \`ssh -T <host>\` once, accept it, then try again.` |
| auth failed / permission denied / `terminal prompts disabled` / 403 / TF401019 | `Authentication — agendo uses your existing git credentials; check your SSH agent, or \`gh auth setup-git\` / \`az repos\` for HTTPS.` |
| repository not found / could not read from remote | `Not found — check the URL, or (if it's private) that your git has access to it.` |
| anything else | git's `fatal:` line alone |

**Order is load-bearing, in both directions.**

The host-key case comes first because it's a consequence of *our own* BatchMode:
ssh would normally ask whether to trust an unknown host, and we turned that off,
so a first-ever SSH clone from `ssh.dev.azure.com` fails here. "Check your SSH
agent" would send that user looking in entirely the wrong place.

Auth comes before not-found because git ends **every** failed SSH handshake with
`fatal: Could not read from remote repository.` — including the one whose real
cause is the line above it (`Permission denied (publickey).`). Matching the
not-found pattern first would classify every SSH credentials failure as a
missing repo. Nothing in the auth patterns appears in a genuine 404, so the
reverse mix-up can't happen.

And the not-found case is deliberately **not** folded into auth even though
GitHub answers an unauthorized private repo with a 404: "check your credentials"
would be a confident wrong answer for what is far more often a typo, so the
message carries both readings.

Which *line* is quoted follows the classification, not the `fatal:` prefix —
otherwise the SSH case would show the generic summary and throw away
`git@github.com: Permission denied (publickey).`, which has no prefix at all.

**Partial clones are always cleaned up.** If agendo created the destination
directory and the clone fails or is cancelled, the directory is removed. A
directory that already existed (the empty-directory case) is *emptied* instead —
the same distinction git draws for itself. Not skipped: `git clone` writes
`remote.origin.url` into the config before it fetches anything, so a killed
clone would otherwise leave a `.git` with an origin and no refs, which the reuse
check above would cheerfully report as "already cloned" and launch a session in.

## A very large repo

The clone is asynchronous — `spawn`, not `spawnSync` — so the TUI keeps
rendering throughout. `git clone --progress` writes its counters to stderr even
when stdout isn't a TTY, and the last line is shown live:

```
Cloning repo  (18s)
  from  https://github.com/owner/repo.git
  into  ~/git/repo

  Receiving objects:  47% (52134/110921), 88.4 MiB | 11.2 MiB/s

  esc cancels
```

An elapsed-seconds ticker runs alongside, so the screen still changes during the
silent phases (DNS, TLS, server-side `Enumerating objects`) — it can never look
frozen. **esc cancels**: the child is killed and the partial directory removed.

`q` is suppressed on this screen and on the URL prompt before it. On the prompt
that's because it's a text input and `q` is an ordinary character —
`github.com/qmk/qmk_firmware` has to be typeable. On the clone screen it's
because a `git clone` is mid-write: the way out is cancelling it (esc), which
cleans up, rather than walking away from a half-made checkout.

Ctrl-c is *not* suppressed — ink handles it before the app sees it, so it quits
from everywhere. What makes that safe is the unmount cleanup: teardown kills the
clone and removes the partial directory synchronously.

Resolving the destination reads the filesystem (one `git remote get-url` per
sibling checkout, a stat per candidate directory), so it runs off the render
path in an effect: the parsed identity appears the instant you type, the
destination line a beat later, and the TUI never blocks on it. Origins are
cached per directory for the process lifetime.

**Full clone, not `--depth`.** Every downstream thing agendo does with a repo
needs history: `git worktree add -b … origin/HEAD`, diffing against the base
branch, `git log` for the agent to read. A shallow clone makes the first of
those work and quietly breaks the rest, which is a worse failure than a slow
clone the user can watch and cancel. `--filter=blob:none` (full history, lazy
blobs) is the interesting middle and is worth revisiting — it trades a fast
first clone for needing the network later, so it isn't obviously right for
someone about to work offline.

## After the clone

The clone becomes a zero-session `RepoInfo` and is fed into **the exact same**
`chooseRepo` the picker's enter key calls — `wtchoice` for a free session,
`branch` for a work item, `startCheckout` for a PR. There is no second
session-creation path, and `src/clone.ts` knows nothing about sessions,
worktrees, or tmux.

Until the next reload discovers it through a session's cwd, the fresh clone is
held in local state and merged into the picker's repo list (in both the scoped
and global views), so backing out with esc — or toggling `a` — still leaves it
selectable.

What the clone step did is carried onto the screens that follow it, since those
replace the list the notice banner lives on: the where-to-run and branch prompts
show it as a `✓` line, and the PR flow — which goes clone → checkout → launch in
a single keystroke — folds it into the launch notice.

## What is deliberately not here

- **No credential prompting or token storage.** If the user's git can't clone
  it, agendo says so.
- **No `git init`** for an empty folder — the picker's non-repo row is
  `new-user-bootstrap`'s territory.
- **No clone from the work-item / PR views.** A PR row already knows its repo;
  cloning the repo a PR lives in is a reasonable follow-up but a separate flow.
- **No ADO remote parser unification.** PR #13 adds an ADO branch to
  `repoScopeKeys()` in `src/repos.ts` for a different purpose (repo *identity*
  for filtering). `parseRepoUrl` here is the more complete parser and exports
  its canonical key; whichever lands second should collapse into it rather than
  leaving the repo with two.

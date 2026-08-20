# Path-scoped launchers ("contexts")

## Problem

Today agendo runs a single, global launcher:

- One hardcoded host tmux session, `LAUNCHER_SESSION = "agendo"` (`src/tmux.ts`),
  assumed at ~14 call sites.
- The session list is global — `tmux list-windows -a` / `list-panes -a` feed the
  live reconciliation, and the Sessions view lists every on-disk session on the
  machine.
- Restore snapshots the one canonical session into a single
  `~/.agendo/restore.json`.

We want **multiple launchers running in parallel**, each scoped to a path:

1. **One repo.** `agendo .` inside a repo → only that repo's sessions, isolated
   from other launchers.
2. **A tree of repos.** `cd ~ && agendo work` (or `agendo ~`) → every repo under a
   parent folder, shallow or deep.

…while a bare `agendo` keeps behaving exactly as today (global, session `agendo`).

## Design

### CLI surface

```
agendo                 Global launcher (session "agendo"), unchanged.
agendo <path>          Launcher scoped to <path>, bootstrapped into its own
                      tmux host session (agendo-<basename of <path>>).
agendo <path> --no-tmux  Same scoping, menu rendered inline (no tmux session).
agendo -s <name> …     Override the derived host session name.
```

`<path>` is an ordinary positional; it is only interpreted as a path when it is
**not** one of the existing subcommands (`launch`, `list`/`ls`, `status`,
`send`, `help`). A directory literally named like a subcommand is disambiguated
with `./launch` or `-s`.

`agendo list [dir]` / `agendo ls [dir]` accept the same optional path and filter
the running-session listing to sessions whose cwd is under the resolved dir
(`isUnderRoot`), so the CLI mirrors the TUI's scoping. `agendo launch` already
runs in `cwd`, and `agendo send <id> …` acts on one specific session, so neither
takes a scope.

### Scope selectors on the CLI (`--path` / `--repo`)

`src/scope.ts` generalizes that `[dir]` filter into the selector pair `list`,
`status` and `wait` share, so the three can't drift into different ideas of
"in this repo":

| flag | meaning |
| --- | --- |
| `--path <dir>` | the session's cwd is `<dir>` or under it (`isUnderRoot`, segment-aware — `/x/repo` never matches `/x/repo-other`) |
| `--repo <name>` | the session's checkout belongs to that repo — `repoScopeFilter` in `sessions.ts`, the *same* matcher as the work-item↔session join, so `owner/repo` slugs beat same-named forks and a worktree resolves to its parent repo |

Both are optional and AND-ed. On `list` they apply to every mode (plain, `--all`,
`--json`, `--pr`/`--issue` queries); `--path` is the flag spelling of the `[dir]`
positional. `list` and `status` parse and apply them in the CLI entrypoint;
`wait` owns its whole argv tail (`parseWaitArgs` in `src/wait.ts`), so it parses
them there and carries the resolved `SessionScope` on `WaitOptions` — one shared
`scope.ts` predicate either way.

A scope **narrows every other selector rather than competing with one**, which is
the invariant that makes it trustworthy: `wait --all --repo X` waits on the
sessions in X, not on all of them (the precedence *among* `wait`'s own selectors
is untouched — `--all` still overrides `--prefix`), and an explicit
`wait <id> --repo X` / `status <id> --repo X` refuses an id that isn't in X
instead of quietly answering for it. So on `status` and `wait` an `<id>` still
names the session — the scope
narrows the set it is resolved *against*, so an orchestrator polling one repo
can't be handed a same-short-id session from another project, and the "no session
found" message names the scope that excluded it. `status` additionally declines
its live-window fallback (the "running, no transcript yet" answer for a
just-launched session) under a scope: a bare tmux target carries no cwd to hold
against one. No selector ⇒ no filtering, unchanged.

`--path` resolution (`resolveScopeRoots`) keeps **both** the literal
`path.resolve` spelling and the symlink-resolved one when they differ. Recorded
session cwds are real process working directories (already symlink-free), so a
symlinked checkout needs the real form to match anything — but a tree that is
itself reached through a symlink (macOS `/tmp` → `/private/tmp`) records the
symlinked spelling, where only the literal form matches. Keeping both makes the
filter a superset of the naive one, so it can never hide a session a plain
`resolve` would have found.

A scope flag with no value (`agendo list --repo`, or a flag immediately followed
by another flag) is a hard error rather than a silent no-op: the one failure mode
a scoping flag must not have is quietly returning *more* than was asked for.

### The context

A path resolves to a `LauncherContext` (`src/context.ts`):

```ts
interface LauncherContext {
  filterRoot: string | null; // absolute; null = global (bare agendo)
  hostSession: string;       // tmux host session for the menu + its windows
}
```

- **`filterRoot`** — `path.resolve(cwd, <path>)`. Drives which sessions the TUI
  shows. `null` for bare `agendo` (no filtering).
- **`hostSession`** — `agendo-<basename(filterRoot)>`, with the basename
  sanitized to a tmux-safe name (`.`/`:`/whitespace → `-`); or the `-s` override
  (honored verbatim, no prefix); or `"agendo"` as the ultimate fallback (bare
  launcher, or a path like `/` whose basename sanitizes to nothing). The
  `agendo-` prefix (derived from `LAUNCHER_SESSION` so the two never drift)
  namespaces our launcher sessions so they're clearly ours and don't collide
  with the user's own tmux sessions. This is the tmux session the menu runs in,
  so any agent window it opens (an inside-tmux `new-window`) lands there
  automatically — no per-launch session juggling, and parallel launchers stay
  isolated.

Both are derived by one pure function, `resolveContext(pathArg, cwd, session?)`,
unit-tested in isolation.

### Filtering (segment-aware)

`isUnderRoot(cwd, root)` — `cwd === root`, or `cwd` starts with `root + "/"`
(after trailing-slash normalization). Segment-aware so `~/work` does **not**
match `~/workshop`.

The filter is applied as a **pure display overlay** in the UI layer:

- Sessions view: session groups filtered by `isUnderRoot(session.cwd, root)`.
- Repo picker (fresh-session flow): repos where the repo root is under the
  filter root, or the filter root is under the repo root (covers both use
  cases).
- Nested sessions under work-item / PR rows: filtered the same way. The WI/PR
  rows themselves are **kept** (they're backend-scoped and may legitimately have
  no local sessions) — only their session lists and running counts are filtered.

Crucially, **tmux reconciliation stays global.** `refreshLiveTmux` /
`reconcileLive` still read every pane and attribute every managed window over
the *full* session set, so the regression-prone window→session attribution is
untouched. Filtering never removes a session before attribution — it only hides
already-attributed sessions from the view. `isRunning(s, live)` keeps using the
full live set.

### Provider detection from the git remote

When the context is a path (a `filterRoot`), the launcher inspects that path's
git `origin` remote and **forces the backend that tracker implies** — GitHub for
a github.com origin, Azure DevOps for `dev.azure.com` / `ssh.dev.azure.com` /
`*.visualstudio.com` — handling both the SSH (`git@github.com:owner/repo`,
`git@ssh.dev.azure.com:v3/org/proj/repo`) and HTTPS
(`https://github.com/owner/repo`, `https://dev.azure.com/org/proj/_git/repo`)
forms. This overrides the persisted/default provider, so opening `agendo .`
inside a checkout lands you on the right backend without a manual toggle. When
the target is a plain parent folder with no remote of its own,
`detectScopeProvider` asks the repos found inside it instead, taking the first one
that names a known backend.

**Known limitation — first match wins.** A target folder that holds repos from
more than one tracker resolves to whichever repo the downward walk reaches first
(name order). Everything from the other tracker is then filtered against scope
keys it cannot match, so those items and PRs disappear from the views. This is
**accepted, not guaranteed correct**: agendo is not meant to be pointed at a
parent that mixes trackers, and mix detection, majority voting or per-repo
backends would all cost more complexity than the case is worth. Point it at a
folder whose repos share a tracker, or scope to the individual repo. `f` also
turns the narrowing off if you land in that situation and want the full lists
back.

Detection has to run **both ways** now that a path context also filters the
work-item / PR lists: the scope keys are derived from the same remotes, so a
persisted GitHub default pointed at an ADO folder would query GitHub and then
filter it against bare ADO repo names — matching nothing, and silently emptying
the view.

Any other host, a repo with no `origin`, or a non-repo path all yield `null`,
leaving the configured default untouched. Forcing is also gated on the target
backend's CLI being installed (via `resolveInitialProvider`'s `forced` argument)
so a GitHub repo without `gh` (or an ADO one without `az`) falls back rather than
stranding the launcher on an unauthenticatable backend.

**Precedence:** the git-remote detection overrides the persisted default. There
is no explicit per-invocation provider flag today; the persisted `state.json`
provider is the "configured default" that a detected remote overrides. Bare
`agendo` (no `filterRoot`) never runs detection — it keeps the persisted choice.

### Global toggle

`a` toggles between the scoped view and the global (unfiltered) view at runtime.
(`g` stays bound to repo-grouping in the Sessions/PRs views, unchanged — hence
`a` = "all" rather than the originally-sketched `g`.) The toggle is only active
when a `filterRoot` exists; bare `agendo` is already global.

### Repo filter (work items / PRs)

The path filter above scopes *sessions* by cwd. A path context also scopes the
**backend data**: the launcher resolves the path to git checkouts
(`discoverGitReposUnder`, `src/repos.ts` — the checkout the path belongs to when
there is one (itself, its enclosing repo when the path sits below a repo root, or
the main repo when it's a worktree), else every repo nested under it, skipping
dot-directories, worktrees and `node_modules`, never following symlinks) and
narrows the work-item and PR views to those repos.

The discovered repos are also **unioned into the fetch scope** (`ctx.repos`), so
a backend that queries per repo (GitHub) covers a repo inside the target even if
no session ever ran there. That union is unconditional, which keeps the filter a
pure display overlay: toggling it never refetches.

Matching (`repoScopeKeys` → `prInRepoScope` / `itemInRepoScope`, shared by the
TUI and `agendo list pr|issues`):

- Each repo contributes the identifier its `origin` remote says a backend uses
  for it: a github.com remote contributes **only** the `owner/repo` slug (never
  the bare repo name — that would let a fork under another owner match through
  `PullRequest.repositoryName`), an Azure DevOps remote contributes the repo
  name (`…/_git/<repo>` over https, `v3/<org>/<project>/<repo>` over ssh). The
  directory basename is used **only as a fallback**, when neither remote form
  matched (no `origin`, or an unrecognized host).
- **PRs** carry a repo identity on both backends (`repositoryId` is a slug on
  GitHub, a guid on ADO; `repositoryName` is the display name), so PR filtering
  is exact.
- **GitHub issues** carry their `owner/repo` slug in `project` → exact.
- **ADO work items have no repo at all** (`project` is the *team project*), so
  they match transitively through their linked PRs. An item with no PR yet has
  no repo signal and is deliberately **kept** — dropping the whole PR-less
  backlog would hide the work the user opened the launcher to start.

Toggle: **`f`** ("filter"), on by default whenever a `filterRoot` exists, not
persisted (like `globalView`). It is independent of `a`: `a` scopes sessions by
path, `f` scopes items/PRs by repo. Both are advertised on the scope line. A
path with no repo inside it leaves the filter inert (and says so) rather than
emptying the views — an empty scope is likelier a wrong path than an intent.

The scan is cached per target for the process lifetime. `r` (refresh) passes
`fresh`, re-walking the tree so a repo cloned into the target *after* launch
joins the scope without a restart; the background live-session poll keeps the
cached result, so only an explicit refresh pays for a rescan.

CLI mirror: `agendo list pr [dir]` / `agendo list issues [dir]`, with
`--repo-filter` / `--no-repo-filter` overriding the "on when a dir is given"
default. The `[dir]` picks the **backend** the same way the menu does
(`detectScopeProvider`), so the tracker its origin points at wins over the
persisted default — otherwise the CLI would query one backend and filter it
against the other's repo identities, and show something different than the TUI at
that path.

### Host session name collisions

Two different paths can share a basename (`~/a/proj`, `~/b/proj`). On fresh
creation the launcher records the absolute root as a tmux **session option**
`@cl_root`. When the launcher would attach to an existing host session (the
default, tmux-backed path), it compares `@cl_root` to the requested root; on
mismatch it refuses and tells the user to pass `-s <name>`. Bare `agendo` (null
root) neither sets nor checks `@cl_root`.

### Per-host-session restore

Browser-style tab restore becomes **per host session** so parallel launchers
don't clobber each other's snapshots. Snapshots live at
`~/.agendo/restore/<session>.json` (one file per host session — avoids concurrent
writers racing on a shared map). Reads for the default `agendo` session fall back
to the legacy single-file snapshots — `~/.agendo/restore.json` (pre-per-session),
then the prior `~/.clops/restore.json`, then `~/.claude-launcher/restore.json` —
so existing installs keep working across both the tool rename and the format
change. Writes always go to the new per-session location.

`agendo launch` records its background tab into the restore bucket of the tmux
session the new window actually landed in (queried via `currentSessionName()`),
so a launch from inside a scoped host session is restored by that same launcher.

## Key couplings reworked

| File | Change |
|------|--------|
| `src/context.ts` (new) | `resolveContext`, `isUnderRoot`, `tmuxSafeName`. Pure, unit-tested. |
| `src/tmux.ts` | `LAUNCHER_SESSION` stays the default; `launcherWindowPaths`/`launcherWindowLive`/`spawnLauncherWindow`/`enterLauncherSession` take a `session` param (defaulted). New `sessionRoot`/`setSessionRoot` (`@cl_root`) and `currentSessionName`. |
| `src/restore.ts` | Restore keyed per host session; legacy fallback; `captureRestore`/`restoreTabs`/`recordLaunchedSession` take a session name. Attribution helpers (`resolveWindowSession`, `bestSessionForCwd`) unchanged. |
| `src/model.ts` | `LoadModelOptions.hostSession`; passed to `captureRestore`. Reconciliation unchanged. |
| `src/provider.ts` | New `detectRepoProvider(path)` (github.com remote → `"github"`, else `null`). `resolveInitialProvider` gains a `forced?` arg that overrides the persisted default when its CLI is installed. |
| `src/index.tsx` | Parse `[path]`/`-s`; build the context; thread it into the default tmux-host bootstrap (collision check + `restoreTabs`), the `--no-tmux` menu render (now `runMenu(ctx)` in `src/cli/menu.tsx`, which passes the App props), and `launch`. Subcommands stay global. |
| `src/ui/App.tsx` | `filterRoot`/`hostSession` props; `globalView` state + `a` toggle; scope filter applied in the row builders and repo picker; header/status scope indicator. `openTarget` (launch.ts) needs no change — the host session is set by `enterLauncherSession`, and inside-tmux `new-window` already targets the current session. |

## Testing

- Unit: `resolveContext` (path → filterRoot + hostSession, `-s` override,
  fallbacks) and `isUnderRoot` (segment-aware; `~/work` ≠ `~/workshop`).
- e2e: a multi-context fixture with agents under two different path roots,
  asserting the filter scopes correctly and the `a` toggle reveals all with
  correct labels — added to `e2e/detection.spec.ts` (unit-level) plus the
  browser harness where applicable.

## Invariants

- Bare `agendo` is byte-identical to today: session `agendo`, no filter, legacy
  restore file honored, `g` still groups. Two deliberate exceptions:
  - **Bootstrap.** When the session-derived repo list is **empty** (a fresh
    install — no sessions anywhere), the new-session picker falls back to the
    launcher's cwd resolved to its enclosing checkout. Without it the picker has
    nothing to offer and the first session can never be created, since a repo
    only enters that list by already having a session in it. An install with any
    session at all keeps its ranking untouched. The walk-up is bounded
    (`bootstrapRepoRoot`): unlike a `[path]` argument, an inferred root must stop
    below `$HOME`, or a dotfiles-tracked `$HOME` would be offered as the repo and
    a worktree would land in `~/.claude/worktrees/`.
  - **The no-checkout hint.** The work-item / PR repo picker warns when none of
    its choices can host a worktree. That can also render on an established
    unscoped install whose sessions all ran in plain folders — it is a warning,
    never a change to what is offered or ranked.
- Live window→session attribution is never gated by the path filter.

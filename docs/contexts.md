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
(`isUnderRoot`), so the CLI mirrors the TUI's scoping. `agendo status <id>` and
`agendo send <id> …` operate on a specific session id, so they stay global
lookups (a path filter there would only get in the way). `agendo launch` already
runs in `cwd`.

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
git `origin` remote and **forces the GitHub backend** when the origin host is
github.com — handling both SSH (`git@github.com:owner/repo`) and HTTPS
(`https://github.com/owner/repo`) forms. This overrides the persisted/default
provider (which may be Azure DevOps), so opening `agendo .` inside a GitHub
checkout lands you on the GitHub backend without a manual toggle.

The override is deliberately **one-directional**: `detectRepoProvider` returns
`"github"` or `null` — never `"ado"`. An ADO remote (`dev.azure.com` /
`*.visualstudio.com`), any other host, a repo with no `origin`, or a non-repo
path all yield `null`, leaving the configured default untouched. It is also
gated on the `gh` CLI being installed (via `resolveInitialProvider`'s `forced`
argument) so a GitHub repo without `gh` falls back rather than stranding the
launcher on an unauthenticatable backend.

**Precedence:** the git-remote detection overrides the persisted default. There
is no explicit per-invocation provider flag today; the persisted `state.json`
provider is the "configured default" that a GitHub remote overrides. Bare
`agendo` (no `filterRoot`) never runs detection — it keeps the persisted choice.

### Global toggle

`a` toggles between the scoped view and the global (unfiltered) view at runtime.
(`g` stays bound to repo-grouping in the Sessions/PRs views, unchanged — hence
`a` = "all" rather than the originally-sketched `g`.) The toggle is only active
when a `filterRoot` exists; bare `agendo` is already global.

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
| `src/index.tsx` | Parse `[path]`/`-s`; build the context; thread it into the default tmux-host bootstrap (collision check + `restoreTabs`), the `--no-tmux` menu render (App props), and `launch`. Subcommands stay global. |
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
  restore file honored, `g` still groups.
- Live window→session attribution is never gated by the path filter.

# e2e — browser-rendered integration tests

These tests render the launcher's Ink TUI in a **real browser** and drive it
with keystrokes, asserting on what's actually on screen. Everything the launcher
touches — Azure DevOps, sessions on disk, tmux, git, the browser opener — is
mocked, so the suite is hermetic: no `az login`, no real tmux server, no git
repos, no network, and **no risk of launching real agents or touching your
worktrees**.

## Running

```bash
bun run test:e2e:setup   # one-time: download the Chromium Playwright uses
bun run test:e2e         # run the suite
bun run test:e2e -- --headed --debug   # watch / step through
bun run typecheck:e2e    # type-check the harness on its own (Node + DOM libs)
```

## How it renders a terminal in a browser (`harness/wterm.ts`)

Built on [**wterm**](https://wterm.dev) (`@wterm/dom` + `@wterm/core`, Vercel
Labs' Zig→WASM DOM terminal emulator):

1. The launcher is spawned in a **pseudo-terminal** (`node-pty`) at a fixed size,
   so Ink sees a real TTY and emits its normal ANSI frames.
2. The test page hosts one long-lived `@wterm/dom` `WTerm` — a real VT state
   machine running as WASM in the browser, rendering to the DOM.
3. PTY output is streamed into that terminal as it arrives: byte deltas are
   forwarded **in order** (writes are serialized) so the emulator state always
   matches what a real terminal would show.
4. The screen is read straight from the WASM grid (`bridge.getCell`), and
   keystrokes are written straight to the PTY.

`@wterm/dom` is bundled for the browser once per process with `bun build`
(its WASM binary is inlined, so the page is fully self-contained — no CDN, no
separate `.wasm` fetch). Reading the grid from the bridge is synchronous after a
write, so assertions don't depend on a paint; screenshots wait one frame so the
DOM render lands.

`WebTerminal` exposes `press(key)`, `write(text)`, `screen()`, `waitForText()`,
`waitForStable()` and `screenshot()`. `KEY` holds the escape sequences for
arrows / enter / tab / esc / etc.

> Keys are sent with a short settle (`press`) between dependent steps: Ink's
> input handler closes over the `cursor`/`rows` of its last render, so two
> keystrokes fired before React commits the first would both act on stale state.
> `press` reproduces human typing cadence and keeps navigation deterministic.

## Snapshot testing (`screenshots.spec.ts`)

Every view is guarded by a **styled-grid snapshot** (`toMatchSnapshot`): the
rendered terminal grid as text, with inline `⟨color,attr⟩` tags on any
non-default run, e.g.

```
▾ #101     User Story ⟨gray⟩In Progress  ⟨yellow⟩Add login screen … ● 1/1      ⟨green⟩
    ▾ ● [claude] Implement login form  <ago>  (running → attach)⟨black,bg:cyan⟩
```

It's read straight from the WASM cell buffer (`bridge.getCell` → `fg/bg/flags`),
so it's deterministic and diff-friendly, yet still catches **color and attribute
regressions** (a green "running" badge turning gray, a rejected PR losing its
red) — which a plain-text snapshot misses and a pixel screenshot catches only
brittly. Volatile bits (relative times, the random temp-home path) are
normalized so baselines stay stable over time.

```bash
bun run test:e2e                       # compare against committed baselines
bun run test:e2e -- --update-snapshots # regenerate after an intentional UI change
```

Baselines live in `e2e/screenshots.spec.ts-snapshots/` (committed). A plain PNG
of each view is also saved to `e2e/screenshots/` as a non-asserted artifact for
eyeballing (gitignored).

## How the environment is mocked (`harness/mockEnv.ts`)

Each test gets a throwaway temp dir and a clean env (see `harness/test.ts`
fixtures `mock` + `launch`):

| Boundary | Real dependency | How it's mocked |
| --- | --- | --- |
| Sessions + config | `~/.claude*/projects`, `~/.copilot`, `~/.claude-launcher` | `HOME` → a fixture home tree (`fixtures.ts` → `materializeHome`). `os.homedir()` honors `$HOME`. |
| Azure DevOps REST | `dev.azure.com`, `app.vssps.visualstudio.com` | A local mock HTTP server (`adoServer.ts`); the app points at it via the `ADO_BASE_URL` / `ADO_VSSPS_URL` env seams added to `src/ado.ts`. |
| `az` token | `az account get-access-token` | Fake `az` shim returns a static token. |
| `tmux` | the user's tmux server | Fake `tmux` shim — answers `list-*`/`has-session` from a JSON state file and logs every call; **starts nothing**. Live "running" state is just fixture data. |
| `git worktree add` | real repos | Fake `git` shim — `mkdir`s the target path, logs the call; never touches a repo. |
| `claude` launch / `xdg-open` | spawning agents / a browser | Fake shims that only record the invocation. |

The shims live in `e2e/fakebin/` and are placed **first on `PATH`**. `TMUX` is
deliberately left unset so the launcher takes its outside-tmux code path. Tests
assert side effects (fresh-session launch, open-in-browser) by reading the fake
shims' call logs via `mock.tmuxLog()` / `mock.callLog()`.

## The fixture scenario (`harness/fixtures.ts`)

Shaped to exercise every branch of the view model:

- **WI 101** (current sprint) → linked **PR 5001** → a **running** Claude session
  (`feature/login`), with parseable activity (prompt + Read/Edit/Bash/Thinking).
- **WI 102** (current sprint) → no PR, matched to a session by the work-item id
  embedded in its branch name.
- **WI 103** → an older sprint, so it lands under "Everything else assigned".
- **PR 6001** → an orphan draft PR (no work item) with a Copilot session.
- a standalone Claude session in a plain checkout (exercises the repo-root walk-up).

## Files

```
e2e/
  harness/
    wterm.ts       PTY ↔ wterm-in-browser terminal + key/assert helpers
    wterm-browser-entry.ts  browser entry (exposes @wterm/dom), bundled by bun
    mockEnv.ts     assembles the isolated env (temp HOME, PATH, ADO server, logs)
    adoServer.ts   mock Azure DevOps REST server
    fixtures.ts    fake HOME tree + ADO payloads + initial tmux state
    test.ts        Playwright fixtures (`mock`, `launch`)
  fakebin/         fake az / tmux / git / claude / xdg-open executables
  launcher.spec.ts behavioral tests (navigation, flows, side effects)
  screenshots.spec.ts          styled-grid snapshot tests for every view
  screenshots.spec.ts-snapshots/  committed snapshot baselines
  screenshots/     non-asserted PNG artifacts for eyeballing (gitignored)
```

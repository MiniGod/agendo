# Sessions on another machine

## Problem

`beam ls`, run on this machine, today:

```
$ beam ls
TARGET                           MACHINE  WINDOWS  STATUS
agendo-agendo                    local    8        attached
agendo-garmin-claude-watch-face  local    3        attached
agendo-mc-applications           local    13       attached
agendo-pc-to-phone-audio         local    3        attached
agendo-pi-plan-26-03             local    2        attached
vm:7                             vm       1        attached
vm:8                             vm       1
vm:agendo-git                    vm       9        attached
warning: mdos: /bin/bash: line 1: tmux: command not found
```

`vm:agendo-git` is an agendo launcher session with nine windows. Read directly
off the machine, read-only:

```
$ ssh vm "tmux list-windows -a -F '#{session_name}|#{window_name}|#{pane_current_command}'"
agendo-git|launcher|bun
agendo-git|cl-claude-0fe53844cc68|claude
agendo-git|cl-new-eeee7f51a8a3|bash
agendo-git|bash|bash
agendo-git|cl-claude-8e3bec3fd38d|claude
agendo-git|cl-new-f7c286cb78df|claude
agendo-git|cl-claude-3b6a734a0d50|claude
agendo-git|cl-bg-520e1fafd572|claude
agendo-git|cl-claude-cf3aa51db0d1|claude
```

Seven live agent windows, agendo's own naming scheme, agendo's own launcher
window — and `agendo list` on this machine cannot see one of them. That is the
whole feature request, and it is not hypothetical: it is the state of the two
machines right now.

`mdos` matters just as much. It is registered, it is reachable, and it does not
have tmux. A remote that answers but cannot serve is a **steady state**, not a
transient, and it took 0.82 s to say so. Whatever is built has to treat that as
ordinary.

## Summary of the finding

| | |
|---|---|
| **Does tmux cross the boundary?** | Yes, at full fidelity — SGR escapes, cursor, formats. Verified. |
| **Does the pane content already work?** | No, and not for the reason expected — see §1.3 |
| **Does the peer socket cross?** | **Yes.** `ssh -L <sock>:<sock>` forwards it; verified against a live session. The brief's premise here is wrong. |
| **Is routing tmux through ssh the easy half?** | Yes: 14 call sites, and 1,650 lines of detection logic that need no change at all |
| **Is it the useful half?** | **No.** On its own it buys almost nothing — see §3 |
| **What actually unlocks the feature** | agendo running *on the far machine*, its `list --json` merged locally |
| **Cost of a remote tmux call** | 20 ms warm, 0.39–1.13 s cold. Verified. |
| **Addressing** | `remote:session:window` **fights** beam's own parser. The host is a separate axis, not a longer string. |
| **Smallest useful slice** | `agendo list` / `status` reading a merged remote index — read-only, no writes anywhere |
| **What I would not build** | remote `restore`, remote `clone`, transcript streaming, a daemon |

---

## 1. How beam works, mechanically

858 lines of CLI (`src/beam.ts`) over 738 lines of pure logic (`src/lib.ts`).
Read in full. It is smaller than it looks, because almost everything is string
building.

### 1.1 The whole surface

```
remote add|rm|ls|forward     register machines, and their default -L set
ls [machine]                 tmux ls on every machine, in parallel
new <target> [-d] [-L]       tmux new-session, local or remote
attach|a <target> [-L]       attach, with port forwards on the same connection
kill <target>                tmux kill-session
pick                         interactive cross-machine picker
bind [--install]             prefix-S -> `beam pick` in a popup
hosts [--install]            /etc/hosts block: <name>.beam -> 127.44.0.x
```

Targets are `remote:session`; a bare `session` is local. Config is
`~/.config/beam/config.json`, `{ remotes: { <name>: { host, port?, ip, forwards? } } }`.
Nothing else is stored — beam keeps no runtime state at all, deliberately
(`lib.ts`: conflicts are "decided at attach time, by trying to bind it").

### 1.2 The two primitives that matter to agendo

Both are already exported from `src/lib.ts`, and both are exactly the shape
agendo would need:

```ts
// beam/src/lib.ts
export const SSH_BATCH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

/** Full argv for running a tmux command locally or over ssh. */
export function tmuxArgv(remote: string, remoteCfg: RemoteConfig | null, tmuxArgs: string[]): string[] {
  if (remote === LOCAL || remoteCfg === null) return ["tmux", ...tmuxArgs];
  const remoteSh = "tmux " + tmuxArgs.map(shellQuote).join(" ");
  return [...sshCommand(remoteCfg), remoteSh];
}
```

`tmuxArgv(host, cfg, args)` is *precisely* the seam agendo is missing. agendo
spells the same idea as `spawnSync("tmux", args)` fourteen times.

The second primitive is the attach:

```ts
export function remoteAttachArgv(remoteCfg, session, forwards = []): string[] {
  return [...sshCommand(remoteCfg, true, forwards), `tmux new-session -A -s ${shellQuote(session)}`];
}
```

### 1.3 What "a window inside your local tmux" actually means

This is the hinge, and it does not mean what the README's phrasing suggests to
someone hoping `capture-pane` will just work.

From `beam.ts:attach`, inside tmux, remote target:

```ts
const shell = remoteAttachShell(remoteCfg!, session, forwards);
const proc = await run(["tmux", "new-window", "-n", `${remote}/${session}`, shell]);
```

So a beam-attached remote session is **one local window whose single pane runs
`ssh -t <host> "tmux new-session -A -s <session>"`**. There is no local tmux
knowledge of the remote windows. The local server sees one window named
`vm/agendo-git` running `ssh`.

I could not test this against `vm:` without attaching a second client to the
owner's live session, which was out of bounds. So I reproduced the mechanism
exactly, locally, on two throwaway tmux servers on dedicated sockets (`-L bmi`
inner, `-L bmo` outer), the default server never touched:

```
$ tmux -L bmi new-session -d -s inner -x 200 -y 50 'printf "INNER-PANE-CONTENT-MARKER\n"; sleep 300'
$ tmux -L bmo new-session -d -s outer -x 100 -y 30 'tmux -L bmi attach -t inner'

$ tmux -L bmo capture-pane -p -e -t '=outer:'
INNER-PANE-CONTENT-MARKER
                            ← 28 blank rows
 inner  1 sleep                                  fös 21 ágú 10:39     ← the INNER status bar

$ tmux -L bmi list-windows -a -F '#{session_name}|#{pane_width}x#{pane_height}'
inner|100x29        ← was created 200x50; the OUTER client resized it
```

**Verified**, and it splits three ways:

1. **The content does come through.** `capture-pane` on the outer window returns
   the inner pane's text, escapes intact. The optimism in the brief is justified
   *as far as it goes*.
2. **It is contaminated.** The inner tmux's own status line lands in the capture
   as the last row. Every classifier in `tmux.ts` that reasons *positionally
   from the bottom* — `liveStatusLines`, `blockAbove`, `paneUsageLimited`,
   `paneResumeDialogActive`, and `inputEmpty`'s caret check — is now reading one
   row off. `paneCursor` is worse than one row off: the outer server reports the
   *outer* pane's caret, which is wherever the inner client last painted.
3. **It only ever shows one window.** The remote session has nine. A tmux client
   renders the session's *active* window. So the pane-content path, at best,
   reads one ninth of `vm:agendo-git` — whichever one the owner last looked at.

And the killer, which is not a fidelity problem but a topology one: **there is
no such window right now.** `beam ls` says `vm:agendo-git` is attached, but the
local tmux server has no `ssh` pane anywhere in it. The attachment is a bare
`ssh -t` running outside tmux entirely:

```
$ ps -eo pid,args | grep '^ *[0-9]* ssh '
3780065 ssh -t kristjan@10.0.0.229 tmux new-session -A -s agendo-git
```

(`beam attach` outside tmux `exec`s exactly this, by design — "exactly one tmux
in play".) So the beam-window path is available only while a human is
*attached from inside local tmux*, which is not the state the machine is in and
not a state agendo can require.

**Conclusion for the pane path: it is not the thing that already works.** It is
a lossy, partial, human-presence-dependent view. §2.1 has the path that does
work, and it is better in every dimension.

### 1.4 What beam deliberately does not have

No `beam exec`. No `beam tmux <remote> -- <args>`. No capture, no send-keys, no
list-windows. The CLI's verb set is `ls / new / attach / kill / pick`, and
`tmuxArgv` — the general primitive — is a *library* export with no CLI surface
over it.

That is not an oversight to route around; it is the shape of the tool. It also
means **agendo cannot get what it needs from the beam CLI.** It needs either
beam-as-a-library, or its own `ssh` calls, or a new beam verb.

### 1.5 The loopback /24, and whether agendo can use it

`127.44.0.x` per machine, `<name>.beam` in `/etc/hosts`, one address handed out
at `remote add` and freed at `remote rm`. Its purpose is narrow and stated
plainly in the README: it is a **bind address for port forwards**, so `web` and
`gpu` can both hold port 3000 at once, and so the address a service lands on
does not depend on attach order. Forwards live exactly as long as the attach's
ssh connection.

**Can agendo use it? For its stated purpose, no** — agendo forwards no ports and
serves nothing over TCP. But there is one thing worth taking:

> `beam remote ls` is already a **stable, user-blessed registry of machine
> names**, and `<name>.beam` is already a stable identity for each. agendo needs
> exactly one new naming axis (§5) and should borrow this one rather than invent
> a second list of machines for the user to keep in sync.

That is the whole of it. `ip` and `forwards` are beam's business.

One thing the /24 *would* be good for later, noted and not designed: agendo has
no story for reaching a dev server a remote session started. `beam attach vm:x
-L auto` already solves that for a human. If agendo ever wants "open the app
this session is running", it should shell out to beam rather than grow its own
forwarding.

### 1.6 Distribution: which tool is installable where

Measured, and it cuts against the obvious plan:

```
$ npm view beam-mux version
npm error 404 Not Found - GET https://registry.npmjs.org/beam-mux

$ npm view agendo version
0.2.0

$ readlink -f $(which beam)
/home/kristjan/git/beam/src/beam.ts        ← bun link from the checkout

$ ssh vm 'ls ~/.bun/bin'
beam  bun  bunx  claude                     ← no agendo
$ ssh vm 'bash -lc "command -v bun; echo rc=$?"'
rc=1                                        ← ~/.bun/bin is NOT on the non-interactive PATH
```

Three consequences:

* **beam is not a dependency agendo can declare.** It is unpublished and
  `bun link`-ed from a checkout. Importing `beam-mux/lib` from agendo would work
  on this machine and nowhere else. Either beam ships to npm, or agendo copies
  the ~30 lines of `tmuxArgv`/`sshCommand`/`shellQuote` it needs, or agendo
  shells out to `beam` when present and degrades when absent.
* **agendo *is* installable on the far machine.** `bunx agendo` on the vm would
  work today. That is what makes §3's architecture B available at all.
* **`ssh vm agendo …` will fail as written**, because a non-interactive ssh does
  not get `~/.bun/bin`. Any remote invocation must be either `bash -lc` with an
  explicit path, or a configured per-remote command. This is a small thing that
  will cost an afternoon if it is discovered late.

---

## 2. What crosses the boundary, measured

### 2.1 tmux, at full fidelity

The single most important measurement in this document. Read-only, against the
owner's live vm session:

```
$ ssh -o BatchMode=yes -o ConnectTimeout=5 kristjan@10.0.0.229 \
    "tmux capture-pane -p -e -t '=agendo-git:=cl-claude-3b6a734a0d50'"
```

returns, verbatim (elided for width, `cat -v`):

```
^[[38;5;114m●^[[39m Agent "Pull latest beam master" finished^[[38;5;246m · 12s^[[39m

^[[38;5;231m●^[[39m PR #1 is green (CI passing, mergeable) and master is already up to date …
…
^[[38;5;246m✻^[[39m ^[[38;5;246mChurned for 1m 4s^[[39m
^[[38;5;37m────…──── beam-remote-squishy-wave ────
^[[39m❯  ^[[2mcheck on the pr1 session^[[0m
  ^[[34m13:13:18^[[38;5;246m | ^[[33m5%^[[38;5;246m ctx | … | ^[[36mFable 5^[[38;5;246m | …
  ^[[38;5;220m⏵⏵ auto mode on^[[38;5;246m (shift+tab to cycle) · ← for agents^[[39m
```

That is **exactly** what `capturePane` returns locally: SGR escapes intact, the
`●` bullets, the `✻ Churned for` spinner summary, the input box, the status
region below it. `paneReadiness`, `paneBackgroundAgents`, `paneUsageLimited`,
`paneCompactionPercent` would all classify it unchanged. `display-message -p -t
… '#{cursor_x} #{cursor_y}'` answers over the same channel.

And unlike §1.3's nested capture, this reaches **any** window, attached or not,
with no inner status bar in the way and no human presence required.

### 2.2 What it costs

| | measured |
|---|---|
| One remote tmux call, warm multiplexed connection | **0.020 s** |
| One remote tmux call, cold (`ControlPath=none`) | **0.39 – 1.13 s** |
| `mdos` (Teleport, tmux missing) answering with its failure | **0.82 s** |
| Remote metadata scan of 181 transcripts (`find -printf`) | **0.004 s** |
| Local `agendo list --json`, 2,574 transcripts / 929 MB | **4.5 – 5.1 s** |
| vm transcript corpus | 181 files / 92 MB |

The multiplexing is not hypothetical — `~/.ssh/config` already carries it for
`10.0.0.229` (`ControlPersist 12h`) and for the Teleport hosts, with the owner's
own measured note: *"1.9s cold, 0.85s on a reused master"*. beam's README
recommends the same for the same reason.

**20 ms per call is cheap enough that a per-poll pane read over ssh is not the
problem.** The problem is everything in §2.3.

### 2.3 The filesystem, which is where agendo's real signal lives

Thirteen modules read local disk. What each needs, and whether it survives:

| read | anchor | on the vm? |
|---|---|---|
| Claude transcripts | `~/.claude*/projects/**/*.jsonl` | yes — 181 files, 92 MB |
| Claude profiles | `~/.claude*` discovery (`profiles.ts`) | yes |
| Copilot | `~/.copilot/session-state` | yes — present |
| Codex | `$CODEX_HOME` or `~/.codex` | **no** — `~/.codex` does not exist there |
| agendo state | `~/.agendo/{state,config,restore}.json`, `restore/` | yes — `~/.agendo/restore/` exists |
| worktrees, git refs | per-repo `.git/`, `.claude/worktrees/` | yes — `/home/kristjan/git/*` |
| peer registry | `~/.claude/sessions/<pid>.json` | yes — live |
| peer socket | `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock` | yes — live, 5 sockets |

None of this is reachable by a local process. All of it is reachable by a
process *on that machine*, which is the entire argument of §3.

The 92 MB is the number that decides it. Shipping transcripts across is
absurd; running the parse on the far side and shipping the ~1 KB of JSON per
session is not.

### 2.4 The peer socket does cross the boundary

The brief states it "does not cross a machine boundary at all". That is not
correct, and the correction is load-bearing enough to show the run.

First, the registry entry, read off the vm (`~/.claude/sessions/2493305.json`,
verbatim):

```json
{"pid":2493305,"sessionId":"520e1faf-d572-4784-991a-54f68da1ec22",
 "cwd":"/home/kristjan/git/beam/.claude/worktrees/pr1-kirby-review",
 "startedAt":1786713191382,"procStart":"243213271","version":"2.1.232",
 "peerProtocol":1,"kind":"interactive","entrypoint":"cli",
 "tmux":"agendo-git:@40.%41",
 "messagingSocketPath":"/run/user/1001/cc-socks/2493305.sock",
 "name":"pr1-kirby-review-7d","nameSource":"derived",
 "status":"idle","updatedAt":1787308461728,"statusUpdatedAt":1787308461728}
```

That single file is a plain `cat` away and carries `sessionId`, `cwd`, the tmux
target, **and a self-reported `status`** — which is most of what a pane read is
for.

Then the socket itself. OpenSSH forwards unix domain sockets:

```
$ ssh -f -N -o ExitOnForwardFailure=yes \
      -L /tmp/bm.sock:/run/user/1001/cc-socks/2493305.sock kristjan@10.0.0.229
$ ls -la /tmp/bm.sock
srw------- 1 kristjan kristjan 0 ágú 21 10:37 /tmp/bm.sock
$ python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bm.sock'); print('connected'); s.close()"
connected
```

**Verified: the connection reached the remote session's messaging socket.**
Zero bytes were written; the forward and the socket file were torn down
immediately after.

Two footnotes, one of them a real constraint:

* `sun_path` is 108 bytes. The first attempt failed with
  `Bad local forwarding specification` purely because the path was ~130
  characters. Any implementation must put forwarded sockets somewhere short.
* This does **not** make socket forwarding the right design. `ssh vm agendo send
  <id> "..."` runs the whole `send` decision — peer lookup, `pidAlive`,
  readiness gate, dialog handling, tmux fallback — on the machine that owns all
  the inputs, in one round trip. Forwarding the socket moves one hop of a
  five-hop decision. The finding matters because it removes "impossible" from
  the discussion, not because it is what to build.

### 2.5 What genuinely does not cross

* **`/proc`.** `peer.ts:pidAlive` reads `/proc/<pid>/stat` field 22 to pin a pid
  to its start time, so a recycled pid cannot misdeliver a prompt. That check is
  meaningless against a remote pid, and it is a *safety* check. Any design that
  forwards a socket and skips this has quietly removed a guard.
* **The user's terminal.** `resume`, `open` (browser), `enterLauncherSession`,
  the whole TUI. These are local by definition.
* **Wall-clock agreement.** `idleSeconds`, `stalled` and `limitResetAt` are all
  derived from timestamps, so a merged view silently lies if the clocks drift.
  Right now they do not — `date -u +%s` returned `1787309302` on both machines,
  run back to back — but that is a property of two NTP-synced boxes on one LAN,
  not a guarantee. The assumption should be *stated in the output*, not
  assumed.

---

## 3. Two architectures, and why the answer is both

### 3.1 Architecture A — route tmux through ssh

Give every tmux call a host. This is the change the brief predicted, and it is
as easy as predicted:

* **14 `spawnSync` sites** in `src/tmux.ts` (lines 39, 153, 179, 1827, 1958,
  1964, 1971, 2091, 2173, 2195, 2241, 2247, 2286, 2300).
* **Lines 179 → 1827 contain no `spawnSync` at all.** That is ~1,650 lines —
  `paneReadiness`, the whole resume-dialog stack, `paneUsageLimited`,
  `paneCompactionPercent`, `paneBackgroundAgents`, `paneShells`,
  `sessionFinished`, `resumeKeystrokes` — every one of them a **pure function of
  a captured string**. They do not care which machine produced it and need no
  change whatsoever.

That is the good news, and it is genuinely good: agendo's detection layer was
built to be pure for testability, and machine-independence falls out for free.

The bad news is what A buys. With A alone, agendo can capture a remote pane —
of a session it does not know exists, cannot name, cannot resolve a short id
for, has no transcript for, no title for, no branch, no idle age, no PR link.
`refreshLiveTmux` would report a live window named `cl-bg-520e1fafd572` that
matches no session in the index, and `reconcileLive` would drop it on the floor.

**A on its own produces a live-window list and nothing else.** It is necessary
and it is not sufficient.

### 3.2 Architecture B — agendo on the far machine

`agendo list --json` already emits a complete, self-describing wire format. Real
output, one element:

```json
{
  "id": "2bcca559-d319-411d-b708-345454a4058e",
  "shortId": "2bcca559d319",
  "source": "claude",
  "running": true,
  "readiness": "busy",
  "resumeDialog": false,
  "limitResetAt": null,
  "compactionPercent": null,
  "shells": 0,
  "kind": "background",
  "branch": "worktree-beam-support-research",
  "cwd": "/home/kristjan/git/agendo/.claude/worktrees/beam-support-research",
  "dir": "beam-support-research",
  "title": "Beam support gap analysis",
  "lastUsed": "2026-08-21T10:41:17.506Z",
  "idleSeconds": 5,
  "stalled": false,
  "stalledAfterSeconds": 14400,
  "git": { "branch": "…", "upstream": "origin/master", "upstreamConfigured": true,
           "hasRemoteRef": true, "unpushed": false },
  "pr": null, "workItem": null, "prUrl": null, "workItemUrl": null, "workflows": []
}
```

Every field in there is derived from something that only exists on the machine
the session runs on. There is no version of this that a local process can
compute for a remote session. **The aggregation format already exists, and it is
this.**

So B is: run `agendo list --json` over ssh, tag each row with its host, merge.
Cost is one ssh (20 ms warm) plus a remote index build. The vm's corpus is 1/14
of this machine's, and this machine's build measures 4.5–5.1 s — so **inferred**
sub-second on the vm, unmeasured because measuring it would have installed
agendo on the vm and the brief said read-only. That number should be the first
thing checked before committing to a poll interval.

### 3.3 The split, and one place where A wins outright

| need | architecture | why |
|---|---|---|
| the session list, titles, branches, PRs, idle age | **B** | none of it is computable locally |
| a one-shot action (`send`, `close`, `unblock`) | **B** | the whole guard runs where its inputs are |
| `wait` | **B, but not by polling** | one blocking `ssh vm agendo wait <id>` — the ssh *exit* is the wake-up, which is what `wait` was designed for |
| a tight readiness poll (the TUI's 2 s refresh) | **A** | B costs a full index build per tick; A costs one 20 ms `capture-pane` |
| `open` (browser) | **split** | `ssh vm agendo open <id> --print` gives the URL; the local machine launches the browser. `--print` already exists "for a headless host with no browser to launch" — it was written for exactly this and did not know it |
| attach / resume | **beam** | `beam attach vm:agendo-git` already does this. agendo should shell out, not reimplement |

The TUI row is the one that matters. `wait.ts`'s header is explicit that its
per-tick cost is "one `refreshLiveTmux` plus one pane capture per live target,
no transcript read". That budget survives A intact and does **not** survive B.
A hybrid is therefore not an optimisation; it is the design.

---

## 4. Per-feature gap table

Every row is against a session on `vm:` with today's code. "Breaks" means the
feature produces a wrong or empty answer, not that it throws.

| feature | today | with A only | with B | notes |
|---|---|---|---|---|
| `list` / `ls` | **breaks** — remote session absent from the index | breaks | **works** | needs a host column and a merge; short ids can collide across machines (§5) |
| `status <id>` | **breaks** — id resolves to nothing | breaks | **works** | `--urls` does a backend round trip; do it locally on the merged row, not per-host |
| `wait` | **breaks** | degrades — pane only, no `stalled`/idle | **works** | one blocking ssh per host; ssh drop must be distinguishable from "woke". See open question 4 |
| `send <id>` | **breaks** | degrades — pane paste only, no peer socket, no `pidAlive` guard | **works** | B keeps the peer-socket path and the recycled-pid guard intact |
| `unblock <id>` | **breaks** | **works** | works | pure keystrokes at a resolved target; A is genuinely enough here |
| `close` / `kill` | **breaks** | **dangerous** — see note | **works** | the close guard is `readiness` + `paneBackgroundAgents` off one capture, plus `windowLocations` ambiguity refusal. Under A those reads are fine, but `forgetRestoreTab` writes the **local** `~/.agendo/restore.json` for a **remote** window. Do not ship remote close under A |
| `resume <id>` | **breaks** | breaks | partial | opening a session needs a terminal. Correct answer is `beam attach vm:<session>` then select the window |
| `launch` | **breaks** | breaks | **works** | this is the point of the feature — fan worktrees out across machines. Needs the repo to exist there; `--repo`/`--path` scoping must be evaluated remotely |
| `open <id>` | **breaks** | breaks | **works, split** | remote `--print`, local browser |
| `restore` | n/a | n/a | **leave alone** | per-machine by construction: `~/.agendo/restore.json` + placeholder windows in that machine's canonical session. A local launcher must never try to restore a remote tab. See §7 |
| TUI list / rows | **breaks** | breaks | **works** | needs a machine column and `sessionId` to become `host:source:id` |
| TUI expand (activity, tasks) | **breaks** | breaks | **works** | `activity.ts` parses the whole transcript on demand — that parse must happen remotely (`status --full`), not by shipping the file |
| TUI clone flow | n/a | n/a | **leave alone** | clones into a local path. Cross-machine clone is a different feature |
| orchestrator mode | **breaks** for remote children | breaks | **works** | the injected prompt names `list`/`status`/`send`; it must be taught the host qualifier or it will address the wrong machine |
| readiness detection (`paneReadiness` et al.) | — | **works unchanged** | works | pure functions; §3.1 |
| usage-limit auto-resume | **breaks** | **works** | works | `paneResetAt` + `resumeKeystrokes` are pane-only. Clock skew is the one hazard (§2.5) |
| error-retry (docs/error-retry.md) | **breaks** | breaks | **works** | transcript-tail detection; the tail read must run remotely |
| `gitrefs` / unpushed | **breaks** | breaks | **works** | reads `.git` ref files; already in `list --json` |
| peer socket `send` | **breaks** | breaks | **works** | and §2.4 shows a forwarded-socket fallback exists if ever wanted |

Two rows deserve emphasis because they are the ones that will bite:

* **`close` under A is not merely degraded, it is wrong.** Its guard reads fine
  remotely, but its bookkeeping (`forgetRestoreTab`) writes the local machine's
  restore snapshot. A remote close would corrupt local restore state while
  leaving the remote's untouched.
* **`unblock` under A actually works**, and it is the only one that does. It
  resolves a target and sends keystrokes; there is no index, no transcript, no
  state file. That makes it a useful canary but a misleading precedent.

---

## 5. Addressing and identity

### 5.1 The collision is live, right now

```
$ comm -12 <(tmux list-windows -a -F '#{window_name}' | sort -u) \
           <(ssh vm "tmux list-windows -a -F '#{window_name}'" | sort -u)
launcher
```

Six windows named `launcher` — five local, one on the vm — and
`liveWindows(): Map<string, string>` is keyed on the bare window name. Merging
two machines' listings into that map today collapses them. `launcher` is not a
managed name so nothing dereferences it, but the demonstration is the point:
**the key space is already not unique across machines, using only names agendo
itself creates.**

`cl-*` names have not collided yet because they embed a 12-hex-character session
id. That is 48 bits and it is fine. Session *short ids* used at the CLI are also
12 hex; also fine. Session names (`agendo-git` on the vm, `agendo-<basename>`
locally) are derived from a repo basename and **will** collide the first time
the same repo is checked out on both machines — which is the likely steady
state, since the whole point is running the same work on two boxes.

### 5.2 `remote:session:window` does not compose — it fights

beam's parser, verbatim:

```ts
// beam/src/lib.ts
export function parseTarget(spec: string): [string, string] {
  const i = spec.indexOf(":");
  if (i !== -1) return [spec.slice(0, i) || LOCAL, spec.slice(i + 1)];
  return [LOCAL, spec];
}
```

**First** colon. So `vm:agendo-git:cl-bg-520e1fafd572` parses as
remote `vm`, session `agendo-git:cl-bg-520e1fafd572` — a session name containing
a colon, which beam then hands to tmux as `-t '=agendo-git:cl-bg-…'`, where the
colon means something else entirely. It does not error; it resolves to the wrong
thing or to nothing.

Meanwhile #47's `windowTarget` produces `=session:=window`, which already
contains a colon and already pins both halves for good reason (host names are
prefixes of each other, so are managed window names).

So the two schemes both claim `:` and they claim it for different axes. Layering
one string on the other is a parser fight, and the loser is silent.

### 5.3 The proposal: a host axis, not a longer string

Do not extend the target string. Extend the *type* — which is what #47 already
started doing when it split `name` from `target` in `LiveTarget`:

```ts
// ILLUSTRATIVE — not implemented.
export interface LiveTarget {
  /** Machine name from `beam remote ls`, or null for this machine. */
  host: string | null;
  /** Attribution + display key, unchanged. */
  name: string;
  /** The only form handed to tmux as `-t` — unchanged, still `=session:=window`. */
  target: string;
}
```

`windowTarget()` does not change at all. It is the *within-machine* half and it
is correct. The host rides alongside, exactly as beam keeps it alongside in
`tmuxArgv(remote, cfg, args)`, and it is consumed at exactly one place: the
argv builder that today is `spawnSync("tmux", args)`.

This composes with both. It also makes the fourteen call sites a mechanical
change rather than a semantic one.

For the user-facing form, `vm:2bcca559d319` (host + short id) reads naturally
and matches beam's own `remote:` prefix. Note the mild trap: in beam the
right-hand side is a *session*, in agendo it would be a *session id*. Same
shape, different vocabulary. Worth deciding deliberately (open question 2).

### 5.4 Adjacent finding: `exactTarget` is already wrong for pane targets

Not a beam problem. Found while probing target syntax, verified read-only on
this machine's live server and reproduced on a throwaway one. tmux 3.4:

| command | `-t '=<session>'` | `-t '=<session>:'` |
|---|---|---|
| `has-session` | ok | ok |
| `list-windows -t` | ok | ok |
| `capture-pane -p` | **`can't find pane: =<name>`** | ok |
| `send-keys` / `paste-buffer` | **`can't find pane: =<name>`** | ok |
| `display-message -p -t … '#{session_name}'` | **exit 0, empty output** | ok |
| `show-options -t … -v @x` | **`no such session: =<name>`** | ok |
| `set-option -t … @x v` | **exit 1, `no such session`** | ok |

Live, read-only:

```
$ tmux capture-pane -p -t '=agendo-agendo'
can't find pane: =agendo-agendo
$ tmux capture-pane -p -t '=agendo-agendo:' | head -1
(content)
```

Two consequences in today's code:

1. **`sessionRoot` / `setSessionRoot` never work.** Both build
   `exactTarget(session)` and pass it to `show-options` / `set-option`, which
   reject the `=name` form outright. So `@cl_root` is never written and never
   read, and the basename-collision guard at `src/index.tsx:564` — "refuse to
   attach a differently-rooted launcher to an existing host session" — is
   silently inert. Verified: `set-option -t '=outer' @probe A` → exit 1
   `no such session: =outer`; `-t '=outer:'` → sets, reads back.
2. **Any pane read of a managed session that is a tmux *session* rather than a
   window returns empty.** `liveTargets()` maps session names through
   `exactTarget`, and `newDetached` creates `cl-*` **sessions** when agendo runs
   outside tmux. `capturePane` on such a target returns `""` and `readPaneState`
   returns `null` — which `close` correctly treats as "cannot read", but `list`
   reports as `unknown`.

This belongs in its own issue, not in this feature. It is here because it is the
same question — *what is a target?* — and because a beam design that adds a host
axis on top of a broken within-machine axis will get blamed for it.

---

## 6. Degrading rather than failing: `mdos`

The registered-but-unusable remote is the design's forcing function, and it is
cheap to honour because beam already models it. `listSessionsOn` returns
`{ remote, sessions: [], error }` and `cmdLs` prints rows first, then
`warning: <remote>: <err>` on stderr. The listing succeeds.

agendo should copy that contract exactly:

* A host that cannot be reached, or that answers without tmux/agendo, contributes
  **zero rows and one warning**. It never fails the command.
* The warning goes through the existing `cli/warnings.ts` flush, which the TUI
  already surfaces.
* `--json` gets a sibling key rather than a poisoned array — `{ sessions: [...],
  hosts: [{name, ok, error}] }` — so an orchestrator can tell "no sessions on
  vm" from "could not ask vm". Getting this wrong is how an orchestrator decides
  a machine's work is finished.
* **0.82 s** is the measured cost of `mdos` saying no. With three or four
  registered machines that is the floor on every aggregate command unless hosts
  are queried in parallel (beam does: `Promise.all` in `gatherSessions`) and a
  failing host is remembered for a short window. Recommend copying the parallel
  fan-out and adding a negative cache; do not add a health-check subcommand.

There is a second failure mode beam does not model and agendo must: a host that
is reachable, has tmux, and does **not** have agendo. That is the vm today. It
should read as a *distinct* warning ("vm: agendo not installed"), because the
fix is different and obvious.

---

## 7. What I would not build

Stated as findings, since the brief asked for them.

**Remote `restore`.** `~/.agendo/restore.json` records which tabs are open in
*that machine's* canonical session, and restore recreates them as placeholder
windows there. It is per-machine by construction and there is no coherent
cross-machine version: restoring a remote tab would mean spawning an agent on
another box because you started your local launcher. The local launcher must
scope restore to local windows, and that is not a limitation — it is correct.

**Remote `clone`.** `clone.ts` resolves a URL and clones into a local path.
"Clone this repo onto the vm" is a real thing a person might want and it is a
different feature with different UI. Do not smuggle it in.

**Streaming or syncing transcripts.** 92 MB on the vm, 929 MB here, and the
parse is the expensive part. `activity.ts` and the error-retry tail read both
want *derived* output, not bytes. Anything that copies a transcript across is a
design that has lost the thread.

**A daemon on the remote.** Tempting, since it would amortise the index build.
It is a second lifecycle to manage, a second thing to upgrade, a second thing to
leave running, and a security surface. `bunx agendo list --json` over a
multiplexed ssh is a 20 ms connection plus a sub-second parse. Revisit only if
the vm's measured index build turns out to be seconds, not sub-second.

**Reimplementing attach.** beam already does this well, including the port
forwards, including the outside-tmux case, including the picker. agendo should
call it or print the command.

**Making `beam` a hard dependency.** It is unpublished (§1.6). Depending on it
would make agendo uninstallable for everyone else and unbuildable in CI. Read
`~/.config/beam/config.json` if it is there; fall back to agendo's own host list
if it is not; require neither.

---

## 8. Staged plan

`src/tmux.ts` is being split by another session and GitHub Projects work is in
flight. **As of writing, the split PR is not yet open** (the only open PR is #45,
docs). So this is written against the seams rather than the file, and the seams
are unusually clear: 14 I/O call sites at lines 39 / 153 / 179 / 1827–1971 /
2091–2300, and ~1,650 lines of pure classification between 179 and 1827 that no
stage below touches. Every stage here changes the *I/O band only*. Whatever the
split does to the pure band is orthogonal, and if the split extracts the I/O
band into its own module, stage 1 gets easier, not harder.

### Stage 0 — measure the one number that is missing

Install agendo on the vm and time `agendo list --json`. Everything downstream
assumes it is sub-second. It was not measured here because measuring it would
have written to the machine. **If it is not sub-second, stage 3 changes shape.**

Also settle the PATH question (§1.6) — `bash -lc` vs an explicit remote command
per host — because it will otherwise be discovered by a confusing failure.

### Stage 1 — the smallest independently useful slice

> **`agendo list` and `agendo status` show sessions from every registered
> machine, read-only, with per-host warnings.**

That is the slice. It is worth naming precisely what it is not: no `send`, no
`close`, no `launch`, no TUI change, no writes anywhere, and nothing that
touches a remote session's state. Its entire blast radius is that two read-only
commands print more rows.

It is independently useful on its own terms — "what is running on the vm, and is
it stuck?" is the question the owner actually has, and today the answer requires
ssh-ing in and looking. It is also the slice that proves or kills everything
after it: if the merge, the host tagging, the id collisions and the degradation
story do not work here, they will not work anywhere.

Concretely:

* `src/hosts.ts` (new): read `~/.config/beam/config.json` if present, else
  agendo's own config. Pure parsing plus one `existsSync`. No beam import.
* `remoteSessions(host): Promise<AgentSession[]>` — one ssh, `agendo list --json`,
  tag every row with `host`, return `[]` + a warning on any failure.
* Fan out with `Promise.all`, exactly as beam's `gatherSessions` does.
* `--json` grows the `hosts[]` sibling key (§6).
* `list` grows a machine column; `status <id>` accepts `vm:<id>` and resolves a
  bare id against all hosts, refusing rather than guessing on ambiguity — the
  precedent is `windowLocations`/`close`, which enumerates and refuses.

**Tests.** `e2e/fakebin/` already fakes `tmux`, `git`, `gh`, `az`, `claude` as
state-file-backed stubs. A `fakebin/ssh` in the same shape — answers
`agendo list --json` from a fixture, can be made to fail, can be made slow — is
the natural home for every case in §6. No real network, no real remote.

### Stage 2 — the host axis in `LiveTarget`

`{ host, name, target }` per §5.3, threaded through `liveTargets` /
`liveManagedPaths` / `reconcileLive` / `refreshLiveTmux`. `windowTarget`
unchanged. Still no remote writes: this stage makes remote targets
*addressable*, and stage 3 is the first one that addresses them.

Land after the tmux.ts split, or rebase onto it. This is the only stage that
genuinely conflicts.

### Stage 3 — one-shot remote actions

`send`, `unblock`, `close`, `open --print`: each is `ssh <host> agendo <verb>` with
argv forwarded and exit status preserved. The guards stay where their inputs
are. `close` must not be shipped until `forgetRestoreTab`'s locality is settled
(§4).

### Stage 4 — `wait`

One blocking ssh per watched host; the exit is the wake-up, which is `wait`'s
own design intent. The work here is not the mechanism, it is distinguishing
"the session changed state" from "the ssh died" — see open question 4.

### Stage 5 — the TUI

Machine column, `sessionId` becomes `host:source:id`, remote rows poll their
readiness through the stage-2 axis (A) rather than re-running stage 1 (B).

### Stage 6 — remote `launch`

The actual prize, and correctly last. `agendo launch --host vm …` creates a
worktree and a `cl-bg-…` window on the vm. Orchestrator instructions must be
taught the host qualifier in the same PR, or an orchestrator will address the
wrong machine.

---

## 9. Open questions for the owner

1. **Whose host list?** beam's `~/.config/beam/config.json` is already there and
   already curated, and reading it costs nothing. But it makes agendo's
   behaviour depend on another tool's config file, and beam is not installable
   from npm (§1.6). Read beam's and fall back to agendo's own? Only agendo's,
   with a `agendo host add` that duplicates `beam remote add`? Or read beam's
   and refuse to have an opinion of its own?

2. **`vm:<short-id>` or `--host vm`?** The prefix form matches beam and reads
   well in an orchestrator's prompt. The flag form cannot be confused with
   beam's `remote:session` and cannot be ambiguous with a session id that
   happens to contain a colon. I lean prefix, with `--host` accepted as a
   synonym, but this is a vocabulary decision and it is yours.

3. **Bare short id across machines: refuse, or prefer local?** Twelve hex
   characters will not collide by accident, but a *resumed* session that exists
   on both machines (same repo, same transcript copied) would. `close`'s
   precedent is to enumerate and refuse. `status`'s precedent (scope flags) is to
   narrow first. Refusing is safer and more annoying.

4. **What does a dropped ssh mean to `wait`?** Stage 4 turns a network blip into
   a wake-up. Options: retry the ssh silently (risks waiting forever on a dead
   host), exit non-zero with a distinct `woke: "unreachable"` (honest, but every
   orchestrator loop must learn a new case), or fall back to polling. `wait`
   already distinguishes `woke: "blocked"`, so a fourth value is cheap — but it
   is a contract change for existing callers.

5. **Is remote `launch` (stage 6) the actual goal, or is remote `list` enough?**
   Stage 1 answers "what is running on the vm". Stage 6 answers "run this on the
   vm". They are very different amounts of work and stage 1 may simply be the
   feature. Worth saying which one you are actually reaching for before stage 2
   starts, because stages 2–5 exist only to serve 6.

6. **Should the `exactTarget` pane-target bug (§5.4) be fixed first?** It is
   independent, small, and it makes the basename-collision guard work again. It
   also touches `tmux.ts` while the split is in flight. File it, or fix it
   inside the split?

7. **Clock skew.** Do you want `idleSeconds` / `stalled` on a remote row to be
   computed remotely (correct if the remote clock is right, and the remote is
   the only thing that knows when its transcript was last written) or locally
   from a returned timestamp (consistent across the merged view, wrong if the
   clocks disagree)? Remote is my recommendation, with the assumption stated in
   the output rather than hidden.

---

## Appendix: verified vs inferred

**Verified — I ran this and got that.** All read-only. No remote session was
attached to, sent to, or killed; no bytes were written to any peer socket; no
beam config was changed; `tmux kill-server` was never run.

* beam's full source and README, read completely.
* `beam ls` / `beam remote ls` output, quoted verbatim.
* `vm:agendo-git` holds nine windows with agendo's naming scheme, and
  `agendo-git` has two attached clients (`pts/0` 133x57, `pts/13` 383x97).
* `ssh vm "tmux capture-pane -p -e -t '=session:=window'"` returns full-fidelity
  pane content, SGR escapes intact — §2.1.
* `ssh vm "tmux display-message -p -t … '#{pane_width}x#{pane_height} #{cursor_x},#{cursor_y}'"`
  answers.
* Latency: 0.020 s warm, 0.39–1.13 s cold, 0.82 s for `mdos`'s failure. The vm
  has `ControlMaster auto` / `ControlPersist 12h` in `~/.ssh/config`.
* Nested-tmux capture (throwaway `-L bmi` / `-L bmo` servers): the outer capture
  contains the inner pane's content **plus the inner status bar**, and the inner
  pane resized 200x50 → 100x29 to match the outer client. §1.3.
* No local tmux window is running `ssh` to the vm; the live attachment is a bare
  `ssh -t … tmux new-session -A -s agendo-git` outside tmux. §1.3.
* `window-size latest` on both machines, so a new client resizes the panes an
  existing agendo is reading. §2.5 hazard.
* `ssh -L <local.sock>:<remote.sock>` forwards a unix socket and a local connect
  reaches the remote session's messaging socket. Zero bytes written, forward torn
  down. §2.4.
* The vm's peer registry entry, quoted verbatim, carries `status`, `tmux`,
  `sessionId` and `cwd`.
* `beam-mux` is not on npm (404); `agendo` is, at 0.2.0. `~/.bun/bin` on the vm
  holds `beam bun bunx claude` and no `agendo`, and is not on the
  non-interactive ssh PATH.
* vm corpus: 181 transcripts / 92 MB; local: 2,574 / 929 MB. Local
  `agendo list --json`: 4.5–5.1 s.
* `agendo list --json`'s field set, quoted verbatim from a live run.
* `launcher` is the one window name live on both machines (5 local, 1 remote).
* `tmux.ts` has 14 `spawnSync` sites and none between lines 179 and 1827.
* The `=<session>` pane-target failures in §5.4 — each row of that table run
  individually, on the live server and on a throwaway one, tmux 3.4.
* beam's `parseTarget` splits on the **first** colon (source read).
* `reconcileLive` drops a managed window whose name resolves to no indexed
  session (`resolveWindowSession(...) → null` → `continue`).
* `~/.codex` does not exist on the vm; there are no Codex sessions to aggregate
  there today.
* The two machines' clocks agree exactly — `date -u +%s` returned `1787309302`
  on both, run back to back. §2.5's hazard is real but not currently live.
* As of writing, the only open PR on the repo is #45 (docs). The `tmux.ts` split
  PR has not appeared.

**Inferred — this should follow, and has not been checked.**

* `agendo list --json` on the vm is sub-second. Reasoned from a 14× smaller
  corpus against a measured 4.5–5.1 s here. **Stage 0 exists to check this.**
* The beam-attached-window path (§1.3) behaves against `vm:` as it did in the
  local nested reproduction. The mechanism is identical — `ssh -t` running a
  tmux client in a pane — but it was not run against the vm, because doing so
  would have attached a second client to a live session.
* A `fakebin/ssh` stub in the existing harness shape is sufficient to test all
  of stage 1. Reasoned from `fakebin/tmux`, which does exactly this for tmux.
* tmux 3.6 on the vm behaves as 3.4 does for the §5.4 target forms. The table
  was produced on 3.4; only the remote `capture-pane` calls in §2.1 exercised
  3.6, and they used the `=session:=window` form, which is correct on both.

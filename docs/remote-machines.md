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
| **Is it the useful half?** | **Yes** — once beam is tmux-shaped. See §3, and §3.0 for what this document got wrong. |
| **How much identity does tmux carry?** | Far more than assumed: full session UUID, provider, profile, resume argv, title, idle age. §2.6. Verified. |
| **Cost of a remote tmux call** | 20 ms warm, 0.39–1.13 s cold. Verified. |
| **Addressing** | The host is a separate axis (`-H`), never folded into the tmux target. It does **not** fight beam's parser — §5.2. |
| **Smallest useful slice** | `agendo remote <machine>` — a read-only cross-machine listing. **Built; see §10.** |
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
  `bun link`-ed from a checkout. Importing `beam-mux/lib` would work on this
  machine and nowhere else. So agendo shells out to a `beam` **executable**,
  resolved from `PATH` and overridable by `AGENDO_BEAM` — which is also what lets
  a development build be pointed at without disturbing the linked one. If beam
  ever ships to npm this can become a real dependency; nothing here assumes it.
* **The far machine needs nothing but tmux and sshd.** No agendo, no bun. That is
  the design's best property and it came free with the tmux-shaped transport: the
  remote holds no agendo state and cannot drift from this one.
* **A non-interactive ssh does not get `~/.bun/bin`** (`command -v bun` fails
  there). Irrelevant to stage 1, which runs nothing but tmux on the far side —
  but it is exactly the trap any future "run something over there" design walks
  into, so it is recorded here rather than rediscovered.

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
process *on that machine* — which is why the first draft concluded agendo had to
run there. **§2.6 is why that conclusion does not hold**: the parts of this a
session listing actually needs turn out to live in the tmux server too.

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

### 2.6 How much identity tmux carries — the finding that moved the boundary

§2.3 said a session's title, branch and idle age "come from the transcript on the
machine the session runs on". Half of that is wrong, and it is the half that
decides the design. Read off a live remote, read-only, with `list-panes -F`:

```
=== cl-claude-0fe53844cc68
  start:  env CLAUDE_CONFIG_DIR=/home/kristjan/.claude claude --resume
          0fe53844-cc68-4f89-aac2-3ff54a04d1a4 --append-system-prompt "You are running inside agendo…"
  title:  ✳ Use Fable and Opus sub agents for code review
  path:   /home/kristjan/git/gyroflow-cloud-agendo-fable/.claude/worktrees/review-fable

=== cl-new-f7c286cb78df
  start:  claude --session-id f7c286cb-78df-4bf3-91ee-a47f8209b9d3 --append-system-prompt "…"
  title:  ✳ Check status of all open PRs
  path:   /home/kristjan/git/agendo
```

`#{pane_start_command}` is the pane's whole launch argv. From it, without reading
a byte of any transcript:

* the **full session UUID** — `--resume <uuid>` for a resumed session,
  `--session-id <uuid>` for a fresh one (agendo mints the id up front so it can
  name the window before the agent has written anything);
* the **provider**, from the binary;
* the **config profile** (`CLAUDE_CONFIG_DIR`), which `sessions.ts` needs on
  resume and which was assumed to require profile discovery on the far machine;
* the **exact resume command**, verbatim — enough to relaunch the session.

`#{pane_title}` is the session title the agent itself set. `#{window_activity}`
is a last-painted timestamp that stands in for idle age.

Three caveats, stated rather than discovered later:

1. **Not every pane has a start command.** tmux reports it empty for a pane it
   did not start with one — a plain shell, or one whose original process was
   replaced. Verified: `bash` and one `cl-new-…` window on the remote both come
   back empty. Those rows are honestly unidentified, never guessed at.
2. **`window_activity` is not transcript mtime.** It is "when this pane last
   painted". For a settled session it freezes (verified: unchanged across an
   8-second sample for every idle window), and for a working one it moves. It is
   a good proxy and it is not the same number `agendo list` prints locally.
3. **It differences a remote clock against a local one.** The two agree here
   (checked twice, `date -u +%s` identical, skew 0 s), which is a property of two
   NTP-synced boxes on one LAN and not a guarantee.

A field whose value can contain the separator has to come **last** in the format
and take the whole remainder of the line, since both a title and a launch argv
can contain a tab. That is a parsing rule, not a tmux limit — tmux will
interpolate as many fields as you ask for; only the last one comes back
unambiguously — and it is the rule beam already applies to its own
`TMUX_LS_FORMAT`. So each *arbitrary-valued* field costs a read and every
bounded one rides along free: `#{window_activity}` is a bare epoch second and
travels with the title, leaving two reads rather than three.

---

## 3. The design: beam becomes tmux-shaped

### 3.0 What this document originally got wrong

The first draft framed the question as "here is beam's API — what can agendo do
with it", and concluded that routing tmux over ssh "buys almost nothing on its
own". That conclusion was about **today's beam**, presented as a conclusion about
the **approach**. The owner corrected it:

> "I don't want agendo to run `ssh <host> agendo send ...`. I want agendo,
> running locally, to do the sending via beam, so agendo should rather do
> `beam send-keys <host> ...`. What's missing is to make `beam` almost a drop in
> replacement for tmux. […] Essentially, beam should be tmux compatible, with
> the extra parameter of a host."

That is a better seam than anything proposed here, and the rest of this section
is written to it. Two specific claims from the first draft are withdrawn:

* that `remote:session:window` fights beam's parser (§5.2 — it does not, once
  the host rides on its own flag);
* that a remote session's identity is only in its transcript (§2.6 — it is not).

### 3.1 The shape

```
beam [-H <host>] <tmux-command> [args...]
```

The host is consumed by beam; every other argument is forwarded to tmux
verbatim. agendo keeps saying `capture-pane -p -e -t '=session:=window'` and
gains one parameter saying where.

agendo's side is one function:

```ts
export function tmuxArgv(host: Host, args: string[]): string[] {
  if (host === null) return ["tmux", ...args];
  return [...beamCommand(), "-H", host, ...args];
}
```

**A null host is a direct `tmux` spawn, not `beam -H local`.** Measured against
real beam: a beam call costs **45 ms**, a bare tmux spawn **4 ms**, and a
readiness poll over N windows is ~2N+3 calls. Uniformity there would cost ~1.1 s
per poll of a 12-window session to buy something nobody can see. The local path
stays byte for byte what it was. §11.2 has the full cost table and what the
number implies for batching.

### 3.2 Why this is now the useful half, not just the easy one

Three properties, all measured, make the tmux channel sufficient rather than
merely available:

1. **Pane content arrives byte-exact.** Captured through the transport and
   directly over ssh: identical sha256, 7534 bytes, 37 lines carrying SGR
   escapes. §2.1.
2. **agendo's detection layer is already machine-independent.** Lines 179–1827
   of `tmux.ts` contain no I/O at all — `paneReadiness`, the resume-dialog stack,
   `paneUsageLimited`, `paneCompactionPercent`, `paneBackgroundAgents` are pure
   functions of a captured string. They classify a remote pane with **no change
   whatsoever**, which is not a hope: §10 shows them doing it.
3. **tmux carries the session's identity.** §2.6. This is what removes the need
   to run agendo on the far machine for the listing case.

### 3.3 What the transport still cannot reach

Three things, and they are files on the far machine rather than tmux state:

| still missing | lives in | honest options |
|---|---|---|
| git branch, unpushed commits | `.git` ref files | a non-tmux beam verb, or agendo's own ssh, or do without |
| task checklist, recent activity, final response | the session transcript | one derived read on the far side, or do without |
| linked PR / work item | derived from the branch | follows the branch; the backend call itself is local |

None is required for "what is running over there, and is any of it stuck",
which is the question that motivated this. All three are required for the remote
row to be indistinguishable from a local one. **That is the honest boundary**,
and §9 asks which side of it the feature needs to land on.

## 4. Per-feature gap table

Against a session on `vm:`. "Through beam" means the tmux channel of §3 and
nothing else — no file access on the far machine. "Breaks" means a wrong or empty
answer, not a throw.

| feature | today | through beam | what it still lacks |
|---|---|---|---|
| readiness / limit / dialog / agents / compaction | **breaks** | **works, unchanged** | nothing — pure functions of the capture (§3.2, §10) |
| the window list (what is running over there) | **breaks** | **works** | nothing |
| session id, provider, profile, title, idle age | **breaks** | **works** | idle age is last-paint, not transcript mtime (§2.6) |
| `unblock <id>` | **breaks** | **works** | nothing — resolve a target, send keystrokes |
| `send <id>` | **breaks** | **works via the pane** | the peer socket, and with it `pidAlive`'s recycled-pid guard (§2.4, §2.5) |
| `close` / `kill` | **breaks** | **guard works, bookkeeping does not** | `forgetRestoreTab` writes the LOCAL restore snapshot for a REMOTE window. Do not ship until that is scoped |
| `wait` | **breaks** | **works** | `stalled` is judged from idle age, so it inherits §2.6's caveat |
| `list` / `status` (window-level) | **breaks** | **works** — §10 | see the three rows below |
| `status --full` (checklist, activity, final response) | **breaks** | **breaks** | transcript records on the far machine |
| git branch / unpushed | **breaks** | **breaks** | `.git` ref files on the far machine |
| linked PR / work item | **breaks** | **breaks** | follows the branch; the backend call itself is local |
| `launch` | **breaks** | **partial** | `new-window` is tmux, but the worktree is git and the repo must exist there |
| `resume <id>` | **breaks** | **partial** | the resume argv is recoverable (§2.6); putting a terminal on it is `beam attach` |
| `open <id>` | **breaks** | **partial** | needs the linked PR, so it needs the branch |
| `restore` | n/a | **leave alone** | per-machine by construction — §7 |
| clone flow | n/a | **leave alone** | clones to a local path — §7 |
| orchestrator mode | **breaks** | **works once the CLI does** | the injected prompt names `list`/`status`/`send` and must learn the host qualifier, or it will address the wrong machine |

Two rows are worth pulling out.

**`close` is the dangerous one.** Its safety guard — readiness plus
`paneBackgroundAgents` off one capture — reads correctly over the transport. Its
*bookkeeping* does not: `forgetRestoreTab` edits this machine's
`~/.agendo/restore.json` for a window on another machine, corrupting local
restore state while leaving the remote's untouched. The guard being fine is
exactly what makes this easy to ship by accident.

**`send` degrades quietly rather than loudly.** The pane path works. What is lost
is the peer socket — which is not merely a nicer delivery mechanism, it is the
one that *queues* instead of requiring the TUI to be idle, and the one whose
`pidAlive` check stops a recycled pid misdelivering a prompt. A remote `send` on
the pane path is the pre-#31 behaviour, and should say so rather than look like
the current one.

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

### 5.2 `remote:session:window` — withdrawn

The first draft claimed this composition "fights" beam's parser. On the evidence
it quoted, it does:

```ts
// beam/src/lib.ts
export function parseTarget(spec: string): [string, string] {
  const i = spec.indexOf(":");
  if (i !== -1) return [spec.slice(0, i) || LOCAL, spec.slice(i + 1)];
  return [LOCAL, spec];
}
```

First colon. So `vm:agendo-git:cl-bg-520e1fafd572` yields remote `vm` and
"session" `agendo-git:cl-bg-520e1fafd572`, which beam then wraps in
`exactTarget()` and hands to tmux as a session name containing a colon.

But that is an argument against **beam interpreting the remainder as a session
name**, not against the composition. Split host-first and treat everything after
as an **opaque tmux target**, and `parseTarget` is already correct:
`vm:=agendo-git:=cl-bg-x` → host `vm`, target `=agendo-git:=cl-bg-x`, passed
through untouched.

The claim is withdrawn. It is still not the design chosen, for a different and
better reason: making the host a flag (`-H`) means beam never has to find, parse
or rewrite a target at all, and tmux has ~180 commands whose target argument sits
in different places. A flag is one rule; target rewriting is 180 special cases
waiting to be got wrong.

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
shape, different vocabulary. Worth deciding deliberately (open question 3).

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

**Independently confirmed since.** beam's own pass-through implementation hit
the identical wall from the other side and reached the same conclusion: the
exact-match pane target is `=<session>:`, not `=<session>`. Two separate
reproductions on tmux 3.4, from two codebases that were not comparing notes.

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

**A daemon on the remote.** A second lifecycle to manage, upgrade, leave running
and secure. Stage 1 needs nothing running over there but tmux and sshd, which is
the whole appeal — the far machine keeps no agendo state and cannot drift from
this one. Revisit only if question 1 is answered "indistinguishable", and even
then a derived one-shot read beats a resident process.

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
flight. **As of writing the split PR is still not open.** So this is written
against the seams: 14 I/O call sites, and ~1,650 lines of pure classification
between lines 179 and 1827 that no stage below touches. Every stage changes the
I/O band only. If the split extracts that band into its own module, stage 1 gets
easier, not harder — and stage 1 has already collapsed it to one function.

### Stage 1 — the smallest independently useful slice — **BUILT**

> **`agendo remote <machine>`: a read-only, cross-machine listing of what is
> running over there and whether any of it is stuck.**

No writes anywhere, no TUI change, no remote state touched. See §10 for what it
actually produces and what was verified. What it needed on each side:

*beam:* `-H <host>` pass-through with byte-exact stdout, faithful exit status,
a reserved code for transport failure, and quoting that survives arbitrary
payloads. Specced in full and implemented separately.

*agendo:* one function (`tmuxArgv`), and every `spawnSync` in `tmux.ts` routed
through it — which is what makes the host axis reach every invocation rather
than the handful a narrower change would have covered.

### Stage 2 — decide the boundary of §3.3

Everything past here depends on an answer to open question 1: whether the remote
row must become indistinguishable from a local one, or whether window-level is
the feature. **Do not start stage 3 before that is settled** — the three items in
§3.3 are the only reason to add a non-tmux channel at all, and adding one is a
much larger commitment than anything in stage 1.

### Stage 3 — one-shot remote writes

`unblock` first: it is the only write that needs nothing but a target and
keystrokes, which makes it the honest canary. Then `send`, which must say that
it is on the pane path and not the socket (§4). `close` **after**
`forgetRestoreTab` is scoped per machine, not before.

The remote write path is currently threaded but **unexercised**: there is no
sshd on this machine and the remote is read-only by instruction, so it has
argv-level tests and nothing more. That gap is the first thing stage 3 must
close, and it needs a machine that can be written to.

### Stage 4 — `wait`

Poll the pane over the transport, exactly as the local path does; the per-tick
budget (`wait.ts`: one listing plus one capture per target, no transcript read)
survives unchanged. The one new question is what a dropped connection means —
open question 4.

### Stage 5 — the TUI

Machine column; `sessionId` becomes `host:source:id`. The `launcher` collision of
§5.1 is live today and this is where it starts to matter.

### Stage 6 — remote `launch`

The prize, and correctly last. `new-window` is tmux and comes free; the worktree
is git and does not. Orchestrator instructions must learn the host qualifier in
the same change.

## 9. Open questions for the owner

Reordered: question 1 now gates everything after stage 1.

1. ~~**Does the remote row have to become indistinguishable from a local one?**~~
   **ANSWERED — see §12.** The owner's answer: `agendo ls` and the TUI both show
   every machine's sessions beside the local ones, and enter must attach to a
   remote row. `send` / `wait` / `resume` / `launch` are wanted but explicitly
   not part of this proof of concept. One constraint added with the answer, and
   it is the one that makes it safe: **behind a flag, local-only by default**,
   with the flag taking either all registered machines or a named one. The
   original question is kept below because the reasoning behind it is what §12
   had to respect.

   **Does the remote row have to become indistinguishable from a local one?**
   §3.3 lists what tmux cannot reach: branch/unpushed, the task checklist and
   activity, and the linked PR. Each needs *files* on the far machine, which
   means a second channel beside the tmux one — a non-tmux beam verb, or agendo's
   own ssh, or a derived read run over there. That is a much larger commitment
   than stage 1 was. If "what is running, and is it stuck" is the feature, none
   of it is needed. **This decides whether stages 2–6 happen at all.**

2. **Whose host list?** beam's `~/.config/beam/config.json` is already there and
   already curated, and reading it costs nothing — which is what stage 1 does.
   But it makes agendo's behaviour depend on another tool's config file, and beam
   is not installable from npm (§1.6). Keep reading beam's with a fallback? Add
   `agendo host add` and duplicate `beam remote add`? Or require beam?

3. **`vm:<short-id>` or `--host vm`?** For the *user-facing* selector — the
   transport already uses `-H` and that is settled (§5.2). The prefix form reads
   well in an orchestrator's prompt and matches beam; the flag form can never be
   ambiguous with a session id. I lean prefix with `--host` as a synonym.

4. **Bare short id across machines: refuse, or prefer local?** Twelve hex
   characters will not collide by accident, but a resumed session present on both
   machines would. `close`'s precedent is to enumerate and refuse; `status`'s is
   to narrow by scope first. Refusing is safer and more annoying.

5. **What does a dropped ssh mean to `wait`?** A network blip becomes a wake-up.
   `wait` already distinguishes `woke: "blocked"`, so a `woke: "unreachable"` is
   cheap — but it is a contract change every orchestrator loop must learn.

6. **Is `window_activity` a good enough idle age?** It is last-paint, not
   transcript mtime (§2.6). It freezes for a settled session and moves for a
   working one, which is the behaviour `stalled` wants — but it is a different
   number from the one `agendo list` prints locally, and `stalled` is load-bearing
   for orchestrators. Accept the difference and document it, or hold `stalled`
   back on remote rows until the transcript is reachable?

7. **Should the `exactTarget` pane-target bug (§5.4) be fixed first?** Independent,
   small, and it makes the basename-collision guard work again. It also touches
   `tmux.ts` while the split is in flight. File it, or fix it inside the split?

8. **Where does the 45 ms per beam call get paid?** (New — §11.2, measurable
   only now that real beam exists.) Every beam invocation is a fresh bun process
   that re-reads config and re-probes `ssh -G`, so ~30 ms of each call is startup
   rather than network. On-demand (`agendo remote vm`, ~1 s) that is fine. On a
   TUI refresh cadence it is not. Three ways out, and they are not exclusive:
   collapse reads with tmux `;` chaining (beam pins it with tests), have beam
   grow a persistent or batch mode, or keep remote rows on-demand only. This is
   the one thing I would want decided before stage 5.

9. **The lint ratchet.** Wiring `agendo remote` in cost `src/index.tsx` 3 lines
   (an import, a dispatch line, a separator) no matter how much of the command
   lives in `src/cli/` — every line of it does. Completing the transport seam
   *earned* a lowering on `src/tmux.ts` (2301 → 2299), which was spent in the same
   change, so the net is negative. But the contract says a raise is the part that
   needs an argument, so: that is the argument. Say if it is not good enough.

---

## 10. What was actually built, and what was verified

Stage 1 exists, and now runs against **real beam** rather than a stub of its
contract — §11 records what changed between the spec and the implementation.
`agendo remote vm`, against a live remote, read-only:

```
ID            READY      AGE     DIR           TITLE
0fe53844cc68  ready      11h     review-fable  ✳ Use Fable and Opus sub agents for code review
—             unknown    4d      orchestrator  ~/git/orchestrator
8e3bec3fd38d  dialog     11h     orchestrator  ✳ Set up orchestrator skill with bunx agendo
f7c286cb78df  limited    18s     agendo        ✳ Check status of all open PRs  ·  resets 15:50
3b6a734a0d50  ready      11h     beam          ✳ beam-remote-squishy-wave
cf3aa51db0d1  ready      11h     orchestrator  ✳ Investigate regolith Ubuntu 26.04 support
```

Six windows in **0.86 s** through the stub, **0.99 s** through real beam (§11.2
explains the difference: beam is a bun process, and ten of them start here). The
`limited` row's reset time and the `dialog` row
are `paneUsageLimited` / `paneResetAt` / `paneReadiness` classifying a **remote**
pane with no change to those functions — §3.2's claim, demonstrated. The
unidentified row is a pane tmux reports no start command for (§2.6 caveat 1),
shown as `—` rather than guessed at. `mdos` degrades to one warning and exit 0.

Gates: e2e **649 passed, exit 0** with every tmux call in the file rerouted; lint
green; 53 unit tests. (Re-run in full against real beam, not only against the
stub — same result, and the one previously flaky spec passed clean.)

### Four bugs found in the building, worth recording

1. **Codex's resume grammar is positional.** The identity parser was written
   against claude's `--resume <uuid>` and silently missed `codex resume <uuid>`.
   The row still rendered — just with no id to address the session by, which is
   the kind of failure nobody reports.
2. **The pane-field lookup never matched a managed tmux *session*.** agendo run
   outside tmux names the session `cl-…` rather than a window inside one, so
   there is no window name to key on. The obvious fix — fall back to the
   session's first pane — would have been *worse than the bug*: an ordinary
   window whose key merely missed would have inherited a different session's id
   and title, rendered as though it were its own. The fallback is gated on
   `name === session`.
3. **A reset time was shown on a `ready` row.** The cap notice lingers in
   scrollback after a session recovers. The local path already gates this
   (`cells.ts:rowResetAt`); the remote path had to learn the same rule.
4. **The unit tests passed only because of the shell they ran in.** `AGENDO_BEAM`
   and `BEAM_CONFIG_DIR` are read from the ambient environment, and the suite
   restored them afterwards without clearing them first. Exporting `AGENDO_BEAM`
   — which is exactly what pointing agendo at a development build of beam does,
   and therefore what §11 required — turned three green tests red. Found by doing
   it, not by reading it. They now clear per test.

### What is NOT verified

The remote **write** path — `send-keys`, `paste-buffer`, `kill-window` — is
threaded through the same seam and **has never been run against a real remote**.
There is no sshd on this machine and the one available remote is read-only by
instruction, so it has argv-level tests and nothing else. It is not known to
work. Stage 3 has to close that.

## 11. Reconciliation: beam as built vs beam as specced

Everything above §10 was written against a *specification* of beam's pass-through
mode and exercised through a 30-line stub of that contract. beam's pass-through
mode now exists (`9d08f73`, local, unpushed). The POC has been re-run against the
real thing. (Its author reports 407 tests green including a docker e2e; I ran the
368 non-docker ones myself and they pass, which is the part I will claim.) This section records the differences, because a
spec that was never checked against its implementation is a plan, not a finding.

**The seam needed no change.** `tmuxArgv(host, args)` emits
`beam -H <host> <args…>` and that is byte-for-byte what real beam accepts.
Re-verified against the live remote:

```
$ AGENDO_BEAM="bun …/beam.ts" agendo remote vm
ID            READY      AGE     DIR           TITLE
0fe53844cc68  ready      11h     review-fable  ✳ Use Fable and Opus sub agents for code review
—             unknown    4d      orchestrator  ~/git/orchestrator
8e3bec3fd38d  dialog     11h     orchestrator  ✳ Set up orchestrator skill with bunx agendo
f7c286cb78df  limited    20m     agendo        ✳ Check status of all open PRs  ·  resets 15:50
3b6a734a0d50  ready      11h     beam          ✳ beam-remote-squishy-wave
cf3aa51db0d1  ready      11h     orchestrator  ✳ Investigate regolith Ubuntu 26.04 support
```

Identical to the stub's output. Byte-fidelity re-verified through real beam:
`capture-pane -p -e` via beam and via direct ssh both give 2653 bytes,
sha `3cd23d0f…`, 9 SGR-carrying lines — `cmp` clean.

### 11.1 Where the spec was wrong

**`-H` cannot appear anywhere.** The spec said beam should accept the host flag
at any position. `tmux send-keys -H` already means *hexadecimal*, so scanning the
whole argv would either eat that flag or force beam to know the arity of every
tmux option it scans past — both of which contradict "forwarded verbatim". Real
beam takes leading `-H`/`--host` only. agendo is unaffected (it builds argv
programmatically and always leads with the flag), but the spec sentence was
wrong and is withdrawn.

**"No collisions other than the four" was wrong.** `bind` is a tmux alias for
`bind-key`, and `a` reaches `attach-session` through tmux's unambiguous-prefix
matching. Five shadowed spellings, not four. Resolution is as specced — reserved
verbs stay beam's, long forms always pass through — but the census was
incomplete.

Checked against what agendo actually sends, and it is clean: every first word in
the tree is a tmux long form — `capture-pane`, `display-message`, `has-session`,
`kill-session`, `kill-window`, `list-panes`, `list-sessions`, `list-windows`,
`new-session`, `new-window`, `paste-buffer`, `select-window`, `send-keys`,
`set-buffer`, `set-option`, `set-window-option`, `show-options`. None collides
with a reserved beam verb. That is a property worth keeping rather than
rediscovering: `beam -H vm ls` is a hard error by design.

**Missing tmux is 127, not 255.** The spec folded "no tmux on the far machine"
into `TRANSPORT_EXIT`. Real beam passes 127 through, on the grounds that
rewriting it would assert no tmux invocation can ever legitimately exit 127 —
which is not provable, and with inherited stdio beam cannot read stderr to
disambiguate. This is the better call and agendo now names the number
(`NO_TMUX_EXIT`), which also buys a more accurate warning: the fix for `mdos` is
on `mdos`, not on the wire.

```
$ agendo remote mdos
warning: mdos: /bin/bash: line 1: tmux: command not found
$ echo $?
0
```

The degradation contract of §6 holds against real beam: zero rows, one warning,
exit 0.

**Connection multiplexing: the spec's suggestion was actively harmful here.** I
proposed beam manage its own `ControlMaster`/`ControlPath`. On this machine that
*hangs*: `~/.ssh/config` already runs a master to the remote, command-line
options beat the config file, and naive injection bypassed the warm master and
forced fresh auth through the 1Password agent — which refuses while the owner is
away. Real beam probes with `ssh -G` first and injects nothing when the
destination already has a `ControlPath`. Verified independently here:

```
$ ssh -G kristjan@10.0.0.229 | grep -i control
controlmaster auto
controlpath /home/kristjan/.ssh/cm-kristjan@10.0.0.229-22
controlpersist 43200
```

**`capture-pane -t '=<session>'` — independently confirmed.** §5.4 found this
from agendo's side; beam's implementation hit the identical wall from the other
side and reports the same fix (`=<session>:`). Two independent reproductions on
tmux 3.4. It remains a *local* agendo bug with nothing to do with beam, and it is
still unfixed — see open question 7.

### 11.2 The one new cost, and what it implies

Real beam is a `bun` process, and that dominates. Measured, 5 runs each, warm
connection:

| call | median |
|---|---|
| local `tmux capture-pane` | **0.004 s** |
| `ssh <host> tmux capture-pane` | **0.015 s** |
| `beam -H <host> capture-pane` | **0.045 s** |

So beam adds ~30 ms per call over raw ssh, and that ~30 ms is process startup,
not network — beam re-reads its config and re-runs the `ssh -G` probe in every
process, because there is no process to cache it in. `agendo remote vm` takes
0.99 s for six windows, of which roughly half is beam starting up ten times.

This does not change the design, and it *strengthens* two things already in it:

1. **The local path must stay a direct spawn** (§3.1). The gap is now measured
   against real beam rather than against a bun-startup proxy: 0.045 s vs 0.004 s,
   an 11× difference on the call agendo makes most.
2. **Batching stops being an optimisation and becomes the design.** A readiness
   poll is ~2N+3 tmux calls; at 45 ms each a 12-window remote session costs
   ~1.2 s per poll, ~0.8 s of which is beam starting up. Two ways out, and they
   compose. tmux's own `;` chaining survives the transport — verified here,
   read-only, and a two-command chain costs **0.05 s**, the same as one command,
   so chaining a pair of reads is free. And one `list-panes -a -F` can carry
   several fields at once, so the §2.6 metadata is two reads rather than three
   (the third rode along, see §2.6). The POC does the second and not the first.

   Honesty about the second: folding that read in changed the wall clock by
   nothing measurable — 0.99 s before, 0.99 s after, on six windows. The saving
   is one call in ten. It is in because it is *free and correct*, not because it
   was felt. The number that would be felt is the per-window `capture-pane`, and
   only chaining or a persistent beam reaches that.

If remote polling ever runs on a TUI cadence rather than on demand, this is the
number that decides whether it is viable — not the network.

---

## 12. What the answer to question 1 turned into

The owner answered §9 question 1 directly: remote sessions belong in `agendo ls`
and in the TUI, and enter on a remote row must attach. Not `send`, `wait`,
`resume` or `launch` — wanted, but out of scope here. And **behind a flag**:
local-only by default, the flag taking every registered machine or a named one.

That flag is what makes the rest of this defensible. Without it, every agendo
invocation on a machine with a beam config would start spawning subprocesses to
other computers. With it, the default path is byte-for-byte what it always was.

### 12.1 The surface

```
agendo --remote            # launcher, every machine beam has registered
agendo --remote=vm         # launcher, just vm (repeatable)
agendo ls --remote         # the same, for the one-line listing
```

The value form needs the `=`, because both commands also take an optional
`[dir]` positional and `--remote /some/path` could not otherwise be told from
"all machines, scoped to that path". Guessing there would silently scope a
listing to something other than what the command line reads as. A bare
`--remote <known-machine>` is therefore an error with a hint, not a misread —
and only when the next token names a machine beam actually knows, so an ordinary
path argument is never second-guessed.

`agendo ls --remote` grows one column, and only then:

```
●  local  ready          bg   f942f3b8f8cc  7m ago    refactor-and-guardrails   Agendo refactor enforcement and linting
●  vm     ready          —    0fe53844cc68  13h ago   review-fable              ✳ Use Fable and Opus sub agents  ⚠stalled
●  vm     dialog         —    8e3bec3fd38d  13h ago   orchestrator              ✳ Set up orchestrator skill     ⚠stalled
●  vm     limited 15:50  new  f7c286cb78df  1m ago    agendo                    ✳ Check status of all open PRs
●  vm     unknown        new  —             3d ago    orchestrator              ~/git/orchestrator
```

`limited 15:50`, `dialog`, `⚠stalled` and the `—` for an unidentified pane are
all the LOCAL classifiers, unchanged, run against a remote capture. Without the
flag there is no machine column at all: every row would say `local`, which is
noise, and the local output has to stay exactly what it was.

### 12.2 Identity: the machine is part of it

`live`, `liveKinds` and `liveWindows` have always been keyed by
`sessionName(s)` — the tmux window name. That is not unique across machines: the
same session resumed on two of them carries the same `cl-<source>-<shortid>` on
both. Keyed by name alone, one machine's window answers for the other's, and
enter attaches you to the wrong machine.

So `liveKey(s)` folds the host in, and is `sessionName(s)` exactly when there is
no host — nothing local moves. `isRunning` was the ONLY place that key was
computed, which is why this is a small change rather than a sweep.

The separator is a **NUL**, not a `/`. These maps also hold raw tmux names
(`reconcileLive` seeds them from `liveTargets()`), and agendo names its own
remote-attach windows `<host>/<window>` — so a slash test would classify the
LOCAL half of a remote attach as remote. tmux cannot put a NUL in a name.

### 12.3 Attach: nested tmux, and no pretending otherwise

There is no `switch-client` to a window on another machine — a tmux client can
only display windows served by the tmux it is attached to. Attaching to a remote
session therefore means a LOCAL window whose command is an ssh carrying a remote
tmux client. That is nesting, and it shows: the inner tmux draws its own status
bar inside the outer window, its panes resize to the outer client, and the inner
session takes a doubled prefix (`prefix prefix d` to detach the remote end).
None of that is hidden; the help text says it.

The attach does NOT go through pass-through. Pass-through refuses a tty on
purpose — `-t` would let the line discipline rewrite `\n` as `\r\n` and destroy
the byte-exactness every pane read depends on — and an attach needs exactly that
tty. So it goes through beam's own `attach` verb, which is a second seam
(`beamAttachArgv`) rather than a special case of the first.

Three things agendo needs there that a human's `beam attach web:deploy` does not,
all of which beam now has:

| need | why | beam |
|---|---|---|
| a **window**, not a session | agendo's sessions are windows inside a remote session | `host:session:window` |
| **no creation** | a stale row must not spawn a session on someone's machine | `--no-create` |
| the **exec form** unconditionally | agendo already made the window; beam sees `$TMUX` and would open a second | `--exec` |

Landing on the right window costs no extra round trip. tmux resolves the `-t`
target BEFORE opening the terminal, so `attach-session -t '=session:=window'`
selects that window as part of attaching — verified here on a throwaway server,
and the property beam's own suite leans on. No `select-window` is sent: one would
move the active window for everyone else attached there even when the attach
then fails.

### 12.4 The 2-second timer, which is where this could have gone wrong

agendo re-scans local tmux every 2 seconds. Putting the remote sweep on that
timer would have been the obvious wiring and a serious mistake: a beam call is
~45 ms and a sweep is ~2 calls per remote window (§11.2), so a handful of remote
sessions would put the best part of a second of subprocess work on a 2-second
timer. That is the same CPU regression the `gitrefs` import guard in
`e2e/cli.spec.ts` exists to prevent, an order of magnitude worse.

So machines are swept on a FULL load only — startup and `r` — and the 2 s rescan
folds its fresh local scan onto the remote half already in the model rather than
replacing it. **Remote rows keep their readiness until the next `r`; local rows
stay live at 2 s.** That difference is real, and it is the honest trade: a stale
remote row beats a launcher that stalls for a second at a time. If remote rows
ever need to be live, §9 question 8 is the decision that has to come first.

### 12.5 What this cost the ratchet, and what it earned

Wiring `--remote` into `agendo ls` needed lines in `src/index.tsx`, which sat
exactly on its `max-lines` cap. Rather than raise it, `runList` / `runPlainList`
and then the `list` argv parsing moved to `src/cli/list.ts` where they belonged:
**`src/index.tsx` went 1237 → 750**, and the cap went with it, twice, in the same
change. `src/ui/App.tsx` needed four lines for the new prop and paid for them by
folding two identical set-toggle closures into one helper (1036 → 1035).

The extraction tripped a real guard on the way, which is the interesting part.
`e2e/cli.spec.ts:1690` enforces that `src/gitrefs.ts` has exactly ONE importer —
`src/index.tsx` — so that per-session ref reads can never reach the 2 s rescan.
Moving `runList` out took `branchSync` with it and broke that rule. The suite is
frozen, so the fix was not to widen the allow-list: `runList` now takes the ref
reader as an argument. That satisfies the guard's letter and its intent both — a
one-shot listing may read refs, a timer may not.

### 12.6 What is verified, and the one leg that is not

Verified, by running it:

* `agendo ls` with no flag is unchanged, byte for byte.
* `agendo ls --remote` lists local and remote together; `--remote=vm` narrows;
  `--remote vm` errors with the `=` hint.
* The TUI loads 6 remote sessions into their own `vm` group, `isRunning` is true
  for each, `liveWindows` resolves each to its real remote target, and
  `openSession` yields a plan that opens `vm/<window>` locally.
* `mdos` — reachable, no tmux — contributes zero rows and one warning, exit 0.
* **The attach itself**, through beam, against a throwaway local session: it
  lands on the REQUESTED window rather than the active one, a missing window
  exits 1 and moves nothing, a missing session exits 1 and creates nothing, and
  detach exits 0. The throwaway session was killed afterwards; `kill-server` was
  never run.

**Not verified: an attach to the live remote.** The argv is unit-tested, the
mechanism is verified locally, and beam's own suite exercises the remote leg over
real ssh in docker — but agendo has not attached to a session on `vm`. That is
deliberate rather than pending: both machines run `window-size latest`, so a new
client RESIZES the panes of whatever is attached, and the vm's sessions are live
agents mid-work. Doing it would disturb them, which the standing instruction for
this work forbids. It needs one word from the owner, not more engineering.

---

## Appendix: verified vs inferred

**Verified — I ran this and got that.** All read-only against the remote. No
remote session was attached to, sent to, or killed; no bytes were written to any
peer socket; no beam config was changed; `tmux kill-server` was never run. The
nested-tmux reproduction used two throwaway servers on dedicated sockets.

* beam's full source and README, read completely.
* `beam ls` / `beam remote ls` output, quoted verbatim.
* `ssh vm "tmux capture-pane -p -e -t '=session:=window'"` returns full-fidelity
  pane content for any window, attached or not — §2.1.
* **Byte-exactness through the transport**: capture via agendo's path and via
  direct ssh produce identical sha256, 7534 bytes, 37 lines carrying SGR escapes.
* Latency: **0.020 s** warm, **0.39–1.13 s** cold, **0.82 s** for `mdos`'s
  failure. The remote has `ControlMaster auto` / `ControlPersist 12h` configured.
* Process costs: a **bun** process **15.7 ms**, a bare **tmux** spawn **3.6 ms**
  (10 runs each) — the measurement behind "a null host is a direct spawn".
* Exit statuses: remote tmux failure passes through as **1**; an unreachable or
  unregistered host is ssh's **255**; a reachable host with no tmux is the
  shell's **127** (re-measured against real beam — §11.1 corrects an earlier
  claim that folded 127 into 255). All three are distinguishable from each other
  and from a tmux answer, which `close`'s guard depends on.
* **Tabs survive** a non-interactive ssh intact (`agendo-git^Ilauncher`), with or
  without `LC_ALL`. This was *predicted to break* — beam's own source warns tmux
  substitutes `_` for control characters in that situation — and it did not
  reproduce. The prediction is withdrawn.
* tmux **command chaining** survives ssh AND real beam: `display-message … ';'
  display-message …` runs both, and the chained call costs **0.05 s** — the same
  as either command alone — so collapsing a two-call read is free.
* One `list-panes -a -F` carries `session_name`, `window_name`,
  `window_activity`, `pane_title` and `pane_start_command` in a single
  tab-separated line over the transport, tabs intact. The last field is the only
  one that needs to be arbitrary-valued, which is why the metadata read is now
  two calls and not three.
* `#{pane_start_command}`, `#{pane_title}` and `#{window_activity}` carry the
  full session UUID, provider, config profile, resume argv, title and a
  last-paint timestamp — §2.6, quoted verbatim.
* `window_activity` is unchanged across an 8-second sample for every idle window
  (so the claude status-line clock does not repaint on a timer).
* Panes with **no** start command exist and are reported empty by tmux — `bash`
  and one `cl-new-…` window.
* Clock skew between the two machines: **0 s**, checked twice on different days
  (`date -u +%s` identical).
* Nested-tmux capture: the outer capture contains the inner pane's content **plus
  the inner status bar**, and the inner pane resized 200x50 → 100x29 to match the
  outer client — §1.3.
* No local tmux window runs `ssh` to the remote; the live attachment is a bare
  `ssh -t … tmux new-session -A -s agendo-git` outside tmux — §1.3.
* `window-size latest` on both machines, so a new client resizes the panes an
  existing agendo is reading.
* `ssh -L <local.sock>:<remote.sock>` forwards a unix socket and a local connect
  reaches the remote session's messaging socket — §2.4. Zero bytes written.
* `beam-mux` is not on npm (404); `agendo` is, at 0.2.0. `~/.bun/bin` on the
  remote holds `beam bun bunx claude` and no `agendo`, and is not on the
  non-interactive ssh PATH.
* `~/.codex` does not exist on the remote — no Codex sessions to aggregate there.
* `launcher` is the one window name live on both machines (5 local, 1 remote).
* `tmux.ts` had 14 `spawnSync` sites and none between lines 179 and 1827. It now
  has **zero**: all of them route through the one transport seam.
* The `=<session>` pane-target failures of §5.4 — each row of that table run
  individually, on the live server and on a throwaway one, tmux 3.4.
* beam's `parseTarget` splits on the **first** colon (source read).
* `reconcileLive` drops a managed window whose name resolves to no indexed
  session.
* **Stage 1 works**: §10's listing, produced against the live remote. Gates: e2e
  649 passed exit 0, lint green, 53 unit tests.
* **Against REAL beam**, not the stub (§11): identical listing; byte-identical
  capture (2653 bytes, sha `3cd23d0f…`, `cmp` clean vs direct ssh); `mdos`
  degrades to one warning and exit 0; unknown host exits 255; a bogus tmux target
  exits 1; `beam -V` passes through to `tmux 3.4`.
* Per-call cost against real beam, 5 runs each, warm: local tmux **0.004 s**,
  raw ssh **0.015 s**, beam **0.045 s** — §11.2.
* The remote's ssh destination already carries `ControlMaster auto` /
  `ControlPath` / `ControlPersist 43200` (`ssh -G`), which is why beam's `ssh -G`
  deference matters and why the spec's own-ControlPath suggestion was wrong.
* Every tmux verb agendo sends, enumerated from the tree: all seventeen are long
  forms, none collides with a reserved beam verb — §11.1.

* **beam's window-targeted attach** (§12.3), against a throwaway local session
  on the default server: `attach --exec --no-create local:<sess>:<win>` lands on
  the REQUESTED window (active window moved `first` → `cl-claude-deadbeef1234`),
  a missing window exits **1** and moves nothing, a missing session exits **1**
  and creates nothing, and a pty attach detaches cleanly with exit **0**. The
  throwaway session was killed by name afterwards; `kill-server` was never run
  and the owner's seven live sessions were untouched.
* `tmux attach-session -t '=session:=window'` selects that window as part of
  attaching — the active window moved even though the attach itself failed for
  want of a terminal (tmux 3.4, throwaway server). This is why no `select-window`
  round trip is sent.
* The TUI model with `--remote`: 6 remote sessions in their own `vm` group,
  `isRunning` true for each, `liveWindows` resolving each to its real remote
  `=session:=window`, and `openSession` producing a plan that opens `vm/<window>`
  locally. `mdos` degraded to one warning.
* beam's own suite: 368 non-docker tests on the pass-through build, run here;
  its author reports 438 including docker e2e on the attach build.

**Inferred — this should follow, and has not been checked.**

* **That an attach to the LIVE remote works.** The argv is unit-tested, the
  mechanism is verified locally, and beam exercises the remote leg over real ssh
  in docker — but agendo has not attached to a session on `vm`. Deliberately:
  both machines run `window-size latest`, so a new client resizes the panes of
  whatever is attached, and the vm's sessions are live agents mid-work.

* That the remote **write** path works. It is threaded through the same seam and
  has argv-level tests, and it has never been run against a real remote: there is
  no sshd on this machine and the one available remote is read-only by
  instruction. **This is the largest unverified claim in the document** and §8
  stage 3 exists to close it.
* That the beam-attached-window path (§1.3) behaves against the remote as it did
  in the local nested reproduction. The mechanism is identical; running it would
  have attached a second client to a live session.
* That tmux 3.6 (the remote's) behaves as 3.4 does for the §5.4 target forms.
  The table was produced on 3.4; the remote calls in §2.1 used the
  `=session:=window` form, which is correct on both.
* That `#{pane_start_command}` is stable across agent restarts within a window.
  Observed once per window, not over time.
* That a `fakebin/ssh` stub in the existing harness shape is sufficient to test
  the remote path end to end. Reasoned from `fakebin/tmux`, which does exactly
  this for tmux.

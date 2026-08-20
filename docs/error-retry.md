# Recovering a session that stopped on an error

## Problem

An agent session does not always stop because it is finished. Sometimes the turn
dies — the API drops mid-response, the backend is overloaded, the login expires —
and the CLI returns to an empty input box exactly as if the work were done.

A real specimen, captured read-only from `agendo-pc-to-phone-audio:3` (a
long-running orchestrator in `/home/kristjan/git/pc-to-phone-audio`):

```
● Agent "Commit review fixes F1-F7" finished · 57s

● Committed as 35e2481. Slices 4–5 now — the controller and the UI.

● API Error: Connection lost mid-response. The response above may be incomplete.

✻ Worked for 1h 48m 20s

❯ retry
```

That session had worked for 1h 48m, had just committed a review round, and died
mid-response. Its transcript then records **nothing at all** between
`2026-08-20T06:49:19Z` (the error) and `2026-08-20T10:11:20Z`, when a human
typed `retry` by hand. Three hours and twenty-two minutes of a machine sitting
idle because a socket closed.

Automating that keystroke is the feature. Doing it *naively* is the danger, and
the owner said so:

> "we have to be careful though, wrt retrying too often. Cannot just send a
> 'retry'/'are you done?' message to revive from the error state every time we
> see an error. we'd need retry and backoff strategy, I think..."

He is right, and there are four independent reasons why, each of which shapes
the design below:

1. **An errored session is structurally indistinguishable from a finished one**
   at the pane. Both are an empty input box. `paneReadiness` calls both `ready`.
   This is the same wall `stalled` (#26) hit and deliberately stopped at.
2. **Not every error is retryable.** Retrying an expired login never succeeds.
   Retrying a usage limit burns an attempt against a feature that already exists.
   "Retrying" a session that stopped to *ask the human something* answers the
   question blindly.
3. **Retry is not idempotent.** "The response above may be incomplete" is the CLI
   telling us it does not know how far the turn got. Neither do we. A blind
   "retry" can re-run a migration, re-push a branch, re-open a PR.
4. **Every retry spends the owner's usage.** A retry loop against a session that
   will never recover is a quota fire.

## Summary of the design

| | |
|---|---|
| **Detect from** | the session's own JSONL transcript tail, not the pane |
| **Retryable class** | `server_error` only (the CLI's own label) |
| **Never retried** | `rate_limit`, `authentication_failed`, sidechain errors, anything that is not an error record |
| **Attempts** | 3, delays ≈ 2m / 8m / 32m, ±25 % jitter |
| **Counter resets on** | the transcript growing past the error record — nothing else |
| **Delivery** | peer socket first, tmux pane as fallback |
| **Message** | an explicit "check what already landed before you redo it" brief, never bare `retry` |
| **Default** | **OFF** |
| **New surface** | an `errored` qualifier (like `stalled`), `agendo retry <id>` (like `unblock`) |

---

## 1. Error taxonomy

### 1.1 The discovery that makes this feasible

Claude Code writes a **structured error record** into the session transcript.
From the specimen above, `06772a6f-…jsonl` line 1041, verbatim (elided for
width):

```jsonc
{
  "type": "assistant",
  "isSidechain": false,
  "timestamp": "2026-08-20T06:49:19.207Z",
  "message": {
    "model": "<synthetic>",
    "role": "assistant",
    "content": [{ "type": "text",
      "text": "API Error: Connection lost mid-response. The response above may be incomplete." }]
  },
  "error": "server_error",
  "isApiErrorMessage": true,
  "sessionId": "06772a6f-5c36-4efa-9972-787434a08f13",
  "version": "2.1.235"
}
```

Two fields carry the whole taxonomy: `isApiErrorMessage: true` marks the record
as an error rather than model output, and **`error` is the CLI's own
classification**. It is not something agendo has to infer from prose.

Across every transcript on this machine (`~/.claude/projects/**/*.jsonl`, 174
error records), `error` takes exactly three values:

| `error` | count | sidechain | main-session | verdict |
|---|---|---|---|---|
| `rate_limit` | 145 | 40 | 105 | **not this feature** — see §5.3 |
| `server_error` | 21 | 12 | 9 | **auto-retryable** |
| `authentication_failed` | 8 | 2 | 6 | **never retry** |

The three classes the owner asked about map one-to-one onto a field the CLI
already fills in. That is the single most important finding in this document:
the classification problem is *already solved upstream*, and agendo's job is to
read it rather than re-derive it from a pane.

### 1.2 Class A — `server_error`: retryable

Every distinct text observed, verbatim:

```
API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.
API Error: Connection lost mid-response. The response above may be incomplete.
API Error: Connection closed mid-response. The response above may be incomplete.
API Error: Server error mid-response. The response above may be incomplete.
API Error: Unable to connect to API (ENOTFOUND)
API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)
```

All nine main-session instances **ended the turn** — each is followed by a
`{"type":"system","subtype":"turn_duration"}` record or is the last record in
the file. The CLI's own in-process HTTP retries never reach the transcript, so
by the time agendo can see one of these, the cheap fast retries are **already
spent**. This is load-bearing for the backoff numbers in §3.

Note the sub-shape distinction the text carries: `529 Overloaded` and
`ENOTFOUND` failed *before* any output; `… mid-response. The response above may
be incomplete.` failed *after* partial output. That is the one place the CLI
tells us something about side effects, and §4 uses it — for **wording only**,
never to gate the retry.

### 1.3 Class B — `rate_limit`: not this feature's job, and increasingly not agendo's either

```
You've hit your session limit · resets 2:50pm (Atlantic/Reykjavik)
```

This is the usage cap. agendo already owns it end to end: `paneUsageLimited` /
`isUsageLimited` classify it, `paneResetAt` parses the reset instant,
`shouldAutoResume` fires `<esc>continue<enter>` once per window, and
`autoResumeOnUsageLimit` gates the whole thing. Ownership is decided **at the
source**: a `rate_limit` record is never eligible for error-retry, and a
`server_error` record is never eligible for auto-resume. The classes are
disjoint in the CLI's own field, so the two features cannot both fire on one
episode. See §5.3 for the full contract.

**Finding worth its own issue:** claude 2.1.235 now recovers from its own rate
limits. The same transcript shows, immediately after the `rate_limit` record:

```jsonc
{"type":"system","subtype":"informational",
 "content":"Usage limit reached · continuing automatically at 7pm · esc or type to cancel"}
```

…and later, unprompted:

```jsonc
{"type":"queue-operation","operation":"enqueue",
 "content":"Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached…"}
```

That is the CLI doing agendo's auto-resume for it. agendo's nudge may now be
redundant on recent builds, and two independent "continue" messages into one
session is its own small hazard. Out of scope here; flagged in §7.

### 1.4 Class C — `authentication_failed`: never retry

```
Login expired · Please run /login
Not logged in · Please run /login
Failed to authenticate: OAuth session expired and could not be refreshed
```

No number of retries fixes this, and every attempt costs a round trip and a
line of noise. This class is *detected* (so the session can be surfaced as
`errored` with an actionable reason — "run /login") and **never nudged**.

### 1.5 Class D — sidechain errors: never agendo's business

40 `rate_limit` / 12 `server_error` / 2 `authentication_failed` records carry
`isSidechain: true`. These are background (Task-tool) agents dying, and the CLI
**already recovers them itself** by re-prompting the parent. Same transcript,
line 487:

```
<task-notification>
  <status>failed</status>
  <summary>Agent "Part 1: stop capturing when mic off" failed: Agent terminated
  early due to an API error: API Error: Connection lost mid-response.…</summary>
</task-notification>
```

The parent session receives that as a `user` record with
`origin.kind = "task-notification"` and carries on. Sub-agent transcripts also
live in separate `agent-<hex>.jsonl` files, which `sessions.ts` already skips.
Both filters must hold: **file name is not `agent-*`, and `isSidechain` is
falsy**. An agendo that nudged on a sidechain error would be interrupting a
session that is *working*.

### 1.6 Class E — the states that are not errors at all

Three things stop a session with an empty box and leave **no error record**:

* it finished the work;
* it stopped to ask the human a question (an ordinary `assistant` text record);
* it is sitting on a dialog or permission prompt (`paneReadiness` → `dialog`).

None of these is retryable and none needs to be *distinguished from each other*
by this feature — the absence of an error record at the transcript tail is a
complete answer. This is why detection is framed as "is the last thing that
happened an error?" and not "does this session look stuck?".

### 1.7 What is genuinely undecidable

Stated plainly, because the rest of the design is built around them:

1. **Whether an interrupted turn's side effects landed.** `The response above
   may be incomplete` means the CLI does not know either. A commit may or may
   not exist; a push may or may not have reached the remote; a PR may or may not
   have been opened. This is not recoverable from any signal available to
   agendo. It is only *mitigable*, by the message wording in §4.
2. **Whether the work was nearly done or barely started.** Nothing in the
   transcript tail says.
3. **Whether a `server_error` will recur.** A 529 is a property of the backend
   at a moment, not of the session.
4. **Codex and Copilot.** No equivalent structured error record has been found
   in their logs. v1 is **claude-only**, and says so rather than guessing (§8).

---

## 2. Detection

### 2.1 Why the pane cannot be the primary signal

`src/tmux.ts` learned this the hard way twice, and the lesson generalises
exactly:

* **#33** moved busy/compacting detection to read positionally from the CLI's
  live status region (`liveStatusLines`), because a session that merely *quoted*
  a marker in its turn output got classified as busy. The transcript on screen is
  **history, not state**.
* **#30** / `paneResumeDialogActive` and `paneUsageLimited` anchor on the
  bottom-most content block above the input box for the same reason.

This document is being written by a session whose own pane currently contains
the line `● API Error: Connection lost mid-response…` — quoted from the
specimen. A whole-screen scan for that string would classify **this** healthy,
working session as errored and fire a retry into it. The hazard is not
hypothetical; it reproduced during the research for this design.

And the harder problem: the error line **scrolls away**. In the specimen the
human answered 3h22m later, by which time any amount of output could have pushed
it off screen. A detector that can only see the visible pane is a detector with
a short memory for a state that can last hours.

### 2.2 The primary signal: the transcript tail

**Rule.** A session is `errored` when the last *semantically meaningful* record
in its transcript is an error record for the main conversation:

```ts
// ILLUSTRATIVE — not implemented.
interface TranscriptError {
  /** The CLI's own class: "server_error" | "rate_limit" | "authentication_failed" | other. */
  kind: string;
  /** Human text, e.g. "API Error: 529 Overloaded. …". */
  text: string;
  /** Record uuid — the stable identity of this error EPISODE. */
  uuid: string;
  at: Date;
}

/** The tail error, or null when the session's last act was anything else. */
function tailError(records: Record<string, unknown>[]): TranscriptError | null;
```

"Semantically meaningful" excludes the bookkeeping records the CLI appends
*after* the error, observed directly following it in every specimen:

* `{"type":"system","subtype":"turn_duration"}` — the turn's own epitaph;
* `{"type":"system","subtype":"informational"}` — the CLI's own notices;
* `{"type":"file-history-snapshot"}` — no timestamp, not conversation;
* `{"type":"last-prompt"}` — a cursor, not an event.

Anything else after the error record — an `assistant`, `user`, `attachment` or
`queue-operation` record — means the session **moved on**, and there is no error
state to recover.

This satisfies the "not from scrollback" constraint in its true sense. The
objection to scrollback was never "files are bad"; it was that *scanning a
region that holds history and treating a hit as current state is wrong*. Reading
the **tail** of an append-only log is the strictest possible positional read:
the last record is, by construction, the current state. And unlike the pane it
does not scroll, does not wrap, does not depend on terminal width, and cannot be
faked by a session that merely talks about an error — quoted prose lands in an
ordinary text record with no `isApiErrorMessage` flag.

### 2.3 The pane's role: permission, not evidence

The transcript says *what state the session is in*. The pane says *whether it is
safe to type into it right now*. Both are required, and neither substitutes for
the other. Mirroring `paneResumeSafe`:

```ts
// ILLUSTRATIVE — not implemented.
function paneRetrySafe(raw: string, cursor?: PaneCursor | null): boolean {
  if (paneResumeDialogActive(raw)) return false;   // hasn't started; answer that first
  if (paneUsageLimited(raw)) return false;         // limited owns this pane
  if (isDialog(raw)) return false;                 // a question for a human
  return paneReadiness(raw, cursor) === "ready";   // empty box, nothing running
}
```

The `isDialog` clause is the direct answer to hazard #2's "a tool or permission
prompt the agent is waiting on". If the pane is showing a dialog, we do not type
into it, full stop — whatever the transcript says.

### 2.4 An advisory pane-side mirror, for display only

For providers with no structured transcript, and for the `errored` badge on a
session agendo cannot read a transcript for, a pane-side detector is possible
using the *exact* technique `paneUsageLimited` already uses — the last content
block above the input box, skipping chrome:

```ts
// ILLUSTRATIVE — not implemented. Advisory only: never fires a retry.
const PANE_ERROR_RE = /^●?\s*API Error:|^●?\s*Login expired\b|^●?\s*Not logged in\b/im;

function paneErrored(raw: string): boolean {
  // same shape as paneUsageLimited: rules → blockAbove(…, isPaneChrome | taskPanel)
  // → match the block, never the whole screen.
}
```

This works because `isSpinnerSummary` already treats `✻ Worked for 1h 48m 20s`
as chrome, so in the specimen the `● API Error: …` line *is* the last content
block. It is nonetheless **display-only**: it inherits every known limit of
`blockAbove` (a transcript butting straight against the box, a wrapped line on a
narrow pane) and its failure mode here would cost money rather than a wrong
label. **No auto-retry ever fires on this signal.**

### 2.5 Which direction each ambiguity fails

The existing bias — *a false "not ready" that blocks a send costs less than a
false "ready" that pastes into a live turn* — **holds here, and harder.** The
cost of a false positive has gone up: it is no longer a clobbered input line, it
is a spent turn plus a possible duplicated side effect (a second push, a second
PR). The cost of a false negative is unchanged from today: a human types `retry`,
exactly as they do now. So every ambiguity resolves toward **not retrying**:

| Ambiguity | Resolution | Why |
|---|---|---|
| Transcript unreadable / unparseable | not errored | absence of evidence, per `isStalled`'s rule |
| Tail record type unrecognised | not errored | an unknown record may mean the session moved on |
| `error` value unrecognised (a new class) | detected as `errored`, **not** retried | a class we have never seen is not one we can claim is transient |
| Pane unreadable (`readiness === null`) | no retry | same rule `isStalled` uses |
| Pane reads `busy` | no retry | see the background-agent case below |
| Pane shows any dialog | no retry | it is a question for a human |
| Error record < `RETRY_FLOOR_MS` old | no retry | do not race the CLI's own write, or a human already reaching for the keyboard |
| Sidechain / `agent-*.jsonl` | never | the CLI recovers these itself |

### 2.6 The background-agent case, stated honestly

In the specimen the main turn died while a background agent was still running.
The sub-agent panel renders *below* the input box, inside `liveStatusLines`'
below-the-box band, so the pane reads **`busy`** — and the retry will not fire
until that background agent finishes. This is the safe direction (we never
interrupt live work), but it is a real limitation: recovery is delayed by
however long the orphaned background agent runs. Worth stating in the release
notes rather than discovering in the field.

### 2.7 Cost

Transcripts run to megabytes (the specimen is 2.5 MB), and the readiness poll is
per-session and frequent. Detection must be cheap:

* Only for **live** sessions whose pane already reads settled — the same gate
  `isStalled` applies.
* Only when the transcript's `mtime` has **changed** since the last check.
  `sessions.ts` already stats every transcript each scan and caches on
  `(mtimeMs, size)`; the same key works here.
* Read the **last 64 KiB** only, discard the first partial line, parse backwards
  and stop at the first meaningful record. Typical cost: one seek and one
  `JSON.parse`.
* Only when the session has been settled for at least `RETRY_FLOOR_MS` (§3.4).

---

## 3. Retry policy

### 3.1 What an "episode" is

An **episode** is identified by the `uuid` of the error record at the tail. It is
stable, unique, and generated by the CLI. All bookkeeping is keyed on it, exactly
as auto-resume keys `resumeFired` on the frozen `resetAt`.

An episode ends — and its attempt counter is discarded — when the transcript
grows past that record, i.e. the session produced *any* meaningful record after
it. That is the only honest "recovered" signal. Deliberately **not** used as a
reset: elapsed time (a session can be dead for a day), readiness flapping (a
blank capture must not hand out fresh attempts), or a `list`/`status` refresh.

### 3.2 Attempts: 3

The initial failure is not agendo's attempt — the CLI already burned its own
in-process retries before writing the record. Three agendo nudges therefore cost
at most three additional turn-starts.

Why not more: the observed population is 9 main-session `server_error` events in
26 days on this machine. If three spaced attempts across ~40 minutes do not
recover a session, the cause is not the sort of transient that a fourth would
fix, and each further attempt is a guaranteed spend against a diminishing
probability. Why not fewer: the observed incidents *do* recur within minutes
(below), so a single attempt fired inside an ongoing incident would fail for a
reason a later one would not.

### 3.3 Backoff: base 120 s, factor 4, ±25 % jitter, cap 32 min

Delays: **≈2 min → ≈8 min → ≈32 min**, jittered.

*Why the first wait is minutes, not seconds.* Two measurements from the real
error timeline:

```
2026-08-17T10:28:14Z  3398c8bc  API Error: 529 Overloaded…
2026-08-17T10:31:46Z  3398c8bc  API Error: 529 Overloaded…   (+3m32s — retried, failed again)
```

A retry 3½ minutes into a 529 incident still hit an overloaded backend. A retry
at 10 seconds would be certain to. And because the CLI has already exhausted its
own fast retries, the seconds-scale band is *known* to be empty of value here —
it has been tried, by the CLI, immediately before the record was written.

*Why factor 4 rather than the factor 2 used in `errors.ts`.* `retryDelayMs`
doubles from 1 s for network calls to Azure DevOps, where the whole loop must fit
inside a UI refresh. Here the constraint is inverted: three attempts must span
*longer than a provider incident*. Factor 2 from 2 min gives 2+4+8 = 14 min of
coverage — inside the window of the incident measured below. Factor 4 gives
2+8+32 ≈ 42 min for the same three attempts and the same worst-case spend.

*Why jitter, specifically ±25 %.* Provider incidents hit multiple sessions at
once:

```
2026-08-18T16:56:10Z  c9e9c0fe  API Error: 529 Overloaded…
2026-08-18T17:02:25Z  e1dcf6a6  API Error: 529 Overloaded…   (+6m15s, a different repo)
```

agendo polls all sessions on one timer. Without jitter, every session that
errored inside one poll tick would fire its retry at the same instant — N
simultaneous turns into a backend that is already overloaded, which is both the
least likely moment to succeed and the least considerate. Jitter here is
decorrelation, not politeness. ±25 % is enough to spread a handful of sessions
across tens of seconds without materially changing any one session's schedule.

*Why the 32-minute cap.* It is the third delay, so the cap binds only if the
numbers are reconfigured upward. It exists so a hand-edited `factor: 10` cannot
produce a wait measured in hours that looks like a hang.

### 3.4 The floor: `RETRY_FLOOR_MS = 45 s`

No retry fires until the error record is at least 45 seconds old. Two reasons:
it avoids racing a transcript write the CLI has not finished, and it leaves a
human who is *looking at the session right now* time to type `retry` themselves
before a machine does it for them.

### 3.5 Cross-session circuit breaker (recommended; see §7)

Because incidents are provider-wide, a per-session policy alone can still fan
out: ten managed sessions × three attempts = thirty turns into one outage.
Proposed: if **≥3 distinct sessions** are in an open episode within a rolling
**10-minute** window, treat it as an incident — hold every session at its
longest delay and surface one line saying so, rather than each session
discovering the outage independently. The numbers are a starting point, not a
measurement; §7 asks the owner whether this belongs in v1 at all.

### 3.6 Exhaustion, and how the user finds out

When the attempts are spent the session is **not** retried again for that
episode. It becomes visibly `errored` — a **qualifier**, in the exact sense
`stalled` is one, never a new `Readiness`:

* `agendo list` / `agendo status`: an `errored` marker next to the session, with
  the class, the attempt count, and the error text. Where a session is both
  `errored` and `stalled`, **`errored` wins the display** — it is the more
  specific verdict and it names a cause.
* `agendo list --json` / `status --json`: an `error` object —
  `{ kind, text, at, attempts, exhausted }` — so an orchestrator can act on it.
* `agendo wait`: see §5.2.
* `agendo retry <id> [--force]`: the manual escape hatch, modelled on `unblock`.
  It refuses unless the session is actually errored (overridable with `--force`),
  sends one nudge, and **resets the counter** — a human deciding to try again is
  new information.

---

## 4. What message to send

### 4.1 Not `retry`, and not `continue`

* **`retry`** means "do that again". For a turn that died *after* a commit
  landed but *before* it was reported, "do that again" is the instruction that
  causes the double push. It is the wrong verb precisely when it matters most.
* **`continue`** implies the previous turn's state is known and intact. `The
  response above may be incomplete` is the CLI explicitly saying it is not.
  (`continue` is also already spoken for: it is the literal text `resumeKeystrokes`
  types for the usage-limit resume. Reusing it here would make the two features
  indistinguishable in a transcript.)
* **"are you done?"** — the phrasing the owner explicitly rejected — is worse
  than either: it is a question, so a session that *is* done answers it, costing
  a turn to learn nothing agendo did not already know.

### 4.2 The proposed message

There is strong prior art on this machine: the owner's own orchestrator already
writes recovery prompts by hand, and they are careful in exactly the right way.
Verbatim, from `agent-a28252…jsonl`:

> You were terminated by a transient server-side 529, not by anything you did
> wrong. Your last note was "Red captured. Now the real implementation."
>
> Resume exactly where you left off. Before continuing, re-check the working tree
> (with Read/Grep — still no `git` commands) to see what you had already written,
> so you don't duplicate or clobber your own work.

and from `agent-a5aee1…jsonl`:

> Your previous turn died on a transient API 529 before returning a verdict.
> Please redo review round 5. The tree is clean and the work is committed as
> `d8e0c72`, so nothing is half-done.

Both do three things: name the cause and absolve the agent, order a state check
*before* any action, and say explicitly what must not be repeated. The proposed
template generalises them to what agendo actually knows:

```
Your previous turn was stopped by a transient API error, not by anything you or
the task did wrong:

  <the CLI's own error text, verbatim>

agendo is restarting it automatically (attempt <n> of <m>). Nobody has looked at
this session since it stopped.

Before you do anything else, work out where the work ACTUALLY is. The turn may
have been cut off after an action took effect but before it was reported, so the
last thing you remember saying is not proof of the last thing you did. Check the
working tree, the git log, and whether the step you were about to take has
already happened.

Do not repeat a completed step. In particular do not re-run a migration, re-push
a branch, or re-open a pull request that already exists.

Then carry on from wherever the work really is.
```

Notes on specific choices:

* **The error text is quoted verbatim**, not paraphrased. The agent can tell
  `529 Overloaded` (nothing was sent) from `Connection lost mid-response` (output
  was partial) better than agendo can, and it has the conversation in front of it.
* **"attempt n of m"** is deliberate. An agent that has been restarted twice
  should know that, and may reasonably choose to checkpoint more aggressively —
  which is exactly what the owner's own hand-written recovery did ("Work in
  checkpointable slices. This task has now lost one agent mid-run.").
* **"Nobody has looked at this session"** stops the agent addressing a report to
  a human who is not there.
* agendo deliberately **does not name a commit or a branch state**. The
  orchestrator's messages could ("the tree is clean, committed as `d8e0c72`")
  because a human had checked. agendo has not checked and must not imply it has.

### 4.3 Delivery route: socket first

`send` already knows how to do this. Prefer the peer socket (`src/peer.ts`),
falling back to the tmux pane, honouring `peerSocketEnabled()` in both
directions. Three reasons, one of them decisive:

1. **A socket frame is queued, not typed.** It cannot clobber a draft, cannot
   land in a menu, cannot arrive mid-paint.
2. **It is addressed by `session_id`**, which the receiver validates — a
   recycled pid cannot misdeliver a recovery prompt into someone else's session.
3. **Decisive:** `peer.ts` documents that a peer frame "will NOT be accepted as
   an answer to a pending permission prompt". That is normally a limitation. Here
   it is a safety property: **if agendo has misjudged and the session is actually
   waiting on a dialog, the frame queues harmlessly instead of answering it
   blindly.** It converts hazard #2's worst case from "answered a permission
   prompt at random" into "the message waits until a human answers".

The framing is honest too: the receiver renders it as "Another Claude session
sent a message", which is exactly what it is. It is not the user speaking, and
it should not pretend to be.

When the socket is unavailable (Copilot, older builds, `peerSocket: false`), the
pane path applies with its full, unmodified readiness gate plus `paneRetrySafe`.

---

## 5. Interaction with existing behaviour

### 5.1 `stalled` (#26)

`stalled` says "this session has been settled for N hours; go and look". Error
retry answers *why* for one specific cause. They are complementary and must stay
separate:

* `isStalled` is **not modified**. Its contract ("a prompt to go look, not a
  verdict") is deliberately weak, and the error qualifier is a stronger claim
  computed elsewhere.
* An errored session will also become stalled once it crosses the 4-hour
  threshold — the specimen would have, at 3h22m, only just. Display precedence:
  **`errored` over `stalled`**.
* Practically, error-retry *shrinks* the stalled population by recovering its
  most recoverable member automatically.

### 5.2 `wait`

This one needs a decision, and there is a clean precedent to follow.

Today an errored session reads `ready` → `isSettledReadiness` returns true →
`wait` exits 0 and tells an orchestrator the session **finished**. That is
already wrong, before this feature exists. It is exactly the reasoning
`NOT_SETTLED` applies to `limited`: *"it has stopped, but it is not DONE"* —
`wait` wakes on a capped target with `woke: "blocked"` and a non-zero exit rather
than claiming success.

An errored session is the same case. Recommendation:

* `wait --json` reports `errored: { kind, text, attempts }`.
* The default predicate wakes with `woke: "errored"` and a distinct non-zero
  exit code, mirroring `woke: "blocked"`.
* `--state errored` becomes an explicit success condition, as `--state limited`
  is for the cap.

Mechanically this cannot go through `NOT_SETTLED`: that set is keyed on
`Readiness`, and `errored` is a qualifier, not a readiness. It has to be threaded
into `wait` as its own input, alongside the `resumeDialog` flag `wait` already
carries for the same "the pane lies about this one" reason. **This is a
behaviour change for existing orchestrators and is raised in §7.**

### 5.3 Usage-limit auto-resume

The ownership split, stated as a contract:

| | owns | signal | action |
|---|---|---|---|
| auto-resume-on-limit | `rate_limit` | `paneUsageLimited` + `paneResetAt` | `<esc>continue<enter>` at the reset instant |
| error retry | `server_error` | transcript tail `error` field | one recovery message, backed off |
| neither | `authentication_failed`, unknown classes | transcript tail | surface, never nudge |

They cannot collide, because the classes are disjoint **in the CLI's own field**,
not merely in agendo's heuristics. Two belt-and-braces rules make that structural
rather than incidental:

1. `paneRetrySafe` returns false when `paneUsageLimited(raw)` — if the pane is
   at the cap, the cap's machinery owns it, whatever the transcript tail says.
2. The retry gate requires the tail `error` to be exactly `server_error`. A
   `rate_limit` tail is invisible to it.

An episode that transitions (a session errors, then a retry hits the cap) hands
over cleanly: the tail record becomes `rate_limit`, the retry episode's uuid is
no longer at the tail, the counter is discarded, and auto-resume takes it from
there.

### 5.4 `send`'s readiness gate

Unchanged. The retry is an ordinary `send` with an extra pre-gate
(`paneRetrySafe`), not a new delivery mechanism. It must not acquire a
`--force`-like bypass: the whole design rests on refusing to type into anything
uncertain.

### 5.5 The peer socket

See §4.3. Two further consequences:

* A session reachable **only** over the socket (running outside tmux) has no
  pane to gate on. Recommendation for v1: **do not auto-retry windowless
  sessions.** The transcript can say `errored` and `list --json` can report it,
  but with no pane there is no way to confirm no dialog is open, and the whole
  policy is built on that confirmation. Raised in §7.
* If `peerSocket` is disabled (config or `AGENDO_PEER_SOCKET`), retry falls back
  to the pane and must respect the same kill switch — a user who turned the
  socket off has not opted into a new feature using it.

---

## 6. Configuration

Two existing shapes, used for the two different kinds of setting they are for.

### 6.1 The on/off switch — `LauncherState` + env, default **OFF**

Follows `autoResumeOnUsageLimit` exactly: a runtime toggle on the Settings page,
persisted in `~/.agendo/state.json`.

```ts
// src/config.ts — ILLUSTRATIVE
export interface LauncherState {
  // …
  /**
   * When true, a live session whose transcript tail is a retryable API error is
   * automatically nudged to resume, with backoff. Default OFF. See docs/error-retry.md.
   */
  autoRetryOnError?: boolean;
}
```

Plus an env override copying `peerSocketEnabled`'s semantics **verbatim** —
recognised in both directions, empty value counts as unset, and an
**unrecognised value disables and says so**:

```ts
export const AUTO_RETRY_ENV = "AGENDO_AUTO_RETRY";
export function autoRetryEnabled(s = loadState()): { enabled: boolean; source: "env" | "state"; note?: string };
```

The asymmetry is inherited for the same reason: this is the kill switch, and a
kill switch that fails open on a typo is not one. Someone setting
`AGENDO_AUTO_RETRY` mid-incident is trying to stop something.

**Why default OFF**, in full:

* It **spends money with no human in the loop**. `autoResumeOnUsageLimit`
  defaults off for a weaker reason than this — resuming at the cap spends quota
  the user has already decided to spend on that session. A retry spends it on a
  turn that may re-do work.
* Its worst case is **not** a wasted turn; it is a **repeated side effect**
  (§1.7). Any feature whose failure mode can push a branch twice has to be opted
  into deliberately.
* The most common error class (`rate_limit`, 145 of 174) is **already handled**,
  increasingly by the CLI itself. Defaulting on would buy little and risk much.
* It is a new detector against an **undocumented, internal transcript format**.
  The `isApiErrorMessage` / `error` fields are not a public contract; a rename
  would silently disable detection (safe) — but a *reuse* of those field names
  for something else would not be. Off-by-default keeps the blast radius to users
  who asked for it.

`peerSocket` defaults *on* by contrast, and correctly: it makes an existing
operation strictly better and takes no independent action. This one takes action.

### 6.2 The numbers — `config.json`

Follows `stalledAfterMinutes` / `resumeDialogChoice`: durable, hand-edited,
malformed values **ignored in favour of the default** (not obeyed, not fatal).

```jsonc
// ~/.agendo/config.json — ILLUSTRATIVE
{
  "errorRetry": {
    "attempts": 3,          // agendo nudges per episode (the CLI's own retries are already spent)
    "baseSeconds": 120,     // first delay
    "factor": 4,            // 2m → 8m → 32m
    "maxSeconds": 1920,     // 32m cap
    "jitterPercent": 25,
    "floorSeconds": 45      // minimum age of the error record before acting
  }
}
```

Note the deliberate split from `AGENDO_RETRY_ATTEMPTS` / `AGENDO_RETRY_BASE_MS`
in `errors.ts`: those tune agendo's *own* HTTP calls to Azure DevOps and GitHub,
and the e2e suite drives them to zero to avoid real-time waits. Sharing them
would mean a test that disables ADO backoff also silently rewrites the agent
recovery policy. Different purpose, different knobs — but the same *shape*, so
the e2e suite can drive these to zero the same way.

---

## 7. Open questions for the owner

Genuine decisions, not rhetorical ones.

1. **Should `wait` stop reporting an errored session as finished?** (§5.2) The
   principled answer is yes — it is the same case as `limited`, which already
   wakes with `woke: "blocked"` and a non-zero exit. But it is a **breaking
   change** for any orchestrator currently treating `wait` exit 0 as "done", and
   it changes behaviour even for users who never enable auto-retry. Ship it with
   the feature, behind the feature flag, or as its own change?

2. **Should the cross-session circuit breaker be in v1?** (§3.5) It is the
   difference between "three retries per session" and "three retries per session
   × every session you are running" during a provider outage. It is also the most
   speculative part of this design — the thresholds are not measured, and it adds
   global state where everything else is per-session.

3. **Should windowless (socket-only) sessions be auto-retried?** (§5.5) The
   recommendation is no, because the dialog check needs a pane. That means a
   session running outside tmux gets detection but not recovery. Acceptable, or
   should the socket's own queueing behaviour be considered gate enough?

4. **Should `authentication_failed` do anything beyond surfacing?** It is the one
   class where agendo *could* act usefully without spending a turn — e.g. surface
   "run /login" prominently, or send a push notification. Out of scope as
   written; say if it should not be.

5. **Should the recovery message be user-overridable?** A `config.json` string
   would let the owner tune the wording (his hand-written ones are better than
   the template, because he knows the project). The risk is a custom message that
   drops the idempotency warning — which is the only mitigation that exists for
   §1.7. Offer it with the warning text appended unconditionally, offer it fully
   free-form, or not at all?

6. **Should the CLI's own rate-limit auto-continue retire agendo's?** (§1.3)
   Claude 2.1.235 now prints `continuing automatically at 7pm` and re-prompts
   itself. If that is reliable, `autoResumeOnUsageLimit` is at best redundant and
   at worst a second, competing nudge. Worth its own issue and its own
   measurement — flagged here, not decided here.

7. **Codex and Copilot.** (§1.7) v1 is claude-only. Is a pane-only, best-effort
   detector for the others worth having, given it can only ever be advisory?

---

## 8. Implementation plan

No code exists yet. This is the order a later session should execute in. Each
phase is independently shippable and independently testable.

### Phase 0 — prerequisite

Wait for the `src/tmux.ts` / `src/index.tsx` / `src/ui/App.tsx` refactor to land.
Phases 3 and 4 touch two of those three files directly.

### Phase 1 — `src/transcriptError.ts` (new module, pure, no I/O in the core)

The whole taxonomy and the tail rule, as pure functions over parsed records.
Nothing here touches tmux, so it is fully unit-testable from fixtures.

* `RETRYABLE_ERROR_KINDS = new Set(["server_error"])`
* `MEANINGLESS_TAIL_TYPES` — the `turn_duration` / `informational` /
  `file-history-snapshot` / `last-prompt` skip set (§2.2)
* `tailError(records): TranscriptError | null` — skips the bookkeeping tail,
  rejects `isSidechain`, returns the CLI's `error` value unmodified
* `isRetryableError(e): boolean`
* `readTranscriptTail(path, bytes = 65536): Promise<Record<string, unknown>[]>` —
  the only I/O; discards the leading partial line

**Tests** (`e2e/transcript-error.spec.ts`, new):
* one fixture per class, taken verbatim from the records quoted in §1
* the specimen tail: error → `turn_duration` → `file-history-snapshot` →
  `user "retry"` — must read **not errored** (the session moved on)
* the same tail truncated before the `user` record — must read **errored**
* `isSidechain: true` → null
* an `assistant` record whose text merely *quotes* `API Error: …`, with no
  `isApiErrorMessage` flag → null (the quoting hazard, §2.1)
* an unknown `error` value → detected, not retryable
* a truncated final line (mid-write) → ignored, not fatal
* a 64 KiB read that begins mid-record → leading partial discarded

### Phase 2 — `src/errorRetry.ts` (new module, pure decision + config)

Mirrors `usageLimit.ts`'s split: pure predicates, injected clock, no side effects.

* `RetryEpisode { uuid, kind, attempts, nextAt }`
* `shouldRetry(input): boolean` — enabled, tail error is retryable, pane safe,
  age ≥ floor, attempts remaining, `now >= nextAt`
* `retryDelayMs(attempt, cfg, rand)` — base × factor^(n−1), jittered, capped;
  `rand` injected so tests are deterministic
* `retryMessage(err, attempt, attempts): string` — the §4.2 template
* `resolveErrorRetryConfig()` in `config.ts`, ignoring malformed values
* `autoRetryEnabled()` in `config.ts`, copying `peerSocketEnabled` semantics

**Tests** (`e2e/error-retry.spec.ts`, new): every `shouldRetry` gate
independently; the delay ladder with `rand` pinned to 0 / 0.5 / 1; the cap; the
floor; attempts exhausted; a `rate_limit` tail never retried; malformed config →
defaults; `AGENDO_AUTO_RETRY` in both directions and its unrecognised-value
refusal.

### Phase 3 — `paneRetrySafe` in `src/tmux.ts`

Small, and deliberately last among the detection pieces so it is written against
tests that already exist.

* `paneRetrySafe(raw, cursor)` per §2.3
* optional, advisory `paneErrored(raw)` per §2.4 — **only** if §7 Q7 says yes

**Tests** (added to `e2e/detection.spec.ts`, where this class of test lives):
reuse the existing fixtures — `limit-dialog-menu.ansi` and `limit-esc-revealed.ansi`
must both be refused; `ghost-suggestion.ansi` must still count as ready;
`busy-quoted-marker.ansi` must be refused. Add an `errored-idle.ansi` fixture
reconstructed from the §0 specimen (`● API Error: …` → `✻ Worked for 1h 48m 20s`
→ empty box).

### Phase 4 — wiring

Two consumers, sharing all the logic above:

1. **`agendo retry <id> [--force]`** in `index.tsx`, modelled line-for-line on
   `runUnblock`: resolve the target, refuse unless actually errored, send one
   message, reset the counter, name the route. Ship this **first** — it is the
   manual version of the feature, it is useful on its own, and it exercises the
   whole stack with a human deciding each fire.
2. **The automatic path** in `App.tsx`'s readiness poll, alongside the existing
   auto-resume block and on the same cadence and the same fresh capture.
   Bookkeeping mirrors `limitWindows` / `resumeFired` / `dialogRevealed`: a
   `retryEpisodes: Map<canon, RetryEpisode>` ref, pruned when a window vanishes,
   **not** reset by the local rescan (the same comment that guards
   `resumeFired` applies verbatim).

**Tests**: `e2e/cli.spec.ts` for `agendo retry` (usage, refusal, `--force`,
exit codes); the App-level poll follows whatever pattern the auto-resume poll
uses after the refactor.

### Phase 5 — surfacing

* `errored` qualifier in `list` / `status`, with `errored` taking display
  precedence over `stalled` (§5.1)
* `error: { kind, text, at, attempts, exhausted }` in `list --json` /
  `status --json`
* `wait` — **pending §7 Q1**
* README: one line under the existing feature list, linking here

### Phase 6 — optional, pending §7 Q2

The cross-session circuit breaker. Its own module, its own state, its own tests.
Deliberately last: everything above is useful without it.

---

## Appendix: how the specimens were gathered

All read-only, on this machine, on 2026-08-20.

```bash
# the pane specimen (read-only; nothing was sent to this session)
tmux capture-pane -p -t '=agendo-pc-to-phone-audio:3'

# the population: every error record in every transcript
grep -rh --include='*.jsonl' '"isApiErrorMessage":true' ~/.claude/projects/

# the classification and the timeline were derived from those records'
# `error`, `isSidechain` and `timestamp` fields.
```

No session was interrupted, messaged, or deliberately broken to produce an error.
Every quoted error text and every timestamp in this document is from a real
failure that happened on its own.

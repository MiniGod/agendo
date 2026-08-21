# Codex usage-limit detection

## Problem

agendo already classifies a Claude Code pane that has hit its cap as `limited`
(`src/usageLimit.ts`, `paneUsageLimited` in `src/tmux.ts`). Codex has the same
failure mode and **none** of the detection, so a capped Codex session reads as
`ready` and `agendo send` pastes into it.

Captured live on 2026-08-20 from a real `codex resume` of a capped account
(codex v0.148.0, `gpt-5.6-sol high`, pane 383x96). Five states, in the order a
real resume produces them, all committed as fixtures under `e2e/fixtures/`:

| Fixture | State |
|---|---|
| `codex-trust` | codex's own folder-trust prompt |
| `codex-resume-cwd` | codex's own "which working directory?" resume prompt |
| `codex-limit-idle` | capped, idle at the input box — **the main one** |
| `codex-limit-model-switch` | capped, message sent, model-switch dialog raised |
| `codex-limit-dismissed` | dialog dismissed with Esc, back to capped-idle |

Measured against the code as it stands today (`paneReadiness`,
`paneAcceptsPaste`, `paneUsageLimited`):

| Fixture | `paneReadiness` | `paneAcceptsPaste` | `paneUsageLimited` |
|---|---|---|---|
| `codex-limit-idle` | `ready` ❌ | **`true`** ❌ | `false` ❌ |
| `codex-limit-dismissed` | `ready` ❌ | **`true`** ❌ | `false` ❌ |
| `codex-limit-model-switch` | `dialog` | `false` ✅ | `false` ❌ |
| `codex-trust` | `dialog` | `false` ✅ | `false` ✅ |
| `codex-resume-cwd` | `dialog` | `false` ✅ | `false` ✅ |

Two of the five say a capped session is safe to paste into. That is the bug.

## Why this is not a one-line regex

### 1. The footer lies

In `codex-limit-idle` the status bar reads:

```
gpt-5.6-sol high · ~/git/agendo · Ready · Approve for me · Context 11% used · weekly 0% left · 258K window · 38.7K used · 315K in · 4.79K out
```

Codex says **`Ready`** while the account is capped. `codexReadiness` returns
`ready` on the positive evidence of that field (deliberately — see its doc
comment), so the run-state field alone can never see this state.

### 2. The same line carries the truth

That footer also says **`weekly 0% left`**. It is a live, positional field of
codex's own status bar — the correct place to read from, by the same argument as
`liveStatusLines` / `codexLiveStatus` (#33): the transcript above the box is
history, the footer is now.

Every healthy codex fixture in the repo carries the same field with a healthy
value, which is what makes it a discriminator rather than a marker:

```
codex-idle           …· Ready   · Approve for me · weekly 99% left
codex-draft          …· Ready   · Approve for me · weekly 99% left
codex-busy           …· Working · … · weekly 95% left · …
codex-busy-approval  …· Working · … · weekly 99% left · …
codex-done           …· Ready   · … · weekly 95% left · …
codex-limit-idle     …· Ready   · … · weekly  0% left · …   ← capped
codex-limit-dismissed…· Ready   · … · weekly  0% left · …   ← capped
```

**It is the DISAGREEMENT between two fields on one line that identifies the
state**: run-state `Ready` next to a quota field reading `0% left`.

Colour is no help: codex paints `weekly 0% left` and `weekly 99% left` in the
same pink (`38;2;233;144;169`), so the SGR run carries no signal the text does
not, and the value has to be read.

### 3. The reset time is a wall-clock time of day, not a countdown

Codex's notice says `try again at 1:22 PM`. Claude's says `5h: 100% (1m)` —
a countdown. `parseResetTime` is anchored on the word `reset`
(`/\breset[s]?(?:[^\S\n]+(?:by|at))?[^\S\n]+([^\n]*)/i`), which codex's wording
never contains, so today it returns `null` for the codex notice.

Converting `1:22 PM` to an instant needs a date and a timezone, and it can
already be in the past — it was in this very capture, taken at 10:14 the
following morning with the previous day's notice still on screen. Whatever maps
this to `limitResetAt` must handle "already past" without reporting a live limit
forever. `BARE_TIME_LOOKBACK_MS` already exists for exactly this hazard on the
claude side and applies unchanged here: a bare clock time more than 6h in the
past rolls forward to tomorrow rather than reading as "act now".

### 4. The notice is transcript, not status

```
■ You've hit your usage limit. Upgrade to Pro (…), visit … to purchase more credits or try again at 1:22 PM.
```

That line **scrolls**. Once it leaves the screen, `weekly 0% left` is the only
evidence left. Detection must not depend on the notice being visible — and,
symmetrically, must not keep reporting `limited` because a stale notice is still
visible after the quota recovered.

## The safety point that matters most

In `codex-limit-model-switch`, sending a message to a capped codex session
leaves it sitting in a **numbered menu**:

```
  Approaching rate limits
  Switch to gpt-5.6-luna for lower credit usage?

› 1. Switch to gpt-5.6-luna                 Fast and affordable agentic coding model.
  2. Keep current model
  3. Keep current model (never show again)  Hide future rate limit reminders about switching models.

  Press enter to confirm or esc to go back
```

`sendToPane` is keystroke injection followed by Enter. A message containing a
digit would switch the user's model, and option 3 **permanently** suppresses
future rate-limit warnings. This is the same footgun documented for claude's
resume dialog (`paneResumeMenuSuspect`).

So the ordering requirement is: **03/04/05 must classify as `limited` before
anything decides the pane is safe to paste into.** Today `paneAcceptsPaste`
returns `true` for 03 and 05, i.e. `send` delivers straight into a capped
session; only 04's incidental `isDialog` match keeps the menu safe, and that is
luck, not detection.

Also note codex's selection marker is `›` (U+203A), **not** claude's `❯` — the
same glyph codex uses for its input-box prompt, which `codexInputBox` already
has to disambiguate by position.

## Intended behaviour

### Classification

1. **`codex-limit-idle` and `codex-limit-dismissed` classify as `limited`,** on
   the footer quota field, not on the notice. `paneUsageLimited` is `true`,
   `paneReadiness` is `limited`, `paneAcceptsPaste` is `false`.
2. **`codex-limit-model-switch` classifies as `limited`** and is never
   paste-safe. `dialog` is an acceptable secondary reading, but `ready` and
   `unknown` are not, and `paneAcceptsPaste` must stay `false`.
3. **A healthy idle codex pane still classifies as `ready`.** `codex-idle` has
   `weekly 99% left`; the fix must not turn the mere presence of a quota field
   into a cap.
4. **`codex-trust` and `codex-resume-cwd` are the CLI's own prompts, not agent
   questions.** Nothing is waiting on a human decision about the *work*; codex
   is asking how to start. Two consequences:
   - they are never `ready` and never paste-safe (already true today), and
   - everything above them is the **previous** run's replayed transcript. A limit
     notice replayed there must not read as the current state — the codex
     analogue of `paneResumeDialogActive`'s reason for existing (#30). Today a
     resume-cwd prompt with a replayed notice above it reads `limited`, which
     would make `agendo status` print a stale reset time and `agendo wait` never
     settle.

### Which signal is authoritative

The **footer quota field** decides whether the limit is live. The **notice**
supplies the reset time and nothing else.

- Footer `weekly 0% left` present → `limited`, notice on screen or not.
- Footer quota healthy (`weekly 96% left`) → not limited, even with the notice
  still sitting in scrollback.
- No footer at all (`codex-limit-model-switch` — the dialog replaces it) → fall
  back to the dialog's own durable wording plus the notice. This is the one
  state where the notice is load-bearing, because the field it would rather read
  is not on screen.

That last point has a structural consequence: `codexPane` is anchored on the
footer status bar (`codexFooter` rejects a last line with fewer than two ` · `
fields), so `codex-limit-model-switch` is **not recognised as a codex pane at
all** and falls through to the claude classifier. Codex limit detection
therefore cannot live only inside `codexReadiness`.

### Precedence

`codexReadiness` checks `isDialog` first, then busy, then the run-state field.
The limit check must sit **above the dialog check** (so 04 reads `limited`, not
just `dialog`) and **above the `Ready` read** (so 03/05 stop reading `ready`),
while staying **below busy** — a session that is generating again is busy,
whatever a stale quota field says. That mirrors the claude path, where
`paneUsageLimited` is checked after busy and before `isDialog`.

### Reset time

`parseResetTime` grows a codex arm: `try again at <time>` alongside the existing
`reset(s) at/by <time>` anchor, scoped to the text at/after the usage-limit
phrase exactly as today so a stray clock time in scrollback cannot hijack it.
The existing `BARE_TIME_LOOKBACK_MS` cap applies unchanged.

Codex states no timezone, so the notice's time is read in local time — the same
assumption the claude path already makes when the parenthesised IANA zone is
absent, and safe for same-machine resume.

**Already-past resets.** A parsed instant in the recent past is returned as-is
(the window has reopened; act now). One more than `BARE_TIME_LOOKBACK_MS` in the
past rolls forward to tomorrow. Neither case may produce an indefinite live
limit: because the *footer* is authoritative for liveness, a pane whose quota
field has recovered reads `ready` regardless of what the lingering notice says
about a time that has long since passed.

### Auto-resume

Out of scope for the first implementation round. `shouldAutoResume` requires
`readiness === "limited"` and a non-null `resetAt`, both of which this work
provides, so it becomes reachable for codex — but the resume keystrokes
(`resumeKeystrokes`: Escape, then `continue`, then Enter) are shaped for
claude's TUI and have never been fired at codex. In particular Escape at
`codex-limit-model-switch` is that dialog's own "esc to go back", and
`paneResumeSafe` must keep returning `false` for every codex fixture here until
a resume path has been verified against a live codex pane.

## What is NOT captured, and why it matters

The capture came from one account, one cap, one moment. Four gaps, each of which
the implementation should treat as a known unknown rather than as settled:

- **A genuinely busy codex pane at a cap.** Needed for the negative case on the
  precedence rule above: busy must outrank a stale quota reading. Today the
  ordering is argued from the claude path's shape, not from a capture.
- **A healthy idle codex pane at a *low* quota.** `codex-idle` sits at 99%.
  Nothing pins where between 99% and 0% the field stops meaning "fine" —
  the assumption is that only a literal `0% left` is a cap, and a `weekly 3%
  left` pane would falsify or confirm it.
- **A 5-hour rather than weekly cap.** The footer field is spelled `weekly 0%
  left`. If the shorter cap words itself differently (`5h 0% left`, `hourly`,
  something else) the matcher must cover that spelling too, and no capture shows
  it. Matching the *shape* — `<word> 0% left` as a whole footer field — rather
  than the literal word `weekly` is the hedge, and it is untested.
- **A capture after the reset time passes.** The "already past" behaviour above
  is reasoned from `BARE_TIME_LOOKBACK_MS` and from the fact that this capture's
  own reset was already past. What a *recovered* codex footer looks like the
  moment the quota rolls over — whether it jumps to `weekly 100% left`
  immediately, and whether the notice clears — is unobserved.

Re-capturing any of these burns real quota on the owner's account, so they are
deliberately left as documented gaps rather than synthesized fixtures. The tests
that stand in for them are marked as such.

## Tests

`e2e/detection.spec.ts`, section "paneReadiness: Codex CLI usage limits". The
assertions that describe behaviour not yet built are marked `test.fixme(true,
…)` with a reason pointing here, so the suite stays green until the
implementation round; the ones that pass today are ordinary tests, kept as the
regression guards that a fix must not break.

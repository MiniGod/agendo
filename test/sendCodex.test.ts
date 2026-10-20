// What `agendo send` tells the caller when a codex delivery fails
// (src/cli/commands/sendCodex.ts). e2e/codex.spec.ts reaches four of the five
// reasons through the simulated pane; "unreadable" needs the box to become
// unreadable between send's own read and delivery's first one, a race no
// fixture can stage, so the wording is pinned here for all five.
import { describe, expect, test } from "bun:test";
import { codexFailureMessage } from "../src/cli/commands/sendCodex.ts";
import type { CodexDelivery, CodexDeliveryFailure } from "../src/runtime/tmux/codexDelivery.ts";

const failed = (reason: CodexDeliveryFailure, enters: number, composer: string | null): CodexDelivery =>
  ({ ok: false, reason, enters, turnStarted: null, held: false, composer });

describe("codexFailureMessage", () => {
  test("each reason says whether anything was typed or submitted", () => {
    expect(codexFailureMessage("abc", failed("unreadable", 0, null))).toMatch(/nothing was typed/);
    expect(codexFailureMessage("abc", failed("not-ingested", 0, ""))).toMatch(/Enter was NOT pressed/);
    expect(codexFailureMessage("abc", failed("not-submitted", 4, "hi"))).toMatch(/after 4 Enter presses\. It is still there, unsent/);
    expect(codexFailureMessage("abc", failed("draft-rewritten", 1, "hi @README.md"))).toMatch(/Nothing was submitted/);
    expect(codexFailureMessage("abc", failed("lost-sight", 1, null))).toMatch(/can't say whether the message was taken/);
  });

  test("names the session to look at, and quotes what the box holds, cut short", () => {
    const long = "x".repeat(300);
    const msg = codexFailureMessage("abc", failed("not-submitted", 4, long));
    expect(msg).toContain("status abc");
    expect(msg).toContain(`It now reads: "${"x".repeat(200)}…"`);
    expect(codexFailureMessage("abc", failed("lost-sight", 1, null))).not.toContain("It now reads");
  });
});

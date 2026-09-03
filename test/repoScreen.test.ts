// The repo picker's words (src/ui/screens/RepoScreen.tsx): the heading, the
// key hint and the no-checkout note, each a function of the target and the
// offers. The e2e suite renders the picker for free, work-item and orchestrator
// targets with a checkout on offer; it never shows the note for an
// orchestrator, and never with the clone row withheld.
import { describe, expect, test } from "bun:test";
import { noCheckoutNote, repoHeading, repoHint } from "../src/ui/screens/RepoScreen.tsx";
import type { FreshTarget } from "../src/ui/targets.ts";

const free: FreshTarget = { tmuxName: "t", title: "t", kind: "free", defaultBranch: "main", orchestrator: false };
const orch: FreshTarget = { ...free, orchestrator: true };
const item: FreshTarget = { ...free, kind: "new", title: "x".repeat(60) };

describe("RepoScreen words", () => {
  test("the heading names the flow, and a work item's title is cut at 54", () => {
    expect(repoHeading(free)).toBe("New session — pick a repo");
    expect(repoHeading(orch)).toBe("Orchestrator session — pick a repo");
    expect(repoHeading(item)).toBe(`Fresh session — ${"x".repeat(54)}`);
  });

  test("the hint says when a worktree will be made, and offers c only when clone is on", () => {
    expect(repoHint(true, true)).toBe("Pick a repo  ·  ↑/↓ move · enter select · esc back · c clone · i new repo");
    expect(repoHint(false, false)).toBe("Pick a repo to create the worktree in  ·  ↑/↓ move · enter select · esc back · i new repo");
  });

  test("the note appears only where running in place would dead-end, and offers what is on", () => {
    expect(noCheckoutNote(free, false, true)).toBeNull();
    expect(noCheckoutNote(item, true, true)).toBeNull();
    expect(noCheckoutNote(item, false, true)).toMatch(/^No git checkout here — press c to clone one, i to create one/);
    expect(noCheckoutNote(orch, false, false)).toMatch(/^No git checkout here — press i to create one, .*quit with q/);
  });
});

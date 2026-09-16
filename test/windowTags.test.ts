// The window tag's wire format (src/runtime/tmux/tags.ts): the `-F` fields it
// asks tmux for, and what it does with the answer.
//
// Pure, and untestable through the e2e suite for a specific reason: every tag
// the fixtures produce is well-formed, and well-formed input is exactly the
// class where a validating parser and a trusting one agree. The cases that
// matter here — an untagged window, a hand-set option, a field an older agendo
// never wrote — cannot be produced by driving the app.
import { describe, expect, test } from "bun:test";
import {
  WINDOW_TAG_FIELDS, parseWindowTags, windowTagArgs, windowTagsFormat,
  SESSION_ID_OPTION, SOURCE_OPTION, ACQUIRED_OPTION, BRANCH_OPTION, PR_OPTION, ITEM_OPTION,
} from "../src/runtime/tmux/index.ts";

/** A full tag as `liveManagedPaths` would read it back, in TAG_OPTIONS order. */
const FULL = ["019cde00-1111-7000-8000-00000000cde0", "codex", "launched", "feat/tags", "42", "7"];

describe("windowTagsFormat", () => {
  test("emits one bare #{@cl_…} reference per field, in the parse order", () => {
    expect(windowTagsFormat("\t").split("\t")).toEqual([
      `#{${SESSION_ID_OPTION}}`,
      `#{${SOURCE_OPTION}}`,
      `#{${ACQUIRED_OPTION}}`,
      `#{${BRANCH_OPTION}}`,
      `#{${PR_OPTION}}`,
      `#{${ITEM_OPTION}}`,
    ]);
  });

  test("contributes exactly WINDOW_TAG_FIELDS fields", () => {
    // The live scan splits one line into fixed leading fields plus the tag's
    // tail, so a format that emitted a different count than the parser consumes
    // would silently shift every field by one — a branch read as a session id.
    expect(windowTagsFormat("\t").split("\t")).toHaveLength(WINDOW_TAG_FIELDS);
    expect(FULL).toHaveLength(WINDOW_TAG_FIELDS);
  });
});

describe("parseWindowTags", () => {
  test("reads a full tag back field for field", () => {
    expect(parseWindowTags(FULL)).toEqual({
      sessionId: "019cde00-1111-7000-8000-00000000cde0",
      source: "codex",
      acquired: "launched",
      branch: "feat/tags",
      pr: 42,
      item: 7,
    });
  });

  // The case every window that existed before tagging shipped is in, and the
  // one the whole no-migration promise rests on: an all-empty read must be "no
  // tag" so attribution falls through to the name/cwd route it always used —
  // never "a window claiming to belong to no session".
  test("an untagged window parses to undefined, not an empty tag", () => {
    expect(parseWindowTags(["", "", "", "", "", ""])).toBeUndefined();
    expect(parseWindowTags([])).toBeUndefined();
  });

  test("a partial tag keeps what is there and omits the rest", () => {
    // A Codex launch: source and acquisition are known at launch, the session id
    // does not exist yet. This shape has to survive, or that window could never
    // be tagged at all until its id appeared.
    expect(parseWindowTags(["", "codex", "launched", "", "", ""])).toEqual({
      source: "codex",
      acquired: "launched",
    });
  });

  test("a tag carrying only a session id is enough to attribute by", () => {
    expect(parseWindowTags(["abc-123", "", "", "", "", ""])).toEqual({ sessionId: "abc-123" });
  });

  test("an unrecognised source or acquisition is dropped, not trusted", () => {
    // These are tmux options: a user can set them by hand, and a value written
    // by a future agendo can reach an older one. A bad value degrades the window
    // to the old heuristic; it must never be presented as a real agent.
    const t = parseWindowTags(["id1", "emacs", "stolen", "", "", ""]);
    expect(t).toEqual({ sessionId: "id1" });
  });

  test("non-numeric or non-positive PR / item numbers are dropped", () => {
    expect(parseWindowTags(["", "", "", "", "not-a-number", "-3"])).toBeUndefined();
    expect(parseWindowTags(["", "", "", "", "0", "007"])).toEqual({ item: 7 });
  });

  test("surrounding whitespace is trimmed and embedded tabs cannot split a field", () => {
    // The read format is tab-joined, so a tab inside a value would shift every
    // field after it. Values are sanitized on the way IN (see windowTagArgs);
    // this is the belt to that braces for a value some other writer set.
    expect(parseWindowTags(["  id1  ", "claude", "", "a\tb", "", ""])).toEqual({
      sessionId: "id1",
      source: "claude",
      branch: "a b",
    });
  });

  test("extra trailing fields are ignored", () => {
    // What an OLDER agendo does when a newer one appends a field: it reads the
    // prefix it knows and ignores the rest, rather than misparsing.
    expect(parseWindowTags([...FULL, "something-new"])?.sessionId).toBe(FULL[0]);
  });
});

describe("windowTagArgs", () => {
  test("emits one [option, value] pair per known field", () => {
    expect(windowTagArgs({ sessionId: "id1", source: "claude", acquired: "launched", branch: "main", pr: 5, item: 9 }))
      .toEqual([
        [SESSION_ID_OPTION, "id1"],
        [SOURCE_OPTION, "claude"],
        [ACQUIRED_OPTION, "launched"],
        [BRANCH_OPTION, "main"],
        [PR_OPTION, "5"],
        [ITEM_OPTION, "9"],
      ]);
  });

  // The property that makes a second stamp ADD to a tag rather than replace it —
  // which is what lets a Codex window be tagged at launch and completed once its
  // id is discoverable, and what the adoption flow will need.
  test("an unknown field writes nothing rather than clearing it", () => {
    expect(windowTagArgs({ source: "codex", acquired: "launched" })).toEqual([
      [SOURCE_OPTION, "codex"],
      [ACQUIRED_OPTION, "launched"],
    ]);
    expect(windowTagArgs({})).toEqual([]);
  });

  test("an empty or whitespace-only value is not written either", () => {
    // `launchFresh` spreads a caller's partial tag, so an absent branch can
    // arrive as "" rather than undefined. Writing it would set an empty option,
    // which reads back identically to unset but costs a tmux call to say so.
    expect(windowTagArgs({ branch: "   ", sessionId: "" })).toEqual([]);
  });

  test("values that would break the tab-joined read format are sanitized", () => {
    expect(windowTagArgs({ branch: "feat\tbad\nname" })).toEqual([[BRANCH_OPTION, "feat bad name"]]);
  });

  test("what windowTagArgs writes is what parseWindowTags reads", () => {
    // The round trip both halves exist for, asserted end to end rather than
    // field by field: the writer and the reader share TAG_OPTIONS' order, and
    // nothing else keeps them in step.
    const tags = { sessionId: "id1", source: "copilot" as const, acquired: "adopted" as const, branch: "b", pr: 1, item: 2 };
    const written = new Map(windowTagArgs(tags));
    const fields = windowTagsFormat("\t")
      .split("\t")
      .map((ref) => written.get(ref.slice(2, -1)) ?? "");
    expect(parseWindowTags(fields)).toEqual(tags);
  });
});

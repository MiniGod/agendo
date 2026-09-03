// A workflow script's `export const meta = {…}` literal (src/workflows.ts
// `parseWorkflowMeta`). The e2e fixtures' scripts carry a well-formed meta with
// titled phases; they never carry a meta with no phases, a phase entry without
// a title, a brace inside a string, an unbalanced literal, or no meta at all.
import { describe, expect, test } from "bun:test";
import { parseWorkflowMeta } from "../src/workflows.ts";

describe("parseWorkflowMeta", () => {
  test("description and titled phases, with detail and model when given", () => {
    const src = `import x from "y";
export const meta = {
  name: 'review',
  description: "Review the \\"changes\\"",
  phases: [{ title: 'Review', detail: \`one {brace} inside\` }, { title: "Verify", model: 'opus' }, { detail: "no title" }],
}
const rest = { title: "not a phase" };`;
    expect(parseWorkflowMeta(src)).toEqual({
      description: 'Review the "changes"',
      phases: [
        { title: "Review", detail: "one {brace} inside", model: undefined },
        { title: "Verify", detail: undefined, model: "opus" },
      ],
    });
  });

  test("no phases, only untitled phases, or an empty array leave phases out", () => {
    expect(parseWorkflowMeta("export const meta = { description: 'd' }")).toEqual({ description: "d" });
    expect(parseWorkflowMeta("export const meta = { phases: [{ detail: 'x' }] }")).toEqual({ description: undefined });
    expect(parseWorkflowMeta("export const meta = { phases: [] }")).toEqual({ description: undefined });
    expect(parseWorkflowMeta("export const meta = { phases: 3 }")).toEqual({ description: undefined });
  });

  test("no meta, a meta with no object, and an unbalanced literal all degrade to nothing", () => {
    expect(parseWorkflowMeta("const meta = { description: 'd' }")).toEqual({});
    expect(parseWorkflowMeta("export const meta = 3")).toEqual({});
    expect(parseWorkflowMeta("export const meta = { description: 'd', phases: [{ title: 'a' }")).toEqual({});
    expect(parseWorkflowMeta("export const meta = { phases: [{ title: 'a' }")).toEqual({});
  });
});

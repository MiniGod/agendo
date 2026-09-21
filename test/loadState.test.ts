import { describe, expect, test } from "bun:test";
import {
  loadMarker,
  sliceForView,
  type LoadPhase,
  type ModelLoadState,
} from "../src/ui/models/loadState.ts";

const state: ModelLoadState = {
  items: { phase: "refreshing" },
  prs: { phase: "error", error: "offline" },
};

describe("sliceForView", () => {
  test("maps tracker tabs to their slice and leaves Sessions unblocked", () => {
    expect(sliceForView(state, "items")).toBe(state.items);
    expect(sliceForView(state, "prs")).toBe(state.prs);
    expect(sliceForView(state, "sessions")).toBeNull();
  });
});

describe("loadMarker", () => {
  test("distinguishes pending, failed and ready slices", () => {
    const marker = (phase: LoadPhase) => loadMarker({ phase });
    expect(marker("loading")).toBe(" ⟳");
    expect(marker("refreshing")).toBe(" ⟳");
    expect(marker("error")).toBe(" !");
    expect(marker("stale-error")).toBe(" !");
    expect(marker("ready")).toBe("");
  });
});

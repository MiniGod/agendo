import type { View } from "../keys/context.ts";

export type LoadPhase = "loading" | "refreshing" | "ready" | "error" | "stale-error";

export interface SliceLoadState {
  phase: LoadPhase;
  error?: string;
}

export interface ModelLoadState {
  items: SliceLoadState;
  prs: SliceLoadState;
}

export interface RetryState {
  attempt: number;
  attempts: number;
  resumeAt: number;
  reason: string;
  waiting: boolean;
}

export const INITIAL_LOAD_STATE: ModelLoadState = {
  items: { phase: "loading" },
  prs: { phase: "loading" },
};

export function sliceForView(state: ModelLoadState, view: View): SliceLoadState | null {
  if (view === "sessions") return null;
  return state[view];
}

export function loadMarker(state: SliceLoadState): string {
  if (state.phase === "loading" || state.phase === "refreshing") return " ⟳";
  if (state.phase === "error" || state.phase === "stale-error") return " !";
  return "";
}

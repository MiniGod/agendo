// The expanded session row's tmux identity line (src/ui/models/tmuxMeta.ts) and
// its wiring into sessionMeta (src/ui/models/rows.ts). reconcileLive's own
// production of the underlying LiveTarget fields (session/windowIndex,
// liveWindowLocations, placeholderWindows) is covered in e2e/detection.spec.ts
// alongside the rest of the live-tmux attribution core; this file is the pure,
// UI-facing half — given the precomputed LiveInfo a render already has, does it
// say the right thing.
import { describe, expect, test } from "bun:test";
import type { LoadedModel } from "../src/app/model/index.ts";
import type { AgentSession } from "../src/shared/types.ts";
import type { LiveTarget } from "../src/runtime/tmux/index.ts";
import { sessionName } from "../src/runtime/tmux/index.ts";
import { sessionMeta } from "../src/ui/models/rows.ts";
import { liveInfoOf, tmuxLine, type LiveInfo } from "../src/ui/models/tmuxMeta.ts";

const session = (id: string, over: Partial<AgentSession> = {}): AgentSession =>
  ({ id, source: "claude", cwd: "/w/repo", title: "t", lastUsed: new Date("2026-09-01T00:00:00Z"), ...over }) as AgentSession;

const emptyLive: LiveInfo = { names: new Set(), windows: new Map(), locations: new Map() };

describe("tmuxLine", () => {
  test("not running and no placeholder: no line", () => {
    expect(tmuxLine(emptyLive, "cl-claude-x")).toBeNull();
  });

  test("a single window: session:index and the window name, quoted", () => {
    const live: LiveInfo = {
      names: new Set(["cl-claude-x"]),
      windows: new Map([["cl-claude-x", { name: "cl-claude-x", target: "=agendo:=cl-claude-x", session: "agendo", windowIndex: "3" }]]),
      locations: new Map([["cl-claude-x", ["agendo:3"]]]),
    };
    expect(tmuxLine(live, "cl-claude-x")).toBe('agendo:3  "cl-claude-x"');
  });

  test("a window name live in more than one host session lists every location, not just the first", () => {
    const live: LiveInfo = {
      names: new Set(["cl-claude-x"]),
      windows: new Map([["cl-claude-x", { name: "cl-claude-x", target: "=agendo:=cl-claude-x", session: "agendo", windowIndex: "3" }]]),
      locations: new Map([["cl-claude-x", ["agendo:3", "work:0"]]]),
    };
    expect(tmuxLine(live, "cl-claude-x")).toBe('agendo:3, work:0  "cl-claude-x"');
  });

  test("pane-hosted: the session name, and no window index at all — never a misleading one", () => {
    const live: LiveInfo = {
      names: new Set(["cl-bg-orch"]),
      windows: new Map([["cl-bg-orch", { name: "cl-bg-orch", target: "%4", session: "agendo", windowIndex: null }]]),
      locations: new Map(),
    };
    const line = tmuxLine(live, "cl-bg-orch");
    expect(line).toBe("agendo  ·  pane (no window of its own)");
    expect(line).not.toMatch(/:\d/); // no "session:index" pair anywhere in it
  });

  test("a paused restore placeholder gets a line too, once liveInfoOf merges it in", () => {
    const model = {
      liveTmux: new Set<string>(),
      liveWindows: new Map<string, LiveTarget>(),
      placeholderWindows: new Map<string, LiveTarget>([
        ["cl-claude-p", { name: "cl-claude-p", target: "=agendo:=cl-claude-p", session: "agendo", windowIndex: "5" }],
      ]),
      liveWindowLocations: new Map<string, string[]>(),
    } as unknown as LoadedModel;
    expect(tmuxLine(liveInfoOf(model), "cl-claude-p")).toBe('agendo:5  "cl-claude-p"');
  });
});

describe("liveInfoOf", () => {
  test("a real window wins over a same-canon placeholder (the real-window-vouches precedent elsewhere)", () => {
    const real: LiveTarget = { name: "cl-claude-p", target: "=work:=cl-claude-p", session: "work", windowIndex: "1" };
    const model = {
      liveTmux: new Set(["cl-claude-p"]),
      liveWindows: new Map([["cl-claude-p", real]]),
      placeholderWindows: new Map<string, LiveTarget>([
        ["cl-claude-p", { name: "cl-claude-p", target: "=agendo:=cl-claude-p", session: "agendo", windowIndex: "5" }],
      ]),
      liveWindowLocations: new Map<string, string[]>(),
    } as unknown as LoadedModel;
    expect(liveInfoOf(model).windows.get("cl-claude-p")).toBe(real);
  });
});

describe("sessionMeta: the tmux line", () => {
  test("omitted entirely when the session isn't running and has no placeholder — not blank, not 'none'", () => {
    const meta = sessionMeta(session("notrunning"), emptyLive);
    expect(meta.find(([label]) => label === "tmux")).toBeUndefined();
  });

  test("present, in the same [label, value] vocabulary as dir/repo/branch/profile", () => {
    const s = session("runningid");
    const canon = sessionName(s);
    const live: LiveInfo = {
      names: new Set([canon]),
      windows: new Map([[canon, { name: canon, target: `=agendo:=${canon}`, session: "agendo", windowIndex: "2" }]]),
      locations: new Map([[canon, ["agendo:2"]]]),
    };
    expect(sessionMeta(s, live)).toContainEqual(["tmux", `agendo:2  "${canon}"`]);
  });
});

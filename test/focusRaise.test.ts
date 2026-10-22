// The pure steps behind raising the terminal of a tmux client
// (src/cli/focus/raise.ts) and opening one when none is attached
// (src/cli/focus/terminal.ts). The e2e suite drives the wmctrl, xdotool and
// i3-msg routes with fakes; the parsing they rely on, which helper runs in which
// order on i3, sway and plain X11, and every way it must quietly give up are
// pinned here with an injected runner, since no fixture runs on a real X server.
import { describe, expect, test } from "bun:test";
import {
  ancestry, canRaise, decimalWindowId, i3FocusArgs, nearestWindow, onI3, parsePpid, parseWmctrl, raiseTerminal,
  swayConsByPid, type Run,
} from "../src/cli/focus/raise.ts";
import { focusTerminalTemplate, terminalArgv } from "../src/cli/focus/terminal.ts";
import { notifyBody } from "../src/cli/focus/notify.ts";

describe("parsePpid", () => {
  test("reads the field after the comm", () => expect(parsePpid("4107 (tmux: client) S 4100 4107 4100 0")).toBe(4100));
  test("a comm holding parens and spaces", () => expect(parsePpid("12 (a) b (c) R 7 12 12")).toBe(7));
  test("garbage", () => {
    expect(parsePpid("")).toBeNull();
    expect(parsePpid("1 (x) S")).toBeNull();
    expect(parsePpid("1 (x) S 0")).toBeNull();
  });
});

describe("ancestry", () => {
  const tree: Record<number, number> = { 50: 40, 40: 30, 30: 1 };
  const stat = (pid: number) => (pid in tree ? `${pid} (p) S ${tree[pid]} 0` : null);

  test("nearest first, stopping before init", () => expect(ancestry(50, stat)).toEqual([50, 40, 30]));
  test("an unreadable pid ends the walk", () => expect(ancestry(99, stat)).toEqual([99]));
  test("a cycle cannot loop forever", () => {
    expect(ancestry(5, (pid) => `${pid} (p) S ${pid === 5 ? 6 : 5} 0`)).toEqual([5, 6]);
  });
  test("bounded depth", () => {
    expect(ancestry(1000, (pid) => `${pid} (p) S ${pid - 1} 0`)).toHaveLength(8);
  });
  test("pid 1 and below is never walked", () => expect(ancestry(1, stat)).toEqual([]));
});

describe("parseWmctrl / nearestWindow", () => {
  const listing = [
    "0x04000007  0 4100   host  Terminal",
    "0x04000009  0 4100   host  Terminal 2",
    "0x05000001 -1 900    host  Desktop",
    "not a line",
    "0xzz  0 1 host bad",
  ].join("\n");

  test("first window per pid", () => {
    const m = parseWmctrl(listing);
    expect(m.get(4100)).toBe("0x04000007");
    expect(m.get(900)).toBe("0x05000001");
    expect(m.size).toBe(2);
  });

  test("the nearest ancestor that owns a window", () => {
    const m = parseWmctrl(listing);
    expect(nearestWindow([4107, 4105, 4100, 900], (p) => m.get(p))).toBe("0x04000007");
    expect(nearestWindow([4107], (p) => m.get(p))).toBeNull();
  });
});

describe("canRaise", () => {
  test("X11 only", () => {
    expect(canRaise({ DISPLAY: ":0" })).toBe(true);
    expect(canRaise({})).toBe(false);
    expect(canRaise({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
    expect(canRaise({ DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" })).toBe(false);
  });
});

/**
 * A runner that answers from a table keyed by the full command line and records
 * every call. Nothing here spawns a process: an unlisted command "fails" (null),
 * as a missing binary would.
 */
function fakeRun(answers: Record<string, string | null>): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = (cmd, args, env) => {
    // A call that hands on an I3SOCK is prefixed with it, so a spec can tell the retry without it apart.
    const line = (env?.I3SOCK ? `I3SOCK=${env.I3SOCK} ` : "") + [cmd, ...args].join(" ");
    calls.push(line);
    return answers[line] ?? null;
  };
  return { run, calls };
}

describe("onI3", () => {
  test("by its socket env, without running i3-msg", () => {
    const { run, calls } = fakeRun({});
    expect(onI3({ DISPLAY: ":0", I3SOCK: "/run/i3.sock" }, run)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("when i3-msg finds a socket", () => {
    const { run } = fakeRun({ "i3-msg --get-socketpath": "/run/user/1000/i3/ipc-socket.1\n" });
    expect(onI3({ DISPLAY: ":0" }, run)).toBe(true);
  });
  test("not when i3-msg fails or prints nothing", () => {
    expect(onI3({ DISPLAY: ":0" }, fakeRun({}).run)).toBe(false);
    expect(onI3({ DISPLAY: ":0" }, fakeRun({ "i3-msg --get-socketpath": "  \n" }).run)).toBe(false);
  });
  test("never probed off X11", () => {
    const { run, calls } = fakeRun({ "i3-msg --get-socketpath": "/s" });
    expect(onI3({}, run)).toBe(false);
    expect(onI3({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", I3SOCK: "/s" }, run)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("decimalWindowId / i3FocusArgs", () => {
  test("wmctrl's hex becomes the decimal i3 matches on", () => {
    expect(decimalWindowId("0x04600004")).toBe("73400324");
    expect(decimalWindowId("0X4600004")).toBe("73400324");
  });
  test("xdotool's decimal passes through, normalised", () => {
    expect(decimalWindowId("67108871")).toBe("67108871");
    expect(decimalWindowId("0067108871")).toBe("67108871");
  });
  test("anything else is not an id", () => {
    for (const bad of ["", "0x", "0xzz", "12a", "-1", "] focus; exec rm"]) expect(decimalWindowId(bad)).toBeNull();
  });
  test("one criteria-scoped focus command", () => {
    expect(i3FocusArgs("0x04600004")).toEqual(["[id=73400324] focus"]);
    expect(i3FocusArgs("nope")).toBeNull();
  });
});

describe("swayConsByPid", () => {
  test("first container per pid, tiled and floating", () => {
    const tree = JSON.stringify({
      id: 1, nodes: [
        { id: 4, nodes: [{ id: 10, pid: 7487, nodes: [] }, { id: 11, pid: 7487 }] },
        { id: 5, nodes: [], floating_nodes: [{ id: 12, pid: 900 }] },
      ],
    });
    const m = swayConsByPid(tree);
    expect(m.get(7487)).toBe(10);
    expect(m.get(900)).toBe(12);
    expect(m.size).toBe(2);
  });
  test("garbage is an empty map, never a throw", () => {
    for (const bad of ["", "not json", "null", "42", '{"nodes":[null,1,"x"]}']) expect(swayConsByPid(bad).size).toBe(0);
  });
});

describe("raiseTerminal: command selection", () => {
  // client 50 → shell 40 → terminal 30, which owns the window.
  const tree: Record<number, number> = { 50: 40, 40: 30, 30: 1 };
  const readStat = (pid: number) => (pid in tree ? `${pid} (p) S ${tree[pid]} 0` : null);
  const X = { DISPLAY: ":0" };
  const LIST = "0x04600004  4 30   host  Terminal";
  const raise = (env: NodeJS.ProcessEnv, answers: Record<string, string | null>) => {
    const f = fakeRun(answers);
    return { ok: raiseTerminal(50, env, { run: f.run, readStat }), calls: f.calls };
  };

  test("on i3, i3-msg focuses the window and the EWMH request is never sent", () => {
    const r = raise({ ...X, I3SOCK: "/s" }, { "wmctrl -lp": LIST, "I3SOCK=/s i3-msg [id=73400324] focus": "" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["wmctrl -lp", "I3SOCK=/s i3-msg [id=73400324] focus"]);
  });
  test("on i3, a refused focus falls back to wmctrl -ia", () => {
    const r = raise({ ...X, I3SOCK: "/s" }, { "wmctrl -lp": LIST, "wmctrl -ia 0x04600004": "" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual([
      "wmctrl -lp", "I3SOCK=/s i3-msg [id=73400324] focus", "i3-msg [id=73400324] focus", "wmctrl -ia 0x04600004",
    ]);
  });
  test("on i3, a stale I3SOCK is retried without it, before any EWMH request", () => {
    const r = raise({ ...X, I3SOCK: "/dead" }, { "wmctrl -lp": LIST, "i3-msg [id=73400324] focus": "" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["wmctrl -lp", "I3SOCK=/dead i3-msg [id=73400324] focus", "i3-msg [id=73400324] focus"]);
  });
  test("on i3 found by probe, a refusal is not retried", () => {
    const r = raise(X, { "i3-msg --get-socketpath": "/s", "wmctrl -lp": LIST, "wmctrl -ia 0x04600004": "" });
    expect(r.calls).toEqual(["i3-msg --get-socketpath", "wmctrl -lp", "i3-msg [id=73400324] focus", "wmctrl -ia 0x04600004"]);
  });
  test("on i3 without wmctrl, xdotool finds the window and i3-msg focuses it", () => {
    const r = raise({ ...X, I3SOCK: "/s" }, { "xdotool search --pid 30": "73400324\n", "I3SOCK=/s i3-msg [id=73400324] focus": "" });
    expect(r.ok).toBe(true);
    expect(r.calls.filter((c) => !c.startsWith("xdotool search"))).toEqual(["wmctrl -lp", "I3SOCK=/s i3-msg [id=73400324] focus"]);
  });
  test("without i3, wmctrl -ia as before — after one quiet probe", () => {
    const r = raise(X, { "wmctrl -lp": LIST, "wmctrl -ia 0x04600004": "" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["i3-msg --get-socketpath", "wmctrl -lp", "wmctrl -ia 0x04600004"]);
  });
  test("without i3 or wmctrl, xdotool windowactivate as before", () => {
    const r = raise(X, { "xdotool search --pid 30": "73400324", "xdotool windowactivate 73400324": "" });
    expect(r.ok).toBe(true);
    expect(r.calls.some((c) => c.startsWith("i3-msg [id="))).toBe(false);
  });
  test("on sway, the nearest ancestor's container by con_id", () => {
    const swayTree = JSON.stringify({ id: 1, nodes: [{ id: 9, pid: 30 }, { id: 8, pid: 40 }] });
    const r = raise({ SWAYSOCK: "/s", WAYLAND_DISPLAY: "wayland-1" }, { "swaymsg -t get_tree": swayTree, "swaymsg [con_id=8] focus": "" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["swaymsg -t get_tree", "swaymsg [con_id=8] focus"]);
  });
  test("on sway, no ancestor's container is a quiet false", () => {
    const r = raise({ SWAYSOCK: "/s" }, { "swaymsg -t get_tree": '{"id":1,"nodes":[]}' });
    expect(r).toEqual({ ok: false, calls: ["swaymsg -t get_tree"] });
  });
  test("a stale SWAYSOCK on X11 falls through to the X11 path, i3 probe included", () => {
    const r = raise({ ...X, SWAYSOCK: "/dead" }, { "wmctrl -lp": LIST, "wmctrl -ia 0x04600004": "" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["swaymsg -t get_tree", "i3-msg --get-socketpath", "wmctrl -lp", "wmctrl -ia 0x04600004"]);
  });
  test("a stale SWAYSOCK on an i3 desktop still focuses through i3-msg", () => {
    const r = raise({ ...X, SWAYSOCK: "/dead", I3SOCK: "/s" }, { "wmctrl -lp": LIST, "I3SOCK=/s i3-msg [id=73400324] focus": "" });
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["swaymsg -t get_tree", "wmctrl -lp", "I3SOCK=/s i3-msg [id=73400324] focus"]);
  });
  test("off X11 and off sway, nothing runs at all", () => {
    expect(raise({ WAYLAND_DISPLAY: "wayland-0" }, {})).toEqual({ ok: false, calls: [] });
  });
  test("a throwing runner is swallowed", () => {
    const run: Run = () => { throw new Error("boom"); };
    expect(raiseTerminal(50, X, { run, readStat })).toBe(false);
  });
});

describe("focusTerminal", () => {
  test("off unless configured as a non-empty string", () => {
    expect(focusTerminalTemplate(undefined)).toBeNull();
    expect(focusTerminalTemplate("  ")).toBeNull();
    expect(focusTerminalTemplate(42)).toBeNull();
    expect(focusTerminalTemplate(" xterm -e tmux attach -t {session} ")).toBe("xterm -e tmux attach -t {session}");
  });

  test("split into argv, never a shell, with the session pinned exactly", () => {
    expect(terminalArgv("x-terminal-emulator -e tmux attach -t {session}", "agendo")).toEqual([
      "x-terminal-emulator", "-e", "tmux", "attach", "-t", "=agendo",
    ]);
    expect(terminalArgv("term --title=agendo:{session}", "s; rm -rf ~")).toEqual(["term", "--title=agendo:s; rm -rf ~"]);
  });
});

test("notifyBody escapes markup", () => {
  expect(notifyBody("PR !1 <b>&</b>")).toBe("PR !1 &lt;b&gt;&amp;&lt;/b&gt;");
});

// The pure steps behind raising the terminal of a tmux client
// (src/cli/focus/raise.ts) and opening one when none is attached
// (src/cli/focus/terminal.ts). The e2e suite drives the wmctrl path once with a
// fake; the parsing it relies on — and every way it must quietly give up — is
// pinned here, since no fixture runs on a real X server.
import { describe, expect, test } from "bun:test";
import { ancestry, canRaise, nearestWindow, parsePpid, parseWmctrl } from "../src/cli/focus/raise.ts";
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

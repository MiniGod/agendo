// The browser user-script (extras/userscript/agendo.user.js). There is no
// browser in either suite, so what is pinned here is what can be without one:
// the link it builds from a page URL, that a click lets the browser follow the
// link with a one-shot beforeunload guard armed, and what that guard does with
// the events it is handed. NOT tested here: that a real browser hands the guard
// beforeunload ahead of the page's handlers (Firefox runs a window's capture
// listeners first; Chromium runs them in the order they were added, so there it
// depends on the script manager injecting at document-start), and that the link
// then reaches the OS handler.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const PATH = join(import.meta.dir, "..", "extras", "userscript", "agendo.user.js");
const script = require(PATH);

const loc = (url: string) => new URL(url);

describe("linkFor / hrefFor", () => {
  const href = (url: string) => {
    const t = script.linkFor(loc(url));
    return t ? script.hrefFor(t) : null;
  };

  test("Azure DevOps PRs and work items", () => {
    expect(href("https://dev.azure.com/org/proj/_git/mc-applications/pullrequest/81276")).toBe("agendo://focus?pr=81276&repo=mc-applications");
    expect(href("https://dev.azure.com/org/proj/_workitems/edit/102")).toBe("agendo://focus?workItem=102");
    expect(href("https://dev.azure.com/org/proj/_boards/board?workitem=7")).toBe("agendo://focus?workItem=7");
  });

  test("GitHub PRs and issues carry owner/name", () => {
    expect(href("https://github.com/MiniGod/agendo/pull/137/files")).toBe("agendo://focus?pr=137&repo=MiniGod/agendo");
    expect(href("https://github.com/MiniGod/agendo/issues/5")).toBe("agendo://focus?workItem=5&repo=MiniGod/agendo");
  });

  test("a repo agendo would refuse is left out, not mangled; other pages get no link", () => {
    expect(href("https://dev.azure.com/org/proj/_git/bad%20name/pullrequest/9")).toBe("agendo://focus?pr=9");
    expect(href("https://github.com/MiniGod/agendo")).toBeNull();
    expect(href("https://example.com/x/pull/1")).toBeNull();
  });
});

/** Just enough of a window for `guard`: listeners, and events that record what was done to them. */
function fakeWin() {
  const listeners: { type: string; fn: (e: unknown) => void; capture: unknown }[] = [];
  return {
    listeners,
    addEventListener: (type: string, fn: (e: unknown) => void, capture: unknown) => listeners.push({ type, fn, capture }),
    /** Fire a beforeunload at the guard; returns what it did to the event. */
    unload: () => {
      const e = { stopped: false, prevented: false, returnValue: "" };
      const ev = { ...e, stopImmediatePropagation: () => (e.stopped = true), preventDefault: () => (e.prevented = true) };
      for (const l of listeners) if (l.type === "beforeunload") l.fn(ev);
      return { ...e, returnValue: ev.returnValue };
    },
  };
}

/** A guard on a fake window, with its timers held and its log captured. */
function armed() {
  const win = fakeWin();
  const timers: [() => void, number][] = [];
  const logs: string[] = [];
  const arm = script.guard(win, (fn: () => void, ms: number) => timers.push([fn, ms]), (args: string[]) => logs.push(args.join(" ")));
  return { win, timers, logs, arm };
}

describe("guard", () => {
  test("it listens for beforeunload in the capture phase, so in Firefox it runs before every bubble handler", () => {
    const { win } = armed();
    expect(win.listeners.map((l) => [l.type, l.capture])).toEqual([["beforeunload", true]]);
  });

  test("unarmed, a beforeunload passes untouched: closing the tab still reaches the page", () => {
    const { win } = armed();
    expect(win.unload()).toEqual({ stopped: false, prevented: false, returnValue: "" });
  });

  test("armed, it swallows exactly one beforeunload, without raising the leave-page prompt", () => {
    const { win, arm, logs } = armed();
    arm();
    expect(win.unload()).toEqual({ stopped: true, prevented: false, returnValue: "" });
    expect(logs).toEqual(["stopped beforeunload: page listeners added after the guard were skipped"]);
    expect(win.unload().stopped).toBe(false);
  });

  test("it disarms after GUARD_MS when no beforeunload came", () => {
    const { win, arm, timers, logs } = armed();
    arm();
    expect(timers.map(([, ms]) => ms)).toEqual([script.GUARD_MS]);
    // Long enough for the browser's async link-follow; short enough that closing the tab later is not swallowed.
    expect(script.GUARD_MS).toBeGreaterThanOrEqual(1000);
    expect(script.GUARD_MS).toBeLessThanOrEqual(5000);
    timers[0][0]();
    expect(logs).toEqual([`no beforeunload within ${script.GUARD_MS}ms; guard disarmed`]);
    expect(win.unload().stopped).toBe(false);
  });

  test("a late timer from an earlier click leaves the current arming alone", () => {
    const { win, arm, timers } = armed();
    arm();
    arm();
    timers[0][0]();
    expect(win.unload().stopped).toBe(true);
  });

  test("disarm undoes its own arming only, not a later click's", () => {
    const { win, arm } = armed();
    const disarm = arm();
    disarm();
    expect(win.unload().stopped).toBe(false);
    const stale = arm();
    arm();
    stale();
    expect(win.unload().stopped).toBe(true);
  });

  test("a timer that fires after its beforeunload was swallowed logs nothing", () => {
    const { win, arm, timers, logs } = armed();
    arm();
    win.unload();
    timers[0][0]();
    expect(logs).toHaveLength(1);
  });
});

describe("onClick", () => {
  const link = { getAttribute: () => "agendo://focus?pr=1" };

  /** A click on `link`, its arming and its deferred check held, its log captured. */
  function click(e: Record<string, unknown>) {
    const ev: Record<string, unknown> = { defaultPrevented: false, currentTarget: link, ...e };
    ev.preventDefault = () => (ev.defaultPrevented = true);
    const seen = { arms: 0, disarms: 0, logs: [] as string[], later: [] as [() => void, number][] };
    script.onClick(ev, () => (seen.arms++, () => seen.disarms++), (fn: () => void, ms: number) => seen.later.push([fn, ms]), (a: string[]) => seen.logs.push(a.join(" ")));
    return { ev, seen };
  }

  test("a plain click arms the guard and is NOT cancelled: the browser follows the link itself", () => {
    const { ev, seen } = click({ button: 0 });
    expect(ev.defaultPrevented).toBe(false);
    expect(seen.arms).toBe(1);
    expect(seen.logs).toEqual([`following agendo://focus?pr=1; beforeunload guard armed for ${script.GUARD_MS}ms`]);
    // The check waits a task, for every other click listener to have run.
    expect(seen.later.map(([, ms]) => ms)).toEqual([0]);
    seen.later[0][0]();
    expect(seen.disarms).toBe(0);
    expect(seen.logs).toHaveLength(1);
  });

  test("a click the page cancels after us disarms the guard, so a later real unload is not swallowed", () => {
    const { ev, seen } = click({ button: 0 });
    (ev.preventDefault as () => void)();
    seen.later[0][0]();
    expect(seen.disarms).toBe(1);
    expect(seen.logs[1]).toBe("the page cancelled the click, so the link was not followed; guard disarmed");
  });

  test("a middle or modified click is left to the browser, unguarded", () => {
    for (const e of [{ button: 1 }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true }, { button: 0, shiftKey: true }, { button: 0, altKey: true }]) {
      const { ev, seen } = click(e);
      expect([ev.defaultPrevented, seen.arms, seen.later.length]).toEqual([false, 0, 0]);
    }
  });
});

describe("debug", () => {
  const storage = (value: string | null) => () => ({ getItem: (k: string) => (k === script.DEBUG_KEY ? value : null) });
  const capture = () => {
    const lines: unknown[][] = [];
    return { lines, out: { info: (...a: unknown[]) => lines.push(a) } };
  };

  test("logs to console.info (which Chromium shows by default) only when localStorage says \"1\"", () => {
    for (const [value, logged] of [["1", true], ["0", false], [null, false], ["true", false]] as const) {
      const { lines, out } = capture();
      script.debug(["hello", 2], storage(value), out);
      expect(lines).toEqual(logged ? [["[agendo]", "hello", 2]] : []);
    }
  });

  test("storage that throws, from getItem or on access to localStorage itself, means off rather than an error", () => {
    const { lines, out } = capture();
    script.debug(["x"], () => ({ getItem: () => { throw new Error("SecurityError"); } }), out);
    script.debug(["x"], () => { throw new Error("SecurityError"); }, out);
    expect(lines).toEqual([]);
  });
});

// The link is followed by the browser's own default action; nothing navigates
// the page from script, opens a window, or hands the link to a frame (which
// Azure DevOps' and GitHub's CSP frame-src both refuse).
test("no window.location assignment, location.assign()/replace(), window.open() or iframe", () => {
  const code = readFileSync(PATH, "utf-8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  expect(code).not.toMatch(/location(\.href)?\s*=[^=]/);
  expect(code).not.toMatch(/location\.(assign|replace)\s*\(/);
  expect(code).not.toMatch(/window\.open\s*\(/);
  expect(code).not.toMatch(/iframe/i);
});

// Chromium runs a window's listeners in the order they were added, so the
// guard beats only the page listeners added after it: document-start is what
// makes that all of them.
test("the script runs at document-start, in the top window only", () => {
  const code = readFileSync(PATH, "utf-8");
  expect(code).toMatch(/^\/\/ @run-at\s+document-start$/m);
  expect(code).toMatch(/^\/\/ @noframes$/m);
});

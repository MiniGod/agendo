// The browser user-script (extras/userscript/agendo.user.js). There is no
// browser in either suite, so what is pinned here is what can be without one:
// the link it builds from a page URL, and that a click hands the link over from
// a hidden iframe rather than navigating the page — the navigation is what made
// Azure DevOps drop its live-update connection. That the iframe really keeps
// the page from unloading in Firefox/Chromium is NOT tested here.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const PATH = join(import.meta.dir, "..", "extras", "userscript", "agendo.user.js");
const script = require(PATH);

const loc = (url: string) => new URL(url);

// The script keeps its pending launch between calls; no test inherits another's.
afterEach(() => script.reset());

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

/** Just enough of a document for `launch`: elements, a body, and listeners. */
function fakeDoc() {
  const listeners = new Map<string, (e: unknown) => void>();
  const body: { children: Record<string, unknown>[] } = { children: [] };
  return {
    body: {
      ...body,
      appendChild: (el: Record<string, unknown>) => body.children.push(el),
    },
    children: body.children,
    listeners,
    createElement: (tag: string) => {
      const el: Record<string, unknown> = { tag, style: {}, removed: false };
      el.remove = () => (el.removed = true);
      return el;
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
}

describe("launch", () => {
  test("a hidden iframe carries the link, and is removed again after FRAME_MS", () => {
    const doc = fakeDoc();
    const timers: [() => void, number][] = [];
    let fellBack = false;
    script.launch("agendo://focus?pr=1", () => (fellBack = true), doc, (fn: () => void, ms: number) => timers.push([fn, ms]));
    expect(doc.children).toHaveLength(1);
    const frame = doc.children[0];
    expect(frame.tag).toBe("iframe");
    expect(frame.src).toBe("agendo://focus?pr=1");
    expect(frame.style).toEqual({ display: "none" });
    expect(timers.map(([, ms]) => ms)).toEqual([script.FRAME_MS]);
    // Long enough for the browser's first-use "open this link?" prompt, which belongs to the frame.
    expect(script.FRAME_MS).toBeGreaterThanOrEqual(60_000);
    timers[0][0]();
    expect(frame.removed).toBe(true);
    expect(doc.listeners.has("securitypolicyviolation")).toBe(false);
    expect(fellBack).toBe(false);
  });

  test("an enforced CSP that blocks the agendo: frame falls back to the link, once; other violations are ignored", () => {
    const doc = fakeDoc();
    let fellBack = 0;
    script.launch("agendo://focus?pr=1", () => fellBack++, doc, () => {});
    const report = doc.listeners.get("securitypolicyviolation")!;
    report({ blockedURI: "https://ads.example", disposition: "enforce" });
    expect(fellBack).toBe(0);
    report({ blockedURI: "agendo", disposition: "enforce" });
    expect(fellBack).toBe(1);
    expect(doc.listeners.has("securitypolicyviolation")).toBe(false);
    expect(doc.children[0].removed).toBe(true);
  });

  test("a report-only CSP blocked nothing: no fallback, so the link is not launched twice", () => {
    const doc = fakeDoc();
    let fellBack = 0;
    script.launch("agendo://focus?pr=1", () => fellBack++, doc, () => {});
    doc.listeners.get("securitypolicyviolation")!({ blockedURI: "agendo", disposition: "report" });
    expect(fellBack).toBe(0);
    expect(doc.children[0].removed).toBe(false);
  });

  test("a second click tears the first launch down: one frame, one listener, one fallback", () => {
    const doc = fakeDoc();
    let fellBack = 0;
    script.launch("agendo://focus?pr=1", () => fellBack++, doc, () => {});
    script.launch("agendo://focus?pr=2", () => fellBack++, doc, () => {});
    expect(doc.children.map((f) => [f.src, f.removed])).toEqual([["agendo://focus?pr=1", true], ["agendo://focus?pr=2", false]]);
    doc.listeners.get("securitypolicyviolation")!({ blockedURI: "agendo", disposition: "enforce" });
    expect(fellBack).toBe(1);
  });

  test("a late timer from an earlier launch leaves the current one alone", () => {
    const doc = fakeDoc();
    const timers: (() => void)[] = [];
    script.launch("agendo://focus?pr=1", () => {}, doc, (fn: () => void) => timers.push(fn));
    script.launch("agendo://focus?pr=2", () => {}, doc, (fn: () => void) => timers.push(fn));
    timers[0]();
    expect(doc.children[1].removed).toBe(false);
    expect(doc.listeners.has("securitypolicyviolation")).toBe(true);
  });
});

describe("onClick", () => {
  test("a plain click is cancelled — the page is never navigated", () => {
    let prevented = false;
    const doc = fakeDoc();
    const realDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = doc;
    try {
      script.onClick({
        button: 0, preventDefault: () => (prevented = true),
        currentTarget: { getAttribute: () => "agendo://focus?pr=1" },
      }, () => {});
    } finally {
      (globalThis as { document?: unknown }).document = realDocument;
    }
    expect(prevented).toBe(true);
    expect(doc.children.map((el) => [el.tag, el.src])).toEqual([["iframe", "agendo://focus?pr=1"]]);
  });

  test("a middle or modified click is left to the browser", () => {
    const clicks = [{ button: 1 }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true }, { button: 0, shiftKey: true }, { button: 0, altKey: true }];
    for (const e of clicks) {
      let prevented = false;
      script.onClick({ ...e, preventDefault: () => (prevented = true) });
      expect(prevented).toBe(false);
    }
  });
});

// The CSP fallback does follow the link (a click on a throwaway <a>), by design; what is pinned is no direct navigation.
test("no window.location assignment, location.assign()/replace() or window.open()", () => {
  const code = readFileSync(PATH, "utf-8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  expect(code).not.toMatch(/location(\.href)?\s*=[^=]/);
  expect(code).not.toMatch(/location\.(assign|replace)\s*\(/);
  expect(code).not.toMatch(/window\.open\s*\(/);
});

// The browser user-script (extras/userscript/agendo.user.js). There is no
// browser in either suite, so what is pinned here is what can be without one:
// the link it builds from a page URL, that a click lets the browser follow the
// link with a one-shot beforeunload guard armed, and what that guard does with
// the events it is handed. NOT tested here: that a real browser hands the guard
// beforeunload ahead of the page's handlers (Firefox runs a window's capture
// listeners first; Chromium runs them in the order they were added, so there it
// depends on the script manager injecting at document-start), and that the link
// then reaches the OS handler.
//
// Where the button is mounted is tested against linkedom documents built from
// the Azure DevOps markup as copied out of devtools (trimmed to the parts the
// script looks at). Nobody can drive real Azure DevOps from CI, so what is NOT
// tested is that ADO still renders those classes, and how the button looks.
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
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

describe("an Azure DevOps PR URL that names the repo by its id", () => {
  const GUID = "4b12fdea-5ae3-48d4-a2cd-1f47d10700ce";
  const URL_BY_ID = `https://dev.azure.com/org/proj/_git/${GUID}/pullrequest/81276`;
  const el = (href: string | null) => ({ getAttribute: (n: string) => (n === "href" ? href : null) });
  /** A page with an optional canonical link and the breadcrumb's links (all that `PR_LINKS` selects). */
  const page = (canonical: string | null, crumbs: string[] = []) => ({
    querySelectorAll: () => [...(canonical === null ? [] : [canonical]), ...crumbs].map(el),
  });
  const href = (doc?: unknown) => {
    const t = script.linkFor(loc(URL_BY_ID), doc);
    return t ? script.hrefFor(t) : null;
  };

  test("with no page to read, or a page that does not say, the id goes in the link", () => {
    expect(href()).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
    expect(href(page(null))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
  });

  test("a canonical link to the same PR gives the name", () => {
    expect(href(page("https://dev.azure.com/org/proj/_git/mc-applications/pullrequest/81276"))).toBe("agendo://focus?pr=81276&repo=mc-applications");
  });

  test("a canonical link to another PR, or one that is itself an id, is not used", () => {
    expect(href(page("https://dev.azure.com/org/proj/_git/mc-applications/pullrequest/1"))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
    expect(href(page(URL_BY_ID))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
  });

  test("a breadcrumb link to the same PR gives the name, relative hrefs included", () => {
    expect(href(page(null, ["/org/proj/_git/mc-applications", "/org/proj/_git/mc-applications/pullrequest/81276"]))).toBe(
      "agendo://focus?pr=81276&repo=mc-applications",
    );
  });

  test("links to a repo's root, or to another PR, never name it: the previous PR's breadcrumb may still be on the page", () => {
    expect(href(page(null, ["/org/proj/_git/mc-web", "/org/proj/_git/mc-web/pullrequests"]))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
    expect(href(page(null, ["/org/proj/_git/mc-web/pullrequest/9"]))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
  });

  test("links naming two repos for the PR, or a name agendo would refuse, say nothing", () => {
    expect(href(page(null, ["/org/proj/_git/a-repo/pullrequest/81276", "/org/proj/_git/b-repo/pullrequest/81276"]))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
    expect(href(page(null, ["/org/proj/_git/bad%20name/pullrequest/81276"]))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
  });

  test("a link to the same PR number in another collection is not this PR", () => {
    expect(href(page("https://dev.azure.com/other-org/proj/_git/mc-applications/pullrequest/81276"))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
    expect(href(page("https://example.visualstudio.com/proj/_git/mc-applications/pullrequest/81276"))).toBe(`agendo://focus?pr=81276&repo=${GUID}`);
    expect(href(page("https://dev.azure.com/org/other-proj/_git/mc-applications/pullrequest/81276"))).toBe("agendo://focus?pr=81276&repo=mc-applications");
  });

  test("a URL that already names the repo is not second-guessed by the page", () => {
    const t = script.linkFor(loc("https://dev.azure.com/org/proj/_git/mc-web/pullrequest/9"), page("https://dev.azure.com/org/proj/_git/other/pullrequest/9"));
    expect(script.hrefFor(t)).toBe("agendo://focus?pr=9&repo=mc-web");
  });
});

describe("needsRender", () => {
  const PAGE = "https://dev.azure.com/org/proj/_git/x/pullrequest/1";
  const BY_ID = "agendo://focus?pr=1&repo=4b12fdea-5ae3-48d4-a2cd-1f47d10700ce";
  const r = (href: string, last: string, buttonHref: string | null, since: number, now: number) => script.needsRender(href, last, buttonHref, since, now);

  test("a new URL, or a missing button, always renders", () => {
    expect(r(PAGE, "", "agendo://focus?pr=1&repo=x", 0, 0)).toBe(true);
    expect(r(PAGE, PAGE, null, 0, 0)).toBe(true);
  });

  test("a link with a repo name, or none, is settled", () => {
    expect(r(PAGE, PAGE, "agendo://focus?pr=1&repo=mc-web", 0, 1)).toBe(false);
    expect(r(PAGE, PAGE, "agendo://focus?workItem=1", 0, 1)).toBe(false);
  });

  test("a link with a repo id keeps looking for the name, then settles for the id", () => {
    expect(r(PAGE, PAGE, BY_ID, 1000, 1000 + script.NAME_WAIT_MS - 1)).toBe(true);
    expect(r(PAGE, PAGE, BY_ID, 1000, 1000 + script.NAME_WAIT_MS)).toBe(false);
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

// The PR header's flex row, from devtools: the title row, the Publish split
// button, and the trailing "More actions".
const PR_HEADER = `<div class="flex-row rhythm-horizontal-8 flex-center flex-grow"><div class="repos-pr-title-row inline-flex-row flex-grow rhythm-horizontal-8 flex-center"><input value="title"></div><div class="repos-pr-header-complete-button bolt-split-button flex-stretch inline-flex-row"><button class="bolt-split-button-main bolt-button bolt-icon-button enabled primary bolt-focus-treatment" type="button"><span class="fluent-icons-enabled"><span aria-hidden="true" class="left-icon flex-noshrink fabric-icon ms-Icon--Send medium"></span></span><span class="bolt-button-text body-m">Publish</span></button><div class="bolt-split-button-divider flex-noshrink primary"></div><div class="inline-flex-row"><button aria-label="More actions" class="bolt-split-button-option icon-only"><span class="ms-Icon--ChevronDownMed small"></span></button></div></div><div class="bolt-header-command-item-button bolt-expandable-button inline-flex-row"><button aria-label="More actions" class="icon-only bolt-button bolt-icon-button enabled icon-only bolt-focus-treatment" id="__bolt-menu-button-1"><span class="ms-Icon--MoreVertical medium"></span></button></div></div>`;

// The work item header's command bar, from devtools: Save, Follow, Refresh, Revert, More actions.
const WI_BAR = `<div class="work-item-header-command-bar flex-row flex-grow flex-self-start bolt-header-commandbar bolt-button-group flex-row" role="toolbar"><div class="work-item-header-command-bar flex-row flex-grow flex-self-start bolt-header-commandbar-button-group flex-row flex-center flex-grow scroll-hidden rhythm-horizontal-8"><button aria-disabled="true" class="bolt-header-command-item-button bolt-button bolt-icon-button disabled primary bolt-focus-treatment" id="__bolt-save"><span class="fluent-icons-enabled"><span class="left-icon flex-noshrink fabric-icon ms-Icon--Save medium"></span></span><span class="bolt-button-text body-m">Save</span></button><div class="flex-noshrink bolt-header-command-item-button bolt-split-button">Follow</div><button aria-label="Refresh" class="bolt-header-command-item-button bolt-button bolt-icon-button enabled subtle icon-only bolt-focus-treatment" id="__bolt-refresh"></button><button aria-label="Revert Changes" id="__bolt-revert"></button><div class="bolt-header-command-item-button bolt-expandable-button inline-flex-row"><button aria-label="More actions">More</button></div></div></div>`;

const ADO_PR = "https://dev.azure.com/org/proj/_git/mc-applications/pullrequest/81276";
const ADO_WI = "https://dev.azure.com/org/proj/_workitems/edit/102";

/** An element of a linkedom document (the project's tsconfig has no DOM lib). */
type El = ReturnType<ReturnType<typeof parseHTML>["document"]["createElement"]>;

/** A document whose body holds `html`, and a sync over it with a fixed clock. */
function page(html: string) {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  const state = {};
  const sync = (url: string, now = 0): number => script.sync(document, loc(url), state, now);
  const buttons = () => [...document.querySelectorAll(`[${script.MARK}]`)] as El[];
  return { document, state, sync, buttons };
}

describe("sync: where the button goes", () => {
  test("ADO PR: just before the Publish/Complete button, as a plain, non-primary bolt-button with an icon", () => {
    const { document, sync, buttons } = page(PR_HEADER);
    sync(ADO_PR);
    const [b] = buttons();
    expect(buttons()).toHaveLength(1);
    expect(b.nextElementSibling).toBe(document.querySelector(".repos-pr-header-complete-button"));
    expect(b.previousElementSibling!.className).toContain("repos-pr-title-row");
    expect(b.tagName).toBe("A");
    expect(b.getAttribute("href")).toBe("agendo://focus?pr=81276&repo=mc-applications");
    expect(b.className.split(" ")).toContain("bolt-button");
    expect(b.className.split(" ")).not.toContain("primary");
    expect(b.className).not.toContain("split");
    expect(b.querySelector(".ms-Icon--OpenInNewWindow")).not.toBeNull();
    expect(b.querySelector(".bolt-button-text")!.textContent).toBe("agendo");
    expect(b.style.position).toBe("");
  });

  test("ADO PR with no Complete button (completed, abandoned): right after the title row", () => {
    const { document, sync, buttons } = page(PR_HEADER);
    document.querySelector(".repos-pr-header-complete-button")!.remove();
    sync(ADO_PR);
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].previousElementSibling!.className).toContain("repos-pr-title-row");
  });

  test("ADO work item: in the command bar's button group, before the trailing More actions, as a subtle command item", () => {
    const { document, sync, buttons } = page(WI_BAR);
    sync(ADO_WI);
    const [b] = buttons();
    expect(buttons()).toHaveLength(1);
    expect(b.parentElement!.className).toContain("bolt-header-commandbar-button-group");
    expect(b.nextElementSibling!.className).toContain("bolt-expandable-button");
    expect(b.previousElementSibling!.id).toBe("__bolt-revert");
    expect(b.className.split(" ")).toEqual(expect.arrayContaining(["bolt-header-command-item-button", "bolt-button", "bolt-icon-button", "enabled", "subtle"]));
    expect(b.className.split(" ")).not.toContain("primary");
    expect(b.querySelector(".bolt-button-text")!.textContent).toBe("agendo");
    expect(b.getAttribute("href")).toBe("agendo://focus?workItem=102");
    void document;
  });

  test("ADO work item dialog over a board: the dialog's bar, and only one button even with two bars", () => {
    const { document, sync, buttons } = page(`<div class="page">${WI_BAR}</div><div role="dialog">${WI_BAR}</div>`);
    sync("https://dev.azure.com/org/proj/_boards/board/t/team/Stories?workitem=7");
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].closest('[role="dialog"]')).not.toBeNull();
    expect(buttons()[0].getAttribute("href")).toBe("agendo://focus?workItem=7");
    // A dialog opened over a work item page leaves the URL's item on the page's own bar.
    sync(ADO_WI);
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].closest('[role="dialog"]')).toBeNull();
    expect(buttons()[0].closest(".page")).not.toBeNull();
    // An edit path names the item even with ?workitem= on it, as in linkFor: the page's bar, not the dialog's.
    sync(`${ADO_WI}?workitem=7`);
    expect(buttons().map((b) => [b.getAttribute("href"), b.closest('[role="dialog"]')])).toEqual([["agendo://focus?workItem=102", null]]);
    void document;
  });

  test("GitHub classic header actions: first in the row, as a btn", () => {
    const { document, sync, buttons } = page(`<div class="gh-header-actions"><button class="btn">Edit</button></div>`);
    sync("https://github.com/MiniGod/agendo/pull/137");
    expect(buttons()).toHaveLength(1);
    expect(document.querySelector(".gh-header-actions")!.firstElementChild).toBe(buttons()[0]);
    expect(buttons()[0].className).toBe("btn btn-sm");
    sync("https://github.com/MiniGod/agendo/pull/137");
    expect(document.querySelector(".gh-header-actions")!.firstElementChild).toBe(buttons()[0]);
  });
});

describe("sync: across re-renders", () => {
  test("once placed, repeated syncs keep one button and write nothing to the DOM, so the observer cannot loop", () => {
    const pages: [string, string, (d: ReturnType<typeof page>["document"]) => void, number][] = [
      ["PR before Complete", PR_HEADER, () => {}, 0],
      ["PR with no Complete button", PR_HEADER, (d) => d.querySelector(".repos-pr-header-complete-button")!.remove(), 0],
      ["work item bar", WI_BAR, () => {}, 0],
      ["work item bar with no More actions", WI_BAR, (d) => d.querySelector(".bolt-expandable-button")!.remove(), 0],
      ["GitHub header actions", `<div class="gh-header-actions"><button class="btn">Edit</button></div>`, () => {}, 0],
      ["floating", `<div>another layout</div>`, () => {}, script.FALLBACK_MS],
    ];
    for (const [name, html, prepare, at] of pages) {
      const p = page(html);
      prepare(p.document);
      const url = name.startsWith("work item") ? ADO_WI : name.startsWith("GitHub") ? "https://github.com/MiniGod/agendo/pull/1" : ADO_PR;
      p.sync(url, 0);
      p.sync(url, at);
      const first = p.buttons()[0];
      expect([name, p.buttons().length]).toEqual([name, 1]);
      // linkedom reports mutations through MutationObserver as a browser does; count every one.
      const records: unknown[] = [];
      const mo = new p.document.defaultView.MutationObserver((r: unknown[]) => records.push(...r));
      mo.observe(p.document.body, { childList: true, subtree: true, attributes: true });
      for (let i = 1; i <= 5; i++) p.sync(url, at + i);
      records.push(...mo.takeRecords());
      mo.disconnect();
      expect([name, p.buttons()]).toEqual([name, [first]]);
      expect([name, records.length]).toEqual([name, 0]);
    }
  });

  test("a container the app replaced gets the button back, once", () => {
    const { document, sync, buttons } = page(PR_HEADER);
    sync(ADO_PR);
    const old = document.body.firstElementChild!;
    old.remove();
    document.body.insertAdjacentHTML("beforeend", PR_HEADER);
    sync(ADO_PR, 100);
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].nextElementSibling).toBe(document.querySelector(".repos-pr-header-complete-button"));
    expect(document.body.contains(buttons()[0])).toBe(true);
  });

  test("a button the app moved out of place goes back before the Complete button", () => {
    const { document, sync, buttons } = page(PR_HEADER);
    sync(ADO_PR);
    document.body.appendChild(buttons()[0]);
    sync(ADO_PR, 100);
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].nextElementSibling).toBe(document.querySelector(".repos-pr-header-complete-button"));
  });

  test("stray copies (another instance of the script, a cloned subtree) are removed", () => {
    const { document, sync, buttons } = page(PR_HEADER + WI_BAR);
    sync(ADO_PR);
    document.querySelector(".bolt-header-commandbar-button-group")!.appendChild(buttons()[0].cloneNode(true));
    expect(buttons()).toHaveLength(2);
    sync(ADO_PR, 100);
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].nextElementSibling!.className).toContain("repos-pr-header-complete-button");
  });

  test("a copy cloned ahead of the original may be the one kept, and still arms the guard on click", () => {
    const { document, sync, buttons } = page(PR_HEADER);
    sync(ADO_PR);
    const original = buttons()[0];
    const row = original.parentElement!;
    row.insertBefore(original.cloneNode(true), row.firstElementChild);
    sync(ADO_PR, 100);
    expect(buttons()).toHaveLength(1);
    let arms = 0;
    document.addEventListener("click", script.delegate(() => (arms++, () => {}), () => {}, () => {}), true);
    const text = buttons()[0].querySelector(".bolt-button-text")!;
    text.dispatchEvent(Object.assign(new document.defaultView.Event("click", { bubbles: true }), { button: 0 }));
    expect(arms).toBe(1);
  });

  test("navigating relabels the button, moves it to the new page's row, and removes it where there is no link", () => {
    const { sync, buttons } = page(PR_HEADER + WI_BAR);
    sync(ADO_PR);
    sync("https://dev.azure.com/org/proj/_git/mc-applications/pullrequest/9", 10);
    expect(buttons().map((b) => b.getAttribute("href"))).toEqual(["agendo://focus?pr=9&repo=mc-applications"]);
    sync(ADO_WI, 20);
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0].parentElement!.className).toContain("bolt-header-commandbar-button-group");
    expect(buttons()[0].title).toBe("Focus the agendo session for work item 102");
    sync("https://dev.azure.com/org/proj/_boards/board", 30);
    expect(buttons()).toHaveLength(0);
  });
});

describe("sync: the floating fallback", () => {
  test("no known row within FALLBACK_MS of the URL change floats a small button, bottom left", () => {
    const { document, sync, buttons } = page(`<div>another layout</div>`);
    sync(ADO_PR, 1000);
    sync(ADO_PR, 1000 + script.FALLBACK_MS - 1);
    expect(buttons()).toHaveLength(0);
    sync(ADO_PR, 1000 + script.FALLBACK_MS);
    const [b] = buttons();
    expect(buttons()).toHaveLength(1);
    expect(b.parentElement).toBe(document.body);
    expect([b.style.position, b.style.left, b.style.bottom]).toEqual(["fixed", "8px", "8px"]);
    expect(b.style.right).toBe("");
    expect(b.getAttribute("href")).toBe("agendo://focus?pr=81276&repo=mc-applications");
  });

  test("while waiting, sync says when the button is due to float, so a quiet page still gets it", () => {
    const { sync } = page(`<div>another layout</div>`);
    expect(sync(ADO_PR, 1000)).toBe(script.FALLBACK_MS);
    expect(sync(ADO_PR, 1800)).toBe(script.FALLBACK_MS - 800);
    expect(sync(ADO_PR, 1000 + script.FALLBACK_MS)).toBe(0);
    const inline = page(PR_HEADER);
    expect(inline.sync(ADO_PR, 0)).toBe(0);
  });

  test("GitHub's React layout, with no classic header actions, falls back too", () => {
    const { sync, buttons } = page(`<div>react</div>`);
    sync("https://github.com/MiniGod/agendo/issues/5", 0);
    sync("https://github.com/MiniGod/agendo/issues/5", script.FALLBACK_MS);
    expect(buttons().map((b) => b.getAttribute(script.MARK))).toEqual(["float"]);
  });

  test("a row that renders late replaces the floating button", () => {
    const { document, sync, buttons } = page(``);
    sync(ADO_PR, 0);
    sync(ADO_PR, script.FALLBACK_MS);
    expect(buttons().map((b) => b.getAttribute(script.MARK))).toEqual(["float"]);
    document.body.insertAdjacentHTML("beforeend", PR_HEADER);
    sync(ADO_PR, script.FALLBACK_MS + 1);
    expect(buttons().map((b) => b.getAttribute(script.MARK))).toEqual(["ado-pr"]);
  });

  test("a row that a re-render takes away for a moment does not bring the floating button back", () => {
    const { document, sync, buttons } = page(PR_HEADER);
    sync(ADO_PR, 0);
    document.body.firstElementChild!.remove();
    sync(ADO_PR, script.FALLBACK_MS * 2);
    expect(buttons()).toHaveLength(0);
    document.body.insertAdjacentHTML("beforeend", PR_HEADER);
    sync(ADO_PR, script.FALLBACK_MS * 2 + 1);
    expect(buttons().map((b) => b.getAttribute(script.MARK))).toEqual(["ado-pr"]);
  });
});

describe("the button's click", () => {
  test("a click on or inside any place's button arms the guard; a modified click, or a click elsewhere, does not", () => {
    for (const place of ["ado-pr", "ado-wi", "github", "float"]) {
      const { document } = parseHTML("<!doctype html><html><body><p>elsewhere</p></body></html>");
      let arms = 0;
      document.addEventListener("click", script.delegate(() => (arms++, () => {}), () => {}, () => {}), true);
      const b = script.makeButton(document, place);
      b.setAttribute("href", "agendo://focus?pr=1");
      document.body.appendChild(b);
      const click = (el: El, extra: Record<string, unknown>) => el.dispatchEvent(Object.assign(new document.defaultView.Event("click", { bubbles: true }), extra));
      click(b.firstElementChild ?? b, { button: 0 });
      click(b, { button: 0, ctrlKey: true });
      click(document.querySelector("p")!, { button: 0 });
      expect([place, arms]).toEqual([place, 1]);
    }
  });
});

describe("batched", () => {
  test("any number of calls before the frame runs it once; a call after the frame schedules again", () => {
    const frames: (() => void)[] = [];
    let runs = 0;
    const schedule = script.batched(() => runs++, (fn: () => void) => frames.push(fn));
    schedule();
    schedule();
    schedule();
    expect([frames.length, runs]).toEqual([1, 0]);
    frames[0]();
    expect(runs).toBe(1);
    schedule();
    expect(frames.length).toBe(2);
  });
});

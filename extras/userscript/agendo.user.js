// ==UserScript==
// @name         Open in agendo
// @namespace    https://github.com/MiniGod/agendo
// @version      1.5.0
// @description  Adds an "Open in agendo" button to Azure DevOps and GitHub pull requests and work items. It focuses the agendo session for that PR or work item, resuming it first if it is paused or idle.
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @match        https://github.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==
//
// The button is a plain link to agendo://focus?pr=<id> or ?workItem=<id>, plus
// &repo=<repo> when the page URL names one: `owner/name` on GitHub, where PR and
// issue numbers are per repository, and the repo name on an Azure DevOps PR. The
// browser hands it to whatever `agendo url-handler install` registered, which
// runs `agendo url <link>`. That command accepts nothing but those forms (plus
// ?session=<id>), so this script never needs to escape anything: it puts in the
// link a run of digits from the page URL, and a repo from the page URL only when
// it already has exactly the shape agendo accepts — otherwise it leaves the repo
// out rather than mangle it.
//
// An Azure DevOps PR URL can name the repo by its id instead of its name
// (`/_git/<guid>/pullrequest/N`, as notifications and the PR hub link it). Then
// the script looks for the name on the page — a canonical link or breadcrumb
// link to this same PR by name — and sends the GUID only when the page does not
// say, which agendo resolves itself (src/cli/focus/linked.ts). The breadcrumb
// renders after the URL changes, so while the link still carries a GUID the
// script keeps looking, for ten seconds at most.
//
// The button sits in the page's own button row, styled as one of its buttons:
// in an Azure DevOps PR header just before Publish/Approve/Complete, in a work
// item's command bar (page or dialog) before its trailing "More actions", and
// in GitHub's classic PR/issue header actions. Up to 1.4.0 it floated over the
// bottom right corner, where it covered buttons of the page's own. Both apps are
// single-page apps that render those rows after load and replace them on
// navigation and re-renders, so one MutationObserver on the body, batched to a
// frame, re-reads the location and puts the button back, relabels it or
// removes it (`sync`). Where no known row shows up within FALLBACK_MS of a URL
// change (another layout, GitHub's React pages), the button floats again, but
// small and faded, in the bottom left corner.
//
// A click follows the link like any other: the browser hands it to the
// desktop's handler, and since an external protocol returns no document, the
// page is not replaced. But browsers fire beforeunload first anyway — Firefox
// says so in nsDocShell ("other browsers fire beforeunload for external
// protocols, so keep doing that") — and Azure DevOps then drops its live-update
// connection and shows an "updates paused" warning. (The jQuery SignalR 2.x
// client binds, in Firefox only, a beforeunload handler that stops the
// connection: jquery.signalR.core.js, "Firefox does not fire cross-domain XHRs
// in the normal unload handler".) So the click arms a one-shot guard (`guard`)
// that swallows that one beforeunload before the page's handlers see it — in
// Chromium, the handlers added after the guard, which document-start makes all
// of them when the script manager injects in time. No pagehide or unload
// follows, since nothing commits.
//
// 1.2.0 launched from a hidden iframe instead, and did nothing on Azure DevOps:
// its enforced Content-Security-Policy says `frame-src http: https: blob: tfs:`,
// and Firefox subjects external schemes to frame-src (nsCSPService.cpp), so the
// frame was refused. GitHub's frame-src names two hosts and refuses it too.
// window.open would dodge CSP but leaves a blank tab behind in some browsers.
// Nothing in this script assigns window.location or opens a window.
//
// Set localStorage["agendo.debug"] = "1" on the page (devtools console) to log
// to the console what each click did and whether the guard caught the event.
(function () {
  "use strict";

  const BUTTON_ID = "agendo-open-button";

  /** The repo shape `agendo url` accepts (src/cli/focus/url.ts); anything else is left out of the link. */
  const REPO_RE = /^(?=.{1,120}$)[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;

  /** `raw` as a repo for the link, or undefined when it is not one agendo would accept. */
  function repoOf(raw) {
    let repo;
    try {
      repo = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    return REPO_RE.test(repo) ? repo : undefined;
  }

  /** An Azure DevOps repository id, as a PR URL may carry in place of the repo name. */
  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Where the page may name this PR's repo. Only links to the PR itself count:
   * a repo-root link (the left nav's "Files", or the previous PR's breadcrumb
   * still in the DOM) can name another repo, and a wrong name is worse than the
   * id, which agendo can still resolve. ADO numbers PRs across the whole
   * collection, so `/_git/<name>/pullrequest/<id>` within this page's
   * collection names this PR's repo wherever it stands.
   */
  const PR_LINKS = 'link[rel="canonical"][href], .bolt-breadcrumb a[href*="/pullrequest/"]';

  /** How long after a URL change the poll keeps looking for a repo id's name before settling for the id. */
  const NAME_WAIT_MS = 10000;

  /** The collection a URL is in: its origin, plus the organization on dev.azure.com. */
  function collectionOf(url) {
    return url.hostname === "dev.azure.com" ? `${url.origin}/${url.pathname.split("/")[1]}` : url.origin;
  }

  /**
   * The repo name an href to PR `id` (resolved against `base`) names, if it is a
   * name rather than an id and the href is in `base`'s collection.
   */
  function nameInHref(href, base, id) {
    let path;
    try {
      const url = new URL(href, base);
      if (collectionOf(url) !== collectionOf(new URL(base))) return undefined;
      path = url.pathname;
    } catch {
      return undefined;
    }
    const m = new RegExp(`/_git/([^/]+)/pullrequest/${id}(?:/|$)`, "i").exec(path);
    const repo = m ? repoOf(m[1]) : undefined;
    return repo && !GUID_RE.test(repo) ? repo : undefined;
  }

  /**
   * The repo name `doc` shows for PR `id` at `loc`, read off its canonical link
   * or breadcrumb links to that PR — only when they all name the same one.
   * Undefined when the page does not say.
   */
  function repoNameOnPage(doc, loc, id) {
    const names = new Set();
    for (const el of doc.querySelectorAll(PR_LINKS)) {
      const n = nameInHref(el.getAttribute("href") || "", loc.href, id);
      if (n) names.add(n);
    }
    return names.size === 1 ? [...names][0] : undefined;
  }

  /** An Azure DevOps PR's repo: the URL's, unless that is an id and `doc` shows the name. */
  function adoPrRepo(raw, id, loc, doc) {
    const repo = repoOf(raw);
    if (!repo || !GUID_RE.test(repo) || !doc) return repo;
    return repoNameOnPage(doc, loc, id) || repo;
  }

  /**
   * The agendo:// link for the page at `loc`, or null when it is not a PR or
   * work item. `doc` is where a repo id's name is looked for; without it, the id is used.
   */
  function linkFor(loc, doc) {
    const host = loc.hostname;
    const path = loc.pathname;
    let m;
    if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
      if ((m = /\/_git\/([^/]+)\/pullrequest\/(\d+)(?:\/|$)/i.exec(path))) return { kind: "pr", id: m[2], repo: adoPrRepo(m[1], m[2], loc, doc) };
      if ((m = /\/_workitems\/edit\/(\d+)(?:\/|$)/i.exec(path))) return { kind: "workItem", id: m[1] };
      // A work item opened as a dialog over a board, backlog or query.
      const wi = new URLSearchParams(loc.search).get("workitem");
      if (wi && /^\d+$/.test(wi)) return { kind: "workItem", id: wi };
      return null;
    }
    if (host === "github.com") {
      if ((m = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/.exec(path))) return { kind: "pr", id: m[2], repo: repoOf(m[1]) };
      if ((m = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/.exec(path))) return { kind: "workItem", id: m[2], repo: repoOf(m[1]) };
    }
    return null;
  }

  /**
   * Whether the link must be worked out again: the URL changed, there is no
   * button yet, or the link still carries a repo id and the page has had less than NAME_WAIT_MS
   * since the URL changed (`since`) to show the name.
   */
  function needsRender(href, last, buttonHref, since, now) {
    if (href !== last || buttonHref === null) return true;
    const repo = new URLSearchParams(buttonHref.split("?")[1] || "").get("repo") || "";
    return GUID_RE.test(repo) && now - since < NAME_WAIT_MS;
  }

  /** The href for a `linkFor` result. */
  function hrefFor(target) {
    return `agendo://focus?${target.kind}=${target.id}${target.repo ? `&repo=${target.repo}` : ""}`;
  }

  /**
   * How long a click keeps the guard armed, waiting for the browser's
   * beforeunload. Chromium fires it while handling the click and Firefox a
   * task later, so this is slack, kept short because a real unload in that
   * window (the tab closing) would be swallowed too.
   */
  const GUARD_MS = 1000;

  /** localStorage key that switches on console logging of what the button did. */
  const DEBUG_KEY = "agendo.debug";

  /**
   * console.info `args` when localStorage[DEBUG_KEY] is "1" — info, not
   * debug, which Chromium's console hides by default. `storage` and `out` are
   * injected for tests; storage that throws (blocked site data), even on
   * access, means off.
   */
  function debug(args, storage = () => globalThis.localStorage, out = console) {
    let on = false;
    try {
      on = storage().getItem(DEBUG_KEY) === "1";
    } catch {
      return;
    }
    if (on) out.info("[agendo]", ...args);
  }

  /**
   * Install the beforeunload guard on `win` and return its `arm`. Once armed,
   * the next beforeunload stops at this listener, so the page's handlers
   * after it never see it. Which handlers come after depends on the engine,
   * as measured in real Chromium and Firefox: Firefox runs a window's capture
   * listeners before its bubble ones (EventDispatcher.cpp) and skips the
   * bubble pass once propagation is stopped, so it beats every bubble handler
   * whenever it was added; Chromium runs a window's listeners in the order
   * they were added, so it beats only those added after it — hence
   * @run-at document-start. The guard neither cancels the event nor sets
   * returnValue, which would raise the "leave this page?" prompt. It disarms
   * after that one event, or after GUARD_MS if none comes; `arm` returns a
   * `disarm` for a click that turns out not to navigate. While armed, a
   * beforeunload of the page's own — the tab closing — is swallowed too, so
   * the window is kept short. `later` and `log` are injected for tests.
   */
  function guard(win = window, later = setTimeout, log = debug) {
    let armed = null;
    win.addEventListener("beforeunload", (e) => {
      if (!armed) return;
      armed = null;
      e.stopImmediatePropagation();
      log(["stopped beforeunload: page listeners added after the guard were skipped"]);
    }, true);
    return function arm() {
      const token = {};
      armed = token;
      later(() => {
        if (armed !== token) return;
        armed = null;
        log([`no beforeunload within ${GUARD_MS}ms; guard disarmed`]);
      }, GUARD_MS);
      return () => {
        if (armed === token) armed = null;
      };
    };
  }

  /**
   * The button's click. A plain click arms the guard and lets the browser
   * follow the link itself, with the click's user activation intact; a
   * modified click is left to the browser unguarded. A page listener that runs
   * after this one may still cancel the click, and then no beforeunload comes:
   * a task later, once the click has been dispatched to every listener, a
   * cancelled click disarms the guard again. `link` is the button clicked.
   * `later` and `log` are injected for tests.
   */
  function onClick(e, arm, later = setTimeout, log = debug, link = e.currentTarget) {
    const href = link.getAttribute("href");
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
      log([`modified click on ${href}: left to the browser`]);
      return;
    }
    const disarm = arm();
    log([`following ${href}; beforeunload guard armed for ${GUARD_MS}ms`]);
    later(() => {
      if (!e.defaultPrevented) return;
      disarm();
      log(["the page cancelled the click, so the link was not followed; guard disarmed"]);
    }, 0);
  }

  /** Marks every button this script inserted, wherever it stands, so a stray copy is always found. */
  const MARK = "data-agendo-button";

  /** How long after a URL change the script waits for a known mount point before floating the button instead. */
  const FALLBACK_MS = 3000;

  function isAdo(host) {
    return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
  }

  /**
   * The work item header's button group to mount in. A work item opened as a
   * dialog over a board, backlog or query (`?workitem=<id>`) has its command
   * bar in the dialog; one opened as a dialog over a work item page leaves the
   * page's own bar showing the URL's item. So the URL picks which bar, by the
   * same rule as `linkFor` (an edit path wins over `?workitem=`), and either
   * way only one is used.
   */
  function workItemGroup(doc, loc) {
    const groups = [...doc.querySelectorAll(".work-item-header-command-bar .bolt-header-commandbar-button-group")];
    if (!groups.length) return null;
    const wantDialog = !/\/_workitems\/edit\/\d+(?:\/|$)/i.test(loc.pathname) && new URLSearchParams(loc.search).has("workitem");
    const fit = groups.filter((g) => !!g.closest('[role="dialog"]') === wantDialog);
    if (fit.length) return wantDialog ? fit[fit.length - 1] : fit[0];
    return wantDialog ? groups[groups.length - 1] : groups[0];
  }

  /**
   * Where the button for `target` goes on `doc`: a `place` (which look it
   * gets), the `parent` it goes in and the element it goes just `before`
   * (null: last). Null when the page shows none of the known button rows yet.
   */
  function mountFor(doc, loc, target) {
    if (isAdo(loc.hostname)) {
      if (target.kind === "pr") {
        const complete = doc.querySelector(".repos-pr-header-complete-button");
        if (complete && complete.parentElement) return { place: "ado-pr", parent: complete.parentElement, before: complete };
        // A completed or abandoned PR may show no Complete button: then right after the title.
        const title = doc.querySelector(".repos-pr-title-row");
        if (!title || !title.parentElement) return null;
        let before = title.nextElementSibling;
        while (before && before.hasAttribute(MARK)) before = before.nextElementSibling;
        return { place: "ado-pr", parent: title.parentElement, before };
      }
      const group = workItemGroup(doc, loc);
      if (!group) return null;
      const more = [...group.children].filter((c) => c.classList.contains("bolt-expandable-button")).pop();
      return { place: "ado-wi", parent: group, before: more || null };
    }
    const actions = doc.querySelector(".gh-header-actions");
    if (!actions) return null;
    return { place: "github", parent: actions, before: [...actions.children].find((c) => !c.hasAttribute(MARK)) || null };
  }

  /** The classes each inline place's button wears: ADO's own bolt-button, never `primary`, and GitHub's btn. */
  const CLASSES = {
    "ado-pr": "bolt-button bolt-icon-button enabled bolt-focus-treatment",
    "ado-wi": "bolt-header-command-item-button bolt-button bolt-icon-button enabled subtle bolt-focus-treatment",
    github: "btn btn-sm",
  };

  /**
   * A new button for `place`. Built with createElement throughout, not
   * innerHTML, which a Trusted Types policy would refuse. Its click is
   * handled by `delegate`, not by a listener of its own.
   */
  function makeButton(doc, place) {
    const a = doc.createElement("a");
    a.id = BUTTON_ID;
    a.setAttribute(MARK, place);
    if (place === "float") {
      a.textContent = "agendo";
      // Small and out of the way: bottom left, where neither app keeps its
      // primary actions, and faded until pointed at.
      Object.assign(a.style, {
        position: "fixed",
        left: "8px",
        bottom: "8px",
        zIndex: "2147483647",
        padding: "2px 8px",
        borderRadius: "10px",
        background: "#1f6feb",
        color: "#fff",
        font: "600 11px/1.4 system-ui, sans-serif",
        textDecoration: "none",
        opacity: "0.55",
        cursor: "pointer",
      });
      a.addEventListener("mouseenter", () => (a.style.opacity = "1"));
      a.addEventListener("mouseleave", () => (a.style.opacity = "0.55"));
    } else {
      a.className = CLASSES[place];
      a.style.textDecoration = "none";
      if (place === "github") {
        a.textContent = "agendo";
      } else {
        a.setAttribute("data-is-focusable", "true");
        const wrap = doc.createElement("span");
        wrap.className = "fluent-icons-enabled";
        const icon = doc.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.className = "left-icon flex-noshrink fabric-icon ms-Icon--OpenInNewWindow medium";
        wrap.appendChild(icon);
        const text = doc.createElement("span");
        text.className = "bolt-button-text body-m";
        text.textContent = "agendo";
        a.append(wrap, text);
      }
    }
    return a;
  }

  /**
   * The click listener, for the whole document, that hands a click on any
   * copy of the button to `onClick`. A copy the app cloned with its subtree
   * (GitHub's restored page snapshots, a re-rendered header) carries the mark
   * but none of the original's listeners, and `sync` may keep it rather than
   * the original, so the button's own listener could not be relied on.
   * `later` and `log` are injected for tests.
   */
  function delegate(arm, later = setTimeout, log = debug) {
    return (e) => {
      const link = e.target && typeof e.target.closest === "function" ? e.target.closest(`[${MARK}]`) : null;
      if (link) onClick(e, arm, later, log, link);
    };
  }

  /**
   * Bring `doc`'s button in line with the page at `loc`, as of `now`. `state`
   * carries what an earlier call learned: the URL (`url`) and when it changed
   * (`since`), its link (`target`), and since when the page has shown no
   * mount point (`missing`, null while it shows one). The button goes inline
   * where the page has a known mount point. With none for FALLBACK_MS — since
   * the URL changed, or since a mount point it had went away — it floats; in
   * between it is not shown (but a floating button from before is kept), so a
   * re-render that takes the row away for a moment does not flash it. Every
   * other copy is removed, and nothing is written when the button already
   * stands where it should, so a call that changes nothing triggers no further
   * mutation. Returns in how many ms to look again when nothing in the DOM may
   * say so — the button is due to float, or the link still carries a repo id
   * whose name the page may yet show (see `needsRender`) — else 0.
   */
  function sync(doc, loc, state, now) {
    if (loc.href !== state.url) Object.assign(state, { url: loc.href, since: now, target: undefined, missing: now });
    if (state.target === undefined || (state.target && needsRender(loc.href, state.url, hrefFor(state.target), state.since, now))) {
      state.target = linkFor(loc, doc);
    }
    const target = state.target;
    const existing = [...doc.querySelectorAll(`[${MARK}]`)];
    if (!target) {
      for (const el of existing) el.remove();
      return 0;
    }
    const mount = mountFor(doc, loc, target);
    if (mount) state.missing = null;
    else if (state.missing === null) state.missing = now;
    let want = mount;
    if (!want && now - state.missing >= FALLBACK_MS) want = { place: "float", parent: doc.body, before: null };
    let button;
    if (want) {
      button = existing.find((el) => el.getAttribute(MARK) === want.place);
      if (!button) button = makeButton(doc, want.place);
      const placed = button.parentElement === want.parent && (want.place === "float" || button.nextElementSibling === want.before);
      if (!placed) want.parent.insertBefore(button, want.before);
    } else {
      // Waiting: only a floating button from before is kept, so it does not flicker.
      button = existing.find((el) => el.getAttribute(MARK) === "float");
    }
    for (const el of existing) if (el !== button) el.remove();
    const naming = needsRender(loc.href, state.url, hrefFor(target), state.since, now) ? Math.min(500, state.since + NAME_WAIT_MS - now) : 0;
    if (!button) return Math.min(state.missing + FALLBACK_MS - now, naming || Infinity);
    const href = hrefFor(target);
    if (button.getAttribute("href") !== href) {
      button.setAttribute("href", href);
      button.title = target.kind === "pr" ? `Focus the agendo session for PR ${target.id}` : `Focus the agendo session for work item ${target.id}`;
    }
    return naming;
  }

  /**
   * `run`, at most once a frame however many times this is called before the
   * frame comes: ADO's DOM mutates constantly, and one sync per batch is
   * enough. `frame` is injected for tests.
   */
  function batched(run, frame = (fn) => requestAnimationFrame(fn)) {
    let pending = false;
    return function schedule() {
      if (pending) return;
      pending = true;
      frame(() => {
        pending = false;
        run();
      });
    };
  }

  // Under `bun test` (test/userscript.test.ts), which loads this file as a
  // CommonJS module: hand over the pieces and leave the DOM alone. With
  // `@grant none` the script runs in the page's own realm, where a loader shim
  // may well define a global `module` — so the test is for the script manager,
  // whose GM_info every one of them (Tampermonkey, Violentmonkey,
  // Greasemonkey 4) defines even then.
  if (typeof GM_info === "undefined" && typeof module === "object" && module && module.exports) {
    module.exports = {
      linkFor, hrefFor, needsRender, NAME_WAIT_MS, debug, guard, onClick, GUARD_MS, DEBUG_KEY,
      mountFor, makeButton, delegate, sync, batched, FALLBACK_MS, MARK, BUTTON_ID,
    };
    return;
  }

  // First, before the page's own scripts where @run-at document-start allows,
  // so in Chromium the guard runs ahead of every beforeunload listener they
  // add (see `guard`). A script manager that injects late leaves Chromium's
  // earlier listeners unguarded; Firefox's bubble listeners stay guarded.
  const arm = guard();
  debug([`guard installed at readyState ${document.readyState}`]);
  document.addEventListener("click", delegate(arm), true);

  // While the button waits to float, or for a repo id's name, a timer comes
  // back for it: a page that has stopped changing gives the observer nothing
  // to report, and a name may arrive as an attribute change or in <head>.
  const state = {};
  let wake = null;
  const schedule = batched(() => {
    if (!document.body) return;
    // A monotonic clock: a wall clock stepped back would hold the float and the name wait off by the step.
    const wait = sync(document, window.location, state, performance.now());
    clearTimeout(wake);
    wake = wait > 0 ? setTimeout(schedule, wait + 1) : null;
  });

  // The button rows are rendered by the app after load, and replaced whenever
  // it re-renders them, so every batch of DOM changes is a reason to look.
  const observer = new MutationObserver(schedule);
  let observed = null;
  function observe() {
    if (!document.body || observed === document.body) return;
    // A page that swaps in a new body (GitHub's Turbo) leaves the old one behind: watch only the new.
    observer.disconnect();
    observed = document.body;
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  // A pushState navigation fires no event and may mutate nothing at first, so
  // a cheap check of the URL backs the observer up.
  let lastUrl = "";
  function checkUrl() {
    observe();
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    schedule();
  }

  window.addEventListener("popstate", checkUrl);
  document.addEventListener("DOMContentLoaded", checkUrl);
  setInterval(checkUrl, 500);
  checkUrl();
})();

// ==UserScript==
// @name         Open in agendo
// @namespace    https://github.com/MiniGod/agendo
// @version      1.3.0
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
// Azure DevOps and GitHub are both single-page apps: moving from one PR to
// another changes the URL without loading a page. So the script re-reads the
// location whenever it changes and moves, relabels or removes the button.
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

  /** The agendo:// link for the page at `loc`, or null when it is not a PR or work item. */
  function linkFor(loc) {
    const host = loc.hostname;
    const path = loc.pathname;
    let m;
    if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
      if ((m = /\/_git\/([^/]+)\/pullrequest\/(\d+)(?:\/|$)/i.exec(path))) return { kind: "pr", id: m[2], repo: repoOf(m[1]) };
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
   * cancelled click disarms the guard again. `later` and `log` are injected
   * for tests.
   */
  function onClick(e, arm, later = setTimeout, log = debug) {
    const href = e.currentTarget.getAttribute("href");
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

  function render() {
    const target = linkFor(window.location);
    let button = document.getElementById(BUTTON_ID);
    if (!target) {
      if (button) button.remove();
      return;
    }
    if (!button) {
      button = document.createElement("a");
      button.id = BUTTON_ID;
      button.textContent = "Open in agendo";
      Object.assign(button.style, {
        position: "fixed",
        right: "16px",
        bottom: "16px",
        zIndex: "2147483647",
        padding: "8px 14px",
        borderRadius: "6px",
        background: "#1f6feb",
        color: "#fff",
        font: "600 13px/1.2 system-ui, sans-serif",
        textDecoration: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,.3)",
        cursor: "pointer",
      });
      button.addEventListener("click", (e) => onClick(e, arm));
      document.body.appendChild(button);
    }
    const href = hrefFor(target);
    if (button.getAttribute("href") !== href) {
      button.setAttribute("href", href);
      button.title = target.kind === "pr" ? `Focus the agendo session for PR ${target.id}` : `Focus the agendo session for work item ${target.id}`;
    }
  }

  // Under `bun test` (test/userscript.test.ts), which loads this file as a
  // CommonJS module: hand over the pieces and leave the DOM alone. With
  // `@grant none` the script runs in the page's own realm, where a loader shim
  // may well define a global `module` — so the test is for the script manager,
  // whose GM_info every one of them (Tampermonkey, Violentmonkey,
  // Greasemonkey 4) defines even then.
  if (typeof GM_info === "undefined" && typeof module === "object" && module && module.exports) {
    module.exports = { linkFor, hrefFor, debug, guard, onClick, GUARD_MS, DEBUG_KEY };
    return;
  }

  // First, before the page's own scripts where @run-at document-start allows,
  // so in Chromium the guard runs ahead of every beforeunload listener they
  // add (see `guard`). A script manager that injects late leaves Chromium's
  // earlier listeners unguarded; Firefox's bubble listeners stay guarded.
  const arm = guard();
  debug([`guard installed at readyState ${document.readyState}`]);

  let last = "";
  function check() {
    // At document-start there is no body yet; the poll comes back for it.
    if (!document.body) return;
    if (window.location.href === last && document.getElementById(BUTTON_ID)) return;
    last = window.location.href;
    render();
  }

  window.addEventListener("popstate", check);
  // pushState navigations fire no event, and the apps can re-render the body
  // under us, so a cheap poll is the dependable signal.
  setInterval(check, 500);
  check();
})();

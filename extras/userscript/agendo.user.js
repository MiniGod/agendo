// ==UserScript==
// @name         Open in agendo
// @namespace    https://github.com/MiniGod/agendo
// @version      1.2.0
// @description  Adds an "Open in agendo" button to Azure DevOps and GitHub pull requests and work items. It focuses the agendo session for that PR or work item, resuming it first if it is paused or idle.
// @match        https://dev.azure.com/*
// @match        https://*.visualstudio.com/*
// @match        https://github.com/*
// @grant        none
// @run-at       document-idle
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
// A click never navigates the page itself. Following the link would send the
// TOP window to agendo://, and even though the page stays put, the browser
// fires beforeunload/pagehide first — Firefox included — and Azure DevOps tears
// down its live-update (SignalR) connection and shows an "updates paused"
// warning. So the click is cancelled and the link is handed over from a hidden
// iframe instead (`launch`), created inside the click handler so it carries the
// click's user activation, which Firefox and Chromium both require before an
// iframe may open an external protocol. The frame stays until the next click
// or a minute has passed: the first click raises the browser's "open this
// link?" prompt, which belongs to the frame and must outlive the human reading
// it. If the page's Content-Security-Policy ENFORCES a rule refusing an agendo:
// frame, the browser reports a securitypolicyviolation and the script falls
// back to following the link: the warning comes back, but the button still
// works. A report-only policy did not block anything and is ignored. Nothing
// in this script assigns window.location.
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

  /** How long the hidden iframe stays at most: long enough to answer the browser's first-use prompt. */
  const FRAME_MS = 60000;

  /** The previous launch's teardown: its frame and its CSP listener go when the next click comes. */
  let pending = null;

  /**
   * Hand `href` to the desktop's agendo:// handler from a hidden iframe, so the
   * page itself never begins to unload (see the header). If an ENFORCED CSP
   * blocks the frame, follow the link after all (`fallback`), once. `doc` and
   * `later` are injected for tests.
   */
  function launch(href, fallback, doc = document, later = setTimeout) {
    if (pending) pending();
    const frame = doc.createElement("iframe");
    const done = () => {
      frame.remove();
      doc.removeEventListener("securitypolicyviolation", onBlocked);
      if (pending === done) pending = null;
    };
    const onBlocked = (e) => {
      if (e.disposition !== "enforce" || !String(e.blockedURI).startsWith("agendo")) return;
      done();
      fallback();
    };
    pending = done;
    doc.addEventListener("securitypolicyviolation", onBlocked);
    frame.style.display = "none";
    frame.src = href;
    doc.body.appendChild(frame);
    later(done, FRAME_MS);
  }

  /**
   * The button's click: launch from an iframe instead of following the link; a
   * modified click is left to the browser. `later` is injected for tests.
   */
  function onClick(e, later = setTimeout) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const link = e.currentTarget;
    launch(link.getAttribute("href"), () => {
      // Only reached when the page's CSP refused the iframe: a real click on a
      // throwaway copy, which this handler is not listening to.
      // Attached for the click, since Firefox long ignored click() on a detached link.
      const copy = document.createElement("a");
      copy.href = link.getAttribute("href");
      document.body.appendChild(copy);
      copy.click();
      copy.remove();
    }, document, later);
  }

  /** Tear down any pending launch — for tests, which share this script's state. */
  function reset() {
    if (pending) pending();
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
      button.addEventListener("click", onClick);
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
    module.exports = { linkFor, hrefFor, launch, onClick, reset, FRAME_MS };
    return;
  }

  let last = "";
  function check() {
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

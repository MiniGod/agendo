// ==UserScript==
// @name         Open in agendo
// @namespace    https://github.com/MiniGod/agendo
// @version      1.1.0
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
      document.body.appendChild(button);
    }
    const href = `agendo://focus?${target.kind}=${target.id}${target.repo ? `&repo=${target.repo}` : ""}`;
    if (button.getAttribute("href") !== href) {
      button.setAttribute("href", href);
      button.title = target.kind === "pr" ? `Focus the agendo session for PR ${target.id}` : `Focus the agendo session for work item ${target.id}`;
    }
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

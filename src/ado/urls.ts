import type { EntityUrls } from "../provider.ts";
import { BASE, cfg } from "./env.ts";

// ── Canonical web URLs ────────────────────────────────────────────────────────
// The one place ADO entity links are built. `base` is the org/collection root —
// `https://dev.azure.com/<org>`, a legacy `https://<org>.visualstudio.com`, or
// whatever ADO_BASE_URL points at (self-hosted / proxied / the e2e mock) — so
// every host shape falls out of the same two functions. Both are pure so they
// can be pinned in tests without touching the module's configured base.

/** Drop trailing slashes so a base joins cleanly onto a path. */
const trimBase = (base: string) => base.replace(/\/+$/, "");

/**
 * Web URL of a work item (the Boards details/edit page). Org-level on purpose:
 * it resolves the item in whichever project owns it, so it's correct for items
 * outside `cfg.project` too.
 */
export function adoWorkItemUrl(base: string, id: number): string {
  return `${trimBase(base)}/_workitems/edit/${id}`;
}

/**
 * Web URL of a pull request. `project` and `repo` are raw names, percent-encoded
 * here — ADO project names routinely contain spaces, and a repo name may too, so
 * interpolating them unescaped yields a link that 404s.
 */
export function adoPullRequestUrl(base: string, project: string, repo: string, id: number): string {
  return `${trimBase(base)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;
}

/** Entity URLs for the configured org (see Provider.urls). Derived from the
 *  configured org/project and ADO_BASE_URL — never re-parsed from a git remote. */
export const urls: EntityUrls = {
  workItem: (ref) => adoWorkItemUrl(BASE, ref.id),
  // ADO accepts either the repo's name or its guid in the path; prefer the name
  // (readable, and what the web UI itself links to), falling back to the guid.
  // A PR link is repo-scoped with no repo-less form, so a reference carrying
  // neither yields null rather than `…/_git//pullrequest/<id>`, which 404s.
  pullRequest: (ref) => {
    const repo = ref.repositoryName || ref.repositoryId;
    return repo ? adoPullRequestUrl(BASE, cfg.project, repo, ref.id) : null;
  },
};

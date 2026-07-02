// Provider-specific UI terminology. ADO calls them "work items" and prefixes
// PRs with "!"; GitHub calls them "issues" and (since issues and PRs share one
// numbering space) prefixes PRs with "#" too. The items view is also organised
// differently: ADO splits by sprint, GitHub splits by who filed the issue.
import type { ProviderName } from "./types.ts";

export interface Vocab {
  /** Prefix shown before a PR number ("!12" on ADO, "#12" on GitHub). */
  prPrefix: string;
  /** Tab label for the work-items / issues view. */
  itemsTab: string;

  // ── Items view: the two sections ──
  /** Heading of the primary (always-expanded) section. */
  primaryHeader: string;
  /** Whether the primary heading shows a sub-label (the ADO iteration name). */
  primaryShowsIteration: boolean;
  /** Shown when the primary section is empty. */
  primaryEmpty: string;
  /** Label of the secondary (collapsible) section toggle. */
  secondaryToggle: string;

  // ── PRs view: section headings + empty states ──
  linkedHeader: string;
  linkedEmpty: string;
  /** Sub-label under "awaiting your review" (ADO adds teams; GitHub is just you). */
  reviewSub: string;
  reviewEmpty: string;
  orphanHeader: string;
  orphanEmpty: string;

  /** Whether fresh-session tmux names must be scoped by repo. ADO ids are
   *  globally unique (false); GitHub issue/PR numbers collide across repos, so
   *  the repo is folded into the name to keep `cl-wi-…`/`cl-pr-…` distinct. */
  repoScopedFresh: boolean;
}

const ADO: Vocab = {
  prPrefix: "!",
  itemsTab: "Work items",
  primaryHeader: "Current sprint",
  primaryShowsIteration: true,
  primaryEmpty: "(nothing assigned in the current sprint)",
  secondaryToggle: "Everything else assigned",
  linkedHeader: "PRs on your work items",
  linkedEmpty: "(no PRs linked to your work items)",
  reviewSub: "you + your teams",
  reviewEmpty: "(no PRs awaiting your review)",
  orphanHeader: "PRs without a work item",
  orphanEmpty: "(no orphan PRs)",
  repoScopedFresh: false,
};

const GITHUB: Vocab = {
  prPrefix: "#",
  itemsTab: "Issues",
  primaryHeader: "Created by me",
  primaryShowsIteration: false,
  primaryEmpty: "(no open issues you created)",
  secondaryToggle: "In your repos",
  linkedHeader: "PRs on your issues",
  linkedEmpty: "(no PRs linked to your issues)",
  reviewSub: "review requested",
  reviewEmpty: "(no PRs awaiting your review)",
  orphanHeader: "PRs without an issue",
  orphanEmpty: "(no orphan PRs)",
  repoScopedFresh: true,
};

export function vocab(provider: ProviderName): Vocab {
  return provider === "github" ? GITHUB : ADO;
}

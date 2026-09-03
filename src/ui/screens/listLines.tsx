import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LoadedModel } from "../../model.ts";
import { homeShort } from "../format.ts";
import { CaretText, ColumnHeader, HEADERS_ITEMS, ITEM_WIDTHS, PR_WIDTHS, prHeaders } from "../components.tsx";
import type { PrSort, SessionSort } from "../rows.ts";
import type { RepoInfo } from "../../repos.ts";
import type { View } from "../keys/context.ts";

/**
 * The lines above and below the rows of the list screen. Plain functions
 * rather than components, for the reason `renderRow` gives: each returns the
 * element `ListScreen` used to build inline, so the rendered tree — and the
 * fibre it reconciles — is exactly what it was. The strings they print are
 * exported on their own so every arm of a hint can be read against the others
 * without rendering anything.
 */

export type SearchFocus = "input" | "list" | null;

/** One of the three view tabs in the header, lit when it is the current one. */
export function viewTab(view: View, v: View, label: string): ReactElement {
  return (
    <Text
      bold={view === v}
      backgroundColor={view === v ? "cyan" : undefined}
      color={view === v ? "black" : undefined}
      dimColor={view !== v}
    >
      {` ${label} `}
    </Text>
  );
}

/** What enter does on the focused row, in the words the hint line uses. */
function enterVerb(view: View): string {
  return view === "sessions" ? "resume" : "open";
}

/** The key hint while the search box is being typed into, or its results walked. */
export function searchHint(searchFocus: "input" | "list", view: View): string {
  return searchFocus === "input"
    ? `type to filter · ←/→ caret · ⌫ delete · ⌃w del word · ↓ results · enter ${enterVerb(view)} · esc cancel`
    : `↑/↓ move · ↑ at top edits search · → expand · / edit · enter ${enterVerb(view)} · o browser · esc cancel`;
}

export interface ViewHintState {
  grouped: boolean;
  prsGrouped: boolean;
  prSort: PrSort;
  sessionSort: SessionSort;
}

/** The key hint for a view when nothing is being searched. */
export function viewHint(view: View, s: ViewHintState): string {
  if (view === "sessions") {
    // `⇥ view` (not "switch view") matches the PRs hint and buys back
    // 7 columns for the coordinator and `m →profile` entries — this
    // line already truncated at ~120 cols before any of them, so tail
    // hints are at a premium. `O orch · G global` spends 3 of those 7
    // to name BOTH coordinator levels where one used to be spelled out
    // as `O orchestrator`, in the same words the `kind` column of
    // `agendo list` prints for those sessions.
    return `↑/↓ move · → expand · ⇥ view · g ${s.grouped ? "ungroup" : "group"} · s sort: ${s.sessionSort} · / search · n new · O orch · G global · enter resume · c →other agent · m →profile · o browser · , settings · r refresh · q/esc quit`;
  }
  if (view === "prs") {
    return `↑/↓ move · → expand · ⇥ view · g ${s.prsGrouped ? "ungroup" : "group"} · s sort: ${s.prSort === "created" ? "created" : "updated"} · / search · enter open · o browser · , settings · r refresh · q/esc quit`;
  }
  return "↑/↓ move · →/← expand · ⇥ switch view · / search · enter open/expand · o browser · , settings · r refresh · q/esc quit";
}

export function hintLine(searchFocus: SearchFocus, view: View, s: ViewHintState): ReactElement {
  return (
    <Box>
      <Text wrap="truncate" dimColor>
        {searchFocus ? searchHint(searchFocus, view) : viewHint(view, s)}
      </Text>
    </Box>
  );
}

export interface ScopeState {
  filterRoot: string | null;
  scoped: boolean;
  hostSession?: string;
  discoveredRepos: RepoInfo[];
  repoFilterOn: boolean;
}

/** Where the list is looking: the host session's path, or everywhere. */
export function scopeText(scoped: boolean, hostSession: string | undefined, filterRoot: string): string {
  return scoped ? `⊙ ${hostSession}: ${homeShort(filterRoot)}` : "⊙ global — all paths";
}

/** The `a` key's effect from the current scope. */
export function scopeToggleHint(scoped: boolean, hostSession: string | undefined): string {
  return `  · a ${scoped ? "show all" : `rescope to ${hostSession}`}`;
}

/** The repo filter's own state + key hint, next to the path scope's so both toggles are discoverable in the same place. */
export function repoFilterHint(repos: number, on: boolean): string {
  if (repos === 0) return `  · f repo filter: no repos found here`;
  return `  · f repo filter: ${on ? `on (${repos} repo${repos > 1 ? "s" : ""})` : "off"}`;
}

export function scopeLine(s: ScopeState): ReactElement | null {
  if (!s.filterRoot) return null;
  return (
    <Box>
      <Text wrap="truncate">
        <Text color={s.scoped ? "green" : "yellow"}>{scopeText(s.scoped, s.hostSession, s.filterRoot)}</Text>
        <Text dimColor>{scopeToggleHint(s.scoped, s.hostSession)}</Text>
        <Text dimColor>{repoFilterHint(s.discoveredRepos.length, s.repoFilterOn)}</Text>
      </Text>
    </Box>
  );
}

export function searchLine(searchFocus: SearchFocus, search: { text: string; cursor: number }): ReactElement | null {
  if (!searchFocus) return null;
  return (
    <Box>
      <Text wrap="truncate">
        <Text color={searchFocus === "input" ? "cyan" : "gray"}>{"search "}</Text>
        {searchFocus === "input" ? (
          <Text>
            <CaretText value={search.text} cursor={search.cursor} />
          </Text>
        ) : (
          <Text dimColor>{search.text}</Text>
        )}
      </Text>
    </Box>
  );
}

/** Whose work items and PRs these are; the sessions view has no identity. */
export function identityLine(view: View, model: LoadedModel): ReactElement | null {
  if (view === "sessions") return null;
  return (
    <Box>
      <Text wrap="truncate">
        <Text color="magenta">{"as "}</Text>
        <Text bold>
          {model.identity.displayName}
          {model.identity.id === model.me.id ? " (you)" : ""}
        </Text>
      </Text>
    </Box>
  );
}

export function columnHeader(view: View, prSort: PrSort): ReactElement | null {
  if (view === "sessions") return null;
  return (
    <ColumnHeader
      headers={view === "prs" ? prHeaders(prSort) : HEADERS_ITEMS}
      widths={view === "prs" ? PR_WIDTHS : ITEM_WIDTHS}
    />
  );
}

/** How many rows lie past the viewport's edge, or a blank line to hold the place. */
export function edgeLine(count: number, arrow: "↑" | "↓"): ReactElement {
  return <Text dimColor>{count > 0 ? `  ${arrow} ${count} more` : " "}</Text>;
}

export function noticeLine(notice: string | null): ReactElement | null {
  if (!notice) return null;
  return (
    <Box>
      <Text color="yellow">⚑ {notice}</Text>
    </Box>
  );
}

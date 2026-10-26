import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import { homeShort } from "../format/index.ts";
import { CaretText, ColumnHeader, HEADERS_ITEMS, ITEM_WIDTHS, PR_WIDTHS, prHeaders } from "../components/index.tsx";
import type { PrSort, SessionSort } from "../models/rows.ts";
import type { OrchestratorPins, PinLine } from "../models/orchestratorPins.ts";
import type { RepoInfo } from "../../repositories/index.ts";
import type { View } from "../keys/context.ts";
import type { TeamCheck } from "../../shared/types.ts";

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
  /** Scoped to one repo, where `G` means `O` (see scopeRepo.ts). */
  repoScope?: boolean;
}

/** The coordinator keys: both levels, or one key pair when the scope is a single repo. */
export function coordinatorHint(repoScope: boolean | undefined): string {
  return repoScope ? "O/G orch" : "O orch · G global";
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
    // `agendo list` prints for those sessions. `p/x/X pause/kill` sits
    // right after `enter resume`, the other half of a session's lifecycle,
    // folded into one entry so as little as possible of the tail is pushed off.
    // Scoped to one repo the two coordinator keys open the same session, so
    // they share one entry (`coordinatorHint`).
    return `↑/↓ move · → expand · ⇥ view · g ${s.grouped ? "ungroup" : "group"} · s sort: ${s.sessionSort} · / search · n new · ${coordinatorHint(s.repoScope)} · enter resume · p/x/X pause/kill · c →other agent · m →profile · o browser · C cleanup · , settings · r refresh · q/esc quit`;
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

/**
 * What the Work items view says about a configured team that can't be where
 * "Current sprint" comes from (see TeamCheck), or null when there's nothing to
 * say. Names a few of the user's own teams, so the fix is in the message.
 */
export function teamNoticeText(check: TeamCheck | null | undefined): string | null {
  if (!check) return null;
  if (!check.team) return "no team is set, so there is no current sprint — set it in , settings";
  if (check.mine === null) return `team '${check.team}' wasn't found in ${check.project}, set it in , settings`;
  const yours = check.mine.length === 0 ? `you're in no team of ${check.project}` : check.mine.slice(0, 3).join(", ") + (check.mine.length > 3 ? ", …" : "");
  return `team '${check.team}' isn't one of yours (${yours}), set it in , settings`;
}

/** The team notice as the one line under "as …" in the Work items view; the other views never show it. */
export function teamNoticeLine(view: View, model: LoadedModel): ReactElement | null {
  const text = view === "items" ? teamNoticeText(model.teamCheck) : null;
  if (!text) return null;
  return (
    <Box>
      <Text color="yellow" wrap="truncate">⚑ {text}</Text>
    </Box>
  );
}

/** Lines `teamNoticeLine` takes, for the viewport to leave room for. */
export function teamNoticeLines(view: View, model: LoadedModel | null): number {
  return view === "items" && teamNoticeText(model?.teamCheck) ? 1 : 0;
}

export function noticeLine(notice: string | null): ReactElement | null {
  if (!notice) return null;
  return (
    <Box>
      <Text color="yellow">⚑ {notice}</Text>
    </Box>
  );
}

/** One pinned line's styled segments, in the order orchestratorPins built them. */
function pinSegments(line: PinLine): ReactElement {
  return (
    <Text wrap="truncate">
      {line.map((seg, i) => (
        // eslint-disable-next-line react/no-array-index-key -- a line is a positional literal built by orchestratorPins (glyph, name, title, separators, hint), rebuilt whole on every render and never reordered or filtered; the index IS the segment's identity, and its text is not unique — two "  ·  " separators in one line is ordinary, and a duplicate key prints a React warning into the TUI.
        <Text key={i} color={seg.color} dimColor={seg.dim} bold={seg.bold}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The pinned orchestrator block (see orchestratorPins.ts), Sessions view only.
 * Outside the scrolling rows on purpose, and exactly `lines.length` tall —
 * `useViewport` reserves that many rows for it.
 */
export function pinnedBlock(view: View, pins: OrchestratorPins | null): ReactElement | null {
  if (view !== "sessions" || !pins) return null;
  return (
    <Box flexDirection="column">
      {pins.lines.map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key -- the block is rebuilt whole from the model on every render, each line a stateless leaf at a fixed position (header, then repos, then the overflow); no line's text is guaranteed unique — two repos can share a basename and an orchestrator title — and a duplicate key prints a React warning into the TUI.
        <Box key={i}>{pinSegments(line)}</Box>
      ))}
    </Box>
  );
}

/** How many terminal rows `pinnedBlock` takes, for the viewport arithmetic. */
export function pinnedLineCount(view: View, pins: OrchestratorPins | null): number {
  return view === "sessions" && pins ? pins.lines.length : 0;
}

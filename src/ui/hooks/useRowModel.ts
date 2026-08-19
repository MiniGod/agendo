import { useMemo } from "react";
import { filterModelByRepos, type LoadedModel } from "../../model.ts";
import type { TeamMember } from "../../types.ts";
import type { Activity } from "../format.ts";
import {
  buildItemsRows,
  buildPrsRows,
  buildSessionsRows,
  SELECTABLE,
  type PrSort,
  type SessionSort,
} from "../rows.ts";
import type { View } from "../keys/context.ts";

/**
 * The display model: the loaded model narrowed by the repo filter, the rows the
 * current view renders, the indices of the selectable ones, and the identity
 * roster.
 *
 * Extracted verbatim from App: these four memos sat consecutively in the
 * component body and the hook is called from that same position, so hook order
 * — and every dependency array — is unchanged.
 */
export function useRowModel({
  model,
  repoFilterOn,
  view,
  expanded,
  toggles,
  grouped,
  prsGrouped,
  prSort,
  sessionSort,
  activity,
  search,
  inScope,
}: {
  model: LoadedModel | null;
  repoFilterOn: boolean;
  view: View;
  expanded: Set<string>;
  toggles: Set<string>;
  grouped: boolean;
  prsGrouped: boolean;
  prSort: PrSort;
  sessionSort: SessionSort;
  activity: Map<string, Activity>;
  search: { text: string; cursor: number };
  inScope: (cwd: string) => boolean;
}) {
  // Whether the repo filter is doing anything right now: it needs a path context
  // with at least one repo inside it (model.repoScope is null otherwise) and the
  // `f` toggle on. Applied as a display overlay over the loaded model, so the
  // fetched data — and every count derived from it — narrows in one place.
  const repoFiltered = !!model?.repoScope && repoFilterOn;
  const viewModel = useMemo<LoadedModel | null>(
    () => (model ? filterModelByRepos(model, repoFiltered ? model.repoScope : null) : null),
    [model, repoFiltered],
  );

  const rows = useMemo(() => {
    if (!viewModel) return [];
    if (view === "prs") return buildPrsRows(viewModel, expanded, toggles, prsGrouped, prSort, activity, search.text, inScope);
    if (view === "sessions") return buildSessionsRows(viewModel, toggles, grouped, expanded, activity, sessionSort, search.text, inScope);
    return buildItemsRows(viewModel, expanded, toggles, activity, search.text, inScope);
  }, [viewModel, view, expanded, toggles, grouped, prsGrouped, prSort, sessionSort, activity, search.text, inScope]);
  const selectableIdx = useMemo(
    () => rows.map((r, i) => (SELECTABLE.has(r.kind) ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  // The identity-switcher roster: the team's members, with the authenticated
  // user guaranteed present (in case they aren't on the configured team).
  const roster = useMemo<TeamMember[]>(() => {
    if (!model) return [];
    const list = [...model.teamMembers];
    if (!list.some((m) => m.id === model.me.id)) list.unshift(model.me);
    return list;
  }, [model]);

  return { rows, selectableIdx, roster };
}

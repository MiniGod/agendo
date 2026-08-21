import { useState } from "react";

/**
 * The fuzzy-search box and its edit helpers.
 *
 * Extracted verbatim from App: the two `useState` calls sat consecutively in
 * the component body and the hook is called from that same position, so hook
 * order is unchanged. `setSearch` stays private — every write goes through
 * `clearSearch` / `editSearch`, exactly as before.
 */
export function useSearch() {
  // Fuzzy search (works on every list view: sessions, PRs, work items).
  // `searchFocus` is the three-state mode:
  //   null    — not searching
  //   "input" — the text box is focused; keystrokes edit the query
  //   "list"  — a query is active but the results list is focused for navigation
  // `search` holds the query text plus a caret position for in-place editing.
  const [searchFocus, setSearchFocus] = useState<"input" | "list" | null>(null);
  const [search, setSearch] = useState<{ text: string; cursor: number }>({ text: "", cursor: 0 });

  // ── sessions search helpers ──
  const clearSearch = () => {
    setSearchFocus(null);
    setSearch({ text: "", cursor: 0 });
  };
  // Edit the query text + caret together so batched keystrokes each apply
  // against the latest value instead of a stale snapshot.
  const editSearch = (fn: (text: string, cursor: number) => { text?: string; cursor: number }) =>
    setSearch((s) => {
      const r = fn(s.text, s.cursor);
      return { text: r.text ?? s.text, cursor: r.cursor };
    });

  return { searchFocus, setSearchFocus, search, clearSearch, editSearch };
}

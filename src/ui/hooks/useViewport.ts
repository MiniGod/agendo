import { useEffect, useState } from "react";
import { useStdout } from "ink";
import type { Row } from "../rows.ts";
import type { View } from "../keys/context.ts";

/**
 * Viewport windowing for the list views.
 *
 * Extracted verbatim from App. The hook OWNS `scrollTop` (nothing outside the
 * window arithmetic ever wrote it) and the `useStdout` read that sizes the
 * page, so its effect's dependency array — `[cursor, pageSize, rows.length]` —
 * is unchanged and complete. It is called from the same position the block sat
 * in, so its effect stays last in App's effect order.
 */
export function useViewport({
  rows,
  cursor,
  view,
  searchFocus,
  filterRoot,
}: {
  rows: Row[];
  cursor: number;
  view: View;
  searchFocus: "input" | "list" | null;
  filterRoot: string | null;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const { stdout } = useStdout();

  // ── viewport windowing ──
  // Render only a slice of rows so the list never overflows the terminal (which
  // breaks Ink's redraw and scrolls the cursor off-screen). One row = one line.
  // Reserve lines for the tab strip, hint, scroll indicators, column header
  // (items/prs only) and an occasional notice line.
  const termRows = stdout?.rows ?? 24;
  // Non-sessions views also reserve a line for the "viewing as / filter" status.
  // The search box (shown while a search is active) takes one extra line, and a
  // path-scoped launcher shows one scope line.
  const pageSize = Math.max(
    3,
    termRows - (view === "sessions" ? 6 : 8) - (searchFocus ? 1 : 0) - (filterRoot ? 1 : 0),
  );
  useEffect(() => {
    setScrollTop((prev) => {
      let next = prev;
      if (cursor < next) next = cursor;
      else if (cursor >= next + pageSize) next = cursor - pageSize + 1;
      const maxTop = Math.max(0, rows.length - pageSize);
      return Math.min(Math.max(0, next), maxTop);
    });
  }, [cursor, pageSize, rows.length]);
  const visible = rows.slice(scrollTop, scrollTop + pageSize);
  const moreAbove = scrollTop;
  const moreBelow = Math.max(0, rows.length - (scrollTop + pageSize));

  return { scrollTop, visible, moreAbove, moreBelow };
}

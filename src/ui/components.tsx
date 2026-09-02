import { Box, Text } from "ink";
import { caretRight } from "./keys/caret.ts";
import {
  agentCell,
  approvalCell,
  ciCell,
  fit,
  fmtDelta,
  padCell,
  prBadge,
  stateColor,
  timeAgo,
  verbStyle,
  TASK_STYLE,
  type Cell,
} from "./format.ts";
import { V } from "./vocabState.ts";
import type { PrSort } from "./rows.ts";
import { sessionRowParts, type SessionRowInput } from "./sessionRow.ts";
import type { ActionLine, PRWithSessions, TaskItem, WorkItem } from "../types.ts";

// ── column layout ─────────────────────────────────────────────────────────────
// Rows are rendered as a single Text with each cell padded/truncated to a fixed
// width, so columns line up and the selection highlight stays continuous.
// Items and PRs share the leading column widths. The PR view adds a narrow
// sort-time column (created/updated — whichever sort is active) before AGENT,
// so its title/context columns are a touch narrower to make room.
export const ITEM_WIDTHS = [11, 11, 13, 46, 22, 11];
export const PR_WIDTHS = [11, 11, 13, 42, 18, 8, 11];
export const HEADERS_ITEMS = ["  ID", "TYPE", "STATE", "TITLE", "PR", "AGENT"];
// PR headers are built per render: the sort-time column's label is the active sort.
export function prHeaders(sort: PrSort): string[] {
  return ["  ID", "APPROVE", "CI / MERGE", "TITLE", "CONTEXT", sort.toUpperCase(), "AGENT"];
}

/**
 * A single-line prompt value with a block caret over the character at `cursor`.
 *
 * The caret cell is `value.slice(cursor, caretRight(value, cursor))`, not
 * `value[cursor]`: the latter is ONE UTF-16 code unit, so a caret parked on an
 * astral character (where caretLeft/caretRight deliberately park it) rendered
 * two unpaired surrogates and the terminal drew replacement glyphs over an
 * emoji. The value was always fine — this is the display half of the same
 * boundary problem src/ui/keys/caret.ts fixes for editing.
 */
export function CaretText({ value, cursor, color }: { value: string; cursor: number; color?: string }) {
  const end = caretRight(value, cursor);
  return (
    <>
      <Text color={color}>{value.slice(0, cursor)}</Text>
      <Text inverse>{value.slice(cursor, end) || " "}</Text>
      <Text color={color}>{value.slice(end)}</Text>
    </>
  );
}

function ColRow({ cells, widths, selected }: { cells: Cell[]; widths: number[]; selected: boolean }) {
  // wrap="truncate" keeps each row on one line in narrow terminals, so the
  // viewport windowing (1 row = 1 line) stays accurate instead of overflowing.
  return (
    <Text wrap="truncate" backgroundColor={selected ? "cyan" : undefined}>
      {cells.map((c, i) => (
        // eslint-disable-next-line react/no-array-index-key -- `cells` IS the fixed column layout: a positional literal built by ItemRow/PrRow and indexed in lockstep with `widths[i]`, never reordered, filtered or resized. The index is the column's identity. `c.text` is not unique — two columns rendering "—" is ordinary — so keying by it would print a duplicate-key warning into the terminal this UI is painting.
        <Text key={i} color={selected ? "black" : c.color}>{fit(c.text, widths[i])}</Text>
      ))}
    </Text>
  );
}

export function ColumnHeader({ headers, widths }: { headers: string[]; widths: number[] }) {
  return <Text wrap="truncate" dimColor>{headers.map((h, i) => fit(h, widths[i])).join("")}</Text>;
}

export function ItemRow({
  item,
  expanded,
  running,
  selected,
}: { item: WorkItem; expanded: boolean; running: number; selected: boolean }) {
  const caret = expanded ? "▾" : "▸";
  const primary = item.prs[0];
  const prCell: Cell = primary
    ? {
        text: prBadge(primary).text + (item.prs.length > 1 ? ` +${item.prs.length - 1}` : ""),
        color: prBadge(primary).color,
      }
    : { text: "—", color: "gray" };
  const cells: Cell[] = [
    { text: `${caret} #${item.id}`, color: "gray" },
    { text: item.type, color: "gray" },
    { text: item.state, color: stateColor(item.state) },
    { text: item.title },
    prCell,
    agentCell(running, item.sessions.length),
  ];
  return <Box><ColRow cells={cells} widths={ITEM_WIDTHS} selected={selected} /></Box>;
}

export function PrRow({
  pr,
  expanded,
  running,
  selected,
  contextCell,
  sort,
}: { pr: PRWithSessions; expanded: boolean; running: number; selected: boolean; contextCell?: Cell; sort: PrSort }) {
  const caret = expanded ? "▾" : "▸";
  // The sort-time column tracks the active sort: created vs last-updated time.
  const tNum = sort === "updated" ? pr.updatedDate : pr.createdDate;
  const cells: Cell[] = [
    { text: `${caret} ${V.prPrefix}${pr.id}`, color: prBadge(pr).color },
    approvalCell(pr),
    pr.isDraft ? { text: "draft", color: "gray" } : ciCell(pr),
    { text: pr.title },
    contextCell ?? { text: `${pr.repositoryName ?? ""}:${pr.branch}`.replace(/^:/, ""), color: "gray" },
    { text: tNum ? timeAgo(new Date(tNum)) : "—", color: "gray" },
    agentCell(running, pr.sessions.length),
  ];
  return <Box><ColRow cells={cells} widths={PR_WIDTHS} selected={selected} /></Box>;
}

/** A session in the list. What it says is decided in sessionRow.ts; this paints it, highlighted when selected. */
export function SessionRow(props: SessionRowInput & { selected: boolean }) {
  const p = sessionRowParts(props);
  const { selected } = props;
  function paint(color: string): string {
    return selected ? "black" : color;
  }
  return (
    <Box marginLeft={4}>
      <Text wrap="truncate" {...rowStyle(selected)}>
        <Text color={paint("gray")}>{p.caret}</Text>
        <Text color={paint(p.glyphColor)}>{p.glyph}</Text>
        <Text dimColor={!selected}>{p.source}</Text>
        {p.badge ? <Text color={paint("cyan")}>{p.badge}</Text> : null}
        <Text>{p.title}</Text>
        {p.link ? <Text color={paint("magenta")}>{`  ${p.link}`}</Text> : null}
        <Text dimColor={!selected}>{p.time}</Text>
        {p.status ? <Text color={paint(p.status.color)}>{p.status.text}</Text> : null}
        {p.shells ? <Text color={paint("blue")}>{p.shells}</Text> : null}
        {p.restored ? <Text color={paint("gray")} dimColor={!selected}>{"  restored · press to resume"}</Text> : null}
      </Text>
    </Box>
  );
}

/** The selection highlight: black on cyan, or the terminal's own colors. */
function rowStyle(selected: boolean): { color?: string; backgroundColor?: string } {
  return selected ? { color: "black", backgroundColor: "cyan" } : {};
}

// A single activity line under an expanded session: relative time + the gap
// since the previous action, then a colored verb and a one-line detail.
export function ActionRow({ action }: { action: ActionLine }) {
  const { color } = verbStyle(action.verb);
  return (
    <Box marginLeft={6}>
      <Text wrap="truncate">
        <Text color="gray">{timeAgo(action.timestamp).padStart(8)}</Text>
        <Text color="gray" dimColor>{("  " + fmtDelta(action.deltaMs)).padEnd(8)}</Text>
        <Text color={color}>{padCell(action.verb, 9) + " "}</Text>
        <Text dimColor>{action.detail.replace(/\s+/g, " ")}</Text>
      </Text>
    </Box>
  );
}

// A single task-checklist line under an expanded session: a status checkbox and
// the item text.
export function TaskRow({ task }: { task: TaskItem }) {
  const style = TASK_STYLE[task.status] ?? TASK_STYLE.pending;
  return (
    <Box marginLeft={6}>
      <Text wrap="truncate">
        <Text color={style.color}>{`${style.glyph} `}</Text>
        <Text color={task.status === "in_progress" ? "yellow" : undefined} dimColor={style.dim} bold={task.status === "in_progress"}>
          {task.label.replace(/\s+/g, " ")}
        </Text>
      </Text>
    </Box>
  );
}

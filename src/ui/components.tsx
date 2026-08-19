import { Box, Text } from "ink";
import {
  agentCell,
  approvalCell,
  ciCell,
  compactionSuffix,
  fit,
  fmtDelta,
  limitSuffix,
  prBadge,
  runningStatus,
  stateColor,
  timeAgo,
  verbStyle,
  KIND_BADGE,
  TASK_STYLE,
  type Cell,
  type PaneState,
} from "./format.ts";
import { V } from "./vocabState.ts";
import type { PrSort } from "./rows.ts";
import type { OpenTargets } from "./targets.ts";
import type { SessionKind } from "../tmux.ts";
import type { ActionLine, AgentSession, PRWithSessions, TaskItem, WorkItem } from "../types.ts";

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

function ColRow({ cells, widths, selected }: { cells: Cell[]; widths: number[]; selected: boolean }) {
  // wrap="truncate" keeps each row on one line in narrow terminals, so the
  // viewport windowing (1 row = 1 line) stays accurate instead of overflowing.
  return (
    <Text wrap="truncate" backgroundColor={selected ? "cyan" : undefined}>
      {cells.map((c, i) => (
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

// The PR / work item a session links back to, as a compact one-line badge
// (e.g. `!76896 → WI 234309`, or just one side when only one is known).
export function linkBadge(open: OpenTargets | undefined): string | null {
  if (!open) return null;
  const parts: string[] = [];
  if (open.pr) parts.push(`!${open.pr.id}`);
  if (open.workItem) parts.push(`WI ${open.workItem.id}`);
  return parts.length ? parts.join(" → ") : null;
}

export function SessionRow({
  session,
  running,
  kind,
  pane,
  expanded,
  selected,
  timeField = "lastUsed",
  open,
  showLink,
  placeholder,
}: { session: AgentSession; running: boolean; kind?: SessionKind; pane?: PaneState; expanded: boolean; selected: boolean; timeField?: "lastUsed" | "created"; open?: OpenTargets; showLink?: boolean; placeholder?: boolean }) {
  const caret = expanded ? "▾ " : "▸ ";
  const displayTime = timeField === "created" ? (session.createdAt ?? session.lastUsed) : session.lastUsed;
  const badge = kind ? KIND_BADGE[kind] : undefined;
  const status = running ? runningStatus(pane?.readiness) : null;
  const shells = running ? pane?.shells ?? 0 : 0;
  const link = showLink ? linkBadge(open) : null;
  return (
    <Box marginLeft={4}>
      <Text wrap="truncate" color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
        <Text color={selected ? "black" : "gray"}>{caret}</Text>
        <Text color={selected ? "black" : status ? status.color : "gray"}>{running ? "● " : placeholder ? "⏸ " : "○ "}</Text>
        <Text dimColor={!selected}>{`[${session.source}] `}</Text>
        {badge ? <Text color={selected ? "black" : "cyan"}>{`{${badge}} `}</Text> : null}
        <Text>{session.title.replace(/\s+/g, " ").slice(0, 50)}</Text>
        {link ? <Text color={selected ? "black" : "magenta"}>{`  ${link}`}</Text> : null}
        <Text dimColor={!selected}>{`  ${timeAgo(displayTime)}`}</Text>
        {status ? <Text color={selected ? "black" : status.color}>{`  (${status.label}${pane?.readiness === "limited" ? limitSuffix(pane.resetAt) : pane?.readiness === "compacting" ? compactionSuffix(pane.compactionPercent) : ""})`}</Text> : null}
        {shells > 0 ? <Text color={selected ? "black" : "blue"}>{`  ⛁ ${shells} shell${shells > 1 ? "s" : ""}`}</Text> : null}
        {placeholder ? <Text color={selected ? "black" : "gray"} dimColor={!selected}>{"  restored · press to resume"}</Text> : null}
      </Text>
    </Box>
  );
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
        <Text color={color}>{action.verb.slice(0, 9).padEnd(10)}</Text>
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

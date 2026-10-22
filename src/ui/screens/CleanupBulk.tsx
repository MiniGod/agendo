import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { BulkStep } from "../../cleanup/bulk.ts";
import { homeShort } from "../format/index.ts";
import { bulkScrolls, type BulkDialog } from "../keys/cleanupBulk.ts";

/** `…and N more` under a window of a longer list, else nothing. */
function More({ hidden }: { hidden: number }) {
  return hidden > 0 ? <Text dimColor>{`   …and ${hidden} more (↑/↓ scroll)`}</Text> : null;
}

function ConfirmView({ b, page }: { b: BulkDialog; page: number }) {
  const n = b.rows.length;
  const shown = b.rows.slice(b.top, b.top + page);
  return (
    <Box flexDirection="column">
      <Text bold color="red">{`Delete everything safe to remove — ${n} row${n === 1 ? "" : "s"}?`}</Text>
      {/* Each line fits 80 columns: these are what the dialog is there to say. */}
      <Text dimColor wrap="truncate">{"Each goes with the boxes its own dialog starts ticked: worktree and branch."}</Text>
      <Text dimColor wrap="truncate">{"Transcripts and tmp files are kept. A paused tab's checkout is left alone."}</Text>
      <Text dimColor wrap="truncate">{"Each row is checked again right before it goes; one no longer safe is skipped."}</Text>
      <Box flexDirection="column" marginTop={1}>
        {b.top > 0 ? <Text dimColor>{`   ↑ ${b.top} more`}</Text> : null}
        {shown.map((r) => (
          <Text key={r.key} wrap="truncate">{`   • ${r.title}`}<Text dimColor>{`  ${homeShort(r.path)}`}</Text></Text>
        ))}
        <More hidden={n - b.top - shown.length} />
      </Box>
      <Box marginTop={1}>
        <Text bold>{`y delete all ${n} · ${bulkScrolls(b, page) ? "↑/↓ scroll · " : ""}any other key cancels`}</Text>
      </Box>
    </Box>
  );
}

const MARK: Record<BulkStep["outcome"], { mark: string; color: string }> = {
  removed: { mark: "✓", color: "green" },
  failed: { mark: "✗", color: "red" },
  skipped: { mark: "–", color: "yellow" },
};

function StepLine({ step }: { step: BulkStep }) {
  const m = MARK[step.outcome];
  return <Text color={m.color} wrap="truncate">{`  ${m.mark} ${step.title} — ${step.lines.map((l) => l.text).join("; ")}`}</Text>;
}

const count = (steps: readonly BulkStep[], o: BulkStep["outcome"]) => steps.filter((s) => s.outcome === o).length;

function RunningView({ b, page }: { b: BulkDialog; page: number }) {
  const next = b.rows[b.steps.length];
  return (
    <Box flexDirection="column">
      <Text><Text color="cyan">⟳</Text>{` Deleting ${Math.min(b.steps.length + 1, b.rows.length)} of ${b.rows.length}${next ? ` — ${next.title}` : ""}…`}</Text>
      {b.steps.slice(-page).map((s) => (
        <StepLine key={s.key} step={s} />
      ))}
    </Box>
  );
}

function DoneView({ b, page }: { b: BulkDialog; page: number }) {
  const shown = b.steps.slice(b.top, b.top + page);
  return (
    <Box flexDirection="column">
      <Text bold>
        {`Cleanup finished: ${count(b.steps, "removed")} removed, ${count(b.steps, "failed")} failed, ${count(b.steps, "skipped")} skipped`}
      </Text>
      {b.top > 0 ? <Text dimColor>{`   ↑ ${b.top} more`}</Text> : null}
      {shown.map((s) => (
        <StepLine key={s.key} step={s} />
      ))}
      <More hidden={b.steps.length - b.top - shown.length} />
      <Box marginTop={1}>
        <Text dimColor>{bulkScrolls(b, page) ? "↑/↓ scroll · any other key returns to the list" : "press any key to return to the list"}</Text>
      </Box>
    </Box>
  );
}

const STAGES: Record<BulkDialog["stage"], (p: { b: BulkDialog; page: number }) => ReactElement> = {
  confirm: ConfirmView,
  running: RunningView,
  done: DoneView,
};

/** D's confirmation, its progress and its summary. */
export function CleanupBulkView({ b, page }: { b: BulkDialog; page: number }): ReactElement {
  const Stage = STAGES[b.stage];
  return <Stage b={b} page={page} />;
}

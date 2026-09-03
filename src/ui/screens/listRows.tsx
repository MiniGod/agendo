import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { itemKey, prKey, type LoadedModel } from "../../model.ts";
import { sessionName } from "../../tmux.ts";
import type { PaneState } from "../format.ts";
import { ActionRow, ItemRow, PrRow, SessionRow, TaskRow } from "../components.tsx";
import type { Row, PrSort } from "../rows.ts";
import type { SearchFocus } from "./listLines.tsx";

/**
 * One row of the list, by kind. Plain functions rather than components so the
 * rendered element tree is byte-for-byte what it was when this was an inline
 * `.map` callback — turning any of them into a component would insert a new
 * fibre per row and change reconciliation on every scroll.
 */

export interface RowContext {
  /** The row's index in the full row list, for the keys of the keyless kinds. */
  i: number;
  /** Under the cursor, and the cursor is on the list rather than in the search box. */
  selected: boolean;
  model: LoadedModel;
  panes: Map<string, PaneState>;
  prSort: PrSort;
}

type RowOf<K extends Row["kind"]> = Extract<Row, { kind: K }>;
type Renderer<K extends Row["kind"]> = (row: RowOf<K>, c: RowContext) => ReactElement;

function spacerRow(_row: RowOf<"spacer">, c: RowContext): ReactElement {
  return <Text key={`s${c.i}`}> </Text>;
}

function headerRow(row: RowOf<"header">, c: RowContext): ReactElement {
  return (
    <Box key={`h${c.i}`}>
      <Text wrap="truncate" bold color="blue">{row.label}</Text>
      {row.sub ? <Text dimColor>{`  ${row.sub}`}</Text> : null}
    </Box>
  );
}

function itemRow(row: RowOf<"item">, c: RowContext): ReactElement {
  return (
    <ItemRow key={`i${itemKey(row.item)}`} item={row.item} expanded={row.expanded} running={row.running} selected={c.selected} />
  );
}

function prRow(row: RowOf<"pr">, c: RowContext): ReactElement {
  return (
    <PrRow
      key={`p${prKey(row.pr)}`}
      pr={row.pr}
      expanded={row.expanded}
      running={row.running}
      selected={c.selected}
      contextCell={row.contextCell}
      sort={c.prSort}
    />
  );
}

function sessionRow(row: RowOf<"session">, c: RowContext): ReactElement {
  return (
    <SessionRow
      key={row.key}
      session={row.session}
      running={row.running}
      kind={row.running ? c.model.liveKinds.get(sessionName(row.session)) : undefined}
      pane={row.running ? c.panes.get(sessionName(row.session)) : undefined}
      expanded={row.expanded}
      selected={c.selected}
      timeField={row.timeField}
      open={row.open}
      showLink={row.showLink}
      placeholder={row.placeholder}
    />
  );
}

function sessmetaRow(row: RowOf<"sessmeta">): ReactElement {
  return (
    <Box key={row.key} marginLeft={6}>
      <Text wrap="truncate" dimColor>
        <Text color="gray">{row.label.padEnd(8)}</Text>
        {row.value}
      </Text>
    </Box>
  );
}

function sesspromptRow(row: RowOf<"sessprompt">): ReactElement {
  return (
    <Box key={row.key} marginLeft={6}>
      <Text wrap="truncate" dimColor>{`↳ "${row.prompt.replace(/\s+/g, " ")}"`}</Text>
    </Box>
  );
}

function taskRow(row: RowOf<"task">): ReactElement {
  return <TaskRow key={row.key} task={row.task} />;
}

function actionRow(row: RowOf<"action">): ReactElement {
  return <ActionRow key={row.key} action={row.action} />;
}

function sessnoteRow(row: RowOf<"sessnote">): ReactElement {
  return (
    <Box key={row.key} marginLeft={6}>
      <Text dimColor italic>{row.text}</Text>
    </Box>
  );
}

function newsessRow(_row: RowOf<"newsess">, c: RowContext): ReactElement {
  return (
    <Box key="newsess">
      <Text bold color={c.selected ? "black" : "green"} backgroundColor={c.selected ? "cyan" : undefined}>
        {"＋ new session"}
      </Text>
    </Box>
  );
}

function freshRow(row: RowOf<"fresh">, c: RowContext): ReactElement {
  return (
    <Box key={row.key} marginLeft={4}>
      <Text color={c.selected ? "black" : "gray"} backgroundColor={c.selected ? "cyan" : undefined}>
        {"+ start a fresh session…"}
      </Text>
    </Box>
  );
}

function toggleRow(row: RowOf<"toggle">, c: RowContext): ReactElement {
  const caret = row.open ? "▾" : "▸";
  return (
    <Box key={`toggle:${row.id}`} marginLeft={row.indent ?? 0}>
      <Text wrap="truncate" color={c.selected ? "black" : "blue"} backgroundColor={c.selected ? "cyan" : undefined} bold>
        {`${caret} ${row.label} (${row.count})`}
        {row.sub ? <Text color={c.selected ? "black" : "gray"}>{`  ${row.sub}`}</Text> : null}
      </Text>
    </Box>
  );
}

const ROW_RENDERERS: { [K in Row["kind"]]: Renderer<K> } = {
  spacer: spacerRow,
  header: headerRow,
  item: itemRow,
  pr: prRow,
  session: sessionRow,
  sessmeta: sessmetaRow,
  sessprompt: sesspromptRow,
  task: taskRow,
  action: actionRow,
  sessnote: sessnoteRow,
  newsess: newsessRow,
  fresh: freshRow,
  toggle: toggleRow,
};

export function renderRow(
  row: Row,
  i: number,
  d: { cursor: number; searchFocus: SearchFocus; model: LoadedModel; panes: Map<string, PaneState>; prSort: PrSort },
): ReactElement {
  const c: RowContext = { i, selected: i === d.cursor && d.searchFocus !== "input", model: d.model, panes: d.panes, prSort: d.prSort };
  // The table is exhaustive over `Row["kind"]`; the cast only widens the
  // renderer's parameter from the one narrowed kind to the union.
  const render = ROW_RENDERERS[row.kind] as (row: Row, c: RowContext) => ReactElement;
  return render(row, c);
}

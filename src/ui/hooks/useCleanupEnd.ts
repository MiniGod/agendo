import type { Key } from "ink";
import { useState, type SetStateAction } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import type { CleanupRow } from "../../cleanup/types.ts";
import { killHovered, pauseHovered, type EndCtx } from "../actions/sessionEnd.ts";
import { handleConfirmEndKeys } from "../keys/confirmEnd.ts";
import type { Mode } from "../keys/context.ts";
import type { CleanupEffect } from "../keys/cleanup.ts";
import type { Row } from "../models/rows.ts";

/**
 * A cleanup row as the one-row list the session-row actions read: a session
 * row when it has a session, else nothing — which those actions refuse with
 * "this row is not a session", exactly as they do on the list.
 */
export function endRowsOf(row: CleanupRow | undefined): Row[] {
  if (!row?.session) return [];
  return [{ kind: "session", key: row.key, session: row.session, running: row.run === "running", expanded: false, placeholder: row.run === "paused" }];
}

type ConfirmMode = Extract<Mode, { kind: "confirmEnd" }>;

/**
 * `p` / `x` / `X` in the cleanup view. They are the list's own session-row
 * actions (src/ui/actions/sessionEnd.ts) and its own y/n handler
 * (src/ui/keys/confirmEnd.ts), handed a context in which the focused cleanup
 * row is the hovered row, the view's note line is the notice, and the y/n
 * lives here instead of in App's mode — so answering it returns to this view,
 * not to the list.
 */
export function useCleanupEnd({
  model,
  setNote,
  reload,
  onQuit,
}: {
  model: LoadedModel;
  setNote: (note: string | null) => void;
  reload: () => void;
  onQuit: () => void;
}) {
  const [confirm, setConfirm] = useState<ConfirmMode | null>(null);
  const setMode = (m: SetStateAction<Mode>) =>
    setConfirm((prev) => {
      const next = typeof m === "function" ? m(prev ?? { kind: "list" }) : m;
      return next.kind === "confirmEnd" ? next : null;
    });
  const setNotice = (n: SetStateAction<string | null>) => setNote(typeof n === "function" ? null : n);
  const ctxOf = (row: CleanupRow | undefined): EndCtx => ({ rows: endRowsOf(row), cursor: 0, setNotice, setMode, reload, model });

  /** Start the action an end key asked for on `row`. */
  const start = (effect: CleanupEffect, row: CleanupRow | undefined) => {
    if (effect === "pause") pauseHovered(ctxOf(row));
    else killHovered(ctxOf(row), effect === "forceKill");
  };

  /** A key while the y/n is up; false when there is none. */
  const answer = (input: string, key: Key): boolean => {
    if (!confirm) return false;
    return handleConfirmEndKeys(input, key, { ...ctxOf(undefined), mode: confirm, exit: onQuit });
  };

  return { confirm, start, answer };
}

import { useRef } from "react";
import { discoverProfiles, moveSessionToProfile, profileChoices, type ClaudeProfile } from "../profiles.ts";
import { isRunning, refreshLiveTmux, type LoadedModel } from "../model.ts";
import { retargetRestoreProfile } from "../restore.ts";
import type { AgentSession } from "../types.ts";
import type { Activity } from "./format.ts";
import type { Mode } from "./keys/context.ts";

/**
 * Moving a Claude session to another profile (`m`), lifted out of App.
 *
 * A hook rather than a plain factory, and named as one: it holds the
 * `moveInFlight` ref, which `rules-of-hooks` correctly refuses to let live in
 * anything not called `use*`. It is called unconditionally at App's top level,
 * so hook order is unchanged — which is the property that made this safe to lift
 * at all. App was on its `max-lines` cap and the host guard below had to come
 * from somewhere.
 */
export function useProfileMove({
  model,
  modelRef,
  setMode,
  setNotice,
  setBusy,
  setActivity,
  requested,
  reload,
  hostSession,
}: {
  model: LoadedModel | null;
  modelRef: React.MutableRefObject<LoadedModel | null>;
  setMode: (m: Mode) => void;
  setNotice: (n: string | null) => void;
  setBusy: (b: string | null) => void;
  setActivity: React.Dispatch<React.SetStateAction<Map<string, Activity>>>;
  requested: React.MutableRefObject<Set<string>>;
  reload: () => void;
  hostSession: string | undefined;
}) {
// ── move a session to another Claude profile ────────────────────────────────
// Open the picker for the hovered session. Every guard that can be answered
// without touching disk is answered here, so the picker only ever appears when
// a move is actually possible.
//
// A RUNNING session is refused rather than moved. agendo can tell that a
// session is live (window→session attribution), and `paneReadiness` can even
// say its input box looks idle — but that read is a documented best-effort
// screen scrape (it returns "unknown" for any screen it doesn't recognize, and
// says nothing about background bash, in-flight sub-agents or background
// tasks), and there is no graceful-exit primitive to hand the agent anyway:
// killWindow is a hard kill. Moving files out from under a live `claude` is not
// worth guessing at, so the safe refusal is the whole behaviour.
const enterProfilePicker = async (s: AgentSession) => {
  setNotice(null);
  // A session on another machine is refused FIRST, and by name. The generic
  // guards below would already stop it — it carries no `logPath` and it is
  // always running — but they would say "no on-disk transcript", which is true
  // of the wrong machine and reads as corruption rather than as geography.
  if (s.host) {
    setNotice(`${s.title} is on ${s.host} — a profile move relocates files, and those are on that machine.`);
    return;
  }
  if (s.source !== "claude") {
    setNotice(`${s.source} sessions have no profile — only Claude sessions live in a ~/.claude* dir.`);
    return;
  }
  if (!s.configDir || !s.logPath) {
    setNotice("This session has no on-disk transcript to move.");
    return;
  }
  if (isRunning(s, model?.liveTmux ?? new Set())) {
    setNotice(`${s.title} is running — exit it (or close its tmux window) before moving it to another profile.`);
    return;
  }
  setBusy("Scanning Claude profiles…");
  const choices = profileChoices(await discoverProfiles(), s);
  setBusy(null);
  const firstTarget = choices.findIndex((c) => !c.current);
  if (firstTarget < 0) {
    setNotice("No other Claude profile found — create a second ~/.claude* dir with a projects/ folder first.");
    return;
  }
  setMode({ kind: "profile", session: s, choices, cursor: firstTarget });
};

// Perform the move, then refresh: the session index is keyed by transcript
// path, so a reload is what re-files it under the target profile (and re-reads
// its activity from the new location).
//
// Two guards stand between a keystroke and the filesystem:
//  • `moveInFlight` — `busy` swaps the RENDER but doesn't gate `useInput`, and
//    `mode` only leaves "profile" once the await resolves, so a key-repeat on
//    enter would otherwise start a second move racing the first over the same
//    four renames. The loser hits ENOENT and rolls back the entries it won,
//    tearing the session in half across the two profiles — exactly the state
//    this feature must never produce. The mode is also dropped up front, so a
//    stray enter has no picker left to act on.
//  • a FRESH liveness read — the running-session refusal is the entire safety
//    story for a live agent, and the picker can sit open indefinitely. A session
//    resumed in the meantime (a keypress in its restore-placeholder tab from
//    another tmux client, a second agendo) must not have its files pulled out
//    from under it, so the check is re-run against tmux at commit time rather
//    than trusted from picker-entry.
const moveInFlight = useRef(false);
const moveToProfile = async (s: AgentSession, target: ClaudeProfile) => {
  if (moveInFlight.current) return;
  moveInFlight.current = true;
  setNotice(null);
  setMode({ kind: "list" });
  setBusy(`Moving “${s.title}” to ${target.name}…`);
  try {
    await runMove(s, target);
  } finally {
    moveInFlight.current = false;
    setBusy(null);
  }
};

const runMove = async (s: AgentSession, target: ClaudeProfile) => {
  const sessions = (modelRef.current?.sessionGroups ?? []).flatMap((g) => g.sessions);
  if (isRunning(s, refreshLiveTmux(sessions).live)) {
    setNotice(`${s.title} started running — exit it (or close its tmux window) before moving it to another profile.`);
    return;
  }
  const res = await moveSessionToProfile(s, target);
  if (res.error) {
    setNotice(`Move failed: ${res.error}`);
    return;
  }
  if (res.noop) {
    setNotice(`${target.name} is the same directory on disk as this session's profile — nothing to move.`);
    return;
  }
  // The restore snapshot bakes CLAUDE_CONFIG_DIR into each tab's argv, so a
  // moved session's saved tab has to be repointed — and an already-visible
  // placeholder tab rebuilt — or it would resume against the profile it just left.
  const tab = retargetRestoreProfile(s, target.configDir, hostSession);
  setActivity(new Map()); // its log lives elsewhere now — drop the cached parse
  requested.current.clear();
  reload();
  const extras = [
    res.warning,
    tab.placeholderRefreshed ? "restored tab repointed" : null,
  ].filter(Boolean);
  setNotice(`Moved “${s.title}” → ${target.name}${extras.length ? ` (${extras.join("; ")})` : ""}`);
};

  return { enterProfilePicker, moveToProfile };
}

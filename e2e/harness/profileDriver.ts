// Child driver for the profile-move spec (profiles.spec.ts).
//
// Same shape as cacheDriver.ts and for the same reason: os.homedir() is read at
// process start, so profile discovery can only be exercised against a fixture
// corpus inside a child whose HOME is that corpus. It builds a multi-profile
// $HOME, drives src/profiles.ts + src/sessions.ts through the move scenarios in
// order, and prints one JSON blob for the parent spec to assert on.
//
// Scenarios (one session each, so a failure names itself):
//   S1 move        — a real move, incl. sidecar / session-env / tasks, the
//                    re-anchored workflow paths, and the index re-filing it
//   S2 clobber     — the target already holds an <id>.jsonl → refuse, no damage
//   S3 exdev       — the copy-then-delete fallback (forced, see the seam)
//   S4 symlink     — a transcript symlinked across profiles is listed ONCE,
//                    attributed to the profile that really holds it
//   S5 alias/noop  — a profile whose projects/ is a symlink of another's is
//                    collapsed by discovery, and moving into it does nothing
//   S6 rollback    — a late entry fails → everything renamed goes back and the
//                    directories the attempt created are swept up
//   S7 partialCopy — a `cp` dying mid-tree leaves no debris at the destination
//   S8 leftover    — a source that can't be deleted is a WARNING, not a failure
//   S9 clobber(dst)— the destination-side check fires for a piece the source
//                    doesn't even have
//   S10 agents     — sibling agent-*.jsonl travel only on content evidence
// …plus retargetRestoreProfile rewriting a saved tab's baked CLAUDE_CONFIG_DIR.
//
// S6-S8 are provoked with file permissions, which root ignores; they report null
// instead of a false pass when the suite runs as root.
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SessionIndex, __claudeCacheSize } from "../../src/sessions.ts";
import {
  discoverProfiles,
  dedupeProfiles,
  moveSessionToProfile,
  profileChoices,
  __setForceCrossDevice,
  type ClaudeProfile,
} from "../../src/profiles.ts";
import { loadWorkflowDetails } from "../../src/workflows.ts";
import { retargetRestoreProfile } from "../../src/restore.ts";
import type { AgentSession } from "../../src/types.ts";

const HOME = homedir();
const ENC = "-repo-a"; // one encoded-cwd dir, shared by every session
const CWD = "/repo/a";

const rec = (o: unknown) => JSON.stringify(o);

/** A transcript with one Workflow launch, whose recorded paths are ABSOLUTE —
 *  the thing a move would otherwise break. */
function transcript(id: string, sessionDir: string): string {
  return (
    [
      rec({ type: "summary", cwd: CWD, gitBranch: "feature/x", timestamp: "2026-07-08T09:00:00Z" }),
      rec({ type: "ai-title", aiTitle: `Title ${id}`, timestamp: "2026-07-08T09:00:01Z" }),
      rec({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "launched" }] },
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          runId: "wf_1",
          taskId: "task-1",
          workflowName: "demo",
          transcriptDir: join(sessionDir, "subagents", "workflows", "wf_1"),
          scriptPath: join(sessionDir, "workflows", "scripts", "demo-wf_1.js"),
        },
        timestamp: "2026-07-08T09:00:02Z",
      }),
    ].join("\n") + "\n"
  );
}

/** Write a complete session — transcript + every piece the move set covers. */
function makeSession(profile: string, id: string): void {
  const enc = join(HOME, profile, "projects", ENC);
  const sessionDir = join(enc, id);
  mkdirSync(enc, { recursive: true });
  writeFileSync(join(enc, `${id}.jsonl`), transcript(id, sessionDir));
  // sidecar: a workflow run's journal + its persisted script
  const wfDir = join(sessionDir, "subagents", "workflows", "wf_1");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, "journal.jsonl"),
    [rec({ type: "started", agentId: "a1" }), rec({ type: "result", agentId: "a1" })].join("\n") + "\n",
  );
  const scripts = join(sessionDir, "workflows", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "demo-wf_1.js"), "export const meta = {\n  description: 'Demo run',\n}\n");
  // per-session state beside the store
  for (const dir of ["session-env", "tasks"]) {
    mkdirSync(join(HOME, profile, dir, id), { recursive: true });
    writeFileSync(join(HOME, profile, dir, id, "state.json"), `{"id":"${id}"}`);
  }
}

const sessionOf = (idx: SessionIndex, id: string): AgentSession | undefined => idx.all.find((s) => s.id === id);
const profileOf = (s?: AgentSession) => (s?.configDir ?? "").replace(HOME + "/", "");
const relative = (p?: string) => (p ?? "").replace(HOME + "/", "");

/** Every piece of a session that should travel with it, as profile-relative paths. */
const pieces = (profile: string, id: string) => [
  `${profile}/projects/${ENC}/${id}.jsonl`,
  `${profile}/projects/${ENC}/${id}/subagents/workflows/wf_1/journal.jsonl`,
  `${profile}/projects/${ENC}/${id}/workflows/scripts/demo-wf_1.js`,
  `${profile}/session-env/${id}/state.json`,
  `${profile}/tasks/${id}/state.json`,
];
const allExist = (profile: string, id: string) => pieces(profile, id).every((p) => existsSync(join(HOME, p)));
const noneExist = (profile: string, id: string) => pieces(profile, id).every((p) => !existsSync(join(HOME, p)));

const byName = (ps: ClaudeProfile[], name: string) => ps.find((p) => p.name === name)!;

// ── build the corpus ─────────────────────────────────────────────────────────
for (const id of ["aaaa1111", "bbbb2222", "cccc3333", "eeee5555"]) makeSession(".claude", id);
// S4 lives in .claude and is SYMLINKED into .claude-work (a per-file alias — the
// stores differ, but both names reach one inode).
makeSession(".claude", "dddd4444");
mkdirSync(join(HOME, ".claude-work", "projects", ENC), { recursive: true });
symlinkSync(
  join(HOME, ".claude", "projects", ENC, "dddd4444.jsonl"),
  join(HOME, ".claude-work", "projects", ENC, "dddd4444.jsonl"),
);
// A third profile that is nothing but another name for .claude's store.
mkdirSync(join(HOME, ".claude-alias"), { recursive: true });
symlinkSync(join(HOME, ".claude", "projects"), join(HOME, ".claude-alias", "projects"));

// ── discovery ────────────────────────────────────────────────────────────────
const all = await discoverProfiles();
const deduped = dedupeProfiles(all);
const discovery = {
  all: all.map((p) => p.name),
  deduped: deduped.map((p) => p.name),
};
const work = byName(all, ".claude-work");
const alias = byName(all, ".claude-alias");

// ── S4: a symlinked transcript is listed once, under the profile that owns it ──
const idx0 = await SessionIndex.build();
const symlink = {
  count: idx0.all.filter((s) => s.id === "dddd4444").length,
  profile: profileOf(sessionOf(idx0, "dddd4444")),
  totalSessions: idx0.all.length,
};

// ── S1: the move ─────────────────────────────────────────────────────────────
const s1before = sessionOf(idx0, "aaaa1111")!;
const detailsBefore = await loadWorkflowDetails(s1before.workflows![0]);
const moveRes = await moveSessionToProfile(s1before, work);
const idx1 = await SessionIndex.build();
const s1after = sessionOf(idx1, "aaaa1111");
const detailsAfter = s1after?.workflows?.[0] ? await loadWorkflowDetails(s1after.workflows[0]) : null;
const move = {
  error: moveRes.error ?? null,
  moved: moveRes.moved ?? [],
  warning: moveRes.warning ?? null,
  sourceGone: noneExist(".claude", "aaaa1111"),
  targetHasAll: allExist(".claude-work", "aaaa1111"),
  profile: profileOf(s1after),
  logPath: relative(s1after?.logPath),
  // The recorded workflow paths were absolute under .claude; if they weren't
  // re-anchored on the transcript, this would still point into the old profile
  // and the details below would come back empty.
  transcriptDir: relative(s1after?.workflows?.[0]?.transcriptDir),
  detailsBefore: { agentsDone: detailsBefore.agentsDone, description: detailsBefore.description ?? null },
  detailsAfter: { agentsDone: detailsAfter?.agentsDone ?? -1, description: detailsAfter?.description ?? null },
  // The parse cache is keyed by absolute transcript path; the entry for the old
  // location must be pruned rather than shadow the new one.
  cacheSize: __claudeCacheSize(),
  sessionsIndexed: idx1.all.length,
};

// ── S2: refuse to clobber ────────────────────────────────────────────────────
// Plant an unrelated file exactly where S2's transcript would land.
mkdirSync(join(HOME, ".claude-work", "projects", ENC), { recursive: true });
writeFileSync(join(HOME, ".claude-work", "projects", ENC, "bbbb2222.jsonl"), "not yours\n");
const s2 = sessionOf(idx1, "bbbb2222")!;
const clobberRes = await moveSessionToProfile(s2, work);
const clobber = {
  error: clobberRes.error ?? null,
  sourceIntact: allExist(".claude", "bbbb2222"),
  decoyIntact: readFileSync(join(HOME, ".claude-work", "projects", ENC, "bbbb2222.jsonl"), "utf-8").trim(),
};

// ── S3: the cross-device (copy-then-delete) fallback ─────────────────────────
const s3 = sessionOf(idx1, "cccc3333")!;
const s3Before = readFileSync(s3.logPath!, "utf-8");
__setForceCrossDevice(true);
const exdevRes = await moveSessionToProfile(s3, work);
__setForceCrossDevice(false);
const idx2 = await SessionIndex.build();
const s3after = sessionOf(idx2, "cccc3333");
const exdev = {
  error: exdevRes.error ?? null,
  warning: exdevRes.warning ?? null,
  sourceGone: noneExist(".claude", "cccc3333"),
  targetHasAll: allExist(".claude-work", "cccc3333"),
  profile: profileOf(s3after),
  // A copy must be byte-identical, and the sidecar must have come along whole.
  identical: readFileSync(join(HOME, ".claude-work", "projects", ENC, "cccc3333.jsonl"), "utf-8") === s3Before,
};

// ── S5: an aliased profile is not a destination ──────────────────────────────
const s5 = sessionOf(idx2, "eeee5555")!;
const noopRes = await moveSessionToProfile(s5, alias);
const noop = {
  noop: !!noopRes.noop,
  error: noopRes.error ?? null,
  stillInPlace: allExist(".claude", "eeee5555"),
  // The picker must grey the alias out too — it's the same store, whatever it's called.
  choices: profileChoices(all, s5).map((c) => `${c.profile.name}${c.current ? ":current" : ""}`),
};

// A Copilot session has no profile at all.
const copilot = await moveSessionToProfile(
  { id: "cop-1", source: "copilot", cwd: CWD, title: "x", lastUsed: new Date(), logPath: "/tmp/x" },
  work,
);

// ── failure paths ────────────────────────────────────────────────────────────
// The three below are provoked with file permissions, which root ignores — so
// they report null rather than a false pass when the suite runs as root.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// A pristine fourth profile, so the directory scaffolding a failed move creates
// is visible (moving into .claude-work would find every dir already there).
// Created AFTER the discovery snapshot above, which asserts on the first three.
const SPARE = ".claude-spare";
mkdirSync(join(HOME, SPARE, "projects"), { recursive: true });
mkdirSync(join(HOME, SPARE, "tasks"), { recursive: true });
const spare = byName(await discoverProfiles(), SPARE);

for (const id of ["ffff6666", "gggg7777", "hhhh8888", "iiii9999", "jjjj0000", "kkkk1111"]) makeSession(".claude", id);

// S9 has NO sidecar of its own, but the target already holds a foreign one —
// the clobber check must be about the DESTINATION, not about what the source has.
rmSync(join(HOME, ".claude", "projects", ENC, "iiii9999"), { recursive: true, force: true });
mkdirSync(join(HOME, ".claude-work", "projects", ENC, "iiii9999"), { recursive: true });
writeFileSync(join(HOME, ".claude-work", "projects", ENC, "iiii9999", "not-mine.txt"), "someone else's\n");

// S10 sits beside two top-level sidechain transcripts: one whose records name it,
// one naming a different session. Only the first is its to take.
const encDir = join(HOME, ".claude", "projects", ENC);
writeFileSync(join(encDir, "agent-mine.jsonl"), rec({ agentId: "x", sessionId: "jjjj0000" }) + "\n");
writeFileSync(join(encDir, "agent-theirs.jsonl"), rec({ agentId: "y", sessionId: "eeee5555" }) + "\n");

// S11 owns a sidechain transcript whose NAME is already taken in the target.
// Those destinations are outside the fixed four, so they need their own place in
// the clobber check — on the rename path an existing file would be replaced
// silently, and rollback can restore the source but not what was overwritten.
writeFileSync(join(encDir, "agent-dup.jsonl"), rec({ agentId: "z", sessionId: "kkkk1111" }) + "\n");
writeFileSync(join(HOME, ".claude-work", "projects", ENC, "agent-dup.jsonl"), "someone else's sidechain\n");

const idx3 = await SessionIndex.build();

// S6 — ROLLBACK: the last entry (tasks/) can't be written, so everything already
// renamed must go back and the dirs this move created must go with it.
let rollback: unknown = null;
if (!isRoot) {
  chmodSync(join(HOME, SPARE, "tasks"), 0o555);
  const res = await moveSessionToProfile(sessionOf(idx3, "ffff6666")!, spare);
  chmodSync(join(HOME, SPARE, "tasks"), 0o755);
  rollback = {
    error: res.error ?? null,
    sourceRestored: allExist(".claude", "ffff6666"),
    targetEmpty: noneExist(SPARE, "ffff6666"),
    // Scaffolding the failed move created must not be left behind.
    dirsCleaned:
      !existsSync(join(HOME, SPARE, "projects", ENC)) && !existsSync(join(HOME, SPARE, "session-env")),
  };
}

// S7 — PARTIAL COPY: on the cross-device path a `cp` that dies midway through the
// sidecar leaves a half-written tree at the destination. It has to be swept up, or
// every retry would abort on the clobber check.
//
// Deliberately targets .claude-work, NOT the spare: the spare's dirs would be
// created by this very move, so rolling those away would remove the debris as a
// side effect and the assertion would pass whether or not the sweep exists. In
// .claude-work every destination dir is already there, so the half-written tree is
// the only thing that can clean it up.
let partialCopy: unknown = null;
if (!isRoot) {
  chmodSync(join(HOME, ".claude", "projects", ENC, "gggg7777", "workflows", "scripts", "demo-wf_1.js"), 0o000);
  __setForceCrossDevice(true);
  const res = await moveSessionToProfile(sessionOf(idx3, "gggg7777")!, work);
  __setForceCrossDevice(false);
  chmodSync(join(HOME, ".claude", "projects", ENC, "gggg7777", "workflows", "scripts", "demo-wf_1.js"), 0o644);
  partialCopy = {
    error: res.error ?? null,
    sourceIntact: allExist(".claude", "gggg7777"),
    // Neither the sidecar cp that got partway through NOR the transcript copied
    // before it may survive.
    debrisLeft:
      existsSync(join(HOME, ".claude-work", "projects", ENC, "gggg7777")) ||
      existsSync(join(HOME, ".claude-work", "projects", ENC, "gggg7777.jsonl")),
  };
}

// S8 — PHASE-2 LEFTOVER: the copies are all in place, but a source can't be
// deleted. That is a SUCCESSFUL move carrying a warning, not a failure.
let leftover: unknown = null;
if (!isRoot) {
  chmodSync(join(HOME, ".claude", "tasks"), 0o555);
  __setForceCrossDevice(true);
  const res = await moveSessionToProfile(sessionOf(idx3, "hhhh8888")!, spare);
  __setForceCrossDevice(false);
  chmodSync(join(HOME, ".claude", "tasks"), 0o755);
  leftover = {
    error: res.error ?? null,
    warning: res.warning ?? null,
    targetHasAll: allExist(SPARE, "hhhh8888"),
    sourceStillHasTasks: existsSync(join(HOME, ".claude", "tasks", "hhhh8888")),
  };
}

// S9 — the destination-side clobber check, for a piece the source doesn't have.
const noSidecarRes = await moveSessionToProfile(sessionOf(idx3, "iiii9999")!, work);
const clobberDestOnly = {
  error: noSidecarRes.error ?? null,
  sourceIntact: existsSync(join(HOME, ".claude", "projects", ENC, "iiii9999.jsonl")),
};

// S10 — sidechain transcripts travel only on positive content evidence.
const agentsRes = await moveSessionToProfile(sessionOf(idx3, "jjjj0000")!, work);
const agentTranscripts = {
  moved: agentsRes.moved ?? [],
  mineMoved: existsSync(join(HOME, ".claude-work", "projects", ENC, "agent-mine.jsonl")),
  mineGoneFromSource: !existsSync(join(encDir, "agent-mine.jsonl")),
  theirsStayed: existsSync(join(encDir, "agent-theirs.jsonl")),
  theirsNotTaken: !existsSync(join(HOME, ".claude-work", "projects", ENC, "agent-theirs.jsonl")),
};

// S11 — a sidechain transcript whose name is taken at the target blocks the move.
const dupRes = await moveSessionToProfile(sessionOf(idx3, "kkkk1111")!, work);
const sidechainClobber = {
  error: dupRes.error ?? null,
  sourceIntact:
    existsSync(join(encDir, "kkkk1111.jsonl")) && existsSync(join(encDir, "agent-dup.jsonl")),
  decoyIntact: readFileSync(join(HOME, ".claude-work", "projects", ENC, "agent-dup.jsonl"), "utf-8").trim(),
};

// ── restore snapshot retargeting ─────────────────────────────────────────────
// A saved tab bakes CLAUDE_CONFIG_DIR in; the move has to repoint it. (tmux is
// stubbed to fail in this child, so the live-placeholder half is a no-op here.)
const restoreDir = join(HOME, ".agendo", "restore");
mkdirSync(restoreDir, { recursive: true });
writeFileSync(
  join(restoreDir, "agendo.json"),
  JSON.stringify({
    tabs: [
      {
        name: "cl-claude-aaaa1111",
        cwd: CWD,
        title: "Title aaaa1111",
        argv: ["env", `CLAUDE_CONFIG_DIR=${join(HOME, ".claude")}`, "claude", "--resume", "aaaa1111"],
      },
      { name: "cl-claude-zzzz9999", cwd: CWD, title: "other", argv: ["claude", "--resume", "zzzz9999"] },
    ],
  }),
);
const retarget = retargetRestoreProfile({ id: "aaaa1111", source: "claude", cwd: CWD }, work.configDir);
const savedTabs = JSON.parse(readFileSync(join(restoreDir, "agendo.json"), "utf-8")).tabs as {
  name: string;
  argv: string[];
}[];
const restore = {
  tabUpdated: retarget.tabUpdated,
  placeholderRefreshed: retarget.placeholderRefreshed,
  argv: savedTabs.find((t) => t.name === "cl-claude-aaaa1111")!.argv,
  untouched: savedTabs.find((t) => t.name === "cl-claude-zzzz9999")!.argv,
  // A session with no saved tab must leave the snapshot alone.
  noTab: retargetRestoreProfile({ id: "nosuch", source: "claude", cwd: CWD }, work.configDir).tabUpdated,
};

process.stdout.write(
  JSON.stringify({
    discovery,
    symlink,
    move,
    clobber,
    exdev,
    noop,
    copilotError: copilot.error ?? null,
    isRoot,
    rollback,
    partialCopy,
    leftover,
    clobberDestOnly,
    agentTranscripts,
    sidechainClobber,
    restore,
  }),
);

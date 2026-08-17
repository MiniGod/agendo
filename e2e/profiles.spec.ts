// Moving a session between Claude config profiles (~/.claude, ~/.claude-work, …)
// and the symlink-awareness that goes with it — see src/profiles.ts.
//
// Profile discovery reads os.homedir(), which is fixed at process start, so the
// scenarios run in a child (profileDriver.ts) against a throwaway multi-profile
// $HOME and report a JSON summary we assert on here. Same pattern as
// sessions-cache.spec.ts, and for the same reason.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";

test("move a session between Claude profiles: move · clobber · EXDEV · symlinks · failure paths", () => {
  const home = mkdtempSync(join(tmpdir(), "agendo-profiles-"));
  try {
    // The restore-snapshot path shells out to tmux. Stub it to a plain failure so
    // the child can never see (or touch) the developer's real tmux server — every
    // tmux read then returns "nothing live", which is the state this spec assumes.
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = spawnSync("bun", [join(REPO_ROOT, "e2e", "harness", "profileDriver.ts")], {
      // HOME must be set from the child's start so os.homedir() resolves to it.
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf-8",
    });
    expect(r.status, `driver stderr:\n${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout) as {
      discovery: { all: string[]; deduped: string[] };
      symlink: { count: number; profile: string; totalSessions: number };
      move: {
        error: string | null;
        moved: string[];
        warning: string | null;
        sourceGone: boolean;
        targetHasAll: boolean;
        profile: string;
        logPath: string;
        transcriptDir: string;
        detailsBefore: { agentsDone: number; description: string | null };
        detailsAfter: { agentsDone: number; description: string | null };
        cacheSize: number;
        sessionsIndexed: number;
      };
      clobber: { error: string | null; sourceIntact: boolean; decoyIntact: string };
      exdev: {
        error: string | null;
        warning: string | null;
        sourceGone: boolean;
        targetHasAll: boolean;
        profile: string;
        identical: boolean;
      };
      noop: { noop: boolean; error: string | null; stillInPlace: boolean; choices: string[] };
      copilotError: string | null;
      isRoot: boolean;
      rollback: { error: string | null; sourceRestored: boolean; targetEmpty: boolean; dirsCleaned: boolean } | null;
      partialCopy: { error: string | null; sourceIntact: boolean; debrisLeft: boolean } | null;
      leftover: {
        error: string | null;
        warning: string | null;
        targetHasAll: boolean;
        sourceStillHasTasks: boolean;
      } | null;
      clobberDestOnly: { error: string | null; sourceIntact: boolean };
      agentTranscripts: {
        moved: string[];
        mineMoved: boolean;
        mineGoneFromSource: boolean;
        theirsStayed: boolean;
        theirsNotTaken: boolean;
      };
      sidechainClobber: { error: string | null; sourceIntact: boolean; decoyIntact: string };
      restore: {
        tabUpdated: boolean;
        placeholderRefreshed: boolean;
        argv: string[];
        untouched: string[];
        noTab: boolean;
      };
    };

    // DISCOVERY: all three ~/.claude* dirs are found, but the one whose projects/
    // is a symlink of another's collapses away before anything is scanned.
    expect(out.discovery.all).toEqual([".claude", ".claude-alias", ".claude-work"]);
    expect(out.discovery.deduped).toEqual([".claude", ".claude-work"]);

    // SYMLINK DEDUP: a transcript symlinked into a second profile is listed once,
    // attributed to the profile that actually holds the bytes (the realpath owner)
    // — so `CLAUDE_CONFIG_DIR` on resume points at the right subscription.
    expect(out.symlink.count).toBe(1);
    expect(out.symlink.profile).toBe(".claude");
    expect(out.symlink.totalSessions).toBe(5);

    // MOVE: every id-keyed piece travels, the source is left empty, and the
    // session re-files under the target profile on the next index build.
    expect(out.move.error).toBeNull();
    expect(out.move.warning).toBeNull();
    expect(out.move.moved).toEqual([
      "projects/-repo-a/aaaa1111.jsonl",
      "projects/-repo-a/aaaa1111/",
      "session-env/aaaa1111/",
      "tasks/aaaa1111/",
    ]);
    expect(out.move.sourceGone).toBe(true);
    expect(out.move.targetHasAll).toBe(true);
    expect(out.move.profile).toBe(".claude-work");
    expect(out.move.logPath).toBe(".claude-work/projects/-repo-a/aaaa1111.jsonl");
    // No session is lost or duplicated by the move.
    expect(out.move.sessionsIndexed).toBe(5);

    // WORKFLOW PATHS: recorded absolute in the transcript under the OLD profile,
    // re-anchored on the transcript at read time — so the run's details survive.
    expect(out.move.detailsBefore).toEqual({ agentsDone: 1, description: "Demo run" });
    expect(out.move.transcriptDir).toBe(".claude-work/projects/-repo-a/aaaa1111/subagents/workflows/wf_1");
    expect(out.move.detailsAfter).toEqual({ agentsDone: 1, description: "Demo run" });

    // PARSE CACHE: keyed by absolute transcript PATH, so the vacated path must be
    // pruned rather than shadow the new one. Six keys for five sessions: the five
    // real transcripts plus S4's symlink, which is a second path the scan
    // enumerates (and which the id dedupe, not the cache, collapses).
    expect(out.move.cacheSize).toBe(6);

    // CLOBBER: something already at the destination aborts the whole move before
    // a single file is touched; source and the file in the way are both intact.
    expect(out.clobber.error).toContain("already has");
    expect(out.clobber.error).toContain("bbbb2222.jsonl");
    expect(out.clobber.sourceIntact).toBe(true);
    expect(out.clobber.decoyIntact).toBe("not yours");

    // EXDEV: rename(2) across filesystems fails, so the move falls back to
    // copy-then-delete — same end state, byte-identical content.
    expect(out.exdev.error).toBeNull();
    expect(out.exdev.warning).toBeNull();
    expect(out.exdev.sourceGone).toBe(true);
    expect(out.exdev.targetHasAll).toBe(true);
    expect(out.exdev.identical).toBe(true);
    expect(out.exdev.profile).toBe(".claude-work");

    // ALIAS: a profile that is just another name for the session's own store is a
    // no-op, not a copy of a symlink's target into place — and the picker greys
    // both names out rather than offering the move.
    expect(out.noop.noop).toBe(true);
    expect(out.noop.error).toBeNull();
    expect(out.noop.stillInPlace).toBe(true);
    expect(out.noop.choices).toEqual([".claude:current", ".claude-alias:current", ".claude-work"]);

    // Copilot sessions have no profile to move between.
    expect(out.copilotError).toContain("only Claude sessions");

    // CLOBBER, DESTINATION SIDE: the source has no sidecar, but the target holds a
    // foreign `<id>/`. The transcript must not land beside someone else's sidecar —
    // the rebased workflow paths would then read that other run's files.
    expect(out.clobberDestOnly.error).toContain("already has");
    expect(out.clobberDestOnly.error).toContain("iiii9999/");
    expect(out.clobberDestOnly.sourceIntact).toBe(true);

    // SIDECHAIN TRANSCRIPTS: a sibling agent-*.jsonl travels only when its records
    // name this session; one naming another session is left strictly alone.
    expect(out.agentTranscripts.moved).toContain("projects/-repo-a/agent-mine.jsonl");
    expect(out.agentTranscripts.moved).not.toContain("projects/-repo-a/agent-theirs.jsonl");
    expect(out.agentTranscripts.mineMoved).toBe(true);
    expect(out.agentTranscripts.mineGoneFromSource).toBe(true);
    expect(out.agentTranscripts.theirsStayed).toBe(true);
    expect(out.agentTranscripts.theirsNotTaken).toBe(true);

    // …and a sidechain transcript whose NAME is already taken at the target blocks
    // the move like any other occupied destination. `rename` would replace that
    // file silently, and rollback can restore the source but not what it erased.
    expect(out.sidechainClobber.error).toContain("already has");
    expect(out.sidechainClobber.error).toContain("agent-dup.jsonl");
    expect(out.sidechainClobber.sourceIntact).toBe(true);
    expect(out.sidechainClobber.decoyIntact).toBe("someone else's sidechain");

    // RESTORE SNAPSHOT: the moved session's saved tab is repointed at the new
    // profile (rebuilt through resumeArgv), every other tab untouched.
    expect(out.restore.tabUpdated).toBe(true);
    expect(out.restore.argv[0]).toBe("env");
    // One `env` block carries every assignment the session needs (the launcher's
    // own self-command rides in it too), so match the one under test by name
    // rather than by position.
    expect(out.restore.argv.some((a: string) => /^CLAUDE_CONFIG_DIR=.*\.claude-work$/.test(a))).toBe(true);
    expect(out.restore.argv).toContain("--resume");
    expect(out.restore.untouched).toEqual(["claude", "--resume", "zzzz9999"]);
    expect(out.restore.noTab).toBe(false);
    // No live tmux in this child (stubbed above), so there was no placeholder to rebuild.
    expect(out.restore.placeholderRefreshed).toBe(false);

    // ── failure paths (permission-provoked, so meaningless as root) ──
    if (out.isRoot) return;

    // ROLLBACK: the last entry can't be written, so the entries already renamed go
    // back and the session is whole in the profile it started in — no half-move.
    expect(out.rollback!.error).toContain("session left in .claude");
    expect(out.rollback!.sourceRestored).toBe(true);
    expect(out.rollback!.targetEmpty).toBe(true);
    // …and the directory scaffolding the attempt created goes with it.
    expect(out.rollback!.dirsCleaned).toBe(true);

    // PARTIAL COPY: a `cp` that dies midway through the sidecar must not leave a
    // half-written tree behind, or every retry would abort on the clobber check.
    expect(out.partialCopy!.error).toContain("across filesystems");
    expect(out.partialCopy!.sourceIntact).toBe(true);
    expect(out.partialCopy!.debrisLeft).toBe(false);

    // PHASE-2 LEFTOVER: the data is all at the destination but a source copy can't
    // be deleted — a SUCCESSFUL move that reports the leftover rather than hiding it.
    expect(out.leftover!.error).toBeNull();
    expect(out.leftover!.warning).toContain("tasks/hhhh8888/");
    expect(out.leftover!.targetHasAll).toBe(true);
    expect(out.leftover!.sourceStillHasTasks).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

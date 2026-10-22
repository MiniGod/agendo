import { realpathSync, statSync } from "fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import { claudeTmpRoot, cachedUsage, listManagedWorktrees, usageOf } from "../../cleanup/disk.ts";
import { probeGit } from "../../cleanup/git.ts";
import { activityPathsOf, buildCleanupRows, sessionRepoRoot, tmpDirOf, transcriptPathsOf, type WorktreeDir } from "../../cleanup/rows.ts";
import type { CleanupRow, GitState, RowSizes } from "../../cleanup/types.ts";
import type { AgentSession } from "../../shared/types.ts";
import { repoRootForCwd } from "../../repositories/index.ts";

const realpaths = new Map<string, string>();

/** The newest mtime of a session's activity files, else its `lastUsed`. */
function lastWrite(s: AgentSession): Date {
  let at = s.lastUsed.getTime();
  for (const p of activityPathsOf(s)) {
    try {
      at = Math.max(at, statSync(p).mtimeMs);
    } catch {
      // gone: nothing newer to learn from it
    }
  }
  return new Date(at);
}

/** A path's realpath, remembered: rows are rebuilt on every model refresh. A missing path is its own spelling. */
export function canonical(path: string): string {
  let real = realpaths.get(path);
  if (real === undefined) {
    try {
      real = realpathSync(path);
    } catch {
      real = path;
    }
    realpaths.set(path, real);
  }
  return real;
}

/** How many rows are probed at once — enough to fill the screen quickly, few enough not to swamp a slow disk. */
const PARALLEL = 3;

/** Run `jobs` with at most `limit` in flight, stopping early once `alive()` turns false. */
export async function runPool(jobs: Array<() => Promise<void>>, limit: number, alive: () => boolean): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (alive() && next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

/** The bytes behind each part of a row. */
export async function measureRow(row: CleanupRow, tmpRoot: string, uid: number): Promise<RowSizes> {
  const s = row.session;
  const tmp = s ? tmpDirOf(s, tmpRoot, uid) : null;
  const [worktree, transcript, tmpBytes] = await Promise.all([
    row.worktree ? cachedUsage(row.worktree) : Promise.resolve(null),
    s ? usageOf(transcriptPathsOf(s)) : Promise.resolve(null),
    tmp ? usageOf([tmp]) : Promise.resolve(null),
  ]);
  return { worktree, transcript, tmp: tmpBytes };
}

/** Drop `keys` from a measurement map; the same map when none of them is in it. */
function without<V>(m: Map<string, V>, keys: readonly string[]): Map<string, V> {
  if (!keys.some((k) => m.has(k))) return m;
  const next = new Map(m);
  for (const k of keys) next.delete(k);
  return next;
}

/**
 * The cleanup view's data: its rows, and — filled in asynchronously, a few rows
 * at a time — each row's git state and on-disk sizes. Bumping `scanKey`
 * re-lists the worktrees and re-probes every row (R, a full re-scan).
 * `remeasure(keys)` is what a cleanup uses instead: it re-lists the worktrees
 * and re-probes only those rows, keeping every other measurement as it was.
 * Sizes come from the disk module's cache, which a deletion has already
 * invalidated for what it removed.
 */
export function useCleanupData({
  model,
  inScope,
  extraRoots,
  scanKey,
}: {
  model: LoadedModel;
  inScope: (cwd: string) => boolean;
  extraRoots: readonly string[];
  scanKey: number;
}) {
  const all = useMemo(() => model.sessionGroups.flatMap((g) => g.sessions), [model.sessionGroups]);
  const sessions = useMemo(() => all.filter((s) => inScope(s.cwd)), [all, inScope]);
  const claimers = useMemo(() => all.filter((s) => !inScope(s.cwd)), [all, inScope]);
  const [worktrees, setWorktrees] = useState<WorktreeDir[]>([]);
  // Bumped by `remeasure`: re-lists the worktrees and re-runs the probe pass for the rows it dropped.
  const [relist, setRelist] = useState(0);
  const rows = useMemo(
    () =>
      buildCleanupRows({
        sessions,
        live: model.liveTmux,
        placeholders: model.livePlaceholders,
        worktrees,
        repoRootOf: repoRootForCwd,
        now: Date.now(),
        canon: canonical,
        lastWrite,
        claimers,
      }),
    [sessions, claimers, model.liveTmux, model.livePlaceholders, worktrees],
  );

  // Every repo a row lives in, plus the path context's own: the ones whose
  // `.claude/worktrees/` may hold a worktree no session points at.
  const rootsSig = useMemo(() => {
    // Realpaths, so a repo reached through a symlink is not scanned twice under two names.
    const roots = new Set([...extraRoots, ...sessions.map((s) => sessionRepoRoot(s.cwd, repoRootForCwd))].map(canonical));
    return [...roots].sort().join("\n");
  }, [sessions, extraRoots]);

  useEffect(() => {
    let alive = true;
    void listManagedWorktrees(rootsSig ? rootsSig.split("\n") : []).then((w) => {
      if (alive) setWorktrees(w);
    });
    return () => {
      alive = false;
    };
  }, [rootsSig, scanKey, relist]);

  const [gits, setGits] = useState<Map<string, GitState | null>>(new Map());
  const [sizes, setSizes] = useState<Map<string, RowSizes>>(new Map());
  // Rows already queued in this scan, so a re-render never probes one twice.
  const queued = useRef<{ scan: number; keys: Set<string> }>({ scan: scanKey, keys: new Set() });

  useEffect(() => {
    if (queued.current.scan !== scanKey) {
      queued.current = { scan: scanKey, keys: new Set() };
      setGits(new Map());
      setSizes(new Map());
    }
    const scan = queued.current;
    const fresh = rows.filter((r) => !scan.keys.has(r.key));
    for (const r of fresh) scan.keys.add(r.key);
    const started = new Set<string>();
    let alive = true;
    const tmpRoot = claudeTmpRoot();
    const uid = process.getuid?.() ?? 0;
    const current = () => queued.current === scan; // false once a newer scan replaced this one
    // Each half lands on its own: a slow `du` must not hold back the git state the dialog waits on.
    const jobs = fresh.map((row) => async () => {
      started.add(row.key);
      await Promise.all([
        probeGit(row.repoRoot, row.path, row.branchHint).then((git) => current() && setGits((m) => new Map(m).set(row.key, git))),
        measureRow(row, tmpRoot, uid).then((size) => current() && setSizes((m) => new Map(m).set(row.key, size))),
      ]);
    });
    void runPool(jobs, PARALLEL, () => alive);
    return () => {
      alive = false;
      // Rows this run never started are queued again by the next one; one in flight still lands.
      for (const r of fresh) if (!started.has(r.key)) scan.keys.delete(r.key);
    };
  }, [rows, scanKey, relist]);

  /** Forget the measurements of `keys` and probe those rows again; every other row keeps its own. */
  const remeasure = useCallback((keys: readonly string[]) => {
    for (const k of keys) queued.current.keys.delete(k);
    setGits((m) => without(m, keys));
    setSizes((m) => without(m, keys));
    setRelist((n) => n + 1);
  }, []);

  return { rows, gits, sizes, remeasure };
}

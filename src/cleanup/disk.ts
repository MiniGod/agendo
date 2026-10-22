// Disk measurements and the managed-worktree listing behind the cleanup view.
//
// Sizes come from `du -sk`, a child process, rather than a walk in this one: a
// worktree with node_modules is hundreds of thousands of entries, and walking
// them here would starve Ink's render loop for seconds. Results are cached per
// path for a few minutes, so reopening the view is instant; a deletion drops the
// entries under the path it removed.
import { spawn } from "child_process";
import { existsSync } from "fs";
import { lstat, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { WorktreeDir } from "./rows.ts";

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { bytes: number | null; at: number }>();

/** Bytes used on disk under `path` (`du -sk`), or null when it does not exist or cannot be measured. */
export function diskUsage(path: string): Promise<number | null> {
  if (!existsSync(path)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn("du", ["-sk", path], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", () => resolve(null));
    // du exits 1 when SOME entry was unreadable but still prints the total of the rest.
    child.on("close", () => {
      const kb = Number(stdout.trim().split(/\s+/)[0]);
      resolve(Number.isFinite(kb) && stdout.trim() ? kb * 1024 : null);
    });
  });
}

/** `diskUsage`, served from the cache while it is fresh. */
export async function cachedUsage(path: string, now = Date.now()): Promise<number | null> {
  const hit = cache.get(path);
  if (hit && now - hit.at < TTL_MS) return hit.bytes;
  const bytes = await diskUsage(path);
  cache.set(path, { bytes, at: now });
  return bytes;
}

/** Total bytes of the paths that exist, or null when none does. */
export async function usageOf(paths: readonly string[]): Promise<number | null> {
  const sizes = await Promise.all(paths.map((p) => cachedUsage(p)));
  const present = sizes.filter((s): s is number => s !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/** Forget every cached size at or under `path`. */
export function invalidateUsage(path: string): void {
  for (const key of cache.keys()) if (key === path || key.startsWith(`${path}/`)) cache.delete(key);
}

/** Forget every cached size: R measures everything afresh. */
export function clearUsage(): void {
  cache.clear();
}

/** Where Claude Code keeps per-session scratch dirs: `$CLAUDE_CODE_TMPDIR`, else the OS temp dir. */
export function claudeTmpRoot(): string {
  return process.env.CLAUDE_CODE_TMPDIR || tmpdir();
}

/** Every directory directly under `<root>/.claude/worktrees/`, for each repo root. Symlinks are skipped. */
export async function listManagedWorktrees(repoRoots: readonly string[]): Promise<WorktreeDir[]> {
  const found = await Promise.all(repoRoots.map((root) => worktreesUnder(root)));
  return found.flat();
}

async function worktreesUnder(repoRoot: string): Promise<WorktreeDir[]> {
  const dir = join(repoRoot, ".claude", "worktrees");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: WorktreeDir[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (st?.isDirectory()) out.push({ path, repoRoot, mtime: st.mtime, birthtime: st.birthtime });
  }
  return out;
}

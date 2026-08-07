// Child driver for the transcript-parse-cache spec (sessions-cache.spec.ts).
//
// Run as a subprocess with HOME pointed at a throwaway dir (os.homedir() is read
// at process start, so the cache scenarios can't share one launcher process —
// they must run in a child whose HOME is the fixture root). It creates Claude
// transcripts under $HOME/.claude/projects, drives SessionIndex.build() through a
// sequence of on-disk changes, and prints a JSON summary of the parse counts /
// visible sessions at each step for the parent spec to assert on.
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  SessionIndex,
  __claudeParseCount,
  __resetClaudeParseCount,
  __claudeCacheSize,
} from "../../src/sessions.ts";

const proj = join(homedir(), ".claude", "projects", "proj");
mkdirSync(proj, { recursive: true });

const f = (id: string) => join(proj, `${id}.jsonl`);
const transcript = (cwd: string, branch: string, title: string) =>
  JSON.stringify({ type: "summary", cwd, gitBranch: branch, timestamp: "2026-07-08T09:00:00Z" }) + "\n" +
  JSON.stringify({ type: "ai-title", aiTitle: title, timestamp: "2026-07-08T09:00:01Z" }) + "\n";
const titleOf = (idx: SessionIndex, id: string) => idx.all.find((s) => s.id === id)?.title;

writeFileSync(f("aaaa1111"), transcript("/repo/a", "feature/a", "Alpha"));
writeFileSync(f("bbbb2222"), transcript("/repo/b", "feature/b", "Bravo"));
writeFileSync(f("cccc3333"), transcript("/repo/c", "feature/c", "Charlie"));

// 1) First build parses every file (cold cache).
__resetClaudeParseCount();
const b1 = await SessionIndex.build();
const build1 = { sessions: b1.all.length, parses: __claudeParseCount(), titleA: titleOf(b1, "aaaa1111") };

// 2) Rebuild with NO changes: everything served from cache, zero re-parses.
__resetClaudeParseCount();
await SessionIndex.build();
const build2 = { parses: __claudeParseCount() };

// 3) Invalidation: append a newer title to A (size — and mtime — change) → only A
//    is re-parsed, and the new content is reflected.
appendFileSync(f("aaaa1111"), JSON.stringify({ type: "ai-title", aiTitle: "Alpha v2", timestamp: "2026-07-08T10:00:00Z" }) + "\n");
__resetClaudeParseCount();
const b3 = await SessionIndex.build();
const build3 = { parses: __claudeParseCount(), titleA: titleOf(b3, "aaaa1111") };

// 4) A brand-new file (absent from the cache) is always parsed and appears.
writeFileSync(f("dddd4444"), transcript("/repo/d", "feature/d", "Delta"));
__resetClaudeParseCount();
const b4 = await SessionIndex.build();
const build4 = { parses: __claudeParseCount(), hasD: !!titleOf(b4, "dddd4444") };

// 5) A deleted file drops out AND its cache entry is pruned (4 files → 3 cached).
rmSync(f("bbbb2222"));
__resetClaudeParseCount();
const b5 = await SessionIndex.build();
const build5 = { parses: __claudeParseCount(), hasB: !!titleOf(b5, "bbbb2222"), cacheSize: __claudeCacheSize() };

process.stdout.write(JSON.stringify({ build1, build2, build3, build4, build5 }));

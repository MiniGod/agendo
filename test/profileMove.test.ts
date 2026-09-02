// Moving a session between profiles, on a scratch pair of profile dirs. The e2e
// suite drives the happy path through the picker; what it never reaches is the
// guard set, the two aliasing no-ops, the clobber refusals, the cross-device
// copy, and every failure that has to roll back or be reported as a leftover.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setForceCrossDevice, moveSessionToProfile, type ClaudeProfile } from "../src/profiles.ts";
import type { AgentSession } from "../src/types.ts";

const ID = "0f0e0d0c-1111-2222-3333-444455556666";
const ENC = "-home-me-proj";

let root: string;
let src: ClaudeProfile;
let dst: ClaudeProfile;
const chmodded: string[] = [];

function profile(name: string): ClaudeProfile {
  const configDir = join(root, name);
  const projects = join(configDir, "projects");
  mkdirSync(projects, { recursive: true });
  return { configDir, projects, name, realProjects: projects };
}

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: ID,
    source: "claude",
    cwd: "/home/me/proj",
    title: "t",
    lastUsed: new Date(),
    configDir: src.configDir,
    logPath: join(src.projects, ENC, `${ID}.jsonl`),
    ...over,
  } as AgentSession;
}

/** The transcript, plus whichever of the other pieces the test wants. */
function seed(pieces: { sidecar?: boolean; env?: boolean; tasks?: boolean; agent?: string } = {}) {
  mkdirSync(join(src.projects, ENC), { recursive: true });
  writeFileSync(join(src.projects, ENC, `${ID}.jsonl`), '{"type":"user"}\n');
  if (pieces.sidecar) {
    mkdirSync(join(src.projects, ENC, ID, "subagents"), { recursive: true });
    writeFileSync(join(src.projects, ENC, ID, "subagents", "a.jsonl"), "x\n");
  }
  if (pieces.env) mkdirSync(join(src.configDir, "session-env", ID), { recursive: true });
  if (pieces.tasks) mkdirSync(join(src.configDir, "tasks", ID), { recursive: true });
  if (pieces.agent !== undefined) writeFileSync(join(src.projects, ENC, "agent-abc.jsonl"), pieces.agent);
}

function readOnly(p: string) {
  chmodSync(p, 0o555);
  chmodded.push(p);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agendo-move-"));
  src = profile(".claude");
  dst = profile(".claude-work");
});

afterEach(() => {
  __setForceCrossDevice(false);
  for (const p of chmodded.splice(0)) chmodSync(p, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("moveSessionToProfile — refusals and no-ops", () => {
  test("guards: source, on-disk paths, and a usable id", async () => {
    expect(await moveSessionToProfile(session({ source: "codex" }), dst)).toEqual({ error: "only Claude sessions live in a profile" });
    expect(await moveSessionToProfile(session({ logPath: undefined }), dst)).toEqual({ error: "this session has no on-disk transcript to move" });
    expect(await moveSessionToProfile(session({ configDir: undefined }), dst)).toEqual({ error: "this session has no on-disk transcript to move" });
    expect(await moveSessionToProfile(session({ id: "../x" }), dst)).toEqual({ error: "unusable session id: ../x" });
    expect(await moveSessionToProfile(session({ id: ".." }), dst)).toEqual({ error: "unusable session id: .." });
  });

  test("the same store under two names is a no-op", async () => {
    seed();
    const alias = join(root, ".claude-alias");
    mkdirSync(alias);
    symlinkSync(src.projects, join(alias, "projects"));
    const target: ClaudeProfile = { configDir: alias, projects: join(alias, "projects"), name: ".claude-alias", realProjects: src.projects };
    expect(await moveSessionToProfile(session(), target)).toEqual({ noop: true, logPath: session().logPath });
  });

  test("a transcript symlinked across two different stores is a no-op too", async () => {
    seed();
    mkdirSync(join(dst.projects, ENC), { recursive: true });
    symlinkSync(join(src.projects, ENC, `${ID}.jsonl`), join(dst.projects, ENC, `${ID}.jsonl`));
    expect((await moveSessionToProfile(session(), dst)).noop).toBe(true);
  });

  test("a transcript that is not where the index says is an error", async () => {
    expect(await moveSessionToProfile(session(), dst)).toEqual({ error: `transcript not found at ${session().logPath}` });
  });

  test("refuses to clobber any of the fixed places, a dangling symlink included, and a sidechain file", async () => {
    seed({ agent: `{"sessionId":"${ID}"}\n` });
    mkdirSync(join(dst.configDir, "tasks", ID), { recursive: true });
    expect(await moveSessionToProfile(session(), dst)).toEqual({ error: `.claude-work already has tasks/${ID}/ — refusing to overwrite it` });
    rmSync(join(dst.configDir, "tasks"), { recursive: true });
    mkdirSync(join(dst.projects, ENC), { recursive: true });
    symlinkSync(join(root, "gone"), join(dst.projects, ENC, ID));
    expect((await moveSessionToProfile(session(), dst)).error).toBe(`.claude-work already has projects/${ENC}/${ID}/ — refusing to overwrite it`);
    rmSync(join(dst.projects, ENC, ID));
    writeFileSync(join(dst.projects, ENC, "agent-abc.jsonl"), "theirs\n");
    expect((await moveSessionToProfile(session(), dst)).error).toBe(`.claude-work already has projects/${ENC}/agent-abc.jsonl — refusing to overwrite it`);
    expect(existsSync(session().logPath!)).toBe(true);
  });
});

describe("moveSessionToProfile — moving", () => {
  test("renames every piece it owns, and only the sidechain files that name it", async () => {
    seed({ sidecar: true, env: true, tasks: true, agent: `{"sessionId":"${ID}"}\n` });
    writeFileSync(join(src.projects, ENC, "agent-other.jsonl"), '{"sessionId":"someone-else"}\n');
    const out = await moveSessionToProfile(session(), dst);
    expect(out).toEqual({
      logPath: join(dst.projects, ENC, `${ID}.jsonl`),
      moved: [`projects/${ENC}/${ID}.jsonl`, `projects/${ENC}/${ID}/`, `session-env/${ID}/`, `tasks/${ID}/`, `projects/${ENC}/agent-abc.jsonl`],
      warning: undefined,
    });
    expect(existsSync(join(dst.projects, ENC, ID, "subagents", "a.jsonl"))).toBe(true);
    expect(existsSync(join(dst.configDir, "session-env", ID))).toBe(true);
    expect(existsSync(join(dst.projects, ENC, "agent-abc.jsonl"))).toBe(true);
    expect(existsSync(join(src.projects, ENC, "agent-other.jsonl"))).toBe(true);
    expect(existsSync(session().logPath!)).toBe(false);
  });

  test("across filesystems it copies, then drops the sources", async () => {
    seed({ sidecar: true });
    symlinkSync("subagents/a.jsonl", join(src.projects, ENC, ID, "link"));
    __setForceCrossDevice(true);
    const out = await moveSessionToProfile(session(), dst);
    expect(out.error).toBeUndefined();
    expect(out.warning).toBeUndefined();
    expect(readFileSync(join(dst.projects, ENC, `${ID}.jsonl`), "utf-8")).toBe('{"type":"user"}\n');
    expect(readFileSync(join(dst.projects, ENC, ID, "link"), "utf-8")).toBe("x\n");
    expect(existsSync(session().logPath!)).toBe(false);
    expect(existsSync(join(src.projects, ENC, ID))).toBe(false);
  });

  test("a source that cannot be deleted after the copy is a warning, not a failure", async () => {
    seed({ sidecar: true });
    __setForceCrossDevice(true);
    readOnly(join(src.projects, ENC));
    const out = await moveSessionToProfile(session(), dst);
    expect(out.logPath).toBe(join(dst.projects, ENC, `${ID}.jsonl`));
    expect(out.warning).toBe(`couldn't delete projects/${ENC}/${ID}.jsonl, projects/${ENC}/${ID}/ from .claude — remove it by hand`);
    expect(existsSync(join(dst.projects, ENC, ID, "subagents", "a.jsonl"))).toBe(true);
  });
});

describe("moveSessionToProfile — rolling back", () => {
  test("a directory that cannot be created leaves the session where it was", async () => {
    seed();
    writeFileSync(join(dst.projects, ENC), "not a dir\n");
    const out = await moveSessionToProfile(session(), dst);
    expect(out.error).toStartWith(`couldn't create ${join(dst.projects, ENC)}:`);
    expect(out.error).toEndWith("— session left in .claude");
    expect(existsSync(session().logPath!)).toBe(true);
  });

  test("a rename that fails for a reason other than EXDEV rolls back what was placed", async () => {
    seed({ env: true });
    mkdirSync(join(dst.configDir, "session-env"));
    readOnly(join(dst.configDir, "session-env"));
    const out = await moveSessionToProfile(session(), dst);
    expect(out.error).toStartWith(`couldn't move session-env/${ID}/:`);
    expect(existsSync(session().logPath!)).toBe(true); // the transcript came back
    expect(existsSync(join(src.configDir, "session-env", ID))).toBe(true);
    expect(existsSync(join(dst.projects, ENC))).toBe(false); // and the scaffolding went away
  });

  test("a copy that fails is removed, rolled back, and reported", async () => {
    seed({ sidecar: true });
    __setForceCrossDevice(true);
    mkdirSync(join(dst.projects, ENC));
    // The transcript copies first (a file into a writable dir); the sidecar then
    // fails because its destination cannot be created under a read-only parent.
    writeFileSync(join(dst.projects, ENC, ".keep"), "");
    readOnly(join(dst.projects, ENC));
    const out = await moveSessionToProfile(session(), dst);
    expect(out.error).toMatch(/^couldn't (create|copy) /);
    expect(out.error).toEndWith("— session left in .claude");
    expect(existsSync(session().logPath!)).toBe(true);
    expect(existsSync(join(src.projects, ENC, ID, "subagents", "a.jsonl"))).toBe(true);
    expect(existsSync(join(dst.projects, ENC, `${ID}.jsonl`))).toBe(false);
  });
});

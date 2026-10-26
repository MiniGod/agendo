// Saving config.json from the Settings page (src/app/configSave.ts). The e2e
// suite saves through the real TUI into a temp HOME, once per shape it can
// reach from a keystroke; the shapes it can't — a malformed file in effect, a
// symlinked config (dangling or looped too), a write that fails half way, a
// file's permissions (kept, or carried over from the legacy file a first save
// migrates) — sit here, each on its own temp directory. Every path is
// explicit: nothing here reads or writes a real ~/.agendo, ~/.clops or
// ~/.claude-launcher.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configReadError, mergeConfig, readConfigObject, saveConfig, writeFileAtomic } from "../src/app/configSave.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "agendo-configsave-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readConfigObject", () => {
  test("no file reads as an empty object; a JSON object reads as itself", () => {
    const d = tmp();
    expect(readConfigObject(join(d, "absent.json"))).toEqual({});
    writeFileSync(join(d, "c.json"), '{"org":"o","hmiTag":"x"}');
    expect(readConfigObject(join(d, "c.json"))).toEqual({ org: "o", hmiTag: "x" });
  });

  test("a file that isn't a JSON object refuses, naming the file and the way out", () => {
    const d = tmp();
    const bad = join(d, "bad.json");
    writeFileSync(bad, "{ org: ");
    expect(() => readConfigObject(bad)).toThrow(`${bad} isn't valid JSON (`);
    expect(() => readConfigObject(bad)).toThrow("fix it by hand; nothing saves until then");
    for (const text of ["[1,2]", "42", "null", '"oops"']) {
      writeFileSync(bad, text);
      expect(() => readConfigObject(bad)).toThrow(`${bad} doesn't hold a JSON object`);
    }
  });

  test("a file that can't be read says so, not that it isn't JSON", () => {
    const d = tmp();
    const dir = join(d, "config.json");
    mkdirSync(dir);
    expect(() => readConfigObject(dir)).toThrow("EISDIR");
    expect(() => readConfigObject(dir)).not.toThrow("isn't valid JSON");
  });
});

describe("configReadError", () => {
  test("null for a file that reads, or none at all; else why not", () => {
    const d = tmp();
    const path = join(d, "config.json");
    expect(configReadError(path)).toBeNull();
    writeFileSync(path, '{"org":"o"}');
    expect(configReadError(path)).toBeNull();
    writeFileSync(path, '{"org":"o",}');
    expect(configReadError(path)).toContain(`${path} isn't valid JSON (`);
  });
});

describe("mergeConfig", () => {
  test("patched keys are set in place, unknown keys survive in order, undefined removes", () => {
    const raw = { org: "o", team: "Team DES", hmiTag: "x", focusTerminal: "kitty {session}" };
    const merged = mergeConfig(raw, { team: "Prisma", focusTerminal: undefined, peerSocket: false });
    expect(merged).toEqual({ org: "o", team: "Prisma", hmiTag: "x", peerSocket: false });
    expect(Object.keys(merged)).toEqual(["org", "team", "hmiTag", "peerSocket"]);
    expect(raw.team).toBe("Team DES");
  });
});

describe("writeFileAtomic", () => {
  test("creates the directory and the file, leaving no temp file behind", () => {
    const d = tmp();
    const path = join(d, "nested", "config.json");
    writeFileAtomic(path, "{}\n");
    expect(readFileSync(path, "utf-8")).toBe("{}\n");
    expect(readdirSync(join(d, "nested"))).toEqual(["config.json"]);
  });

  test("an existing file keeps its permissions exactly, past the umask", () => {
    const d = tmp();
    const path = join(d, "config.json");
    for (const mode of [0o600, 0o664]) {
      writeFileSync(path, "{}");
      chmodSync(path, mode);
      writeFileAtomic(path, '{"a":1}');
      expect(statSync(path).mode & 0o777).toBe(mode);
    }
  });

  test("a symlinked config is written through, and stays a link", () => {
    const d = tmp();
    mkdirSync(join(d, "dotfiles"));
    const real = join(d, "dotfiles", "config.json");
    writeFileSync(real, "{}");
    const link = join(d, "config.json");
    symlinkSync(real, link);
    writeFileAtomic(link, '{"team":"Prisma"}');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).toBe('{"team":"Prisma"}');
  });

  test("a dangling link is written through too, its target created", () => {
    const d = tmp();
    const real = join(d, "dotfiles", "agendo", "config.json");
    const link = join(d, "config.json");
    symlinkSync(real, link);
    writeFileAtomic(link, '{"team":"Prisma"}');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).toBe('{"team":"Prisma"}');
  });

  test("a link loop is given up on: the write replaces the link rather than spinning", () => {
    const d = tmp();
    const a = join(d, "a.json");
    const b = join(d, "b.json");
    symlinkSync(b, a);
    symlinkSync(a, b);
    writeFileAtomic(a, "{}");
    expect(lstatSync(a).isSymbolicLink()).toBe(false);
    expect(readFileSync(a, "utf-8")).toBe("{}");
  });

  test("a failed rename throws and removes the temp file", () => {
    const d = tmp();
    const dir = join(d, "config.json");
    mkdirSync(dir);
    expect(() => writeFileAtomic(dir, "{}")).toThrow();
    expect(readdirSync(d)).toEqual(["config.json"]);
  });
});

describe("saveConfig", () => {
  test("the first save from a legacy file writes all of it, edited, to the new path; the legacy file is untouched", () => {
    const home = tmp();
    const legacy = join(home, ".claude-launcher", "config.json");
    mkdirSync(join(home, ".claude-launcher"));
    const legacyText = '{\n  "org": "contoso",\n  "team": "Team DES",\n  "hmiTag": "keep me"\n}';
    writeFileSync(legacy, legacyText);
    const to = join(home, ".agendo", "config.json");
    expect(saveConfig({ team: "Prisma" }, { from: legacy, to })).toBe(to);
    expect(readFileSync(to, "utf-8")).toBe('{\n  "org": "contoso",\n  "team": "Prisma",\n  "hmiTag": "keep me"\n}\n');
    expect(readFileSync(legacy, "utf-8")).toBe(legacyText);
  });

  test("the new file takes the legacy file's permissions, past the umask", () => {
    for (const mode of [0o600, 0o664]) {
      const home = tmp();
      const legacy = join(home, ".clops", "config.json");
      mkdirSync(join(home, ".clops"));
      writeFileSync(legacy, '{"team":"Team DES"}');
      chmodSync(legacy, mode);
      const to = join(home, ".agendo", "config.json");
      saveConfig({ team: "Prisma" }, { from: legacy, to });
      expect(statSync(to).mode & 0o777).toBe(mode);
    }
  });

  test("with no file anywhere, the save writes just the patch", () => {
    const home = tmp();
    const to = join(home, ".agendo", "config.json");
    saveConfig({ stalledAfterMinutes: 90 }, { from: to, to });
    expect(JSON.parse(readFileSync(to, "utf-8"))).toEqual({ stalledAfterMinutes: 90 });
  });

  test("a malformed file in effect refuses the save and writes nothing", () => {
    const home = tmp();
    const from = join(home, "old.json");
    writeFileSync(from, "not json");
    const to = join(home, ".agendo", "config.json");
    expect(() => saveConfig({ team: "Prisma" }, { from, to })).toThrow("isn't valid JSON");
    expect(existsSync(to)).toBe(false);
  });
});

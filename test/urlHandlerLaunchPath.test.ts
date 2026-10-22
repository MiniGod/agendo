// The PATH `agendo url-handler install` bakes into the Exec line
// (src/cli/urlHandler/launchPath.ts), so a link started from the desktop
// session — whose PATH has no ~/.bun/bin — still finds bun; and the reading of
// that line `status` warns from. Pure: no real install, no xdg-mime, no bun run.
import { describe, expect, test } from "bun:test";
import { desktopEntry, execLine, execWords, readExec } from "../src/cli/urlHandler/desktop.ts";
import {
  DESKTOP_SESSION_PATH, bunBinary, execTarget, launchPath, launchProblem, mentionsBun, withPath,
} from "../src/cli/urlHandler/launchPath.ts";

describe("bunBinary", () => {
  test("the bun running agendo, by its own path", () => {
    expect(bunBinary("/home/me/.bun/bin/bun", () => "/usr/bin/bun")).toBe("/home/me/.bun/bin/bun");
  });

  test("else bun on PATH, else nothing", () => {
    expect(bunBinary("/usr/bin/node", () => "/opt/bun/bin/bun")).toBe("/opt/bun/bin/bun");
    expect(bunBinary("/usr/bin/node", () => null)).toBeNull();
  });
});

describe("launchPath", () => {
  test("bun's dir first, then the installing shell's PATH, then the system dirs", () => {
    expect(launchPath("/home/me/.bun/bin/bun", "/home/me/bin:/usr/bin")).toBe("/home/me/.bun/bin:/home/me/bin:/usr/bin:/usr/local/bin:/bin");
  });

  test("each dir once, so a reinstall from a shell that already has bun's dir writes the same PATH", () => {
    const first = launchPath("/home/me/.bun/bin/bun", "/usr/bin:/bin");
    expect(first).toBe("/home/me/.bun/bin:/usr/bin:/bin:/usr/local/bin");
    expect(launchPath("/home/me/.bun/bin/bun", first)).toBe(first);
    expect(launchPath("/home/me/.bun/bin/bun", "/home/me/.bun/bin/:/usr/bin//:/bin")).toBe(first);
  });

  test("drops relative, empty and package-runner temporary dirs", () => {
    expect(launchPath("/u/bun", ".::bin:/tmp/bunx-1000-agendo/node_modules/.bin:/home/me/.npm/_npx/ab/node_modules/.bin:/opt/x"))
      .toBe("/u:/opt/x:/usr/local/bin:/usr/bin:/bin");
  });

  test("drops every node_modules/.bin, so where install ran (bun x, bun run, which cwd) does not change the line", () => {
    const fromHome = "/home/me/node_modules/.bin:/home/node_modules/.bin:/node_modules/.bin:/home/me/.local/bin:/usr/bin";
    const fromProject = "/node_modules/.bin:/home/me/git/p/node_modules/.bin:/home/me/git/node_modules/.bin:/home/me/.local/bin:/usr/bin";
    expect(launchPath("/u/bun", fromHome)).toBe("/u:/home/me/.local/bin:/usr/bin:/usr/local/bin:/bin");
    expect(launchPath("/u/bun", fromProject)).toBe(launchPath("/u/bun", fromHome));
    expect(launchPath("/u/bun", "/opt/node_modules_extra/bin")).toBe("/u:/opt/node_modules_extra/bin:/usr/local/bin:/usr/bin:/bin");
  });

  test("without bun found, a sane default still", () => {
    expect(launchPath(null, "")).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

describe("the Exec line with a baked PATH", () => {
  test("env by absolute path, PATH as one argument, then the command and the URL", () => {
    const words = withPath(["/home/me/bin/agendo"], launchPath("/home/me/.bun/bin/bun", "/usr/bin"));
    expect(execLine(words)).toBe("/usr/bin/env PATH=/home/me/.bun/bin:/usr/bin:/usr/local/bin:/bin /home/me/bin/agendo url %u");
  });

  test("a PATH with spaces is one double-quoted argument, and reads back whole", () => {
    const words = withPath(["/opt/my apps/agendo"], launchPath("/home/my user/.bun/bin/bun", "/usr/bin"));
    const exec = execLine(words);
    expect(exec).toBe('/usr/bin/env "PATH=/home/my user/.bun/bin:/usr/bin:/usr/local/bin:/bin" "/opt/my apps/agendo" url %u');
    expect(execWords(exec)).toEqual([...words, "url", "%u"]);
  });

  test("Desktop Entry escaping: $, backquote, quote and backslash escaped inside the quotes, then backslashes doubled, % doubled", () => {
    const words = withPath(["/x/agendo"], launchPath('/h/a$b`c"d\\e%f/bun', ""));
    const exec = readExec(desktopEntry(words));
    expect(exec).toBe('/usr/bin/env "PATH=/h/a\\\\$b\\\\`c\\\\"d\\\\\\\\e%%f:/usr/local/bin:/usr/bin:/bin" /x/agendo url %u');
    expect(execWords(exec ?? "")).toEqual([...words, "url", "%u"]);
  });

  test("reinstalling writes byte-for-byte the same entry", () => {
    const entry = () => desktopEntry(withPath(["/u/bunx", "agendo@1.2.3"], launchPath("/u/bun", "/u:/usr/bin")));
    expect(entry()).toBe(entry());
  });
});

describe("execTarget", () => {
  test("past an env prefix, with the PATH it sets", () => {
    expect(execTarget(["/usr/bin/env", "FOO=1", "PATH=/a:/b", "/x/agendo", "url", "%u"])).toEqual({ program: "/x/agendo", path: "/a:/b" });
    expect(execTarget(["env", "PATH=", "agendo"])).toEqual({ program: "agendo", path: "" });
  });

  test("a line without env inherits the desktop session's PATH", () => {
    expect(execTarget(["/x/agendo", "url", "%u"])).toEqual({ program: "/x/agendo", path: null });
    expect(execTarget(["/usr/bin/env", "/x/agendo"])).toEqual({ program: "/x/agendo", path: null });
  });

  test("nothing to run", () => {
    expect(execTarget([])).toBeNull();
    expect(execTarget(["/usr/bin/env", "PATH=/a"])).toBeNull();
  });
});

test("mentionsBun: a bun looked up on PATH, directly or through a package bin's shebang", () => {
  expect(mentionsBun("#!/usr/bin/env bun\n")).toBe(true);
  expect(mentionsBun('#!/bin/bash\nexec bun x github:minigod/agendo#abc "$@"\n')).toBe(true);
  expect(mentionsBun("#!/bin/sh\nexec bunx agendo@1.0.0\n")).toBe(true);
  expect(mentionsBun("#!/bin/sh\nexec /opt/bun/bin/bun /x/index.tsx\n")).toBe(false);
  expect(mentionsBun("#!/home/me/.bun/bin/bun\n")).toBe(false);
  // bun by path running a package: the package's `env bun` shebang still asks PATH, unless --bun.
  expect(mentionsBun('#!/bin/sh\nexec /home/me/.bun/bin/bun x github:minigod/agendo#abc "$@"\n')).toBe(true);
  expect(mentionsBun('#!/bin/sh\nexec /home/me/.bun/bin/bun run agendo "$@"\n')).toBe(true);
  expect(mentionsBun("#!/bin/sh\nexec /home/me/.bun/bin/bunx agendo@1.0.0\n")).toBe(true);
  expect(mentionsBun('#!/bin/sh\nexec /home/me/.bun/bin/bun x --bun agendo "$@"\n')).toBe(false);
  expect(mentionsBun("#!/bin/sh\nexec /home/me/.bun/bin/bunx --bun agendo@1.0.0\n")).toBe(false);
  expect(mentionsBun("#!/bin/sh\necho bundle bunny\n")).toBe(false);
  expect(mentionsBun("")).toBe(false);
});

describe("launchProblem", () => {
  const files: Record<string, string> = {
    "/home/me/bin/agendo": '#!/bin/bash\nexec bun x github:minigod/agendo#abc "$@"\n',
    "/home/me/.bun/bin/bun": "\x7fELF",
    "/usr/bin/tool": "#!/bin/sh\necho hi\n",
    "/usr/bin/abs": '#!/bin/sh\nexec /home/me/.bun/bin/bun /x/index.tsx "$@"\n',
  };
  const exists = (p: string) => p in files;
  const head = (p: string) => files[p] ?? null;

  test("the reported bug: a wrapper calling bun, under the desktop session's PATH", () => {
    expect(launchProblem({ program: "/home/me/bin/agendo", path: null }, DESKTOP_SESSION_PATH, exists, head))
      .toBe(`/home/me/bin/agendo runs bun, which is not on the desktop session's PATH (${DESKTOP_SESSION_PATH})`);
  });

  test("the same wrapper under a baked PATH that has bun", () => {
    expect(launchProblem({ program: "/home/me/bin/agendo", path: "/home/me/.bun/bin:/usr/bin" }, "/home/me/.bun/bin:/usr/bin", exists, head)).toBeNull();
  });

  test("a baked PATH without bun is a problem too", () => {
    expect(launchProblem({ program: "/home/me/bin/agendo", path: "/usr/bin" }, "/usr/bin", exists, head))
      .toBe("/home/me/bin/agendo runs bun, which is not on its PATH (/usr/bin)");
  });

  test("an old entry running bunx by absolute path: its agendo bin's `env bun` shebang still asks PATH", () => {
    expect(launchProblem({ program: "/home/me/.bun/bin/bunx", path: null }, DESKTOP_SESSION_PATH, exists, head))
      .toBe(`/home/me/.bun/bin/bunx runs bun, which is not on the desktop session's PATH (${DESKTOP_SESSION_PATH})`);
    expect(launchProblem({ program: "/home/me/.bun/bin/bunx", path: "/home/me/.bun/bin" }, "/home/me/.bun/bin", exists, head)).toBeNull();
  });

  test("a wrapper that runs a file with bun by absolute path asks PATH for nothing", () => {
    expect(launchProblem({ program: "/usr/bin/abs", path: null }, DESKTOP_SESSION_PATH, exists, head)).toBeNull();
  });

  test("bun itself by absolute path needs no lookup, and a program that never runs bun is fine", () => {
    expect(launchProblem({ program: "/home/me/.bun/bin/bun", path: null }, DESKTOP_SESSION_PATH, exists, head)).toBeNull();
    expect(launchProblem({ program: "/usr/bin/tool", path: null }, DESKTOP_SESSION_PATH, exists, head)).toBeNull();
  });

  test("a bare name is looked up on that PATH", () => {
    expect(launchProblem({ program: "tool", path: null }, DESKTOP_SESSION_PATH, exists, head)).toBeNull();
    expect(launchProblem({ program: "agendo", path: null }, DESKTOP_SESSION_PATH, exists, head))
      .toBe(`agendo is not on the desktop session's PATH (${DESKTOP_SESSION_PATH})`);
  });

  test("an unreadable or missing program says nothing here (status reports a missing one separately)", () => {
    expect(launchProblem({ program: "/gone/agendo", path: null }, DESKTOP_SESSION_PATH, exists, head)).toBeNull();
  });
});

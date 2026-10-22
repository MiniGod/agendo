// The .desktop entry `agendo url-handler install` writes
// (src/cli/urlHandler/desktop.ts). The e2e suite installs one with a plain
// `--exec`; the quoting a path with spaces or a `%` needs, the default command
// choice, the mimeapps.list edit on uninstall, and the desktop-database refresh
// (against a fake update-desktop-database on PATH) are pinned here.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applicationsDir, cacheListsUs, defaultCommand, defaultSpec, desktopEntry, execLine, execProgram, execWords, findOnPath, isOurs, isVolatile, mimeappsPath,
  parseExec, quoteExecArg, readExec, shellQuote, withoutOurDefault,
} from "../src/cli/urlHandler/desktop.ts";
import { refreshCommand, refreshDesktopDatabase } from "../src/cli/urlHandler/desktopDb.ts";

describe("desktopEntry", () => {
  test("registers the scheme, hidden from menus, with the URL as one argument", () => {
    const text = desktopEntry(["/home/me/.bun/bin/bunx", "agendo@0.2.3"]);
    expect(text.split("\n")).toEqual([
      "[Desktop Entry]",
      "Type=Application",
      "Name=agendo",
      "Comment=Focus an agendo session from an agendo:// link",
      "Exec=/home/me/.bun/bin/bunx agendo@0.2.3 url %u",
      "Terminal=false",
      "NoDisplay=true",
      "MimeType=x-scheme-handler/agendo;",
      "",
    ]);
    expect(readExec(text)).toBe("/home/me/.bun/bin/bunx agendo@0.2.3 url %u");
  });

  test("quoting per the Desktop Entry spec", () => {
    expect(quoteExecArg("/usr/bin/agendo")).toBe("/usr/bin/agendo");
    expect(quoteExecArg("/opt/my app/agendo")).toBe('"/opt/my app/agendo"');
    expect(quoteExecArg("100%")).toBe("100%%");
    expect(quoteExecArg('a"b')).toBe('"a\\\\"b"');
    expect(quoteExecArg("$HOME")).toBe('"\\\\$HOME"');
    expect(quoteExecArg("a;b")).toBe('"a;b"');
    expect(execLine(["/opt/my app/agendo"])).toBe('"/opt/my app/agendo" url %u');
  });
});

describe("paths", () => {
  test("XDG_DATA_HOME, else ~/.local/share", () => {
    expect(applicationsDir({ XDG_DATA_HOME: "/x/data" }, "/home/me")).toBe("/x/data/applications");
    expect(applicationsDir({ XDG_DATA_HOME: " " }, "/home/me")).toBe("/home/me/.local/share/applications");
    expect(applicationsDir({}, "/home/me")).toBe("/home/me/.local/share/applications");
  });

  test("XDG_CONFIG_HOME, else ~/.config", () => {
    expect(mimeappsPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/me")).toBe("/x/cfg/mimeapps.list");
    expect(mimeappsPath({}, "/home/me")).toBe("/home/me/.config/mimeapps.list");
  });

  test("findOnPath: first hit", () => {
    const exists = (p: string) => p === "/b/agendo" || p === "/c/agendo";
    expect(findOnPath("agendo", "/a::/b:/c", exists)).toBe("/b/agendo");
    expect(findOnPath("bunx", "/a:/b", exists)).toBeNull();
  });
});

describe("defaultCommand", () => {
  test("a stable global install runs its own bin — a bun script or a wrapper alike finds bun on the baked PATH", () => {
    const global = { path: "/usr/local/bin/agendo", volatile: false };
    expect(defaultCommand(global, "/u/bunx", "agendo@1.2.3")).toEqual(["/usr/local/bin/agendo"]);
  });

  test("a runner's /tmp copy is skipped for bunx with a pinned spec", () => {
    const tmp = { path: "/tmp/bunx-1000-agendo/agendo", volatile: true };
    expect(defaultCommand(tmp, "/u/bunx", "agendo@1.2.3")).toEqual(["/u/bunx", "agendo@1.2.3"]);
  });

  test("neither available", () => expect(defaultCommand(null, null, "agendo@1.2.3")).toBeNull());

  test("defaultSpec pins the npm release, never a git ref", () => {
    expect(defaultSpec("0.2.3")).toBe("agendo@0.2.3");
    expect(defaultSpec("1.0.0-rc.1")).toBe("agendo@1.0.0-rc.1");
    expect(defaultSpec("unknown")).toBe("agendo");
    expect(defaultSpec("1.0.0 ; rm -rf ~")).toBe("agendo");
  });

  test("isVolatile", () => {
    expect(isVolatile("/tmp/bunx-1000-agendo@latest/node_modules/agendo/src/index.tsx")).toBe(true);
    expect(isVolatile("/home/me/.npm/_npx/abc/node_modules/.bin/agendo")).toBe(true);
    expect(isVolatile("/home/me/.bun/install/global/node_modules/agendo/src/index.tsx")).toBe(false);
  });
});

test("parseExec", () => {
  expect(parseExec(" /usr/bin/agendo ")).toEqual(["/usr/bin/agendo"]);
  expect(parseExec("/u/bunx github:minigod/agendo")).toEqual(["/u/bunx", "github:minigod/agendo"]);
  expect(parseExec("")).toBeNull();
  expect(parseExec("agendo url %u")).toBeNull();
});

test("withoutOurDefault removes only our own line", () => {
  const before = [
    "[Default Applications]",
    "text/html=firefox.desktop",
    "x-scheme-handler/agendo=agendo-url-handler.desktop",
    "x-scheme-handler/agendox=agendo-url-handler.desktop",
    "",
  ].join("\n");
  expect(withoutOurDefault(before)).toBe(
    ["[Default Applications]", "text/html=firefox.desktop", "x-scheme-handler/agendox=agendo-url-handler.desktop", ""].join("\n"),
  );
  const theirs = "x-scheme-handler/agendo=my-own.desktop\n";
  expect(withoutOurDefault(theirs)).toBe(theirs);
});

test("isOurs", () => {
  expect(isOurs("agendo-url-handler.desktop\n")).toBe(true);
  expect(isOurs("other.desktop")).toBe(false);
});

describe("execProgram", () => {
  test("reads back the first word of every Exec line execLine writes", () => {
    for (const cmd of [["/u/bun", "/x/index.tsx"], ["/with space/bun"], ['/q"uo`te$/b\\s'], ["/pct%/bun"], ["/pct% space/bun"]]) {
      expect(execProgram(execLine(cmd))).toBe(cmd[0]);
    }
  });

  test("execWords inverts execLine for every word, the field code included", () => {
    const cmd = ["/usr/bin/env", "PATH=/home/my dir/.bun/bin:/usr/bin", "/a;b/x", 'q"$`\\', "50%", "\\s", "tab\there"];
    expect(execWords(execLine(cmd))).toEqual([...cmd, "url", "%u"]);
  });

  test("execWords undoes the desktop-file value escapes", () => {
    // `\s` is a space before the line is split into words, `\\` one backslash, and an unknown escape stays as it is.
    expect(execWords('"/a\\sb" /c\\\\d /e\\qf url %u')).toEqual(["/a b", "/c\\d", "/e\\qf", "url", "%u"]);
  });

  test("empty, unterminated or malformed", () => {
    expect(execProgram("")).toBeNull();
    expect(execProgram('"/never/closed url %u')).toBeNull();
    expect(execWords('/a"b" url')).toBeNull();
    expect(execWords("   ")).toEqual([]);
  });
});

describe("desktop database", () => {
  test("cacheListsUs: our entry among the scheme's handlers, and nowhere else", () => {
    expect(cacheListsUs("[MIME Cache]\nx-scheme-handler/agendo=agendo-url-handler.desktop;\n")).toBe(true);
    expect(cacheListsUs("[MIME Cache]\nx-scheme-handler/agendo=other.desktop;agendo-url-handler.desktop;\n")).toBe(true);
    expect(cacheListsUs("[MIME Cache]\nx-scheme-handler/agendo=other.desktop;\n")).toBe(false);
    expect(cacheListsUs("[MIME Cache]\nx-scheme-handler/agendox=agendo-url-handler.desktop;\n")).toBe(false);
    expect(cacheListsUs("[MIME Cache]\ntext/html=agendo-url-handler.desktop;\n")).toBe(false);
    expect(cacheListsUs("")).toBe(false);
  });

  test("the printed fix command pastes as-is", () => {
    expect(shellQuote("/home/me/.local/share/applications")).toBe("/home/me/.local/share/applications");
    expect(shellQuote("/home/my dir/it's")).toBe("'/home/my dir/it'\\''s'");
    expect(refreshCommand("/a b")).toBe("update-desktop-database '/a b'");
  });

  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tempDir = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  /** A PATH holding only a fake update-desktop-database that logs its argv, prints `stderr`, and exits `code`. */
  function fakePath(code: number, stderr = ""): { path: string; log: string } {
    const bin = tempDir("agendo-udd-");
    const log = join(bin, "calls.txt");
    writeFileSync(join(bin, "update-desktop-database"), `#!/bin/sh\necho "$@" >> "${log}"\nprintf '${stderr}' >&2\nexit ${code}\n`);
    chmodSync(join(bin, "update-desktop-database"), 0o755);
    return { path: bin, log };
  }

  test("runs update-desktop-database on exactly the dir it is given", () => {
    const fake = fakePath(0);
    expect(refreshDesktopDatabase("/x/applications", { PATH: fake.path })).toBeNull();
    expect(readFileSync(fake.log, "utf-8")).toBe("/x/applications\n");
  });

  test("a missing binary is a warning with the manual command, not a throw", () => {
    const empty = tempDir("agendo-udd-none-");
    const warning = refreshDesktopDatabase("/x/my apps", { PATH: empty });
    expect(warning).toContain("update-desktop-database could not run");
    expect(warning).toContain("desktop-file-utils");
    expect(warning).toContain("run `update-desktop-database '/x/my apps'`");
  });

  test("a run that hangs past its timeout is a warning, not a missing package", () => {
    const bin = tempDir("agendo-udd-hang-");
    writeFileSync(join(bin, "update-desktop-database"), "#!/bin/sh\nexec sleep 5\n");
    chmodSync(join(bin, "update-desktop-database"), 0o755);
    const warning = refreshDesktopDatabase("/x/applications", { PATH: `${bin}:/usr/bin:/bin` }, 200);
    expect(warning).toContain("update-desktop-database did not finish");
    expect(warning).not.toContain("desktop-file-utils");
    expect(warning).toContain("run `update-desktop-database /x/applications`");
  });

  test("a failing run is a warning too, carrying the first thing it said", () => {
    const warning = refreshDesktopDatabase("/x/applications", { PATH: fakePath(1, "\\nboom: no such dir\\nmore\\n").path });
    expect(warning).toContain("update-desktop-database failed: boom: no such dir;");
    expect(refreshDesktopDatabase("/x/applications", { PATH: fakePath(1).path })).toContain("update-desktop-database failed;");
    expect(warning).toContain("run `update-desktop-database /x/applications`");
  });
});

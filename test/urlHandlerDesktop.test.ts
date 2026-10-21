// The .desktop entry `agendo url-handler install` writes
// (src/cli/urlHandler/desktop.ts). The e2e suite installs one with a plain
// `--exec`; the quoting a path with spaces or a `%` needs, the default command
// choice, and the mimeapps.list edit on uninstall are pinned here.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPEC, applicationsDir, defaultCommand, desktopEntry, execLine, findOnPath, isOurs, isVolatile, mimeappsPath,
  parseExec, quoteExecArg, readExec, withoutOurDefault,
} from "../src/cli/urlHandler/desktop.ts";

describe("desktopEntry", () => {
  test("registers the scheme, hidden from menus, with the URL as one argument", () => {
    const text = desktopEntry(["/home/me/.bun/bin/bunx", DEFAULT_SPEC]);
    expect(text.split("\n")).toEqual([
      "[Desktop Entry]",
      "Type=Application",
      "Name=agendo",
      "Comment=Focus an agendo session from an agendo:// link",
      "Exec=/home/me/.bun/bin/bunx github:minigod/agendo url %u",
      "Terminal=false",
      "NoDisplay=true",
      "MimeType=x-scheme-handler/agendo;",
      "",
    ]);
    expect(readExec(text)).toBe("/home/me/.bun/bin/bunx github:minigod/agendo url %u");
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
  test("a stable global install is run directly", () => {
    expect(defaultCommand({ path: "/usr/local/bin/agendo", volatile: false }, "/u/bunx")).toEqual(["/usr/local/bin/agendo"]);
  });

  test("a runner's /tmp copy is skipped for bunx with an unpinned spec", () => {
    expect(defaultCommand({ path: "/tmp/bunx-1000-agendo/agendo", volatile: true }, "/u/bunx")).toEqual(["/u/bunx", DEFAULT_SPEC]);
    expect(DEFAULT_SPEC).not.toContain("#");
  });

  test("neither available", () => expect(defaultCommand(null, null)).toBeNull());

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

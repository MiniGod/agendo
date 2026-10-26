// The config.json rows of the Settings page (src/ui/models/configFields.ts):
// how each value reads on its row, and how typed text becomes a value or the
// error shown under the input. The e2e suite types one valid and one invalid
// value; every other arm of every field sits here, beside its neighbours.
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/app/config.ts";
import {
  CONFIG_FIELDS, SETTINGS_ITEMS, fieldDisplay, fieldText, isConfigField, parseField, patchReloads, tildePath, toggledValue,
} from "../src/ui/models/configFields.ts";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, closedStates: [...DEFAULT_CONFIG.closedStates], ...over });

describe("the rows", () => {
  test("the launcher's own rows come first, then every config field once", () => {
    expect(SETTINGS_ITEMS.slice(0, 3)).toEqual(["provider", "identity", "autoResume"]);
    expect(SETTINGS_ITEMS.slice(3)).toEqual([...CONFIG_FIELDS]);
    expect(new Set(SETTINGS_ITEMS).size).toBe(SETTINGS_ITEMS.length);
    expect(CONFIG_FIELDS).not.toContain("resource" as never);
  });

  test("isConfigField: config rows yes; the launcher's rows, nothing, and prototype keys no", () => {
    expect(isConfigField("team")).toBe(true);
    expect(isConfigField("autoResume")).toBe(false);
    expect(isConfigField(undefined)).toBe(false);
    expect(isConfigField("toString" as never)).toBe(false);
  });
});

describe("fieldText", () => {
  test("arrays join with commas, absent reads empty, a hand-edited wrong type still reads", () => {
    expect(fieldText("closedStates", cfg())).toBe("Closed, Done, Removed, Resolved");
    expect(fieldText("focusTerminal", cfg())).toBe("");
    expect(fieldText("team", cfg({ team: null as never }))).toBe("");
    expect(fieldText("stalledAfterMinutes", cfg({ stalledAfterMinutes: 90 }))).toBe("90");
    expect(fieldText("team", cfg({ team: 7 as never }))).toBe("7");
  });
});

describe("fieldDisplay", () => {
  test("a blank required field says so in yellow; a set one reads as-is", () => {
    expect(fieldDisplay("team", cfg())).toEqual({ text: "(not set)", color: "yellow" });
    expect(fieldDisplay("team", cfg({ team: "  " }))).toEqual({ text: "(not set)", color: "yellow" });
    expect(fieldDisplay("team", cfg({ team: "Prisma" }))).toEqual({ text: "Prisma" });
  });

  test("the resume choice, unknown values reading as the default", () => {
    expect(fieldDisplay("resumeDialogChoice", cfg())).toEqual({ text: "summary (recommended)", color: "cyan" });
    expect(fieldDisplay("resumeDialogChoice", cfg({ resumeDialogChoice: "as-is" }))).toEqual({ text: "as-is (full transcript)", color: "cyan" });
    expect(fieldDisplay("resumeDialogChoice", cfg({ resumeDialogChoice: "bogus" as never })).text).toBe("summary (recommended)");
  });

  test("the peer socket is on unless it is false", () => {
    expect(fieldDisplay("peerSocket", cfg())).toEqual({ text: "on", color: "green" });
    expect(fieldDisplay("peerSocket", cfg({ peerSocket: undefined }))).toEqual({ text: "on", color: "green" });
    expect(fieldDisplay("peerSocket", cfg({ peerSocket: false }))).toEqual({ text: "off", color: "gray" });
  });

  test("the focus terminal reads off when unset or blank", () => {
    expect(fieldDisplay("focusTerminal", cfg())).toEqual({ text: "(off)", color: "gray" });
    expect(fieldDisplay("focusTerminal", cfg({ focusTerminal: " " }))).toEqual({ text: "(off)", color: "gray" });
    expect(fieldDisplay("focusTerminal", cfg({ focusTerminal: "kitty tmux attach -t {session}" }))).toEqual({ text: "kitty tmux attach -t {session}" });
  });
});

describe("toggledValue", () => {
  test("each toggle saves the value it isn't now", () => {
    expect(toggledValue("peerSocket", cfg())).toEqual({ peerSocket: false });
    expect(toggledValue("peerSocket", cfg({ peerSocket: false }))).toEqual({ peerSocket: true });
    expect(toggledValue("resumeDialogChoice", cfg())).toEqual({ resumeDialogChoice: "as-is" });
    expect(toggledValue("resumeDialogChoice", cfg({ resumeDialogChoice: "as-is" }))).toEqual({ resumeDialogChoice: "summary" });
  });
});

describe("parseField", () => {
  test("org and tenant: required, trimmed, and one word with no slash", () => {
    expect(parseField("org", "  contoso ")).toEqual({ patch: { org: "contoso" } });
    expect(parseField("org", "   ")).toEqual({ error: "the organization can't be empty" });
    expect(parseField("org", "dev.azure.com/contoso")).toEqual({ error: "the organization has no spaces or slashes" });
    expect(parseField("tenant", "contoso.onmicrosoft.com")).toEqual({ patch: { tenant: "contoso.onmicrosoft.com" } });
    expect(parseField("tenant", "a b")).toEqual({ error: "the tenant has no spaces or slashes" });
  });

  test("project and team: required and trimmed, spaces allowed, slashes not", () => {
    expect(parseField("project", " My Project ")).toEqual({ patch: { project: "My Project" } });
    expect(parseField("project", "")).toEqual({ error: "the project can't be empty" });
    expect(parseField("project", "https://dev.azure.com/acme/Widgets")).toEqual({ error: "the project has no slashes (its name, not a URL)" });
    expect(parseField("team", "Team DES")).toEqual({ patch: { team: "Team DES" } });
    expect(parseField("team", " ")).toEqual({ error: "the team can't be empty" });
    expect(parseField("team", "Widgets\\Prisma")).toEqual({ error: "the team has no slashes (its name, not a URL)" });
  });

  test("closed states: comma-split, trimmed, blanks and duplicates dropped; at least one, no quote", () => {
    expect(parseField("closedStates", " Closed, Done,,Closed , Removed ")).toEqual({ patch: { closedStates: ["Closed", "Done", "Removed"] } });
    expect(parseField("closedStates", " , ")).toEqual({ error: "list at least one state, comma-separated (e.g. Closed, Done, Removed)" });
    expect(parseField("closedStates", "Won't Fix")).toEqual({ error: "a state name can't contain ' (it would break the work-item query)" });
  });

  test("stalled after: a positive number of minutes, fractions allowed", () => {
    expect(parseField("stalledAfterMinutes", " 90 ")).toEqual({ patch: { stalledAfterMinutes: 90 } });
    expect(parseField("stalledAfterMinutes", "1.5")).toEqual({ patch: { stalledAfterMinutes: 1.5 } });
    for (const bad of ["abc", "0", "-5", "", "1e3", "0x10", "4h"]) {
      expect(parseField("stalledAfterMinutes", bad)).toEqual({ error: "enter a positive number of minutes (e.g. 240)" });
    }
  });

  test("focus terminal: trimmed, and empty removes the key", () => {
    expect(parseField("focusTerminal", " kitty tmux attach -t {session} ")).toEqual({ patch: { focusTerminal: "kitty tmux attach -t {session}" } });
    expect(parseField("focusTerminal", "  ")).toEqual({ patch: { focusTerminal: undefined } });
  });
});

describe("patchReloads", () => {
  test("only the fields that re-point the requests reload", () => {
    for (const field of ["org", "project", "team", "tenant", "closedStates"] as const) {
      expect(patchReloads({ [field]: "x" })).toBe(true);
    }
    expect(patchReloads({ stalledAfterMinutes: 5 })).toBe(false);
    expect(patchReloads({ peerSocket: false, focusTerminal: undefined })).toBe(false);
    expect(patchReloads({})).toBe(false);
  });
});

describe("tildePath", () => {
  test("the home directory reads as ~, and only as a whole directory", () => {
    expect(tildePath("/home/u/.agendo/config.json", "/home/u")).toBe("~/.agendo/config.json");
    expect(tildePath("/home/user/x", "/home/u")).toBe("/home/user/x");
    expect(tildePath("/etc/x", "")).toBe("/etc/x");
  });
});

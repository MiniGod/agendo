// The team picker's keys and list updates (src/ui/keys/teamPicker.ts). The e2e
// suite picks a team from the list, wraps up from the top to typing one, and
// has the list request fail; it never wraps down past the last row, has the
// list land after the picker closed, or has the save itself fail. Each arm here
// runs on a context of mocks.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { DEFAULT_CONFIG } from "../src/app/config.ts";
import type { ConfigPatch } from "../src/app/configSave.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { afterSave, openEditor, settingsAt } from "../src/ui/keys/settings.ts";
import { handleTeamPickerKeys, pickTeam, stepTeam, teamRowCount, teamsFailed, teamsLoaded } from "../src/ui/keys/teamPicker.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });
type TeamMode = Extract<Mode, { kind: "teamPicker" }>;
const picker = (cursor: number, teams: string[] | null = ["Prisma", "Zeta"], error?: string): TeamMode => ({
  kind: "teamPicker", cursor, teams, request: 7, ...(error ? { error } : {}),
});
const config = { ...DEFAULT_CONFIG, team: "Team DES" };
const ctxIn = (mode: Mode, saveError: string | null = null) => ({ mode, setMode: mock(), config, saveConfigPatch: mock((_patch: ConfigPatch) => saveError) });
const list: Mode = { kind: "list" };

describe("the list", () => {
  test("one row per team plus the type-a-name row, which is all there is while loading", () => {
    expect(teamRowCount(picker(0))).toBe(3);
    expect(teamRowCount(picker(0, null))).toBe(1);
  });

  test("the cursor wraps both ways; a no-op once the picker is gone", () => {
    expect(stepTeam(1)(picker(2))).toEqual(picker(0));
    expect(stepTeam(-1)(picker(0))).toEqual(picker(2));
    expect(stepTeam(1)(picker(0, null))).toEqual(picker(0, null));
    expect(stepTeam(1)(list)).toBe(list);
  });

  test("loaded: the cursor lands on the current team, matched loosely, else the top", () => {
    expect(teamsLoaded(["Prisma", "Zeta"], " zeta ", 7)(picker(0, null))).toEqual(picker(1));
    expect(teamsLoaded(["Prisma", "Zeta"], "Team DES", 7)(picker(0, null))).toEqual(picker(0));
  });

  test("failed: no teams, the reason, and the cursor on typing a name", () => {
    expect(teamsFailed("couldn't list your teams: 401", 7)(picker(0, null))).toEqual(picker(0, [], "couldn't list your teams: 401"));
  });

  test("an answer is dropped once its picker is gone, or another picker has asked since", () => {
    expect(teamsLoaded(["Prisma"], "Prisma", 7)(list)).toBe(list);
    expect(teamsFailed("x", 7)(list)).toBe(list);
    const newer = picker(0, null);
    expect(teamsLoaded(["Prisma"], "Prisma", 6)(newer)).toBe(newer);
    expect(teamsFailed("x", 6)(newer)).toBe(newer);
  });
});

describe("pickTeam", () => {
  test("a team saves and goes back to the Team row", () => {
    const ctx = ctxIn(picker(1));
    pickTeam(picker(1), ctx);
    expect(ctx.saveConfigPatch.mock.calls).toEqual([[{ team: "Zeta" }]]);
    expect(ctx.setMode.mock.calls[0][0]).toEqual(afterSave("team", null));
  });

  test("a failed save stays in the picker with the reason", () => {
    const ctx = ctxIn(picker(0), "couldn't save: EROFS");
    pickTeam(picker(0), ctx);
    expect(ctx.setMode.mock.calls[0][0]).toEqual(picker(0, ["Prisma", "Zeta"], "couldn't save: EROFS"));
  });

  test("the last row — or the only one, while loading — opens the editor on the current team", () => {
    for (const mode of [picker(2), picker(0, null)]) {
      const ctx = ctxIn(mode);
      pickTeam(mode, ctx);
      expect(ctx.saveConfigPatch).not.toHaveBeenCalled();
      expect(ctx.setMode.mock.calls[0][0]).toEqual(openEditor("team", config));
    }
  });
});

describe("handleTeamPickerKeys", () => {
  test("declines off the picker; on it, owns every key", () => {
    expect(handleTeamPickerKeys("j", NONE, ctxIn(list))).toBe(false);
    const ctx = ctxIn(picker(0));
    expect(handleTeamPickerKeys("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.setMode.mock.calls[0][0]).toEqual(settingsAt("team"));
    expect(handleTeamPickerKeys("j", NONE, ctx)).toBe(true);
    expect((ctx.setMode.mock.calls[1][0] as (m: Mode) => Mode)(picker(0))).toEqual(picker(1));
    expect(handleTeamPickerKeys("", key({ upArrow: true }), ctx)).toBe(true);
    expect((ctx.setMode.mock.calls[2][0] as (m: Mode) => Mode)(picker(0))).toEqual(picker(2));
    expect(handleTeamPickerKeys("", key({ return: true }), ctx)).toBe(true);
    expect(ctx.saveConfigPatch.mock.calls).toEqual([[{ team: "Prisma" }]]);
    expect(handleTeamPickerKeys("q", NONE, ctx)).toBe(true);
    expect(ctx.setMode).toHaveBeenCalledTimes(4);
  });
});

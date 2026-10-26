// Opening the Settings page, saving config.json and listing the user's teams
// from it (src/ui/actions/config.ts), on a fake of the file and the Azure
// DevOps layer. The e2e suite saves through the real ones; a save that throws,
// a team list that fails, a save that needn't reload, and a file another
// agendo changed under the page are reached here.
import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/app/config.ts";
import type { ConfigPatch } from "../src/app/configSave.ts";
import { makeConfigActions, type ConfigIo } from "../src/ui/actions/config.ts";
import type { Mode } from "../src/ui/keys/context.ts";

/** Let the team list's promise handlers run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const loaded: Config = { ...DEFAULT_CONFIG, team: "Prisma" };

function setup({
  save = (_p: ConfigPatch): unknown => "/tmp/x",
  backendMoved = false,
  myTeams = () => Promise.resolve(["Prisma", "Zeta"]),
}: { save?: ConfigIo["save"]; backendMoved?: boolean; myTeams?: ConfigIo["myTeams"] } = {}) {
  const fake = { save: mock(save), load: mock(() => loaded), reloadBackend: mock(() => backendMoved), myTeams: mock(myTeams) };
  const deps = { setConfig: mock(), setMode: mock(), reload: mock() };
  return { fake, deps, actions: makeConfigActions({ ...deps, io: fake }) };
}

describe("saveConfigPatch", () => {
  test("a save that throws reports why and changes nothing else", () => {
    const { deps, fake, actions } = setup({ save: () => { throw new Error("EACCES: permission denied"); } });
    expect(actions.saveConfigPatch({ team: "Prisma" })).toBe("couldn't save: EACCES: permission denied");
    expect(deps.setConfig).not.toHaveBeenCalled();
    expect(fake.reloadBackend).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  test("a save re-reads the file into the page and the backend, and reloads when requests moved", () => {
    const { deps, fake, actions } = setup({ backendMoved: true });
    expect(actions.saveConfigPatch({ team: "Prisma" })).toBeNull();
    expect(fake.save.mock.calls).toEqual([[{ team: "Prisma" }]]);
    expect(deps.setConfig.mock.calls).toEqual([[loaded]]);
    expect(fake.reloadBackend).toHaveBeenCalledTimes(1);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  test("closed states reload even though the backend's endpoints didn't move", () => {
    const { deps, actions } = setup();
    actions.saveConfigPatch({ closedStates: ["Done"] });
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  test("a field nothing loaded depends on saves without a reload", () => {
    const { deps, fake, actions } = setup();
    actions.saveConfigPatch({ stalledAfterMinutes: 30 });
    expect(fake.reloadBackend).toHaveBeenCalledTimes(1);
    expect(deps.reload).not.toHaveBeenCalled();
  });
});

describe("openSettings", () => {
  test("the page opens on a fresh read of the file, the backend following it", () => {
    const { deps, fake, actions } = setup();
    actions.openSettings();
    expect(deps.setConfig.mock.calls).toEqual([[loaded]]);
    expect(fake.reloadBackend).toHaveBeenCalledTimes(1);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.setMode.mock.calls).toEqual([[{ kind: "settings", cursor: 0 }]]);
  });

  test("a file changed elsewhere that moved requests reloads the model", () => {
    const { deps, actions } = setup({ backendMoved: true });
    actions.openSettings();
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });
});

describe("enterTeamPicker", () => {
  /** The picker `enterTeamPicker` opened, and the update its list request made to it. */
  const opened = (deps: { setMode: ReturnType<typeof mock> }) => {
    const loading = deps.setMode.mock.calls[0][0] as Extract<Mode, { kind: "teamPicker" }>;
    return { loading, answered: () => (deps.setMode.mock.calls[1][0] as (m: Mode) => Mode)(loading) };
  };

  test("opens loading, then lists the teams with the cursor on the current one", async () => {
    const { deps, actions } = setup();
    actions.enterTeamPicker("zeta");
    const { loading, answered } = opened(deps);
    expect(loading).toEqual({ kind: "teamPicker", cursor: 0, teams: null, request: loading.request });
    await settled();
    expect(answered()).toEqual({ ...loading, cursor: 1, teams: ["Prisma", "Zeta"] });
  });

  test("a list that fails says why, leaving typing a name", async () => {
    const { deps, actions } = setup({ myTeams: () => Promise.reject(new Error("HTTP 401")) });
    actions.enterTeamPicker("Prisma");
    await settled();
    const { loading, answered } = opened(deps);
    expect(answered()).toEqual({ ...loading, teams: [], error: "couldn't list your teams: HTTP 401" });
  });

  test("each picker asks under its own request, so an earlier one's late answer can't land in it", async () => {
    const { deps, actions } = setup();
    actions.enterTeamPicker("Prisma");
    actions.enterTeamPicker("Prisma");
    const first = deps.setMode.mock.calls[0][0] as Extract<Mode, { kind: "teamPicker" }>;
    const second = deps.setMode.mock.calls[1][0] as Extract<Mode, { kind: "teamPicker" }>;
    expect(second.request).not.toBe(first.request);
    await settled();
    const firstAnswer = deps.setMode.mock.calls[2][0] as (m: Mode) => Mode;
    expect(firstAnswer(second)).toBe(second);
  });
});

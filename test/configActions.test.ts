// Opening the Settings page, saving config.json and listing the user's teams
// from it (src/ui/actions/config.ts), on a fake of the file and the Azure
// DevOps layer. The e2e suite saves through the real ones; a save that throws,
// a team list that fails, a save that needn't reload, a file another agendo
// changed under the page, a file that won't read, the "viewing as" choice
// a move to another org or tenant drops, and a save or open on the GitHub
// backend (which the e2e settings specs never switch to) are reached here.
import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/app/config.ts";
import type { ConfigPatch } from "../src/app/configSave.ts";
import { makeConfigActions, type ConfigIo } from "../src/ui/actions/config.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import type { ProviderName } from "../src/shared/types.ts";

/** Let the team list's promise handlers run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const loaded: Config = { ...DEFAULT_CONFIG, team: "Prisma" };

const STILL = { caches: false, identities: false };
const NEW_TEAM = { caches: true, identities: false };
const NEW_ORG = { caches: true, identities: true };

function setup({
  save = (_p: ConfigPatch): unknown => "/tmp/x",
  moved = STILL,
  readError = null,
  provider = "ado",
  myTeams = () => Promise.resolve(["Prisma", "Zeta"]),
}: {
  save?: ConfigIo["save"];
  moved?: { caches: boolean; identities: boolean };
  readError?: string | null;
  provider?: ProviderName;
  myTeams?: ConfigIo["myTeams"];
} = {}) {
  const fake = {
    save: mock(save),
    load: mock(() => loaded),
    readError: mock(() => readError),
    reloadBackend: mock(() => moved),
    myTeams: mock(myTeams),
  };
  const deps = { setConfig: mock(), setMode: mock(), reload: mock(), setIdentity: mock(), persist: mock() };
  return { fake, deps, actions: makeConfigActions({ ...deps, provider, io: fake }) };
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
    const { deps, fake, actions } = setup({ moved: NEW_TEAM });
    expect(actions.saveConfigPatch({ team: "Prisma" })).toBeNull();
    expect(fake.save.mock.calls).toEqual([[{ team: "Prisma" }]]);
    expect(deps.setConfig.mock.calls).toEqual([[loaded]]);
    expect(fake.reloadBackend).toHaveBeenCalledTimes(1);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.setIdentity).not.toHaveBeenCalled(); // a team's members are still the org's identities
  });

  test("a move to another org or tenant drops the viewing-as choice, on screen and on disk", () => {
    const { deps, actions } = setup({ moved: NEW_ORG });
    actions.saveConfigPatch({ org: "contoso" });
    expect(deps.setIdentity.mock.calls).toEqual([[null]]);
    expect(deps.persist.mock.calls).toEqual([[{ identity: null }]]);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  test("on GitHub the viewing-as choice isn't Azure DevOps', so an org move leaves it", () => {
    const { deps, actions } = setup({ moved: NEW_ORG, provider: "github" });
    actions.saveConfigPatch({ org: "contoso" });
    expect(deps.setIdentity).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  test("on GitHub nothing saved reaches the model, so nothing reloads it — the backend still follows the file", () => {
    for (const patch of [{ team: "Prisma" }, { closedStates: ["Done"] }] as ConfigPatch[]) {
      const { deps, fake, actions } = setup({ moved: NEW_TEAM, provider: "github" });
      expect(actions.saveConfigPatch(patch)).toBeNull();
      expect(fake.reloadBackend).toHaveBeenCalledTimes(1);
      expect(deps.reload).not.toHaveBeenCalled();
    }
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
    const { deps, actions } = setup({ moved: NEW_ORG });
    actions.openSettings();
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.setIdentity.mock.calls).toEqual([[null]]);
  });

  test("on GitHub a file changed elsewhere re-points the Azure DevOps layer without reloading the GitHub model", () => {
    const { deps, fake, actions } = setup({ moved: NEW_ORG, provider: "github" });
    actions.openSettings();
    expect(fake.reloadBackend).toHaveBeenCalledTimes(1);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.setIdentity).not.toHaveBeenCalled();
  });

  test("a file that won't read keeps the last good read, here and in the backend, and says why", () => {
    const { deps, fake, actions } = setup({ readError: "~/.agendo/config.json isn't valid JSON (x)" });
    actions.openSettings();
    expect(deps.setConfig).not.toHaveBeenCalled();
    expect(fake.reloadBackend).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.setMode.mock.calls).toEqual([
      [{ kind: "settings", cursor: 0, note: { text: "kept the last good read: ~/.agendo/config.json isn't valid JSON (x)", error: true } }],
    ]);
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

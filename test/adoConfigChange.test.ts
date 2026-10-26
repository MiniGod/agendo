// The pure half of a config.json change under a running launcher
// (src/providers/azureDevOps/configChange.ts): what a save invalidates, and
// what the Work items view says about the configured team. The e2e suite saves
// a team and an org, trips the not-yours, not-found, missing-project and no-team
// notices, and clears the not-found one while the team list still fails; it
// never changes the tenant or the resource (the fake `az` mints the same token
// either way) or the project.
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/app/config.ts";
import { invalidatedBy, judgeTeam } from "../src/providers/azureDevOps/configChange.ts";

const before: Config = { ...DEFAULT_CONFIG, org: "acme", project: "Widgets", team: "Team A", tenant: "t1" };

describe("invalidatedBy", () => {
  test("a tenant change drops the token, every cache and the identities", () => {
    expect(invalidatedBy(before, { ...before, tenant: "t2" })).toEqual({ token: true, caches: true, identities: true });
  });

  test("an org change drops the caches and the identities but keeps the token", () => {
    expect(invalidatedBy(before, { ...before, org: "contoso" })).toEqual({ token: false, caches: true, identities: true });
  });

  test("a resource change (a hand edit; the page shows it read-only) drops only the token", () => {
    expect(invalidatedBy(before, { ...before, resource: "another-app-id" })).toEqual({ token: true, caches: false, identities: false });
  });

  test("a project or team change drops only the caches", () => {
    for (const change of [{ project: "Gadgets" }, { team: "Team B" }]) {
      expect(invalidatedBy(before, { ...before, ...change })).toEqual({ token: false, caches: true, identities: false });
    }
  });

  test("anything else drops nothing", () => {
    expect(invalidatedBy(before, { ...before, stalledAfterMinutes: 5, closedStates: ["Done"], peerSocket: false })).toEqual({ token: false, caches: false, identities: false });
  });
});

describe("judgeTeam", () => {
  const judge = (team: unknown, mine: string[] | null, missing: string | null = null) => judgeTeam({ team, project: "Widgets", mine, missing });

  test("one of your teams, matched loosely, says nothing", () => {
    expect(judge(" team a ", ["Team A", "Team B"])).toBeNull();
  });

  test("a team that isn't yours names yours", () => {
    expect(judge("Team DES", ["Team A"])).toEqual({ team: "Team DES", project: "Widgets", mine: ["Team A"] });
    expect(judge("Team DES", [])).toEqual({ team: "Team DES", project: "Widgets", mine: [] });
  });

  test("no team set is never one of yours", () => {
    expect(judge("  ", ["Team A"])).toEqual({ team: "", project: "Widgets", mine: ["Team A"] });
  });

  test("your teams unknown: not found, in ADO's words, only when the members request 404'd, else nothing to tell", () => {
    expect(judge("Team Prisma", null, "ADO GET … -> 404")).toEqual({ team: "Team Prisma", project: "Widgets", mine: null, why: "ADO GET … -> 404" });
    expect(judge("Team A", null)).toBeNull();
  });

  test("your teams unlistable because the project 404'd too: the project is what's missing", () => {
    expect(judgeTeam({ team: "Team A", project: "Widgetz", mine: null, missing: "404", projectMissing: true })).toEqual({
      team: "Team A", project: "Widgetz", mine: null, why: "404", projectMissing: true,
    });
  });

  test("your teams known: a 404 changes nothing, the list is the better answer", () => {
    expect(judge("Team A", ["Team A"], "ADO GET … -> 404")).toBeNull();
  });

  test("a hand-edited value of the wrong type reads as text", () => {
    expect(judge(null, ["Team A"])).toEqual({ team: "", project: "Widgets", mine: ["Team A"] });
    expect(judge(7, ["7"])).toBeNull();
    expect(judgeTeam({ team: "X", project: undefined, mine: null, missing: "404" })).toEqual({ team: "X", project: "", mine: null, why: "404" });
  });
});

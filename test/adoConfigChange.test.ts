// The pure half of a config.json change under a running launcher
// (src/providers/azureDevOps/configChange.ts): what a save invalidates, and
// what the Work items view says about the configured team. The e2e suite saves
// a team and trips the not-yours and not-found notices; it never changes the
// tenant (whose token the fake `az` mints the same either way), leaves the team
// blank, or has the team list fail while the team itself exists.
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/app/config.ts";
import { invalidatedBy, judgeTeam } from "../src/providers/azureDevOps/configChange.ts";

const before: Config = { ...DEFAULT_CONFIG, org: "acme", project: "Widgets", team: "Team A", tenant: "t1" };

describe("invalidatedBy", () => {
  test("a tenant change drops the token and every cache", () => {
    expect(invalidatedBy(before, { ...before, tenant: "t2" })).toEqual({ token: true, caches: true });
  });

  test("org, project or team drop the caches but keep the token", () => {
    for (const change of [{ org: "contoso" }, { project: "Gadgets" }, { team: "Team B" }]) {
      expect(invalidatedBy(before, { ...before, ...change })).toEqual({ token: false, caches: true });
    }
  });

  test("anything else drops nothing", () => {
    expect(invalidatedBy(before, { ...before, stalledAfterMinutes: 5, closedStates: ["Done"], peerSocket: false })).toEqual({ token: false, caches: false });
  });
});

describe("judgeTeam", () => {
  const judge = (team: unknown, mine: string[] | null, missing = false) => judgeTeam({ team, project: "Widgets", mine, missing });

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

  test("your teams unknown: not found only when the members request 404'd, else nothing to tell", () => {
    expect(judge("Team Prisma", null, true)).toEqual({ team: "Team Prisma", project: "Widgets", mine: null });
    expect(judge("Team A", null, false)).toBeNull();
  });

  test("a hand-edited value of the wrong type reads as text", () => {
    expect(judge(null, ["Team A"])).toEqual({ team: "", project: "Widgets", mine: ["Team A"] });
    expect(judge(7, ["7"])).toBeNull();
    expect(judgeTeam({ team: "X", project: undefined, mine: null, missing: true })).toEqual({ team: "X", project: "", mine: null });
  });
});

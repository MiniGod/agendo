// The pure half of the ADO CI status (src/ado/build.ts). The e2e ADO fixture
// answers the policy-evaluations endpoint with fresh builds only: it never
// expires one, never rejects one, and never has to recover a purged build's
// result, so the whole of the expired path was unreachable from a spec.
import { describe, expect, test } from "bun:test";
import { aggregateBuild, buildResult, worstExpired } from "../src/ado/build.ts";
import { fetchBuildResult } from "../src/ado/policy.ts";

const build = (status: string, context?: { isExpired?: boolean; buildId?: number }) => ({
  status,
  context,
  configuration: { type: { displayName: "Build" } },
});
const reviewers = { status: "approved", configuration: { type: { displayName: "Minimum number of reviewers" } } };

describe("aggregateBuild", () => {
  test("no build policy, or only inapplicable ones, is none", () => {
    expect(aggregateBuild(undefined as unknown as any[])).toEqual({ status: "none", expiredBuildIds: [] });
    expect(aggregateBuild([reviewers, build("notApplicable"), { ...build("queued"), status: "" }])).toEqual({ status: "none", expiredBuildIds: [] });
  });

  test("worst first: rejected, then running, then genuinely queued, then expired, then approved", () => {
    const expired = build("queued", { isExpired: true, buildId: 7 });
    expect(aggregateBuild([build("approved"), build("running"), build("rejected")]).status).toBe("fail");
    expect(aggregateBuild([build("approved"), build("queued"), build("running")]).status).toBe("running");
    expect(aggregateBuild([expired, build("queued")]).status).toBe("queued");
    expect(aggregateBuild([build("approved"), expired])).toEqual({ status: "expired", expiredBuildIds: [7] });
    expect(aggregateBuild([build("approved"), reviewers])).toEqual({ status: "pass", expiredBuildIds: [] });
    expect(aggregateBuild([build("waiting")])).toEqual({ status: "none", expiredBuildIds: [] });
  });

  test("an expired context without a usable build id counts as freshly queued", () => {
    expect(aggregateBuild([build("queued", { isExpired: true, buildId: 0 })])).toEqual({ status: "queued", expiredBuildIds: [] });
    expect(aggregateBuild([build("queued", { isExpired: true })])).toEqual({ status: "queued", expiredBuildIds: [] });
    expect(aggregateBuild([build("queued", { isExpired: false, buildId: 3 })])).toEqual({ status: "queued", expiredBuildIds: [] });
  });
});

describe("buildResult", () => {
  test("only a completed build has a verdict, and only succeeded or failed is one", () => {
    expect(buildResult({ status: "completed", result: "succeeded" })).toBe("pass");
    expect(buildResult({ status: "completed", result: "failed" })).toBe("fail");
    expect(buildResult({ status: "completed", result: "canceled" })).toBeUndefined();
    expect(buildResult({ status: "completed", result: "partiallySucceeded" })).toBeUndefined();
    expect(buildResult({ status: "inProgress", result: "succeeded" })).toBeUndefined();
    expect(buildResult({})).toBeUndefined();
  });
});

describe("worstExpired", () => {
  test("a failed expired build outranks a passed one; nothing clear is nothing", () => {
    expect(worstExpired(["pass", "fail", undefined])).toBe("fail");
    expect(worstExpired([undefined, "pass"])).toBe("pass");
    expect(worstExpired([undefined, undefined])).toBeUndefined();
    expect(worstExpired([])).toBeUndefined();
  });
});

describe("fetchBuildResult", () => {
  test("asks for the build once, then answers from the cache; a purged build is nothing, and stays nothing", async () => {
    const asked: string[] = [];
    const get = async (path: string) => {
      asked.push(path);
      if (path.includes("/builds/404?")) throw new Error("404");
      return { status: "completed", result: path.includes("/builds/1?") ? "succeeded" : "failed" };
    };
    expect(await fetchBuildResult(1, get)).toBe("pass");
    expect(await fetchBuildResult(2, get)).toBe("fail");
    expect(await fetchBuildResult(404, get)).toBeUndefined();
    expect(await fetchBuildResult(1, get)).toBe("pass");
    expect(await fetchBuildResult(404, get)).toBeUndefined();
    expect(asked.map((p) => p.replace(/^.*\/builds\//, "").replace(/\?.*$/, ""))).toEqual(["1", "2", "404"]);
  });
});

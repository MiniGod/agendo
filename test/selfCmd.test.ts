// How agendo names itself (src/selfCmd.ts). `SELF_CMD` is decided once, at
// module load, from the real environment, so any one process — the e2e
// suite's included — runs exactly one arm of the derivation. Here the inputs
// are explicit, so every arm sits beside the one next to it: a bunx cache with
// its spec, an npx cache with none, an inherited spec that must not be
// adopted, a global install on PATH, and the plain argv fallback.
import { describe, expect, test } from "bun:test";
import { deriveSelfCmd, runnerCacheArgv, runnerName, runnerSpec, type SelfCmdInputs } from "../src/selfCmd.ts";

const inputs = (over: Partial<SelfCmdInputs>): SelfCmdInputs => ({
  argv0: "/usr/bin/bun",
  argv1: "/repo/src/index.tsx",
  userAgent: undefined,
  lifecycleScript: undefined,
  onPath: () => false,
  ...over,
});

describe("runnerSpec", () => {
  test("bunx leaves the spec as typed; npm's quoted command form and a spec naming another package are refused", () => {
    expect(runnerSpec("github:owner/agendo#pull/8/head")).toBe("github:owner/agendo#pull/8/head");
    expect(runnerSpec(" agendo@0.1.0 ")).toBe("agendo@0.1.0");
    expect(runnerSpec('"agendo" list')).toBeNull();
    expect(runnerSpec("other-tool@1")).toBeNull();
    expect(runnerSpec("")).toBeNull();
    expect(runnerSpec(undefined)).toBeNull();
  });
});

describe("runnerCacheArgv", () => {
  test("only argv[1] inside bunx's staging dir or npm's _npx cache says a runner started us", () => {
    expect(runnerCacheArgv("/tmp/bunx-1000-agendo@0.1.0/node_modules/agendo/src/index.tsx")).toBe("/tmp/bunx-1000-agendo@0.1.0/node_modules/agendo/src/index.tsx");
    expect(runnerCacheArgv("/home/u/.npm/_npx/abc123/node_modules/.bin/agendo")).toBe("/home/u/.npm/_npx/abc123/node_modules/.bin/agendo");
    expect(runnerCacheArgv("/repo/src/index.tsx")).toBeNull();
    expect(runnerCacheArgv(undefined)).toBeNull();
  });
});

describe("runnerName", () => {
  test("bun before npm, since bun's user-agent carries a bare npm/? too", () => {
    expect(runnerName("bun/1.3.0 npm/? node/v24.0.0 linux x64")).toBe("bunx");
    expect(runnerName("npm/11.0.0 node/v24.0.0 linux x64 workspaces/false")).toBe("npx");
    expect(runnerName("pnpm/9.0.0 npm/? node/v24.0.0")).toBeNull();
    expect(runnerName(undefined)).toBeNull();
  });
});

describe("deriveSelfCmd", () => {
  const bunxCache = "/tmp/bunx-1000-agendo@0.1.0/node_modules/agendo/src/index.tsx";

  test("from a runner's cache: the runner and its spec when both are known, else the cached copy itself", () => {
    expect(deriveSelfCmd(inputs({ argv1: bunxCache, userAgent: "bun/1.3.0 npm/?", lifecycleScript: "github:owner/agendo#HEAD" }))).toBe("bunx github:owner/agendo#HEAD");
    expect(deriveSelfCmd(inputs({ argv1: "/c/_npx/h/node_modules/.bin/agendo", userAgent: "npm/11.0.0 node/v24", lifecycleScript: '"agendo"' }))).toBe("/usr/bin/bun /c/_npx/h/node_modules/.bin/agendo");
    expect(deriveSelfCmd(inputs({ argv1: bunxCache, userAgent: undefined, lifecycleScript: "agendo@0.1.0" }))).toBe(`/usr/bin/bun ${bunxCache}`);
  });

  test("outside a cache an inherited spec is ignored: the bare name when installed, else the literal argv", () => {
    expect(deriveSelfCmd(inputs({ userAgent: "bun/1.3.0 npm/?", lifecycleScript: "agendo@0.1.0", onPath: (cmd) => cmd === "agendo" }))).toBe("agendo");
    expect(deriveSelfCmd(inputs({}))).toBe("/usr/bin/bun /repo/src/index.tsx");
    expect(deriveSelfCmd(inputs({ argv1: undefined }))).toBe("agendo");
  });
});

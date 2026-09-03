// `agendo open` (src/cli/open.ts): which link to open, and the refusals. The
// e2e suite opens a fixture session's PR through the real command; what it
// never asks for is the entity the session does not have, a session with an
// item and no PR, or a backend that could not be asked. Those are here, with
// `process.exit` stubbed to throw so a refusal is an assertion.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chooseTarget, linksToOpen, refuseMissing } from "../src/cli/open.ts";
import { linkVocab } from "../src/output.ts";

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const realExit = process.exit;
const realError = console.error;
let errors: string[];

beforeEach(() => {
  errors = [];
  process.exit = ((code?: number) => {
    throw new Exit(code);
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
});

afterEach(() => {
  process.exit = realExit;
  console.error = realError;
});

const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof Exit && e.code === 1) return errors[errors.length - 1];
    throw e;
  }
  throw new Error("did not refuse");
};

const pr = { id: 7, url: "https://x/pull/7" };
const workItem = { id: 1, url: "https://x/items/1" };
const ado = linkVocab("ado");
const gh = linkVocab("github");

describe("linksToOpen", () => {
  test("both links with URLs come through; one without a URL reads as absent", () => {
    expect(linksToOpen("ab", { provider: "ado", link: { pr, workItem } }, ado)).toEqual({ pr, workItem });
    expect(linksToOpen("ab", { provider: "ado", link: { pr: { id: 7, url: "" }, workItem } }, ado)).toEqual({ pr: undefined, workItem });
  });

  test("a backend that could not be asked, or that knows of nothing open, is a refusal that says so", () => {
    expect(refused(() => linksToOpen("ab", { provider: "ado", error: "boom" }, ado))).toBe("open: could not resolve associations from the backend: boom");
    expect(refused(() => linksToOpen("ab", { provider: "github", link: {} }, gh))).toMatch(
      /^Session ab has no linked pull request or issue to open\.\n {2}\(links resolve against the backend's OPEN PRs \/ issues/,
    );
    expect(refused(() => linksToOpen("ab", { provider: "ado" }, ado))).toMatch(/^Session ab has no linked pull request or work item to open\./);
  });
});

describe("refuseMissing", () => {
  test("asking for the one the session lacks names the one it has; asking for nothing, or what is there, passes", () => {
    expect(refused(() => refuseMissing("ab", "pr", { workItem }, ado))).toBe("Session ab has no linked pull request (only work item #1).");
    expect(refused(() => refuseMissing("ab", "item", { pr }, gh))).toBe("Session ab has no linked issue (only PR #7).");
    expect(refused(() => refuseMissing("ab", "item", { pr }, ado))).toBe("Session ab has no linked work item (only PR !7).");
    expect(() => refuseMissing("ab", undefined, { workItem }, ado)).not.toThrow();
    expect(() => refuseMissing("ab", "pr", { pr }, ado)).not.toThrow();
  });
});

describe("chooseTarget", () => {
  test("the entity asked for, else the PR, else the item", () => {
    expect(chooseTarget("item", { pr, workItem })).toBe(workItem);
    expect(chooseTarget("pr", { pr, workItem })).toBe(pr);
    expect(chooseTarget(undefined, { pr, workItem })).toBe(pr);
    expect(chooseTarget(undefined, { workItem })).toBe(workItem);
  });
});

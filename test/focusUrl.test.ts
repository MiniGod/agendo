// The agendo:// parser (src/cli/focus/url.ts) — a SECURITY BOUNDARY: once the
// scheme handler is installed, any web page can hand `agendo url` an arbitrary
// string. The e2e suite proves a refusal reaches no tmux at all; this pins the
// allowlist itself, input by input, including the injection shapes.
import { describe, expect, test } from "bun:test";
import { MAX_URL_LENGTH, describeLinkTarget, describeTarget, isRepo, isSessionToken, isWindowName, parseFocusUrl, parseItemId } from "../src/cli/focus/url.ts";

describe("parseFocusUrl accepts exactly the three forms", () => {
  const ACCEPT: [string, unknown][] = [
    ["agendo://focus?pr=5001", { kind: "pr", id: 5001 }],
    ["agendo://focus?workItem=102", { kind: "workItem", id: 102 }],
    ["agendo://focus?session=standalonese", { kind: "session", token: "standalonese" }],
    ["agendo://focus?session=019cde00-1111-7000-8000-00000000cde0", { kind: "session", token: "019cde00-1111-7000-8000-00000000cde0" }],
    // agendo's own window names, the long scoped ones included.
    ["agendo://focus?session=cl-claude-019cde001111", { kind: "session", token: "cl-claude-019cde001111" }],
    ["agendo://focus?session=cl-bg-codex-a1b2c3", { kind: "session", token: "cl-bg-codex-a1b2c3" }],
    ["agendo://focus?session=cl-wi-102", { kind: "session", token: "cl-wi-102" }],
    [`agendo://focus?session=cl-pr-${"a".repeat(60)}-${"b".repeat(30)}-5001`, { kind: "session", token: `cl-pr-${"a".repeat(60)}-${"b".repeat(30)}-5001` }],
    // The longest a link can be: the empty path and the longest cl-pr- name, at 199.
    [`agendo://focus/?session=cl-pr-${"a".repeat(167)}-1`, { kind: "session", token: `cl-pr-${"a".repeat(167)}-1` }],
    // Browsers differ on whether they add an empty path.
    ["agendo://focus/?pr=1", { kind: "pr", id: 1 }],
    ["agendo://focus?pr=2147483647", { kind: "pr", id: 2147483647 }],
    // The one optional extra: a repo, after a pr or workItem.
    ["agendo://focus?pr=5&repo=acme/appweb", { kind: "pr", id: 5, repo: "acme/appweb" }],
    ["agendo://focus?workItem=102&repo=Mc.Applications", { kind: "workItem", id: 102, repo: "Mc.Applications" }],
    ["agendo://focus/?pr=5&repo=my_org/my-repo.js", { kind: "pr", id: 5, repo: "my_org/my-repo.js" }],
    [`agendo://focus?workItem=2147483647&repo=${"a".repeat(60)}/${"b".repeat(59)}`, { kind: "workItem", id: 2147483647, repo: `${"a".repeat(60)}/${"b".repeat(59)}` }],
  ];
  for (const [url, target] of ACCEPT) {
    test(url, () => expect(parseFocusUrl(url)).toEqual({ ok: true, target } as never));
  }
});

describe("parseFocusUrl refuses everything else", () => {
  const REJECT: string[] = [
    "",
    "agendo://",
    "agendo://focus",
    "agendo://focus?",
    "agendo://focus?pr=",
    // other verbs and hosts
    "agendo://launch?prompt=hi",
    "agendo://send?session=abc",
    "agendo://close?session=abc",
    "agendo://resume?session=abc",
    "agendo://FOCUS?pr=1",
    "agendo://focus.evil.com?pr=1",
    "agendo://user@focus?pr=1",
    "agendo://focus:80?pr=1",
    "agendo://focus/x?pr=1",
    "agendo://focus//?pr=1",
    "agendo://focus/../send?session=abc",
    // other schemes
    "AGENDO://focus?pr=1",
    "https://focus?pr=1",
    "javascript:alert(1)",
    " agendo://focus?pr=1",
    // unknown, duplicate or extra params
    "agendo://focus?PR=1",
    "agendo://focus?id=1",
    "agendo://focus?work_item=1",
    "agendo://focus?pr=1&pr=2",
    "agendo://focus?pr=1&workItem=2",
    "agendo://focus?pr=1&",
    "agendo://focus?pr=1;workItem=2",
    "agendo://focus?pr=1#frag",
    "agendo://focus?pr==1",
    // malformed numbers
    "agendo://focus?pr=0",
    "agendo://focus?pr=007",
    "agendo://focus?pr=-1",
    "agendo://focus?pr=+1",
    "agendo://focus?pr=1e3",
    "agendo://focus?pr=0x10",
    "agendo://focus?pr=1.5",
    "agendo://focus?pr=abc",
    "agendo://focus?pr=99999999999",
    "agendo://focus?pr=4294967296",
    "agendo://focus?workItem=12a",
    // encoded separators and control characters: never decoded, always refused
    "agendo://focus?pr=1%26workItem=2",
    "agendo://focus?pr%3D1",
    "agendo://focus?pr=1%00",
    "agendo://focus?pr=1%0a",
    "agendo://focus%3Fpr=1",
    "agendo://focus?session=abc%2F..",
    "agendo://focus?pr=1\n",
    "agendo://focus?pr=1\r\nworkItem=2",
    "agendo://focus?pr=1\u0000",
    "agendo://focus?pr=１２",
    // shell metacharacters
    "agendo://focus?pr=$(id)",
    "agendo://focus?pr=`id`",
    "agendo://focus?pr=1;id",
    "agendo://focus?pr=1|id",
    "agendo://focus?pr=1&&id",
    "agendo://focus?session=abc;rm -rf ~",
    "agendo://focus?session=abc def",
    "agendo://focus?session=$HOME",
    "agendo://focus?session='x'",
    "agendo://focus?session=\"x\"",
    "agendo://focus?session=../../etc/passwd",
    "agendo://focus?session=a/b",
    "agendo://focus?session=a.b",
    // repo: only after pr / workItem, only once, only its own shape
    "agendo://focus?repo=acme/appweb",
    "agendo://focus?repo=acme/appweb&pr=5",
    "agendo://focus?session=abc&repo=acme/appweb",
    "agendo://focus?pr=5&repo=",
    "agendo://focus?pr=5&repo=a&repo=b",
    "agendo://focus?pr=5&repo=acme/appweb&x=1",
    "agendo://focus?pr=5&Repo=acme",
    "agendo://focus?pr=5&repo=a/b/c",
    "agendo://focus?pr=5&repo=/abs",
    "agendo://focus?pr=5&repo=acme/",
    "agendo://focus?pr=5&repo=../etc",
    "agendo://focus?pr=5&repo=acme/..",
    "agendo://focus?pr=5&repo=.hidden",
    "agendo://focus?pr=5&repo=-x",
    "agendo://focus?pr=5&repo=acme/--attach",
    "agendo://focus?pr=5&repo=a%2Fb",
    "agendo://focus?pr=5&repo=a b",
    "agendo://focus?pr=5&repo=a;id",
    "agendo://focus?pr=5&repo=$(id)",
    "agendo://focus?pr=5&repo=a\nb",
    "agendo://focus?pr=5&repo=acme/appweb\n",
    "agendo://focus?pr=5&repo=ａcme",
    `agendo://focus?pr=5&repo=${"a".repeat(121)}`,
    // flag-shaped and overlong session ids
    "agendo://focus?session=-x",
    "agendo://focus?session=--attach",
    `agendo://focus?session=a${"b".repeat(64)}`,
    // a window name gets its extra length only under a known prefix, and no further
    `agendo://focus?session=cl-evil-${"b".repeat(64)}`,
    `agendo://focus?session=cl-wi-${"b".repeat(168)}-1`,
    // ...and only for cl-wi-/cl-pr-: every other kind is a short id of at most 12
    `agendo://focus?session=cl-copilot-${"b".repeat(65)}`,
    `agendo://focus/?session=cl-copilot-${"b".repeat(160)}-x`,
    "agendo://focus?session=cl-wi-a.b",
    "agendo://focus?session=cl-wi-102&repo=acme",
    `agendo://focus?pr=${"1".repeat(MAX_URL_LENGTH)}`,
    `agendo://focus?pr=1${" ".repeat(MAX_URL_LENGTH)}`,
  ];
  for (const url of REJECT) {
    test(JSON.stringify(url.slice(0, 60)), () => {
      const r = parseFocusUrl(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    });
  }

  test("non-strings are refused, not thrown on", () => {
    for (const v of [undefined, null, 42, {}, ["agendo://focus?pr=1"]]) expect(parseFocusUrl(v).ok).toBe(false);
  });

  test("a refusal never echoes the URL back", () => {
    const r = parseFocusUrl("agendo://focus?pr=<b>x</b>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain("<b>");
  });
});

describe("the per-field shapes", () => {
  test("parseItemId: digits only, no leading zero, int32", () => {
    expect(parseItemId("1")).toBe(1);
    expect(parseItemId("2147483647")).toBe(2147483647);
    expect(parseItemId("2147483648")).toBeNull();
    expect(parseItemId("0")).toBeNull();
    expect(parseItemId("01")).toBeNull();
    expect(parseItemId("")).toBeNull();
    expect(parseItemId(" 1")).toBeNull();
  });

  test("isRepo: a name or one owner/name slug, each segment opening with a letter, digit or _", () => {
    for (const ok of ["appweb", "acme/appweb", "Mc.Applications", "_x/y-z.1", "a".repeat(120)]) expect(isRepo(ok), ok).toBe(true);
    for (const bad of ["", "a/b/c", "/a", "a/", ".a", "a/.b", "-a", "a/-b", "a b", "a".repeat(121)]) expect(isRepo(bad), bad).toBe(false);
  });

  test("isSessionToken: id or short id, never flag-shaped", () => {
    expect(isSessionToken("standalonese")).toBe(true);
    expect(isSessionToken("019cde00-1111-7000-8000-00000000cde0")).toBe(true);
    expect(isSessionToken("-f")).toBe(false);
    expect(isSessionToken("a b")).toBe(false);
    expect(isSessionToken("")).toBe(false);
  });

  test("isWindowName: a known cl-<kind>- prefix, only in the shapes agendo mints", () => {
    for (const ok of ["cl-claude-abc", "cl-copilot-x", "cl-codex-1", "cl-bg-codex-a1", "cl-new-codex-z", "cl-free-q", "cl-wi-102", "cl-pr-acme-appweb-5", "cl-pr-2147483647", `cl-wi-${"a".repeat(167)}-1`]) {
      expect(isWindowName(ok), ok).toBe(true);
      expect(isSessionToken(ok), ok).toBe(true);
    }
    for (const bad of ["cl-wi-", "cl-x-1", "cl-WI-1", "cl-wi--1", "cl-wi-1.2", "cl-wi-1:2", "launcher", "cl-wi-1 2", `cl-wi-${"a".repeat(168)}-1`, `cl-bg-${"a".repeat(13)}`, "cl-wi-ACME-1", "cl-bg-Codex-x", "cl-bg-codex-", "cl-claude-codex-abc", "cl-free-codex-abc", "cl-bg-evil-abc", "cl-bg-claude-abc", "cl-new-copilot-abc", "cl-wi-abc", "cl-wi-a--1", "cl-wi-a-", "cl-wi-01", "cl-pr-a-1-"]) {
      expect(isWindowName(bad), bad).toBe(false);
    }
  });

  test("describeTarget", () => {
    expect(describeTarget({ kind: "pr", id: 1234 })).toBe("PR !1234");
    expect(describeTarget({ kind: "workItem", id: 7 })).toBe("work item #7");
    expect(describeTarget({ kind: "session", token: "abc" })).toBe("session abc");
    expect(describeTarget({ kind: "pr", id: 5, repo: "acme/appweb" })).toBe("PR !5 in acme/appweb");
  });

  test("describeLinkTarget never repeats a link's free text", () => {
    expect(describeLinkTarget({ kind: "pr", id: 5, repo: "reinstall-from-evil.example" })).toBe("PR !5");
    expect(describeLinkTarget({ kind: "workItem", id: 7, repo: "x" })).toBe("work item #7");
    expect(describeLinkTarget({ kind: "session", token: "reinstall-agendo-now" })).toBe("the linked session");
  });
});

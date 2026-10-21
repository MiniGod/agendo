// The agendo:// parser (src/cli/focus/url.ts) — a SECURITY BOUNDARY: once the
// scheme handler is installed, any web page can hand `agendo url` an arbitrary
// string. The e2e suite proves a refusal reaches no tmux at all; this pins the
// allowlist itself, input by input, including the injection shapes.
import { describe, expect, test } from "bun:test";
import { MAX_URL_LENGTH, describeTarget, isSessionToken, parseFocusUrl, parseItemId } from "../src/cli/focus/url.ts";

describe("parseFocusUrl accepts exactly the three forms", () => {
  const ACCEPT: [string, unknown][] = [
    ["agendo://focus?pr=5001", { kind: "pr", id: 5001 }],
    ["agendo://focus?workItem=102", { kind: "workItem", id: 102 }],
    ["agendo://focus?session=standalonese", { kind: "session", token: "standalonese" }],
    ["agendo://focus?session=019cde00-1111-7000-8000-00000000cde0", { kind: "session", token: "019cde00-1111-7000-8000-00000000cde0" }],
    // Browsers differ on whether they add an empty path.
    ["agendo://focus/?pr=1", { kind: "pr", id: 1 }],
    ["agendo://focus?pr=2147483647", { kind: "pr", id: 2147483647 }],
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
    // flag-shaped and overlong session ids
    "agendo://focus?session=-x",
    "agendo://focus?session=--attach",
    `agendo://focus?session=a${"b".repeat(64)}`,
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

  test("isSessionToken: id or short id, never flag-shaped", () => {
    expect(isSessionToken("standalonese")).toBe(true);
    expect(isSessionToken("019cde00-1111-7000-8000-00000000cde0")).toBe(true);
    expect(isSessionToken("-f")).toBe(false);
    expect(isSessionToken("a b")).toBe(false);
    expect(isSessionToken("")).toBe(false);
  });

  test("describeTarget", () => {
    expect(describeTarget({ kind: "pr", id: 1234 })).toBe("PR !1234");
    expect(describeTarget({ kind: "workItem", id: 7 })).toBe("work item #7");
    expect(describeTarget({ kind: "session", token: "abc" })).toBe("session abc");
  });
});

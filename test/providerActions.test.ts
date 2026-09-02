// Switching backend from the provider picker (src/ui/providerActions.ts): the
// pure decision and the closures that apply it. The e2e suite runs with one
// backend's CLI stubbed at a time and never opens the picker to switch, so
// the whole of the old inline closure scored at cc 7 with one statement seen.
import { describe, expect, mock, test } from "bun:test";
import type { Mode } from "../src/ui/keys/context.ts";
import { makeProviderActions, providerSwitch, unavailableNotice } from "../src/ui/providerActions.ts";

const both = new Set(["github", "ado"] as const);
const settings: Mode = { kind: "settings", cursor: 0 } as Mode;

describe("providerSwitch", () => {
  test("uninstalled → the auth hint; current → same; else → switch", () => {
    expect(providerSwitch("ado", "github", new Set(["github"]))).toEqual({ kind: "unavailable", notice: unavailableNotice("ado") });
    expect(providerSwitch("github", "github", both)).toEqual({ kind: "same" });
    expect(providerSwitch("ado", "github", both)).toEqual({ kind: "switch" });
  });

  test("the hint names the backend and its CLI login", () => {
    expect(unavailableNotice("ado")).toBe("Azure DevOps unavailable — install the Azure CLI, then: az login");
    expect(unavailableNotice("github")).toBe("GitHub unavailable — install the GitHub CLI, then: gh auth login");
  });
});

describe("applyProvider", () => {
  function actions(provider: "github" | "ado", available: ReadonlySet<"github" | "ado">) {
    const setters = {
      setProvider: mock(),
      setIdentity: mock(),
      persist: mock(),
      setCursor: mock(),
      clearSearch: mock(),
      setMode: mock(),
      setNotice: mock(),
    };
    return { ...setters, ...makeProviderActions({ provider, available, ...setters }) };
  }

  test("a real switch clears the identity, persists, resets scroll and search, and lands on the list", () => {
    const a = actions("github", both);
    a.applyProvider("ado", settings);
    expect(a.setProvider.mock.calls).toEqual([["ado"]]);
    expect(a.setIdentity.mock.calls).toEqual([[null]]);
    expect(a.persist.mock.calls).toEqual([[{ provider: "ado", identity: null }]]);
    expect(a.setCursor.mock.calls).toEqual([[0]]);
    expect(a.clearSearch).toHaveBeenCalledTimes(1);
    expect(a.setMode.mock.calls).toEqual([[{ kind: "list" }]]);
    expect(a.setNotice).not.toHaveBeenCalled();
  });

  test("an uninstalled backend goes back to the fallback with its hint; the current one goes back silently", () => {
    const off = actions("github", new Set(["github"]));
    off.applyProvider("ado", settings);
    expect(off.setMode.mock.calls).toEqual([[settings]]);
    expect(off.setNotice.mock.calls).toEqual([[unavailableNotice("ado")]]);
    expect(off.setProvider).not.toHaveBeenCalled();
    const same = actions("github", both);
    same.applyProvider("github", settings);
    expect(same.setMode.mock.calls).toEqual([[settings]]);
    expect(same.setNotice).not.toHaveBeenCalled();
    expect(same.persist).not.toHaveBeenCalled();
  });
});

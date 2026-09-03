// The string half of the clone flow (src/clone/url.ts): every shape of Azure
// DevOps and GitHub URL reduced to the remote to clone and its identity key.
// The e2e clone spec pastes the common forms into the real screen; what it
// never pastes is the legacy `{org}.visualstudio.com` host, a dev.azure.com
// URL with no repo in it, a segment that does not percent-decode, a `:token@`
// with an empty username, and GitHub's SSH-over-443 host.
import { describe, expect, test } from "bun:test";
import { parseRepoUrl, redactUrl } from "../src/clone/url.ts";

const remoteOf = (s: string) => parseRepoUrl(s)?.remote ?? null;
const keyOf = (s: string) => parseRepoUrl(s)?.key ?? null;

describe("parseRepoUrl — Azure DevOps", () => {
  test("SSH: git@ on the new host, the org on the legacy host, a pasted user kept, a port forcing ssh://", () => {
    expect(remoteOf("git@ssh.dev.azure.com:v3/acme/Proj/repo")).toBe("git@ssh.dev.azure.com:v3/acme/Proj/repo");
    expect(remoteOf("vs-ssh.visualstudio.com:v3/acme/Proj/repo")).toBe("acme@vs-ssh.visualstudio.com:v3/acme/Proj/repo");
    expect(remoteOf("me@vs-ssh.visualstudio.com:v3/acme/Proj/repo")).toBe("me@vs-ssh.visualstudio.com:v3/acme/Proj/repo");
    expect(remoteOf("ssh://git@ssh.dev.azure.com:2222/v3/acme/Proj/repo.git")).toBe("ssh://git@ssh.dev.azure.com:2222/v3/acme/Proj/repo");
    expect(remoteOf("ssh://git@SSH.dev.azure.com:22/v3/acme/Proj/repo")).toBe("git@ssh.dev.azure.com:v3/acme/Proj/repo");
    expect(keyOf("git@ssh.dev.azure.com:v3/acme/Proj/repo")).toBe("ado:acme/proj/repo");
  });

  test("dev.azure.com: web decoration dropped, the org's userinfo kept, no-project shorthand, and nothing without _git", () => {
    expect(remoteOf("https://acme@dev.azure.com/acme/My%20Proj/_git/repo?path=/src&version=GBmain")).toBe("https://acme@dev.azure.com/acme/My%20Proj/_git/repo");
    expect(parseRepoUrl("https://dev.azure.com/acme/My%20Proj/_git/repo")).toMatchObject({ project: "My Proj", key: "ado:acme/my proj/repo" });
    expect(remoteOf("https://dev.azure.com/acme/_git/repo")).toBe("https://dev.azure.com/acme/repo/_git/repo");
    expect(remoteOf("https://dev.azure.com/acme/Proj/pullrequest/42")).toBeNull();
    expect(remoteOf("https://dev.azure.com/acme/Proj/_git/")).toBeNull();
    expect(remoteOf("https://dev.azure.com/")).toBeNull();
  });

  test("the legacy host: DefaultCollection is not a project, and a non-repo page is nothing", () => {
    expect(remoteOf("https://acme.visualstudio.com/DefaultCollection/Proj/_git/repo")).toBe("https://acme.visualstudio.com/Proj/_git/repo");
    expect(keyOf("https://acme.visualstudio.com/Proj/_git/repo.git")).toBe("ado:acme/proj/repo");
    expect(remoteOf("https://acme.visualstudio.com/Proj/pullrequest/42")).toBeNull();
    expect(remoteOf("https://evil.visualstudio.com.example.org/Proj/_git/repo")).toBeNull();
  });

  test("a segment that does not percent-decode is kept as pasted, encoded once more for the remote", () => {
    expect(parseRepoUrl("https://dev.azure.com/acme/%E0%A4%A/_git/repo")).toMatchObject({
      project: "%E0%A4%A",
      remote: "https://dev.azure.com/acme/%25E0%25A4%25A/_git/repo",
    });
  });
});

describe("parseRepoUrl — GitHub", () => {
  test("the SSH-over-443 host keeps its ssh:// form; credentials are kept in the remote and masked for display", () => {
    expect(remoteOf("ssh://git@ssh.github.com:443/octo/hello.git")).toBe("ssh://git@ssh.github.com:443/octo/hello.git");
    expect(parseRepoUrl("https://x:tok@github.com/octo/hello")).toMatchObject({
      remote: "https://x:tok@github.com/octo/hello.git",
      displayRemote: "https://x:***@github.com/octo/hello.git",
    });
    expect(remoteOf("git clone https://github.com/octo/hello.git --depth 1")).toBe("https://github.com/octo/hello.git");
    expect(remoteOf("https://github.com/orgs/octo/repositories")).toBeNull();
  });
});

describe("redactUrl", () => {
  test("an empty username with a token, a vouched org, and a bare token", () => {
    expect(redactUrl("https://:tok@dev.azure.com/x")).toBe("https://:***@dev.azure.com/x");
    expect(redactUrl("https://acme@dev.azure.com/x", "ACME")).toBe("https://acme@dev.azure.com/x");
    expect(redactUrl("https://pat@dev.azure.com/x")).toBe("https://***@dev.azure.com/x");
    expect(redactUrl("https://github.com/octo/hello")).toBe("https://github.com/octo/hello");
  });
});

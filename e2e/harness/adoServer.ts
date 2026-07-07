// A tiny mock of the Azure DevOps REST surface the launcher talks to. Routes
// requests by matching the path suffix (so the project/team segments in the real
// paths — and their URL-encoding — don't matter) and, where the launcher
// distinguishes calls by query string (creatorId vs reviewerId, the policy
// artifactId, the workitems id list), by the parsed query. Returns the base URLs
// to point the REST layer at via ADO_BASE_URL / ADO_VSSPS_URL / ADO_GRAPH_URL.
// Every request is recorded for optional assertions.
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  ADO,
  resolveWiql,
  resolveWorkItems,
  resolvePullRequests,
  resolveSinglePr,
  resolvePolicy,
  resolvePrIterations,
  resolvePrWorkItems,
} from "./fixtures.ts";

export interface AdoServer {
  baseUrl: string; // dev.azure.com stand-in (ADO_BASE_URL)
  vsspsUrl: string; // app.vssps.visualstudio.com stand-in (ADO_VSSPS_URL)
  graphUrl: string; // vssps.dev.azure.com/<org> stand-in (ADO_GRAPH_URL)
  requests: string[]; // "METHOD pathname" for each handled request
  /** Bodies of every POST, keyed by path suffix match — for WIQL assertions. */
  wiqlQueries: string[];
  /** Patch a PR's fields at runtime (merged over the fixture on every response),
   *  so a test can flip status/isDraft/title between reloads to prove the app
   *  re-reads mutable PR state rather than serving a frozen cache. */
  setPr(id: number, patch: Record<string, unknown>): void;
  close(): Promise<void>;
}

export async function startAdoServer(): Promise<AdoServer> {
  const requests: string[] = [];
  const wiqlQueries: string[] = [];
  // Runtime PR overrides, merged over the fixture PR on every single-PR / list
  // response. In-memory (same process as the test), so a mutation is visible to
  // the child launcher's very next request.
  const prOverrides = new Map<number, Record<string, unknown>>();
  const withOverride = (pr: any): any =>
    pr && prOverrides.has(pr.pullRequestId) ? { ...pr, ...prOverrides.get(pr.pullRequestId) } : pr;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const q = url.searchParams;
    requests.push(`${req.method} ${path}`);

    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const notFound = () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unmocked path: ${path}` }));
    };

    // ── identity / project metadata ──
    if (/_apis\/profile\/profiles\/me$/i.test(path)) return json(ADO.profile);
    if (/_apis\/projects\/[^/]+\/teams\/[^/]+\/members$/i.test(path)) return json(ADO.teamMembers);
    if (/_apis\/projects\/[^/]+\/teams$/i.test(path)) return json(ADO.teams);
    if (/_apis\/projects\/[^/]+$/i.test(path)) return json(ADO.project);
    // Graph traversal (team-membership). Intentionally unmocked → 404; the app
    // catches it and falls back to "self only" (review reason "you").
    if (/_apis\/graph\//i.test(path)) return notFound();

    // ── work items ──
    if (/_apis\/work\/teamsettings\/iterations$/i.test(path)) return json(ADO.iterations);
    if (/_apis\/wit\/wiql$/i.test(path)) {
      drain(req, (body) => {
        let query = "";
        try {
          query = JSON.parse(body || "{}").query ?? "";
        } catch {
          query = "";
        }
        wiqlQueries.push(query);
        json(resolveWiql(query));
      });
      return;
    }
    if (/_apis\/wit\/workitems$/i.test(path)) return json(resolveWorkItems(q.get("ids")));

    // ── pull requests ──
    // PR→workitems and PR iterations are sub-resources; match them before the
    // single-PR route (whose `$` anchor already excludes these, but be explicit).
    const wiOfPr = path.match(/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/workitems$/i);
    if (wiOfPr) return json(resolvePrWorkItems(Number(wiOfPr[1])));
    const itersOfPr = path.match(/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)\/iterations$/i);
    if (itersOfPr) return json(resolvePrIterations(Number(itersOfPr[1])));
    const prMatch = path.match(/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)$/i);
    if (prMatch) {
      const pr = withOverride(resolveSinglePr(prMatch[1], Number(prMatch[2])));
      if (pr) return json(pr);
      res.writeHead(404).end("no such PR");
      return;
    }
    // Active PRs by creator or reviewer (same path; distinguished by query).
    if (/_apis\/git\/pullrequests$/i.test(path)) {
      const { value } = resolvePullRequests(q);
      return json({ value: value.map(withOverride) });
    }

    // ── CI / merge-gate policy + build results ──
    if (/_apis\/policy\/evaluations$/i.test(path)) {
      return json(resolvePolicy(q.get("artifactId") ?? ""));
    }
    if (/_apis\/build\/builds\/\d+$/i.test(path)) {
      // No expired builds in the fixtures; respond benignly if ever asked.
      return json({ status: "completed", result: "succeeded" });
    }

    notFound();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    // The app appends paths to ADO_BASE_URL; the org segment is irrelevant to
    // routing (we match on the _apis suffix) but we include one for realism.
    baseUrl: `${origin}/acme`,
    vsspsUrl: origin,
    graphUrl: `${origin}/acme`,
    requests,
    wiqlQueries,
    setPr: (id, patch) => prOverrides.set(id, { ...prOverrides.get(id), ...patch }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function drain(req: import("node:http").IncomingMessage, done: (body: string) => void) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => done(body));
}

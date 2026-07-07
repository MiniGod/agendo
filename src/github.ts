// GitHub access layer. Mirrors the surface of ado.ts but talks to GitHub
// through the `gh` CLI (so it reuses the user's existing `gh auth login` — no
// token handling here). Active when the GitHub backend is selected in the UI.
//
// GitHub has no "team current iteration", so the two item buckets are by
// authorship instead: issues you created vs. other open issues in repos you own
// (see fetchWorkItems). Scope is the set of repos discovered from your local
// agent sessions (see repos.ts), each resolved to an `owner/repo` slug via its
// `origin` remote; repos whose origin isn't a github.com remote are skipped.
// Issue↔PR links come from closing references, "#N" mentions, or the issue id
// embedded in the PR branch (see linkedIssues).
import { spawn, spawnSync } from "child_process";
import type { RepoInfo } from "./repos.ts";
import type { FetchContext } from "./provider.ts";
import type {
  CIStatus,
  Identity,
  PullRequest,
  ReviewPR,
  TeamMember,
  WorkItem,
} from "./types.ts";

// ── gh invocation ─────────────────────────────────────────────────────────────
/** Run `gh` and parse its stdout as JSON (null on empty output). */
function gh(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gh ${args.join(" ")} -> exit ${code}: ${err.trim()}`));
        return;
      }
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch (e) {
        reject(new Error(`gh ${args.join(" ")} -> bad JSON: ${(e as Error).message}`));
      }
    });
  });
}

/** Like gh(), but swallows failures (e.g. a repo with issues disabled) → []. */
async function ghSafe(args: string[]): Promise<any[]> {
  try {
    return (await gh(args)) ?? [];
  } catch {
    return [];
  }
}

// ── Repo scope: local repo roots → owner/repo slugs ───────────────────────────
export interface RepoRef {
  owner: string;
  repo: string;
  /** Local checkout root the slug was derived from. */
  root: string;
}

const refCache = new Map<string, RepoRef | null>();

/**
 * Parse a git `origin` URL into a github.com `owner/repo`, or null when it isn't
 * a GitHub remote. The github.com host (or GitHub's `ssh.github.com` SSH-over-
 * HTTPS host) must sit right after the scheme `//`, an SSH `user@`, or the string
 * start, so a look-alike host is rejected: `mygithub.com` (no anchor before
 * `github.com`) and `github.com.evil.org` (github.com not delimited by a port,
 * `:`, or `/`) both yield null. Port-aware, so `ssh://git@ssh.github.com:443/
 * owner/repo` yields owner=`owner` (not `443`), and case-insensitive so
 * `GitHub.com` parses. Handles the SSH (`git@github.com:owner/repo(.git)`),
 * HTTPS (`https://github.com/owner/repo(.git)`), and `ssh://` forms.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = url
    .trim()
    .match(/(?:^|@|\/\/)(?:ssh\.)?github\.com(?::\d+)?[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Resolve a checkout's `origin` remote to a github.com owner/repo, or null. */
function repoRef(root: string): RepoRef | null {
  if (refCache.has(root)) return refCache.get(root)!;
  let ref: RepoRef | null = null;
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8" });
  if (r.status === 0) {
    const parsed = parseGithubRemote(r.stdout);
    if (parsed) ref = { ...parsed, root };
  }
  refCache.set(root, ref);
  return ref;
}

/** Distinct github.com slugs across the discovered repos (deduped, owner/repo). */
function reposToRefs(repos: RepoInfo[]): RepoRef[] {
  const seen = new Set<string>();
  const refs: RepoRef[] = [];
  for (const r of repos) {
    const ref = repoRef(r.root);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

const slugOf = (ref: RepoRef) => `${ref.owner}/${ref.repo}`;

// ── PR mapping ────────────────────────────────────────────────────────────────
// The --json fields we request for every PR. `reviews` and `statusCheckRollup`
// give us votes and CI without a second round-trip (so enrichPrCI is a no-op).
const PR_FIELDS =
  "number,title,url,headRefName,isDraft,reviewDecision,reviews," +
  "statusCheckRollup,mergeStateStatus,createdAt,updatedAt,author,closingIssuesReferences";

// For the linking query we additionally pull `body`, so "#N" mentions in the PR
// description count as links (see linkedIssues).
const LINK_PR_FIELDS = PR_FIELDS + ",body";

/**
 * Which of `issueNums` a PR is linked to. GitHub's own "closing references" only
 * exist once someone writes `Closes #N`, which is too strict to be the only
 * signal — so we also link on a bare `#N` mention anywhere in the title/body and
 * on the issue id embedded in the PR's branch (the launcher names work branches
 * `worktree-…-<id>`, the same convention sessions are matched by). The result is
 * that a PR shows under its issue while both are open, no closing keyword needed.
 */
function linkedIssues(raw: any, issueNums: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const r of raw.closingIssuesReferences ?? []) {
    if (issueNums.has(r.number)) out.add(r.number);
  }
  const text = `${raw.title ?? ""}\n${raw.body ?? ""}`;
  for (const m of text.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (issueNums.has(n)) out.add(n);
  }
  const branch = raw.headRefName ?? "";
  for (const n of issueNums) {
    // Same id-in-branch test sessions use (id delimited by non-digits).
    if (new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(branch)) out.add(n);
  }
  return out;
}

// Aggregate a PR's check rollup into a single gate status. CheckRuns carry
// status+conclusion; legacy StatusContexts carry a single `state`. A merge
// conflict (mergeStateStatus "DIRTY") outranks any individual check.
function rollupCI(rollup: any[] | undefined, mergeStateStatus: string | undefined): CIStatus {
  if (mergeStateStatus === "DIRTY") return "conflict";
  if (!rollup || rollup.length === 0) return "none";
  let fail = false, running = false, queued = false, pass = false;
  for (const c of rollup) {
    if (c.__typename === "StatusContext") {
      const s = c.state;
      if (s === "FAILURE" || s === "ERROR") fail = true;
      else if (s === "PENDING") running = true;
      else if (s === "SUCCESS") pass = true;
      continue;
    }
    // CheckRun
    if (c.status !== "COMPLETED") {
      if (c.status === "QUEUED" || c.status === "WAITING" || c.status === "PENDING") queued = true;
      else running = true; // IN_PROGRESS, REQUESTED, …
      continue;
    }
    const concl = c.conclusion;
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(concl)) fail = true;
    else if (concl === "SUCCESS") pass = true;
    // NEUTRAL / SKIPPED → ignored (don't count toward pass or fail).
  }
  if (fail) return "fail";
  if (running) return "running";
  if (queued) return "queued";
  if (pass) return "pass";
  return "none";
}

// Net review votes: the latest non-comment review per author. GitHub doesn't
// expose the branch-protection required count cheaply, so we approximate the
// gate from reviewDecision (any decision ⇒ at least one approval is required).
function voteSummary(reviews: any[] | undefined, reviewDecision: string | undefined) {
  const latest = new Map<string, string>(); // login → latest meaningful state
  for (const r of reviews ?? []) {
    const login = r.author?.login;
    const s = r.state;
    if (!login) continue;
    if (s === "COMMENTED" || s === "PENDING" || s === "DISMISSED") continue;
    latest.set(login, s); // reviews are chronological; last meaningful vote wins
  }
  let approvals = 0, rejections = 0;
  for (const s of latest.values()) {
    if (s === "APPROVED") approvals++;
    else if (s === "CHANGES_REQUESTED") rejections++;
  }
  const requiredCount = reviewDecision ? 1 : 0;
  const approvedCount = reviewDecision === "APPROVED" ? Math.max(1, approvals) : approvals;
  return { approvals, rejections, waiting: 0, approvedCount, requiredCount };
}

function mapPR(raw: any, ref: RepoRef): PullRequest {
  const slug = slugOf(ref);
  const createdDate = raw.createdAt ? new Date(raw.createdAt).getTime() : 0;
  const updatedDate = raw.updatedAt ? new Date(raw.updatedAt).getTime() : createdDate;
  return {
    id: raw.number,
    title: raw.title ?? "",
    status: "active", // only open PRs are fetched
    branch: raw.headRefName ?? "",
    repositoryId: slug,
    repositoryName: ref.repo,
    isDraft: !!raw.isDraft,
    ci: rollupCI(raw.statusCheckRollup, raw.mergeStateStatus),
    createdDate,
    updatedDate,
    url: raw.url ?? `https://github.com/${slug}/pull/${raw.number}`,
    ...voteSummary(raw.reviews, raw.reviewDecision),
  };
}

/** Whether `gh` is authenticated (`gh auth status` exits 0 when logged in) —
 *  the auth probe for the Settings page. Never throws; false on any failure. */
export function checkAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "status"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// ── Identities ────────────────────────────────────────────────────────────────
let cachedMe: Identity | null = null;

/** The authenticated `gh` user. login doubles as the id/uniqueName. */
export async function getMe(): Promise<Identity> {
  if (cachedMe) return cachedMe;
  const u = await gh(["api", "user"]);
  cachedMe = {
    id: u.login,
    displayName: u.name || u.login,
    uniqueName: u.login,
  };
  return cachedMe;
}

/**
 * GitHub has no "configured team" roster equivalent, so the identity switcher
 * just offers the authenticated user. (model.ts always includes `me` anyway.)
 */
export async function getTeamMembers(): Promise<TeamMember[]> {
  return [await getMe()];
}

// ── Work items (GitHub issues) ────────────────────────────────────────────────
// GitHub has no sprint, and solo OSS work rarely uses issue assignment, so the
// two item buckets are by authorship instead: issues you opened (inCurrentSprint
// = true → the primary "Created by me" section) vs. other open issues in repos
// you own (the collapsible "In your repos" section). For repos you *don't* own
// we only surface issues you opened, to avoid dumping a foreign tracker.
export async function fetchWorkItems(ctx: FetchContext): Promise<{
  items: Omit<WorkItem, "sessions">[];
  currentIterationPath: string | null;
}> {
  const refs = reposToRefs(ctx.repos);
  const login = ctx.identity.id;
  const isMe = (l: string | undefined) => !!l && l.toLowerCase() === login.toLowerCase();

  const perRepo = await Promise.all(
    refs.map(async (ref) => {
      const slug = slugOf(ref);
      const owned = ref.owner.toLowerCase() === login.toLowerCase();
      const issueArgs = owned
        // Repos you own: every open issue (split into created-by-you vs. the rest).
        ? ["issue", "list", "--repo", slug, "--state", "open",
           "--json", "number,title,state,url,labels,author", "--limit", "200"]
        // Repos you don't own: only the issues you filed.
        : ["issue", "list", "--repo", slug, "--author", login, "--state", "open",
           "--json", "number,title,state,url,labels,author", "--limit", "200"];
      const [issues, prsRaw] = await Promise.all([
        ghSafe(issueArgs),
        // Open PRs involving the user, scanned for links to the repo's issues.
        ghSafe([
          "pr", "list", "--repo", slug, "--search", `state:open involves:${login}`,
          "--json", LINK_PR_FIELDS, "--limit", "200",
        ]),
      ]);
      // Map issue number → PRs linked to it (closing ref, #N mention, or branch).
      const issueNums = new Set<number>((issues as any[]).map((i) => i.number));
      const prsByIssue = new Map<number, PullRequest[]>();
      for (const raw of prsRaw) {
        const pr = mapPR(raw, ref);
        for (const n of linkedIssues(raw, issueNums)) {
          const arr = prsByIssue.get(n) ?? [];
          arr.push(pr);
          prsByIssue.set(n, arr);
        }
      }
      return { ref, issues, prsByIssue };
    }),
  );

  const items: Omit<WorkItem, "sessions">[] = [];
  for (const { ref, issues, prsByIssue } of perRepo) {
    const slug = slugOf(ref);
    for (const iss of issues) {
      items.push({
        id: iss.number,
        type: "Issue",
        title: iss.title ?? "",
        state: iss.state ?? "OPEN",
        boardColumn: undefined,
        iterationPath: "",
        project: slug,
        // Authorship drives the two buckets (see header comment).
        inCurrentSprint: isMe(iss.author?.login),
        prs: prsByIssue.get(iss.number) ?? [],
        url: iss.url ?? `https://github.com/${slug}/issues/${iss.number}`,
      });
    }
  }

  // GitHub has no iteration path; the primary section header stays unlabeled.
  return { items, currentIterationPath: null };
}

// ── PRs you created ───────────────────────────────────────────────────────────
export async function fetchActivePRs(ctx: FetchContext): Promise<PullRequest[]> {
  const refs = reposToRefs(ctx.repos);
  const login = ctx.identity.id;
  const lists = await Promise.all(
    refs.map(async (ref) => {
      const raw = await ghSafe([
        "pr", "list", "--repo", slugOf(ref), "--search", `state:open author:${login}`,
        "--json", PR_FIELDS, "--limit", "200",
      ]);
      return raw.map((p) => mapPR(p, ref));
    }),
  );
  return lists.flat();
}

// ── PRs awaiting your review ──────────────────────────────────────────────────
export async function fetchReviewPRs(ctx: FetchContext): Promise<ReviewPR[]> {
  const refs = reposToRefs(ctx.repos);
  const login = ctx.identity.id;
  const lists = await Promise.all(
    refs.map(async (ref) => {
      const raw = await ghSafe([
        "pr", "list", "--repo", slugOf(ref), "--search", `state:open review-requested:${login}`,
        "--json", PR_FIELDS, "--limit", "200",
      ]);
      return raw
        // Don't surface your own PRs in your review queue.
        .filter((p) => p.author?.login !== login)
        .map((p): ReviewPR => ({ ...mapPR(p, ref), reviewReason: "you" }));
    }),
  );
  return lists.flat();
}

/**
 * No-op for GitHub: CI status, votes, and last-update time are already filled in
 * at fetch time (from statusCheckRollup / reviews / updatedAt). Kept to satisfy
 * the Provider interface.
 */
export async function enrichPrCI(_prs: PullRequest[]): Promise<void> {}

/**
 * No-op for GitHub. GitHub has no PR→work-item artifact link to resolve issues
 * *from* a PR; issue↔PR links are computed the other way (in fetchWorkItems via
 * closing references / "#N" mentions / branch ids), so orphan PRs simply stay
 * orphans. Kept to satisfy the Provider interface.
 */
export async function fetchWorkItemsForPRs(
  _prs: PullRequest[],
  _opts: { excludeWorkItemIds: Set<number>; currentIterationPath: string | null },
): Promise<{ items: Omit<WorkItem, "sessions">[]; surfacedPrIds: Set<number> }> {
  return { items: [], surfacedPrIds: new Set() };
}

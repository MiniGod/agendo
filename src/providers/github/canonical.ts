// Where a repo lives now. A checkout's `origin` keeps the name it was cloned
// under, and GitHub keeps redirecting git operations after a rename or a
// transfer, so a stale origin works for years. The search answers with the
// CURRENT `owner/name`, though, so matching on the origin's slug alone would
// silently drop every issue and PR of a moved repo. GraphQL's
// `repository(owner, name)` follows the redirect, so one request — about a
// point, however many repos — maps each origin slug to its current one.
import type { GraphqlRun } from "./search.ts";

/** One request for every slug: `r<i>: repository(owner: $o<i>, name: $n<i>) { nameWithOwner }`. */
export function canonicalQuery(count: number): string {
  const indices = Array.from({ length: count }, (_, i) => i);
  const vars = indices.map((i) => `$o${i}: String!, $n${i}: String!`).join(", ");
  const fields = indices.map((i) => `  r${i}: repository(owner: $o${i}, name: $n${i}) { nameWithOwner }`).join("\n");
  return `query AgendoGithubRepos(${vars}) {\n${fields}\n}`;
}

/**
 * Each slug's current `owner/name`, lowercased, keyed by the slug lowercased.
 * A repo GitHub does not show (gone, private to someone else) maps to itself.
 * A failed request rejects rather than answering "no renames", so the caller's
 * cache never keeps a failure as if it were an answer.
 */
export async function canonicalSlugs(run: GraphqlRun, slugs: string[]): Promise<Map<string, string>> {
  const out = new Map(slugs.map((s) => [s.toLowerCase(), s.toLowerCase()]));
  if (slugs.length === 0) return out;
  const vars: Record<string, string> = {};
  slugs.forEach((slug, i) => {
    const [owner, name] = slug.split("/");
    vars[`o${i}`] = owner!;
    vars[`n${i}`] = name!;
  });
  const data = await run(canonicalQuery(slugs.length), vars);
  slugs.forEach((slug, i) => {
    const now = data?.[`r${i}`]?.nameWithOwner;
    if (typeof now === "string") out.set(slug.toLowerCase(), now.toLowerCase());
  });
  return out;
}

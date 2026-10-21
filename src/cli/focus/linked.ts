// Which sessions a PR or work-item NUMBER names — and when it names more than
// one thing.
//
// `list --pr` answers for the model's whole reverse index and leaves the reader
// to look at the rows. `focus` acts on its answer, from a browser, with no cwd to
// scope by. And a number alone is not always an identity: GitHub numbers PRs and
// issues per REPOSITORY, so `#5` can be a PR in two repos at once, each with its
// own session. Picking "the most recent running one" across both would switch
// the human to the wrong repo's agent. So the matches are grouped by the entity
// they came from (its URL), and two different entities with sessions is a
// refusal, not a choice.
import type { LoadedModel } from "../../app/model/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import type { FocusTarget } from "./url.ts";

/** One PR or work item the number matched, keyed by what makes it THAT one. */
export interface LinkedMatch {
  key: string;
  sessions: AgentSession[];
}

type LinkedModel = Pick<LoadedModel, "linkedPrs" | "orphanPrs" | "reviewPrs" | "current" | "other" | "prLinked">;

/** Every PR / work item in the model with this number, each with its sessions. */
export function linkedMatches(m: LinkedModel, target: Exclude<FocusTarget, { kind: "session" }>): LinkedMatch[] {
  if (target.kind === "pr") {
    return [...m.linkedPrs, ...m.orphanPrs, ...m.reviewPrs]
      .filter((p) => p.id === target.id)
      .map((p) => ({ key: p.url || `repo:${p.repositoryId}`, sessions: p.sessions }));
  }
  return [...m.current, ...m.other, ...m.prLinked]
    .filter((it) => it.id === target.id)
    .map((it) => ({ key: it.url || `item:${it.id}`, sessions: it.sessions }));
}

export type LinkedSessions = { sessions: AgentSession[] } | { ambiguous: string[] };

/**
 * The sessions of the ONE entity the number matched, deduped by source:id —
 * or, when entities that differ both have sessions, the keys that collided.
 * The same entity listed twice (a PR both linked and awaiting review) is one.
 */
export function resolveLinked(matches: LinkedMatch[]): LinkedSessions {
  const withSessions = matches.filter((m) => m.sessions.length > 0);
  const keys = [...new Set(withSessions.map((m) => m.key))];
  if (keys.length > 1) return { ambiguous: keys };
  const out = new Map<string, AgentSession>();
  for (const m of withSessions) for (const s of m.sessions) out.set(`${s.source}:${s.id}`, s);
  return { sessions: [...out.values()] };
}

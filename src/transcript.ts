// Record-level helpers shared by the two passes over an agent transcript: the
// cheap metadata scan that builds the session index (sessions.ts) and the
// on-demand full-log parse that builds a session's activity (activity.ts).
// Both read the same codex records, so the shapes they agree on live here
// rather than in either half.

export function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The VS Code extension wraps the typed prompt in a context preamble (active
 * file, open tabs, …) and puts the real request under this header. We keep what
 * follows it and drop the machine-generated part above.
 */
const CODEX_IDE_REQUEST = /^# Context from my IDE setup:[\s\S]*?## My request for Codex:\s*/;

/**
 * Reduce a "user" turn to what the user actually typed, or "" when the whole
 * turn was injected by codex.
 *
 * Codex opens a thread with several such turns — `<environment_context>`,
 * `<user_instructions>`, `<recommended_plugins>`, the AGENTS.md dump — and more
 * keep appearing across versions, so we drop them by the two SHAPES they take
 * (an XML-ish block, or a markdown-header preamble) rather than enumerating
 * each one. The IDE preamble is the exception: it *contains* the real prompt.
 */
function stripCodexPreamble(msg: string): string {
  const ide = msg.replace(CODEX_IDE_REQUEST, "");
  if (ide !== msg) return ide.trim();
  return msg.startsWith("<") || msg.startsWith("# AGENTS.md instructions") ? "" : msg;
}

/**
 * The user-typed text of a codex transcript record, or undefined if it isn't a
 * user turn (or is one codex injected).
 *
 * Reads only `response_item` records: those are the model-facing conversation
 * and are present in every codex version we've seen, whereas the parallel
 * `event_msg`/`user_message` stream is absent from newer top-level threads. It
 * also means a message can't be counted twice from the two streams.
 */
export function codexUserText(e: Record<string, any>, p: Record<string, any>): string | undefined {
  if (e.type !== "response_item" || p.type !== "message" || p.role !== "user") return undefined;
  if (!Array.isArray(p.content)) return undefined;
  const raw = p.content
    .filter((c: any) => c?.type === "input_text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join(" ");
  return clean(stripCodexPreamble(raw)) || undefined;
}

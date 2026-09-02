import { execFile } from "child_process";
import type { AgentSource } from "../types.ts";

// The external session converter (Claude ↔ Copilot), run via npx. It rewrites a
// session's transcript into the other agent's on-disk format and prints the new
// session id; we then resume that session. Run with `--json` for a machine-
// readable result. See the gist for the full conversion logic.
const CONVERT_GIST = "gist:MiniGod/41cc0ab2f52f1577b55b8a0e362fd669";

/** Result of a successful conversion (subset of the converter's JSON output). */
export interface ConvertResult {
  /** New session id in the destination agent. */
  id: string;
  /** Working directory of the new session (only emitted for copilot→claude). */
  cwd?: string;
}

export type ConvertDirection = "claude-to-copilot" | "copilot-to-claude";

/** The last line of `stdout` that looks like a JSON object, parsed, or null. npm
 *  and npx chatter freely on stdout, so the converter's answer is the LAST such
 *  line, and anything that does not parse is treated as chatter too. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** What to tell the user when the converter produced no usable result: its own
 *  stderr first, then the spawn error, then a stock line. */
function converterFailure(stderr: string, err: Error | null): string {
  return stderr.trim() || err?.message || "converter produced no result";
}

/**
 * The converter's answer, read from what it wrote. A converter-reported
 * `{ "error": … }` is thrown with that message; an answer without an `id` is
 * a failure described by `converterFailure`. Pure — `runConvert` is the process
 * plumbing around it — so the parsing is pinned in test/convert.test.ts, which
 * the e2e suite cannot do: it has no npx and never runs the converter.
 */
export function parseConvertOutput(stdout: string, stderr: string, err: Error | null): ConvertResult {
  const obj = lastJsonObject(stdout);
  if (obj?.error) throw new Error(String(obj.error));
  if (obj?.id) return obj as unknown as ConvertResult;
  throw new Error(converterFailure(stderr, err));
}

/** Convert a session to the other agent via the external converter and resolve
 *  with its JSON result (see `parseConvertOutput` for how that is read). */
export function runConvert(direction: ConvertDirection, sessionId: string): Promise<ConvertResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      [CONVERT_GIST, direction, sessionId, "--json"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
      (err, stdout, stderr) => {
        try {
          resolve(parseConvertOutput(String(stdout), String(stderr), err));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

/**
 * The agent a session can be CONVERTED to, or null when there's nowhere to go.
 * The external converter (see CONVERT_GIST) only speaks Claude↔Copilot, so a
 * Codex session has no destination — better to hide the action than to offer a
 * conversion that would fail.
 */
export function convertTarget(source: AgentSource): AgentSource | null {
  if (source === "claude") return "copilot";
  if (source === "copilot") return "claude";
  return null;
}

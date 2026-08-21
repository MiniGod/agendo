import { execFile } from "child_process";
import type { AgentSource } from "../types.ts";

// The external session converter (Claude ↔ Copilot), run via npx. It rewrites a
// session's transcript into the other agent's on-disk format and prints the new
// session id; we then resume that session. Run with `--json` for a machine-
// readable result. See the gist for the full conversion logic.
const CONVERT_GIST = "gist:MiniGod/41cc0ab2f52f1577b55b8a0e362fd669";

/** Result of a successful conversion (subset of the converter's JSON output). */
interface ConvertResult {
  /** New session id in the destination agent. */
  id: string;
  /** Working directory of the new session (only emitted for copilot→claude). */
  cwd?: string;
}

/**
 * Convert a session to the other agent via the external converter and resolve
 * with its JSON result. We tolerate npm/npx chatter on stdout by scanning for
 * the last line that parses as a JSON object, and surface a converter-reported
 * `{ "error": … }` as a rejection.
 */
export function runConvert(
  direction: "claude-to-copilot" | "copilot-to-claude",
  sessionId: string,
): Promise<ConvertResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      [CONVERT_GIST, direction, sessionId, "--json"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
      (err, stdout, stderr) => {
        const line = (stdout || "")
          .split("\n")
          .map((l) => l.trim())
          .reverse()
          .find((l) => l.startsWith("{"));
        if (line) {
          try {
            const obj = JSON.parse(line);
            if (obj?.error) return reject(new Error(String(obj.error)));
            if (obj?.id) return resolve(obj as ConvertResult);
          } catch {
            // fall through to the error path below
          }
        }
        reject(new Error((stderr || "").trim() || err?.message || "converter produced no result"));
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

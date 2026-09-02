// The prose agendo injects into, or prints for, the agents it launches: the
// short system-prompt pointer that every spawned claude gets, and the long
// `--llm` guide it points at.
//
// Its own module for size: the guide is ~170 lines of text and nothing else in
// launch.ts is text at all.
import { SELF_CMD } from "./selfCmd.ts";

/**
 * Injected into every claude we spawn. Rather than teach claude the tmux /
 * worktree / system-prompt mechanics, it points at the one `launch` subcommand
 * the launcher owns — so the launcher handles all the details and the
 * instructions propagate automatically to any nested session it starts.
 */
export function launcherSystemPrompt(): string {
  return (
    "You are running inside agendo, which manages claude sessions as attachable tmux " +
    "windows. If the user EXPLICITLY asks you to start, check on, or message a separate " +
    `background session (its own session/worktree — not a sub-agent), first run \`${SELF_CMD} --llm\` ` +
    "for exact instructions; do not hand-roll tmux or worktrees."
  );
}

/**
 * The coordination hierarchy, as `--llm` describes it. Its own function because
 * `llmGuide` is a single array literal against a `max-lines-per-function` budget,
 * and because this section is the one part of the guide that is about a ROLE
 * rather than a command.
 *
 * It says how the levels relate and which way instructions may flow. It does NOT
 * say how to create a coordinator — see the note in `llmGuide`.
 */
function hierarchyGuide(): string[] {
  return [
    `Repo survey:  ${SELF_CMD} list repos [--json]`,
    "  One row per repo: how many sessions it has, and its orchestrator (or `none`).",
    "  The direct answer to \"which repos is nobody coordinating?\". Read-only.",
    "",
    "── The three-level hierarchy ────────────────────────────────────────────────",
    "",
    "    global orchestrator  →  per-repo orchestrators  →  per-worktree sessions",
    "",
    "Most sessions are the right-hand level and none of this applies. But if you ARE a",
    "coordinator, each level talks only to the level directly BELOW it, and always via",
    `\`${SELF_CMD} send <id> "…"\`:`,
    "",
    "  · The global orchestrator sends to repo orchestrators. Never to their sessions.",
    "  · A repo orchestrator sends to the worktree sessions it launched, and integrates",
    "    their branches. It does not manage other repos.",
    "  · A worktree session does the work in its own worktree and reports back.",
    "",
    "Reaching past a level is the mistake to avoid: two coordinators instructing one",
    "agent duplicate, revert, or lose its work. If something needs doing a level down",
    "from where you can reach, tell the level below you and let it act. READING is",
    "unrestricted — `list` and `status` are read-only, so inspect any depth you like.",
    "",
    "Who is where: `list --json` carries `repoRoot`/`repoName` per session, plus",
    '`orchestrator` (boolean) and `role` (`"global"` · `"repo"` · `null`). Both repo',
    'fields are `null` on a `role: "global"` row — that session belongs to no',
    "repository, so do not read one off it.",
    "",
  ];
}

/**
 * On-demand, agent-facing guide for the background-session workflow. Kept out of
 * the injected system prompt (which only points here) so every session isn't
 * bloated with detail it may never use. Printed by `agendo --llm`.
 */
export function llmGuide(): string {
  return [
    "agendo — running a separate background claude session",
    "",
    "Use this ONLY when the user explicitly asks to run work in a separate/background",
    "session (its own git worktree + claude). It is NOT for sub-agents within this session.",
    "EXCEPTION: if you are running in ORCHESTRATOR MODE, delegating this way IS your job —",
    "launch freely, no explicit per-unit request needed. (Your own instructions say so;",
    "nothing here can put you in that mode.)",
    "",
    "This guide is the WORKFLOW — which command to reach for, and what each one guarantees.",
    `It is not the complete flag reference: run \`${SELF_CMD} --help\` before using a flag you`,
    "are recalling from memory rather than reading here, and don't assume one exists.",
    "",
    `Start one:    ${SELF_CMD} launch "<task prompt>"`,
    "  Creates an isolated git worktree, runs a new agent there in an attachable tmux",
    "  window, runs unattended (auto/autopilot mode), and prints its session id.",
    "  Flags: --name <slug> (name the worktree/branch; if .claude/worktrees/<slug> already",
    "         exists and git lists it as a worktree, the session runs THERE) ·",
    "         --worktree=<path> (run in that existing worktree — the way to start a fresh",
    "         agent on work that only exists in a worktree, e.g. one whose session is",
    "         gone; adopted as found, uncommitted changes and an unexpected branch are",
    "         reported on stderr, never reset or stashed; note the =) · --no-worktree",
    "         (use the current checkout) · --attach (switch to it now instead of leaving",
    "         it detached) ·",
    "         --agent <claude|copilot|codex> / --copilot / --codex (which agent to run;",
    "         default claude) · --model <name> (model for the new session; all agents) ·",
    "         --fallback-model <name> (claude only). Only these agent flags are forwarded",
    "         — anything else dashed is an error, so put prompt text that starts with --",
    "         after a bare --.",
    "  Codex assigns its own session id, so `--agent codex` prints no id up front — find",
    "  it with `list` once the session has started.",
    "",
    // Deliberately NOT documented here: `launch --orchestrator`. `repoRootForCwd`
    // resolves a worktree back to its parent repo, so an agent sandboxed in a
    // worktree could use it to start a session in the human's MAIN checkout — one
    // told to merge branches there. That escalation should come from a human (it is
    // in `--help` and the README), never from instructions an agent reads to itself.
    // An orchestrator doesn't need it either: it is already in orchestrator mode,
    // and the sessions it launches are meant to implement, not to orchestrate.
    //
    // `launch --global-orchestrator` is omitted for the same reason, and harder:
    // a global orchestrator's whole job is starting orchestrators in OTHER repos.
    // `hierarchyGuide` above describes the levels and the one-level-down rule,
    // because a coordinator has to know them — and stops short of saying how to
    // CREATE a coordinator. One is told that by its own injected prompt, which
    // exists only because a human asked for it.
    `List yours:   ${SELF_CMD} list`,
    "  Lists the sessions running now (readiness, kind, id, dir, title) — to find ids.",
    "  The kind column marks COORDINATORS: `orch` is a repo orchestrator, `global` the",
    "  global one; everything else is an ordinary worktree session. A per-repo summary",
    "  under the table names each repo's orchestrator, or says it has none.",
    "  --all additionally lists idle ones: not running, but still on disk and revivable",
    "  with `resume` (below). A session missing from a plain `list` is not a lost session.",
    "  One at its usage limit reads \"limited <time>\" — when it comes back. Same instant",
    `  as an ISO 8601 limitResetAt field in ${SELF_CMD} list --json.`,
    "  It lists EVERY session on the machine, so when you only care about one project",
    "  scope it rather than filtering the output yourself: --path <dir> (sessions whose",
    "  cwd is under dir) or --repo <name> (sessions in that repo — a bare name or an",
    "  owner/repo slug; a worktree counts as the repo it belongs to). Both also work on",
    `  ${SELF_CMD} status, ${SELF_CMD} open and ${SELF_CMD} wait, and with --json.`,
    "",
    ...hierarchyGuide(),
    `Check on it:  ${SELF_CMD} status <id>`,
    "  Prints its state, task checklist, Workflow-tool runs (with agent progress),",
    "  recent activity, and whether its input is ready for a prompt. A session parked on",
    "  claude's own resume dialog reports ready (and a `resume:` line saying so) — the",
    "  activity you see there is the PREVIOUS run's, until your next send resumes it.",
    "",
    "Finished, or stalled?  Both look like `ready`. So list/status also report how long",
    "  since the session last did anything, and mark a live, non-busy one that has been",
    "  silent past a threshold (4h; --stalled-after <dur> to change it) with \"stalled\".",
    "  That ONLY means nothing has happened for that long — agendo cannot tell finished",
    "  from fell-over, so read the final response before deciding. It also cannot see a",
    "  session BUSY doing nothing (a shell loop polling for a file reads as busy forever),",
    "  and a limited or resume-dialog session is never marked stalled — it is waiting, not",
    "  hung. --json adds per session: idleSeconds, stalled, stalledAfterSeconds (the",
    "  threshold it was judged against), resumeDialog, limitResetAt, compactionPercent (how",
    "  far a compacting session has got), and git — the",
    "  checkout's branch/upstream and whether it holds commits the remote does not",
    "  (unpushed). \"idle for hours AND unpushed work\" is the parked-session signal.",
    "",
    `Link to it:   ${SELF_CMD} open <id> --print`,
    "  Prints the FULL URLs of the PR / work item the session links to (drop --print to",
    "  open the PR in a browser; --work-item picks the other one). Use it whenever you",
    "  report a PR or work item to a human — hand over the whole clickable link, never a",
    `  bare number, and never hand-assemble one. \`${SELF_CMD} list --json\` carries the`,
    "  same links per session as prUrl / workItemUrl.",
    "",
    `Message it:   ${SELF_CMD} send <id> "<prompt>"`,
    "  Sends a follow-up prompt. A claude session takes it on its messaging socket, which",
    "  QUEUES it even mid-turn, so you don't have to wait for one to go idle first; a",
    "  session without that channel (Copilot) has it typed into the pane, and that needs",
    "  an idle input and refuses otherwise (--force to override). Either way it refuses a",
    "  session at its usage limit — check back with `status` or `wait`.",
    "  Exception: claude's OWN resume dialog (\"Resume from summary / Resume full session",
    "  as-is\") is not a question for you — such a session reports ready, and send answers",
    "  the dialog itself (config resumeDialogChoice), waits for the input box, then",
    "  delivers. Answering it is always keystrokes — the socket can't do it, since a frame",
    "  arrives as a peer message the receiver won't take as the answer to a prompt — so if",
    "  that box never appears, send fails WITHOUT delivering by EITHER route, and --force",
    "  will not change that (pasting into the menu would pick an option) — retry, or attach.",
    "  The socket does not shorten that wait: it replaces the DELIVERY step only, never the",
    "  dialog step, so the retry advice under `resume` below applies exactly as written.",
    "  \"Session <id> is not running\" is not a dead end either: `resume` it (below), then send.",
    "  (A session that IS running but has the socket switched off says so instead, and names",
    "  the switch — don't `resume` that one, it is already alive.)",
    "  It always NAMES the route: \"queued via socket\" means the message is sitting in that",
    "  session's queue and may not be read for a while; \"pasted into pane\" means it is on",
    "  screen now, and the pane had to be idle to accept it. Do not assume which you got —",
    "  `--json` carries the same as route: \"socket\" | \"pane\" plus queued: true/false.",
    "  The socket can be switched off (AGENDO_PEER_SOCKET=0, or \"peerSocket\": false in",
    "  ~/.agendo/config.json), in which case every send is the pane route and refuses a",
    "  busy session — so route reporting is the only reliable way to know what you have.",
    "",
    `Be told when it needs you (DON'T poll):`,
    `              ${SELF_CMD} wait <id...> --any --json --timeout 30m`,
    "  Blocks until a session settles — a non-busy state that isn't limited or unknown and",
    "  has no background agent still running — or its window closing (\"exited\"), then exits.",
    "  A session parked at its usage cap does",
    "  NOT count as settled: it is paused, not finished. You are still woken promptly, but",
    "  with a non-zero exit and woke=\"blocked\" plus limitResetAt (which can already be past,",
    "  if it is parked beyond its own reset), so you can back off until then.",
    "  Run it in the BACKGROUND and treat its exit as the notification: that is the whole",
    "  point. Do NOT re-run `status` on a guessed cadence; you will either check too often",
    "  or find out too late.",
    "  --any wakes on the first of several sessions to settle, so one long-running session",
    "         can't hide the others. Without it, every target must settle.",
    "  --json prints what you woke up to find out: why it woke (satisfied / timeout /",
    "         unsatisfiable / blocked) and per session its from → state, changed,",
    "         satisfied, cwd, limitResetAt, resumeDialog and backgroundAgents.",
    "         resumeDialog true means it woke you at claude's resume dialog, so nothing has",
    "         run yet and any activity you read is the PREVIOUS run's. backgroundAgents > 0",
    "         means a subagent is still running, so the default wait does not treat the",
    "         session as done — usually with the main agent idle at its prompt, in which",
    "         case state is `ready` and send reaches it. Check state, not the count.",
    "  Instead of ids: --all, or --prefix <p>. --repo <name> / --path <dir> scope it to",
    "         one project, and narrow --all and explicit ids too rather than replacing them.",
    "  --state <s> waits for one exact state (ready, busy, queued, dialog, limited,",
    "         exited, …) — e.g. --state limited to be told the moment it hits its usage",
    "         cap, or --state exited to be told only when it is completely finished.",
    "         `dialog` means a question for YOU; claude's own resume dialog is not one",
    "         (it reads ready, per send above), so it won't wake a --state dialog wait.",
    "         An explicit --state/--not is never pre-empted by the blocked wake, so",
    "         --state exited waits THROUGH a usage cap and --not limited waits it out.",
    "  Exit 0 = the condition held. Non-zero = timed out, a session exited without",
    "  reaching it, or one is stuck at its usage cap. Raise --timeout (default 120s) to",
    "  the real length of the work.",
    "  Check the exit code before parsing --json: a setup error (unknown id, nothing",
    "  running) reports on stderr and prints no payload at all.",
    "",
    `Close it:     ${SELF_CMD} close <id>`,
    "  Ends the session by killing ONLY its tmux window. Its git worktree, branch and",
    "  commits are guaranteed untouched on disk, so nothing is lost and `resume <id>`",
    "  brings it back — see \"Bring one back\" below. Refuses a session with work in flight",
    "  (--force to override). That includes a session whose SUBAGENT is still running while",
    "  its main agent sits idle: it reads \"ready\" and `send` reaches it, but closing it now",
    "  would kill the subagent mid-write. `wait` holds for the same reason.",
    "  Use this instead of `tmux kill-window`/`kill-session` — never hand-roll a kill.",
    "  A `wait` on a session you close ends at once, reporting it as \"exited\".",
    "",
    `Bring one back: ${SELF_CMD} resume <id>`,
    "  A session whose tmux window is GONE is NOT a lost session, and must never be",
    "  relaunched from scratch. That holds however the window went away: you closed it, the",
    "  agent exited, the tmux server was restarted, the machine rebooted. Its git worktree,",
    "  branch and commits are on disk and its transcript is in the agent's own history, so",
    "  `resume` starts it again in a fresh detached tmux window, where it picks up where it",
    "  left off. Relaunching the work in a new worktree instead ABANDONS that branch and",
    "  those commits — reach for `resume` first, every time. (--attach switches to it now,",
    "  the way `launch --attach` does.)",
    "  This is the answer to \"is not running\" from `send` / `unblock` / `wait`, and to a",
    "  session that `wait` reported \"exited\". Find ids for idle sessions with `list --all`.",
    "  AFTER A RESUME, GIVE IT A MOMENT. The agent comes back on claude's own resume dialog",
    "  and may compact before its input box exists, so the first `send` can legitimately",
    "  fail with \"answered claude's resume dialog but no input box appeared within <n>s\".",
    "  Nothing was delivered and nothing is broken: WAIT AND RETRY (a minute is usually",
    "  enough; --timeout <dur> raises the ceiling). Do NOT reach for --force — it cannot",
    "  paste into that menu by design, since the message would pick a menu option instead.",
    "",
    "The <id> is printed when you launch. Background sessions you start carry these same",
    "instructions, so they can launch and coordinate their own background sessions too.",
  ].join("\n");
}


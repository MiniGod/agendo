/** The `--help` / `help` text, printed verbatim by the dispatch in src/index.tsx. */
export const HELP = `agendo — manage claude sessions as attachable tmux windows

Usage:
  agendo [path]                Open the launcher in its own tmux session (default:
                                session "agendo"). With a path, scope the launcher
                                to sessions under it (host session "agendo-<basename>")
                                and narrow the work-item / PR views to the git repos
                                found inside it. Toggle scoped↔global at runtime with
                                the a key, the repo filter with f.
      --session, -s <name>      Override the derived host session name (e.g. on a
                                basename collision between two paths)
  agendo --no-tmux             Open the menu inline, without a tmux session
  agendo launch [opts] <prompt>
                              Start a background session: own git worktree + a
                              new agent, in a tmux window attachable later from
                              the menu. Prints the new session id.
      --attach, -a              Switch/attach to it immediately (default: detached)
      --name, -n <slug>         Name the worktree/branch (else derived from prompt).
                                If .claude/worktrees/<slug> already exists it is
                                ADOPTED — provided git lists it as a worktree of
                                this repo (a bare directory there is refused).
      --worktree=<path>         Run in that EXISTING worktree instead of creating
                                one — any worktree root git registers, wherever
                                it lives. Adopted as found: an unexpected branch or
                                uncommitted changes are reported on stderr, never
                                reset, stashed or checked out. Can't combine with
                                --name / --no-worktree. Note the "=": a bare
                                --worktree followed by a path is refused.
      --no-worktree             Run in the current checkout instead of a new worktree
      --worktree                Force a new worktree (only useful with --orchestrator,
                                which otherwise runs in the main checkout)
      --agent <claude|copilot|codex>
                                Which agent to launch (default: claude). Codex
                                assigns its own session id, so no id is printed;
                                find it with "agendo list" once it has started.
      --copilot / --claude / --codex
                                Shorthand for the matching --agent
      --orchestrator, -O        Run the session in ORCHESTRATOR MODE: it writes no
                                project code itself — it splits the goal into units,
                                launches one background session per unit (each with a
                                sub-agent dev→review loop), monitors them via
                                list/status/send, and squash-merges each finished
                                branch into the main branch. Claude only. Runs in the
                                repo's MAIN checkout (not a worktree) — git allows the
                                main branch in only one working tree, which is where
                                the merges have to happen. --worktree overrides, and
                                then names the branch "orchestrator" (-2, -3, … if
                                taken) unless --name says otherwise. Unlike other
                                background launches it keeps its approval prompts,
                                since it acts on your main checkout; --unattended
                                waives them.
      --unattended              Only with --orchestrator: run it auto-approving, like
                                an ordinary background session. It merges into your
                                main checkout and spawns further sessions, so this
                                hands all of that over unreviewed.
      --model <name>            Model for the new session, passed to the agent
      --fallback-model <name>   Claude only: model to fall back to when overloaded
                                Any other dashed argument is an error; put prompt
                                text that starts with -- after a bare --.
  agendo list, ls [dir]        List the sessions running right now, one per line
                                (readiness, kind, id, age, dir, title). "age" is
                                how long since the session last did anything; a
                                live, non-busy session idle past the stall
                                threshold is marked ⚠stalled. A session at its
                                usage limit reads "limited <time>" when the pane
                                says when it resets — waiting on a quota, so
                                never ⚠stalled. With a dir, only sessions whose
                                cwd is under it are shown.
      --json                    Emit machine-readable JSON (with branch + linked
                                PR + work-item/issue + idleSeconds/stalled +
                                ISO limitResetAt + unpushed-work state per session,
                                each link carrying a full prUrl / workItemUrl).
      --stalled-after <dur>     Idle time after which a live, non-busy session is
                                flagged stalled (default 4h; persist your own via
                                "stalledAfterMinutes" in ~/.agendo/config.json).
                                ⚠stalled only means "nothing has happened for
                                that long" — agendo cannot know if work finished.
      --all, --include-idle     Also list idle (not-running) sessions, each marked
                                running vs idle.
      --pr <n>                  Only sessions linked to PR #n (resolved via the
                                backend, so gh/az data is fetched).
      --issue, --work-item <n>  Only sessions linked to that issue / work item.
      --path <dir>              Same as the [dir] positional: only sessions whose
                                cwd is under dir. Combines with --repo.
      --repo <name>             Only sessions in that repo — a bare name or an
                                owner/repo slug. Worktrees count as their repo.
  agendo list pr, prs [dir]    List your open pull requests from the active backend,
                                each with its associated running session (pr#, ci,
                                approvals, branch, session, title). With a dir, only
                                PRs of the git repos inside it (see --repo-filter).
      --json                    Emit machine-readable JSON (full rows).
      --repo-filter,            Keep / drop the repo narrowing a [dir] implies
        --no-repo-filter        (default: on whenever a dir is given).
  agendo list issues [dir]     List issues / work items with any associated session
       (aliases: wi,            (id, state, session, title). Vocab follows the backend:
        work-items)             GitHub says "issue", Azure DevOps "work item". With a
                                dir, only issues of the git repos inside it — Azure
                                DevOps work items carry no repo, so they're matched
                                through their linked PRs (items with none are kept).
      --json                    Emit machine-readable JSON (id + sessions[]).
      --repo-filter,            As for list pr above.
        --no-repo-filter
  agendo resume <id>           Headless resume of an idle session in its own tmux
                                window (detached). <id> as for status. A missing
                                window — closed, crashed, tmux server restarted,
                                machine rebooted — never means the session is
                                lost: its worktree, branch, commits and transcript
                                are on disk, and this brings it back. Right after
                                one it sits on claude's resume dialog and may
                                compact, so the first \`send\` can time out waiting
                                for an input box — retry rather than --force.
      --attach, -a              Switch/attach to it immediately (default: detached)
  agendo wait [id...]          Block until the target session(s) settle, then exit
                                0; exit non-zero if they don't (timeout, exited,
                                usage-limited). Run it in the background and use
                                its exit as a notification, not re-polling status.
                                With no ids, select with --all / --prefix, and
                                scope any of those with --repo / --path.
                                A session whose window closes reads "exited": it
                                satisfies the default wait, and short-circuits a
                                --state it can no longer reach. One at its usage
                                limit does NOT — it's paused, not done: the wait
                                wakes on it promptly but exits non-zero
                                ("blocked"). An explicit --state/--not is never
                                pre-empted that way, so --state limited wakes on
                                the cap as a success and --not limited waits it out.
      --any                     Wake on the FIRST session to satisfy, not all of
                                them (so one stuck session can't mask the rest)
      --json                    Emit a wake payload on stdout: why it woke, and
                                each session's from → state, changed, satisfied,
                                limitResetAt, plus resumeDialog (parked on
                                claude's resume dialog: it reads ready, but
                                nothing has run yet)
      --state <ready|busy|…>    Wait for exactly this state (default: settled —
                                not busy, limited or unknown).
                                One of ready, busy, compacting, queued, dialog,
                                limited, unknown, exited. "dialog" means a question
                                for you — claude's own resume dialog reads ready,
                                so it won't wake a --state dialog wait.
      --not <state>             Wait until the state is anything but this
      --timeout <dur>           Give up after this long (default 120s)
      --interval <dur>          Poll cadence (default 2s). Durations: 500ms, 2s, 5m…
      --all                     All running sessions
      --prefix <p>              Sessions whose dir basename starts with p
      --repo <name>             Sessions in that repo (bare name or owner/repo)
      --path <dir>              Sessions whose cwd is under dir
                                --repo/--path narrow whichever selector chose the
                                set — including --all and explicit <id>s.
  agendo status <id>           Show a session's state, idle age, task checklist,
                                workflows (Workflow-tool runs with agent progress),
                                recent activity + full final response, and input
                                readiness. <id> is the session id or a tmux
                                name (cl-bg-…, cl-claude-…, cl-codex-…).
      --full, -F                Don't truncate the prompt / activity details
      --stalled-after <dur>     Idle time after which a live, non-busy session is
                                reported stalled (as for list)
      --urls, --links           Also resolve and print the full URLs of the linked
                                PR / work item (needs the backend, so it's opt-in —
                                the default status stays fast and auth-free).
      --path <dir>              Only resolve <id> among sessions under dir
      --repo <name>             Only resolve <id> among sessions in that repo
  agendo open <id>             Open the session's linked PR / work item in your
                                browser — the CLI mirror of the menu's o key. Every
                                resolved URL is printed first, so the link is
                                usable even where no browser can be launched.
      --pr                      Open the pull request (the default when both exist)
      --issue, --work-item      Open the work item / issue instead
      --print, -p               Only print the URL(s); never launch a browser
      --path <dir>              Only resolve <id> among sessions under dir
      --repo <name>             Only resolve <id> among sessions in that repo
  agendo send <id> <prompt>    Send a prompt to a running session. Claude sessions
                                that expose a messaging socket take it there, which
                                queues it even mid-turn; everything else (Copilot,
                                older claude builds) gets it typed into the pane,
                                and that refuses unless the input is idle/ready.
                                Either way, refuses a session at its usage limit.
                                If claude's own resume dialog is up, answers it
                                first (config: resumeDialogChoice) with keystrokes
                                and waits for the input box — the socket cannot
                                answer a dialog — then delivers.
                                Always names the route it took: "queued via socket"
                                (may be mid-turn) vs "pasted into pane" (had to be
                                idle). The two differ, so never assume which.
      --force, -f               Send even if the input doesn't look ready (but
                                never into claude's resume menu, see above)
      --json                    Emit the outcome as JSON: ok, route ("socket" |
                                "pane" | null), queued, the resolved sessionId /
                                target / pid, the socket setting in force, and a
                                "reason" when it refused.
      --timeout <dur>           Deadline for the input box to appear after that
                                dialog is answered — a ceiling, not a wait: it
                                proceeds as soon as the box is there (default 120s)
  agendo close <id>            End a running session: kills ONLY the tmux window
       (aliases: kill, stop)    (or session) it runs in. Its git worktree, branch
                                and commits are guaranteed untouched on disk —
                                nothing there is deleted, and \`agendo resume
                                <id>\` brings the session back. Only ever kills a
                                managed cl-… target, and refuses a session with
                                work in flight — mid-turn, compacting, text
                                queued, an open question, or a SUBAGENT still
                                running while the main agent sits idle at its
                                prompt — or a window it can't attribute to that
                                session alone, or can't read.
      --force, -f               Close despite work in flight / an ambiguous window
  agendo unblock <id>          Nudge a session at its usage limit to continue:
                                sends <esc>continue<enter>. Refuses unless the
                                pane is still showing the usage-limit notice.
      --force, -f               Unblock even if it doesn't look limited
  agendo --llm                 Print agent-facing instructions for the background-
                                session workflow (what the system prompt points to)
  agendo --help, -h            Show this help

Sessions are listed in the menu and marked running → attach. Background sessions
carry a {bg} badge, manually-started ones {new}.

The messaging socket \`send\` prefers is an internal, undocumented claude channel,
so there is a switch for turning it off without waiting for a release:
  AGENDO_PEER_SOCKET=0     one-off override (0/false/off/no; 1/true/on/yes re-enables)
  "peerSocket": false      durable preference, in ~/.agendo/config.json
The variable wins over the file, in both directions. Either one set to off forces
the tmux keystroke path outright — no discovery, no socket write — which means a
non-idle pane is refused again and a session with no window is unreachable.`;

# 🐢 Turtle Command Center

One page per project for supervising several Claude Code agents at once.

- **Create a task**: it gets its own git worktree + branch and a Claude Code session that starts investigating immediately.
- **Quick replies**: each agent turn ends with a summary + one-click options (or type your own reply).
- **Split**: when a task is too big, the agent proposes subtasks; edit them, approve, and they run in parallel.
- **Permissions** show up as cards (Allow / Always allow / Deny).

## Run

```sh
npm install
npm run build   # build the UI once
npm start       # http://localhost:7777
```

For UI development: `npm run dev` and open http://localhost:5173.

Requires the `claude` CLI, logged in (`claude login`). Sessions run on your Claude subscription;
`ANTHROPIC_API_KEY` is stripped from the agent environment so it is never billed to an API key by accident.

## Settings (env vars)

| Variable | Default | |
|---|---|---|
| `TCC_PORT` | `7777` | |
| `TCC_MAX_CONCURRENT` | `5` | Agents running at once across all projects; extra tasks queue |
| `TCC_DATA_DIR` | `~/.turtle-cc` | SQLite DB + task worktrees |
| `TCC_CLAUDE_BIN` | `claude` | |

## How it works

The server can restart at any time (`npm run dev` is safe to use while agents work): agents and the board
only share the SQLite database and log files.

- `server/runner.ts` starts each agent turn as a **detached** `claude -p --output-format stream-json` process writing
  to a log file in `~/.turtle-cc/runs`, and follows that log. After a restart the server re-attaches from the last
  processed byte offset; runs that finished while it was down are completed from their logs. `AgentRunner` is the
  seam for a future cloud/SDK runner.
- `server/mcp-stdio.mjs` provides the agent's command-center tools (`report_checkpoint`, `propose_split`,
  `permission_prompt`). Claude Code launches it per session, so it lives and dies with the session. It writes
  straight to the database; permission requests wait for your answer there, so they survive server restarts.
- `server/tasks.ts` has the scheduler and task lifecycle, and streams changes to the UI (SSE at `/api/stream`)
  by polling the database's `rev` counter.
- **Merge into &lt;branch&gt;** merges the task branch (`--no-ff`) into whatever your main checkout has checked out, then removes
  the worktree and branch. It only appears when the task has commits or uncommitted edits your checkout doesn't have yet. On conflicts the merge is aborted (your checkout is untouched) and you can ask the agent to resolve them.
- **Mark done** commits leftover changes and removes the worktree but keeps the `tcc/...` branch.
  **Discard** deletes the worktree and the branch.
- Hitting a usage limit parks the task and retries it automatically after 30 minutes.

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
| `TCC_MAX_CONCURRENT` | `2` | Agents running at once across all projects; extra tasks queue |
| `TCC_DATA_DIR` | `~/.turtle-cc` | SQLite DB + task worktrees |
| `TCC_CLAUDE_BIN` | `claude` | |

## How it works

- `server/runner.ts` runs `claude -p --output-format stream-json`, one process per agent turn, resuming the
  same session id each time. `AgentRunner` is the seam for a future cloud/SDK runner.
- `server/mcp.ts` is a small MCP server at `/mcp/:taskId` that every session connects to. It provides
  `report_checkpoint`, `propose_split`, and `permission_prompt` (used via `--permission-prompt-tool`).
- `server/tasks.ts` has the scheduler, task lifecycle, and live updates (SSE at `/api/stream`).
- **Mark done** commits leftover changes and removes the worktree but keeps the `tcc/...` branch for you to merge.
  **Discard** deletes the worktree and the branch.
- Hitting a usage limit parks the task and retries it automatically after 30 minutes.

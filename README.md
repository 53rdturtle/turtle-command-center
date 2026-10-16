# 🐢 Turtle Command Center

One page per project for supervising several Claude Code agents at once.

- **Create a task**: it gets its own git worktree + branch and a Claude Code session that starts investigating immediately.
- **Quick replies**: each agent turn ends with a summary + one-click options (or type your own reply). When an agent suggests merging, marking done or discarding, that option runs the board action directly.
- **Split**: when a task is too big, the agent proposes subtasks; edit them, approve, and they run in parallel.
- **Permissions** show up as cards (Allow / Always allow / Deny).
- **Screenshots**: paste (or drop) an image into a task's details or a reply. It's saved under `~/.turtle-cc/images` and
  the message references it as `[Image: <path>]`; agents open it with their Read tool (that folder is passed via `--add-dir`). When a task is done or discarded,
  its images are deleted unless an open task still mentions them; on startup, unsent drafts' images older than a day go too.

## Run

```sh
npm install
npm run build   # build the UI once
npm start       # http://localhost:7777
```

### Developing the board with itself

Run the board you use from a **stable copy**, not from this checkout: merging a task into this checkout changes
the server's files, and a `--watch` server would restart in the middle of the merge.

```sh
npm run stable   # creates/updates ../TurtleCommandCenter-stable at this checkout's HEAD and builds it
cd ../TurtleCommandCenter-stable && npm start   # http://localhost:7777, your real data in ~/.turtle-cc
```

After that, the board shows **Update board (N new)** in its header whenever tasks have been merged into this
checkout. Clicking it lets a running merge finish (queued merges wait), moves the stable copy to this checkout's
HEAD, installs and builds, restarts, and reloads the page. If the install or build fails, it rolls back and says so.

For UI development, `npm run dev` here and open http://localhost:5173. Dev mode uses its own API port (7778) and data
(`~/.turtle-cc-dev`), so it never shares a database with the stable board.

Requires the `claude` CLI, logged in (`claude login`). Sessions run on your Claude subscription;
`ANTHROPIC_API_KEY` is stripped from the agent environment so it is never billed to an API key by accident.

## Settings (env vars)

| Variable | Default | |
|---|---|---|
| `TCC_PORT` | `7777` | |
| `TCC_MAX_CONCURRENT` | `5` | Default for agents running at once across all projects; extra tasks queue. Change it live by editing the number in the board header (saved in the DB, overrides this) |
| `TCC_DEV_PORT` | `5173` | Vite dev server port (`npm run dev`) |
| `TCC_DATA_DIR` | `~/.turtle-cc` | SQLite DB + task worktrees |
| `TCC_CLAUDE_BIN` | `claude` | |

## How it works

The server can restart at any time (`npm run dev` is safe to use while agents work): agents and the board
only share the SQLite database and log files.

- `server/guard.ts` keeps other websites out of the API: requests need a loopback `Host` (no DNS rebinding), and
  mutating requests need `Content-Type: application/json`, an `X-TCC: 1` header and, if sent, a local `Origin`.
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
  the worktree and branch. It only appears when the task has commits or uncommitted edits your checkout doesn't have yet.
  It refuses up front if that checkout has uncommitted changes to tracked files (it lists them so you can commit or stash),
  a detached HEAD, or a merge, rebase or cherry-pick in progress. On conflicts the merge is aborted (your checkout is
  untouched) and you can ask the agent to resolve them; other git errors are shown as-is.
- **Try it** opens a terminal in the task's worktree and runs the project's *Try command* (project settings; e.g.
  `npm install && npm run dev`), or just a shell when there is none. The terminal gets free ports in `TCC_PORT` and
  `TCC_DEV_PORT` and a sandbox `TCC_DATA_DIR` (`~/.turtle-cc/try/<task>`), so when the project is this app, the copy
  under test runs beside your board with its own empty database instead of picking up your tasks.
  The **Try it** button in the header does the same in the project's main checkout, to try everything merged so far.
  Settings suggests a Try command from the repo (`godot --path .` for a Godot project, `npm install && npm run dev` with a `package.json`).
- **Agents test their own copy** too. Each agent run gets free `TCC_PORT` / `TCC_DEV_PORT` and its own sandbox
  `TCC_DATA_DIR` (`~/.turtle-cc/try/<task>-agent`, separate from the Try it one). The system prompt tells the agent to
  start the project with its Try command, stop what it started, and check pages with a headless Chrome screenshot
  (Edge when Chrome isn't installed). The browser uses a throwaway profile, so it never touches yours.
- **Mark done** commits leftover changes and removes the worktree but keeps the `tcc/...` branch.
  **Discard** deletes the worktree and the branch.
- **Accounts** (in Settings, along with desktop notifications): agents run on the first account with usage left. When it hits its usage limit, its tasks
  resume the same session on the next account; only when every account is limited do tasks park until the earliest
  reset (or 30 minutes if the limit message doesn't say). The default account is whatever `claude` is logged in to; add
  more with a token from `claude setup-token` (run it and sign in with that account). Each run gets its account's token
  as `CLAUDE_CODE_OAUTH_TOKEN`; sessions live in the shared `~/.claude`, so they carry over between accounts. Tokens are
  stored in the local SQLite DB and never sent to the browser.

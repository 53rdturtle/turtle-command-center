// Command-center tools for one agent session, as a stdio MCP server.
//
// Claude Code launches this process itself (via --mcp-config) and owns it, so it lives exactly as long as
// the session does and keeps working while the board server restarts. It talks to the board only through
// the shared SQLite database. Plain JS with no dependencies so it starts from any worktree without a loader.
//
// Env: TCC_DB (database path), TCC_TASK_ID (the board card this session belongs to).

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const taskId = Number(process.env.TCC_TASK_ID);
const db = new DatabaseSync(process.env.TCC_DB);
db.exec('PRAGMA busy_timeout = 10000');

const SUMMARY_MAX = 350;
const BOARD_ACTIONS = ['merge', 'done', 'discard'];
const SPLIT_MAX = 6;

const TOOLS = [
  {
    name: 'report_checkpoint',
    description:
      'Report back to the user on the command-center board. Call exactly once at the end of every turn, then stop. ' +
      'The user glances at the TL;DR on a busy board and picks one of the options (or types a reply).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: `TL;DR: 2-3 plain sentences, at most ${SUMMARY_MAX} characters, no bullets or headings. What you found or did, and what you need from the user. The decision must be clear from this alone.`,
        },
        details: { type: 'string', description: 'Optional markdown behind a "More" toggle: evidence, file paths, caveats, alternatives.' },
        options: {
          type: 'array',
          maxItems: 4,
          description:
            'One-click replies. The label is sent back verbatim as the user message, unless the option has an action. Recommended first.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Self-contained instruction, e.g. "Go with approach A: patch the parser (Recommended)"' },
              detail: { type: 'string', description: 'Optional tradeoff in a few words, shown under the button' },
              action: {
                type: 'string',
                enum: BOARD_ACTIONS,
                description:
                  'Makes this option run a board action instead of replying to you: "merge" merges your branch into the checked-out branch, ' +
                  '"done" marks the task done (keeps the branch), "discard" deletes the work and branch (the user confirms first). ' +
                  'You cannot do these yourself, so use this whenever you would suggest one, e.g. {label: "Looks good, merge it", action: "merge"}.',
              },
            },
            required: ['label'],
          },
        },
        done: {
          type: 'boolean',
          description: 'True when the task is complete and nothing more is needed. The board then shows its own merge and mark-done buttons, so no need to add those as options.',
        },
      },
      required: ['summary', 'options'],
    },
  },
  {
    name: 'propose_split',
    description:
      'Propose splitting this task into parallel subtasks when it is too big for one session, or when your findings are a list of ' +
      'independent changes or suggestions (one subtask each, so every change stays scoped and gets its own diff and merge). ' +
      'The user ticks which subtasks to create. Each subtask runs in its own session and git worktree. Call instead of report_checkpoint, then stop.',
    inputSchema: {
      type: 'object',
      properties: {
        rationale: {
          type: 'string',
          description: 'Why split, and how the pieces fit together (markdown, short). Lower-value ideas you left out go here, one line each under "Also considered".',
        },
        subtasks: {
          type: 'array',
          minItems: 2,
          maxItems: SPLIT_MAX,
          description: `At most ${SPLIT_MAX}, most valuable first.`,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              prompt: { type: 'string', description: 'Self-contained instructions including relevant findings; the subtask agent has no access to this conversation.' },
              recommended: { type: 'boolean', description: 'Starts ticked in the review. If none are recommended, all start ticked.' },
            },
            required: ['title', 'prompt'],
          },
        },
      },
      required: ['rationale', 'subtasks'],
    },
  },
  {
    name: 'permission_prompt',
    description: 'Internal: asks the user on the board whether a tool call may run.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
    },
  },
].map((tool) => ({ ...tool, _meta: { 'anthropic/alwaysLoad': true } })); // never hide these behind tool search

// ---------- database writes (mirror server/db.ts: every task change bumps rev) ----------

function updateTask(fields) {
  const keys = Object.keys(fields);
  const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?', 'rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM tasks)'];
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), Date.now(), taskId);
}
const addEvent = (kind, text) =>
  db.prepare('INSERT INTO events (task_id, ts, kind, text) VALUES (?, ?, ?, ?)').run(taskId, Date.now(), kind, text);

// ---------- permissions ----------

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'WebSearch', 'WebFetch', 'Task', 'Agent',
]);

const MULTI_COMMAND_TOOLS = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'python', 'python3', 'py', 'cargo', 'go', 'docker', 'gh',
]);
// Tools that run another command: a rule only ever covers the exact command line.
const WRAPPER_TOOLS = new Set(['bash', 'sh', 'env', 'sudo', 'xargs', 'eval', 'exec', 'pwsh', 'powershell', 'cmd']);

/**
 * The "Always allow" rule a tool call would create, or null when none should be offered.
 * Keep identical to allowKey in server/tasks.ts.
 * Bash rules are scoped to the command's first word, or first two for multi-command tools
 * (so allowing `git status` doesn't allow `git push`). Commands with shell control or
 * substitution never get a rule: `cd x && rm -rf ~` must not ride on a `cd` rule.
 */
function allowKey(toolName, input) {
  if (toolName !== 'Bash' || typeof input.command !== 'string') return toolName;
  const command = input.command.trim();
  if (!command || /[&|;<>`\n\r]|\$\(/.test(command)) return null;
  const words = command.split(/\s+/);
  const tool = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (words[0].includes('=') || WRAPPER_TOOLS.has(tool)) return `Bash:${words.join(' ')}`;
  if (!MULTI_COMMAND_TOOLS.has(tool)) return `Bash:${words[0]}`;
  // `git -C dir push` or bare `git`: no safe subcommand to scope on, so match exactly.
  if (words.length < 2 || words[1].startsWith('-')) return `Bash:${words.join(' ')}`;
  return `Bash:${words[0]} ${words[1]}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestPermission(toolName, input) {
  const allow = { behavior: 'allow', updatedInput: input };
  const project = db.prepare('SELECT p.always_allow FROM projects p JOIN tasks t ON t.project_id = p.id WHERE t.id = ?').get(taskId);
  const alwaysAllow = project ? JSON.parse(project.always_allow) : [];
  if (READ_ONLY_TOOLS.has(toolName) || toolName.startsWith('mcp__tcc__') || alwaysAllow.includes(allowKey(toolName, input) ?? '')) {
    return allow;
  }

  const id = randomUUID();
  db.prepare('INSERT INTO permissions (id, task_id, tool_name, input, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, taskId, toolName, JSON.stringify(input), Date.now());
  updateTask({}); // let the board know a card changed

  // The answer arrives through the database, so it survives board restarts.
  for (;;) {
    const row = db.prepare('SELECT status, message FROM permissions WHERE id = ?').get(id);
    if (row && row.status !== 'pending') {
      return row.status === 'deny' ? { behavior: 'deny', message: row.message || 'The user denied this action.' } : allow;
    }
    await sleep(500);
  }
}

// ---------- tools ----------

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const retryError = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

/** Models occasionally send arrays as JSON strings. */
function list(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

async function callTool(name, args) {
  switch (name) {
    case 'report_checkpoint': {
      const summary = String(args.summary ?? '').trim();
      if (!summary) return retryError('summary is required. Call report_checkpoint again with summary and options filled in.');
      if (summary.length > SUMMARY_MAX) {
        return retryError(
          `summary is ${summary.length} characters; the limit is ${SUMMARY_MAX}. Rewrite it as a 2-3 sentence TL;DR and move the rest into details, then call report_checkpoint again.`,
        );
      }
      const details = String(args.details ?? '').trim();
      const options = list(args.options)
        .map((o) => (typeof o === 'string' ? { label: o } : o))
        .filter((o) => o?.label)
        .map(({ label, detail, action }) => ({
          label: String(label),
          ...(detail && { detail: String(detail) }),
          ...(BOARD_ACTIONS.includes(action) && { action }),
        }))
        .slice(0, 4);
      updateTask({ checkpoint: JSON.stringify({ summary, ...(details && { details }), options, done: Boolean(args.done) }) });
      addEvent('checkpoint', details ? `${summary}\n\n${details}` : summary);
      return text("Checkpoint shown to the user. End your turn now; their reply will arrive as the next message.");
    }
    case 'propose_split': {
      const subtasks = list(args.subtasks)
        .filter((s) => s?.title && s?.prompt)
        .map(({ title, prompt, recommended }) => ({ title: String(title), prompt: String(prompt), ...(recommended === true && { recommended }) }));
      if (subtasks.length < 2) {
        return retryError('propose_split needs a rationale and at least 2 subtasks, each with title and prompt. Call it again with those filled in.');
      }
      if (subtasks.length > SPLIT_MAX) {
        return retryError(
          `You proposed ${subtasks.length} subtasks; the limit is ${SPLIT_MAX}. Keep the most valuable ones, list the rest in the rationale as one line each under "Also considered", then call propose_split again.`,
        );
      }
      const rationale = String(args.rationale ?? '');
      updateTask({ split: JSON.stringify({ rationale, subtasks }) });
      addEvent('split', `${rationale}\n\n${subtasks.map((s) => `- ${s.title}`).join('\n')}`);
      return text('Split proposal shown to the user. End your turn now.');
    }
    case 'permission_prompt':
      return text(JSON.stringify(await requestPermission(String(args.tool_name), args.input ?? {})));
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

// ---------- JSON-RPC over stdio ----------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  if (msg.id === undefined) return; // notification
  const ok = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  try {
    switch (msg.method) {
      case 'initialize':
        return ok({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'turtle-command-center', version: '0.2.0' },
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call':
        return ok(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
      default:
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Don't await: a permission prompt can wait for minutes while other requests proceed.
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  })
  // The session ended (or was stopped); don't linger polling the database.
  .on('close', () => process.exit(0));

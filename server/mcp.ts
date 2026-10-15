import type { Context } from 'hono';
import { getTask } from './db.ts';
import { recordCheckpoint, recordSplit, requestPermission } from './tasks.ts';

/**
 * A minimal stateless MCP server (Streamable HTTP, JSON responses) mounted at /mcp/:taskId.
 * The task id in the URL tells us which board card a session belongs to.
 */

const TOOLS = [
  {
    name: 'report_checkpoint',
    description:
      'Report back to the user on the command-center board. Call exactly once at the end of every turn, then stop. ' +
      'The user sees only this summary and picks one of the options (or types a reply).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Markdown, 2-6 short sentences or bullets. Lead with the outcome or decision needed.' },
        options: {
          type: 'array',
          maxItems: 4,
          description: 'One-click replies. The label is sent back verbatim as the user message. Recommended first.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Self-contained instruction, e.g. "Go with approach A: patch the parser (Recommended)"' },
              detail: { type: 'string', description: 'Optional one-line tradeoff shown under the button' },
            },
            required: ['label'],
          },
        },
        done: { type: 'boolean', description: 'True when the task is complete and nothing more is needed.' },
      },
      required: ['summary', 'options'],
    },
  },
  {
    name: 'propose_split',
    description:
      'Propose splitting this task into parallel subtasks when it is too big for one session. ' +
      'Each subtask runs in its own session and git worktree. Call instead of report_checkpoint, then stop.',
    inputSchema: {
      type: 'object',
      properties: {
        rationale: { type: 'string', description: 'Why split, and how the pieces fit together (markdown, short).' },
        subtasks: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              prompt: { type: 'string', description: 'Self-contained instructions including relevant findings; the subtask agent has no access to this conversation.' },
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

const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
const retryError = (t: string) => ({ content: [{ type: 'text', text: t }], isError: true });

/** Models occasionally send arrays as JSON strings. */
function list(value: unknown): any[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

async function callTool(taskId: number, name: string, args: any) {
  switch (name) {
    case 'report_checkpoint': {
      const summary = String(args.summary ?? '').trim();
      if (!summary) return retryError('summary is required. Call report_checkpoint again with summary and options filled in.');
      const options = list(args.options)
        .map((o) => (typeof o === 'string' ? { label: o } : o))
        .filter((o) => o?.label)
        .slice(0, 4);
      recordCheckpoint(taskId, { summary, options, done: Boolean(args.done) });
      return text("Checkpoint shown to the user. End your turn now; their reply will arrive as the next message.");
    }
    case 'propose_split': {
      const subtasks = list(args.subtasks).filter((s) => s?.title && s?.prompt);
      if (subtasks.length < 2) {
        return retryError('propose_split needs a rationale and at least 2 subtasks, each with title and prompt. Call it again with those filled in.');
      }
      recordSplit(taskId, { rationale: String(args.rationale ?? ''), subtasks });
      return text('Split proposal shown to the user. End your turn now.');
    }
    case 'permission_prompt': {
      const decision = await requestPermission(taskId, String(args.tool_name), args.input ?? {});
      return text(JSON.stringify(decision));
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

async function handleMessage(taskId: number, msg: any) {
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'turtle-command-center', version: '0.1.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      if (process.env.TCC_DEBUG_MCP) console.log('[mcp]', taskId, JSON.stringify(msg.params));
      try {
        return ok(await callTool(taskId, msg.params?.name, msg.params?.arguments ?? {}));
      } catch (err: any) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } };
      }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

export async function mcpHandler(c: Context) {
  const taskId = Number(c.req.param('taskId'));
  if (!getTask(taskId)) return c.json({ error: 'unknown task' }, 404);
  const body = await c.req.json();
  const messages: any[] = Array.isArray(body) ? body : [body];
  const requests = messages.filter((m) => m.id !== undefined && m.method);
  if (requests.length === 0) return c.body(null, 202); // notifications only
  const responses = await Promise.all(requests.map((m) => handleMessage(taskId, m)));
  return c.json(Array.isArray(body) ? responses : responses[0]);
}

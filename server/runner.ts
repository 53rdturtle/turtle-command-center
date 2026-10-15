import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLAUDE_BIN, DATA_DIR } from './config.ts';

export interface RunRequest {
  taskId: number;
  cwd: string;
  prompt: string;
  sessionId: string;
  resume: boolean;
  model: string;
  permissionMode: string;
  dbPath: string;
  systemPrompt: string;
  /** Long-lived token from `claude setup-token`, selecting the account to bill; null uses the CLI's own login. */
  oauthToken: string | null;
}

/** Everything needed to find a run again after the server restarts. Stored as JSON on the task. */
export interface RunRef {
  pid: number;
  log: string;
  errLog: string;
}

export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; text: string }
  /** Tokens in the main conversation as of its latest model call. */
  | { kind: 'context'; tokens: number }
  | { kind: 'usage'; usage: AccountUsage };

/** A subscription usage window: fraction used (0-1) and when it resets (ms). */
export interface UsageWindow { utilization: number; resetsAt: number }
/** Subscription usage the CLI reports alongside each API call. */
export interface AccountUsage { fiveHour?: UsageWindow; sevenDay?: UsageWindow }

export interface RunResult {
  costUsd: number;
  /** Size of the model's context window, when the run reported it. */
  contextWindow: number | null;
  resultText: string;
  isError: boolean;
  usageLimited: boolean;
  /** The process ended without reporting a result (crashed, killed, or the machine restarted). */
  interrupted: boolean;
}

export interface RunHandlers {
  onEvent(e: AgentEvent): void;
  /** Output up to this byte offset has been handled; persist it to resume from after a restart. */
  onProgress(offset: number): void;
  onExit(result: RunResult): void;
}

/**
 * The seam for moving to the cloud later. Runs outlive the server: `start` launches one,
 * and `attach` (re)connects to it from a saved offset, e.g. after a server restart.
 */
export interface AgentRunner {
  start(req: RunRequest): RunRef;
  attach(ref: RunRef, offset: number, handlers: RunHandlers): { detach(): void };
  /** Resolves once the run's process has exited. */
  stop(ref: RunRef): Promise<void>;
}

const LIMIT_PATTERN = /usage limit|limit reached|rate limit|resets? (at|in)|out of (extra )?usage/i;
const MCP_SCRIPT = resolve(import.meta.dirname, 'mcp-stdio.mjs');
const POLL_MS = 300;

function describeTool(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  const detail = typeof pick === 'string' ? pick : '';
  return detail ? `${name}: ${detail.length > 200 ? detail.slice(0, 200) + '…' : detail}` : name;
}

const usageWindow = (w: any): UsageWindow | undefined =>
  typeof w?.utilization === 'number' && typeof w?.resetsAt === 'number'
    ? { utilization: w.utilization, resetsAt: w.resetsAt * 1000 }
    : undefined;

/** Reads a `rate_limit_event` line. Older CLIs report only the window that's closest to its limit. */
function parseUsage(info: any): AccountUsage | undefined {
  const windows = info?.unifiedWindows ?? (info?.rateLimitType ? { [info.rateLimitType]: info } : {});
  const usage = { fiveHour: usageWindow(windows.five_hour), sevenDay: usageWindow(windows.seven_day) };
  return usage.fiveHour || usage.sevenDay ? usage : undefined;
}

/** The result's per-model usage includes each model's window; the main model's is the largest. */
function contextWindowOf(modelUsage: Record<string, { contextWindow?: number }> | undefined): number | null {
  const sizes = Object.values(modelUsage ?? {}).map((u) => u.contextWindow ?? 0);
  return Math.max(0, ...sizes) || null;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Drives the logged-in `claude` CLI in print mode, so usage counts against the user's subscription.
 * Each run is a detached process writing stream-json to a log file, so it keeps going when the server restarts.
 */
export class CliRunner implements AgentRunner {
  start(req: RunRequest): RunRef {
    const dir = join(DATA_DIR, 'runs');
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `task-${req.taskId}-${Date.now()}`);
    const files = { prompt: `${base}.prompt.txt`, mcp: `${base}.mcp.json`, log: `${base}.jsonl`, errLog: `${base}.err.log` };

    writeFileSync(files.prompt, req.prompt);
    writeFileSync(files.mcp, JSON.stringify({
      mcpServers: {
        tcc: {
          type: 'stdio',
          command: process.execPath,
          args: ['--no-warnings', MCP_SCRIPT],
          env: { TCC_DB: req.dbPath, TCC_TASK_ID: String(req.taskId) },
          alwaysLoad: true,
        },
      },
    }));

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', req.model,
      '--permission-mode', req.permissionMode,
      '--mcp-config', files.mcp,
      '--permission-prompt-tool', 'mcp__tcc__permission_prompt',
      '--allowedTools', 'mcp__tcc__report_checkpoint,mcp__tcc__propose_split',
      '--append-system-prompt', req.systemPrompt,
      ...(req.resume ? ['--resume', req.sessionId] : ['--session-id', req.sessionId]),
    ];

    const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 60 * 60 * 1000) };
    // An API key in the environment would bill the key instead of the subscription login.
    delete env.ANTHROPIC_API_KEY;
    if (req.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = req.oauthToken;

    // Windows reports a missing cwd as "spawn claude ENOENT", which would send you looking for the wrong problem.
    if (!existsSync(req.cwd)) throw new Error(`The task's working directory no longer exists: ${req.cwd}`);

    const stdin = openSync(files.prompt, 'r');
    const stdout = openSync(files.log, 'a');
    const stderr = openSync(files.errLog, 'a');
    try {
      const child = spawn(CLAUDE_BIN, args, {
        cwd: req.cwd, env, detached: true, windowsHide: true, stdio: [stdin, stdout, stderr],
      });
      // Listen before anything can throw: an unhandled 'error' event (e.g. ENOENT) crashes the whole server.
      child.on('error', () => {}); // exit is detected by polling the pid
      if (!child.pid) throw new Error(`Failed to start ${CLAUDE_BIN}. Is it installed and on PATH?`);
      child.unref();
      return { pid: child.pid, log: files.log, errLog: files.errLog };
    } finally {
      [stdin, stdout, stderr].forEach((fd) => closeSync(fd));
    }
  }

  attach(ref: RunRef, startOffset: number, handlers: RunHandlers) {
    let offset = startOffset;
    let result: Omit<RunResult, 'interrupted' | 'usageLimited'> | undefined;
    let finished = false;
    let lastContext = -1;

    /** Handles complete lines past `offset`. The result line is never counted as handled until the
     *  process exits, so a restart in between reads it again. */
    const drain = () => {
      if (!existsSync(ref.log)) return;
      const size = statSync(ref.log).size;
      if (size <= offset) return;
      const fd = openSync(ref.log, 'r');
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);

      let pos = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl === -1) break;
        let msg: any;
        try {
          msg = JSON.parse(buf.subarray(pos, nl).toString('utf8'));
        } catch {
          msg = null;
        }
        if (msg?.type === 'result') {
          result = {
            costUsd: msg.total_cost_usd ?? 0,
            contextWindow: contextWindowOf(msg.modelUsage),
            resultText: typeof msg.result === 'string' ? msg.result : '',
            isError: Boolean(msg.is_error),
          };
          break;
        }
        if (msg?.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          handlers.onEvent({ kind: 'session', sessionId: msg.session_id });
        } else if (msg?.type === 'rate_limit_event') {
          const usage = parseUsage(msg.rate_limit_info);
          if (usage) handlers.onEvent({ kind: 'usage', usage });
        } else if (msg?.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) handlers.onEvent({ kind: 'assistant', text: block.text });
            if (block.type === 'tool_use') handlers.onEvent({ kind: 'tool', text: describeTool(block.name, block.input ?? {}) });
          }
          // Subagent messages carry a parent_tool_use_id and have their own, separate context.
          const usage = msg.message?.usage;
          if (usage && !msg.parent_tool_use_id) {
            const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
              + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
            if (tokens !== lastContext) handlers.onEvent({ kind: 'context', tokens });
            lastContext = tokens;
          }
        }
        pos = nl + 1;
      }
      if (pos > 0) {
        offset += pos;
        handlers.onProgress(offset);
      }
    };

    const tick = () => {
      if (finished) return;
      try {
        drain();
        if (isAlive(ref.pid)) return;
        drain(); // pick up anything written just before exit
        finished = true;
        clearInterval(timer);
        if (result) {
          handlers.onExit({ ...result, interrupted: false, usageLimited: result.isError && LIMIT_PATTERN.test(result.resultText) });
        } else {
          const errText = existsSync(ref.errLog) ? readFileSync(ref.errLog, 'utf8').trim() : '';
          handlers.onExit({
            costUsd: 0,
            contextWindow: null,
            resultText: errText || 'The agent process exited without reporting a result.',
            isError: true,
            usageLimited: LIMIT_PATTERN.test(errText),
            interrupted: true,
          });
        }
      } catch (err) {
        console.error(`[runner] pid ${ref.pid}:`, err);
      }
    };

    const timer = setInterval(tick, POLL_MS);
    tick();
    return {
      detach: () => {
        finished = true;
        clearInterval(timer);
      },
    };
  }

  async stop(ref: RunRef) {
    if (!isAlive(ref.pid)) return;
    if (process.platform === 'win32') {
      // Kill the whole tree: the CLI plus its tool subprocesses and MCP server.
      execFile('taskkill', ['/pid', String(ref.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try {
        process.kill(-ref.pid, 'SIGTERM'); // detached: the run is its own process group
      } catch {
        /* already gone */
      }
    }
    for (let i = 0; i < 50 && isAlive(ref.pid); i++) await new Promise((r) => setTimeout(r, 100));
  }
}

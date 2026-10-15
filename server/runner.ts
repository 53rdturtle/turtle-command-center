import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CLAUDE_BIN, DATA_DIR } from './config.ts';

export interface RunRequest {
  taskId: number;
  cwd: string;
  prompt: string;
  sessionId: string;
  resume: boolean;
  model: string;
  permissionMode: string;
  mcpUrl: string;
  systemPrompt: string;
}

export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; text: string };

export interface RunResult {
  sessionId?: string;
  costUsd: number;
  resultText: string;
  isError: boolean;
  usageLimited: boolean;
}

export interface RunHandle {
  done: Promise<RunResult>;
  stop(): void;
}

/** The seam for moving to the cloud later: swap this for an SDK- or container-backed runner. */
export interface AgentRunner {
  run(req: RunRequest, onEvent: (e: AgentEvent) => void): RunHandle;
}

const LIMIT_PATTERN = /usage limit|limit reached|rate limit|resets? (at|in)|out of (extra )?usage/i;

function describeTool(name: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  const detail = typeof pick === 'string' ? pick : '';
  return detail ? `${name}: ${detail.length > 200 ? detail.slice(0, 200) + '…' : detail}` : name;
}

/** Drives the logged-in `claude` CLI in print mode, so usage counts against the user's subscription. */
export class CliRunner implements AgentRunner {
  run(req: RunRequest, onEvent: (e: AgentEvent) => void): RunHandle {
    const cfgDir = join(DATA_DIR, 'mcp');
    mkdirSync(cfgDir, { recursive: true });
    const mcpConfig = join(cfgDir, `task-${req.taskId}.json`);
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { tcc: { type: 'http', url: req.mcpUrl, alwaysLoad: true } } }));

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', req.model,
      '--permission-mode', req.permissionMode,
      '--mcp-config', mcpConfig,
      '--permission-prompt-tool', 'mcp__tcc__permission_prompt',
      '--allowedTools', 'mcp__tcc__report_checkpoint,mcp__tcc__propose_split',
      '--append-system-prompt', req.systemPrompt,
      ...(req.resume ? ['--resume', req.sessionId] : ['--session-id', req.sessionId]),
    ];

    const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: String(24 * 60 * 60 * 1000) };
    // An API key in the environment would bill the key instead of the subscription login.
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(CLAUDE_BIN, args, { cwd: req.cwd, env, windowsHide: true });
    child.stdin.end(req.prompt);

    let sessionId: string | undefined;
    let result: Partial<RunResult> | undefined;
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.session_id && msg.session_id !== sessionId) {
        sessionId = msg.session_id;
        onEvent({ kind: 'session', sessionId: msg.session_id });
      }
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) onEvent({ kind: 'assistant', text: block.text });
          if (block.type === 'tool_use') onEvent({ kind: 'tool', text: describeTool(block.name, block.input ?? {}) });
        }
      } else if (msg.type === 'result') {
        result = {
          costUsd: msg.total_cost_usd ?? 0,
          resultText: typeof msg.result === 'string' ? msg.result : '',
          isError: Boolean(msg.is_error),
        };
      }
    });

    const done = new Promise<RunResult>((resolve) => {
      child.on('error', (err) =>
        resolve({ sessionId, costUsd: 0, resultText: `Failed to start claude: ${err.message}`, isError: true, usageLimited: false }));
      child.on('close', (code) => {
        const isError = result?.isError ?? code !== 0;
        const resultText = result?.resultText || stderr.trim() || (code !== 0 ? `claude exited with code ${code}` : '');
        resolve({
          sessionId,
          costUsd: result?.costUsd ?? 0,
          resultText,
          isError,
          usageLimited: isError && LIMIT_PATTERN.test(resultText),
        });
      });
    });

    return { done, stop: () => child.kill() };
  }
}

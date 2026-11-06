import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface, type Interface } from 'node:readline';
import { ANTHROPIC } from './anthropic.ts';
import { OPENAI } from './openai.ts';
import { preparePaid, type PaidEngine, type PreparedPaid } from './paid.ts';

// Adding a paid provider requires its adapter and this registration, not another spend path.
export const PAID_ENGINES = { anthropic: ANTHROPIC, openai: OPENAI } satisfies Record<string, PaidEngine>;
export const ENGINE_NAMES = ['pipe', ...Object.keys(PAID_ENGINES)];
export type PaidEngineName = keyof typeof PAID_ENGINES;
export function paidEngine(name: string): PaidEngine | undefined {
  return Object.hasOwn(PAID_ENGINES, name) ? PAID_ENGINES[name as PaidEngineName] : undefined;
}

export type AskOptions = {
  engine: 'fake' | 'pipe' | PaidEngineName;
  family: 'claude' | 'codex';
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeout: number;
  /** The most the answer may use, for the API-key engine (the pipe sets its own). */
  maxTokens: number;
  question: string;
};

/**
 * refused: the engine certainly did not take the job (it can be sent again). uncertain: the job may exist (the submit
 * was sent but its answer was lost). Reasons are fixed words: never a path, a prompt or a command's output.
 */
export type SubmitResult =
  | { outcome: 'accepted'; requestId: string; wait: () => Promise<WaitResult>; abandon: () => void }
  | { outcome: 'refused'; why: string }
  | { outcome: 'uncertain'; why: string };

export type WaitResult =
  | { status: 'completed'; answer: string; truncated?: boolean }
  | { status: 'failed'; why: string }
  | { status: 'uncertain'; why: string };

/** `onSent` is called just before the job is handed over: after it, an interruption means "may have run". */
export type SubmitHooks = { onSent: () => void };

export async function submitJob(options: AskOptions, hooks: SubmitHooks, paid?: PreparedPaid): Promise<SubmitResult> {
  if (options.engine === 'fake') return submitFake(hooks);
  const engine = paidEngine(options.engine);
  if (engine) return (paid ?? preparePaid(engine, options)).submit(hooks);
  return submitPipe(options, hooks);
}

function submitFake(hooks: SubmitHooks): SubmitResult {
  const fail = process.env.HUNTAWAY_FAKE_FAIL;
  if (fail === 'submit') return { outcome: 'refused', why: 'the fake engine refused it' };
  hooks.onSent();
  return {
    outcome: 'accepted',
    requestId: 'fake',
    abandon: () => {},
    wait: async () => fail === 'wait'
      ? { status: 'uncertain', why: 'the fake engine lost the answer' }
      : { status: 'completed', answer: process.env.HUNTAWAY_FAKE_ANSWER ?? 'ok' },
  };
}

/** The pipe's MCP command: HUNTAWAY_PIPE_CMD (a JSON array), else the `pipe` server in ~/.claude.json. */
function pipeCommand(): [string, string[]] | null {
  const configured = process.env.HUNTAWAY_PIPE_CMD;
  try {
    if (configured) {
      const parsed = JSON.parse(configured);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === 'string')) {
        return [parsed[0], parsed.slice(1)];
      }
      return null;
    }
    const conf = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))?.mcpServers?.pipe;
    if (conf && typeof conf.command === 'string' && (conf.args === undefined || Array.isArray(conf.args))) {
      return [conf.command, (conf.args ?? []).map(String)];
    }
  } catch {
    // fall through: no usable command
  }
  return null;
}

/** Whether a pipe command is configured, for `doctor`: it is never run here, and its path is never shown. */
export function pipeConfigured(): boolean {
  return pipeCommand() !== null;
}

/** A tool result's text is a line of prose, then a JSON object. */
function toolJson(result: unknown): Record<string, unknown> | null {
  const text = (result as { content?: { text?: unknown }[] } | null)?.content?.[0]?.text;
  if (typeof text !== 'string' || !text.includes('{')) return null;
  try {
    const doc = JSON.parse(text.slice(text.indexOf('{')));
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/**
 * The pipe runs work on the owner's subscriptions. An API key in Huntaway's environment (set for `--engine anthropic`)
 * must never reach it: the official CLIs behind the pipe would bill that key instead of the subscription.
 */
export function withoutApiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!API_BILLING_VARS.has(name)) out[name] = value;
  return out;
}

// The API key variables of the official CLIs (they switch them to API billing). Subscription sign-ins stay untouched.
const API_BILLING_VARS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']);

/** Every pipe connection still open, so a signal handler can close them all before exiting. */
const liveClients = new Set<McpClient>();

export function closeAllClients(): void {
  for (const client of liveClients) client.close();
}

class McpClient {
  private child: ChildProcess;
  private lines: Interface;
  private nextId = 1;
  private pending = new Map<number, (message: Record<string, unknown> | null) => void>();
  private closed = false;

  constructor(command: string, args: string[]) {
    // stderr is ignored so a chatty server can never fill a pipe nobody reads and stall.
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false, env: withoutApiKeys(process.env) });
    liveClients.add(this);
    this.child.on('error', () => this.fail());
    this.child.on('close', () => this.fail());
    this.child.stdin?.on('error', () => this.fail());
    this.lines = createInterface({ input: this.child.stdout! });
    this.lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
      if (typeof message.method === 'string') {
        // A request or notification from the server, never a response to us. Answer pings; ignore the rest.
        if (message.method === 'ping' && message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result: {} });
        return;
      }
      const resolve = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (resolve) {
        this.pending.delete(message.id as number);
        resolve(message);
      }
    });
  }

  private fail(): void {
    this.closed = true;
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve(null);
    }
  }

  /** The JSON-RPC response, or null on timeout or a lost connection. */
  call(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown> | null> {
    if (this.closed) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin!.write(JSON.stringify(message) + '\n');
    } catch {
      this.fail();
    }
  }

  notify(method: string): void {
    this.send({ jsonrpc: '2.0', method });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    liveClients.delete(this);
    this.fail();                                     // resolve anything still waiting; no call can start after this
    this.lines.close();
    this.child.stdin?.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    }, 2000);
    timer.unref();
  }
}

/** How long a submit may take to be confirmed; independent of how long the answer may take. */
function submitTimeoutMs(): number {
  const n = Number(process.env.HUNTAWAY_SUBMIT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 100 && n <= 120_000 ? n : 30_000;
}

async function submitPipe(options: AskOptions, hooks: SubmitHooks): Promise<SubmitResult> {
  const command = pipeCommand();
  if (command === null) return { outcome: 'refused', why: 'no pipe command is configured' };
  let client: McpClient;
  try {
    client = new McpClient(command[0], command[1]);
  } catch {
    return { outcome: 'refused', why: 'the pipe command could not be started' };
  }
  const init = await client.call('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'huntaway', version: '0' },
  }, 15_000);
  if (init === null || init.error !== undefined) {
    client.close();
    return { outcome: 'refused', why: 'the pipe could not be reached' };
  }
  client.notify('notifications/initialized');
  if (client.isClosed) {
    // The pipe went away before the submit could be written: nothing was sent.
    client.close();
    return { outcome: 'refused', why: 'the pipe closed before the request was sent' };
  }
  hooks.onSent();
  const submitted = await client.call('tools/call', {
    name: 'pipe_submit',
    arguments: {
      provider: options.family, model: options.model, effort: options.effort, reason: 'huntaway ask',
      prompt: options.question, kind: 'chat', mutating: false, priority: 'interactive', project: 'huntaway',
      requester: 'huntaway ask',
    },
  }, submitTimeoutMs());
  if (submitted === null) {
    // The submit was sent and no answer came back: the pipe may have taken it.
    client.close();
    return { outcome: 'uncertain', why: 'the pipe did not confirm the submit' };
  }
  if (submitted.error !== undefined) {
    client.close();
    // A protocol error (bad method or arguments) certainly refused it; an internal error may have queued it first.
    const code = (submitted.error as { code?: unknown })?.code;
    return code === -32601 || code === -32602 || code === -32700 || code === -32600
      ? { outcome: 'refused', why: 'the pipe refused the request' }
      : { outcome: 'uncertain', why: 'the pipe reported an internal error' };
  }
  const flagged = submitted.result as { isError?: unknown; content?: { text?: unknown }[] } | undefined;
  if (flagged?.isError === true) {
    // A tool error is a definite refusal: nothing was queued. Pass on the pipe's own short reason when it is plain
    // words (e.g. which models exist), never anything path-like.
    client.close();
    const text = flagged.content?.[0]?.text;
    const plain = typeof text === 'string' && /^[A-Za-z0-9 "',.;:()_-]{1,160}$/.test(text) ? `: ${text}` : '';
    return { outcome: 'refused', why: `the pipe refused the request${plain}` };
  }
  const doc = toolJson(submitted.result);
  const request = doc?.request as { id?: unknown } | undefined;
  if (doc === null) {
    client.close();
    return { outcome: 'uncertain', why: 'the pipe gave an unreadable confirmation' };
  }
  if (typeof request?.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.id)) {
    // A readable success without a usable id: the pipe may still have queued it.
    client.close();
    return { outcome: 'uncertain', why: 'the pipe confirmed without a request id' };
  }
  const requestId = request.id;
  return {
    outcome: 'accepted',
    requestId,
    abandon: () => client.close(),
    wait: async () => {
      const deadline = Date.now() + options.timeout * 1000;
      let polls = 0;
      try {
        for (;;) {
          const remaining = Math.ceil((deadline - Date.now()) / 1000);
          if (remaining <= 0) return { status: 'uncertain', why: 'it was still running at the time limit; the pipe may still finish it' };
          const waitSeconds = Math.min(remaining, 540);
          const waited = await client.call('tools/call', {
            name: 'pipe_wait', arguments: { id: requestId, timeoutSeconds: waitSeconds },
          }, (waitSeconds + 30) * 1000);
          if (waited === null) {
            return { status: 'uncertain', why: client.isClosed ? 'the connection to the pipe was lost' : 'the pipe did not answer in time' };
          }
          if (waited.error !== undefined || (waited.result as { isError?: unknown } | undefined)?.isError === true) {
            return { status: 'uncertain', why: 'the pipe could not report on this request' };
          }
          const state = (toolJson(waited.result)?.request as { id?: unknown; state?: unknown; result?: unknown } | undefined);
          if (state === undefined) return { status: 'uncertain', why: 'the pipe gave an unreadable report' };
          if (state.id !== requestId) {
            // The pipe always names the request it reports on; anything else is not our answer.
            const why = state.id === undefined
              ? 'the pipe\'s report did not name this request'
              : 'the pipe reported on a different request';
            return { status: 'uncertain', why };
          }
          if (state.state === 'completed') {
            return typeof state.result === 'string'
              ? { status: 'completed', answer: state.result }
              : { status: 'uncertain', why: 'the pipe finished without an answer' };
          }
          // failed and cancelled are the pipe's own final word: the job ended and no answer will come, so asking
          // again is the honest next step. interrupted is not final: the pipe lost the job mid-run (for example it
          // restarted) and cannot say whether it finished, so the answer may still exist.
          if (state.state === 'failed' || state.state === 'cancelled') {
            return { status: 'failed', why: `the pipe reported it ${state.state}` };
          }
          if (state.state === 'interrupted') {
            return { status: 'uncertain', why: 'the pipe reported it interrupted' };
          }
          if (state.state !== 'queued' && state.state !== 'running' && state.state !== 'dispatched') {
            return { status: 'uncertain', why: 'the pipe reported a state Huntaway does not know' };
          }
          polls += 1;
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 1000 * polls)));
        }
      } finally {
        client.close();
      }
    },
  };
}

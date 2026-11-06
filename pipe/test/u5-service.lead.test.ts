/**
 * Acceptance grader, lane U5: the running pipe (lead-authored; the implementation lane must not
 * edit it). End to end through the real modules: HTTP in, probes, plan, runner, record, out.
 * Fake official CLIs replay the U3/U4 captures. Contract (docs/PLAN.md U5, the U5 brief):
 *   startPipe(config) => { url, stop() }, HTTP on 127.0.0.1 with one bearer token;
 *   POST /v1/requests, GET /v1/requests/:id, GET /v1/accounts; `node src/mcp.ts` with
 *   PIPE_URL and PIPE_TOKEN serves MCP on stdio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPipe } from '../src/service.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
const POLICY = {
  claude: { models: { opus: 'default', fable: 'hard', 'claude-opus-5-5': 'hard' }, efforts: ['low', 'medium', 'high', 'max'] },
  codex: { models: { 'gpt-6-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'ultra'] },
};

/** A capture's lines with the CLI's init reporting `model` (the success capture ran Sonnet). */
const withModel = (jsonl: string, model: string) => jsonl.trim().split('\n').map((l) => {
  const o = JSON.parse(l); if (o.type === 'system' && o.subtype === 'init') o.model = model; return JSON.stringify(o);
}).join('\n') + '\n';

/**
 * One fake `claude`: answers the probes from the U4 captures (with resets moved to after now, so
 * the readings never go stale), and runs a job from the U3 capture. `limitFirst`: the first job hits
 * a five-hour limit that resets `limitFirst` ms later; later jobs succeed.
 */
function fakeClaude(o: { jobDelayMs?: number; initModel?: string; limitFirst?: number; lingerMs?: number; usageFailFirst?: number } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u5-claude-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    version: u4('claude-version').stdout, auth: u4('claude-auth-status.signed-in').stdout,
    usage: u4('claude-usage.signed-in').stdout, job: withModel(readFileSync(new URL('claude-success.jsonl', FIX), 'utf8'), o.initModel ?? 'claude-opus-5-5'),
    limit: withModel(readFileSync(new URL('claude-weekly-limit.jsonl', FIX), 'utf8'), o.initModel ?? 'claude-opus-5-5'),
    jobDelayMs: o.jobDelayMs ?? 0, limitFirst: o.limitFirst ?? null, lingerMs: o.lingerMs ?? 0, usageFailFirst: o.usageFailFirst ?? 0,
  }));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '--version') process.stdout.write(sc.version);
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.auth));
else if (a[0] === '-p' && a[1] === '/usage') {
  const uc = p.join(__dirname, 'usage-calls'); const u = fs.existsSync(uc) ? Number(fs.readFileSync(uc, 'utf8')) : 0; fs.writeFileSync(uc, String(u + 1));
  if (u < sc.usageFailFirst) { process.exitCode = 1; return; }
  const at = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return p.month + ' ' + p.day + ' at ' + p.hour + ':' + p.minute + p.dayPeriod.toLowerCase(); };
  // No backslashes here: this is a template literal, which would eat them.
  const NL = String.fromCharCode(10), RESET = new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m', 'u');
  const result = sc.usage.result.split(NL).map((l) => l.replace(RESET, 'resets ' + at(Date.now() + (l.startsWith('Current session') ? 3 : 96) * 3600000))).join(NL);
  process.stdout.write(JSON.stringify({ ...sc.usage, result }));
} else {
  try { fs.readFileSync(0); } catch {}
  const count = p.join(__dirname, 'jobs'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));
  if (sc.limitFirst !== null && n === 0) {
    const reset = Math.ceil((Date.now() + sc.limitFirst) / 1000);
    process.stdout.write(sc.limit.replace('"rateLimitType": "seven_day", "resetsAt": 1790000000', '"rateLimitType": "five_hour", "resetsAt": ' + reset)
      .replace('"rateLimitType":"seven_day","resetsAt":1790000000', '"rateLimitType":"five_hour","resetsAt":' + reset));
    process.exitCode = 1;
  } else setTimeout(() => { process.stdout.write(sc.job); if (sc.lingerMs) setTimeout(() => {}, sc.lingerMs); }, sc.jobDelayMs);
}
`);
  chmodSync(path, 0o755);
  return path;
}

async function pipe(options: { jobDelayMs?: number; maxConcurrency?: number; initModel?: string; limitFirst?: number; lingerMs?: number; usageFailFirst?: number; root?: string; probeIntervalMs?: number; probeRetryMs?: number; pinWaitMs?: number; cliOnPath?: boolean | 'bare' } = {}) {
  const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u5-')));
  const login = join(root, 'login-claude-a');
  mkdirSync(login, { recursive: true });
  const fake = fakeClaude(options);
  const handle = await startPipe({
    accounts: [{ id: 'claude-a', provider: 'claude', loginDir: login, fingerprint: sha8('<orgId>'), maxConcurrency: options.maxConcurrency ?? 1, enabled: true }],
    policy: POLICY,
    storePath: join(root, 'pipe.sqlite'),
    worktreeRoot: join(root, 'worktrees'),
    cli: options.cliOnPath === 'bare' ? { claude: 'claude' } : options.cliOnPath ? {} : { claude: fake },
    env: { PATH: `${options.cliOnPath ? `${join(fake, '..')}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN,
    port: 0,
    reachable: async () => true,
    tickMs: 100,
    probeIntervalMs: options.probeIntervalMs ?? 60_000,
    ...(options.pinWaitMs === undefined ? {} : { pinWaitMs: options.pinWaitMs }),
    ...(options.probeRetryMs === undefined ? {} : { probeRetryMs: options.probeRetryMs }),
  });
  const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  const jobsRun = () => { try { return Number(readFileSync(join(fake, '..', 'jobs'), 'utf8')); } catch { return 0; } };
  return { ...handle, call, root, jobsRun };
}
const ask = (over: Record<string, unknown> = {}) => ({ requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high',
  reason: 'a routine check', prompt: 'say OK', mutating: false, priority: 'interactive', ...over });
async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await get(); if (ok(v)) return v; if (Date.now() > end) assert.fail(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`); await new Promise((r) => setTimeout(r, 100)); }
}

test('G1 one token guards every route, and no answer echoes it', async () => {
  const p = await pipe();
  try {
    for (const token of [null, 'wrong-token']) {
      const r = await p.call('GET', '/v1/accounts', undefined, token);
      assert.equal(r.status, 401);
      assert.ok(!r.text.includes(TOKEN));
    }
    assert.equal((await p.call('GET', '/v1/accounts')).status, 200);
    assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+$/u, 'loopback only');
  } finally { await p.stop(); }
});

test('G2 a request goes in, runs on the account through its official CLI, and its result and record come out', async () => {
  const p = await pipe();
  try {
    const made = await p.call('POST', '/v1/requests', ask());
    assert.equal(made.status, 201, made.text);
    const id = made.json.request.id as string;
    const done = await until('the request completes', () => p.call('GET', `/v1/requests/${id}`), (r) => ['completed', 'failed'].includes(r.json.request?.state));
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(done.json.request.result, 'OK');
    const accounts = await p.call('GET', '/v1/accounts');
    assert.ok(Array.isArray(accounts.json.accounts) && accounts.json.accounts.some((a: any) => a.id === 'claude-a'), accounts.text);
  } finally { await p.stop(); }
});

test('G3 no silent default: a missing or unknown model or effort is refused with the options', async () => {
  const p = await pipe();
  try {
    const missing = await p.call('POST', '/v1/requests', ask({ model: undefined }));
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error?.code, 'choice_required');
    const unknown = await p.call('POST', '/v1/requests', ask({ model: 'claude-9' }));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error?.code, 'unknown_model');
    assert.ok(unknown.json.error.options.includes('opus'), unknown.text);
    const effort = await p.call('POST', '/v1/requests', ask({ effort: 'ultra' }));
    assert.equal(effort.status, 400);
    assert.equal(effort.json.error?.code, 'unsupported_effort');
  } finally { await p.stop(); }
});

test('G4 a busy account makes the next request wait, never fail, and it runs when the account frees (L1)', async () => {
  const p = await pipe({ jobDelayMs: 1_500 });
  try {
    const a = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
    const b = (await p.call('POST', '/v1/requests', ask({ prompt: 'say OK again' }))).json.request.id as string;
    const waiting = await until('the second waits', () => p.call('GET', `/v1/requests/${b}`), (r) => r.json.request?.state === 'queued' && r.json.request?.waiting !== null);
    assert.ok(waiting.json.request.waiting.reason.length > 0, 'why it waits is always answerable (L4)');
    for (const id of [a, b]) {
      const r = await until(`${id} completes`, () => p.call('GET', `/v1/requests/${id}`), (x) => ['completed', 'failed'].includes(x.json.request?.state), 20_000);
      assert.equal(r.json.request.state, 'completed', r.text);
    }
  } finally { await p.stop(); }
});

test('G5 the MCP tool requires an active choice of model and effort, and stdout carries only protocol frames', async () => {
  const p = await pipe();
  const mcp = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIPE_URL: p.url, PIPE_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const lines: string[] = [];
    let buf = '';
    mcp.stdout.setEncoding('utf8');
    mcp.stdout.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    const send = (m: unknown) => mcp.stdin.write(`${JSON.stringify(m)}\n`);
    const reply = (id: number) => until(`reply ${id}`, async () => lines.map((l) => JSON.parse(l)).find((m) => m.id === id), (m) => m !== undefined);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grader', version: '1' } } });
    await reply(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (await reply(2)).result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>;
    const submit = tools.find((t) => t.name === 'pipe_submit');
    assert.ok(submit, JSON.stringify(tools.map((t) => t.name)));
    for (const field of ['model', 'effort', 'reason', 'prompt']) assert.ok(submit.inputSchema.required?.includes(field), field);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pipe_submit', arguments: { provider: 'claude', effort: 'high', reason: 'x', prompt: 'say OK', kind: 'chat', mutating: false } } });
    const refused = await reply(3);
    assert.ok(refused.error || refused.result?.isError, 'no model: refused');
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pipe_submit', arguments: { provider: 'claude', model: 'opus', effort: 'high', reason: 'a routine check', prompt: 'say OK', kind: 'chat', mutating: false } } });
    const ok = await reply(4);
    assert.ok(!ok.error && !ok.result?.isError, JSON.stringify(ok));
    for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0', 'every stdout line is a protocol frame');
  } finally { mcp.kill(); await p.stop(); }
});

// ── Review round 1 (Sol and Opus on 1f46f6d) ───────────────────────────────

const settled = (p: Awaited<ReturnType<typeof pipe>>, id: string, ms = 20_000) =>
  until(`${id} settles`, () => p.call('GET', `/v1/requests/${id}`), (r) => ['completed', 'failed', 'cancelled'].includes(r.json.request?.state), ms);

test('G6 stopping the pipe mid-job is not a cancel: after a restart on the same store, the read-only request runs again and completes', async () => {
  const first = await pipe({ jobDelayMs: 5_000 });
  const id = (await first.call('POST', '/v1/requests', ask())).json.request.id as string;
  await until('it runs', () => first.call('GET', `/v1/requests/${id}`), (r) => r.json.request?.state === 'running');
  await first.stop();
  const second = await pipe({ root: first.root });
  try {
    const done = await settled(second, id);
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(done.json.request.result, 'OK');
  } finally { await second.stop(); }
});

test('G7 a job that hits a limit makes its request wait for the reset on the same account, never fail (L1, SPEC §5)', async () => {
  const p = await pipe({ limitFirst: 3_000, probeIntervalMs: 1_000 });
  try {
    const id = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
    const waiting = await until('it waits after the limit', () => p.call('GET', `/v1/requests/${id}`),
      (r) => r.json.request?.state === 'failed' || (r.json.request?.state === 'queued' && r.json.request?.waiting !== null && r.json.request?.waiting !== undefined));
    assert.equal(waiting.json.request.state, 'queued', waiting.text);
    const done = await settled(p, id, 30_000);
    assert.equal(done.json.request.state, 'completed', done.text);
  } finally { await p.stop(); }
});

test('G8 a job whose CLI reports a model other than the one chosen is not recorded as completed', async () => {
  const p = await pipe({ initModel: 'claude-sonnet-5' });
  try {
    const id = (await p.call('POST', '/v1/requests', ask({ model: 'opus' }))).json.request.id as string;
    const done = await settled(p, id);
    assert.notEqual(done.json.request.state, 'completed', done.text);
  } finally { await p.stop(); }
});

test('G9 a large accepted submission gets a small answer: accepted means 201, whatever the prompt size', async () => {
  const p = await pipe();
  try {
    const made = await p.call('POST', '/v1/requests', ask({ prompt: 'x'.repeat(900 * 1024) }));
    assert.equal(made.status, 201, made.text.slice(0, 300));
    assert.ok(made.text.length < 64 * 1024, `answer is ${made.text.length} bytes`);
    assert.equal(typeof made.json.request.id, 'string');
  } finally { await p.stop(); }
});

test('G10 the MCP server survives frames that are valid JSON but not objects', async () => {
  const p = await pipe();
  const mcp = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PIPE_URL: p.url, PIPE_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let out = '';
    mcp.stdout.setEncoding('utf8'); mcp.stdout.on('data', (d: string) => { out += d; });
    for (const bad of ['null', '[]', '42', '"x"', '{"jsonrpc":"2.0","id":null}']) mcp.stdin.write(`${bad}\n`);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grader', version: '1' } } })}\n`);
    await until('initialize answered', async () => out, (o) => o.split('\n').some((l) => l.includes('"id":1')));
    assert.equal(mcp.exitCode, null, 'still running');
  } finally { mcp.kill(); await p.stop(); }
});

// ── Review round 2 (Sol and Opus on 64f60af) ───────────────────────────────

test('G11 a pinned request whose account hits a limit waits for the stated reset, past the pin wait (SPEC §5)', async () => {
  const p = await pipe({ limitFirst: 4_000, probeIntervalMs: 1_000, pinWaitMs: 1_000 });
  try {
    const id = (await p.call('POST', '/v1/requests', ask({ pin: 'claude-a' }))).json.request.id as string;
    const done = await settled(p, id, 30_000);
    assert.equal(done.json.request.state, 'completed', done.text);
  } finally { await p.stop(); }
});

test('G13 a stop after the CLI reported success keeps the success: the request is completed and never runs again', async () => {
  const first = await pipe({ lingerMs: 8_000 });
  const id = (await first.call('POST', '/v1/requests', ask())).json.request.id as string;
  await until('the CLI has answered', async () => first.jobsRun(), (n) => n === 1);
  await new Promise((r) => setTimeout(r, 1_000));   // the result is out; the CLI lingers
  await first.stop();
  const second = await pipe({ root: first.root });
  try {
    const done = await settled(second, id);
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(done.json.request.result, 'OK');
    assert.equal(second.jobsRun(), 0, 'not run again');
  } finally { await second.stop(); }
});

// ── Review round 3 (Sol on c66cf9d) ────────────────────────────────────────

test('G14 a limit survives a restart: the restarted pipe does not send the request back into it before its reset', async () => {
  const first = await pipe({ limitFirst: 7_000, probeIntervalMs: 1_000 });
  const id = (await first.call('POST', '/v1/requests', ask())).json.request.id as string;
  await until('it waits on the limit', () => first.call('GET', `/v1/requests/${id}`),
    (r) => r.json.request?.state === 'queued' && first.jobsRun() === 1);
  await first.stop();
  const second = await pipe({ root: first.root, probeIntervalMs: 1_000 });
  try {
    await new Promise((r) => setTimeout(r, 2_500));
    assert.equal(second.jobsRun(), 0, 'the held account got no job before its reset');
    const done = await settled(second, id, 30_000);
    assert.equal(done.json.request.state, 'completed', done.text);
  } finally { await second.stop(); }
});

// ── Fix round 4 (live use, 2026-09-25) ─────────────────────────────────────

test('G15 a Codex prompt goes to the CLI on stdin, never argv: a prompt over 1 MiB completes', async () => {
  const { run } = await import('../src/runner.ts');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u5-codex-')));
  const out = readFileSync(new URL('codex-success.jsonl', FIX), 'utf8');
  writeFileSync(join(dir, 'codex'), `#!${process.execPath}
const fs = require('fs'), p = require('path');
fs.writeFileSync(p.join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));
let input = ''; try { input = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(p.join(__dirname, 'stdin.txt'), input);
process.stdout.write(${JSON.stringify(out)});
`);
  chmodSync(join(dir, 'codex'), 0o755);
  const login = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u5-codex-login-')));
  const prompt = 'p'.repeat(1_100_000);
  const events: Array<{ type: string }> = [];
  for await (const e of run({ requestId: 'req-g15', accountId: 'codex-a', provider: 'codex', model: 'gpt-6-sol', effort: 'low', prompt,
    mutating: false, cwd: realpathSync(tmpdir()), loginDir: login } as any, { cli: { codex: join(dir, 'codex') },
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, reachable: async () => true } as any)) events.push(e);
  const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[];
  assert.ok(!argv.some((a) => a.includes('ppppp')), 'the prompt is not in argv');
  assert.equal(readFileSync(join(dir, 'stdin.txt'), 'utf8'), prompt, 'the prompt arrives whole on stdin');
  assert.equal(events.at(-1)?.type, 'completed', JSON.stringify(events.at(-1)));
});

test('G16 a request can exclude accounts: it never runs on one it excluded, and says why it waits', async () => {
  const p = await pipe();
  try {
    const id = (await p.call('POST', '/v1/requests', ask({ exclude: ['claude-a'] }))).json.request.id as string;
    const waiting = await until('it waits', () => p.call('GET', `/v1/requests/${id}`),
      (r) => r.json.request?.state !== 'queued' || (r.json.request?.waiting ?? null) !== null);
    assert.equal(waiting.json.request.state, 'queued', waiting.text);
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(p.jobsRun(), 0, 'the excluded account ran nothing');
    const bad = await p.call('POST', '/v1/requests', ask({ exclude: 'claude-a' }));
    assert.equal(bad.status, 400, 'exclude is a list of account ids');
  } finally { await p.stop(); }
});

test('G17 drain: running work finishes, new work is not started, and the pipe reports when it is drained', async () => {
  const p = await pipe({ jobDelayMs: 2_500 });
  try {
    const a = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
    await until('A runs', () => p.call('GET', `/v1/requests/${a}`), (r) => r.json.request?.state === 'running');
    const d = await p.call('POST', '/v1/drain');
    assert.ok(d.status === 200 || d.status === 202, d.text);
    const b = await p.call('POST', '/v1/requests', ask({ prompt: 'after the drain' }));
    const done = await settled(p, a);
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(typeof (p as any).drained?.then, 'function', 'startPipe returns drained: a promise');
    await Promise.race([(p as any).drained, new Promise((_, no) => setTimeout(() => no(new Error('not drained in 10 s')), 10_000))]);
    assert.equal(p.jobsRun(), 1, 'nothing new started while draining');
    if (b.status === 201) assert.equal((await p.call('GET', `/v1/requests/${b.json.request.id}`)).json.request.state, 'queued', 'accepted, kept for the next start');
    else assert.equal(b.status, 503, 'or refused while draining');
  } finally { await p.stop(); }
});

// ── Fix round 7 ───────────────────────────────────────────

test('G18 a request that names a specific model id completes only when the CLI ran exactly that id', async () => {
  const exact = await pipe({ initModel: 'claude-opus-5-5' });
  try {
    const id = (await exact.call('POST', '/v1/requests', ask({ model: 'claude-opus-5-5' }))).json.request.id as string;
    assert.equal((await settled(exact, id)).json.request.state, 'completed');
  } finally { await exact.stop(); }
  const other = await pipe({ initModel: 'claude-opus-4-1' });
  try {
    const id = (await other.call('POST', '/v1/requests', ask({ model: 'claude-opus-5-5' }))).json.request.id as string;
    const done = await settled(other, id);
    assert.notEqual(done.json.request.state, 'completed', done.text);
    const alias = (await other.call('POST', '/v1/requests', ask({ model: 'opus' }))).json.request.id as string;
    assert.equal((await settled(other, alias)).json.request.state, 'completed', 'an alias still matches its family');
  } finally { await other.stop(); }
});

test('G19 a failed probe is retried soon, not at the next interval: the request runs within seconds', async () => {
  const p = await pipe({ usageFailFirst: 2, probeIntervalMs: 120_000, probeRetryMs: 500 });
  try {
    const id = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
    const done = await settled(p, id, 20_000);
    assert.equal(done.json.request.state, 'completed', done.text);
  } finally { await p.stop(); }
});

test('G20 with no CLI path configured, probes and runs both use the same `claude` found on the configured PATH', async () => {
  const p = await pipe({ cliOnPath: true });
  try {
    const id = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
    const done = await settled(p, id);
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(p.jobsRun(), 1, 'the job ran on the configured PATH\'s claude');
  } finally { await p.stop(); }
});

test('G21 a configured bare CLI name is looked up on the configured PATH, once, for probes and runs alike', async () => {
  const p = await pipe({ cliOnPath: 'bare' });
  try {
    const id = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
    const done = await settled(p, id);
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(p.jobsRun(), 1);
  } finally { await p.stop(); }
});

/**
 * Acceptance grader, lane U6: reliability (lead-authored; the implementation lane must not edit it).
 *
 * `pipe wait` and MCP `pipe_wait` ride through a service restart, fail only when the service
 * stays unreachable past their budget, and never retry a real HTTP error.
 * Temporary outages must never be marked permanent: repeated sign-in
 * failures hold an account for a while, not for ever. The hold backs off, clears on its own, and
 * never fails or permanently marks a request. A request still gives up after a bounded budget.
 *
 * Contract added by this lane: startPipe accepts `authHoldMs` (first hold, default 5 min),
 * `authHoldMaxMs` (cap, default 30 min) and `maxLimits` (the store's bounded wait budget, which now
 * also counts sign-in failures); `pipe wait` accepts `--reconnect-seconds N` (default 600).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPipe } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import type { AccountConfig } from '../src/identity.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = new URL('./fixtures/', import.meta.url);
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
const POLICY = {
  claude: { models: { opus: 'default', fable: 'hard', 'claude-opus-5-5': 'hard' }, efforts: ['low', 'medium', 'high', 'max'] },
  codex: { models: { 'gpt-6-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'ultra'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT_TOKEN = 'pipe-wait-test-token-not-a-credential-0123456789';

const withModel = (jsonl: string, model: string) => jsonl.trim().split('\n').map((l) => {
  const o = JSON.parse(l); if (o.type === 'system' && o.subtype === 'init') o.model = model; return JSON.stringify(o);
}).join('\n') + '\n';

/** A job that fails on sign-in, the way Claude reports a rejected credential. */
function authFailureJob(): string {
  const lines = withModel(readFileSync(new URL('claude-weekly-limit.jsonl', FIX), 'utf8'), 'claude-opus-5-5')
    .trim().split('\n').filter((l) => !l.includes('"rate_limit_event"'));
  const last = JSON.parse(lines.pop()!);
  last.errors = [{ message: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }];
  return [...lines, JSON.stringify(last)].join('\n') + '\n';
}

/**
 * One fake `claude`: probes answer from the U4 captures (resets moved after now); job number n runs
 * `plan[n]` ('auth' fails on sign-in, 'ok' succeeds); jobs past the plan succeed.
 */
function fakeClaude(plan: Array<'auth' | 'ok'>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u6-claude-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    version: u4('claude-version').stdout, auth: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout,
    ok: withModel(readFileSync(new URL('claude-success.jsonl', FIX), 'utf8'), 'claude-opus-5-5'), fail: authFailureJob(), plan,
  }));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '--version') process.stdout.write(sc.version);
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.auth));
else if (a[0] === '-p' && a[1] === '/usage') {
  const at = (ms) => { const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return q.month + ' ' + q.day + ' at ' + q.hour + ':' + q.minute + q.dayPeriod.toLowerCase(); };
  const NL = String.fromCharCode(10), RESET = new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m', 'u');
  const result = sc.usage.result.split(NL).map((l) => l.replace(RESET, 'resets ' + at(Date.now() + (l.startsWith('Current session') ? 3 : 96) * 3600000))).join(NL);
  process.stdout.write(JSON.stringify({ ...sc.usage, result }));
} else {
  try { fs.readFileSync(0); } catch {}
  const count = p.join(__dirname, 'jobs'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));
  if (sc.plan[n] === 'auth') { process.stdout.write(sc.fail); process.exitCode = 1; }
  else process.stdout.write(sc.ok);
}
`);
  chmodSync(path, 0o755);
  return path;
}

async function pipe(o: { plan: Array<'auth' | 'ok'>; authHoldMs?: number; authHoldMaxMs?: number; maxLimits?: number; pinWaitMs?: number }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u6-')));
  const login = join(root, 'login-claude-a');
  mkdirSync(login, { recursive: true });
  const fake = fakeClaude(o.plan);
  const handle = await startPipe({
    accounts: [{ id: 'claude-a', provider: 'claude', loginDir: login, fingerprint: sha8('<orgId>'), maxConcurrency: 1, enabled: true }],
    policy: POLICY, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'),
    cli: { claude: fake }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000,
    ...(o.authHoldMs === undefined ? {} : { authHoldMs: o.authHoldMs }),
    ...(o.authHoldMaxMs === undefined ? {} : { authHoldMaxMs: o.authHoldMaxMs }),
    ...(o.maxLimits === undefined ? {} : { maxLimits: o.maxLimits }),
    ...(o.pinWaitMs === undefined ? {} : { pinWaitMs: o.pinWaitMs }),
  } as Parameters<typeof startPipe>[0]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  const jobsRun = () => { try { return Number(readFileSync(join(fake, '..', 'jobs'), 'utf8')); } catch { return 0; } };
  return { ...handle, call, jobsRun };
}
const ask = (over: Record<string, unknown> = {}) => ({ requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high',
  reason: 'a routine check', prompt: 'say OK', mutating: false, priority: 'interactive', ...over });
const avail = (r: { json: Record<string, any> }) => r.json.accounts.find((a: any) => a.id === 'claude-a').availability.opus;
async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await get(); if (ok(v)) return v; if (Date.now() > end) assert.fail(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`); await sleep(50); }
}
const settled = (r: { json: Record<string, any> }) => ['completed', 'failed', 'cancelled'].includes(r.json.request?.state);

test('A1 two sign-in failures in a row hold the account for a while; the request waits, then runs when the hold ends', async () => {
  const p = await pipe({ plan: ['auth', 'auth'], authHoldMs: 4000 });
  try {
    const made = await p.call('POST', '/v1/requests', ask());
    assert.equal(made.status, 201, made.text);
    const id = made.json.request.id as string;
    const held = await until('the account to be held', () => p.call('GET', '/v1/accounts'), (r) => avail(r)?.state === 'unavailable');
    const a = avail(held);
    assert.match(String(a.reason), /auth|sign/i, 'the hold says why');
    const ends = Date.parse(a.until);
    assert.ok(Number.isFinite(ends) && ends > Date.now() && ends <= Date.now() + 4000 + 1000, `the hold is temporary: ${a.until}`);
    assert.equal(p.jobsRun(), 2);
    // The queue records why on its next tick.
    const waiting = await until('waiting to say why', () => p.call('GET', `/v1/requests/${id}`), (r) => /auth|sign/i.test(JSON.stringify(r.json.request?.waiting ?? '')), 3000);
    assert.equal(waiting.json.request.state, 'queued', `a sign-in failure never fails a read-only request: ${waiting.text}`);
    await sleep(600);
    assert.equal(p.jobsRun(), 2, 'nothing is dispatched to a held account');
    const done = await until('the request to finish', () => p.call('GET', `/v1/requests/${id}`), settled);
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(done.json.request.result, 'OK');
    assert.equal(p.jobsRun(), 3, 'after the hold, the next real attempt is the probe');
    assert.equal(avail(await p.call('GET', '/v1/accounts')).state, 'available', 'a success clears the hold with no human step');
  } finally { await p.stop(); }
});

test('A2 a success between sign-in failures resets the count, so no hold starts', async () => {
  const p = await pipe({ plan: ['auth', 'ok', 'auth', 'ok'], authHoldMs: 60_000 });
  try {
    for (const n of [1, 2]) {
      const id = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
      const done = await until(`request ${n} to finish`, () => p.call('GET', `/v1/requests/${id}`), settled, 10_000);
      assert.equal(done.json.request.state, 'completed', done.text);
    }
    assert.equal(p.jobsRun(), 4);
    assert.equal(avail(await p.call('GET', '/v1/accounts')).state, 'available');
  } finally { await p.stop(); }
});

test('A3 a pinned request waits through holds that back off, instead of failing or hitting the pin timeout', async () => {
  const p = await pipe({ plan: ['auth', 'auth', 'auth', 'auth'], authHoldMs: 1000, authHoldMaxMs: 8000, pinWaitMs: 1500 });
  try {
    const started = Date.now();
    const id = (await p.call('POST', '/v1/requests', ask({ pin: 'claude-a' }))).json.request.id as string;
    const done = await until('the pinned request to finish', () => p.call('GET', `/v1/requests/${id}`), settled, 30_000);
    const elapsed = Date.now() - started;
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.equal(p.jobsRun(), 5);
    // Holds of 1 s, then 2 s, then 4 s (each failure after a hold doubles it) come to at least 7 s.
    assert.ok(elapsed >= 6_500, `the holds back off: finished after ${elapsed} ms`);
    assert.ok(!JSON.stringify(done.json.request.avoid ?? []).includes('claude-a'), 'a sign-in failure never marks the request against the account');
  } finally { await p.stop(); }
});

test('A4 sign-in failures still end: a request gives up after the bounded budget, saying why', async () => {
  const p = await pipe({ plan: Array(40).fill('auth'), authHoldMs: 50, authHoldMaxMs: 50, maxLimits: 3 });
  try {
    const id = (await p.call('POST', '/v1/requests', ask())).json.request.id as string;
    const done = await until('the request to give up', () => p.call('GET', `/v1/requests/${id}`), settled, 20_000);
    assert.equal(done.json.request.state, 'failed', done.text);
    assert.match(JSON.stringify(done.json.request.error ?? ''), /auth|sign/i);
    assert.ok(p.jobsRun() >= 3 && p.jobsRun() <= 5, `bounded: ${p.jobsRun()} attempts`);
  } finally { await p.stop(); }
});

// ---- Waiting rides through a restart ------------------------------------------------

/** A stand-in pipe service whose answers the test controls, and which can stop and come back. */
async function fakeService() {
  const state = { phase: 'running' as string, status: 200, calls: 0, hang: false };
  const handler = (_req: IncomingMessage, res: ServerResponse) => {
    state.calls++;
    if (state.hang) return;   // accept the request and never answer
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.status === 200 ? { request: { id: 'r1', state: state.phase, ...(state.phase === 'completed' ? { result: 'ok' } : {}) } } : { error: { message: 'unknown request' } }));
  };
  let server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const stop = async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); };
  const start = async () => { server = createServer(handler); await new Promise<void>((r) => server.listen(port, '127.0.0.1', r)); };
  return { state, url: `http://127.0.0.1:${port}`, stop, start, close: stop };
}
const children = new Set<ChildProcess>();
test.afterEach(() => { for (const c of children) c.kill('SIGKILL'); children.clear(); });
function run(args: string[], env: Record<string, string>, input?: string) {
  const child: ChildProcess = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout!.on('data', (d) => { stdout += d; }); child.stderr!.on('data', (d) => { stderr += d; });
  if (input !== undefined) child.stdin!.write(input); else child.stdin!.end();
  const exit = (ms: number) => new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`still running after ${ms} ms; stderr: ${stderr}`)); }, ms);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  return { child, exit, out: () => stdout, err: () => stderr };
}

test('W1 `pipe wait` rides through a service restart and prints the finished request', async () => {
  const s = await fakeService();
  try {
    const w = run(['src/cli.ts', 'wait', 'r1'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN });
    await until('the wait to poll', async () => s.state.calls, (n) => n >= 2);
    await s.stop();
    await sleep(1500);
    s.state.phase = 'completed';
    await s.start();
    const code = await w.exit(20_000);
    assert.equal(code, 0, w.err());
    assert.equal(JSON.parse(w.out()).request.state, 'completed');
  } finally { await s.close(); }
});

test('W2 `pipe wait` fails only after the service stays unreachable past its reconnect budget', async () => {
  const s = await fakeService();
  const w = run(['src/cli.ts', 'wait', 'r1', '--reconnect-seconds', '2'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN });
  await until('the wait to poll', async () => s.state.calls, (n) => n >= 1);
  await s.stop();
  const stopped = Date.now();
  const code = await w.exit(20_000);
  assert.notEqual(code, 0);
  assert.ok(Date.now() - stopped >= 1_500, 'it kept retrying before giving up');
  assert.match(w.err(), /unreachable|connect/i);
});

test('W3 a real HTTP error is not retried', async () => {
  const s = await fakeService();
  try {
    s.state.status = 404;
    const started = Date.now();
    const w = run(['src/cli.ts', 'wait', 'r1'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN });
    const code = await w.exit(10_000);
    assert.notEqual(code, 0);
    assert.ok(Date.now() - started < 5_000, 'it failed at once');
    assert.match(w.err(), /unknown request/);
  } finally { await s.close(); }
});

test('W4 MCP pipe_wait rides through a service restart', async () => {
  const s = await fakeService();
  try {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pipe_wait', arguments: { id: 'r1', timeoutSeconds: 30 } } });
    const m = run(['src/mcp.ts'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN }, `${frame}\n`);
    await until('the MCP wait to poll', async () => s.state.calls, (n) => n >= 2);
    await s.stop();
    await sleep(1500);
    s.state.phase = 'completed';
    await s.start();
    const reply = await until('the MCP reply', async () => m.out(), (o) => o.includes('"id":7'), 25_000);
    m.child.kill();
    const answer = JSON.parse(reply.trim().split('\n').find((l) => l.includes('"id":7'))!);
    assert.ok(!answer.result?.isError, reply);
    assert.match(answer.result.content[0].text, /"state":"completed"/);
  } finally { await s.close(); }
});

test('W5 MCP pipe_wait returns a clear error, not a crash, when the service stays away', async () => {
  const s = await fakeService();
  const frame = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'pipe_wait', arguments: { id: 'r1', timeoutSeconds: 2 } } });
  const m = run(['src/mcp.ts'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN }, `${frame}\n`);
  await until('the MCP wait to poll', async () => s.state.calls, (n) => n >= 1);
  await s.stop();
  const stopped = Date.now();
  const reply = await until('the MCP reply', async () => m.out(), (o) => o.includes('"id":8'), 20_000);
  assert.ok(Date.now() - stopped >= 1_500, 'it kept retrying until its timeout');
  m.child.kill();
  const answer = JSON.parse(reply.trim().split('\n').find((l) => l.includes('"id":8'))!);
  assert.equal(answer.result?.isError, true, reply);
  assert.match(answer.result.content[0].text, /unreachable|connect/i);
});


// ---- Round 2 (Sol on 79963c3): the hold is durable per-account state, kept in completion order -------------------
// Contract: Store accepts `authHoldMs` and `authHoldMaxMs`, and `authHoldUntil(accountId)` returns the hold's end in
// epoch ms (0 when there is none), read from per-account state that is updated with each recorded outcome.

const T0 = Date.parse('2026-09-26T01:00:00.000Z');
function holdStore(o: { authHoldMs?: number; authHoldMaxMs?: number } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u6-store-')));
  const clock = { t: T0 };
  const path = join(dir, 'pipe.sqlite');
  const open = () => new Store(path, { now: () => new Date(clock.t), authHoldMs: o.authHoldMs ?? 60_000, authHoldMaxMs: o.authHoldMaxMs ?? 480_000 } as ConstructorParameters<typeof Store>[1]);
  return { clock, open, path };
}
const ACCOUNT: AccountConfig = { id: 'claude-a', provider: 'claude', loginDir: '/logins/claude-a', fingerprint: 'fp-claude-a', maxConcurrency: 8, enabled: true };
function attemptOn(store: Store, t: number): string {
  const r = store.submit(ask() as Parameters<Store['submit']>[0]);
  const s = store.startAttempt(r.id, ACCOUNT, { accountId: ACCOUNT.id, model: 'opus', observedAt: new Date(t).toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] });
  assert.equal(s.ok, true, JSON.stringify(s));
  return s.ok ? s.attempt.id : '';
}
const signinFailure = { kind: 'failed', errorKind: 'auth', message: 'invalid api key' } as const;
const success = { kind: 'completed', result: 'OK' } as const;

test('A5 the hold survives a restart, in completion order, even when outcomes share a timestamp', () => {
  // Completed, then two sign-in failures, all in the same millisecond: the account is held.
  const h = holdStore();
  let store = h.open();
  const [ok, f1, f2] = [attemptOn(store, T0), attemptOn(store, T0), attemptOn(store, T0)];
  store.finishAttempt(ok, success); store.finishAttempt(f1, signinFailure); store.finishAttempt(f2, signinFailure);
  assert.equal(store.authHoldUntil('claude-a'), T0 + 60_000);
  store.close();
  store = h.open();
  assert.equal(store.authHoldUntil('claude-a'), T0 + 60_000, 'a restart keeps the hold');
  store.close();
  // Two sign-in failures, then a success, in the same millisecond: no hold, before or after a restart.
  const g = holdStore();
  store = g.open();
  const [e1, e2, done] = [attemptOn(store, T0), attemptOn(store, T0), attemptOn(store, T0)];
  store.finishAttempt(e1, signinFailure); store.finishAttempt(e2, signinFailure); store.finishAttempt(done, success);
  assert.equal(store.authHoldUntil('claude-a'), 0);
  store.close();
  store = g.open();
  assert.equal(store.authHoldUntil('claude-a'), 0, 'the success came last, and a restart keeps that order');
  store.close();
});

test('A6 a sign-in failure during a hold extends it; one after it ends doubles the next, up to the cap', () => {
  const h = holdStore({ authHoldMs: 60_000, authHoldMaxMs: 150_000 });
  const store = h.open();
  const ids = Array.from({ length: 6 }, () => attemptOn(store, T0));   // all running before any hold
  store.finishAttempt(ids[0]!, signinFailure); store.finishAttempt(ids[1]!, signinFailure);
  assert.equal(store.authHoldUntil('claude-a'), T0 + 60_000);
  h.clock.t = T0 + 30_000;   // an attempt that was already running fails during the hold
  store.finishAttempt(ids[2]!, signinFailure);
  assert.equal(store.authHoldUntil('claude-a'), T0 + 30_000 + 60_000, 'extended to a full hold from the latest failure, not doubled');
  h.clock.t = T0 + 100_000;  // after the hold ends, the next failure doubles it
  store.finishAttempt(ids[3]!, signinFailure);
  assert.equal(store.authHoldUntil('claude-a'), T0 + 100_000 + 120_000);
  h.clock.t = T0 + 300_000;  // and the next is capped
  store.finishAttempt(ids[4]!, signinFailure);
  assert.equal(store.authHoldUntil('claude-a'), T0 + 300_000 + 150_000);
  store.finishAttempt(ids[5]!, success);   // an attempt that was already running succeeds during the hold
  assert.equal(store.authHoldUntil('claude-a'), 0, 'a success clears it');
  store.close();
});

test('W6 `pipe wait` does not hang on a request that never gets an answer', async () => {
  const s = await fakeService();
  try {
    s.state.hang = true;
    const started = Date.now();
    const w = run(['src/cli.ts', 'wait', 'r1', '--reconnect-seconds', '2'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN });
    const code = await w.exit(20_000);
    assert.notEqual(code, 0);
    assert.ok(Date.now() - started < 15_000, 'bounded by its budget');
    assert.match(w.err(), /unreachable|timed out|connect/i);
  } finally { await s.close(); }
});

test('W7 MCP pipe_wait does not hang on a request that never gets an answer', async () => {
  const s = await fakeService();
  try {
    s.state.hang = true;
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'pipe_wait', arguments: { id: 'r1', timeoutSeconds: 2 } } });
    const m = run(['src/mcp.ts'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN }, `${frame}\n`);
    const reply = await until('the MCP reply', async () => m.out(), (o) => o.includes('"id":9'), 15_000);
    const answer = JSON.parse(reply.trim().split('\n').find((l) => l.includes('"id":9'))!);
    assert.equal(answer.result?.isError, true, reply);
  } finally { await s.close(); }
});


// ---- Round 3 (Sol on e87f612): claims respect the hold; an upgrade keeps an active hold; a zero budget still asks once --

test('A7 a held account cannot be claimed for a new attempt, even outside the planner', () => {
  const h = holdStore();
  const store = h.open();
  const [f1, f2] = [attemptOn(store, T0), attemptOn(store, T0)];
  store.finishAttempt(f1, signinFailure); store.finishAttempt(f2, signinFailure);
  assert.equal(store.authHoldUntil('claude-a'), T0 + 60_000);
  const r = store.submit(ask() as Parameters<Store['submit']>[0]);
  const claim = store.startAttempt(r.id, ACCOUNT, { accountId: ACCOUNT.id, model: 'opus', observedAt: new Date(T0).toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] });
  assert.equal(claim.ok, false, 'the claim is refused while the hold lasts');
  if (!claim.ok) assert.match(claim.reason, /hold|sign-in|auth/i);
  h.clock.t = T0 + 60_001;
  const later = store.startAttempt(r.id, ACCOUNT, { accountId: ACCOUNT.id, model: 'opus', observedAt: new Date(h.clock.t).toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] });
  assert.equal(later.ok, true, 'after the hold, the account can be claimed again');
  store.close();
});

test('A8 upgrading a record that has sign-in history keeps an active hold, and adds none after a success', () => {
  // A record written before holds were stored: its history is there, the hold table is not.
  const h = holdStore();
  let store = h.open();
  const [f1, f2] = [attemptOn(store, T0), attemptOn(store, T0)];
  store.finishAttempt(f1, signinFailure); store.finishAttempt(f2, signinFailure);
  store.close();
  const raw = new DatabaseSync(h.path);
  raw.exec('DROP TABLE account_holds');
  raw.close();
  store = h.open();
  assert.equal(store.authHoldUntil('claude-a'), T0 + 60_000, 'the upgrade rebuilt the active hold from history');
  store.close();
  // History that ends in a success needs no hold.
  const g = holdStore();
  store = g.open();
  const [e1, e2, ok] = [attemptOn(store, T0), attemptOn(store, T0), attemptOn(store, T0)];
  store.finishAttempt(e1, signinFailure); store.finishAttempt(e2, signinFailure);
  g.clock.t = T0 + 1;
  store.finishAttempt(ok, success);
  store.close();
  const raw2 = new DatabaseSync(g.path);
  raw2.exec('DROP TABLE account_holds');
  raw2.close();
  store = g.open();
  assert.equal(store.authHoldUntil('claude-a'), 0);
  store.close();
});

test('W8 `pipe wait --reconnect-seconds 0` still asks a healthy service once', async () => {
  const s = await fakeService();
  try {
    s.state.phase = 'completed';
    const w = run(['src/cli.ts', 'wait', 'r1', '--reconnect-seconds', '0'], { PIPE_URL: s.url, PIPE_TOKEN: WAIT_TOKEN });
    const code = await w.exit(10_000);
    assert.equal(code, 0, w.err());
    assert.equal(JSON.parse(w.out()).request.state, 'completed');
  } finally { await s.close(); }
});

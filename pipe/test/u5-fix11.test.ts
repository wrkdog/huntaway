import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, type NewRequest, type RequestRecord } from '../src/store.ts';
import { plan } from '../src/queue.ts';
import { probeAccount } from '../src/probe.ts';
import { advanceOfflineMark, classifyOfflineOutcome, journalOf, persistCompletedOutcome, startPipe } from '../src/service.ts';
import { run } from '../src/runner.ts';

const token = 'x'.repeat(32);
const account = { id: 'a', provider: 'claude' as const, loginDir: '/tmp/a', fingerprint: createHash('sha256').update('owner').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true };
const request: NewRequest = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'routine request', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };
const path = () => join(mkdtempSync(join(tmpdir(), 'pipe-fix11-')), 'store.sqlite');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw new Error('condition did not arrive'); await pause(20); }
}
const evidence = (at: string) => ({ accountId: 'a', model: 'opus', observedAt: at, verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read'] });

test('fix11 offline failures have a separate finite budget', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const store = new Store(path(), { now: () => now, maxAttempts: 1, retryBackoffMs: 0 });
  try {
    const row = store.submit(request);
    for (let n = 1; n <= 11; n++) {
      const started = store.startAttempt(row.id, account, evidence(now.toISOString()));
      assert.equal(started.ok, true);
      if (!started.ok) return;
      store.finishAttempt(started.attempt.id, { kind: 'failed', errorKind: 'offline', message: 'ECONNRESET' });
      assert.equal(store.get(row.id)?.state, n <= 10 ? 'queued' : 'failed');
    }
    assert.match(store.get(row.id)?.error?.message ?? '', /gave up after 11 offline failures/);
  } finally { store.close(); }
});

test('fix11 priority, FIFO, fairness, and aged background work', () => {
  const at = new Date('2026-09-24T12:00:00Z');
  const store = new Store(path(), { now: () => at });
  try {
    const old = store.submit({ ...request, priority: 'background', prompt: 'old' });
    const bg = store.submit({ ...request, priority: 'background', prompt: 'new' });
    const first = store.submit({ ...request, prompt: 'first' });
    const second = store.submit({ ...request, prompt: 'second' });
    const status = { account, running: 0, evidence: () => evidence(at.toISOString()) };
    const options = { now: at, pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() };
    const planNow = plan([old, bg, first, second], [status], options);
    assert.equal(planNow.dispatch[0]?.requestId, first.id);
    const aged: RequestRecord = { ...old, createdAt: new Date(at.getTime() - 30 * 60_000 - 1).toISOString() };
    const planLater = plan([aged, bg, first, second], [status], options);
    assert.equal(planLater.dispatch[0]?.requestId, old.id);
    const free = plan([first, second], [{ ...status, account: { ...account, maxConcurrency: 2 } }], options);
    assert.deepEqual(free.dispatch.map((d) => d.requestId), [first.id, second.id]);
    const other = store.submit({ ...request, requester: 'another', prompt: 'fair' });
    const fair = plan([first, second, other], [status], { ...options, load: new Map([['dev-a', { running: 1, lastDispatchedAt: at.toISOString() }]]) });
    assert.equal(fair.dispatch[0]?.requestId, other.id);
  } finally { store.close(); }
});

test('fix11 cancellation records the actor, defaulting to requester', () => {
  const store = new Store(path());
  try {
    const queued = store.submit(request);
    store.cancel(queued.id, 'withdrawn');
    assert.equal(store.get(queued.id)?.state, 'cancelled');
    assert.equal(store.get(queued.id)?.by, 'dev-a');
    const running = store.submit(request);
    assert.equal(store.startAttempt(running.id, account, evidence(new Date().toISOString())).ok, true);
    store.cancel(running.id, 'withdrawn', 'operator');
    assert.equal(store.get(running.id)?.by, 'operator');
  } finally { store.close(); }
});

test('fix11 nonzero Claude usage exit is unknown despite valid JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix11-usage-'));
  const cli = join(root, 'claude');
  writeFileSync(cli, `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==='--version') console.log('2.1.280'); else if(args[0]==='auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',orgId:'owner'})); else { console.log(JSON.stringify({is_error:false,num_turns:0,total_cost_usd:0,result:'Current session: 10% used · resets Sep 25 at 4:00pm (America/New_York)\\nCurrent week (all models): 20% used · resets Sep 27 at 4:00pm (America/New_York)'})); process.exitCode=1; }\n`);
  chmodSync(cli, 0o755);
  const report = await probeAccount({ ...account, loginDir: root }, { cli: { claude: cli }, reachable: async () => true });
  assert.equal(report.allowance.state, 'unknown');
});

test('fix11 an older probe cannot clear a newer offline mark', () => {
  const marks = new Map([['a', '2026-09-24T12:00:01.000Z']]);
  advanceOfflineMark(marks, 'a', false, Date.parse('2026-09-24T12:00:00.000Z'));
  assert.equal(marks.get('a'), '2026-09-24T12:00:01.000Z');
  advanceOfflineMark(marks, 'a', false, Date.parse('2026-09-24T12:00:01.000Z'));
  assert.equal(marks.has('a'), true);
  advanceOfflineMark(marks, 'a', false, Date.parse('2026-09-24T12:00:02.000Z'));
  assert.equal(marks.has('a'), false);
});

test('fix11 reachable service turns misleading offline runner output into a bounded failed try', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix11-runner-'));
  const cli = join(root, 'claude');
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('ECONNRESET'); process.exitCode=1; });\n`);
  chmodSync(cli, 0o755);
  const events = [];
  for await (const event of run({ requestId: 'r', accountId: 'a', provider: 'claude', model: 'opus', effort: 'high', prompt: 'OK', mutating: false, cwd: root, loginDir: root },
    { cli: { claude: cli }, reachable: async () => true })) events.push(event);
  assert.equal(events.find((e) => e.type === 'failed')?.errorKind, 'offline');
  const store = new Store(path(), { maxAttempts: 1 });
  try {
    const row = store.submit(request);
    const started = store.startAttempt(row.id, account, evidence(new Date().toISOString()));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.finishAttempt(started.attempt.id, { kind: 'failed', errorKind: await classifyOfflineOutcome('claude', async () => true), message: 'ECONNRESET' });
    assert.equal(store.get(row.id)?.state, 'failed');
    assert.equal(store.attempts(row.id).length, 1, 'a reachable service does not let the request loop');
  } finally { store.close(); }
});

test('fix11 failed completion write is journaled before a crash and replayed by new startPipe', async (t) => {
  const storePath = path();
  const store = new Store(storePath);
  const row = store.submit(request);
  const started = store.startAttempt(row.id, account, evidence(new Date().toISOString()));
  assert.equal(started.ok, true);
  if (!started.ok) { store.close(); return; }
  const outcome = { kind: 'completed' as const, result: 'OK' };
  const pending = new Map([[started.attempt.id, outcome]]);
  const original = store.finishAttempt;
  store.finishAttempt = () => { throw new Error('injected store write failure'); };
  try { await persistCompletedOutcome(store, pending, journalOf(storePath), () => {}); }
  finally { store.finishAttempt = original; store.close(); }
  assert.equal(pending.size, 0);
  assert.equal(existsSync(journalOf(storePath)), true);
  // No stop call: the old process dies after completion, before its ordinary shutdown.
  const pipe = await startPipe({ accounts: [], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
    storePath, worktreeRoot: join(storePath, '..'), cli: {}, token }).catch((e: Error) => {
    if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.diagnostic('loopback bind unavailable; startup replay completed before bind'); return null; } throw e;
  });
  try {
    const reopened = new Store(storePath);
    try { assert.equal(reopened.get(row.id)?.state, 'completed'); assert.equal(reopened.get(row.id)?.result, 'OK'); assert.equal(reopened.attempts(row.id).length, 1); }
    finally { reopened.close(); }
  } finally { await pipe?.stop(); }
});

test('fix11 CLI and MCP expose cancel via POST', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix11-client-'));
  const mock = join(root, 'fetch.mjs');
  writeFileSync(mock, `globalThis.fetch = async (url, options) => { process.stderr.write('FETCH ' + JSON.stringify({ url: String(url), method: options.method, body: options.body ?? null }) + '\\n'); return new Response('{"request":{"state":"cancelled"}}', { status: 200, headers: { 'content-type': 'application/json' } }); };\n`);
  const env = { ...process.env, PIPE_URL: 'http://127.0.0.1:8123', PIPE_TOKEN: token };
  const invoke = (file: string, args: string[], input = '') => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', mock, file, ...args], { env }); let out = '', err = '';
    child.stdout.on('data', (v) => out += v); child.stderr.on('data', (v) => err += v);
    child.on('close', (code) => resolve({ code, out, err })); child.stdin.end(input);
  });
  const cli = await invoke(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ['cancel', 'one']);
  assert.equal(cli.code, 0, cli.err);
  const mcp = await invoke(fileURLToPath(new URL('../src/mcp.ts', import.meta.url)), [], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pipe_cancel', arguments: { id: 'two', by: 'operator' } } }) + '\n');
  assert.match(mcp.out, /cancelled/);
  const call = (output: string) => JSON.parse(output.slice(output.indexOf('FETCH ') + 6).split('\n')[0]!);
  assert.deepEqual([call(cli.err).method, new URL(call(cli.err).url).pathname, call(cli.err).body], ['POST', '/v1/requests/one/cancel', null]);
  assert.deepEqual([call(mcp.err).method, new URL(call(mcp.err).url).pathname, JSON.parse(call(mcp.err).body)], ['POST', '/v1/requests/two/cancel', { by: 'operator' }]);
});

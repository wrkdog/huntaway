import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllowanceLedger } from '../src/allowance.ts';
import { availability, IdentityLedger } from '../src/availability.ts';
import { drainClient } from '../src/cli.ts';
import { startHttp } from '../src/http.ts';
import { probeAccount } from '../src/probe.ts';
import { plan } from '../src/queue.ts';
import { probeHealth, startPipe } from '../src/service.ts';
import { Store, type NewRequest } from '../src/store.ts';

const token = 'x'.repeat(32);
const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw new Error('condition did not arrive'); await pause(25); }
}
function fake(kind: 'claude' | 'codex', scenario: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-fix9-cli-'));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const path = join(dir, kind);
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') process.stdout.write('2.1.280');
else if (args[0] === 'auth') process.stdout.write(JSON.stringify(sc.auth));
else if (args[0] === '-p' && args[1] === '/usage') {
  const when = (hours) => { const z = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(Date.now() + hours * 3600000)).map((x) => [x.type, x.value])); return z.month + ' ' + z.day + ' at ' + z.hour + ':' + z.minute + z.dayPeriod.toLowerCase(); };
  process.stdout.write(JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result: 'Current session: 10% used · resets ' + when(3) + ' (America/New_York)\\nCurrent week (all models): 20% used · resets ' + when(96) + ' (America/New_York)' }));
} else if (args[0] === 'app-server') {
  let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { buf += chunk; let n;
    while ((n = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue; process.stdout.write(JSON.stringify({ id: m.id, ...(sc.app[m.method] || { result: {} }) }) + '\\n'); }
  });
} else { fs.writeFileSync(p.join(__dirname, 'ran'), 'yes'); process.stdout.write(sc.job || ''); }
`);
  chmodSync(path, 0o755);
  return path;
}
const claudeAuth = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', orgId: 'owner' };
const claude = { id: 'a', provider: 'claude' as const, loginDir: '/tmp/a', fingerprint: sha8('owner'), maxConcurrency: 1, enabled: true };
const request: NewRequest = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'routine', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/u4/${name}.json`, import.meta.url), 'utf8'));
const codexApp = Object.fromEntries((fixture('codex-app-server.signed-in') as Array<{ method: string; response: object }>).map((e) => [e.method, e.response]));

test('fix9 offline allowance probe blocks dispatch, preserves room, and later succeeds', async (t) => {
  let online = true;
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix9-service-'));
  const cli = fake('claude', { auth: claudeAuth });
  const pipe = await startPipe({ accounts: [{ ...claude, loginDir: root }], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
    storePath: join(root, 'store.sqlite'), worktreeRoot: root, cli: { claude: cli }, token, reachable: async () => online,
    probeIntervalMs: 100, probeRetryMs: 50, tickMs: 20, pinWaitMs: 100 }).catch((e: Error) => { if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.skip('loopback bind unavailable'); return null; } throw e; });
  if (!pipe) return;
  const read = async () => (await (await fetch(`${pipe.url}/v1/accounts`, { headers: { authorization: `Bearer ${token}` } })).json()) as { accounts: Array<{ availability: { opus: { state: string; reason?: string } }; allowance: { state: string } }> };
  try {
    await until(read, (v) => v.accounts[0]?.availability.opus.state === 'available');
    online = false;
    await until(read, (v) => /offline since/.test(v.accounts[0]?.availability.opus.reason ?? ''));
    assert.equal((await read()).accounts[0]?.allowance.state, 'ok');
    const submitted = await fetch(`${pipe.url}/v1/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const id = (await submitted.json()).request.id;
    await pause(220);
    const row = await (await fetch(`${pipe.url}/v1/requests/${id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(row.request.state, 'queued');
    assert.match(row.request.waiting?.reason ?? '', /offline since/);
    online = true;
    await until(read, (v) => v.accounts[0]?.availability.opus.state === 'available');
  } finally { await pipe.stop(); }
});

test('fix9 a reset at or before the hit becomes resetless in view and persisted holds', () => {
  const at = '2026-09-24T12:00:00.000Z';
  const ledger = new AllowanceLedger({ freshnessMs: 60_000, now: () => new Date(at) });
  for (const reset of [at, '2026-09-24T11:59:59.000Z']) {
    ledger.recordLimit('a', { bucket: 'five_hour', model: null, resetsAt: reset, observedAt: at });
    assert.deepEqual(ledger.view('a'), { state: 'exhausted', accountId: 'a', bucket: 'five_hour', until: null });
    assert.equal(ledger.limitHolds('a')[0]?.resetsAt, null);
  }
});

test('fix9 a pinned request waits past its patience on an expired stated reset', () => {
  let now = new Date('2026-09-24T12:00:00.000Z');
  const ledger = new AllowanceLedger({ freshnessMs: 60_000, now: () => now });
  const identities = new IdentityLedger({ now: () => now });
  identities.record('a', { signedIn: true, fingerprint: claude.fingerprint });
  ledger.record('a', [{ bucket: 'five_hour', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T12:00:00Z' }]);
  ledger.recordLimit('a', { bucket: 'five_hour', model: null, resetsAt: now.toISOString(), observedAt: now.toISOString() });
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-fix9-plan-')), 'store.sqlite'), { now: () => now });
  try {
    const row = store.submit(request);
    const status = { account: claude, running: 0, evidence: () => ({ accountId: 'a', model: 'opus', observedAt: now.toISOString(),
      verdict: availability({ account: claude, identities, allowances: ledger, model: 'opus', running: 0, now, identityMaxAgeMs: 60_000 }) }),
      limitHold: () => { const v = ledger.view('a'); return v.state === 'exhausted' ? { accountId: 'a', until: v.until } : null; } };
    const first = plan([row], [status], { now, pinWaitMs: 1, evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.equal(first.fail.length, 0);
    assert.equal(first.waits[0]?.until, null);
    const started = now.toISOString();
    now = new Date(now.getTime() + 10);
    const later = plan([{ ...row, waiting: { ...first.waits[0]!, stoppedSince: started } }], [status],
      { now, pinWaitMs: 1, evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.equal(later.fail.length, 0);
  } finally { store.close(); }
});

test('fix9 an offline probe vetoes earlier room and a pinned request waits beyond patience', () => {
  const since = '2026-09-24T12:00:00.000Z';
  const report = { accountId: 'a', provider: 'claude' as const, identity: { state: 'signed-in' as const, identity: { accountId: 'a', signedIn: true, fingerprint: claude.fingerprint, observedAt: since } },
    allowance: { state: 'offline' as const, reason: 'unreachable' }, version: { state: 'ok' as const, version: '2.1.280', outdated: false, minimum: null }, models: { state: 'none' as const, reason: 'no list' } };
  const health = probeHealth(report, 'opus', since);
  assert.match(health?.ok === false ? health.reason : '', /offline since/);
  const now = new Date('2026-09-24T12:00:01.000Z');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-fix9-offline-')), 'store.sqlite'), { now: () => now });
  try {
    const row = store.submit(request);
    const status = { account: claude, running: 0, evidence: () => ({ accountId: 'a', model: 'opus', observedAt: now.toISOString(), verdict: { state: 'unavailable' as const, reason: 'offline since ' + since, until: null } }) };
    const decision = plan([{ ...row, waiting: { reason: 'offline', until: null, stoppedSince: since } }], [status], { now, pinWaitMs: 1, evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.equal(decision.fail.length, 0);
    assert.equal(decision.waits.length, 1);
  } finally { store.close(); }
});

test('fix9 an ok official Codex list vetoes an absent model', () => {
  const report = { accountId: 'a', provider: 'codex' as const, identity: { state: 'signed-in' as const, identity: { accountId: 'a', signedIn: true, fingerprint: 'owner', observedAt: new Date().toISOString() } }, allowance: { state: 'ok' as const, buckets: [], measuredAt: new Date().toISOString(), verified: true },
    version: { state: 'ok' as const, version: '0.1.0', outdated: false, minimum: null }, models: { state: 'ok' as const, models: ['gpt-6-sol'] } };
  const health = probeHealth(report, 'gpt-7-sol', undefined);
  assert.equal(health?.ok, false);
  assert.match(health?.ok === false ? health.reason : '', /official list is: gpt-6-sol/);
});

test('fix9 malformed Claude and Codex login fields are unknown with reasons', async () => {
  const options = { env: { PATH: process.env.PATH, HOME: '/tmp' }, reachable: async () => true, now: () => new Date('2026-09-24T23:20:00Z') };
  for (const bad of [{ authMethod: undefined }, { authMethod: 4 }, { apiProvider: undefined }, { apiProvider: 4 }, { subscriptionType: undefined }, { subscriptionType: 4 }, { orgId: undefined, email: undefined }, { orgId: 4, email: 'valid@example.com' }]) {
    const path = fake('claude', { auth: { ...claudeAuth, ...bad } });
    const r = await probeAccount(claude, { ...options, cli: { claude: path } });
    assert.equal(r.identity.state, 'unknown', JSON.stringify(bad));
    assert.match(r.identity.reason ?? '', /missing|malformed|identity/i);
  }
  for (const account of [{ type: 'mystery' }, { type: 'chatgpt' }]) {
    const app = { ...codexApp, 'account/read': { result: { account, workspaceRouting: {} } } };
    const path = fake('codex', { app });
    const r = await probeAccount({ ...claude, provider: 'codex' }, { ...options, cli: { codex: path } });
    assert.equal(r.identity.state, 'unknown');
    assert.ok(r.identity.reason);
  }
});

test('fix9 official Codex list blocks an absent model in the dispatch verdict', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix9-model-'));
  const path = fake('codex', { app: codexApp });
  const pipe = await startPipe({ accounts: [{ ...claude, provider: 'codex', loginDir: root, fingerprint: sha8('<chatgptAccountId>') }],
    policy: { codex: { models: { 'gpt-7-sol': 'default' }, efforts: ['high'] } }, storePath: join(root, 'store.sqlite'), worktreeRoot: root,
    cli: { codex: path }, token, tickMs: 20 }).catch((e: Error) => { if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.skip('loopback bind unavailable'); return null; } throw e; });
  if (!pipe) return;
  try {
    const response = await fetch(`${pipe.url}/v1/accounts`, { headers: { authorization: `Bearer ${token}` } });
    const data = await response.json() as { accounts: Array<{ availability: { 'gpt-7-sol': { state: string; reason: string } } }> };
    assert.equal(data.accounts[0]?.availability['gpt-7-sol'].state, 'unavailable');
    assert.match(data.accounts[0]?.availability['gpt-7-sol'].reason ?? '', /official list.*gpt-6/u);
  } finally { await pipe.stop(); }
});

test('fix9 drain reports serviceGone if a running service vanishes', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 1) return new Response('{"draining":true,"drained":false,"running":1}');
    throw new TypeError('fetch failed'); };
  try { await assert.rejects(() => drainClient('http://127.0.0.1:8123', token, 0), /serviceGone/); }
  finally { globalThis.fetch = previous; }
});

test('fix9 a request read failure after claim records an unstarted attempt', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix9-read-'));
  const cli = fake('claude', { auth: claudeAuth });
  const oldGet = Store.prototype.get;
  const oldFinish = Store.prototype.finishAttempt;
  let thrown = false;
  let firstOutcome: unknown;
  Store.prototype.get = function (id) { if (!thrown && this.openAttempts().some((a) => a.requestId === id)) { thrown = true; throw new Error('injected read failure'); } return oldGet.call(this, id); };
  Store.prototype.finishAttempt = function (id, outcome) { firstOutcome ??= outcome; return oldFinish.call(this, id, outcome); };
  let pipe: Awaited<ReturnType<typeof startPipe>> | null = null;
  try {
    pipe = await startPipe({ accounts: [{ ...claude, loginDir: root }], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      storePath: join(root, 'store.sqlite'), worktreeRoot: root, cli: { claude: cli }, token, reachable: async () => true, tickMs: 20 });
    const post = await fetch(`${pipe.url}/v1/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(post.status, 201);
    await until(async () => firstOutcome, (v) => v !== undefined);
    assert.equal((firstOutcome as { kind: string }).kind, 'unstarted');
  } catch (e) { if (/(?:EACCES|EPERM|listen)/.test((e as Error).message)) t.skip('loopback bind unavailable'); else throw e; }
  finally { Store.prototype.get = oldGet; Store.prototype.finishAttempt = oldFinish; await pipe?.stop(); }
});

test('fix9 malformed model, effort and reason and bad request id encoding return 400', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix9-http-'));
  const store = new Store(join(root, 'store.sqlite'));
  let http: Awaited<ReturnType<typeof startHttp>> | null = null;
  try {
    http = await startHttp({ token, store, policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, accounts: () => [], models: () => ({}), accountIds: () => [], draining: () => false, drain: async () => {}, cancel: () => {} });
    for (const bad of [{ model: 3 }, { effort: [] }, { reason: {} }]) {
      const response: Response = await fetch(`${http.url}/v1/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...request, ...bad }) });
      assert.equal(response.status, 400, JSON.stringify(bad));
    }
    const response = await fetch(`${http.url}/v1/requests/%ZZ`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 400);
  } catch (e) { if (/(?:EACCES|EPERM|listen)/.test((e as Error).message)) t.skip('loopback bind unavailable'); else throw e; }
  finally { if (http) { const h = http; await new Promise<void>((resolve) => h.server.close(() => resolve())); } store.close(); }
});

test('fix9 MCP ping replies with an empty result', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (s: string) => { output += s; });
  try {
    child.stdin.end('{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
    await new Promise<void>((resolve, reject) => child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`))));
    assert.deepEqual(JSON.parse(output.trim()), { jsonrpc: '2.0', id: 9, result: {} });
  } finally { child.kill(); }
});

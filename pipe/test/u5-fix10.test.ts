import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainClient } from '../src/cli.ts';
import { probeHealth, resolveCli, startPipe } from '../src/service.ts';
import { Store, type NewRequest } from '../src/store.ts';
import type { ProbeReport } from '../src/probe.ts';

const token = 'x'.repeat(32);
const account = { id: 'a', provider: 'claude' as const, loginDir: '/tmp/a', fingerprint: 'owner', maxConcurrency: 1, enabled: true };
const request: NewRequest = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'test', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };
const evidence = (at: string) => ({ accountId: 'a', model: 'opus', observedAt: at, verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read'] });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 8_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw new Error('condition did not arrive'); await pause(20); }
}

function offlineCli(root: string): string {
  const path = join(root, 'claude');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const args = process.argv.slice(2), root = __dirname;
if (args[0] === '--version') process.stdout.write('2.1.280');
else if (args[0] === 'auth') { const out = fs.existsSync(p.join(root, 'signed-out')); process.stdout.write(JSON.stringify(out ? { loggedIn: false } : { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', orgId: 'owner' })); if (out) process.exitCode = 1; }
else if (args[0] === '-p' && args[1] === '/usage') {
  const when = (hours) => { const z = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(Date.now() + hours * 3600000)).map((x) => [x.type, x.value])); return z.month + ' ' + z.day + ' at ' + z.hour + ':' + z.minute + z.dayPeriod.toLowerCase(); };
  const result = 'Current session: 10% used · resets ' + when(3) + ' (America/New_York)' + String.fromCharCode(10) + 'Current week (all models): 20% used · resets ' + when(96) + ' (America/New_York)';
  process.stdout.write(JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result }));
} else {
  fs.readFileSync(0);
  const file = p.join(root, 'runs'); const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  if (n < 3) { fs.writeFileSync(p.join(root, 'last-failure'), String(Date.now())); process.stderr.write('ECONNRESET'); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }) + String.fromCharCode(10) + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }) + String.fromCharCode(10));
}
`);
  chmodSync(path, 0o755);
  return path;
}

test('fix10 latest probe blocks earlier room for every unreadable or wrong identity state', () => {
  const base: ProbeReport = { accountId: 'a', provider: 'claude',
    identity: { state: 'signed-in', identity: { accountId: 'a', signedIn: true, fingerprint: 'owner', observedAt: new Date().toISOString() } },
    allowance: { state: 'ok', buckets: [], measuredAt: new Date().toISOString(), verified: false },
    version: { state: 'ok', version: '2.1.280', minimum: null, outdated: false }, models: { state: 'none', reason: 'no list' } };
  for (const report of [
    { ...base, allowance: { state: 'unknown' as const, reason: 'unreadable' } },
    { ...base, identity: { state: 'unknown' as const, reason: 'malformed login' } },
    { ...base, identity: { state: 'signed-out' as const, identity: { accountId: 'a', signedIn: false, fingerprint: null, observedAt: new Date().toISOString() } } },
    { ...base, identity: { state: 'signed-in' as const, identity: { accountId: 'a', signedIn: true, fingerprint: 'other', observedAt: new Date().toISOString() } } },
  ]) assert.equal(probeHealth(report, 'opus', undefined, 'owner')?.ok, false);
});

test('fix10 store claim rejects available evidence beyond its freshness window', () => {
  const now = new Date('2026-09-24T12:02:00Z');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-fix10-store-')), 'store.sqlite'), { now: () => now, evidenceMaxAgeMs: 60_000 });
  try {
    const row = store.submit(request);
    const result = store.startAttempt(row.id, account, evidence('2026-09-24T12:00:00Z'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /stale/);
  } finally { store.close(); }
});

test('fix10 offline outcomes do not use the attempt budget', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-fix10-offline-')), 'store.sqlite'), { now: () => now, maxAttempts: 1, retryBackoffMs: 0 });
  try {
    const row = store.submit(request);
    for (let i = 0; i < 4; i++) {
      const started = store.startAttempt(row.id, account, evidence(now.toISOString()));
      assert.equal(started.ok, true);
      if (!started.ok) return;
      store.finishAttempt(started.attempt.id, { kind: 'failed', errorKind: 'offline', message: 'network disconnected' });
      assert.equal(store.get(row.id)?.state, 'queued');
    }
    const started = store.startAttempt(row.id, account, evidence(now.toISOString()));
    assert.equal(started.ok, true);
    if (started.ok) store.finishAttempt(started.attempt.id, { kind: 'completed', result: 'OK' });
    assert.equal(store.get(row.id)?.state, 'completed');
  } finally { store.close(); }
});

test('fix10 configured bare CLI resolves on configured PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix10-path-'));
  const cli = join(root, 'claude');
  writeFileSync(cli, `#!${process.execPath}\n`); chmodSync(cli, 0o755);
  assert.equal(resolveCli({ claude: 'claude' }, { PATH: root }).claude, cli);
});

test('fix10 zero running is not a drain confirmation', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 1) return new Response('{"draining":true,"drained":false,"running":0}'); throw new TypeError('connection lost'); };
  try { await assert.rejects(() => drainClient('http://127.0.0.1:8123', token, 1), /serviceGone/); assert.equal(calls, 2); }
  finally { globalThis.fetch = previous; }
});

test('fix10 repeated offline jobs wait for later probes and eventually complete', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix10-jobs-'));
  const cli = offlineCli(root);
  const fingerprint = createHash('sha256').update('owner').digest('hex').slice(0, 8);
  const pipe = await startPipe({ accounts: [{ ...account, loginDir: root, fingerprint }],
    policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: join(root, 'store.sqlite'), worktreeRoot: root,
    cli: { claude: cli }, token, reachable: async () => !existsSync(join(root, 'last-failure')) || Date.now() - Number(readFileSync(join(root, 'last-failure'), 'utf8')) > 150,
    tickMs: 20, probeIntervalMs: 100, probeRetryMs: 25, pinWaitMs: 40, maxAttempts: 1, retryBackoffMs: 25 }).catch((e: Error) => {
    if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.skip('loopback bind unavailable'); return null; } throw e;
  });
  if (!pipe) return;
  const read = async (path: string) => (await (await fetch(`${pipe.url}${path}`, { headers: { authorization: `Bearer ${token}` } })).json());
  try {
    const submitted = await fetch(`${pipe.url}/v1/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const id = (await submitted.json()).request.id;
    await until(() => read('/v1/accounts'), (v) => /offline since/.test(v.accounts[0]?.availability.opus.reason ?? ''));
    // An offline failure makes the job wait, never fail: with maxAttempts 1 it still completes after three of them.
    // Whether a later probe has already dispatched it again is timing, so only a final state is an error here.
    assert.ok(['queued', 'running'].includes((await read(`/v1/requests/${id}`)).request.state));
    const done = await until(() => read(`/v1/requests/${id}`), (v) => v.request.state === 'completed' || v.request.state === 'failed');
    assert.equal(done.request.state, 'completed', JSON.stringify(done.request.error));
    assert.equal(done.request.result, 'OK');
    assert.equal(Number(readFileSync(join(root, 'runs'), 'utf8')), 4);
  } finally { await pipe.stop(); }
});

test('fix10 a reached signed-out probe clears the earlier offline hold and normal pin patience resumes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix10-reached-'));
  const cli = offlineCli(root);
  const fingerprint = createHash('sha256').update('owner').digest('hex').slice(0, 8);
  let online = true;
  const pipe = await startPipe({ accounts: [{ ...account, loginDir: root, fingerprint }],
    policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: join(root, 'store.sqlite'), worktreeRoot: root,
    cli: { claude: cli }, token, reachable: async () => online, tickMs: 20, probeIntervalMs: 100, probeRetryMs: 25, pinWaitMs: 60 }).catch((e: Error) => {
    if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.skip('loopback bind unavailable'); return null; } throw e;
  });
  if (!pipe) return;
  const accounts = async () => (await (await fetch(`${pipe.url}/v1/accounts`, { headers: { authorization: `Bearer ${token}` } })).json()).accounts;
  try {
    await until(accounts, (v) => v[0]?.availability.opus.state === 'available');
    online = false;
    await until(accounts, (v) => /offline since/.test(v[0]?.availability.opus.reason ?? ''));
    writeFileSync(join(root, 'signed-out'), 'yes'); online = true;
    const reached = await until(accounts, (v) => /signed out/.test(v[0]?.availability.opus.reason ?? ''));
    assert.doesNotMatch(reached[0].availability.opus.reason, /offline since/);
    const submitted = await fetch(`${pipe.url}/v1/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const id = (await submitted.json()).request.id;
    const failed = await until(async () => (await (await fetch(`${pipe.url}/v1/requests/${id}`, { headers: { authorization: `Bearer ${token}` } })).json()).request,
      (v) => v.state === 'failed');
    assert.match(failed.error.message, /signed out/);
  } finally { await pipe.stop(); }
});

test('fix10 drain of a real idle pipe confirms success', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix10-drain-'));
  const pipe = await startPipe({ accounts: [], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: join(root, 'store.sqlite'), worktreeRoot: root, cli: {}, token }).catch((e: Error) => {
    if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.skip('loopback bind unavailable'); return null; } throw e;
  });
  if (!pipe) return;
  try { assert.deepEqual(await drainClient(pipe.url, token, 25), { draining: true, drained: true }); }
  finally { await pipe.stop(); }
});

test('fix10 drain waits through a real open attempt and then confirms success', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix10-running-drain-'));
  const path = join(root, 'store.sqlite');
  const pipe = await startPipe({ accounts: [{ ...account, loginDir: root, enabled: false }],
    policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: path, worktreeRoot: root,
    cli: {}, env: { PATH: root }, token, tickMs: 20 }).catch((e: Error) => {
    if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.skip('loopback bind unavailable'); return null; } throw e;
  });
  if (!pipe) return;
  const other = new Store(path);
  try {
    const row = other.submit(request);
    const started = other.startAttempt(row.id, account, evidence(new Date().toISOString()));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const draining = drainClient(pipe.url, token, 25);
    const status = await (await fetch(`${pipe.url}/v1/drain?wait=25`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(status, { draining: true, drained: false, running: 1 });
    other.finishAttempt(started.attempt.id, { kind: 'completed', result: 'OK' });
    assert.deepEqual(await draining, { draining: true, drained: true });
  } finally { other.close(); await pipe.stop(); }
});

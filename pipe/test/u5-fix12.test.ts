import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceOfflineMark, classifyAndMarkOfflineOutcome, classifyOfflineOutcome, journalOf, persistCompletedOutcome, startPipe } from '../src/service.ts';
import { Store, type NewRequest } from '../src/store.ts';

const token = 'x'.repeat(32);
const account = { id: 'a', provider: 'claude' as const, loginDir: '/tmp/a', fingerprint: createHash('sha256').update('owner').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true };
const request: NewRequest = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'test', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };
const evidence = (at: string) => ({ accountId: 'a', model: 'opus', observedAt: at, verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read'] });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T> | T, accept: (v: T) => boolean, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw new Error('condition did not arrive'); await pause(20); }
}
function fakeCli(root: string): string {
  const cli = join(root, 'claude');
  writeFileSync(cli, `#!${process.execPath}\nconst fs = require('fs'), p = require('path');\nconst a = process.argv.slice(2);\nif (a[0] === '--version') console.log('2.1.280');\nelse if (a[0] === 'auth') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',orgId:'owner'}));\nelse if (a[0] === '-p' && a[1] === '/usage') { const when = (h) => { const z = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(new Date(Date.now()+h*3600000)).map(x=>[x.type,x.value])); return z.month+' '+z.day+' at '+z.hour+':'+z.minute+z.dayPeriod.toLowerCase(); }; console.log(JSON.stringify({is_error:false,num_turns:0,total_cost_usd:0,result:'Current session: 10% used · resets '+when(3)+' (America/New_York)\\nCurrent week (all models): 20% used · resets '+when(96)+' (America/New_York)'})); }\nelse { fs.readFileSync(0); fs.writeFileSync(p.join(__dirname,'runs'),String(1+(Number(fs.existsSync(p.join(__dirname,'runs')) && fs.readFileSync(p.join(__dirname,'runs'),'utf8'))||0))); console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-opus-5-5'})+'\\n'+JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK'})); }\n`);
  chmodSync(cli, 0o755);
  return cli;
}

test('fix12 journaled completion retries on a later tick and drain resolves', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix12-tick-')), storePath = join(root, 'store.sqlite'), cli = fakeCli(root);
  const original = Store.prototype.finishAttempt;
  let failWrites = true;
  Store.prototype.finishAttempt = function (id, outcome) { if (failWrites) throw new Error('injected store failure'); return original.call(this, id, outcome); };
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  try {
    try { pipe = await startPipe({ accounts: [{ ...account, loginDir: root }], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath, worktreeRoot: root, cli: { claude: cli }, token, port: 0, reachable: async () => true, tickMs: 20 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('loopback bind unavailable'); return; } throw e; }
    const headers = { authorization: `Bearer ${token}` };
    const submitted = await fetch(`${pipe.url}/v1/requests`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const id = (await submitted.json()).request.id as string;
    await until(() => existsSync(journalOf(storePath)), Boolean);
    const draining = fetch(`${pipe.url}/v1/drain?wait=5000`, { method: 'POST', headers });
    failWrites = false;
    await until(async () => (await (await fetch(`${pipe!.url}/v1/requests/${id}`, { headers })).json()).request.state, (v) => v === 'completed');
    assert.equal((await (await draining).json()).drained, true);
    assert.equal(readFileSync(join(root, 'runs'), 'utf8'), '1');
  } finally { failWrites = false; Store.prototype.finishAttempt = original; await pipe?.stop(); }
});

test('fix12 an offline failure marks the account before its reachability check and a later probe clears it', async () => {
  const marks = new Map<string, string>();
  const kind = await classifyAndMarkOfflineOutcome(marks, 'a', 'claude', async () => {
    assert.ok(marks.has('a'), 'the failure has its own mark before the check begins');
    return false;
  });
  assert.equal(kind, 'offline');
  advanceOfflineMark(marks, 'a', false, Date.parse(marks.get('a')!) + 1);
  assert.equal(marks.has('a'), false);
});

test('fix12 journaled live outcomes remain pending until the store accepts them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix12-pending-')), path = join(root, 'store.sqlite');
  const pending = new Map([['attempt', { kind: 'completed' as const, result: 'OK' }]]);
  const journaled = new Set<string>();
  let fail = true, writes = 0;
  const store = { finishAttempt: () => { writes++; if (fail) throw new Error('injected store failure'); } };
  await persistCompletedOutcome(store as never, pending, journalOf(path), () => {}, { journaled, recoveryPath: path });
  assert.equal(pending.size, 1);
  assert.equal(journaled.has('attempt'), true);
  fail = false;
  await persistCompletedOutcome(store as never, pending, journalOf(path), () => {}, { journaled, recoveryPath: path });
  assert.equal(pending.size, 0);
  assert.ok(writes >= 2);
});

test('fix12 a reachable dropped stream spends a retry without avoiding its account', async () => {
  const kind = await classifyOfflineOutcome('claude', async () => true);
  assert.equal(kind, 'transient');
  let now = new Date('2026-09-25T12:00:00.000Z');
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix12-retry-'));
  const store = new Store(join(root, 'store.sqlite'), { now: () => now, maxAttempts: 2, retryBackoffMs: 500 });
  try {
    const row = store.submit(request);
    const first = store.startAttempt(row.id, account, evidence(now.toISOString())); assert.equal(first.ok, true);
    if (!first.ok) return;
    store.finishAttempt(first.attempt.id, { kind: 'failed', errorKind: kind, message: 'ECONNRESET' });
    assert.equal(store.get(row.id)?.state, 'queued');
    assert.deepEqual(store.get(row.id)?.avoid, []);
    assert.equal(store.get(row.id)?.notBefore, '2026-09-25T12:00:00.500Z');
    const second = store.startAttempt(row.id, account, evidence(now.toISOString()));
    assert.equal(second.ok, false, 'backoff is honored');
    now = new Date('2026-09-25T12:00:00.501Z');
    const retried = store.startAttempt(row.id, account, evidence(now.toISOString()));
    assert.equal(retried.ok, true);
    if (!retried.ok) return;
    store.finishAttempt(retried.attempt.id, { kind: 'failed', errorKind: kind, message: 'ECONNRESET again' });
    assert.equal(store.get(row.id)?.state, 'failed');
    assert.deepEqual(store.get(row.id)?.avoid, []);
    assert.match(store.get(row.id)?.error?.message ?? '', /gave up after 2 attempts/);
    const changing = store.submit({ ...request, mutating: true, cwd: root, prompt: 'change' });
    const attempted = store.startAttempt(changing.id, account, evidence(now.toISOString()));
    assert.equal(attempted.ok, true);
    if (attempted.ok) {
      store.finishAttempt(attempted.attempt.id, { kind: 'failed', errorKind: kind, message: 'ECONNRESET' });
      assert.equal(store.get(changing.id)?.state, 'failed');
      assert.match(store.get(changing.id)?.error?.message ?? '', /inspect/);
    }
  } finally { store.close(); }
});

test('fix12 an overlapping old probe cannot clear a newer offline failure, but a later probe can', () => {
  const marks = new Map<string, string>();
  advanceOfflineMark(marks, 'a', true, 2_000);
  advanceOfflineMark(marks, 'a', false, 1_000);
  assert.equal(marks.get('a'), new Date(2_000).toISOString());
  advanceOfflineMark(marks, 'a', true, 3_000);
  advanceOfflineMark(marks, 'a', false, 2_500);
  assert.equal(marks.get('a'), new Date(3_000).toISOString());
  advanceOfflineMark(marks, 'a', false, 3_001);
  assert.equal(marks.has('a'), false);
});

test('fix12 failed store and journal writes leave a durable completion replayed before reconciliation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix12-recovery-')), storePath = join(root, 'store.sqlite');
  const store = new Store(storePath), row = store.submit(request);
  const started = store.startAttempt(row.id, account, evidence(new Date().toISOString())); assert.equal(started.ok, true);
  if (!started.ok) { store.close(); return; }
  const pending = new Map([[started.attempt.id, { kind: 'completed' as const, result: 'OK' }]]);
  const original = store.finishAttempt;
  store.finishAttempt = () => { throw new Error('injected store failure'); };
  try { await persistCompletedOutcome(store, pending, journalOf(storePath), () => {}, { recoveryPath: storePath,
    journalWrite: () => { throw new Error('injected journal failure'); } }); }
  finally { store.finishAttempt = original; store.close(); }
  const recoveryFile = readdirSync(root).find((name) => name.startsWith('store.sqlite.pipe-outcome-'));
  assert.ok(recoveryFile);
  assert.equal(statSync(join(root, recoveryFile)).mode & 0o777, 0o600);
  const pipe = await startPipe({ accounts: [], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath, worktreeRoot: root, cli: {}, token, port: 0 }).catch((e: Error) => {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('loopback bind unavailable; replay occurred before bind'); return null; } throw e;
  });
  try { const reopened = new Store(storePath); try { assert.equal(reopened.get(row.id)?.state, 'completed'); assert.equal(reopened.attempts(row.id).length, 1); assert.equal(existsSync(join(root, recoveryFile)), false); } finally { reopened.close(); } }
  finally { await pipe?.stop(); }
});

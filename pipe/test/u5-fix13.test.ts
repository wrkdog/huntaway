import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyAndMarkOfflineOutcome, journalOf, markFailedStop, persistCompletedOutcome, recoverFailedStop, startPipe } from '../src/service.ts';
import { LAST_INSTANT, Store, type AttemptOutcome, type NewRequest } from '../src/store.ts';

const root = () => mkdtempSync(join(tmpdir(), 'pipe-fix13-'));
const account = { id: 'a', provider: 'claude' as const, loginDir: '/tmp/a', fingerprint: createHash('sha256').update('owner').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true };
const request: NewRequest = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'test', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };
const evidence = (at: string) => ({ accountId: 'a', model: 'opus', observedAt: at, verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read'] });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('fix13 operator recovery replays a journaled completion before resolving another failed outcome', async () => {
  const path = join(root(), 'store.sqlite');
  const store = new Store(path);
  const a = store.submit(request), b = store.submit({ ...request, prompt: 'B' });
  const first = store.startAttempt(a.id, account, evidence(new Date().toISOString()));
  const second = store.startAttempt(b.id, { ...account, maxConcurrency: 2 }, evidence(new Date().toISOString()));
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  const broken = { finishAttempt: () => { throw new Error('store unavailable'); } };
  const journaled = new Set<string>();
  await persistCompletedOutcome(broken, new Map([[first.attempt.id, { kind: 'completed' as const, result: 'A' }]]),
    journalOf(path), () => {}, { journaled, recoveryPath: path });
  assert.equal(journaled.has(first.attempt.id), true);
  const blockedFile = `${path}.pipe-outcome-${createHash('sha256').update(second.attempt.id).digest('hex')}`;
  mkdirSync(blockedFile);
  await assert.rejects(() => persistCompletedOutcome(broken,
    new Map([[second.attempt.id, { kind: 'completed' as const, result: 'B' }]]), journalOf(path), () => {},
    { journaled, recoveryPath: path, journalWrite: () => { throw new Error('journal unavailable'); } }));
  rmdirSync(blockedFile);
  markFailedStop(path, [first.attempt.id, second.attempt.id]);
  store.close();
  assert.throws(() => recoverFailedStop(path, second.attempt.id, { kind: 'completed', result: 7 } as unknown as AttemptOutcome));
  assert.deepEqual(JSON.parse(readFileSync(`${path}.pipe-failed-stop`, 'utf8')), [second.attempt.id], 'the recorded journal entry is dropped before an operator retry');
  assert.deepEqual(recoverFailedStop(path, second.attempt.id, { kind: 'completed', result: 'B' }), []);
  const reopened = new Store(path);
  try {
    assert.equal(reopened.get(a.id)?.state, 'completed');
    assert.equal(reopened.get(a.id)?.result, 'A');
    assert.equal(reopened.get(b.id)?.result, 'B');
    assert.equal(existsSync(journalOf(path)), false);
  } finally { reopened.close(); }
});

test('fix13 a live failed-stop marker names only outcomes still unsaved', () => {
  const path = join(root(), 'store.sqlite');
  markFailedStop(path, ['journaled', 'unsaved'], new Set(['journaled']));
  assert.deepEqual(JSON.parse(readFileSync(`${path}.pipe-failed-stop`, 'utf8')), ['unsaved']);
  markFailedStop(path, ['journaled'], new Set(['journaled']));
  assert.equal(existsSync(`${path}.pipe-failed-stop`), false);
});

test('fix13 a transient reachability result clears an unconfirmed offline mark', async () => {
  const marks = new Map([['a', new Date(Date.now() - 1000).toISOString()]]);
  assert.equal(await classifyAndMarkOfflineOutcome(marks, 'a', 'claude', async () => true), 'transient');
  assert.equal(marks.has('a'), false);
  const prior = new Date(Date.now() - 1000).toISOString();
  const confirmed = new Map([['a', prior]]);
  marks.set('a', prior);
  assert.equal(await classifyAndMarkOfflineOutcome(marks, 'a', 'claude', async () => true, confirmed), 'transient');
  assert.equal(marks.get('a'), prior);
});

test('fix13 overlapping transient classifications retain the prior confirmed mark', async () => {
  const prior = new Date(Date.now() - 2000).toISOString();
  const marks = new Map([['a', prior]]), confirmed = new Map([['a', prior]]);
  let settleFirst!: (reachable: boolean) => void;
  const first = classifyAndMarkOfflineOutcome(marks, 'a', 'claude', () => new Promise<boolean>((resolve) => { settleFirst = resolve; }), confirmed);
  await pause(0);
  const pending = marks.get('a');
  assert.notEqual(pending, prior);
  await classifyAndMarkOfflineOutcome(marks, 'a', 'claude', async () => true, confirmed);
  assert.equal(marks.get('a'), prior, 'a transient restores confirmed evidence, not the first pending mark');
  settleFirst(true);
  await first;
  assert.equal(marks.get('a'), prior);
});

test('fix13 a restart behind the stored clock blocks probes and dispatch until catch-up', async (t) => {
  const dir = root(), path = join(dir, 'store.sqlite'), cli = join(dir, 'claude');
  // The stored clock is ahead by a margin that a loaded machine's startup cannot use up; the "no probe yet" checks
  // count only while that is true.
  const ahead = Date.now() + 3000;
  const early = () => Date.now() < ahead - 500;
  const seed = new Store(path, { now: () => new Date(ahead) });
  const row = seed.submit(request); seed.close();
  writeFileSync(cli, `#!${process.execPath}\nconst fs=require('fs'); fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, process.argv[2]+'\\n'); process.exit(1);\n`);
  chmodSync(cli, 0o755);
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  try {
    try { pipe = await startPipe({ accounts: [{ ...account, loginDir: dir }], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: path, worktreeRoot: dir, cli: { claude: cli }, token: 'x'.repeat(32), port: 0, reachable: async () => true, tickMs: 20, probeRetryMs: 100 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('loopback bind unavailable'); return; } throw e; }
    if (early()) assert.equal(existsSync(join(dir, 'calls')), false, 'no CLI probe while the persisted mark is in the future');
    const asked = early();
    const accounts = await (await fetch(`${pipe.url}/v1/accounts`, { headers: { authorization: `Bearer ${'x'.repeat(32)}` } })).json();
    if (asked) {
      assert.equal(accounts.accounts[0].allowance.state, 'unknown');
      assert.match(accounts.accounts[0].availability.opus.reason, /clock.*high-water/);
    }
    await pause(100);
    if (early()) assert.equal(existsSync(join(dir, 'calls')), false, 'still no probe before catch-up');
    const open = new Store(path);
    try { assert.equal(open.get(row.id)?.state, 'queued'); } finally { open.close(); }
    const until = ahead + 10_000;
    while (Date.now() < until && !existsSync(join(dir, 'calls'))) await pause(25);
    assert.equal(existsSync(join(dir, 'calls')), true, 'probing resumes after catch-up');
  } finally { await pipe?.stop(); }
});

test('fix13 the stored clock mark remains a gate across Store reopen', () => {
  const path = join(root(), 'store.sqlite');
  let time = new Date('2026-09-25T12:00:02.000Z');
  const first = new Store(path, { now: () => time });
  first.submit(request); first.close();
  time = new Date('2026-09-25T12:00:01.000Z');
  const again = new Store(path, { now: () => time });
  try {
    assert.equal(again.clockIsCurrent(), false);
    time = new Date('2026-09-25T12:00:02.000Z');
    assert.equal(again.clockIsCurrent(), true);
    assert.equal(again.clockIsCurrent(new Date('2026-09-25T12:00:01.000Z')), false, 'an earlier probe stamp remains unknown after catch-up');
  } finally { again.close(); }
});

test('fix13 offline and transient backoff deadlines stay inside the last instant', () => {
  const now = new Date(LAST_INSTANT - 10);
  const store = new Store(join(root(), 'store.sqlite'), { now: () => now, retryBackoffMs: 60_000, maxAttempts: 2 });
  try {
    for (const kind of ['offline', 'transient'] as const) {
      const row = store.submit({ ...request, prompt: kind });
      const started = store.startAttempt(row.id, account, evidence(now.toISOString()));
      assert.equal(started.ok, true);
      if (!started.ok) continue;
      store.finishAttempt(started.attempt.id, { kind: 'failed', errorKind: kind, message: kind });
      assert.equal(store.get(row.id)?.notBefore, new Date(LAST_INSTANT).toISOString());
    }
  } finally { store.close(); }
});

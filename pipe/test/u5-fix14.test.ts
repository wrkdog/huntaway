import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan } from '../src/queue.ts';
import { classifyAndMarkOfflineOutcome, journalOf, persistCompletedOutcome, startPipe } from '../src/service.ts';
import { Store, type AttemptOutcome, type NewRequest } from '../src/store.ts';

const root = () => mkdtempSync(join(tmpdir(), 'pipe-fix14-'));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const account = { id: 'a', provider: 'claude' as const, loginDir: '/tmp/a', fingerprint: 'owner', maxConcurrency: 1, enabled: true };
const request: NewRequest = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'test', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };

async function until(read: () => number, want: (n: number) => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!want(read())) { if (Date.now() > end) throw new Error('condition did not arrive'); await pause(10); }
}

/** The service tests exercise its timers and store without requiring a TCP bind. */
async function withoutHttp<T>(work: () => Promise<T>): Promise<T> {
  const listen = Server.prototype.listen, address = Server.prototype.address, close = Server.prototype.close;
  Server.prototype.listen = function (this: Server, ...args: Parameters<typeof listen>) { const cb = args.at(-1); if (typeof cb === 'function') queueMicrotask(() => cb()); return this; } as typeof listen;
  Server.prototype.address = function () { return { address: '127.0.0.1', family: 'IPv4', port: 1 }; };
  Server.prototype.close = function (this: Server, cb?: (err?: Error) => void) { queueMicrotask(() => cb?.()); return this; } as typeof close;
  try { return await work(); }
  finally { Server.prototype.listen = listen; Server.prototype.address = address; Server.prototype.close = close; }
}

function failingCli(dir: string): string {
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, 'x'); process.exit(1);\n`);
  chmodSync(path, 0o755);
  return path;
}

const serviceConfig = (dir: string, cli: string) => ({ accounts: [{ ...account, loginDir: dir }],
  policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: join(dir, 'store.sqlite'),
  worktreeRoot: dir, cli: { claude: cli }, token: 'x'.repeat(32), tickMs: 1000, probeIntervalMs: 1000, probeRetryMs: 20 });

test('fix14 confirmed offline survives overlapping transient classifications in both completion orders', async () => {
  for (const offlineStartsFirst of [true, false]) for (const offlineFinishesFirst of [true, false]) {
    const marks = new Map<string, string>(), confirmed = new Map<string, string>();
    let finishOffline!: (reachable: boolean) => void, finishTransient!: (reachable: boolean) => void;
    const beginOffline = () => classifyAndMarkOfflineOutcome(marks, 'a', 'claude', () => new Promise<boolean>((resolve) => { finishOffline = resolve; }), confirmed);
    const beginTransient = () => classifyAndMarkOfflineOutcome(marks, 'a', 'claude', () => new Promise<boolean>((resolve) => { finishTransient = resolve; }), confirmed);
    let offline!: Promise<'offline' | 'transient'>, transient!: Promise<'offline' | 'transient'>;
    if (offlineStartsFirst) { offline = beginOffline(); await pause(0); transient = beginTransient(); }
    else { transient = beginTransient(); await pause(0); offline = beginOffline(); }
    await pause(0);
    if (offlineFinishesFirst) { finishOffline(false); await offline; finishTransient(true); await transient; }
    else { finishTransient(true); await transient; finishOffline(false); await offline; }
    assert.equal(marks.get('a'), confirmed.get('a'), `confirmed offline survives start=${offlineStartsFirst}, finish=${offlineFinishesFirst}`);
    assert.ok(marks.has('a'));
  }
});

test('fix14 a clock-gated probe retries before the slower service tick', async () => withoutHttp(async () => {
  const dir = root(), cli = failingCli(dir), path = join(dir, 'store.sqlite'), original = Store.prototype.clockIsCurrent;
  const seed = new Store(path, { now: () => new Date(Date.now() + 60_000) });
  seed.submit(request); seed.close();
  let caughtUp = false;
  Store.prototype.clockIsCurrent = function () { return caughtUp; };
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  try {
    pipe = await startPipe({ ...serviceConfig(dir, cli), tickMs: 5000 });
    assert.equal(existsSync(join(dir, 'calls')), false);
    caughtUp = true;
    await until(() => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls')).length : 0, (n) => n > 0, 3500);
  } finally { Store.prototype.clockIsCurrent = original; await pipe?.stop(); }
}));

test('fix14 a probe timer turns a store read exception into a logged rejection', async () => withoutHttp(async () => {
  const dir = root(), cli = failingCli(dir), original = Store.prototype.clockIsCurrent;
  let fail = false, sawLog = false;
  const stderr = process.stderr.write;
  process.stderr.write = function (chunk: string | Uint8Array, ...args: unknown[]) {
    if (String(chunk).includes('clock read injected')) { sawLog = true; return true; }
    return Reflect.apply(stderr, process.stderr, [chunk, ...args]);
  } as typeof stderr;
  Store.prototype.clockIsCurrent = function (...args) { if (fail) { fail = false; throw new Error('clock read injected'); } return original.apply(this, args); };
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  try {
    pipe = await startPipe({ ...serviceConfig(dir, cli), tickMs: 80 });
    const firstCalls = readFileSync(join(dir, 'calls')).length;
    fail = true;
    await until(() => Number(sawLog), (n) => n === 1, 700);
    await until(() => readFileSync(join(dir, 'calls')).length, (n) => n > firstCalls, 700);
  } finally { fail = false; Store.prototype.clockIsCurrent = original; process.stderr.write = stderr; await pipe?.stop(); }
}));

test('fix14 each pending outcome gets a durable write despite an earlier failure', async () => {
  const dir = root(), path = join(dir, 'store.sqlite');
  const pending = new Map<string, AttemptOutcome>([['blocked', { kind: 'completed', result: 'A' }], ['later', { kind: 'completed', result: 'B' }]]);
  const blocked = `${path}.pipe-outcome-${createHash('sha256').update('blocked').digest('hex')}`;
  mkdirSync(blocked);
  const journaled = new Set<string>();
  try {
    await assert.rejects(() => persistCompletedOutcome({ finishAttempt: () => { throw new Error('store down'); } }, pending,
      journalOf(path), () => {}, { journaled, recoveryPath: path, journalWrite: () => { throw new Error('journal down'); } }));
    assert.equal(pending.has('later'), true);
    assert.equal(existsSync(`${path}.pipe-outcome-${createHash('sha256').update('later').digest('hex')}`), true);
    assert.equal(journaled.has('later'), true);
  } finally { rmdirSync(blocked); }
});

test('fix14 a pending limit hold journals its outcome before any store completion', async () => {
  const dir = root(), path = join(dir, 'store.sqlite'), pending = new Map<string, AttemptOutcome>([['attempt', { kind: 'failed', errorKind: 'rate_limited', message: 'held', limitRecorded: true }]]);
  const journaled = new Set<string>();
  let writes = 0;
  await persistCompletedOutcome({ finishAttempt: () => { writes++; } } as never, pending, journalOf(path), () => {},
    { journaled, recoveryPath: path, pendingHolds: new Set(['a']), accountId: 'a', heldAttemptId: 'attempt' });
  assert.equal(writes, 0);
  assert.equal(journaled.has('attempt'), true);
  assert.equal(pending.has('attempt'), true);
  assert.equal(existsSync(journalOf(path)), true);
});

test('fix14 pin patience starts when an offline mark lifts', () => {
  const dir = root(), now = new Date('2026-09-25T12:10:00.000Z');
  const store = new Store(join(dir, 'store.sqlite'), { now: () => now });
  try {
    const row = store.submit(request);
    const old = new Date(now.getTime() - 60_000).toISOString();
    const offline = { account, running: 0, evidence: () => ({ accountId: 'a', model: 'opus', observedAt: now.toISOString(), verdict: { state: 'unavailable' as const, reason: `offline since ${old}`, until: null } }) };
    const options = { now, pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() };
    const waiting = plan([{ ...row, waiting: { reason: 'offline', until: null, stoppedSince: old } }], [offline], options).waits[0]!;
    assert.equal(waiting.stoppedSince, undefined, 'offline waiting does not spend pin patience');
    const signedOut = { ...offline, evidence: () => ({ accountId: 'a', model: 'opus', observedAt: now.toISOString(), verdict: { state: 'unavailable' as const, reason: 'signed out', until: null } }) };
    const lifted = plan([{ ...row, waiting }], [signedOut], options);
    assert.equal(lifted.fail.length, 0);
    assert.equal(lifted.waits[0]?.stoppedSince, now.toISOString());
  } finally { store.close(); }
});

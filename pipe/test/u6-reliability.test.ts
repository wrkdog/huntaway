import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type NewRequest } from '../src/store.ts';
import type { AccountConfig } from '../src/identity.ts';
import { requestJsonReconnecting } from '../src/client.ts';
import { plan } from '../src/queue.ts';

const account: AccountConfig = { id: 'a', provider: 'claude', loginDir: '/tmp/a', fingerprint: 'a', maxConcurrency: 1, enabled: true };
const input: NewRequest = { requester: 'r', project: 'p', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'check', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };
const evidence = { accountId: 'a', model: 'opus', observedAt: '2026-09-25T00:00:00.000Z', verdict: { state: 'available' as const, headroom: 1 }, grant: ['Read'] };

test('auth retries its pin without avoidance or attempt spending, then exhausts the wait budget', () => {
  let clock = Date.parse(evidence.observedAt);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u6-store-')), 'pipe.sqlite'),
    { now: () => new Date(clock), maxAttempts: 1, maxLimits: 3 });
  try {
    const id = store.submit(input).id;
    for (let n = 1; n <= 3; n++) {
      clock = Math.max(clock, store.authHoldUntil('a') + 1);
      const start = store.startAttempt(id, account, { ...evidence, observedAt: new Date(clock).toISOString() });
      assert.equal(start.ok, true);
      if (!start.ok) break;
      const row = store.finishAttempt(start.attempt.id, { kind: 'failed', errorKind: 'auth', message: 'sign-in failed' }).request;
      assert.deepEqual(row.avoid, []);
      assert.equal(row.state, n === 3 ? 'failed' : 'queued');
      if (n === 3) assert.match(row.error?.message ?? '', /sign-in/i);
    }
  } finally { store.close(); }
});

test('auth uses the wait budget without spending an ordinary retry', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u6-tries-')), 'pipe.sqlite'),
    { now: () => new Date(evidence.observedAt), maxAttempts: 2, maxLimits: 3, retryBackoffMs: 0 });
  try {
    const id = store.submit(input).id;
    for (const errorKind of ['auth', 'transient'] as const) {
      const start = store.startAttempt(id, account, evidence);
      assert.equal(start.ok, true);
      if (!start.ok) break;
      const row = store.finishAttempt(start.attempt.id, { kind: 'failed', errorKind, message: errorKind }).request;
      assert.equal(row.state, 'queued');
    }
  } finally { store.close(); }
});

test('auth holds start after two recorded failures, double after expiry, and clear on completion', () => {
  let clock = Date.parse(evidence.observedAt);
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u6-holds-')), 'pipe.sqlite'),
    { now: () => new Date(clock), authHoldMs: 1000, authHoldMaxMs: 8000 });
  const finish = (outcome: Parameters<Store['finishAttempt']>[1]) => {
    const start = store.startAttempt(store.submit(input).id, account, { ...evidence, observedAt: new Date(clock).toISOString() });
    assert.equal(start.ok, true);
    if (start.ok) store.finishAttempt(start.attempt.id, outcome);
  };
  try {
    const failed = { kind: 'failed' as const, errorKind: 'auth' as const, message: 'sign-in failed' };
    finish(failed);
    assert.equal(store.authHoldUntil('a'), 0);
    clock += 1000;
    finish(failed);
    assert.equal(store.authHoldUntil('a'), clock + 1000);
    clock += 2000;
    finish(failed);
    assert.equal(store.authHoldUntil('a'), clock + 2000);
    clock = store.authHoldUntil('a') + 1;
    finish({ kind: 'completed', result: 'OK' });
    assert.equal(store.authHoldUntil('a'), 0);
  } finally { store.close(); }
});

test('the account hold persists in the record after reopening it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pipe-u6-reopen-')), 'pipe.sqlite');
  let clock = Date.parse(evidence.observedAt);
  let store = new Store(path, { now: () => new Date(clock), authHoldMs: 10_000, authHoldMaxMs: 20_000 });
  try {
    const id = store.submit(input).id;
    for (let n = 0; n < 2; n++) {
      const start = store.startAttempt(id, account, { ...evidence, observedAt: new Date(clock).toISOString() });
      assert.equal(start.ok, true);
      if (!start.ok) break;
      store.finishAttempt(start.attempt.id, { kind: 'failed', errorKind: 'auth', message: 'sign-in failed' });
      clock += 1000;
    }
  } finally { store.close(); }
  store = new Store(path, { now: () => new Date(clock), authHoldMs: 10_000, authHoldMaxMs: 20_000 });
  try { assert.equal(store.authHoldUntil('a'), clock - 1000 + 10_000); }
  finally { store.close(); }
});

test('hold table upgrade treats a tied success as earlier than failures', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pipe-u6-upgrade-')), 'pipe.sqlite');
  const time = Date.parse(evidence.observedAt);
  const options = { now: () => new Date(time), authHoldMs: 1000 };
  let store = new Store(path, options);
  const attempts = Array.from({ length: 5 }, () => {
    const started = store.startAttempt(store.submit(input).id, { ...account, maxConcurrency: 5 }, evidence);
    assert.equal(started.ok, true);
    return started.ok ? started.attempt.id : '';
  });
  const auth = { kind: 'failed', errorKind: 'auth', message: 'sign-in failed' } as const;
  store.finishAttempt(attempts[0]!, auth);
  store.finishAttempt(attempts[1]!, auth);
  store.finishAttempt(attempts[2]!, auth);
  store.finishAttempt(attempts[3]!, auth);
  store.finishAttempt(attempts[4]!, { kind: 'completed', result: 'OK' });
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE account_holds'); raw.close();
  store = new Store(path, options);
  try { assert.equal(store.authHoldUntil('a'), time + 1000); }
  finally { store.close(); }
});

test('a pinned request waits through an auth hold beyond pin patience', () => {
  const now = new Date('2026-09-25T00:00:10.000Z');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u6-plan-')), 'pipe.sqlite'), { now: () => now });
  try {
    const row = store.submit(input);
    const until = '2026-09-25T00:00:20.000Z';
    const status = { account, running: 0, evidence: () => ({ accountId: 'a', model: 'opus', observedAt: now.toISOString(),
      verdict: { state: 'unavailable' as const, reason: 'auth sign-in hold', until } }) };
    const decision = plan([{ ...row, waiting: { reason: 'old', until: null, stoppedSince: '2026-09-25T00:00:00.000Z' } }], [status],
      { now, pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.equal(decision.fail.length, 0);
    assert.match(decision.waits[0]?.reason ?? '', /sign-in/i);
  } finally { store.close(); }
});

test('reconnect retries transport errors but preserves an HTTP error response', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; if (calls === 1) throw new TypeError('fetch failed');
      return new Response('{"request":{"state":"completed"}}', { status: 200 }); };
    const result = await requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 1000);
    assert.deepEqual(result, { request: { state: 'completed' } });
    assert.equal(calls, 2);
    globalThis.fetch = async () => { calls++; return new Response('{"error":{"message":"unknown request"}}', { status: 404 }); };
    await assert.rejects(requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 1000), /unknown request/);
    assert.equal(calls, 3);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 20), /unreachable/);
  } finally { globalThis.fetch = original; }
});

test('reconnect bounds a stalled request and a stalled body read', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Promise<Response>(() => {});
    await assert.rejects(requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 40), /unreachable/);
    globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
    await assert.rejects(requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 40), /unreachable/);
  } finally { globalThis.fetch = original; }
});

test('a zero reconnect budget makes one bounded request, including with an expired wait deadline', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response('{"request":{"state":"completed"}}'); };
    const result = await requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 0, performance.now());
    assert.deepEqual(result, { request: { state: 'completed' } });
    assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; throw new TypeError('connection refused'); };
    await assert.rejects(requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 0), /unreachable/);
    assert.equal(calls, 2, 'a zero budget never retries an unreachable service');
    globalThis.fetch = async () => { calls++; return new Promise<Response>(() => {}); };
    await assert.rejects(requestJsonReconnecting('http://127.0.0.1:1', 'token', '/v1/requests/r', 0), /unreachable/);
    assert.equal(calls, 3, 'a stalled first request is bounded');
  } finally { globalThis.fetch = original; }
});

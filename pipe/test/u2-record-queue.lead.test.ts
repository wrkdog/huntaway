/**
 * Acceptance grader, lane U2 version 2: the record and the queue (lead-authored).
 * The implementation lane must not edit this file.
 *
 * Version 1 (36a2d32) was reviewed by Sol 6, Gemini and a fresh Claude context. All three
 * asked for revision, and they agreed on these gaps:
 *   - crash recovery;
 *   - a claim that does not enforce placement;
 *   - fairness that resets on every plan;
 *   - unbound and untimed evidence;
 *   - pin patience measured from submission;
 *   - malformed rows and unvalidated submissions;
 *   - missing receipt fields;
 *   - a busy timeout of 0;
 *   - a world-readable file;
 *   - a stale duplicate outcome able to settle a request.
 * Every test below names what it pins.
 *
 * Sources: docs/SPEC.md concepts 5 and 7; docs/ROUTER-MAP.md, Choice and Failure; LESSONS
 * L1 (busy means wait), L3 (fair across requesters), L4 (never wait silently forever),
 * L10 and rule 8 (evidence carries its owner and its time), L11 (offline is not signed out).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, StoreError, type NewRequest, type RequestRecord, type DispatchEvidence } from '../src/store.ts';
import { plan, type AccountStatus, type Evidence } from '../src/queue.ts';
import type { AccountConfig } from '../src/identity.ts';

/** A real folder for changing work: the store refuses a cwd that is not an existing directory (U7). */
const WORK = mkdtempSync(join(tmpdir(), 'pipe-u2-work-'));
import type { Availability } from '../src/availability.ts';

const T0 = Date.parse('2026-09-24T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();

function openStore(options: { maxAttempts?: number; retryBackoffMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-u2-'));
  const clock = { now: at(0) };
  const path = join(dir, 'pipe.sqlite');
  const store = new Store(path, { now: () => clock.now, ...options });
  return { store, path, dir, clock, set: (minutes: number) => { clock.now = at(minutes); } };
}

function request(over: Partial<NewRequest> = {}): NewRequest {
  return {
    requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
    reason: 'a routine change', prompt: 'do the thing', mutating: false, priority: 'background', ...over,
  };
}
function cfg(id: string, provider: 'claude' | 'codex' = 'claude', maxConcurrency = 1, enabled = true): AccountConfig {
  return { id, provider, loginDir: `/logins/${id}`, fingerprint: `fp-${id}`, maxConcurrency, enabled };
}
function dispatchOf(accountId: string, minutes = 0, verdict: Availability = { state: 'available', headroom: 0.5 }, model = 'opus'): DispatchEvidence {
  return { accountId, model, observedAt: iso(minutes), verdict, grant: ['Read', 'Grep', 'Glob'] };
}
/** Start an attempt that must succeed; returns its id. */
function start(store: Store, id: string, account: AccountConfig, minutes = 0): string {
  const got = store.startAttempt(id, account, dispatchOf(account.id, minutes, undefined, store.get(id)?.model));
  assert.equal(got.ok, true, JSON.stringify(got));
  return got.ok ? got.attempt.id : '';
}

// ── the record ──────────────────────────────────────────────────────────────

test('R1 a request is recorded durably with its choice, kind and folder, and waits in submission order', () => {
  const { store, path, clock } = openStore();
  const a = store.submit(request({ model: 'fable', effort: 'max', reason: 'cross-module race', pin: 'claude-a', priority: 'interactive', kind: 'chat' }));
  const b = store.submit(request({ requester: 'team-b', mutating: true, cwd: WORK }));
  assert.equal(a.state, 'queued');
  assert.ok(b.seq > a.seq, 'submission order is a sequence, not a clock');
  store.close();
  const again = new Store(path, { now: () => clock.now });
  const back = again.get(a.id)!;
  for (const [k, v] of Object.entries({ model: 'fable', effort: 'max', reason: 'cross-module race', pin: 'claude-a', priority: 'interactive', kind: 'chat' })) {
    assert.equal((back as Record<string, unknown>)[k], v, k);
  }
  assert.equal(again.get(b.id)!.cwd, WORK);
  assert.equal(again.get(b.id)!.mutating, true);
  assert.deepEqual(again.waitingRequests().map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(back.avoid, []);
  assert.equal(back.waiting, null);
  assert.equal(back.notBefore, null);
  again.close();
});

test('R2 a malformed submission is refused with a clear error, never stored', () => {
  const { store } = openStore();
  const bad: Array<[string, unknown]> = [
    ['no reason', { ...request(), reason: '' }],
    ['unknown provider', { ...request(), provider: 'openrouter' }],
    ['unknown priority', { ...request(), priority: 'urgent' }],
    ['unknown kind', { ...request(), kind: 'video' }],
    ['mutating not a boolean', { ...request(), mutating: 'false' }],
    ['mutating missing', { ...request(), mutating: undefined }],
    ['empty requester', { ...request(), requester: '' }],
    ['empty pin', { ...request(), pin: '' }],
    ['relative cwd', { ...request(), cwd: 'relative/dir' }],
  ];
  for (const [what, body] of bad) assert.throws(() => store.submit(body as NewRequest), StoreError, what);
  assert.deepEqual(store.waitingRequests(), []);
  store.close();
});

test('R3 a claim is one validated compare-and-swap: provider, pin, avoid, room and evidence', () => {
  const { store, path, clock } = openStore();
  const other = new Store(path, { now: () => clock.now });
  const r = store.submit(request());
  const refusals: Array<[string, AccountConfig, DispatchEvidence]> = [
    ['wrong provider', cfg('codex-a', 'codex'), dispatchOf('codex-a')],
    ['disabled account', cfg('claude-a', 'claude', 1, false), dispatchOf('claude-a')],
    ['evidence for another account', cfg('claude-a'), dispatchOf('claude-b')],
    ['a verdict that is not available', cfg('claude-a'), dispatchOf('claude-a', 0, { state: 'busy', running: 1, max: 1 })],
  ];
  for (const [what, account, evidence] of refusals) {
    assert.equal(store.startAttempt(r.id, account, evidence).ok, false, what);
  }
  const pinned = store.submit(request({ pin: 'claude-a' }));
  assert.equal(store.startAttempt(pinned.id, cfg('claude-b'), dispatchOf('claude-b')).ok, false, 'a pin mismatch');
  const first = store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a'));
  assert.equal(first.ok, true);
  assert.equal(store.startAttempt(r.id, cfg('claude-b'), dispatchOf('claude-b')).ok, false, 'a running request cannot start twice');
  const second = other.submit(request({ requester: 'team-b' }));
  const full = other.startAttempt(second.id, cfg('claude-a'), dispatchOf('claude-a'));
  assert.equal(full.ok, false, 'a full account refuses, even through a second Store on the same file (L1)');
  if (!full.ok) assert.match(full.reason, /claude-a/);
  assert.equal(other.startAttempt(second.id, cfg('claude-a', 'claude', 2), dispatchOf('claude-a')).ok, true, 'room is maxConcurrency minus open attempts');
  const rec = store.attempts(r.id)[0]!;
  assert.deepEqual(rec.dispatch, { ...dispatchOf('claude-a'), allowance: { provenance: 'claim_verdict', headroom: 0.5,
    basis: 'ordinary', evaluatedAt: iso(0), observedAt: null } }, 'the receipt keeps the evidence and grant, plus the narrow claim snapshot');
  assert.equal(store.runningCount('claude-a'), 2);
  other.close();
  store.close();
});

test('R4 cancel writes the record first and is absorbing; the account stays busy until the attempt ends', () => {
  const { store } = openStore();
  const r = store.submit(request());
  const attempt = start(store, r.id, cfg('claude-a'));
  assert.equal(store.cancel(r.id, 'the requester withdrew it'), true);
  const cancelled = store.get(r.id)!;
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(cancelled.error, { kind: 'cancelled', message: 'the requester withdrew it' });
  assert.equal(store.runningCount('claude-a'), 1, 'the runner has not stopped yet');
  const after = store.finishAttempt(attempt, { kind: 'completed', result: 'late' });
  assert.equal(after.recorded, true);
  assert.equal(after.request.state, 'cancelled', 'a late completion never resurrects a cancelled request');
  assert.equal(store.attempts(r.id)[0]!.outcome?.kind, 'completed', 'the attempt still records what happened');
  assert.equal(store.runningCount('claude-a'), 0);
  store.close();
});

test('R5 a completed attempt completes the request with its result and where the work landed', () => {
  const { store, set } = openStore();
  const r = store.submit(request({ mutating: true, cwd: WORK }));
  const attempt = start(store, r.id, cfg('claude-a'));
  set(3);
  const workspace = { path: '/work/trees/r1', branch: 'pipe/r1', commit: 'a'.repeat(40) };
  const done = store.finishAttempt(attempt, { kind: 'completed', result: 'all green', workspace });
  assert.equal(done.request.state, 'completed');
  assert.equal(done.request.result, 'all green');
  assert.deepEqual(done.request.workspace, workspace);
  assert.equal(done.request.error, null);
  const [a] = store.attempts(r.id);
  assert.equal(a!.startedAt, iso(0));
  assert.equal(a!.endedAt, iso(3));
  store.close();
});

test('R6 read-only work retries after each transient kind, is bounded, and never blames the account for offline (L11)', () => {
  // U5 round 2 (SPEC §5): a limit makes the request wait on its hold, never blames the account. U6: a sign-in failure
  // waits the same way (temporary outages are never marked permanent).
  for (const [errorKind, avoid] of [['quota_exhausted', []], ['rate_limited', []], ['auth', []]] as const) {
    const { store } = openStore();
    const r = store.submit(request());
    const rec = store.finishAttempt(start(store, r.id, cfg('claude-a')), { kind: 'failed', errorKind, message: errorKind }).request;
    assert.equal(rec.state, 'queued', `${errorKind} as the first failure requeues`);
    assert.deepEqual(rec.avoid, [...avoid], `${errorKind}: avoid ${JSON.stringify(avoid)}`);
    assert.equal(rec.error?.kind, errorKind);
    store.close();
  }
  const { store, set } = openStore({ retryBackoffMs: 60_000 });
  const r = store.submit(request());
  const off = store.finishAttempt(start(store, r.id, cfg('claude-a')), { kind: 'failed', errorKind: 'offline', message: 'ECONNRESET' }).request;
  assert.equal(off.state, 'queued');
  assert.deepEqual(off.avoid, [], 'offline is not the account\'s fault');
  assert.equal(off.notBefore, iso(1), 'offline backs off instead');
  assert.equal(off.error?.kind, 'offline', 'offline and auth stay distinct');
  set(2);
  // Fix round 10: an offline attempt waits for the account to be reachable again and never counts as a try.
  const lost = store.finishAttempt(start(store, r.id, cfg('claude-a'), 2), { kind: 'no_outcome', message: 'runner exited' }).request;
  assert.equal(lost.state, 'queued', 'a lost read-only attempt retries');
  const again = store.finishAttempt(start(store, r.id, cfg('claude-b'), 2), { kind: 'no_outcome', message: 'again' }).request;
  assert.equal(again.state, 'queued', 'the offline attempt did not count: two tries so far');
  const final = store.finishAttempt(start(store, r.id, cfg('claude-c'), 2), { kind: 'no_outcome', message: 'and again' }).request;
  assert.equal(final.state, 'failed', 'the third counted attempt is the last (maxAttempts 3)');
  store.close();
});

test('R7 changing work is never re-run: every unfinished changing attempt says to inspect the work', () => {
  const outcomes = [
    { kind: 'failed', errorKind: 'offline', message: 'lost' },
    { kind: 'failed', errorKind: 'quota_exhausted', message: 'limit' },
    { kind: 'no_outcome', message: 'runner exited' },
    { kind: 'cancelled' },
  ] as const;
  for (const outcome of outcomes) {
    const { store } = openStore();
    const r = store.submit(request({ mutating: true, cwd: WORK }));
    const rec = store.finishAttempt(start(store, r.id, cfg('claude-a')), outcome).request;
    assert.ok(rec.state === 'failed' || rec.state === 'cancelled', JSON.stringify(outcome));
    if (rec.state === 'failed') assert.match(rec.error?.message ?? '', /inspect/i, JSON.stringify(outcome));
    store.close();
  }
});

test('R8 an outcome counts once: first outcome stays, a stale one from an earlier attempt never settles the request', () => {
  const { store, path, clock } = openStore();
  const r = store.submit(request());
  const first = start(store, r.id, cfg('claude-a'));
  store.finishAttempt(first, { kind: 'failed', errorKind: 'rate_limited', message: '429' });
  const second = start(store, r.id, cfg('claude-b'));
  const stale = store.finishAttempt(first, { kind: 'completed', result: 'stale' });
  assert.equal(stale.recorded, false);
  assert.equal(stale.request.state, 'running', 'the second attempt still decides');
  assert.equal(store.attempts(r.id)[0]!.outcome?.kind, 'failed', 'the first attempt keeps its first outcome');
  const other = new Store(path, { now: () => clock.now });
  const x = other.finishAttempt(second, { kind: 'completed', result: 'from the other handle' });
  const y = store.finishAttempt(second, { kind: 'failed', errorKind: 'other', message: 'second writer' });
  assert.equal(x.recorded, true);
  assert.equal(y.recorded, false, 'competing finishes through two handles: one wins');
  assert.equal(store.get(r.id)!.result, 'from the other handle');
  assert.throws(() => store.finishAttempt('no-such-attempt', { kind: 'cancelled' }), StoreError);
  other.close();
  store.close();
});

test('R9 terminal states are absorbing on every path', () => {
  const { store } = openStore();
  const done = store.submit(request());
  store.finishAttempt(start(store, done.id, cfg('claude-a')), { kind: 'completed', result: 'ok' });
  const broken = store.submit(request());
  store.finishAttempt(start(store, broken.id, cfg('claude-a')), { kind: 'failed', errorKind: 'other', message: 'tool error' });
  const given = store.submit(request());
  store.fail(given.id, 'no route');
  const withdrawn = store.submit(request());
  store.cancel(withdrawn.id, 'withdrawn');
  for (const r of [done, broken, given, withdrawn]) {
    const before = store.get(r.id)!;
    assert.equal(store.startAttempt(r.id, cfg('claude-z'), dispatchOf('claude-z')).ok, false, `start ${before.state}`);
    assert.equal(store.cancel(r.id, 'again'), false, `cancel ${before.state}`);
    assert.equal(store.fail(r.id, 'again'), false, `fail ${before.state}`);
    assert.equal(store.setWaiting(r.id, { reason: 'x', until: null }), false, `setWaiting ${before.state}`);
    const after = store.get(r.id)!;
    assert.deepEqual([after.state, after.result, after.error], [before.state, before.result, before.error]);
  }
  store.close();
});

test('R10 a crash leaves no account busy forever: reconcile ends every open attempt as no outcome', () => {
  const { store, path, clock } = openStore();
  const reader = store.submit(request());
  const writer = store.submit(request({ mutating: true, cwd: WORK }));
  start(store, reader.id, cfg('claude-a', 'claude', 2));
  start(store, writer.id, cfg('claude-a', 'claude', 2));
  store.close();   // the pipe stops with both attempts open
  const again = new Store(path, { now: () => clock.now });
  assert.equal(again.openAttempts().length, 2, 'open attempts are listed');
  const settled = again.reconcile('the pipe restarted while this attempt ran');
  assert.equal(settled.length, 2);
  assert.equal(again.runningCount('claude-a'), 0);
  assert.deepEqual(again.openAttempts(), []);
  // U5 round 2: these attempts never recorded a runner, so no prompt was sent: requeued without blame.
  assert.equal(again.get(reader.id)!.state, 'queued');
  assert.deepEqual(again.get(reader.id)!.avoid, []);
  const w = again.get(writer.id)!;
  assert.ok(w.state === 'queued' || (w.state === 'failed' && /inspect/i.test(w.error?.message ?? '')), JSON.stringify(w));
  again.close();
});

test('R11 a pinned request keeps its cause: avoid kinds fail it at once, offline retries its pin after a backoff', () => {
  const { store, set } = openStore({ retryBackoffMs: 60_000 });
  const quota = store.submit(request({ pin: 'claude-a' }));
  const q = store.finishAttempt(start(store, quota.id, cfg('claude-a')), { kind: 'no_outcome', message: 'the runner ended without an outcome' }).request;
  assert.equal(q.state, 'failed');
  assert.equal(q.error?.kind, 'no_outcome', 'the requester learns the real cause, not "unroutable"');
  // U6: a pinned request that hit a sign-in failure waits for its account instead of failing.
  const signin = store.submit(request({ pin: 'claude-a' }));
  const s = store.finishAttempt(start(store, signin.id, cfg('claude-a')), { kind: 'failed', errorKind: 'auth', message: 'invalid api key' }).request;
  assert.equal(s.state, 'queued');
  assert.deepEqual(s.avoid, []);
  // U5 round 2 (SPEC §5): a pinned request that hit a limit waits on it instead.
  const limited = store.submit(request({ pin: 'claude-a' }));
  const l = store.finishAttempt(start(store, limited.id, cfg('claude-a')), { kind: 'failed', errorKind: 'quota_exhausted', message: 'weekly limit' }).request;
  assert.equal(l.state, 'queued');
  assert.deepEqual(l.avoid, []);
  const offline = store.submit(request({ pin: 'claude-a' }));
  const o = store.finishAttempt(start(store, offline.id, cfg('claude-a')), { kind: 'failed', errorKind: 'offline', message: 'ENOTFOUND' }).request;
  assert.equal(o.state, 'queued');
  assert.deepEqual(o.avoid, []);
  assert.equal(o.notBefore, iso(1));
  set(2);
  assert.equal(store.startAttempt(offline.id, cfg('claude-a'), dispatchOf('claude-a', 2)).ok, true, 'the pin is tried again');
  store.close();
});

test('R12 a malformed row fails on its own; the rest of the queue still plans', () => {
  const { store, path } = openStore();
  const good = store.submit(request());
  const badBody = store.submit(request());
  const badAvoid = store.submit(request());
  store.close();
  const raw = new DatabaseSync(path);
  const cols = (raw.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
  const bodyCol = cols.find((c) => c === 'body') ?? cols.find((c) => /body|request/i.test(c));
  if (bodyCol) raw.prepare(`UPDATE requests SET ${bodyCol} = ? WHERE id = ?`).run('{not json', badBody.id);
  if (cols.includes('avoid')) raw.prepare('UPDATE requests SET avoid = ? WHERE id = ?').run('null', badAvoid.id);
  assert.throws(() => raw.prepare("UPDATE requests SET state = 'Queued' WHERE id = ?").run(good.id), 'the state column only takes known states');
  raw.close();
  const again = new Store(path);
  assert.deepEqual(again.waitingRequests().map((r) => r.id), [good.id]);
  for (const id of bodyCol ? [badBody.id] : []) assert.equal(again.get(id)?.state ?? 'failed', 'failed');
  again.close();
});

test('R13 strings are data: SQL-shaped and unusual values round-trip exactly', () => {
  const { store } = openStore();
  const odd = "'; DROP TABLE requests; -- \"quoted\" \\ back\\slash";
  const r = store.submit(request({ requester: odd, project: odd, model: odd, effort: odd, reason: odd, prompt: odd + '\u0000nul' }));
  const back = store.get(r.id)!;
  for (const k of ['requester', 'project', 'model', 'effort', 'reason'] as const) assert.equal(back[k], odd, k);
  assert.equal(back.prompt, odd + '\u0000nul');
  const failed = store.finishAttempt(start(store, r.id, cfg('claude-a')), { kind: 'failed', errorKind: 'other', message: odd }).request;
  assert.equal(failed.error?.message, odd);
  store.close();
});

test('R14 the file is private, versioned, waits for a busy writer, and refuses an unknown version', async () => {
  const { store, path } = openStore();
  store.submit(request());
  assert.equal(statSync(path).mode & 0o077, 0, 'the record holds prompts and results: owner-only');
  store.close();
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2,
    'U13 combined limit holds require version 2 so older binaries refuse them');
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => new Store(path), StoreError, 'a file from a newer or unknown version is refused, not guessed at');
  const { store: s2, path: p2 } = openStore();
  // Another process holds the write lock for about 300 ms. node:sqlite is synchronous, so the
  // holder must be a separate process: a timer on this thread could never fire during submit().
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(p2)});
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    const end = Date.now() + 300; while (Date.now() < end) {}
    db.exec('COMMIT'); db.close();
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
  const t = Date.now();
  s2.submit(request());   // waits for the lock instead of failing at once
  assert.ok(Date.now() - t >= 150, `submit waited for the busy writer (${Date.now() - t} ms)`);
  await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  s2.close();
});

test('R15 stamps never go backwards, and an invalid clock is refused', () => {
  const { store, set, clock } = openStore();
  set(10);
  const r = store.submit(request());
  set(5);   // the clock steps back
  const attempt = store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', 5));
  assert.equal(attempt.ok, true);
  if (attempt.ok) assert.ok(attempt.attempt.startedAt >= r.createdAt, `${attempt.attempt.startedAt} >= ${r.createdAt}`);
  clock.now = new Date(Number.NaN);
  assert.throws(() => store.submit(request()), (e: unknown) => e instanceof StoreError || e instanceof RangeError);
  store.close();
});

test('R16 each requester\'s load comes from the record', () => {
  const { store, set } = openStore();
  const a = store.submit(request({ requester: 'lane' }));
  store.submit(request({ requester: 'team-b' }));
  set(4);
  start(store, a.id, cfg('claude-a'), 4);
  const load = store.requesterLoad();
  assert.deepEqual(load.get('lane'), { running: 1, lastDispatchedAt: iso(4) });
  assert.equal(load.get('team-b')?.running ?? 0, 0);
  store.close();
});

// ── the queue ───────────────────────────────────────────────────────────────

let seq = 0;
function waiting(over: Partial<RequestRecord> = {}): RequestRecord {
  seq += 1;
  return {
    ...request(), id: `r${seq}`, seq, state: 'queued', createdAt: iso(0), updatedAt: iso(0),
    waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null, ...over,
  } as RequestRecord;
}
const NOW = at(10);
const fresh = (accountId: string, verdict: Availability, minutes = 9, model = 'opus'): Evidence => ({ accountId, model, observedAt: iso(minutes), verdict });
function acct(id: string, provider: 'claude' | 'codex', verdict: Availability | ((model: string) => Availability), running = 0, maxConcurrency = 1, observedMinute = 9): AccountStatus {
  return { account: cfg(id, provider, maxConcurrency), running, evidence: (model) => fresh(id, typeof verdict === 'function' ? verdict(model) : verdict, observedMinute, model) };
}
const free = (headroom = 0.5): Availability => ({ state: 'available', headroom });
const busy = (running = 1, max = 1): Availability => ({ state: 'busy', running, max });
const stopped = (reason: string, until: string | null): Availability => ({ state: 'unavailable', reason, until });
const OPTS = { now: NOW, pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load: new Map() };
const where = (p: ReturnType<typeof plan>, id: string) =>
  p.dispatch.find((d) => d.requestId === id)?.accountId
  ?? (p.waits.some((w) => w.requestId === id) ? 'waits' : p.fail.some((f) => f.requestId === id) ? 'fails' : 'missing');

test('Q1 a busy account means wait, never fail, and says so', () => {
  const r = waiting();
  const p = plan([r], [acct('claude-a', 'claude', busy())], OPTS);
  assert.deepEqual([p.dispatch, p.fail], [[], []]);
  const w = p.waits[0]!;
  assert.match(w.reason, /claude-a/);
  assert.match(w.reason, /busy/);
  assert.equal(w.until, null);
});

test('Q2 work spreads: the least loaded account first, then the most headroom', () => {
  const [r1, r2] = [waiting(), waiting()];
  const two = plan([r1!, r2!], [acct('claude-a', 'claude', free(0.70), 0, 2), acct('claude-b', 'claude', free(0.69), 0, 2)], OPTS);
  assert.notEqual(where(two, r1!.id), where(two, r2!.id), 'parallel work goes to both idle accounts (SPEC 5)');
  const one = plan([r1!], [acct('claude-a', 'claude', free(0.2)), acct('claude-b', 'claude', free(0.7))], OPTS);
  assert.deepEqual(one.dispatch.map((d) => [d.requestId, d.accountId]), [[r1!.id, 'claude-b']]);
  assert.equal(one.dispatch[0]!.evidence.accountId, 'claude-b', 'the dispatch carries the evidence it used');
});

test('Q3 requesters take turns across plans, and interactive work goes first (L3)', () => {
  const { store, set } = openStore();
  const lane = [1, 2, 3].map(() => store.submit(request({ requester: 'lane' })));
  const dog = store.submit(request({ requester: 'team-b' }));
  const order: string[] = [];
  for (let tick = 1; tick <= 4; tick++) {
    // Plan at minutes 10-13, so the evidence (observed at minute 9) is fresh and in the past.
    set(9 + tick);
    const p = plan(store.waitingRequests(), [acct('claude-a', 'claude', free())], { ...OPTS, now: at(9 + tick), load: store.requesterLoad() });
    const d = p.dispatch[0]!;
    order.push(store.get(d.requestId)!.requester);
    store.finishAttempt(start(store, d.requestId, cfg('claude-a'), 9 + tick), { kind: 'completed', result: 'ok' });
  }
  assert.deepEqual(order, ['lane', 'team-b', 'lane', 'lane'], 'one burst cannot starve another requester');
  store.close();
  const bg = waiting({ requester: 'lane' });
  const fg = waiting({ requester: 'dev-a', priority: 'interactive' });
  assert.deepEqual(plan([bg, fg], [acct('claude-a', 'claude', free())], OPTS).dispatch.map((d) => d.requestId), [fg.id]);
  assert.equal(lane.length + 1, 4);
  assert.ok(dog);
});

test('Q4 capacity counts running jobs and this plan\'s own assignments (L1)', () => {
  const rs = [waiting(), waiting(), waiting()];
  const p = plan(rs, [acct('claude-a', 'claude', free(), 1, 2)], OPTS);
  assert.equal(p.dispatch.length, 1);
  assert.equal(p.waits.length, 2);
});

test('Q5 providers never mix; until is the earliest real reset, and null while anything is merely busy', () => {
  const job = waiting({ provider: 'codex', model: 'gpt-6-sol' });
  const p = plan([job], [
    acct('claude-a', 'claude', free()),
    acct('codex-a', 'codex', stopped('credits exhausted', '2026-09-24T09:00:00-04:00')),   // 13:00Z
    acct('codex-b', 'codex', stopped('week exhausted', '2026-09-24T12:30:00.000Z')),
    acct('codex-c', 'codex', stopped('old', '2026-09-24T11:00:00.000Z')),                  // already past
  ], OPTS);
  const w = p.waits[0]!;
  assert.doesNotMatch(w.reason, /claude-a/);
  for (const id of ['codex-a', 'codex-b']) assert.match(w.reason, new RegExp(id));
  assert.equal(w.until, '2026-09-24T12:30:00.000Z', 'compared as times, not strings; lapsed resets dropped');
  const mixed = plan([job], [acct('codex-a', 'codex', busy()), acct('codex-b', 'codex', stopped('3 days', iso(4320)))], OPTS);
  assert.equal(mixed.waits[0]!.until, null, 'a busy account may free up at any moment');
  const none = plan([waiting({ provider: 'codex', model: 'gpt-6-sol' })], [acct('claude-a', 'claude', free())], OPTS);
  assert.match(none.waits[0]!.reason, /codex/);
});

test('Q6 a pin narrows and never promotes, and its patience counts from when it stopped (L4)', () => {
  const accounts = (pinVerdict: Availability, observedMinute = 9) =>
    [acct('claude-a', 'claude', pinVerdict, 0, 1, observedMinute), acct('claude-b', 'claude', free(), 0, 1, observedMinute)];
  const pinned = waiting({ pin: 'claude-a', createdAt: iso(-600) });   // old, but that alone is not a reason
  const p1 = plan([pinned], accounts(busy()), OPTS);
  assert.equal(where(p1, pinned.id), 'waits', 'busy never fails, and never moves to a free account');
  const p2 = plan([pinned], accounts(stopped('signed out', null)), OPTS);
  assert.equal(where(p2, pinned.id), 'waits', 'the first sight of a stopped pin starts its patience');
  const firstStop = p2.waits[0]!;
  assert.equal(firstStop.stoppedSince, NOW.toISOString());
  assert.equal(firstStop.until, at(40).toISOString(), 'the wait says when the pin bound will be judged');
  const later = { ...pinned, waiting: { reason: firstStop.reason, until: firstStop.until, stoppedSince: firstStop.stoppedSince! } };
  const p3 = plan([later], accounts(stopped('signed out', null), 44), { ...OPTS, now: at(45) });
  assert.equal(where(p3, pinned.id), 'fails', 'stopped for longer than pinWaitMs, with no reset in sight');
  assert.match(p3.fail[0]!.reason, /claude-a/);
  const soon = plan([later], accounts(stopped('five_hour exhausted', at(50).toISOString()), 44), { ...OPTS, now: at(45) });
  assert.equal(where(soon, pinned.id), 'waits', 'back within pinWaitMs: keep waiting');
  const cleared = plan([later], accounts(busy(), 44), { ...OPTS, now: at(45) });
  assert.equal(cleared.waits[0]!.stoppedSince, undefined, 'busy clears the stop');
  for (const bad of [waiting({ pin: 'claude-nope' }), waiting({ pin: 'claude-b', avoid: ['claude-b'] }), waiting({ pin: 'codex-a' })]) {
    const p = plan([bad], [...accounts(free()), acct('codex-a', 'codex', free())], OPTS);
    assert.equal(where(p, bad.id), 'fails', `pin ${bad.pin} can never be met`);
  }
});

test('Q7 a request never returns to an account that failed it, and never waits for one forever', () => {
  const r = waiting({ avoid: ['claude-a'] });
  assert.equal(where(plan([r], [acct('claude-a', 'claude', free(0.9)), acct('claude-b', 'claude', free(0.1))], OPTS), r.id), 'claude-b');
  const only = plan([r], [acct('claude-a', 'claude', free(0.9))], OPTS);
  assert.equal(where(only, r.id), 'fails', 'every candidate already failed it: a bounded outcome');
  assert.match(only.fail[0]!.reason, /claude-a/);
});

test('Q8 every request lands in exactly one outcome; verdicts are asked per model; a malformed record fails', () => {
  const byModel = (model: string): Availability => model === 'fable' ? stopped('fable week exhausted', iso(90)) : free();
  const opus = waiting({ model: 'opus' });
  const fable = waiting({ model: 'fable', reason: 'hard' });
  const odd = waiting({ priority: 'urgent' as RequestRecord['priority'] });
  const p = plan([opus, fable, odd], [acct('claude-a', 'claude', byModel, 0, 3)], OPTS);
  assert.equal(where(p, opus.id), 'claude-a');
  assert.equal(where(p, fable.id), 'waits');
  assert.equal(p.waits.find((w) => w.requestId === fable.id)!.until, iso(90));
  assert.equal(where(p, odd.id), 'fails', 'an unknown priority is a malformed record, not a silent drop');
  const all = [...p.dispatch.map((d) => d.requestId), ...p.waits.map((w) => w.requestId), ...p.fail.map((f) => f.requestId)];
  assert.deepEqual(all.sort(), [opus.id, fable.id, odd.id].sort());
});

test('Q9 a blocked provider never holds up another provider\'s work', () => {
  const stuck = waiting({ provider: 'codex', model: 'gpt-6-sol', priority: 'interactive' });
  const next = waiting();
  const p = plan([stuck, next], [acct('codex-a', 'codex', busy()), acct('claude-a', 'claude', free())], OPTS);
  assert.equal(where(p, next.id), 'claude-a');
  assert.equal(where(p, stuck.id), 'waits');
});

test('Q10 placement evidence must name its account and be fresh on the plan\'s clock (rule 8)', () => {
  const r = waiting();
  const liar: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: () => fresh('claude-b', free()) };
  assert.equal(where(plan([r], [liar], OPTS), r.id), 'waits', 'evidence for another account is unknown');
  const stale: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: () => fresh('claude-a', free(), 0) };
  assert.equal(where(plan([r], [stale], OPTS), r.id), 'waits', 'evidence older than evidenceMaxAgeMs is unknown');
  const future: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: () => fresh('claude-a', free(), 30) };
  assert.equal(where(plan([r], [future], OPTS), r.id), 'waits', 'evidence from the future is unknown');
  const badClock = plan([r], [acct('claude-a', 'claude', free())], { ...OPTS, now: new Date(Number.NaN) });
  assert.equal(badClock.dispatch.length, 0, 'an invalid plan clock dispatches nothing');
  assert.equal(where(badClock, r.id), 'waits');
});

test('Q11 a request backing off waits until its notBefore', () => {
  const r = waiting({ notBefore: iso(12) });
  const p = plan([r], [acct('claude-a', 'claude', free())], OPTS);
  assert.equal(where(p, r.id), 'waits');
  assert.equal(p.waits[0]!.until, iso(12));
  assert.equal(where(plan([r], [acct('claude-a', 'claude', free())], { ...OPTS, now: at(13) }), r.id), 'claude-a');
});

// ── small by design ─────────────────────────────────────────────────────────

test('S2 U1 and U2 together stay small and dependency-free', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'node:sqlite is built in; no runtime dependencies');
  const src = new URL('../src/', import.meta.url);
  // Later lanes' own files are theirs to budget (U3: runner.ts; U4: probe.ts, buckets.ts; U5: service, http, mcp, cli; U8: disk.ts; U10: review.ts; U11: client.ts; U18: release-copy.ts; READ-CONTRACT-01: cards.ts; u51: retention.ts).
  const lines = readdirSync(src).filter((f) => f.endsWith('.ts') && !['runner.ts', 'probe.ts', 'buckets.ts', 'service.ts', 'http.ts', 'mcp.ts', 'cli.ts', 'disk.ts', 'client.ts', 'review.ts', 'agy.ts', 'telemetry.ts', 'release-copy.ts', 'cards.ts', 'projects.ts', 'retention.ts'].includes(f))
    .map((f) => readFileSync(new URL(f, src), 'utf8').split('\n').filter((l) => l.trim() !== '').length)
    .reduce((a, b) => a + b, 0);
  // u42 (2026-10-23): src/projects.ts is that lane's own file, budgeted on its own in S5; its store field fits here.
  // U6 added the durable sign-in hold, its upgrade backfill and the claim guard (Sol's review); U8 adds the store's
  // side of worktree retention, and U10 the reviews table. S5 still caps the core.
  // U13 adds the ledger's retirement of buckets a provider stops reporting, and its rule that a cached reading
  // on a verified account only holds (the lead, 2026-09-26).
  // U15 keeps src/agy.ts under its own S15, and adds the store's one-seat AGY hold (the lead's delegate).
  // U13 follow-up adds 17 non-blank lines here for two release gates, observation order, A9's unmeasured hold and version-2 records.
  // READ-CONTRACT-01 step 1 (2026-09-30) keeps src/cards.ts under its own S19, and adds the wait codes, the saved state,
  // attempts(), a change number (moved by attempt writes too) and changedAfter(), the open-card read and a finish stamp
  // to the store, and unique account display names: 95 (the Router owner).
  // READ-CONTRACT-01 step 2a (2026-09-30), the hub's "Running": the event clock (src/event-clock.ts) and the store's
  // event columns, their migration (each column on its own) and noteEvents: 35 (the Router owner).
  // Rule 49: the ledger marks a view that draws on credits and keeps credit room from
  // lifting a job's limit, and the queue ranks credit room last: 5 (the Router Architect).
  // READ-CONTRACT-01 step 2b (2026-09-30), the hub's Resume proof: attempts' closed_at column, its migration and the
  // write-once noteClosed, and the trigger that keeps it write-once: 16 (the Router owner).
  // L75: placement and durable selection reuse the planner/attempt record, +30 nonblank lines.
  // L76: atomic automatic admission/retention replaces implicit single-route waiting; measured +87 nonblank lines.
  // L78 / FIX ROUND2: exact net growth for final certificates, automatic retry proof and runner closure proof.
  // Repair 1: the coordinator explicitly authorizes 1,887 -> measured 1,988, no headroom, for optional
  // start-from-saved-commit admission and its shared preclaim/execution proof (L80-L81); no files reclassified.
  // Velocity telemetry: the store's review lane, round and setupFailed, and the saved diff (src/telemetry.ts is budgeted on its own in S5): +12 (the lead).
  // Telemetry round 3: the store's dedicated setup-cancel marker: +1 (the lead).
  // U39 account preference: +2 (the lead).
  // E1 idempotent admission: +307 (2,003 → 2,310), the lead.
  // u43 external leases (round 2): store lease table and pure reads, plus lease load in availability, planning and claims: +70 (2,310 → 2,380), the lead.
  // u43 review round 1: jobs-aware take, expiry sweep and grace: +10 (2,380 → 2,390), the lead.
  // u43 final round: renewal clock guard and sweep isolation: +3 (2,390 → 2,393), the lead.
  // u43 lead round 4: renewal window and heartbeat freshness: +4 (2,393 → 2,397), the lead.
  // u43: tick/TTL check at take and renew: +2 (2,397 → 2,399), the lead.
  // u44 housekeeping (round 3, no archiving; 2026-10-29): store housekeeping and save-strike fields, the review git deadline and src/classify.ts (regenerable ignored roots): +89 (2,399 → 2,488), the lead.
  // u44 lead round 4 (2026-10-29): byte-safe ignored listing, durable partial removal, fingerprints, write-aware capacity guard and abortable scans: +44 (2,488 → 2,532), the lead.
  // u44 lead round 5 (2026-10-29): resource-fork refusal, byte-safe walk, removal-refusal recovery, fair retries, placeholder re-listing and index-aware capacity: +38 (2,532 → 2,570), the lead.
  // u44 lead round 6 (2026-10-29): extended-attribute refusal, exit-128 removal recovery, hung-vs-slow scans, tree-aware capacity and other VCS markers: +74 (2,570 → 2,644), the lead.
  // u44 lead rounds 6b-6c (2026-10-29): removal-only xattr checks and the hung-group outcome: +2 (2,644 → 2,646), the lead.
  // u44 lead round 7 (2026-10-29): unambiguous xattr refusal, deleted-directory capacity, block-size rounding, the unproven-group gate and rethrown group failures: +41 (2,646 → 2,687), the lead.
  // u44 lead round 7c (2026-10-29): the prune group proof and file-to-directory capacity: +2 (2,687 → 2,689), the lead.
  // u49 round 2 (2026-10-31): canonical non-overlapping previous worktree roots, per-volume tiers and the restored disk.ts rationale comments (round 1 had moved them out to fit): +2 (2,689 → 2,691), the lead.
  // u49 round 5 (2026-10-31): src/worktree-roots.ts (abortable previous-root reads, per-pass availability, the root-bound proof), partly moved out of disk.ts: +109 (2,691 → 2,800), the lead.
  // u49 round 6 (2026-10-31): the no-follow walk under worktreeRoot, refresh-invalidated save proofs and unavailable-root handling: +16 (2,800 → 2,816), the lead.
  // u49 rounds 7-7b (2026-10-31): the canonical-root walk, per-pass abortable root checks, ancestor dev proof for a root created after startup and mount-point refusal: +22 (2,816 → 2,838), the lead.
  // u49 round 8 (2026-10-31): missing-root hold, guarded worktreeRoot creation and per-save root checks: +9 (2,838 → 2,847), the lead.
  // u49 round 9 (2026-10-31): unchecked or vanished-root finalization holds, startup refusal before the volume mounts and the startup-device guard: +3 (2,847 → 2,850), the lead.
  // u49.1 (2026-10-31): lost-volume detection, the optional work-volume marker and the canonical-root guard: +32 (2,850 → 2,882), the lead.
  // u51 (2026-11-01): the store's pruneEndedRecords for ended-record retention (one clock sample, a resumable scan cursor set after commit) and lane_rounds, each lane's highest round, backfilled once and raised on every review (src/retention.ts is budgeted on its own in S5): +18 (2,882 → 2,900), the Huntaway lead.
  assert.ok(lines <= 2_900, `U1 and U2 hold ${lines} non-blank lines; their budget is 2,900`);
});

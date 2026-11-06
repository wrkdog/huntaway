/**
 * The lead's additions to the U2 grader, from mutation testing the builder's 4493ab1 with the
 * lead's type fix (5ae4327). Grader v3 (`u2-record-queue.lead.test.ts`) was the builder's target
 * and stays byte for byte. 21 of 26 mutants failed it; one survivor is equivalent (a late outcome
 * cannot move a cancelled request past the SQL guard `AND state = 'running'`). The other four
 * survived because nothing tested them, and each test below kills one. The implementation
 * already passes them all: they guard against regressions, not new behaviour.
 *   M1 (S8)  the claim accepted an account that already failed the request;
 *   M2 (S11) a malformed row was hidden but left queued (R12's `?? 'failed'` let it pass);
 *   M3 (S13) the claim accepted evidence stamped after the pipe's clock (rule 8);
 *   M4 (Q9)  turns within one plan stopped counting a dispatch as a running attempt (L3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type NewRequest, type RequestRecord, type DispatchEvidence } from '../src/store.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import type { AccountConfig } from '../src/identity.ts';
import type { Availability } from '../src/availability.ts';
import { instantOf } from '../src/allowance.ts';

const T0 = Date.parse('2026-09-24T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();

function openStore() {
  const path = join(mkdtempSync(join(tmpdir(), 'pipe-u2-m-')), 'pipe.sqlite');
  const clock = { now: at(0) };
  return { store: new Store(path, { now: () => clock.now }), path, clock };
}
const request = (over: Partial<NewRequest> = {}): NewRequest => ({
  requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
  reason: 'a routine change', prompt: 'do the thing', mutating: false, priority: 'background', ...over,
});
const cfg = (id: string): AccountConfig => ({ id, provider: 'claude', loginDir: `/logins/${id}`, fingerprint: `fp-${id}`, maxConcurrency: 1, enabled: true });
const dispatchOf = (accountId: string, observedAt: string, model = 'opus'): DispatchEvidence =>
  ({ accountId, model, observedAt, verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] });

test('M1 a claim refuses an account that already failed the request, even without the plan', () => {
  const { store } = openStore();
  const r = store.submit(request());
  const first = store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(0)));
  assert.equal(first.ok, true);
  // U6 (temporary outages are never marked permanent): a sign-in failure no longer avoids; a lost attempt still does.
  const back = store.finishAttempt(first.ok ? first.attempt.id : '', { kind: 'no_outcome', message: 'the runner ended without an outcome' }).request;
  assert.equal(back.state, 'queued');
  assert.deepEqual(back.avoid, ['claude-a']);
  const again = store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(0)));
  assert.equal(again.ok, false, 'the account that failed it is refused');
  if (!again.ok) assert.match(again.reason, /claude-a/);
  assert.equal(store.startAttempt(r.id, cfg('claude-b'), dispatchOf('claude-b', iso(0))).ok, true, 'another account may take it');
  store.close();
});

test('M2 a malformed row is failed as malformed in the record, not merely hidden', () => {
  const { store, path } = openStore();
  const good = store.submit(request());
  const bad = store.submit(request());
  store.close();
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE requests SET body = ? WHERE id = ?').run('{not json', bad.id);
  raw.close();
  const again = new Store(path);
  assert.deepEqual(again.waitingRequests().map((r) => r.id), [good.id]);
  again.close();
  const check = new DatabaseSync(path, { readOnly: true });
  const row = check.prepare('SELECT state, error FROM requests WHERE id = ?').get(bad.id) as { state: string; error: string | null };
  check.close();
  assert.equal(row.state, 'failed', 'the unreadable request no longer counts as queued');
  assert.equal(JSON.parse(String(row.error)).kind, 'malformed');
});

test('M3 a claim refuses evidence stamped after the pipe\'s clock, or with no valid time (rule 8)', () => {
  const { store } = openStore();                       // the clock reads minute 0
  const r = store.submit(request());
  for (const [what, observedAt] of [['observed at minute 5', iso(5)], ['not a time', 'soon'], ['empty', '']] as const) {
    assert.equal(store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', observedAt)).ok, false, what);
  }
  assert.equal(store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(0))).ok, true, 'evidence at the clock is valid');
  store.close();
});

test('M4 within one plan, a turn counts as a running attempt, so another requester goes next (L3)', () => {
  let seq = 0;
  const waiting = (requester: string): RequestRecord => {
    seq += 1;
    return {
      ...request({ requester }), id: `m${seq}`, seq, state: 'queued', createdAt: iso(0), updatedAt: iso(0),
      waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null,
    } as RequestRecord;
  };
  const [lane1, lane2, dog] = [waiting('lane'), waiting('lane'), waiting('team-b')];
  const free: Availability = { state: 'available', headroom: 0.5 };
  const acct = (id: string): AccountStatus => ({ account: cfg(id), running: 0, evidence: (model) => ({ model, accountId: id, observedAt: iso(9), verdict: free }) });
  // 'lane' has never dispatched; 'team-b' has one attempt running elsewhere. Two accounts are free.
  const load = new Map([['team-b', { running: 1, lastDispatchedAt: iso(5) }]]);
  const p = plan([lane1!, lane2!, dog!], [acct('claude-a'), acct('claude-b')], { now: at(10), pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load });
  assert.deepEqual(p.dispatch.map((d) => d.requestId).sort(), [dog!.id, lane1!.id].sort(), 'lane\'s first turn counts, so team-b takes the second account');
  assert.deepEqual(p.waits.map((w) => w.requestId), [lane2!.id]);
});

// Added after Gemini's review of d35605f (two minors and a nit).

test('M5 an attempt whose request row is unreadable ends cleanly: a named error, and reconcile carries on', () => {
  const { store, path, clock } = openStore();
  const r = store.submit(request());
  const first = store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(0)));
  assert.equal(first.ok, true);
  store.close();
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE requests SET body = ? WHERE id = ?').run('{not json', r.id);
  raw.close();
  const again = new Store(path, { now: () => clock.now });
  assert.throws(() => again.finishAttempt(first.ok ? first.attempt.id : '', { kind: 'completed', result: 'ok' }), (e: Error) => e.name === 'StoreError' && /cannot be read/.test(e.message));
  again.close();
  const other = openStore();
  const a = other.store.submit(request());
  const b = other.store.submit(request());
  const sa = other.store.startAttempt(a.id, cfg('claude-a'), dispatchOf('claude-a', iso(0)));
  const sb = other.store.startAttempt(b.id, cfg('claude-b'), dispatchOf('claude-b', iso(0)));
  assert.ok(sa.ok && sb.ok);
  other.store.close();
  const raw2 = new DatabaseSync(other.path);
  raw2.prepare('UPDATE requests SET body = ? WHERE id = ?').run('{not json', a.id);
  raw2.close();
  const recovered = new Store(other.path, { now: () => other.clock.now });
  assert.doesNotThrow(() => recovered.reconcile('restarted'));
  assert.equal(recovered.openAttempts().length, 0, 'every open attempt is ended, the unreadable one included');
  assert.equal(recovered.runningCount('claude-a') + recovered.runningCount('claude-b'), 0, 'no account stays busy');
  recovered.close();
});

test('M6 a corrupted attempt row is a named error, and reconcile still ends every open attempt (L4)', () => {
  const { store, path, clock } = openStore();
  const [a, b] = [store.submit(request()), store.submit(request())];
  const sa = store.startAttempt(a.id, cfg('claude-a'), dispatchOf('claude-a', iso(0)));
  const sb = store.startAttempt(b.id, cfg('claude-b'), dispatchOf('claude-b', iso(0)));
  assert.ok(sa.ok && sb.ok);
  store.close();
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run('{not json', sa.ok ? sa.attempt.id : '');
  raw.close();
  const again = new Store(path, { now: () => clock.now });
  assert.throws(() => again.openAttempts(), (e: Error) => e.name === 'StoreError' && e.message.includes(sa.ok ? sa.attempt.id : '?'), 'a named error, not a SyntaxError');
  assert.doesNotThrow(() => again.reconcile('restarted'));
  assert.equal(again.runningCount('claude-a'), 0, 'the corrupted attempt is ended too');
  assert.equal(again.runningCount('claude-b'), 0);
  assert.equal(again.get(b.id)?.state, 'queued', 'the readable one settles through the retry policy');
  again.close();
});

test('M7 a claim checks the verdict\'s headroom, as the plan does', () => {
  const { store } = openStore();
  const r = store.submit(request());
  for (const headroom of [2, -0.1, Number.NaN, undefined, '0.5'] as never[]) {
    const evidence = { accountId: 'claude-a', model: 'opus', observedAt: iso(0), verdict: { state: 'available', headroom }, grant: ['Read'] } as never;
    assert.equal(store.startAttempt(r.id, cfg('claude-a'), evidence).ok, false, `headroom ${String(headroom)}`);
  }
  assert.equal(store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(0))).ok, true);
  store.close();
});

// Added when U2 was rebased onto U1 round 9, which accepts a time only as an instant.

test('M8 evidence whose time is not an instant (ISO date-time with an offset) is unknown to the plan and refused by a claim', () => {
  const localTime = iso(9).replace('Z', '').replace(/\.\d+$/, '');   // the same wall-clock time, with no offset
  const r = { ...request(), id: 'm8', seq: 1, state: 'queued', createdAt: iso(0), updatedAt: iso(0), waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null } as RequestRecord;
  for (const observedAt of [localTime, '3000', 1790000000 as never]) {
    const acct: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: (model) => ({ model, accountId: 'claude-a', observedAt, verdict: { state: 'available', headroom: 0.5 } }) };
    const p = plan([r], [acct], { now: at(10), pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load: new Map() });
    assert.deepEqual(p.dispatch, [], `plan: observedAt ${JSON.stringify(observedAt)} is not evidence`);
    const { store, clock } = openStore();
    clock.now = at(10);
    const s = store.submit(request());
    assert.equal(store.startAttempt(s.id, cfg('claude-a'), dispatchOf('claude-a', observedAt as string)).ok, false, `claim: observedAt ${JSON.stringify(observedAt)}`);
    store.close();
  }
});

// Added after the Anthropic seat's review of edb8db9 (two majors).

test('M9 a request that cannot be placed costs its requester no turn (L3)', () => {
  let seq = 100;
  const make = (requester: string, over: Partial<RequestRecord> = {}): RequestRecord => {
    seq += 1;
    return { ...request({ requester }), id: `m9-${seq}`, seq, state: 'queued', createdAt: iso(0), updatedAt: iso(0),
      waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null, ...over } as RequestRecord;
  };
  const a1 = make('lane', { notBefore: iso(30) });   // backing off: cannot be placed now
  const b1 = make('team-b');
  const b2 = make('team-b');
  const a2 = make('lane');
  const free: Availability = { state: 'available', headroom: 0.5 };
  const acct = (id: string): AccountStatus => ({ account: cfg(id), running: 0, evidence: (model) => ({ model, accountId: id, observedAt: iso(9), verdict: free }) });
  const p = plan([a1, b1, b2, a2], [acct('claude-a'), acct('claude-b')], { now: at(10), pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load: new Map() });
  assert.deepEqual(p.dispatch.map((d) => d.requestId).sort(), [a2.id, b1.id].sort(), 'lane\'s backing-off request costs it nothing, so its next one takes the second account');
  assert.deepEqual(p.waits.map((w) => w.requestId).sort(), [a1.id, b2.id].sort());
});

test('M10 a clock outside the instant range is refused before it can move the mark; a stored mark that is not a real time is refused', () => {
  const { store, clock, path } = openStore();
  clock.now = new Date(Date.parse('9999-12-31T23:59:59.999Z') + 1);   // year 10000: toISOString is no longer an instant
  assert.throws(() => store.submit(request()), (e: Error) => e.name === 'StoreError');
  clock.now = at(1);
  const r = store.submit(request());
  assert.notEqual(instantOf(r.createdAt), null, 'the refused time never became the mark');
  assert.equal(r.createdAt, iso(1));
  store.close();
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE clock SET last = ?').run(8.64e15);   // the largest Date, far beyond year 9999
  raw.close();
  assert.throws(() => new Store(path, { now: () => at(2) }), (e: Error) => e.name === 'StoreError', 'a record whose clock mark is not a real time is refused, not guessed at');
});

test('M11 a stoppedSince later than the plan clock restarts patience now, never lengthens it (L4)', () => {
  const r = { ...request({ pin: 'claude-a' }), id: 'm11', seq: 1, state: 'queued', createdAt: iso(0), updatedAt: iso(0),
    waiting: { reason: 'stopped', until: null, stoppedSince: iso(10 + 1440) }, notBefore: null, avoid: [], result: null, workspace: null, error: null } as RequestRecord;
  const stopped: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: (model) => ({ model, accountId: 'claude-a', observedAt: iso(9), verdict: { state: 'unavailable', reason: 'signed out', until: null } }) };
  const p = plan([r], [stopped], { now: at(10), pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load: new Map() });
  assert.equal(p.waits.length, 1);
  assert.equal(p.waits[0]!.stoppedSince, iso(10), 'a stoppedSince from the future is not evidence: patience starts now');
  assert.equal(p.waits[0]!.until, iso(40));
});

test('M12 a request for a provider with no configured account waits with its reason, then fails after pinWaitMs (L4)', () => {
  const base = { ...request({ provider: 'codex', model: 'gpt-6-sol' }), id: 'm12', seq: 1, state: 'queued', createdAt: iso(0), updatedAt: iso(0),
    waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null } as RequestRecord;
  const claudeOnly: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: (model) => ({ model, accountId: 'claude-a', observedAt: iso(9), verdict: { state: 'available', headroom: 0.5 } }) };
  const opts = { pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load: new Map() };
  const first = plan([base], [claudeOnly], { ...opts, now: at(10) });
  assert.equal(first.waits[0]?.reason.includes('no codex account is configured'), true);
  assert.equal(first.waits[0]!.stoppedSince, iso(10));
  assert.equal(first.waits[0]!.until, iso(40), 'the wait says when it will end');
  const later = plan([{ ...base, waiting: first.waits[0]! } as RequestRecord], [{ ...claudeOnly, evidence: (model) => ({ model, accountId: 'claude-a', observedAt: iso(40), verdict: { state: 'available', headroom: 0.5 } }) }], { ...opts, now: at(41) });
  assert.deepEqual(later.fail.map((f) => f.requestId), ['m12'], 'after pinWaitMs it fails, never waits for ever');
});

test('M13 the stored verdict keeps only its known fields, and an existing record is made owner-only', () => {
  const { store, path } = openStore();
  const r = store.submit(request());
  const evidence = { accountId: 'claude-a', model: 'opus', observedAt: iso(0), verdict: { state: 'available', headroom: 0.5, note: 'unvalidated extra' }, grant: ['Read'] } as never;
  const got = store.startAttempt(r.id, cfg('claude-a'), evidence);
  assert.equal(got.ok, true);
  assert.deepEqual(store.attempts(r.id)[0]!.dispatch.verdict, { state: 'available', headroom: 0.5 });
  store.close();
  chmodSync(path, 0o644);
  new Store(path).close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

// Added after the Anthropic seat's review of c5d3eaa (one major, minors and nits), and Gemini's nit.

test('M14 a backoff deadline comes from the real clock, not from a mark a runaway reading pushed ahead', () => {
  const { store, clock } = openStore();
  clock.now = new Date(Date.parse('2126-01-01T00:00:00Z'));   // one runaway reading, inside the instant range
  store.submit(request());
  clock.now = at(0);                                           // the clock is right again
  const r = store.submit(request());
  const a = store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(0)));
  assert.equal(a.ok, true);
  const back = store.finishAttempt(a.ok ? a.attempt.id : '', { kind: 'failed', errorKind: 'offline', message: 'no network' }).request;
  assert.equal(back.state, 'queued');
  assert.equal(back.notBefore, new Date(T0 + 60_000).toISOString(), 'the deadline is the real clock plus the backoff');
  clock.now = new Date(T0 + 30_000);
  assert.equal(store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(0))).ok, false, 'still backing off on the real clock, though the mark is far ahead');
  clock.now = at(2);
  assert.equal(store.startAttempt(r.id, cfg('claude-a'), dispatchOf('claude-a', iso(2))).ok, true, 'and the claim checks it against the real clock');
  store.close();
});

test('M15 an absurd duration is a broken plan (it dispatches nothing), never a crash', () => {
  const r = { ...request(), id: 'm15', seq: 1, state: 'queued', createdAt: iso(0), updatedAt: iso(0), waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null } as RequestRecord;
  const acct: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: (model) => ({ model, accountId: 'claude-a', observedAt: iso(9), verdict: { state: 'available', headroom: 0.5 } }) };
  for (const [what, over] of [['pinWaitMs', { pinWaitMs: Number.MAX_SAFE_INTEGER }], ['evidenceMaxAgeMs', { evidenceMaxAgeMs: Number.MAX_SAFE_INTEGER }], ['now', { now: new Date(Date.parse('9999-12-31T23:59:59.999Z') + 1) }]] as const) {
    let p: ReturnType<typeof plan> | undefined;
    assert.doesNotThrow(() => { p = plan([r], [acct], { now: at(10), pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load: new Map(), ...over }); }, what);
    assert.deepEqual(p!.dispatch, [], what);
    assert.match(p!.waits[0]!.reason, /nothing is dispatched/, what);
  }
});

test('M16 when every account of the provider is disabled, the wait is bounded like no account at all (L4)', () => {
  const base = { ...request(), id: 'm16', seq: 1, state: 'queued', createdAt: iso(0), updatedAt: iso(0), waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null } as RequestRecord;
  const disabled: AccountStatus = { account: { ...cfg('claude-a'), enabled: false }, running: 0, evidence: (model) => ({ model, accountId: 'claude-a', observedAt: iso(9), verdict: { state: 'available', headroom: 0.5 } }) };
  const opts = { pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load: new Map() };
  const first = plan([base], [disabled], { ...opts, now: at(10) });
  assert.equal(first.waits[0]!.until, iso(40));
  const later = plan([{ ...base, waiting: first.waits[0]! } as RequestRecord], [disabled], { ...opts, now: at(41) });
  assert.deepEqual(later.fail.map((f) => f.requestId), ['m16']);
});

test('M17 with a broken clock, an unreadable row is skipped, not a reason to lose the whole listing', () => {
  const { store, path, clock } = openStore();
  const good = store.submit(request());
  const bad = store.submit(request());
  store.close();
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE requests SET body = ? WHERE id = ?').run('{not json', bad.id);
  raw.close();
  const again = new Store(path, { now: () => clock.now });
  clock.now = new Date(Number.NaN);
  assert.deepEqual(again.waitingRequests().map((r) => r.id), [good.id]);
  again.close();
});

test('M18 a record that cannot be opened is a named error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-u2-ro-'));
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => new Store(join(dir, 'pipe.sqlite')), (e: Error) => e.name === 'StoreError');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('M9b with one free slot, a request that cannot be placed never hands its requester\'s turn to someone else (L3)', () => {
  let seq = 200;
  const make = (requester: string, over: Partial<RequestRecord> = {}): RequestRecord => {
    seq += 1;
    return { ...request({ requester }), id: `m9b-${seq}`, seq, state: 'queued', createdAt: iso(0), updatedAt: iso(0),
      waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null, ...over } as RequestRecord;
  };
  const a1 = make('lane', { notBefore: iso(30) });
  const b1 = make('team-b');
  const a2 = make('lane');
  const free: Availability = { state: 'available', headroom: 0.5 };
  const one: AccountStatus = { account: cfg('claude-a'), running: 0, evidence: (model) => ({ model, accountId: 'claude-a', observedAt: iso(9), verdict: free }) };
  const load = new Map([['team-b', { running: 1, lastDispatchedAt: iso(5) }]]);   // team-b already has work running elsewhere
  const p = plan([a1, b1, a2], [one], { now: at(10), pinWaitMs: 30 * 60_000, evidenceMaxAgeMs: 5 * 60_000, load });
  assert.deepEqual(p.dispatch.map((d) => d.requestId), [a2.id], 'lane runs nothing, so its next request takes the slot');
});

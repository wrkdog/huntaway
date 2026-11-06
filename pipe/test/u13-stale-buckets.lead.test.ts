/**
 * Acceptance grader, lane U13: a limit the provider stops reporting is retired, never an account unknown forever
 * (lead-authored; the implementation lane must not edit it).
 *
 * The ledger remembers every bucket an account has reported (`known`), and a reading that leaves one out makes the
 * account unknown: a partial reading is never taken for room. But nothing ever retires a bucket. So when a provider
 * stops reporting one (Codex reports a window as null, or drops a limit id; a plan changes), every later reading says
 * "<bucket> was not reported in the last reading", and the account stays unknown until the pipe restarts. A
 * temporary change becomes permanent, against the pipe's rule that temporary conditions never are.
 *
 * The rule: one reading without a bucket still makes the account unknown. A bucket missing from every verified reading
 * for at least `RETIRE_AFTER` readings and `RETIRE_AFTER_MS` is retired: the account is measured from what the provider
 * reports now. Each account's own kind of reading is its proof: on an account that has had a verified reading, cached
 * readings never retire a bucket, show room, add a bucket or clear a hold; they may only hold a bucket verified readings
 * still expect. An account whose readings are all cached (Claude) takes its cache as its evidence (B15). A job's own
 * limit hold is evidence of its own and is kept until it clears by its own rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as allowance from '../src/allowance.ts';

const { AllowanceLedger } = allowance;
const T0 = Date.parse('2026-09-26T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
function ledger(freshnessMinutes = 10) {
  const clock = { now: at(0) };
  const l = new AllowanceLedger({ freshnessMs: freshnessMinutes * 60_000, now: () => clock.now });
  return { l, set: (minutes: number) => { clock.now = at(minutes); } };
}
const bucket = (name: string, usedFraction: number | null, resetsInMinutes: number | null, model: string | null = null) =>
  ({ bucket: name, model, usedFraction, resetsAt: resetsInMinutes === null ? null : iso(resetsInMinutes) });

test('B0 the ledger states how long a bucket must be missing before it is retired', () => {
  const after = (allowance as Record<string, unknown>).RETIRE_AFTER, afterMs = (allowance as Record<string, unknown>).RETIRE_AFTER_MS;
  assert.equal(after, 3, 'three verified readings');
  assert.equal(afterMs, 30 * 60_000, 'over at least thirty minutes');
});

test('B1 a bucket the provider stops reporting makes the account unknown for a while, then is retired', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('codex:primary', 0.2, 300), bucket('codex:secondary', 0.1, 10_000)]);
  assert.equal(l.view('acct').state, 'ok');
  // The provider stops reporting the secondary window.
  set(1); l.record('acct', [bucket('codex:primary', 0.2, 300)]);
  const once = l.view('acct');
  assert.equal(once.state, 'unknown', 'one reading without it is not trusted');
  if (once.state === 'unknown') assert.match(once.reason, /codex:secondary/);
  set(15); l.record('acct', [bucket('codex:primary', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'unknown', 'two readings, fourteen minutes: still not retired');
  set(31); l.record('acct', [bucket('codex:primary', 0.2, 300)]);
  const later = l.view('acct');
  assert.equal(later.state, 'ok', `three readings over thirty minutes: the bucket is retired: ${JSON.stringify(later)}`);
  // It can come back, and is known again.
  set(32); l.record('acct', [bucket('codex:primary', 0.2, 300), bucket('codex:secondary', 1, 10_000)]);
  assert.equal(l.view('acct').state, 'exhausted', 'a bucket that returns counts again');
});

test('B2 many quick readings never retire a bucket before the time has passed, nor does one that reports it again', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  for (let m = 1; m <= 10; m++) { set(m); l.record('acct', [bucket('a', 0.2, 300)]); }
  assert.equal(l.view('acct').state, 'unknown', 'ten readings in ten minutes: not yet');
  set(20); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  set(40); l.record('acct', [bucket('a', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'unknown', 'reported again at 20, so its absence starts over at 40');
});

test('B3 on an account with verified readings, unverified (cached) readings never retire a bucket', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('session', 0.2, 300), bucket('week', 0.1, 10_000)]);
  for (const m of [1, 20, 40, 60]) { set(m); l.record('acct', [bucket('session', 0.2, 300)], undefined, { verified: false }); }
  assert.equal(l.view('acct').state, 'unknown', 'a cache may simply have lost the bucket');
  set(61); l.record('acct', [bucket('session', 0.2, 300)]);
  const v = l.view('acct');
  assert.ok(v.state === 'unknown' && /week was not reported/.test(v.reason), `the first verified omission: still expected (${JSON.stringify(v)})`);
});

test('B4 retiring a bucket keeps a job\'s own limit on it until that limit clears by its own rules', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('session', 0.2, 300), bucket('week', 0.5, 10_000)]);
  // A job hits the week limit, which resets in two hours.
  set(1); l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(121) });
  for (const m of [2, 20, 40]) { set(m); l.record('acct', [bucket('session', 0.2, 300)]); }
  assert.equal(l.view('acct').state, 'exhausted', 'the job\'s limit still stands after the bucket is retired');
  set(122); l.record('acct', [bucket('session', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'ok', 'and clears at its reset');
});

test('B5 a job\'s limit that stated no reset, on a retired bucket, clears after the resetless wait, never stands forever', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('session', 0.2, 300), bucket('week', 0.5, 10_000)]);
  for (const m of [2, 20]) { set(m); l.record('acct', [bucket('session', 0.2, 300)]); }
  // A job hits the week limit, stating no reset; the next reading retires the bucket.
  set(35); l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: null });
  set(40); l.record('acct', [bucket('session', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'exhausted', 'the job\'s limit stands at first');
  // No reading of the retired bucket will ever come to clear it; the resetless wait (L13) bounds it instead.
  set(35 + allowance.RESETLESS_LIMIT_WAIT_MS / 60_000 + 1); l.record('acct', [bucket('session', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'ok', 'it clears after the resetless wait');
});

// ---- Round 2 (Sol on 97c2c30) -----------------------------------------------------------------------------------

test('B6 a new job limit on a bucket already retired clears at its reset, or after the resetless wait', () => {
  for (const resets of [true, false]) {
    const { l, set } = ledger(10);
    l.record('acct', [bucket('session', 0.2, 300), bucket('week', 0.5, 10_000)]);
    for (const m of [1, 20, 40]) { set(m); l.record('acct', [bucket('session', 0.2, 300)]); }
    assert.equal(l.view('acct').state, 'ok', 'week is retired');
    set(45); l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: resets ? iso(105) : null });
    set(50); l.record('acct', [bucket('session', 0.2, 300)]);
    assert.equal(l.view('acct').state, 'exhausted', `${resets ? 'with' : 'without'} a reset: the new limit stands at first`);
    set(45 + allowance.RESETLESS_LIMIT_WAIT_MS / 60_000 + 61); l.record('acct', [bucket('session', 0.2, 300)]);
    assert.equal(l.view('acct').state, 'ok', `${resets ? 'with' : 'without'} a reset: it ends`);
  }
});

test('B7 after a restart, a saved job limit on a bucket no reading reports clears at its reset', () => {
  const { l, set } = ledger(10);
  // A fresh ledger restores a saved limit (as the service does at startup), then the provider reports only the session.
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(60), observedAt: iso(0) });
  set(1); l.record('acct', [bucket('session', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'exhausted', 'the saved limit stands until its reset');
  set(70); l.record('acct', [bucket('session', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'ok', 'and ends at it, although no reading reports its bucket');
});

// ---- Round 3 (Sol on 21d2bb9) -----------------------------------------------------------------------------------

test('B8 a retired model-scoped bucket\'s job limit ends, although the same bucket is still reported for another model', () => {
  const { l, set } = ledger(10);
  const all = () => [bucket('week', 0.2, 10_000), bucket('week', 0.2, 10_000, 'fable')];
  l.record('acct', [...all(), bucket('week', 0.3, 10_000, 'opus')]);
  for (const m of [1, 20, 40]) { set(m); l.record('acct', all()); }
  set(45); l.recordLimit('acct', { bucket: 'week', model: 'opus', resetsAt: iso(105) });
  set(50); l.record('acct', all());
  assert.equal(l.view('acct', 'opus').state, 'exhausted', 'the opus limit stands at first');
  set(110); l.record('acct', all());
  assert.equal(l.view('acct', 'opus').state, 'ok', 'and ends at its reset, although week is still reported for fable');
});

test('B9 one measurement replayed never counts twice toward retirement', () => {
  const { l, set } = ledger(60);
  l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)], iso(0));
  set(2); l.record('acct', [bucket('a', 0.2, 300)], iso(1));
  set(3); l.record('acct', [bucket('a', 0.2, 300)], iso(1));   // the same measurement again
  set(31); l.record('acct', [bucket('a', 0.2, 300)], iso(31));
  assert.equal(l.view('acct').state, 'unknown', 'two distinct readings are not three');
});

test('B10 a reading with an entry the ledger cannot read never counts as leaving a bucket out', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  const broken = { bucket: 'b', usedFraction: 0.1, resetsAt: iso(300) } as unknown as ReturnType<typeof bucket>;   // no model
  for (const m of [1, 20, 40]) { set(m); l.record('acct', [bucket('a', 0.2, 300), broken]); }
  assert.equal(l.view('acct').state, 'unknown', 'an unreadable entry for b is not proof that b is gone');
});

test('B11 a cached reading never brings back a bucket that verified readings retired', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  for (const m of [1, 20, 40]) { set(m); l.record('acct', [bucket('a', 0.2, 300)]); }
  assert.equal(l.view('acct').state, 'ok', 'b is retired');
  set(41); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)], undefined, { verified: false });
  set(42); l.record('acct', [bucket('a', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'ok', 'a cached answer that still lists b does not restart the wait');
  set(43); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  set(44); l.record('acct', [bucket('a', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'unknown', 'a verified reading that reports b again makes it count again');
});

// ---- Round 4 (Sol on 605c1f8) -----------------------------------------------------------------------------------

test('B13 a cached reading of a retired bucket never sets a hold on it, nor shows room from it', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  for (const m of [1, 20, 40]) { set(m); l.record('acct', [bucket('a', 0.2, 300)]); }
  assert.equal(l.view('acct').state, 'ok', 'b is retired');
  // A cache still lists b, full: it is not evidence about a bucket verified readings retired.
  set(41); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 1, 200)], undefined, { verified: false });
  assert.equal(l.view('acct').state, 'ok', 'no hold from a cached retired bucket');
  set(250); l.record('acct', [bucket('a', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'ok', 'and nothing waits on it after its reset');
  // Model-scoped: a cached retired bucket with room does not stand in for the whole account's unmeasured one.
  const m = ledger(10);
  m.l.record('acct', [bucket('week', 0.2, 300), bucket('week', 0.3, 300, 'fable')]);
  for (const t of [1, 20, 40]) { m.set(t); m.l.record('acct', [bucket('week', 0.2, 300)]); }
  m.set(41); m.l.record('acct', [bucket('week', null, 300), bucket('week', 0.1, 300, 'fable')], undefined, { verified: false });
  // A cached reading on a verified account shows no room at all (B20): any room shown is the verified reading's.
  const v = m.l.view('acct', 'fable');
  assert.ok(v.state !== 'ok' || (v.binding === 'week' && Math.abs(v.headroom - 0.8) < 1e-9), `a cached retired bucket is not room (${JSON.stringify(v)})`);
});

test('B14 a reading that could not be read in full shows no room', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  for (const m of [1, 20, 40]) { set(m); l.record('acct', [bucket('a', 0.2, 300)]); }
  assert.equal(l.view('acct').state, 'ok', 'b is retired');
  const broken = { bucket: 'b', usedFraction: 0.1, resetsAt: iso(300) } as unknown as ReturnType<typeof bucket>;   // no model
  set(41); l.record('acct', [bucket('a', 0.2, 300), broken]);
  assert.equal(l.view('acct').state, 'unknown', 'an unreadable entry may be the retired bucket, full: no room');
  set(42); l.record('acct', [bucket('a', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'ok', 'the next complete reading measures again');
});

// ---- Round 5 (Sol, Opus and Google on 0a112bc) ------------------------------------------------------------------

const cached = { verified: false };

test('B15 an account whose readings are all cached (Claude) retires a bucket its cache stops reporting, and a cache can bring it back', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('session', 0.2, 300), bucket('week', 0.1, 10_000, 'opus')], undefined, cached);
  for (const m of [1, 20]) { set(m); l.record('acct', [bucket('session', 0.2, 300)], undefined, cached); }
  assert.equal(l.view('acct', 'opus').state, 'unknown', 'not yet: two cached omissions');
  set(40); l.record('acct', [bucket('session', 0.2, 300)], undefined, cached);
  assert.equal(l.view('acct', 'opus').state, 'ok', 'three cached omissions over thirty minutes retire it: Claude never waits for ever');
  set(41); l.record('acct', [bucket('session', 0.2, 300), bucket('week', 1, 500, 'opus')], undefined, cached);
  assert.equal(l.view('acct', 'opus').state, 'exhausted', 'with no verified readings at all, the cache that retired it can bring it back');
});

test('B16 a limit that names no bucket ends at its reset, or the resetless wait, once no reported bucket lies in its scope', () => {
  for (const resets of [true, false]) {
    const { l, set } = ledger(10);
    l.record('acct', [bucket('a', 0.2, 300)]);
    // The provider now reports nothing at all, verified and complete; a job hits a limit that names no bucket.
    for (const m of [2, 20]) { set(m); l.record('acct', []); }
    set(35); l.recordLimit('acct', { bucket: null, model: null, resetsAt: resets ? iso(95) : null });
    set(40); l.record('acct', []);   // the third omission over thirty minutes: 'a' is retired
    assert.equal(l.view('acct').state, 'exhausted', `${resets ? 'with' : 'without'} a reset: it stands at first`);
    set(35 + allowance.RESETLESS_LIMIT_WAIT_MS / 60_000 + 61); l.record('acct', []);
    assert.notEqual(l.view('acct').state, 'exhausted', `${resets ? 'with' : 'without'} a reset: it ends, never exhausted for ever`);
  }
});

test('B17 a reading that could not be read in full never clears a hold, directly or when a limit arrives after it', () => {
  const broken = { bucket: 'b', usedFraction: 0.1, resetsAt: iso(300) } as unknown as ReturnType<typeof bucket>;   // no model
  // A reading hold on a full bucket.
  const r = ledger(10);
  r.l.record('acct', [bucket('a', 0.2, 300), bucket('b', 1, 100)]);
  r.set(1); r.l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 100), broken]);
  r.set(2); r.l.record('acct', [bucket('a', 0.2, 300), bucket('b', 1, 100)]);
  assert.equal(r.l.view('acct').state, 'exhausted', 'the incomplete reading did not lift b\'s reading hold');
  // A job's named limit, and one that names no bucket.
  for (const named of ['b', null]) {
    const { l, set } = ledger(10);
    l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
    set(1); l.recordLimit('acct', { bucket: named, model: null, resetsAt: iso(100) });
    set(2); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300), broken]);
    set(3); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)], undefined, cached);
    assert.equal(l.view('acct').state, 'exhausted', `a ${named === null ? 'no-bucket' : 'named'} limit survives an incomplete reading`);
  }
  // A limit that arrives, dated before an incomplete reading, is not settled against it.
  const late = ledger(10);
  late.l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)]);
  late.set(5); late.l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300), broken]);
  late.set(6); late.l.recordLimit('acct', { bucket: 'b', model: null, resetsAt: iso(100), observedAt: iso(4) });
  assert.equal(late.l.view('acct').state, 'exhausted', 'the limit stands: it is not settled against the incomplete reading');
  late.set(7); late.l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 300)], undefined, cached);
  assert.equal(late.l.view('acct').state, 'exhausted');
});

test('B18 on an account with verified readings, a cached reading never clears a hold', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('a', 0.2, 300), bucket('b', 1, 100)]);
  set(1); l.record('acct', [bucket('a', 0.2, 300)]);                     // a verified reading leaves b out: its hold stands
  set(2); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 100)], undefined, cached);
  assert.equal(l.view('acct').state, 'exhausted', 'a cache showing b with room does not lift the hold before its reset');
  set(3); l.record('acct', [bucket('a', 0.2, 300), bucket('b', 0.1, 100)]);
  assert.equal(l.view('acct').state, 'ok', 'a verified reading does');
});

test('B19 the first verified reading starts the count of omissions over: cached ones made before it no longer count', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('x', 0.2, 300), bucket('y', 0.1, 10_000)], undefined, cached);
  for (const m of [1, 15]) { set(m); l.record('acct', [bucket('x', 0.2, 300)], undefined, cached); }
  set(31); l.record('acct', [bucket('x', 0.2, 300)]);   // the account's first verified reading, without y
  assert.equal(l.view('acct').state, 'unknown', 'one verified omission: the two cached ones before it do not count');
  for (const m of [45, 62]) { set(m); l.record('acct', [bucket('x', 0.2, 300)]); }
  assert.equal(l.view('acct').state, 'ok', 'three verified omissions over thirty minutes retire it');
});

test('B20 on an account with verified readings, a cached reading never shows room, adds a bucket, or dates the evidence', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('x', 0.95, 300), bucket('y', 0.5, 300)]);
  set(2); l.record('acct', [bucket('x', 0.1, 300), bucket('y', 0.1, 300), bucket('z', 0.1, 300)], undefined, cached);
  let v = l.view('acct');
  assert.ok(v.state === 'ok' && Math.abs(v.headroom - 0.05) < 1e-9, `room is the verified reading's, not the cache's (${JSON.stringify(v)})`);
  set(3); l.record('acct', [bucket('x', 0.9, 300), bucket('y', 0.5, 300)], iso(1));   // verified, measured before the cache
  v = l.view('acct');
  assert.ok(v.state === 'ok' && Math.abs(v.headroom - 0.1) < 1e-9,
    `a verified reading measured before the cached one is taken, and z, which only the cache reported, is not expected (${JSON.stringify(v)})`);
  set(20); l.record('acct', [bucket('x', 0.1, 300), bucket('y', 0.1, 300)], undefined, cached);
  v = l.view('acct');
  assert.ok(v.state === 'unknown' && /older than/.test(v.reason), `with only cached readings since, the evidence is stale (${JSON.stringify(v)})`);
});

test('B21 on an account with verified readings, a cached reading holds a bucket verified readings expect, and only such a bucket', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('x', 0.2, 300)]);
  set(1); l.record('acct', [bucket('x', 0.2, 300), bucket('z', 1, null)], undefined, cached);
  assert.equal(l.view('acct').state, 'ok', 'a full bucket only a cache reports sets no hold: no verified reading would ever lift it');
  set(2); l.record('acct', [bucket('x', 1, 100)], undefined, cached);
  assert.equal(l.view('acct').state, 'exhausted', 'a cache reading a known bucket full holds it');
  set(3); l.record('acct', [bucket('x', 0.2, 300)]);
  assert.equal(l.view('acct').state, 'ok', 'a newer verified reading with room lifts that hold');
});

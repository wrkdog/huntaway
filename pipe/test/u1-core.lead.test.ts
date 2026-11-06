/**
 * Acceptance grader, lane U1: policy, identity, allowance and availability (lead-authored).
 * The implementation lane must not edit this file.
 *
 * Sources:
 * - docs/SPEC.md, core concepts 1-4 and "Model policy lives in configuration";
 * - docs/ROUTER-MAP.md, the Allowance, Identity and Choice invariants.
 *
 * Everything in U1 is pure and synchronous. The only I/O is `validateAccounts`, which resolves
 * login folders on disk. Time comes from an injected clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePolicy, checkChoice, PolicyError } from '../src/policy.ts';
import { validateAccounts, AccountConfigError, type AccountConfig } from '../src/identity.ts';
import { AllowanceLedger, instantOf } from '../src/allowance.ts';
import { availability, IdentityLedger } from '../src/availability.ts';

// ── policy as data ──────────────────────────────────────────────────────────

const POLICY = {
  claude: { models: { opus: 'default', fable: 'hard' }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { models: { 'gpt-6-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
};

test('P1 policy is data: it parses, and a malformed policy is refused with a clear message', () => {
  const policy = parsePolicy(structuredClone(POLICY));
  assert.ok(policy);
  const bad: Array<[string, unknown, RegExp]> = [
    ['two defaults', { claude: { models: { opus: 'default', fable: 'default' }, efforts: ['low'] } }, /claude/],
    ['no default', { codex: { models: { 'gpt-6-astra': 'hard' }, efforts: ['low'] } }, /codex/],
    ['empty efforts', { claude: { models: { opus: 'default' }, efforts: [] } }, /claude/],
    ['duplicate effort', { claude: { models: { opus: 'default' }, efforts: ['low', 'low'] } }, /claude/],
    ['unknown provider', { openrouter: { models: { x: 'default' }, efforts: ['low'] } }, /openrouter/],
    ['unknown use', { claude: { models: { opus: 'cheap' }, efforts: ['low'] } }, /claude/],
    ['not an object', 'claude', /./],
  ];
  for (const [what, raw, names] of bad) {
    assert.throws(() => parsePolicy(raw), (e: unknown) => e instanceof PolicyError && names.test(e.message), what);
  }
});

test('P2 the caller must actively choose a model and an effort; the refusal lists the options', () => {
  const policy = parsePolicy(structuredClone(POLICY));
  for (const missing of [{ effort: 'high' }, { model: 'opus' }, {}] as Array<{ model?: string; effort?: string }>) {
    const got = checkChoice(policy, { provider: 'claude', ...missing });
    assert.equal(got.ok, false);
    if (got.ok) continue;
    assert.equal(got.code, 'choice_required', JSON.stringify(missing));
    for (const option of ['opus', 'fable', 'low', 'max']) assert.ok(got.message.includes(option), `${got.message} lists ${option}`);
  }
  assert.deepEqual(checkChoice(policy, { provider: 'claude', model: 'opus', effort: 'high', reason: 'a routine fix' }), { ok: true, use: 'default', reason: 'a routine fix' });
  assert.deepEqual(checkChoice(policy, { provider: 'codex', model: 'gpt-6-sol', effort: 'ultra', reason: 'a deep audit' }), { ok: true, use: 'default', reason: 'a deep audit' });
});

test('P3 an unknown model or effort is answered with the provider\'s real options; nothing is swapped', () => {
  const policy = parsePolicy(structuredClone(POLICY));
  const model = checkChoice(policy, { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  assert.equal(model.ok, false);
  if (!model.ok) {
    assert.equal(model.code, 'unknown_model');
    assert.deepEqual([...model.options].sort(), ['gpt-6-astra', 'gpt-6-sol']);
  }
  const effort = checkChoice(policy, { provider: 'claude', model: 'opus', effort: 'ultra' });
  assert.equal(effort.ok, false);
  if (!effort.ok) {
    assert.equal(effort.code, 'unsupported_effort', 'ultra is not a Claude level');
    assert.deepEqual(effort.options, POLICY.claude.efforts);
  }
  const provider = checkChoice(policy, { provider: 'gemini', model: 'x', effort: 'low' });
  assert.equal(provider.ok, false);
  if (!provider.ok) assert.equal(provider.code, 'unknown_provider');
});

test('P4 a model kept for hard problems needs a stated reason, which is returned for the record', () => {
  const policy = parsePolicy(structuredClone(POLICY));
  for (const reason of [undefined, '', '   ']) {
    const got = checkChoice(policy, { provider: 'codex', model: 'gpt-6-astra', effort: 'high', ...(reason === undefined ? {} : { reason }) });
    assert.equal(got.ok, false);
    if (!got.ok) {
      assert.equal(got.code, 'reason_required');
      assert.match(got.message, /hard/);
    }
  }
  assert.deepEqual(
    checkChoice(policy, { provider: 'claude', model: 'fable', effort: 'max', reason: 'cross-module race' }),
    { ok: true, use: 'hard', reason: 'cross-module race' },
  );
});

// Added after review round 1 (Sol and Gemini, U1 at 0ae8fe6).

test('P5 a reason given for a default model is kept for the record', () => {
  const policy = parsePolicy(structuredClone(POLICY));
  assert.deepEqual(
    checkChoice(policy, { provider: 'codex', model: 'gpt-6-sol', effort: 'low', reason: '  a one-line rename  ' }),
    { ok: true, use: 'default', reason: 'a one-line rename' },
  );
});

test('P6 the refusal for a missing reason offers the default model as the alternative', () => {
  const policy = parsePolicy(structuredClone(POLICY));
  const got = checkChoice(policy, { provider: 'claude', model: 'fable', effort: 'high' });
  assert.equal(got.ok, false);
  if (!got.ok) assert.deepEqual(got.options, ['opus']);
});

test('P7 model ids are plain data, whatever they are called', () => {
  const policy = parsePolicy({ claude: { models: JSON.parse('{"__proto__":"hard","opus":"default"}'), efforts: ['low'] } });
  const proto = checkChoice(policy, { provider: 'claude', model: '__proto__', effort: 'low' });
  assert.equal(proto.ok, false);
  if (!proto.ok) assert.equal(proto.code, 'reason_required', '__proto__ is an ordinary "hard" model here');
  for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
    const got = checkChoice(policy, { provider: 'claude', model: inherited, effort: 'low' });
    assert.equal(got.ok, false, inherited);
    if (!got.ok) assert.equal(got.code, 'unknown_model', inherited);
  }
});

// Added after review round 2 (Sol, U1 at cb77c36).

test('P8 every accepted choice says why (AGENTS rule 4), default models included', () => {
  const policy = parsePolicy(structuredClone(POLICY));
  for (const reason of [undefined, '', '  ']) {
    const got = checkChoice(policy, { provider: 'claude', model: 'opus', effort: 'high', ...(reason === undefined ? {} : { reason }) });
    assert.equal(got.ok, false);
    if (!got.ok) {
      assert.equal(got.code, 'reason_required');
      assert.match(got.message, /why/);
    }
  }
});

// ── identity ────────────────────────────────────────────────────────────────

function account(over: Partial<AccountConfig> & { id: string; loginDir: string }): AccountConfig {
  return { provider: 'claude', fingerprint: `fp-${over.id}`, maxConcurrency: 1, enabled: true, ...over };
}

test('I1 accounts are refused when they share an id, a pinned login or a login folder (even through a link)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u1-'));
  const a = join(root, 'a'); const b = join(root, 'b'); const alias = join(root, 'alias-of-a');
  mkdirSync(a); mkdirSync(b); symlinkSync(a, alias);
  validateAccounts([account({ id: 'one', loginDir: a }), account({ id: 'two', loginDir: b })]);   // control
  const refused: Array<[string, AccountConfig[]]> = [
    ['same id', [account({ id: 'one', loginDir: a }), account({ id: 'one', loginDir: b, fingerprint: 'fp-x' })]],
    ['same pinned login', [account({ id: 'one', loginDir: a, fingerprint: 'same' }), account({ id: 'two', loginDir: b, fingerprint: 'same' })]],
    ['same folder', [account({ id: 'one', loginDir: a }), account({ id: 'two', loginDir: a })]],
    ['folder through a link', [account({ id: 'one', loginDir: a }), account({ id: 'two', loginDir: alias })]],
    ['relative folder', [account({ id: 'one', loginDir: 'relative/dir' })]],
    ['zero concurrency', [account({ id: 'one', loginDir: a, maxConcurrency: 0 })]],
  ];
  for (const [what, accounts] of refused) {
    assert.throws(() => validateAccounts(accounts), AccountConfigError, what);
  }
});

// Added after review round 2 (Sol, U1 at cb77c36).

test('I2 an account never uses its provider\'s default login folder, directly or through a link', () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u1-default-'));
  const home = join(root, 'dot-claude'); const own = join(root, 'own'); const link = join(root, 'link-to-default');
  mkdirSync(home); mkdirSync(own); symlinkSync(home, link);
  const defaults = { defaultLoginDirs: { claude: home } };
  validateAccounts([account({ id: 'one', loginDir: own })], defaults);   // control
  assert.throws(() => validateAccounts([account({ id: 'one', loginDir: home })], defaults), AccountConfigError);
  assert.throws(() => validateAccounts([account({ id: 'one', loginDir: link })], defaults), AccountConfigError);
  validateAccounts([account({ id: 'one', loginDir: home, provider: 'codex' })], defaults);   // another provider's default is not claude's
});

// ── allowance ───────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-09-24T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();

function ledger(freshnessMinutes = 10) {
  const clock = { now: at(0) };
  const l = new AllowanceLedger({ freshnessMs: freshnessMinutes * 60_000, now: () => clock.now });
  return { l, set: (minutes: number) => { clock.now = at(minutes); } };
}
const bucket = (name: string, usedFraction: number | null, resetsInMinutes: number | null, model: string | null = null) =>
  ({ bucket: name, model, usedFraction, resetsAt: resetsInMinutes === null ? null : iso(resetsInMinutes) });

test('A1 no reading, an unmeasured bucket or a stale reading is unknown, never capacity', () => {
  const { l, set } = ledger(10);
  assert.equal(l.view('acct').state, 'unknown', 'no reading');
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', null, 60)]);
  assert.equal(l.view('acct').state, 'unknown', 'one applicable bucket is unmeasured');
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', 0.1, 60)]);
  assert.equal(l.view('acct').state, 'ok');
  set(11);
  assert.equal(l.view('acct').state, 'unknown', 'older than the freshness window, on the ledger\'s own clock');
});

test('A2 scarcity is the maximum over the buckets that apply, not their sum', () => {
  const { l } = ledger();
  l.record('acct', [bucket('week', 0.6, 600), bucket('session', 0.3, 60)]);
  const v = l.view('acct');
  assert.equal(v.state, 'ok');
  if (v.state === 'ok') {
    assert.ok(Math.abs(v.headroom - 0.4) < 1e-9, `headroom ${v.headroom}`);
    assert.equal(v.binding, 'week');
  }
});

test('A3 a limit hit holds until the stated reset; only a newer measured reading clears it', () => {
  const { l, set } = ledger(30);
  l.record('acct', [bucket('week', 0.5, 600)]);
  set(1);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(120) });
  let v = l.view('acct');
  assert.deepEqual(v, { state: 'exhausted', accountId: 'acct', bucket: 'week', until: iso(120) });
  set(2);
  l.record('acct', [bucket('week', null, 600)]);
  assert.equal(l.view('acct').state, 'exhausted', 'an unmeasured reading never clears a hold');
  l.recordProbeFailure('acct');
  assert.equal(l.view('acct').state, 'exhausted', 'a failed probe never touches allowance');
  set(3);
  l.record('acct', [bucket('week', 0.97, 600)]);
  v = l.view('acct');
  assert.equal(v.state, 'ok', 'a newer measured reading below the limit clears the hold');
});

test('A4 a measured full bucket is exhausted until its reset; after the reset, old readings are not reused', () => {
  const { l, set } = ledger(600);
  l.record('acct', [bucket('session', 1, 30), bucket('week', 0.2, 6000)]);
  assert.deepEqual(l.view('acct'), { state: 'exhausted', accountId: 'acct', bucket: 'session', until: iso(30) });
  set(31);
  assert.equal(l.view('acct').state, 'unknown', 'the window rolled over; the old reading no longer describes it');
  l.record('acct', [bucket('session', 0.05, 330), bucket('week', 0.2, 6000)]);
  assert.equal(l.view('acct').state, 'ok');
  set(32);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(40) });
  set(41);
  assert.equal(l.view('acct').state, 'unknown', 'a lapsed limit hit leaves that bucket unmeasured until a new reading');
  const partial = ledger(600);
  partial.l.record('acct', [bucket('session', 0.8, 30)]);
  assert.equal(partial.l.view('acct').state, 'ok');
  partial.set(31);
  assert.equal(partial.l.view('acct').state, 'unknown', 'a reading describes its window only until that window resets');
});

test('A5 a hold with no stated reset lasts until a newer measured reading', () => {
  const { l, set } = ledger(600);
  l.recordLimit('acct', { bucket: 'credits', model: null, resetsAt: null });
  set(500);
  assert.deepEqual(l.view('acct'), { state: 'exhausted', accountId: 'acct', bucket: 'credits', until: null });
  set(501);
  l.record('acct', [bucket('credits', 0.1, null)]);
  assert.equal(l.view('acct').state, 'ok');
});

test('A6 a model-only limit blocks that model, not the whole account', () => {
  const { l } = ledger();
  l.record('acct', [bucket('week', 0.3, 600), bucket('week:fable', 1, 900, 'fable')]);
  assert.equal(l.view('acct', 'fable').state, 'exhausted');
  assert.equal(l.view('acct', 'opus').state, 'ok');
  assert.equal(l.view('acct').state, 'ok', 'the account as a whole is not blocked');
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(600) });
  assert.equal(l.view('acct', 'opus').state, 'exhausted', 'a whole-account limit blocks every model');
});

test('A7 readings and limits belong only to the account that produced them', () => {
  const { l } = ledger();
  l.record('one', [bucket('week', 0.1, 600)]);
  l.record('two', [bucket('week', 0.1, 600)]);
  l.recordLimit('one', { bucket: 'week', model: null, resetsAt: iso(600) });
  assert.equal(l.view('one').state, 'exhausted');
  assert.equal(l.view('two').state, 'ok');
  assert.equal(l.view('three').state, 'unknown');
  for (const id of ['one', 'two', 'three']) assert.equal(l.view(id).accountId, id, 'every view names the account it describes');
});

// Added after review round 1 (Sol and Gemini, U1 at 0ae8fe6).

test('A8 a newer reading that omits a full bucket does not clear its exhaustion', () => {
  const { l, set } = ledger(600);
  l.record('acct', [bucket('week', 0.2, 6000), bucket('session', 1, 30)]);
  set(1);
  l.record('acct', [bucket('week', 0.2, 6000)]);
  assert.deepEqual(l.view('acct'), { state: 'exhausted', accountId: 'acct', bucket: 'session', until: iso(30) });
  set(31);
  assert.equal(l.view('acct').state, 'unknown', 'after its reset, the omitted bucket is unmeasured, not free');
  l.record('acct', [bucket('week', 0.2, 6000), bucket('session', 0.1, 330)]);
  assert.equal(l.view('acct').state, 'ok');
});

test('A9 holds are kept per bucket and model, and the most restrictive one stands', () => {
  const { l, set } = ledger(600);
  l.recordLimit('acct', { bucket: 'week', model: 'fable', resetsAt: iso(600) });
  l.recordLimit('acct', { bucket: 'week', model: 'opus', resetsAt: iso(300) });
  assert.deepEqual(l.view('acct', 'fable'), { state: 'exhausted', accountId: 'acct', bucket: 'week', until: iso(600) });
  assert.deepEqual(l.view('acct', 'opus'), { state: 'exhausted', accountId: 'acct', bucket: 'week', until: iso(300) });
  set(1);
  l.record('acct', [bucket('week', 0.2, 6000)]);
  assert.equal(l.view('acct', 'fable').state, 'exhausted', 'a whole-account reading does not measure a model-only limit');
  l.record('acct', [bucket('week', 0.2, 6000), bucket('week', 0.3, 6000, 'fable')]);
  assert.equal(l.view('acct', 'fable').state, 'ok', 'a newer reading of that bucket for that model clears it');
  assert.equal(l.view('acct', 'opus').state, 'exhausted', 'and leaves the other model held');
  // The readings report the credits bucket, unmeasured: a job's limit on a bucket no reading reports at all ends at its
  // reset or the resetless wait (U13), which is not what this checks.
  l.record('acct', [bucket('week', 0.2, 6000), bucket('week', 0.3, 6000, 'fable'), bucket('credits', null, null)]);
  l.recordLimit('acct', { bucket: 'credits', model: null, resetsAt: null });
  l.recordLimit('acct', { bucket: 'credits', model: null, resetsAt: iso(60) });
  set(61);
  assert.deepEqual(l.view('acct', 'fable'), { state: 'exhausted', accountId: 'acct', bucket: 'credits', until: null },
    'a later dated hit does not shorten a hold with no stated reset');
});

test('A10 a clock that moves backwards never makes old evidence fresh or clears a hold', () => {
  const { l, set } = ledger(10);
  set(100);
  l.record('acct', [bucket('week', 0.2, 6000)]);
  set(95);
  assert.equal(l.view('acct').state, 'unknown', 'a reading from the ledger\'s future is not trusted');
  const hit = ledger(600);
  hit.set(100);
  hit.l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(500) });
  hit.set(90);
  hit.l.record('acct', [bucket('week', 0.2, 6000)]);
  hit.set(101);
  assert.equal(hit.l.view('acct').state, 'exhausted', 'a reading stamped before the hit does not clear it');
  assert.throws(() => new AllowanceLedger({ freshnessMs: Number.NaN }), 'the freshness window must be a real duration');
  assert.throws(() => new AllowanceLedger({ freshnessMs: 0 }));
});

test('A11 malformed readings are unmeasured, never capacity', () => {
  for (const [what, reading] of [
    ['NaN', { bucket: 'week', model: null, usedFraction: Number.NaN, resetsAt: iso(600) }],
    ['negative', { bucket: 'week', model: null, usedFraction: -0.1, resetsAt: iso(600) }],
    ['unreadable reset', { bucket: 'week', model: null, usedFraction: 0.2, resetsAt: 'next tuesday' }],
  ] as const) {
    const { l } = ledger();
    l.record('acct', [reading]);
    assert.equal(l.view('acct').state, 'unknown', what);
  }
  const over = ledger();
  over.l.record('acct', [bucket('week', 1.3, 600)]);
  assert.equal(over.l.view('acct').state, 'exhausted', 'over the limit is exhausted');
});

// Added after review round 2 (Sol, U1 at cb77c36).

test('A12 a reading stamped before the latest reading is ignored, never a replacement', () => {
  const { l, set } = ledger(600);
  set(100);
  l.record('acct', [bucket('week', 0.2, 6000), bucket('session', null, 6000)]);
  assert.equal(l.view('acct').state, 'unknown');
  set(90);
  l.record('acct', [bucket('week', 0.2, 6000)]);   // older, and it omits the unmeasured bucket
  set(101);
  assert.equal(l.view('acct').state, 'unknown', 'the older reading did not replace the newer one');
});

test('A13 a stronger hold keeps the time of the latest hit', () => {
  const { l, set } = ledger(600);
  set(100);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(200) });
  set(90);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(300) });
  set(95);
  l.record('acct', [bucket('week', 0.2, 6000)]);   // newer than the second hit, older than the first
  set(101);
  assert.deepEqual(l.view('acct'), { state: 'exhausted', accountId: 'acct', bucket: 'week', until: iso(300) });
});

test('A14 a clock that cannot tell the time makes evidence unknown, and cannot stamp new evidence', () => {
  const clock = { now: at(0) };
  const l = new AllowanceLedger({ freshnessMs: 600_000, now: () => clock.now });
  l.record('acct', [bucket('week', 0.2, 600)]);
  assert.equal(l.view('acct').state, 'ok');
  clock.now = new Date(Number.NaN);
  assert.equal(l.view('acct').state, 'unknown');
  assert.throws(() => l.record('acct', [bucket('week', 0.1, 600)]), RangeError);
  assert.throws(() => l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: null }), RangeError);
});

// Added after review round 3 (Sol, U1 at e02f3ab).

test('A15 a bucket once seen must keep being reported: omitting it is not evidence', () => {
  const { l } = ledger();
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', null, 60)]);
  assert.equal(l.view('acct').state, 'unknown');
  l.record('acct', [bucket('week', 0.2, 600)]);
  assert.equal(l.view('acct').state, 'unknown', 'an omitted unmeasured bucket is still unmeasured');
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', 0.3, 60)]);
  assert.equal(l.view('acct').state, 'ok');
  l.record('acct', [bucket('week', 0.2, 600)]);
  assert.equal(l.view('acct').state, 'unknown', 'an omitted measured bucket is no longer measured');
  l.record('acct', [bucket('week', 0.2, 600), bucket('week:fable', 0.1, 600, 'fable')]);
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', 0.3, 60)]);
  assert.equal(l.view('acct', 'opus').state, 'ok', 'an omitted bucket for another model does not matter');
  assert.equal(l.view('acct', 'fable').state, 'unknown');
});

test('A16 one reading without a bucket retires nothing; retire() and repeated omissions (U13) do', () => {
  const { l } = ledger();
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', null, 60)]);
  l.record('acct', [bucket('week', 0.2, 600)]);
  assert.equal(l.view('acct').state, 'unknown');
  l.retire('acct', { bucket: 'session', model: null });
  assert.equal(l.view('acct').state, 'ok', 'a retired bucket no longer applies');
});

// Added after review round 4 (Sol, U1 at ff8e27d).

test('A17 a retired bucket leaves no reading behind', () => {
  const { l } = ledger();
  l.record('acct', [bucket('week', 0.2, 600)]);
  l.retire('acct', { bucket: 'week', model: null });
  assert.equal(l.view('acct').state, 'unknown', 'with nothing measured left, nothing is known');
});

test('A18 a clock step back makes the ledger unknown, and readings it stamps are ignored', () => {
  const { l, set } = ledger(10);
  l.record('acct', [bucket('week', 0.2, 600)]);
  set(8);
  assert.equal(l.view('acct').state, 'ok');
  set(7);
  assert.equal(l.view('acct').state, 'unknown', 'the clock went back after the ledger saw 12:08');
  l.record('acct', [bucket('week', 0.1, 600)]);   // stamped by a clock that went back: ignored, like A12
  set(9);
  const v = l.view('acct');
  assert.equal(v.state, 'ok', 'once the clock is past its high-water mark again, evidence counts');
  if (v.state === 'ok') assert.ok(Math.abs(v.headroom - 0.8) < 1e-9, 'the ignored reading did not count');
});

// Added after review round 5 (Sol, U1 at 9550344).

test('A19 a limit hit raises the clock high-water mark too, across accounts', () => {
  const { l, set } = ledger(10);
  l.record('a', [bucket('week', 0.2, 600)]);
  set(8);
  l.recordLimit('b', { bucket: 'week', model: null, resetsAt: iso(600) });
  set(7);
  assert.equal(l.view('a').state, 'unknown', 'the ledger saw 12:08 through the hit on another account');
  l.record('a', [bucket('week', 0.1, 600)]);   // stamped while behind: ignored
  set(9);
  const v = l.view('a');
  assert.equal(v.state, 'ok');
  if (v.state === 'ok') assert.ok(Math.abs(v.headroom - 0.8) < 1e-9, 'the reading stamped while behind did not count');
});

// Added after review round 6 (Sol, U1 at 8a9da58).

test('A20 retirement is evidence too: while the clock is behind, it is ignored and the hold survives', () => {
  const { l, set } = ledger(600);
  set(8);
  l.record('acct', [bucket('week', 1, 600), bucket('session', 0.3, 60)]);
  set(7);
  l.retire('acct', { bucket: 'week', model: null });
  set(9);
  assert.equal(l.view('acct').state, 'exhausted', 'the full week bucket still holds');
});

test('A21 a null model and an empty model name are different buckets', () => {
  const { l, set } = ledger(600);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(600) });
  set(1);
  l.record('acct', [bucket('week', 0.1, 600, ''), bucket('day', 0.2, 600)]);
  assert.equal(l.view('acct', 'opus').state, 'exhausted', 'a reading for model "" does not clear the account-wide hold');
});

// Added after review round 7 (Sol, U1 at ece84e7).

test('A22 a malformed bucket is not evidence: it never clears a hold or establishes capacity', () => {
  const { l, set } = ledger(600);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(600) });
  set(1);
  const missingModel = { bucket: 'week', usedFraction: 0.1, resetsAt: iso(600) } as never;
  l.record('acct', [missingModel, bucket('day', 0.2, 600)]);
  assert.equal(l.view('acct', 'opus').state, 'exhausted', 'a reading with no model field is not the account-wide bucket');
  const fresh = ledger(600);
  fresh.l.record('acct', [{ bucket: '', model: null, usedFraction: 0.1, resetsAt: iso(600) }, { bucket: 7, model: null, usedFraction: 0.1, resetsAt: null } as never]);
  assert.equal(fresh.l.view('acct').state, 'unknown', 'malformed buckets establish nothing');
  assert.throws(() => fresh.l.recordLimit('acct', { bucket: '', model: null, resetsAt: null }), TypeError, 'a limit hit is never silently dropped');
});

// ── availability ────────────────────────────────────────────────────────────

const ACCT = account({ id: 'claude-a', loginDir: '/logins/a', fingerprint: 'pin-a', maxConcurrency: 2 });
const SIGNED_IN = { accountId: 'claude-a', signedIn: true, fingerprint: 'pin-a', observedAt: iso(0) };
/** Lookups that answer like ledgers, from literal evidence. */
function ev(identity: ReturnType<IdentityLedger['view']>, allowance: ReturnType<AllowanceLedger['view']> | null) {
  return {
    identities: { view: (_id: string) => identity },
    allowances: { view: (_id: string, _model?: string) => allowance as ReturnType<AllowanceLedger['view']> },
  };
}
/** The verdict's clock and how long a login observation stays fresh. */
const T = { now: at(1), identityMaxAgeMs: 10 * 60_000 };
const OK = { state: 'ok' as const, accountId: 'claude-a', headroom: 0.4, binding: 'week' };

test('V1 one verdict per account, from identity, allowance, running jobs and health', () => {
  assert.deepEqual(availability({ ...T, account: ACCT, ...ev(SIGNED_IN, OK), running: 0 }), { state: 'available', headroom: 0.4 });
  assert.deepEqual(availability({ ...T, account: ACCT, ...ev(SIGNED_IN, OK), running: 2 }), { state: 'busy', running: 2, max: 2 });
  const exhausted = availability({ ...T, account: ACCT, ...ev(SIGNED_IN, { state: 'exhausted', accountId: 'claude-a', bucket: 'week', until: iso(60) }), running: 0 });
  assert.equal(exhausted.state, 'unavailable');
  if (exhausted.state === 'unavailable') { assert.match(exhausted.reason, /week/); assert.equal(exhausted.until, iso(60)); }
  const outOfSync = availability({ ...T, account: ACCT, ...ev({ accountId: 'claude-a', signedIn: true, fingerprint: 'someone-else', observedAt: iso(0) }, OK), running: 0 });
  assert.equal(outOfSync.state, 'unavailable', 'a login that does not match its pin is never used');
  const signedOut = availability({ ...T, account: ACCT, ...ev({ accountId: 'claude-a', signedIn: false, fingerprint: null, observedAt: iso(0) }, OK), running: 0 });
  assert.equal(signedOut.state, 'unavailable');
  const unhealthy = availability({ ...T, account: ACCT, ...ev(SIGNED_IN, OK), running: 0, health: { ok: false, reason: 'three failures', until: iso(5) } });
  assert.deepEqual(unhealthy, { state: 'unavailable', reason: 'three failures', until: iso(5) });
  const disabled = availability({ ...T, account: { ...ACCT, enabled: false }, ...ev(SIGNED_IN, OK), running: 0 });
  assert.equal(disabled.state, 'unavailable');
});

test('V2 unknown is never available: missing identity or allowance evidence is reported as unknown', () => {
  const allowances = [OK, { state: 'unknown' as const, accountId: 'claude-a', reason: 'no reading' }, { state: 'exhausted' as const, accountId: 'claude-a', bucket: 'week', until: null }];
  const identities = [undefined, SIGNED_IN, { accountId: 'claude-a', signedIn: true, fingerprint: 'x', observedAt: iso(0) }, { accountId: 'claude-a', signedIn: false, fingerprint: null, observedAt: iso(0) }];
  for (const allowance of allowances) for (const identity of identities) for (const running of [0, 2]) for (const enabled of [true, false]) {
    const v = availability({ ...T, account: { ...ACCT, enabled }, ...ev(identity, allowance), running });
    const evidenced = enabled && identity === SIGNED_IN && allowance === OK && running === 0;
    assert.equal(v.state === 'available', evidenced, JSON.stringify({ allowance, identity, running, enabled, v }));
    if (enabled && identity === undefined) assert.equal(v.state, 'unknown', 'an unobserved login is unknown');
    if (enabled && identity === SIGNED_IN && allowance.state === 'unknown') assert.equal(v.state, 'unknown');
  }
});

test('V3 a stopped account reports why before it reports busy', () => {
  const both = availability({ ...T, account: ACCT, ...ev(SIGNED_IN, { state: 'exhausted', accountId: 'claude-a', bucket: 'week', until: null }), running: 2 });
  assert.equal(both.state, 'unavailable', 'exhausted beats busy');
  const off = availability({ ...T, account: { ...ACCT, enabled: false }, ...ev(undefined, { state: 'unknown', accountId: 'claude-a', reason: 'x' }), running: 2 });
  assert.equal(off.state, 'unavailable', 'disabled beats everything');
});

// Added after review round 1 (Sol and Gemini, U1 at 0ae8fe6).

test('V4 allowance evidence must belong to the account it is judged for', () => {
  const { l } = ledger();
  l.record('someone-else', [bucket('week', 0.1, 600)]);
  const v = availability({ ...T, account: ACCT, ...ev(SIGNED_IN, l.view('someone-else')), running: 0 });
  assert.equal(v.state, 'unknown');
  if (v.state === 'unknown') assert.match(v.reason, /another account/);
  l.record('claude-a', [bucket('week', 0.1, 600)]);
  assert.equal(availability({ ...T, account: ACCT, ...ev(SIGNED_IN, l.view('claude-a')), running: 0 }).state, 'available');
});

// Added after review round 2 (Sol, U1 at cb77c36).

test('V5 login evidence must belong to the account it is judged for', () => {
  const borrowed = { accountId: 'codex-a', signedIn: true, fingerprint: 'pin-a', observedAt: iso(0) };   // same email, another account
  const v = availability({ ...T, account: ACCT, ...ev(borrowed, OK), running: 0 });
  assert.equal(v.state, 'unknown');
  if (v.state === 'unknown') assert.match(v.reason, /another account/);
});

// Added after review round 3 (Sol, U1 at e02f3ab).

test('V6 malformed allowance evidence is unknown, never available', () => {
  const bad = [
    { state: 'bogus', accountId: 'claude-a' },
    { state: 'ok', accountId: 'claude-a', headroom: Number.NaN, binding: 'week' },
    { state: 'ok', accountId: 'claude-a', headroom: 1.5, binding: 'week' },
    { state: 'ok', accountId: 'claude-a', headroom: -0.1, binding: 'week' },
    null,
  ];
  for (const allowance of bad) {
    const v = availability({ ...T, account: ACCT, ...ev(SIGNED_IN, allowance as never), running: 0 });
    assert.equal(v.state, 'unknown', JSON.stringify(allowance));
  }
});

test('V7 login evidence is judged on the pipe clock: stale, future or unstamped is unknown', () => {
  const stale = { ...SIGNED_IN, observedAt: iso(-60) };
  const future = { ...SIGNED_IN, observedAt: iso(30) };
  const unstamped = { ...SIGNED_IN, observedAt: 'yesterday' };
  for (const identity of [stale, future, unstamped]) {
    const v = availability({ ...T, account: ACCT, ...ev(identity, OK), running: 0 });
    assert.equal(v.state, 'unknown', identity.observedAt);
  }
  assert.equal(availability({ ...T, account: ACCT, ...ev(SIGNED_IN, OK), running: 0 }).state, 'available');
  const badClock = availability({ ...T, now: new Date(Number.NaN), account: ACCT, ...ev(SIGNED_IN, OK), running: 0 });
  assert.equal(badClock.state, 'unknown');
});

// Added after review round 4 (Sol and Gemini, U1 at ff8e27d).

test('V8 the identity ledger keeps the latest login observation; an older one never supersedes it', () => {
  const clock = { now: at(2) };
  const ids = new IdentityLedger({ now: () => clock.now });
  ids.record('claude-a', { signedIn: false, fingerprint: null, observedAt: iso(1) });
  ids.record('claude-a', { signedIn: true, fingerprint: 'pin-a', observedAt: iso(0) });   // arrives late, observed earlier
  const latest = ids.view('claude-a');
  assert.deepEqual(latest, { accountId: 'claude-a', signedIn: false, fingerprint: null, observedAt: iso(1) });
  assert.equal(availability({ ...T, now: at(2), account: ACCT, ...ev(latest, OK), running: 0 }).state, 'unavailable');
  ids.record('claude-a', { signedIn: true, fingerprint: 'pin-a' });   // no observedAt: stamped by the ledger clock
  assert.equal(ids.view('claude-a')?.observedAt, iso(2));
  assert.throws(() => ids.record('claude-a', { signedIn: true, fingerprint: 'pin-a', observedAt: iso(5) }), RangeError, 'an observation from the future is refused');
  assert.equal(ids.view('claude-b'), undefined);
});

test('V9 the login freshness window must be a real duration', () => {
  for (const identityMaxAgeMs of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    const v = availability({ ...T, identityMaxAgeMs, account: ACCT, ...ev(SIGNED_IN, OK), running: 0 });
    assert.equal(v.state, 'unknown', String(identityMaxAgeMs));
  }
});

// ── small by design ─────────────────────────────────────────────────────────

test('S1 the core stays small and dependency-free', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'the U1 core has no runtime dependencies');
  assert.match(pkg.scripts?.test ?? '', /node --test/);
  assert.match(pkg.scripts?.typecheck ?? '', /tsc --noEmit/);
  const src = new URL('../src/', import.meta.url);
  const U1 = ['policy.ts', 'identity.ts', 'allowance.ts', 'availability.ts'];   // U1's own files; later lanes have their own budgets
  const lines = readdirSync(src).filter((f) => U1.includes(f))
    .map((f) => readFileSync(new URL(f, src), 'utf8').split('\n').filter((l) => l.trim() !== '').length)
    .reduce((a, b) => a + b, 0);
  assert.ok(lines > 0 && lines <= 700, `src/ holds ${lines} non-blank lines; U1's budget is 700`);
  const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  assert.equal(tsconfig.compilerOptions?.strict, true);
});

// Added after review round 5 (Sol, U1 at 9550344).

test('V10 the verdict reads the current evidence itself: a saved view cannot outlive a newer sign-out', () => {
  const clock = { now: at(1) };
  const identities = new IdentityLedger({ now: () => clock.now });
  identities.record('claude-a', { signedIn: true, fingerprint: 'pin-a' });
  const saved = identities.view('claude-a');
  assert.equal(saved?.signedIn, true);
  clock.now = at(2);
  identities.record('claude-a', { signedIn: false, fingerprint: null });
  const allowances = { view: (id: string) => ({ ...OK, accountId: id }) };
  const v = availability({ ...T, now: at(3), account: ACCT, identities, allowances, running: 0 });
  assert.equal(v.state, 'unavailable', 'the verdict saw the sign-out, whatever a caller saved');
});

test('V11 the identity ledger has a high-water mark: observations stamped while its clock is behind are ignored', () => {
  const clock = { now: at(8) };
  const identities = new IdentityLedger({ now: () => clock.now });
  identities.record('claude-a', { signedIn: false, fingerprint: null });
  clock.now = at(7);
  identities.record('claude-b', { signedIn: true, fingerprint: 'fp-claude-b' });
  assert.equal(identities.view('claude-b'), undefined, 'stamped by a clock that stepped back');
  clock.now = at(9);
  identities.record('claude-b', { signedIn: true, fingerprint: 'fp-claude-b' });
  assert.equal(identities.view('claude-b')?.signedIn, true, 'past the mark again, observations count');
});

// Added after review round 6 (Sol, U1 at 8a9da58).

test('V12 while the identity clock is behind its high-water mark, the ledger shows no login', () => {
  const clock = { now: at(0) };
  const identities = new IdentityLedger({ now: () => clock.now });
  identities.record('claude-a', { signedIn: true, fingerprint: 'pin-a' });
  clock.now = at(8);
  identities.record('claude-other', { signedIn: false, fingerprint: null });
  clock.now = at(7);
  assert.equal(identities.view('claude-a'), undefined, 'the clock stepped back: no evidence is current');
  const allowances = { view: (id: string) => ({ ...OK, accountId: id }) };
  assert.equal(availability({ ...T, now: at(7), account: ACCT, identities, allowances, running: 0 }).state, 'unknown');
});

// Added after review round 7 (Sol, U1 at ece84e7).

test('V13 an invalid running count is unknown, never free capacity', () => {
  const identities = { view: (id: string) => ({ ...SIGNED_IN, accountId: id }) };
  const allowances = { view: (id: string) => ({ ...OK, accountId: id }) };
  for (const running of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
    const v = availability({ ...T, account: ACCT, identities, allowances, running });
    assert.equal(v.state, 'unknown', String(running));
  }
});

// Added after review round 8 (Sol, U1 at 10ececb).

test('A23 a reading or retirement that is not an object is dropped, never a crash', () => {
  const { l, set } = ledger(600);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: iso(600) });
  set(1);
  for (const junk of [null, undefined, 7, 'week', []] as never[]) {
    assert.doesNotThrow(() => l.record('acct', [junk, bucket('day', 0.2, 600)]), `reading ${JSON.stringify(junk)}`);
    assert.doesNotThrow(() => l.retire('acct', junk), `retirement ${JSON.stringify(junk)}`);
  }
  assert.equal(l.view('acct', 'opus').state, 'exhausted', 'the hold survives junk readings and retirements');
  assert.throws(() => l.recordLimit('acct', null as never), /a limit hit needs/, 'a malformed limit hit is a caller bug, named as such');
  assert.throws(() => l.record('acct', null as never), /a reading is a list/, 'a reading that is not a list is a caller bug, named as such');
});

test('A24 a reset time must be an ISO date-time with an offset: anything else is not evidence', () => {
  const junk = [3000, 0, true, {}, '3000', '2026-09-24', '2026-09-24T12:00:00', 'soon'] as never[];
  const { l, set } = ledger(600);
  l.recordLimit('acct', { bucket: 'week', model: null, resetsAt: null });
  for (const [i, resetsAt] of junk.entries()) {
    set(i + 1);
    l.record('acct', [{ bucket: 'week', model: null, usedFraction: 0.2, resetsAt }]);
    assert.equal(l.view('acct').state, 'exhausted', `resetsAt ${JSON.stringify(resetsAt)} does not clear the hold`);
  }
  for (const resetsAt of junk) {
    const fresh = ledger(600);
    fresh.l.record('acct', [{ bucket: 'week', model: null, usedFraction: 0.2, resetsAt }]);
    assert.equal(fresh.l.view('acct').state, 'unknown', `resetsAt ${JSON.stringify(resetsAt)} establishes no capacity`);
    assert.throws(() => fresh.l.recordLimit('acct', { bucket: 'week', model: null, resetsAt }), /resets at an ISO date-time/, `a limit hit with resetsAt ${JSON.stringify(resetsAt)} is refused by name`);
  }
  const offset = ledger(600);
  offset.l.record('acct', [{ bucket: 'week', model: null, usedFraction: 0.2, resetsAt: '2026-09-24T22:00:00+02:00' }]);
  assert.equal(offset.l.view('acct').state, 'ok', 'an explicit offset is a real time');
});

test('V14 login evidence whose time is not an ISO date-time with an offset is unknown', () => {
  for (const observedAt of [0, 3000, '3000', '2026-09-24T12:00:00', null] as never[]) {
    const identity = { ...SIGNED_IN, observedAt };
    assert.equal(availability({ ...T, account: ACCT, ...ev(identity, OK), running: 0 }).state, 'unknown', JSON.stringify(observedAt));
  }
});

test('V15 the identity ledger refuses an observation time that is not an ISO date-time with an offset', () => {
  const identities = new IdentityLedger({ now: () => at(1) });
  for (const observedAt of [0, 3000, '3000', '2026-09-24T12:00:00'] as never[]) {
    assert.throws(() => identities.record('claude-a', { signedIn: true, fingerprint: 'pin-a', observedAt }), RangeError, JSON.stringify(observedAt));
  }
  assert.equal(identities.view('claude-a'), undefined, 'nothing was recorded');
  identities.record('claude-a', { signedIn: true, fingerprint: 'pin-a', observedAt: iso(1) });
  assert.equal(identities.view('claude-a')?.signedIn, true);
});

// Added after the Anthropic seat's review of fa534fa (two minors, two nits), and for U3's limits
// that name no bucket.

test('A25 an instant must be a real calendar time: an impossible date, hour or offset is not evidence', () => {
  for (const bad of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-09-31T00:00:00Z',
    '2026-09-24T24:00:00Z', '2026-09-24T12:60:00Z', '2026-09-24T12:00:60Z', '2026-09-24T12:00:00+24:00', '2026-09-24T12:00:00+05:60']) {
    assert.equal(instantOf(bad), null, bad);
  }
  for (const good of ['2024-02-29T00:00:00Z', '2026-09-24T23:59:59.999Z', '2026-09-24T12:00:00+05:30', '2026-09-24T12:00Z', '2026-12-31T23:59:59-12:00']) {
    assert.notEqual(instantOf(good), null, good);
  }
  assert.equal(instantOf('2026-09-24T12:00:00+05:30'), Date.parse('2026-09-24T06:30:00Z'), 'the offset is honoured');
});

test('A26 a limit that names no bucket holds the whole account until a newer reading has room in every bucket', () => {
  const { l, set } = ledger(600);
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', 0.1, 60)]);
  set(1);
  l.recordLimit('acct', { bucket: null, model: null, resetsAt: null });
  for (const model of [undefined, 'opus', 'sonnet']) {
    assert.deepEqual(l.view('acct', model), { state: 'exhausted', accountId: 'acct', bucket: null, until: null }, `model ${model}`);
  }
  set(2);
  l.record('acct', [bucket('week', 0.3, 600), bucket('session', null, 60)]);
  assert.equal(l.view('acct').state, 'exhausted', 'an unmeasured bucket does not clear an unnamed hold');
  set(3);
  l.record('acct', [bucket('week', 1, 600), bucket('session', 0.1, 60)]);
  assert.equal(l.view('acct').state, 'exhausted', 'a full bucket does not clear it');
  set(4);
  l.record('acct', [bucket('week', 0.4, 600), bucket('session', 0.2, 60)]);
  assert.equal(l.view('acct').state, 'ok', 'a newer reading with room in every bucket clears it');
  const forged = ledger(600);
  forged.l.recordLimit('acct', { bucket: null, model: null, resetsAt: null });
  forged.set(1);
  forged.l.record('acct', [bucket('week', 0.2, 600), bucket('session', null, 60), { bucket: null, model: null, usedFraction: 0.1, resetsAt: null } as never]);
  assert.deepEqual(forged.l.view('acct'), { state: 'exhausted', accountId: 'acct', bucket: null, until: null }, 'a reading entry with no bucket name is dropped, wherever it sits: it cannot clear an unnamed hold');
  const empty = ledger(600);
  empty.l.recordLimit('acct', { bucket: null, model: null, resetsAt: null });
  empty.set(1);
  empty.l.record('acct', []);
  assert.equal(empty.l.view('acct').state, 'exhausted', 'an empty reading proves nothing');
  const same = ledger(600);
  same.l.recordLimit('acct', { bucket: null, model: null, resetsAt: null });
  same.l.record('acct', [bucket('week', 0.1, 600)]);
  assert.equal(same.l.view('acct').state, 'exhausted', 'a reading at the same instant is not provably newer');
  assert.throws(() => same.l.recordLimit('acct', { bucket: '', model: null, resetsAt: null }), TypeError, 'an empty name is still malformed');
});

test('V16 an identity observation must be well formed: a named error before the clock, and a non-boolean sign-in is unknown', () => {
  const clock = { now: at(5) };
  const identities = new IdentityLedger({ now: () => clock.now });
  for (const bad of [null, 7, { signedIn: 'false', fingerprint: 'pin-a' }, { signedIn: true, fingerprint: 7 }, { signedIn: 1, fingerprint: null }] as never[]) {
    assert.throws(() => identities.record('claude-a', bad), (e: Error) => e instanceof TypeError && /observation/.test(e.message), JSON.stringify(bad));
  }
  clock.now = at(3);
  identities.record('claude-a', { signedIn: true, fingerprint: 'pin-a' });
  assert.equal(identities.view('claude-a')?.signedIn, true, 'malformed observations never raised the high-water mark');
  const truthy = { ...SIGNED_IN, signedIn: 'false' as never };
  assert.equal(availability({ ...T, account: ACCT, ...ev(truthy, OK), running: 0 }).state, 'unknown', 'a sign-in that is not a boolean is unknown');
});

// Added after both families reviewed 0d9dda7 (the same minor from each, and three nits).

test('A27 an unnamed hold clears only on a reading that reports every known bucket in its scope, each with room', () => {
  const { l, set } = ledger(600);
  l.record('acct', [bucket('week', 0.2, 600), bucket('session', 0.1, 60)]);
  set(1);
  l.recordLimit('acct', { bucket: null, model: null, resetsAt: null });
  set(2);
  l.record('acct', [bucket('week', 0.2, 600)]);
  assert.equal(l.view('acct').state, 'exhausted', 'a reading that omits a known bucket does not clear it');
  const scoped = ledger(600);
  scoped.l.record('acct', [bucket('week', 0.2, 600), bucket('week_opus', 0.2, 600, 'opus'), bucket('week_sonnet', 0.2, 600, 'sonnet')]);
  scoped.set(1);
  scoped.l.recordLimit('acct', { bucket: null, model: 'opus', resetsAt: null });
  scoped.l.recordLimit('acct', { bucket: null, model: null, resetsAt: null });
  scoped.set(2);
  scoped.l.record('acct', [bucket('week', 0.3, 600), bucket('week_opus', 0.3, 600, 'opus'), bucket('week_sonnet', 1, 600, 'sonnet')]);
  assert.equal(scoped.l.view('acct', 'sonnet').state, 'exhausted', 'the full sonnet bucket holds sonnet');
  assert.equal(scoped.l.view('acct').state, 'exhausted', 'the account-wide unnamed hold stays: a bucket in its scope is full');
  scoped.set(3);
  scoped.l.record('acct', [bucket('week', 0.3, 600), bucket('week_opus', 0.3, 600, 'opus'), bucket('week_sonnet', 0.5, 600, 'sonnet')]);
  assert.equal(scoped.l.view('acct', 'opus').state, 'ok', 'with room everywhere, both unnamed holds clear');
  const opusOnly = ledger(600);
  opusOnly.l.record('acct', [bucket('week', 0.2, 600), bucket('week_opus', 0.2, 600, 'opus'), bucket('week_sonnet', 0.2, 600, 'sonnet')]);
  opusOnly.set(1);
  opusOnly.l.recordLimit('acct', { bucket: null, model: 'opus', resetsAt: null });
  opusOnly.set(2);
  opusOnly.l.record('acct', [bucket('week', 0.3, 600), bucket('week_opus', 0.3, 600, 'opus'), bucket('week_sonnet', 1, 600, 'sonnet')]);
  assert.equal(opusOnly.l.view('acct', 'opus').state, 'ok', 'an opus-scoped hold ignores the sonnet bucket');
});

test('A28 a leap day in a year below 100 is a real date', () => {
  assert.notEqual(instantOf('0000-02-29T00:00:00Z'), null, 'year 0 is a leap year (proleptic Gregorian)');
  assert.notEqual(instantOf('0004-02-29T00:00:00Z'), null);
  assert.equal(instantOf('0001-02-29T00:00:00Z'), null);
});

test('V17 a malformed observation time is refused before the identity clock is touched', () => {
  const clock = { now: at(5) };
  const identities = new IdentityLedger({ now: () => clock.now });
  assert.throws(() => identities.record('claude-a', { signedIn: true, fingerprint: 'pin-a', observedAt: '3000' }), RangeError);
  clock.now = at(3);
  identities.record('claude-a', { signedIn: true, fingerprint: 'pin-a' });
  assert.equal(identities.view('claude-a')?.signedIn, true, 'the refused observation never raised the high-water mark');
});

// Added after the Anthropic seat's review of 8009357 (nits).

test('A29 an account-wide bucket is in every unnamed hold\'s scope, a model-scoped one included', () => {
  const { l, set } = ledger(600);
  l.record('acct', [bucket('week', 0.2, 600), bucket('week_opus', 0.2, 600, 'opus')]);
  set(1);
  l.recordLimit('acct', { bucket: null, model: 'opus', resetsAt: null });
  set(2);
  l.record('acct', [bucket('week', null, 600), bucket('week_opus', 0.3, 600, 'opus')]);
  assert.deepEqual(l.view('acct', 'opus'), { state: 'exhausted', accountId: 'acct', bucket: null, until: null }, 'the unmeasured account-wide bucket keeps the opus hold');
});

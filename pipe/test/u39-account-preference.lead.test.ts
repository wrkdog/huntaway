/**
 * U39 account preference (lead tests, written before the build; builders must not edit this file).
 *
 * An operator can say which account of a provider to use first. `preference` is an optional whole number
 * from 0 to 100 on an account in config; an account without one has preference 0. Among the accounts that
 * can take a request, a higher preference is used first, whatever its load or headroom, on default
 * spreading, on `ordinary_headroom` placement and on automatic routes (primary and fallback). Within one
 * preference the existing order holds unchanged. Credit room still comes after every account with ordinary
 * room, whatever the preference (rule 49). A pin ignores preference. A preferred account that is busy,
 * exhausted, stopped, disabled or excluded yields to the next preference.
 *
 * Why: a first Claude account carries most Claude seats (maxConcurrency 4) and a second should serve only
 * when the first is busy, limited or out of room (the owner's ruling, 2026-10-14).
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type NewRequest } from '../src/store.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import { validateAccounts, AccountConfigError, type AccountConfig } from '../src/identity.ts';

const NOW = new Date('2026-10-03T12:00:00Z'), RESET = '2026-10-03T13:00:00Z';
const policy = { codex: { models: { 'gpt-6.1-sol': 'default' as const }, efforts: ['high'] }, claude: { models: { opus: 'default' as const }, efforts: ['high'] } };
const automatic = { fallback: { provider: 'claude', model: 'opus', effort: 'high', reason: 'fixture fallback' }, reviewReserve: 0.1 };
const request = (extra = {}): NewRequest => ({ requester: 'fixture', project: 'fixture', kind: 'code', provider: 'codex',
  model: 'gpt-6.1-sol', effort: 'high', reason: 'fixture test', prompt: 'fixture', priority: 'interactive', mutating: false, ...extra } as NewRequest);
const auto = (extra = {}) => request({ placement: 'ordinary_headroom', automatic, ...extra });

type Opt = { preference?: number; room?: number; running?: number; max?: number; credits?: boolean; exhausted?: boolean; unknown?: boolean; enabled?: boolean };
/** Ids starting with "f" are Claude accounts (the automatic fallback); all others are Codex. */
const status = (id: string, o: Opt = {}): AccountStatus => ({
  account: { id, provider: id.startsWith('f') ? 'claude' : 'codex', loginDir: `/fixture/${id}`, fingerprint: `fp-${id}`,
    enabled: o.enabled ?? true, maxConcurrency: o.max ?? 2, ...(o.preference === undefined ? {} : { preference: o.preference }) } as AccountConfig,
  running: o.running ?? 0,
  evidence: (model: string) => ({ accountId: id, model, observedAt: NOW.toISOString(), allowanceObservedAt: NOW.toISOString(),
    ordinaryExhaustion: o.exhausted ? { observedAt: NOW.toISOString(), until: RESET } : null,
    verdict: o.exhausted ? { state: 'unavailable', reason: 'allowance exhausted', cause: 'allowance', until: RESET }
      : o.unknown ? { state: 'unknown', reason: 'fixture unknown' }
      : { state: 'available', headroom: o.room ?? 0.5, ...(o.credits ? { via: 'credits' } : {}) } }) as never,
});
const options = { now: NOW, pinWaitMs: 60_000, evidenceMaxAgeMs: 60_000, load: new Map() };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u39-'));
  const store = new Store(join(root, 'record.sqlite'), { now: () => NOW, retryBackoffMs: 0 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const pick = (accounts: AccountStatus[], extra = {}) => plan([store.submit(request(extra))], accounts, options).dispatch[0]?.accountId;
  return { store, root, pick };
}

test('R1 without preferences the existing order is unchanged; an explicit 0 is the same as none', (t) => {
  const { pick } = fixture(t);
  assert.equal(pick([status('a', { running: 1 }), status('b')]), 'b', 'default spreading uses load');
  assert.equal(pick([status('a', { preference: 0, running: 1 }), status('b', { preference: 0 })]), 'b');
  assert.equal(pick([status('a', { room: 0.9, running: 1 }), status('b', { room: 0.2 })], { placement: 'ordinary_headroom' }), 'a', 'opt-in placement uses headroom');
  assert.equal(pick([status('b'), status('a')]), 'a', 'equal load and headroom fall back to the id');
});

test('R2 a higher preference wins over load and headroom, in any config order and either placement', (t) => {
  const { pick } = fixture(t);
  const preferred = () => status('a', { preference: 10, running: 3, max: 4, room: 0.2 });
  for (const placement of [{}, { placement: 'ordinary_headroom' }]) {
    assert.equal(pick([preferred(), status('b', { room: 0.9 })], placement), 'a', JSON.stringify(placement));
    assert.equal(pick([status('b', { room: 0.9 }), preferred()], placement), 'a', `reversed ${JSON.stringify(placement)}`);
    assert.equal(pick([status('z', { preference: 1, running: 1, room: 0.1 }), status('a', { room: 0.99 })], placement), 'z', 'any positive preference beats none');
  }
});

test('R3 within one preference the existing order holds', (t) => {
  const { pick } = fixture(t);
  assert.equal(pick([status('a', { preference: 5, running: 1 }), status('b', { preference: 5 }), status('c')]), 'b', 'load within the tier');
  assert.equal(pick([status('a', { preference: 5, room: 0.3 }), status('b', { preference: 5, room: 0.8 }), status('c', { room: 0.99 })], { placement: 'ordinary_headroom' }), 'b', 'headroom within the tier');
  assert.equal(pick([status('d', { preference: 5 }), status('c', { preference: 5 })]), 'c', 'id within the tier');
});

test('R4 a preferred account that cannot take the request yields to the next preference, never past it', (t) => {
  const { pick } = fixture(t);
  // The next tier's account is busier than the unpreferred one, so only preference can choose it.
  const next = () => [status('y', { preference: 5, running: 1 }), status('c')];
  for (const [what, a] of [
    ['busy', status('a', { preference: 10, running: 2, max: 2 })],
    ['exhausted', status('a', { preference: 10, exhausted: true })],
    ['unknown', status('a', { preference: 10, unknown: true })],
    ['disabled', status('a', { preference: 10, enabled: false })],
  ] as const) assert.equal(pick([a, ...next()]), 'y', what);
  assert.equal(pick([status('a', { preference: 10 }), ...next()], { exclude: ['a'] }), 'y', 'excluded');
});

test('R5 credit room comes after every account with ordinary room, whatever its preference (rule 49)', (t) => {
  const { pick } = fixture(t);
  assert.equal(pick([status('a', { preference: 10, credits: true, room: 0.05 }), status('b', { room: 0.3 })]), 'b');
  assert.equal(pick([status('a', { preference: 10, credits: true, room: 0.05 })]), 'a', 'credit room alone still serves default placement');
  assert.equal(pick([status('a', { credits: true, room: 0.05 }), status('b', { preference: 10, credits: true, room: 0.05 })]), 'b', 'preference orders credit room too');
  assert.equal(pick([status('a', { preference: 10, credits: true, room: 0.05 }), status('b', { room: 0.3 })], { placement: 'ordinary_headroom' }), 'b');
});

test('R6 one plan fills the preferred account to its limit, then spills to the next', (t) => {
  const { store } = fixture(t);
  const waiting = [1, 2, 3, 4].map(() => store.submit(request()));
  const got = plan(waiting, [status('b', { max: 2 }), status('a', { preference: 10, max: 2 }), status('c', { preference: 5, max: 1 })], options).dispatch.map((d) => d.accountId);
  assert.deepEqual(got, ['a', 'a', 'c', 'b']);
});

test('R7 a pin ignores preference', (t) => {
  const { pick } = fixture(t);
  assert.equal(pick([status('a', { preference: 10 }), status('b')], { pin: 'b' }), 'b');
});

test('R8 automatic routes use preference before headroom, on the primary and on the fallback', (t) => {
  const { store } = fixture(t);
  const route = (accounts: AccountStatus[]) => plan([store.submit(auto())], accounts, options).dispatch[0];
  assert.equal(route([status('c1', { room: 0.9 }), status('c2', { preference: 10, room: 0.3 }), status('f1', { room: 0.99 })])?.accountId, 'c2');
  assert.equal(route([status('c1', { room: 0.9 }), status('c2', { preference: 10, room: 0.3, running: 1, max: 1 }), status('f1', { room: 0.99 })])?.accountId, 'c1', 'a busy preferred primary yields');
  const fallback = route([status('c1', { exhausted: true }), status('f1', { room: 0.9 }), status('f2', { preference: 10, room: 0.3 })]);
  assert.equal(fallback?.accountId, 'f2');
  assert.equal(fallback?.route?.provider, 'claude');
  // The store's own automatic claim plans with the same order.
  const started = (store as any).startAutomatic(store.submit(auto()).id, [status('c1', { room: 0.9 }), status('c2', { preference: 10, room: 0.3 }), status('f1', { room: 0.99 })], policy, []);
  assert.ok(started.ok, started.reason);
  assert.equal(started.attempt.accountId, 'c2');
});

test('R9 config accepts a whole-number preference from 0 to 100 and refuses anything else, naming the account', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u39-cfg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = (preference: unknown): AccountConfig => {
    const loginDir = join(root, `login-${Math.random().toString(36).slice(2)}`);
    mkdirSync(loginDir);
    return { id: 'acct-one', provider: 'codex', loginDir, fingerprint: 'abcd1234', maxConcurrency: 1, enabled: true,
      ...(preference === undefined ? {} : { preference }) } as AccountConfig;
  };
  for (const ok of [undefined, 0, 1, 37, 100]) assert.doesNotThrow(() => validateAccounts([config(ok)]), String(ok));
  for (const bad of [-1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, true, [], {}]) {
    assert.throws(() => validateAccounts([config(bad)]), (e: unknown) => e instanceof AccountConfigError && /acct-one/.test(e.message) && /preference/.test(e.message), JSON.stringify(bad));
  }
});

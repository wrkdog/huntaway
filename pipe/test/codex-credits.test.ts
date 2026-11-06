/**
 * Codex credits as headroom when opted in (L66, rule 49).
 * Tests a to n: a to g from the brief, h to n from review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAccount, applyProbe, codexCreditsConfig, type ProbeOptions } from '../src/probe.ts';
import { AllowanceLedger } from '../src/allowance.ts';
import { IdentityLedger } from '../src/availability.ts';
import type { AccountConfig } from '../src/identity.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import type { Evidence, RequestRecord } from '../src/store.ts';
import { startPipe } from '../src/service.ts';

const FIX = new URL('./fixtures/u4/', import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const NOW = new Date('2026-09-24T23:20:00.000Z');

type Scenario = Record<string, unknown>;
function fake(kind: 'claude' | 'codex', scenario: Scenario): { path: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pipe-credits-${kind}-`)));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const path = join(dir, kind);
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const answer = (key, dflt) => {
  const a = sc[key] ?? dflt;
  if (a === undefined) { process.stderr.write('no scenario for ' + key); process.exit(2); }
  if (a.stdout !== undefined) out(a.stdout);
  if (a.stderr !== undefined) process.stderr.write(a.stderr);
  process.exitCode = a.exit ?? 0;
};
if (argv[0] === '--version') answer('version');
else if (argv[0] === 'auth' && argv[1] === 'status') answer('auth');
else if (argv[0] === 'login' && argv[1] === 'status') answer('login');
else if (argv[0] === 'app-server') {
  const app = sc.app || {};
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue;
      const r = app[m.method];
      if (!r) { out({ id: m.id, error: { code: -32601, message: 'unknown method ' + m.method } }); out('\\n'); continue; }
      out(Object.assign({ id: m.id }, r)); out('\\n');
    }
  });
} else { process.stderr.write('unexpected ' + argv.join(' ')); process.exit(2); }
`);
  chmodSync(path, 0o755);
  return { path };
}

function appOf(name: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const e of fixture(name) as Array<{ method: string; response: Record<string, unknown> }>) {
    const { id: _id, ...rest } = e.response;
    map[e.method] = rest;
  }
  return { ...map, ...patch };
}

const codexAccount: AccountConfig = {
  id: 'codex-a', provider: 'codex', loginDir: '/logins/codex-a',
  fingerprint: sha8('<chatgptAccountId>'), maxConcurrency: 1, enabled: true,
};

const signedInCodex = (app: Record<string, unknown>) => ({
  version: { stdout: fixture('codex-version').stdout },
  login: { stderr: fixture('codex-login-status.signed-in').stderr, exit: 0 },
  app,
});

const opts = (over: Partial<ProbeOptions> = {}): ProbeOptions => ({
  cli: {}, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
  reachable: async () => true, timeoutMs: 5_000, now: () => NOW,
  minVersion: { claude: '2.1.280', codex: '0.156.1' }, ...over,
});

const ledgers = () => ({
  identities: new IdentityLedger({ now: () => NOW }),
  allowances: new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => NOW }),
});

function rateLimitsApp(codexPatch: Record<string, unknown>) {
  const good = appOf('codex-app-server.signed-in')['account/rateLimits/read'] as { result: Record<string, unknown> };
  const baseCodex = (good.result.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex!;
  const codex = { ...baseCodex, ...codexPatch };
  return appOf('codex-app-server.signed-in', {
    'account/rateLimits/read': {
      result: {
        ...good.result,
        rateLimits: codex,
        rateLimitsByLimitId: { codex },
      },
    },
  });
}

const fullUsable = {
  primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790622227 },
  credits: { hasCredits: true, unlimited: false, balance: '62420.6122000000' },
  spendControlReached: false,
};

test('a. covered: primary window full with usable credits is ok with via credits and headroom 0.05', async () => {
  const cli = fake('codex', signedInCodex(rateLimitsApp(fullUsable)));
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path }, codexCredits: { floor: 5000 } }));
  assert.equal(r.allowance.state, 'ok');
  assert.ok(r.allowance.state === 'ok');
  assert.deepEqual(r.allowance.buckets, [
    { bucket: 'codex:primary', model: null, usedFraction: 0.95, resetsAt: new Date(1790622227 * 1000).toISOString(), via: 'credits' },
  ]);
  const l = ledgers();
  applyProbe(r, l);
  const view = l.allowances.view('codex-a');
  assert.equal(view.state, 'ok');
  if (view.state === 'ok') {
    assert.equal(view.via, 'credits');
    assert.equal(view.binding, 'codex:primary');
    assert.ok(Math.abs(view.headroom - 0.05) < 1e-9, `headroom: ${view.headroom}`);
  }

  // Also covered when unlimited: true, even with balance 0 (<= floor)
  const unlCli = fake('codex', signedInCodex(rateLimitsApp({
    ...fullUsable,
    credits: { hasCredits: true, unlimited: true, balance: '0' },
  })));
  const unlR = await probeAccount(codexAccount, opts({ cli: { codex: unlCli.path }, codexCredits: { floor: 5000 } }));
  assert.equal(unlR.allowance.state, 'ok');
  assert.ok(unlR.allowance.state === 'ok');
  assert.equal(unlR.allowance.buckets[0]?.via, 'credits');
  assert.equal(unlR.allowance.buckets[0]?.usedFraction, 0.95);
});

test('b. off: without codexCredits configured, the same reading is exhausted until reset', async () => {
  const cli = fake('codex', signedInCodex(rateLimitsApp(fullUsable)));
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path } }));
  assert.equal(r.allowance.state, 'ok');
  assert.ok(r.allowance.state === 'ok');
  assert.deepEqual(r.allowance.buckets, [
    { bucket: 'codex:primary', model: null, usedFraction: 1, resetsAt: new Date(1790622227 * 1000).toISOString() },
  ]);
  const l = ledgers();
  applyProbe(r, l);
  const view = l.allowances.view('codex-a');
  assert.deepEqual(view, {
    state: 'exhausted',
    accountId: 'codex-a',
    bucket: 'codex:primary',
    until: new Date(1790622227 * 1000).toISOString(),
  });
});

test('c. at the floor: balance <= floor is exhausted', async () => {
  for (const balance of ['5000', '4999', 5000, 0]) {
    const cli = fake('codex', signedInCodex(rateLimitsApp({
      ...fullUsable,
      credits: { hasCredits: true, unlimited: false, balance },
    })));
    const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path }, codexCredits: { floor: 5000 } }));
    assert.equal(r.allowance.state, 'ok');
    assert.ok(r.allowance.state === 'ok');
    assert.deepEqual(r.allowance.buckets, [
      { bucket: 'codex:primary', model: null, usedFraction: 1, resetsAt: new Date(1790622227 * 1000).toISOString() },
    ]);
    const l = ledgers();
    applyProbe(r, l);
    assert.equal(l.allowances.view('codex-a').state, 'exhausted');
  }
});

test('d. spend control: spendControlReached: true is exhausted', async () => {
  const cli = fake('codex', signedInCodex(rateLimitsApp({
    ...fullUsable,
    spendControlReached: true,
  })));
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path }, codexCredits: { floor: 5000 } }));
  assert.equal(r.allowance.state, 'ok');
  assert.ok(r.allowance.state === 'ok');
  assert.deepEqual(r.allowance.buckets, [
    { bucket: 'codex:primary', model: null, usedFraction: 1, resetsAt: new Date(1790622227 * 1000).toISOString() },
  ]);
  const l = ledgers();
  applyProbe(r, l);
  assert.equal(l.allowances.view('codex-a').state, 'exhausted');
});

test('e. malformed: balance "abc" is exhausted, and the reading itself stays ok rather than unknown', async () => {
  for (const credits of [
    { hasCredits: true, unlimited: false, balance: 'abc' },
    { hasCredits: 'yes', unlimited: false, balance: '62420' },
    { hasCredits: true, unlimited: 'no', balance: '62420' },
    { hasCredits: true, unlimited: false, balance: -10 },
    'not an object',
    null,
  ]) {
    const cli = fake('codex', signedInCodex(rateLimitsApp({
      ...fullUsable,
      credits,
    })));
    const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path }, codexCredits: { floor: 5000 } }));
    assert.equal(r.allowance.state, 'ok');
    assert.ok(r.allowance.state === 'ok');
    assert.deepEqual(r.allowance.buckets, [
      { bucket: 'codex:primary', model: null, usedFraction: 1, resetsAt: new Date(1790622227 * 1000).toISOString() },
    ]);
    const l = ledgers();
    applyProbe(r, l);
    assert.equal(l.allowances.view('codex-a').state, 'exhausted');
  }
});

test('f. a hold clears: reading hold from a full reading clears to ok via credits on newer verified credit reading', () => {
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  allowances.record('codex-a', [
    { bucket: 'codex:primary', model: null, usedFraction: 1, resetsAt: new Date(1790622227 * 1000).toISOString() },
  ], new Date(t).toISOString(), { verified: true });
  assert.equal(allowances.view('codex-a').state, 'exhausted');

  t += 60_000;
  allowances.record('codex-a', [
    { bucket: 'codex:primary', model: null, usedFraction: 0.95, resetsAt: new Date(1790622227 * 1000).toISOString(), via: 'credits' },
  ], new Date(t).toISOString(), { verified: true });

  const view = allowances.view('codex-a');
  assert.equal(view.state, 'ok');
  if (view.state === 'ok') {
    assert.equal(view.via, 'credits');
    assert.equal(view.binding, 'codex:primary');
    assert.ok(Math.abs(view.headroom - 0.05) < 1e-9);
  }
});

test('g. not full: a window below 100% with usable credits is reported exactly as today, with no via', async () => {
  const cli = fake('codex', signedInCodex(rateLimitsApp({
    primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 1790622227 },
    credits: { hasCredits: true, unlimited: false, balance: '62420.6122000000' },
    spendControlReached: false,
  })));
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path }, codexCredits: { floor: 5000 } }));
  assert.equal(r.allowance.state, 'ok');
  assert.ok(r.allowance.state === 'ok');
  assert.deepEqual(r.allowance.buckets, [
    { bucket: 'codex:primary', model: null, usedFraction: 0.8, resetsAt: new Date(1790622227 * 1000).toISOString() },
  ]);
  const l = ledgers();
  applyProbe(r, l);
  const view = l.allowances.view('codex-a');
  assert.equal(view.state, 'ok');
  if (view.state === 'ok') {
    assert.equal(view.via, undefined);
    assert.equal(view.binding, 'codex:primary');
    assert.ok(Math.abs(view.headroom - 0.2) < 1e-9);
  }
});

test('h. refused ordinary use: a window with room left counts as full, and credits cover it only when opted in', async () => {
  const refused = (credits?: { floor: number }) => {
    const app = rateLimitsApp({ ...fullUsable, primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1790622227 } });
    (app['account/rateLimits/read'] as { result: Record<string, unknown> }).result.ordinaryUsageAllowed = false;
    return probeAccount(codexAccount, opts({ cli: { codex: fake('codex', signedInCodex(app)).path }, ...(credits ? { codexCredits: credits } : {}) }));
  };
  const off = await refused();
  assert.ok(off.allowance.state === 'ok');
  assert.equal(off.allowance.buckets[0]?.usedFraction, 1);
  assert.equal(off.allowance.buckets[0]?.via, undefined);
  const on = await refused({ floor: 5000 });
  assert.ok(on.allowance.state === 'ok');
  assert.equal(on.allowance.buckets[0]?.usedFraction, 0.95);
  assert.equal(on.allowance.buckets[0]?.via, 'credits');
});

test('i. config: codexCredits needs a finite floor of 0 or more; absent is off', () => {
  assert.equal(codexCreditsConfig(undefined), undefined);
  assert.deepEqual(codexCreditsConfig({ floor: 0 }), { floor: 0 });
  assert.deepEqual(codexCreditsConfig({ floor: 5000 }), { floor: 5000 });
  for (const bad of [null, 'x', {}, { floor: -1 }, { floor: '5000' }, { floor: Number.NaN }, { floor: Number.POSITIVE_INFINITY }]) {
    assert.throws(() => codexCreditsConfig(bad), RangeError);
  }
});

test('j. the queue ranks credit room after every account with ordinary room, whatever its load', () => {
  const at = NOW.toISOString();
  const request = {
    requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'codex', model: 'gpt-6-sol', effort: 'high',
    reason: 'why', prompt: 'do', mutating: false, priority: 'interactive', cwd: '/work',
    id: 'r1', seq: 1, state: 'queued', createdAt: at, updatedAt: at,
    waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null,
  } as unknown as RequestRecord;
  const status = (id: string, running: number, verdict: Record<string, unknown>): AccountStatus => ({
    account: { id, provider: 'codex', loginDir: `/logins/${id}`, fingerprint: 'fp', maxConcurrency: 2, enabled: true }, running,
    evidence: (model) => ({ accountId: id, model, observedAt: at, verdict } as unknown as Evidence),
  });
  const options = { now: NOW, pinWaitMs: 3_600_000, evidenceMaxAgeMs: 600_000, load: new Map() };
  const credit = status('codex-credits', 0, { state: 'available', headroom: 0.05, via: 'credits' });
  const ordinary = status('codex-ordinary', 1, { state: 'available', headroom: 0.02 });
  assert.equal(plan([request], [credit, ordinary], options).dispatch[0]?.accountId, 'codex-ordinary');
  // With no ordinary room free, credit room is used.
  const busy = status('codex-ordinary', 2, { state: 'available', headroom: 0.02 });
  assert.equal(plan([request], [credit, busy], options).dispatch[0]?.accountId, 'codex-credits');
});

test("k. credit room never lifts a job's own limit; ordinary room does", () => {
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  const resetsAt = new Date(1790622227 * 1000).toISOString();
  const read = (usedFraction: number, via?: 'credits') => allowances.record('codex-a',
    [{ bucket: 'codex:primary', model: null, usedFraction, resetsAt, ...(via ? { via } : {}) }], new Date(t).toISOString(), { verified: true });
  read(0.5);
  t += 60_000;
  allowances.recordLimit('codex-a', { bucket: null, model: null, resetsAt: null, observedAt: new Date(t).toISOString() });
  assert.equal(allowances.view('codex-a').state, 'exhausted');
  t += 60_000;
  read(0.95, 'credits');
  assert.equal(allowances.view('codex-a').state, 'exhausted');
  t += 60_000;
  read(0.3);
  assert.equal(allowances.view('codex-a').state, 'ok');
  // The same for a limit that names its bucket.
  t += 60_000;
  allowances.recordLimit('codex-a', { bucket: 'codex:primary', model: null, resetsAt: null, observedAt: new Date(t).toISOString() });
  assert.equal(allowances.view('codex-a').state, 'exhausted');
  t += 60_000;
  read(0.95, 'credits');
  assert.equal(allowances.view('codex-a').state, 'exhausted');
  t += 60_000;
  read(0.3);
  assert.equal(allowances.view('codex-a').state, 'ok');
});

test('l. start refuses a malformed codexCredits before any store work', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-credits-start-')));
  const login = join(root, 'login-codex-a');
  mkdirSync(login);
  const storePath = join(root, 'pipe.sqlite');
  await assert.rejects(startPipe({
    accounts: [{ id: 'codex-a', provider: 'codex', loginDir: login, fingerprint: sha8('<chatgptAccountId>'), maxConcurrency: 1, enabled: true }],
    policy: {
      claude: { models: { opus: 'default', 'claude-opus-5-5': 'hard' }, efforts: ['low', 'medium', 'high', 'max'] },
      codex: { models: { 'gpt-6-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'ultra'] },
    },
    storePath, worktreeRoot: join(root, 'worktrees'), cli: {}, token: 't'.repeat(32), port: 0,
    codexCredits: { floor: -1 },
  } as Parameters<typeof startPipe>[0]), RangeError);
  assert.equal(existsSync(storePath), false);
});

test('m. edge cases: hasCredits false, missing credits, loose number strings, unlimited without a balance, secondary-only, several limits', async () => {
  const probe = async (patch: Record<string, unknown>, extra?: Record<string, unknown>) => {
    const app = rateLimitsApp(patch);
    if (extra) {
      const result = (app['account/rateLimits/read'] as { result: Record<string, unknown> }).result;
      result.rateLimitsByLimitId = { ...(result.rateLimitsByLimitId as Record<string, unknown>), ...extra };
    }
    return probeAccount(codexAccount, opts({ cli: { codex: fake('codex', signedInCodex(app)).path }, codexCredits: { floor: 5000 } }));
  };
  const vias = (r: Awaited<ReturnType<typeof probe>>) => r.allowance.state === 'ok' ? r.allowance.buckets.map((b) => b.via ?? null) : ['not ok'];
  const window = { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790622227 };
  assert.deepEqual(vias(await probe({ ...fullUsable, credits: { hasCredits: false, unlimited: false, balance: '62420' } })), [null]);
  assert.deepEqual(vias(await probe({ primary: window, spendControlReached: false })), [null]);   // no credits key
  for (const balance of ['0x1F4F4', '1e5', ' 62420 ', '62,420', '-62420', '']) {
    assert.deepEqual(vias(await probe({ ...fullUsable, credits: { hasCredits: true, unlimited: false, balance } })), [null], balance);
  }
  assert.deepEqual(vias(await probe({ ...fullUsable, credits: { hasCredits: true, unlimited: true, balance: null } })), ['credits']);
  const secondaryOnly = await probe({ ...fullUsable, primary: null, secondary: window });
  assert.ok(secondaryOnly.allowance.state === 'ok');
  assert.equal(secondaryOnly.allowance.buckets[0]?.bucket, 'codex:secondary');
  assert.equal(secondaryOnly.allowance.buckets[0]?.via, 'credits');
  const other = {
    limitId: 'codex-other', limitName: null, normalModelSlug: null, secondary: null, spendControlReached: false,
    primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1790622227 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
  };
  const several = await probe(fullUsable, { 'codex-other': other });
  assert.deepEqual(vias(several), ['credits', null]);
  const l = ledgers();
  applyProbe(several, l);
  const view = l.allowances.view('codex-a');
  assert.ok(view.state === 'ok');
  assert.equal(view.via, 'credits');
  assert.equal(view.binding, 'codex:primary');
});

test('n. a covered window marks the view even when another bucket binds', () => {
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => NOW });
  const resetsAt = new Date(1790622227 * 1000).toISOString();
  allowances.record('codex-a', [
    { bucket: 'codex:primary', model: null, usedFraction: 0.95, resetsAt, via: 'credits' },
    { bucket: 'codex-other:primary', model: null, usedFraction: 0.97, resetsAt },
  ], NOW.toISOString(), { verified: true });
  const view = allowances.view('codex-a');
  assert.ok(view.state === 'ok');
  assert.equal(view.binding, 'codex-other:primary');
  assert.equal(view.via, 'credits');
});

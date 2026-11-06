/**
 * Acceptance grader, lane U4: probes (lead-authored). The implementation lane must not edit it.
 *
 * Fixtures are official status output captured on a development Mac on 2026-09-24, with every identity
 * value replaced before it touched disk (test/fixtures/u4/README.md). Fake CLIs replay them.
 * Sources: docs/PLAN.md (U4), L5 (the official model list answers an unknown id), L11 (offline
 * is never signed out), L14 (Claude's /usage answers from a cache when offline, silently),
 * rule 8 (evidence carries its owner and its time).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeAccount, applyProbe, explainUnknownModel, parseClaudeUsage, type ProbeOptions, type ProbeReport } from '../src/probe.ts';
import { run, type RunEvent } from '../src/runner.ts';
import { claudeLimitBucket, claudeUsageBucket, codexBucket, modelFamily } from '../src/buckets.ts';
import { AllowanceLedger, RESETLESS_LIMIT_WAIT_MS } from '../src/allowance.ts';
import { IdentityLedger } from '../src/availability.ts';
import type { AccountConfig } from '../src/identity.ts';

const FIX = new URL('./fixtures/u4/', import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const NOW = new Date('2026-09-24T23:20:00.000Z');   // the captures were taken at about 23:16Z
const iso = (d: Date) => d.toISOString();

type Scenario = Record<string, unknown>;
/** A fake official CLI: answers the subcommands it is asked from the scenario, and records how it was called. */
function fake(kind: 'claude' | 'codex', scenario: Scenario): { path: string; calls: () => Array<{ argv: string[]; env: Record<string, string>; cwd: string; pid: number }> } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pipe-u4-${kind}-`)));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const path = join(dir, kind);
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, 'call-' + process.pid + '-' + Date.now() + '.json'), JSON.stringify({ argv, env: process.env, cwd: process.cwd(), pid: process.pid }));
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const answer = (key, dflt) => {
  const a = sc[key] ?? dflt;
  if (a === undefined) { process.stderr.write('no scenario for ' + key); process.exit(2); }
  if (a.hang) { setInterval(() => {}, 1000); return; }
  if (a.bigBytes) { process.stdout.write('x'.repeat(a.bigBytes)); process.exit(0); }
  if (a.stdout !== undefined) out(a.stdout);
  if (a.stderr !== undefined) process.stderr.write(a.stderr);
  process.exitCode = a.exit ?? 0;
};
if (argv[0] === '--version') answer('version');
else if (argv[0] === 'auth' && argv[1] === 'status') answer('auth');
else if (argv[0] === '-p' && argv[1] === '/usage') answer('usage');
else if (argv[0] === 'login' && argv[1] === 'status') answer('login');
else if (argv[0] === 'app-server') {
  const app = sc.app || {};
  if (app.hang) { setInterval(() => {}, 1000); }
  else {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === undefined) continue;                        // notifications
        fs.writeFileSync(path.join(__dirname, 'received-' + m.method.split('/').join('_')), String(Date.now()));
        const r = app[m.method];
        if (!r) { out({ id: m.id, error: { code: -32601, message: 'unknown method ' + m.method } }); out('\\n'); continue; }
        out(Object.assign({ id: m.id }, r)); out('\\n');
        // A server request may reuse an id the client already has an answer for: it must not replace it.
        if (app.unsolicited && m.method === 'account/rateLimits/read') { out({ id: m.id, method: 'item/commandExecution/requestApproval', params: {} }); out('\\n'); }
      }
    });
  }
} else { process.stderr.write('unexpected ' + argv.join(' ')); process.exit(2); }
`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () => readdirSync(dir).filter((f) => f.startsWith('call-')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))),
  };
}

/** The captured app-server exchange as a method -> response map, for the fake codex. */
function appOf(name: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const e of fixture(name) as Array<{ method: string; response: Record<string, unknown> }>) {
    const { id: _id, ...rest } = e.response;
    map[e.method] = rest;
  }
  return { ...map, ...patch };
}

const claudeAccount: AccountConfig = { id: 'claude-a', provider: 'claude', loginDir: '/logins/claude-a', fingerprint: sha8('<orgId>'), maxConcurrency: 1, enabled: true };
const codexAccount: AccountConfig = { id: 'codex-a', provider: 'codex', loginDir: '/logins/codex-a', fingerprint: sha8('<chatgptAccountId>'), maxConcurrency: 1, enabled: true };
const signedInClaude = () => ({
  version: { stdout: fixture('claude-version').stdout },
  auth: { stdout: fixture('claude-auth-status.signed-in').stdout, exit: 0 },
  usage: { stdout: fixture('claude-usage.signed-in').stdout, exit: 0 },
});
const signedInCodex = (app: Record<string, unknown> = appOf('codex-app-server.signed-in')) => ({
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

// ── Claude ──────────────────────────────────────────────────────────────────

test('P1 Claude signed in: identity signed in, fingerprint = sha256(orgId)[0:8], bound to the account and the probe time', async () => {
  const cli = fake('claude', signedInClaude());
  const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
  assert.equal(r.accountId, 'claude-a');
  assert.equal(r.identity.state, 'signed-in');
  assert.ok(r.identity.state === 'signed-in');
  assert.deepEqual(r.identity.identity, { accountId: 'claude-a', signedIn: true, fingerprint: sha8('<orgId>'), observedAt: iso(NOW) });
});

test('P2 Claude signed out (exit 1, JSON on stdout) is signed out, not unknown', async () => {
  const cli = fake('claude', { ...signedInClaude(), auth: { stdout: fixture('claude-auth-status.signed-out').stdout, exit: 1 } });
  const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
  assert.equal(r.identity.state, 'signed-out');
  assert.ok(r.identity.state === 'signed-out');
  assert.equal(r.identity.identity.signedIn, false);
  assert.equal(r.identity.identity.fingerprint, null);
});

test('P3 Claude auth garbage, a crash or a missing CLI is unknown, never signed out (L11)', async () => {
  for (const auth of [{ stdout: 'not json at all', exit: 0 }, { stdout: '', exit: 3 }, { stdout: '{"loggedIn":"yes"}', exit: 0 }]) {
    const cli = fake('claude', { ...signedInClaude(), auth });
    const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
    assert.equal(r.identity.state, 'unknown', JSON.stringify(auth));
  }
  const missing = await probeAccount(claudeAccount, opts({ cli: { claude: '/nonexistent/claude' } }));
  assert.equal(missing.identity.state, 'unknown');
  assert.equal(missing.allowance.state, 'unknown');
  assert.equal(missing.version.state, 'unknown');
});

test('P4 Claude on an API key, or on no subscription, is not a subscription login: signed out, with the reason', async () => {
  const base = fixture('claude-auth-status.signed-in').stdout;
  for (const stdout of [{ ...base, authMethod: 'api_key' }, { ...base, subscriptionType: null }, { ...base, apiProvider: 'bedrock' }]) {
    const cli = fake('claude', { ...signedInClaude(), auth: { stdout, exit: 0 } });
    const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
    assert.equal(r.identity.state, 'signed-out', JSON.stringify(stdout));
    assert.ok(r.identity.state === 'signed-out');
    assert.match(r.identity.reason ?? '', /not a subscription/u);
  }
});

test('P5 /usage becomes readings named as the service names them, with zone-correct instants', async () => {
  const cli = fake('claude', signedInClaude());
  const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
  assert.equal(r.allowance.state, 'ok');
  assert.ok(r.allowance.state === 'ok');
  assert.equal(r.allowance.measuredAt, iso(NOW));
  assert.deepEqual(r.allowance.buckets, [
    { bucket: 'five_hour', model: null, usedFraction: 0.16, resetsAt: '2026-09-25T02:59:00.000Z' },
    { bucket: 'seven_day', model: null, usedFraction: 0.85, resetsAt: '2026-09-30T00:59:00.000Z' },
    { bucket: 'seven_day', model: 'fable', usedFraction: 0.16, resetsAt: '2026-09-30T00:59:00.000Z' },
  ]);
  // A reset with no minutes, and one with no date (the next such time after the probe).
  const usage = { ...fixture('claude-usage.signed-in').stdout, result: [
    'Current session: 3% used · resets 7:10pm (America/New_York)',
    'Current week (all models): 87% used · resets Sep 27 at 4am (America/New_York)',
  ].join('\n') };
  const other = fake('claude', { ...signedInClaude(), usage: { stdout: usage, exit: 0 } });
  const s = await probeAccount(claudeAccount, opts({ cli: { claude: other.path } }));
  assert.ok(s.allowance.state === 'ok');
  assert.deepEqual(s.allowance.buckets.map((b) => b.resetsAt), ['2026-09-25T23:10:00.000Z', '2026-09-27T08:00:00.000Z']);
});

test('P6 when the service cannot be reached, /usage answers from its cache: the reading is offline and never recorded (L14)', async () => {
  const cli = fake('claude', { ...signedInClaude(), usage: { stdout: fixture('claude-usage.offline').stdout, exit: 0 } });
  const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path }, reachable: async () => false }));
  assert.equal(r.allowance.state, 'offline');
  assert.equal(r.identity.state, 'signed-in', 'the login is local: an outage says nothing about it');
  const l = ledgers();
  applyProbe(r, l);
  assert.deepEqual(l.allowances.view('claude-a'), { state: 'unknown', accountId: 'claude-a', reason: 'no reading' });
  const hung = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path }, reachable: () => new Promise<boolean>(() => {}) }));
  assert.equal(hung.allowance.state, 'offline', 'an unanswered reachability check is offline too, and bounded');
});

test('P7 a /usage that ran a turn, cost anything or reported an error is not a free status reading: unknown', async () => {
  const base = fixture('claude-usage.signed-in').stdout;
  for (const stdout of [{ ...base, num_turns: 1 }, { ...base, total_cost_usd: 0.01 }, { ...base, is_error: true }, { ...base, result: 'no usage lines here' }]) {
    const cli = fake('claude', { ...signedInClaude(), usage: { stdout, exit: 0 } });
    const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
    assert.equal(r.allowance.state, 'unknown', JSON.stringify({ ...stdout, result: undefined }));
  }
});

// ── Codex ───────────────────────────────────────────────────────────────────

test('P8 Codex identity comes from account/read, which is local: signed in with its fingerprint, signed out, or not a subscription', async () => {
  const cli = fake('codex', signedInCodex());
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path } }));
  assert.ok(r.identity.state === 'signed-in');
  assert.deepEqual(r.identity.identity, { accountId: 'codex-a', signedIn: true, fingerprint: sha8('<chatgptAccountId>'), observedAt: iso(NOW) });
  const out = fake('codex', signedInCodex(appOf('codex-app-server.signed-out')));
  const o = await probeAccount(codexAccount, opts({ cli: { codex: out.path } }));
  assert.equal(o.identity.state, 'signed-out');
  const apiKey = fake('codex', signedInCodex(appOf('codex-app-server.signed-in', { 'account/read': { result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } } })));
  const k = await probeAccount(codexAccount, opts({ cli: { codex: apiKey.path } }));
  assert.ok(k.identity.state === 'signed-out');
  assert.match(k.identity.reason ?? '', /not a subscription/u);
  const offline = fake('codex', signedInCodex(appOf('codex-app-server.offline')));
  const f = await probeAccount(codexAccount, opts({ cli: { codex: offline.path } }));
  assert.equal(f.identity.state, 'signed-in', 'offline, the login is still known');
});

test('P9 Codex allowance from rateLimits: its windows as buckets; offline, signed out and malformed are never readings', async () => {
  const cli = fake('codex', signedInCodex());
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path } }));
  assert.ok(r.allowance.state === 'ok');
  assert.deepEqual(r.allowance.buckets, [
    { bucket: 'codex:primary', model: null, usedFraction: 0.96, resetsAt: new Date(1790622227 * 1000).toISOString() },
  ]);
  const offline = fake('codex', signedInCodex(appOf('codex-app-server.offline')));
  assert.equal((await probeAccount(codexAccount, opts({ cli: { codex: offline.path } }))).allowance.state, 'offline');
  const out = fake('codex', signedInCodex(appOf('codex-app-server.signed-out')));
  assert.equal((await probeAccount(codexAccount, opts({ cli: { codex: out.path } }))).allowance.state, 'signed-out');
  const good = appOf('codex-app-server.signed-in')['account/rateLimits/read'] as { result: Record<string, unknown> };
  const codex = (good.result.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex!;
  for (const primary of [{ usedPercent: 150, windowDurationMins: 10080, resetsAt: 1790622227 }, { usedPercent: 50, windowDurationMins: 10080, resetsAt: 'soon' }, { usedPercent: 50, windowDurationMins: 0, resetsAt: 1790622227 }]) {
    const bad = { result: { ...good.result, rateLimitsByLimitId: { codex: { ...codex, primary } } } };
    const b = fake('codex', signedInCodex(appOf('codex-app-server.signed-in', { 'account/rateLimits/read': bad })));
    assert.equal((await probeAccount(codexAccount, opts({ cli: { codex: b.path } }))).allowance.state, 'unknown', JSON.stringify(primary));
  }
  // A limit scoped to a model names it: the bucket is that model's.
  const scoped = { result: { ...good.result, rateLimitsByLimitId: { codex, spark: { ...codex, limitId: 'spark', normalModelSlug: 'gpt-6-luna' } } } };
  const sc = fake('codex', signedInCodex(appOf('codex-app-server.signed-in', { 'account/rateLimits/read': scoped })));
  const sr = await probeAccount(codexAccount, opts({ cli: { codex: sc.path } }));
  assert.ok(sr.allowance.state === 'ok');
  assert.deepEqual(sr.allowance.buckets.map((b) => [b.bucket, b.model]), [['codex:primary', null], ['spark:primary', 'gpt-6-luna']]);
});

test('P10 the official model list is reported, and an unknown id is answered with it (L5); Claude has none', async () => {
  const cli = fake('codex', signedInCodex());
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path } }));
  assert.ok(r.models.state === 'ok');
  for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) assert.ok(r.models.models.includes(id), id);
  const answer = explainUnknownModel(r.models, 'gpt-7-sol');
  assert.match(answer, /gpt-7-sol/u);
  for (const id of r.models.models) assert.ok(answer.includes(id), `the answer lists ${id}`);
  const c = await probeAccount(claudeAccount, opts({ cli: { claude: fake('claude', signedInClaude()).path } }));
  assert.equal(c.models.state, 'none');
});

test('P11 the CLI version is parsed and flagged below the configured minimum; an unparsable one is unknown, not stale', async () => {
  const cli = fake('claude', signedInClaude());
  const ok = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
  assert.deepEqual(ok.version, { state: 'ok', version: '2.1.280', outdated: false, minimum: '2.1.280' });
  const old = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path }, minVersion: { claude: '2.1.300' } }));
  assert.ok(old.version.state === 'ok' && old.version.outdated === true);
  const newer = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path }, minVersion: { claude: '2.1.99' } }));
  assert.ok(newer.version.state === 'ok' && newer.version.outdated === false, 'compared as numbers, not text: 280 > 99');
  const odd = fake('claude', { ...signedInClaude(), version: { stdout: 'a development build\n' } });
  assert.equal((await probeAccount(claudeAccount, opts({ cli: { claude: odd.path } }))).version.state, 'unknown');
  const codex = await probeAccount(codexAccount, opts({ cli: { codex: fake('codex', signedInCodex()).path }, minVersion: { codex: '0.156.1' } }));
  assert.deepEqual(codex.version, { state: 'ok', version: '0.156.1', outdated: false, minimum: '0.156.1' });
});

// ── the ledgers ─────────────────────────────────────────────────────────────

test('P12 a report records only for its own account', async () => {
  const cli = fake('claude', signedInClaude());
  const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
  const l = ledgers();
  applyProbe(r, l);
  assert.equal(l.identities.view('claude-a')?.accountId, 'claude-a');
  assert.equal(l.allowances.view('claude-a', 'opus').state, 'ok');
  assert.equal(l.identities.view('claude-b'), undefined);
  assert.equal(l.allowances.view('claude-b').state, 'unknown');
  // A report whose parts name another account is refused whole: evidence belongs to its owner.
  const forged = { ...r, identity: r.identity.state === 'signed-in' ? { ...r.identity, identity: { ...r.identity.identity, accountId: 'claude-b' } } : r.identity } as ProbeReport;
  const m = ledgers();
  assert.throws(() => applyProbe(forged, m), /another account/u);
  assert.equal(m.identities.view('claude-b'), undefined);
});

test('P13 a failed probe leaves both ledgers exactly as they were', async () => {
  const l = ledgers();
  const good = await probeAccount(claudeAccount, opts({ cli: { claude: fake('claude', signedInClaude()).path } }));
  applyProbe(good, l);
  l.allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: '2026-09-25T02:59:00.000Z' });
  const before = { id: l.identities.view('claude-a'), a: l.allowances.view('claude-a'), f: l.allowances.view('claude-a', 'fable') };
  const broken = fake('claude', { version: { stdout: 'x' }, auth: { stdout: 'garbage', exit: 0 }, usage: { stdout: 'garbage', exit: 0 } });
  for (const o of [opts({ cli: { claude: broken.path } }), opts({ cli: { claude: fake('claude', signedInClaude()).path }, reachable: async () => false })]) {
    applyProbe(await probeAccount(claudeAccount, o), l);
    assert.deepEqual({ id: l.identities.view('claude-a'), a: l.allowances.view('claude-a'), f: l.allowances.view('claude-a', 'fable') }, before);
  }
});

test('P14 the runner and the probe name a bucket alike, so a probe reading can clear the runner\'s hold', () => {
  assert.deepEqual(claudeLimitBucket('five_hour', 'opus'), { bucket: 'five_hour', model: null });
  assert.deepEqual(claudeLimitBucket('seven_day', 'opus'), { bucket: 'seven_day', model: null });
  assert.deepEqual(claudeLimitBucket('seven_day_fable', 'claude-fable-5-1'), { bucket: 'seven_day', model: 'fable' });
  assert.deepEqual(claudeUsageBucket('session', null), claudeLimitBucket('five_hour', 'opus'));
  assert.deepEqual(claudeUsageBucket('week', 'all models'), claudeLimitBucket('seven_day', 'opus'));
  assert.deepEqual(claudeUsageBucket('week', 'Fable'), claudeLimitBucket('seven_day_fable', 'claude-fable-5-1'));
  assert.deepEqual(codexBucket('codex', 'primary', null), { bucket: 'codex:primary', model: null });
  assert.equal(modelFamily('claude-fable-5-1'), 'fable');
  assert.equal(modelFamily('fable'), 'fable');
  assert.equal(modelFamily('gpt-6-sol'), 'gpt-6-sol');
  // Through the ledger: a spent Fable week holds Fable only, and a later reading with room clears it.
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  allowances.record('claude-a', [
    { bucket: 'five_hour', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T02:59:00.000Z' },
    { bucket: 'seven_day', model: null, usedFraction: 0.5, resetsAt: '2026-09-30T00:59:00.000Z' },
    { bucket: 'seven_day', model: 'fable', usedFraction: 0.5, resetsAt: '2026-09-30T00:59:00.000Z' },
  ]);
  allowances.recordLimit('claude-a', { ...claudeLimitBucket('seven_day_fable', 'claude-fable-5-1'), resetsAt: '2026-09-30T00:59:00.000Z' });
  assert.equal(allowances.view('claude-a', 'claude-fable-5-1').state, 'exhausted', 'a full model id is scoped by its family');
  assert.equal(allowances.view('claude-a', 'opus').state, 'ok', 'another model is not held');
  t += 60_000;
  allowances.record('claude-a', [
    { bucket: 'five_hour', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T02:59:00.000Z' },
    { bucket: 'seven_day', model: null, usedFraction: 0.5, resetsAt: '2026-09-30T00:59:00.000Z' },
    { ...claudeUsageBucket('week', 'Fable')!, usedFraction: 0.2, resetsAt: '2026-09-30T00:59:00.000Z' },
  ], new Date(t).toISOString());
  assert.equal(allowances.view('claude-a', 'fable').state, 'ok');
});

test('P15 a reading measured before a hold began cannot clear it, even when it arrives after', () => {
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  const room = (): Array<{ bucket: string; model: string | null; usedFraction: number; resetsAt: string }> =>
    [{ bucket: 'five_hour', model: null, usedFraction: 0.2, resetsAt: '2026-09-25T02:59:00.000Z' }];
  const measured = new Date(t).toISOString();   // the probe measures here…
  t += 1_000;
  allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: '2026-09-25T02:59:00.000Z' });   // …a job hits the limit…
  t += 1_000;
  allowances.record('claude-a', room(), measured);   // …and the probe's older reading lands last
  assert.equal(allowances.view('claude-a').state, 'exhausted');
  t += 1_000;
  allowances.record('claude-a', room(), new Date(t).toISOString());
  assert.equal(allowances.view('claude-a').state, 'ok', 'a reading measured after the hold clears it');
  // A measurement later than the ledger's clock is not evidence.
  const later = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => NOW });
  later.record('claude-a', room(), new Date(NOW.getTime() + 60_000).toISOString());
  assert.equal(later.view('claude-a').state, 'unknown');
});

// ── isolation and bounds ────────────────────────────────────────────────────

test('P16 probes run with the account\'s own login folder and the allow-listed environment only', async () => {
  const leaky = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ANTHROPIC_API_KEY: 'fake-anthropic-key', OPENAI_API_KEY: 'fake-openai-key', HTTPS_PROXY: 'http://127.0.0.1:9', CLAUDE_CONFIG_DIR: '/somewhere/else', CODEX_HOME: '/somewhere/else', GITHUB_TOKEN: 'ghp_not_real' };
  const c = fake('claude', signedInClaude());
  await probeAccount(claudeAccount, opts({ cli: { claude: c.path }, env: leaky }));
  const x = fake('codex', signedInCodex());
  await probeAccount(codexAccount, opts({ cli: { codex: x.path }, env: leaky }));
  const calls = [...c.calls(), ...x.calls()];
  assert.ok(calls.length >= 4, 'every probe ran');
  for (const call of calls) {
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'GITHUB_TOKEN']) assert.equal(call.env[k], undefined, `${k} in ${call.argv.join(' ')}`);
  }
  for (const call of c.calls()) assert.equal(call.env.CLAUDE_CONFIG_DIR, '/logins/claude-a');
  for (const call of x.calls()) assert.equal(call.env.CODEX_HOME, '/logins/codex-a');
  assert.ok(c.calls().some((call) => call.argv.join(' ').startsWith('-p /usage --output-format json')), 'the isolated /usage argv');
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--setting-sources']) {
    assert.ok(c.calls().some((call) => call.argv[1] === '/usage' && call.argv.includes(flag)), flag);
  }
});

test('P17 bounded: a CLI that never answers is killed at the timeout, and oversized output is unknown', async () => {
  // Raced against the test's own deadline, so a probe that is not bounded fails here instead of hanging.
  const bounded = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('the probe did not end: not bounded')), 10_000).unref(); })]);
  const hung = fake('claude', { ...signedInClaude(), auth: { hang: true } });
  const quiet = fake('codex', signedInCodex({ hang: true }));
  try {
    const r = await bounded(probeAccount(claudeAccount, opts({ cli: { claude: hung.path }, timeoutMs: 1_000 })));
    assert.equal(r.identity.state, 'unknown');
    const q = await bounded(probeAccount(codexAccount, opts({ cli: { codex: quiet.path }, timeoutMs: 1_000 })));
    assert.equal(q.identity.state, 'unknown');
    assert.equal(q.allowance.state, 'unknown');
  } finally {
    // If the probe failed to kill them, the test does, so a broken bound fails here instead of hanging the run.
    for (const call of [...hung.calls(), ...quiet.calls()]) { try { process.kill(call.pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  }
  // Valid JSON, but more than the cap: refused for its size, not for its content.
  const padded = { ...fixture('claude-usage.signed-in').stdout, padding: 'x'.repeat(3 * 1024 * 1024) };
  const big = fake('claude', { ...signedInClaude(), usage: { stdout: padded, exit: 0 } });
  const b = await bounded(probeAccount(claudeAccount, opts({ cli: { claude: big.path } })));
  assert.equal(b.allowance.state, 'unknown');
  // A server request that reuses a pending id is ignored, not mistaken for that response.
  const chatty = fake('codex', signedInCodex(appOf('codex-app-server.signed-in', { unsolicited: true })));
  assert.equal((await bounded(probeAccount(codexAccount, opts({ cli: { codex: chatty.path } })))).allowance.state, 'ok');
  assert.ok(existsSync(hung.path));
});

test('P18 the runner names a limit as the probe names readings: a model\'s week is scoped to that model', async () => {
  const weekly = readFileSync(new URL('../claude-weekly-limit.jsonl', FIX), 'utf8').trim().split('\n');
  for (const [type, expected] of [['seven_day', { bucket: 'seven_day', model: null }], ['seven_day_fable', { bucket: 'seven_day', model: 'fable' }],
    // Round 5: a scope that is not the running model's, or a type the pipe does not know, holds the account's week.
    ['seven_day_other', { bucket: 'seven_day', model: null }], ['seven_day_opus', { bucket: 'seven_day', model: null }],
    ['monthly', { bucket: 'seven_day', model: null }]] as const) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u4-runner-')));
    const lines = weekly.map((l) => l.replace('"rateLimitType": "seven_day"', `"rateLimitType": "${type}"`));
    writeFileSync(join(dir, 'cli'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});\nprocess.exit(1);\n`);
    chmodSync(join(dir, 'cli'), 0o755);
    const login = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u4-login-')));
    const events: RunEvent[] = [];
    for await (const e of run({ requestId: 'req-p18', accountId: 'claude-a', provider: 'claude', model: 'fable', effort: 'high', prompt: 'x',
      mutating: false, cwd: realpathSync(tmpdir()), loginDir: login }, { cli: { claude: join(dir, 'cli') }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, reachable: async () => true })) events.push(e);
    const limit = events.find((e) => e.type === 'limit') as { bucket: string | null; model: string | null } | undefined;
    assert.ok(limit, `${type}: a limit event`);
    assert.deepEqual({ bucket: limit.bucket, model: limit.model }, expected, type);
  }
});

test('S4 the core through U4 stays small and dependency-free (docs/PLAN.md: U4 grows it by 500-700 lines)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', FIX), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  const src = new URL('../../../src/', FIX);
  // Later lanes' own files are theirs to budget (U5: service, http, mcp, cli; U8: disk.ts; U10: review.ts; U11: client.ts, moved out of http.ts; U18: release-copy.ts; READ-CONTRACT-01: cards.ts; u51: retention.ts; U5's S5 checks the whole core).
  const lines = readdirSync(src).filter((f) => f.endsWith('.ts') && !['service.ts', 'http.ts', 'mcp.ts', 'cli.ts', 'disk.ts', 'client.ts', 'review.ts', 'agy.ts', 'telemetry.ts', 'release-copy.ts', 'cards.ts', 'projects.ts', 'retention.ts'].includes(f))
    .map((f) => readFileSync(new URL(f, src), 'utf8').split('\n').filter((l) => l.trim() !== '').length)
    .reduce((a, b) => a + b, 0);
  // U12 grows the runner's git and the store's cancel record past the original 2,700; U13 the
  // ledger's bucket retirement and its cached-reading rule (the lead, 2026-09-26).
  // U15 keeps src/agy.ts under its own S15, and adds the store's one-seat AGY hold (the lead's delegate).
  // U13 follow-up adds 30 non-blank lines in this slice for two gates, cached ordering, A9 and migration.
  // READ-CONTRACT-01 step 1 (2026-09-30) keeps src/cards.ts under its own S19, and adds the wait codes, the saved state,
  // attempts(), a change number (moved by attempt writes too) and changedAfter(), the open-card read and a finish
  // stamp to the store, a proved runner liveness, and unique account display names: 105 (the Router owner).
  // READ-CONTRACT-01 step 2a (2026-09-30): the event clock, its store columns and noteEvents, and the runner's onEvent
  // hook: 38 (the Router owner).
  // Rule 49: Codex credits the owner did not buy count as last-ranked room by opt-in
  // (`codexCredits`), with its config check; refused ordinary use fills every window; the queue ranks credit room last
  // and it never lifts a job's limit: 37 (the Router Architect).
  // READ-CONTRACT-01 step 2b (2026-09-30): closedAt's store column and noteClosed, and the runner's onClosed after a
  // group is proved gone and its pipes closed, or when no process was ever made: 27 (the Router owner).
  // The 2026-10-08 merge of main with live line (saved bases, automatic routing, placement status, review placement and MCP narrow reads),
  // which ran live at 3,258 without this gate moving: +236 (the lead).
  // Velocity telemetry: the store's review lane, round and setupFailed, and the saved diff (src/telemetry.ts is budgeted on its own in S5): +12 (the lead).
  // Telemetry round 3: the store's dedicated setup-cancel marker: +1 (the lead).
  // U39 account preference: +2 (the lead).
  // round 3: worktreeAddTimeoutMs is validated like gitTimeoutMs: +1 (the lead).
  // u42: src/projects.ts is budgeted on its
  // own in S5; the store's contextPacketSha256 request field: +2 (3,274 -> 3,276).
  // E1 idempotent admission: +308 (3,276 → 3,584), the lead.
  // u43 external leases (round 2): store lease table and pure reads, plus lease load in availability, planning and claims: +70 (3,584 → 3,654), the lead.
  // u43 review round 1: jobs-aware take, expiry sweep and grace: +10 (3,654 → 3,664), the lead.
  // u43 final round: renewal clock guard and sweep isolation: +3 (3,664 → 3,667), the lead.
  // u43 lead round 4: renewal window and heartbeat freshness: +4 (3,667 → 3,671), the lead.
  // u43: tick/TTL check at take and renew: +2 (3,671 → 3,673), the lead.
  // u44 housekeeping (round 3, no archiving; 2026-10-29): store housekeeping and save-strike fields, the review git deadline and src/classify.ts (regenerable ignored roots): +89 (3,673 → 3,762), the lead.
  // u44 lead round 4 (2026-10-29): byte-safe ignored listing, durable partial removal, fingerprints, write-aware capacity guard and abortable scans: +44 (3,762 → 3,806), the lead.
  // u44 lead round 5 (2026-10-29): resource-fork refusal, byte-safe walk, removal-refusal recovery, fair retries, placeholder re-listing and index-aware capacity: +38 (3,806 → 3,844), the lead.
  // u44 lead round 6 (2026-10-29): extended-attribute refusal, exit-128 removal recovery, hung-vs-slow scans, tree-aware capacity and other VCS markers: +74 (3,844 → 3,918), the lead.
  // u44 lead rounds 6b-6c (2026-10-29): removal-only xattr checks and the hung-group outcome: +2 (3,918 → 3,920), the lead.
  // u44 lead round 7 (2026-10-29): unambiguous xattr refusal, deleted-directory capacity, block-size rounding, the unproven-group gate and rethrown group failures: +41 (3,920 → 3,961), the lead.
  // u44 lead round 7c (2026-10-29): the prune group proof and file-to-directory capacity: +2 (3,961 → 3,963), the lead.
  // u49 round 2 (2026-10-31): canonical non-overlapping previous worktree roots, per-volume tiers and the restored disk.ts rationale comments (round 1 had moved them out to fit): +2 (3,963 → 3,965), the lead.
  // u49 round 5 (2026-10-31): src/worktree-roots.ts (abortable previous-root reads, per-pass availability, the root-bound proof), partly moved out of disk.ts: +109 (3,965 → 4,074), the lead.
  // u49 round 6 (2026-10-31): the no-follow walk under worktreeRoot, refresh-invalidated save proofs and unavailable-root handling: +16 (4,074 → 4,090), the lead.
  // u49 rounds 7-7b (2026-10-31): the canonical-root walk, per-pass abortable root checks, ancestor dev proof for a root created after startup and mount-point refusal: +22 (4,090 → 4,112), the lead.
  // u49 round 8 (2026-10-31): missing-root hold, guarded worktreeRoot creation and per-save root checks: +9 (4,112 → 4,121), the lead.
  // u49 round 9 (2026-10-31): unchecked or vanished-root finalization holds, startup refusal before the volume mounts and the startup-device guard: +3 (4,121 → 4,124), the lead.
  // u49.1 (2026-10-31): lost-volume detection, the optional work-volume marker and the canonical-root guard: +32 (4,124 → 4,156), the lead.
  // 2026-11-01: a /usage page with the week but no session line reads as a session not yet started: +3 (4,156 → 4,159), the Huntaway lead.
  // u51 (2026-11-01): the store's pruneEndedRecords for ended-record retention (one clock sample, a resumable scan cursor set after commit) and lane_rounds, each lane's highest round, backfilled once and raised on every review (src/retention.ts is budgeted on its own in S5): +18 (4,159 → 4,177), the Huntaway lead.
  assert.ok(lines <= 4_177, `src/ holds ${lines} non-blank lines; U1-U4 together have 4,177`);
});

// Added after review round 1 (Sol 6 on b203298).

test('P19 Codex rate limits count only when they name the signed-in login', async () => {
  const good = appOf('codex-app-server.signed-in')['account/rateLimits/read'] as { result: Record<string, unknown> };
  for (const accountId of ['someone-else', undefined, '']) {
    const limits = { result: { ...good.result, accountId } };
    const cli = fake('codex', signedInCodex(appOf('codex-app-server.signed-in', { 'account/rateLimits/read': limits })));
    const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path } }));
    assert.equal(r.identity.state, 'signed-in');
    assert.equal(r.allowance.state, 'unknown', String(accountId));
  }
});

test('P20 allowance counts only for the login pinned in config: another login\'s is never this account\'s', async () => {
  const other = { ...claudeAccount, fingerprint: 'deadbeef' };
  const c = await probeAccount(other, opts({ cli: { claude: fake('claude', signedInClaude()).path } }));
  assert.equal(c.identity.state, 'signed-in');
  assert.equal(c.allowance.state, 'unknown');
  const x = await probeAccount({ ...codexAccount, fingerprint: 'deadbeef' }, opts({ cli: { codex: fake('codex', signedInCodex()).path } }));
  assert.equal(x.allowance.state, 'unknown');
  const l = ledgers();
  applyProbe(c, l);
  assert.equal(l.allowances.view('claude-a').state, 'unknown', 'nothing recorded');
});

test('P21 a Claude reading is unverified: it may clear what readings held, never a job\'s own limit (L14)', async () => {
  const c = await probeAccount(claudeAccount, opts({ cli: { claude: fake('claude', signedInClaude()).path } }));
  assert.ok(c.allowance.state === 'ok' && c.allowance.verified === false);
  const x = await probeAccount(codexAccount, opts({ cli: { codex: fake('codex', signedInCodex()).path } }));
  assert.ok(x.allowance.state === 'ok' && x.allowance.verified === true);
  let t = NOW.getTime() - 60_000;
  const l = { identities: new IdentityLedger({ now: () => new Date(t) }), allowances: new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) }) };
  l.allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: '2026-09-25T02:59:00.000Z' });
  t = NOW.getTime();
  applyProbe(c, l);   // a later /usage with room, possibly from its cache
  assert.equal(l.allowances.view('claude-a').state, 'exhausted', 'a job\'s limit stands until its reset');
  const full = { ...c, allowance: { ...c.allowance, buckets: c.allowance.buckets.map((b) => b.bucket === 'seven_day' && b.model === null ? { ...b, usedFraction: 1 } : b) } } as ProbeReport;
  const m = ledgers();
  applyProbe(full, m);
  assert.equal(m.allowances.view('claude-a').state, 'exhausted', 'a reading may hold');
  t = NOW.getTime() + 60_000;
  const later = { ...c, allowance: { ...c.allowance, measuredAt: new Date(NOW.getTime() + 30_000).toISOString() } } as ProbeReport;
  const n = { identities: new IdentityLedger({ now: () => new Date(t) }), allowances: new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) }) };
  n.allowances.record('claude-a', (full.allowance as unknown as { buckets: Parameters<AllowanceLedger['record']>[1] }).buckets, iso(NOW), { verified: false });
  applyProbe(later, n);
  assert.equal(n.allowances.view('claude-a').state, 'ok', 'a later reading clears what a reading held');
});

test('P22 a stated reset that cannot be read makes the reading unknown, not resetless capacity', () => {
  const lines = (zone: string) => ['Current session: 10% used · resets Sep 24 at 10:59pm (' + zone + ')',
    'Current week (all models): 20% used · resets Sep 29 at 8:59pm (America/New_York)'].join('\n');
  assert.equal(parseClaudeUsage(lines('Mars/Olympus_Mons'), NOW), null);
  assert.ok(parseClaudeUsage(lines('America/New_York'), NOW));
});

test('P23 a Claude reading needs the week; a session alone is unknown, a week alone is a session not yet started', async () => {
  const base = fixture('claude-usage.signed-in').stdout;
  for (const [result, state] of [['Current session: 16% used · resets Sep 24 at 10:59pm (America/New_York)', 'unknown'],
    ['Current week (Fable): 19% used · resets Sep 29 at 8:59pm (America/New_York)', 'unknown'],
    ['Current week (all models): 85% used · resets Sep 29 at 8:59pm (America/New_York)', 'ok']]) {
    const cli = fake('claude', { ...signedInClaude(), usage: { stdout: { ...base, result }, exit: 0 } });
    assert.equal((await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }))).allowance.state, state, result);
  }
});

test('P24 a Codex limit that names a malformed model is unknown, never account-wide', async () => {
  const good = appOf('codex-app-server.signed-in')['account/rateLimits/read'] as { result: Record<string, unknown> };
  const codex = (good.result.rateLimitsByLimitId as Record<string, Record<string, unknown>>).codex!;
  for (const normalModelSlug of [42, '', { id: 'x' }]) {
    const limits = { result: { ...good.result, rateLimitsByLimitId: { codex, spark: { ...codex, limitId: 'spark', normalModelSlug } } } };
    const cli = fake('codex', signedInCodex(appOf('codex-app-server.signed-in', { 'account/rateLimits/read': limits })));
    assert.equal((await probeAccount(codexAccount, opts({ cli: { codex: cli.path } }))).allowance.state, 'unknown', JSON.stringify(normalModelSlug));
  }
});

test('P25 auth status must exit as its state says: 0 signed in, 1 signed out; anything else is unknown', async () => {
  const inJson = fixture('claude-auth-status.signed-in').stdout;
  const outJson = fixture('claude-auth-status.signed-out').stdout;
  for (const auth of [{ stdout: inJson, exit: 1 }, { stdout: outJson, exit: 0 }, { stdout: outJson, exit: 2 }]) {
    const cli = fake('claude', { ...signedInClaude(), auth });
    assert.equal((await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }))).identity.state, 'unknown', JSON.stringify({ exit: auth.exit }));
  }
});

test('P26 resets are real instants: the fall-back hour\'s next time, no invented calendar dates, no spring-forward gap', () => {
  const at = (line: string, now: string) => parseClaudeUsage(line + '\nCurrent week (all models): 1% used · resets Dec 1 at 1am (America/New_York)', new Date(now))?.[0]?.resetsAt ?? null;
  // At 01:40 EDT on 1 Nov 2026, the next 1:30am is the second one (EST), an hour away, not tomorrow's.
  assert.equal(at('Current session: 5% used · resets 1:30am (America/New_York)', '2026-11-01T05:40:00Z'), '2026-11-01T06:30:00.000Z');
  assert.equal(at('Current session: 5% used · resets Feb 30 at 1am (America/New_York)', '2026-09-24T23:20:00Z'), null);
  assert.equal(at('Current session: 5% used · resets Mar 8 at 2:30am (America/New_York)', '2026-03-07T12:00:00Z'), null, '02:30 does not exist that night');
  assert.equal(at('Current session: 5% used · resets Mar 8 at 3:30am (America/New_York)', '2026-03-07T12:00:00Z'), '2026-03-08T07:30:00.000Z');
});

// Added after review round 2 (Sol 6 on 02781e9).

test('P27 any allowance line that cannot be read in full makes the reading unknown, a model\'s week included', () => {
  const base = 'Current session: 10% used · resets Sep 24 at 10:59pm (America/New_York)\nCurrent week (all models): 20% used · resets Sep 29 at 8:59pm (America/New_York)';
  assert.ok(parseClaudeUsage(base, NOW));
  for (const odd of ['Current week (Fable): 16% used · resets Sep 29 at 8:59pm (Weird Zone)', 'Current week (Fable): about a sixth used',
    'Current week (Sonnet 5): 3% used · resets Sep 29 at 8:59pm (America/New_York)', 'Current session: 120% used · resets 7pm (America/New_York)',
    'Current Week (Fable): cannot read', 'CURRENT SESSION: 5% used · resets 7pm (America/New_York)', '  current week (opus) - 3% used']) {
    assert.equal(parseClaudeUsage(`${base}\n${odd}`, NOW), null, odd);
  }
});

test('P28 a job limit that stated no reset is not permanent, and cached readings lift it at most once per wait (L13)', () => {
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: null });
  const room = [{ bucket: 'five_hour', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T02:59:00.000Z' },
    { bucket: 'seven_day', model: null, usedFraction: 0.2, resetsAt: '2026-09-30T00:59:00.000Z' }];
  t += 60_000;
  allowances.record('claude-a', room, new Date(t).toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a').state, 'exhausted', 'a cached copy of room right after the limit does not lift it');
  t = NOW.getTime() + RESETLESS_LIMIT_WAIT_MS;
  allowances.record('claude-a', room, new Date(t).toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a').state, 'ok', 'after the wait, a reading lifts it');
  allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: null });   // the next job hits it again
  t += 60_000;
  allowances.record('claude-a', room, new Date(t).toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a').state, 'exhausted', 'and again it waits: one job per wait, not one per reading');
  t += 60_000;
  allowances.record('claude-a', room, new Date(t).toISOString());
  assert.equal(allowances.view('claude-a').state, 'ok', 'a verified reading lifts it at once');
});

test('P29 a job\'s limit and a reading\'s hold on one bucket keep their own resets and rules: no over-hold', () => {
  let t = Date.parse('2026-09-24T20:00:00.000Z');
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  const reading = (used: number, reset: string) => [{ bucket: 'five_hour', model: null, usedFraction: used, resetsAt: reset },
    { bucket: 'seven_day', model: null, usedFraction: 0.2, resetsAt: '2026-09-30T00:59:00.000Z' }];
  allowances.record('claude-a', reading(1, '2026-09-24T23:00:00.000Z'), new Date(t).toISOString(), { verified: false });   // a reading: full until 23:00
  t += 60_000;
  allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: '2026-09-24T21:00:00.000Z' });   // a job: full until 21:00
  assert.equal(allowances.view('claude-a').state, 'exhausted');
  t = Date.parse('2026-09-24T21:30:00.000Z');   // the job's limit has passed its own reset
  allowances.record('claude-a', reading(0.3, '2026-09-25T02:00:00.000Z'), new Date(t).toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a').state, 'ok', 'the reading clears its own hold, and the lapsed job limit');
  // Before a job limit's reset, an unverified reading still cannot clear it.
  allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: '2026-09-25T02:00:00.000Z' });
  t += 60_000;
  allowances.record('claude-a', reading(0.3, '2026-09-25T02:00:00.000Z'), new Date(t).toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a').state, 'exhausted');
});

test('P30 Codex evidence is dated no later than the service was asked, never when the session ended', async () => {
  const cli = fake('codex', signedInCodex());
  const r = await probeAccount(codexAccount, opts({ cli: { codex: cli.path }, now: () => new Date() }));
  assert.ok(r.allowance.state === 'ok');
  const asked = Number(readFileSync(join(cli.path, '..', 'received-account_rateLimits_read'), 'utf8'));
  assert.ok(Date.parse(r.allowance.measuredAt) <= asked, `measured ${r.allowance.measuredAt} is not later than the request at ${new Date(asked).toISOString()}`);
  const read = Number(readFileSync(join(cli.path, '..', 'received-account_read'), 'utf8'));
  assert.ok(r.identity.state === 'signed-in' && Date.parse(r.identity.identity.observedAt) <= read, 'the login is dated no later than it was asked for');
});

// Added after review round 4 (Sol 6 on 2ba7d41).

test('P31 an allowance window the pipe does not know makes the reading unknown', () => {
  const base = 'Current session: 10% used · resets Sep 24 at 10:59pm (America/New_York)\nCurrent week (all models): 20% used · resets Sep 29 at 8:59pm (America/New_York)';
  assert.equal(parseClaudeUsage(`${base}\nCurrent month: cannot read`, NOW), null);
  assert.equal(parseClaudeUsage(`${base}\nCurrent month: 5% used · resets Oct 1 at 1am (America/New_York)`, NOW), null);
});

test('P32 a job limit whose stated reset had already passed is treated as resetless: cached readings wait before lifting it', () => {
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  const room = [{ bucket: 'five_hour', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T02:59:00.000Z' },
    { bucket: 'seven_day', model: null, usedFraction: 0.2, resetsAt: '2026-09-30T00:59:00.000Z' }];
  allowances.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: new Date(t - 60_000).toISOString() });
  t += 1_000;
  allowances.record('claude-a', room, new Date(t).toISOString(), { verified: false });
  assert.notEqual(allowances.view('claude-a').state, 'ok', 'a stale reset does not let a cached reading lift the limit at once');
  t = NOW.getTime() + RESETLESS_LIMIT_WAIT_MS;
  allowances.record('claude-a', room, new Date(t).toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a').state, 'ok');
});

test('P33 a limit of a type the pipe does not know stops the model that hit it, and a later week reading can clear it', () => {
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  const room = (usedFraction: number) => [{ bucket: 'five_hour', model: null, usedFraction, resetsAt: '2026-09-25T02:59:00.000Z' },
    { bucket: 'seven_day', model: null, usedFraction, resetsAt: '2026-09-30T00:59:00.000Z' }];
  allowances.record('claude-a', room(0.1), new Date(t).toISOString(), { verified: false });
  const reset = new Date(t + 60 * 60_000).toISOString();
  allowances.recordLimit('claude-a', { ...claudeLimitBucket('seven_day_other', 'claude-fable-5-1'), resetsAt: reset });
  assert.notEqual(allowances.view('claude-a', 'claude-fable-5-1').state, 'ok', 'the model that hit the limit cannot dispatch');
  assert.notEqual(allowances.view('claude-a', 'opus').state, 'ok', 'nor can another: the limit is account-wide');
  t += 61 * 60_000;
  allowances.record('claude-a', room(0.2), new Date(t).toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a', 'claude-fable-5-1').state, 'ok', 'a week reading after the stated reset clears it');
});

// Added after review round 6 (Sol 6 on 7b74a82).

test('P34 an ok allowance in a report that does not show the login signed in is not recorded', async () => {
  const cli = fake('claude', signedInClaude());
  const r = await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }));
  assert.equal(r.allowance.state, 'ok');
  for (const identity of [{ state: 'unknown', reason: 'timed out' }, { state: 'signed-out', identity: { accountId: 'claude-a', signedIn: false, fingerprint: null, observedAt: NOW.toISOString() }, reason: 'x' }]) {
    const l = ledgers();
    applyProbe({ ...r, identity } as ProbeReport, l);
    assert.equal(l.allowances.view('claude-a', 'opus').state, 'unknown', identity.state);
  }
});

test('P35 a limit is dated when the job saw it: a verified reading measured after that, recorded first, still counts', () => {
  let t = NOW.getTime();
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  const room = [{ bucket: 'primary:primary', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T02:59:00.000Z' }];
  const seen = new Date(t).toISOString();
  t += 60_000;
  allowances.record('codex-a', room, new Date(t).toISOString(), { verified: true });
  t += 1_000;
  allowances.recordLimit('codex-a', { bucket: 'primary:primary', model: null, resetsAt: '2026-09-25T02:59:00.000Z', observedAt: seen });
  assert.equal(allowances.view('codex-a').state, 'ok', 'the later verified reading outweighs the earlier limit');
  // Unverified, the same order keeps the hold: only a verified reading or the stated reset lifts a job's limit.
  const claude = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  claude.record('claude-a', [{ bucket: 'five_hour', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T02:59:00.000Z' }], new Date(t - 500).toISOString(), { verified: false });
  claude.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: '2026-09-25T02:59:00.000Z', observedAt: seen });
  assert.notEqual(claude.view('claude-a').state, 'ok');
  // A stamp later than the pipe's clock is not believed: the limit dates from now.
  const ahead = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t) });
  ahead.recordLimit('codex-a', { bucket: 'primary:primary', model: null, resetsAt: '2026-09-25T02:59:00.000Z', observedAt: new Date(t + 3_600_000).toISOString() });
  ahead.record('codex-a', room, new Date(t + 1).toISOString(), { verified: true });
  assert.notEqual(ahead.view('codex-a').state, 'ok', 'a reading measured before now does not clear a limit dated now');
});

test('P36 a window not yet started states no reset: read as a bucket with none (live /usage, 2026-09-25)', () => {
  const live = 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 0% used\nCurrent week (all models): 100% used · resets Sep 26 at 10pm (America/New_York)\nCurrent week (Fable): 100% used · resets Sep 26 at 10pm (America/New_York)\n\nWhat\'s contributing to your limits usage?';
  const r = parseClaudeUsage(live, NOW);
  assert.ok(r, 'readable');
  assert.deepEqual(r.find((b) => b.bucket === 'five_hour'), { bucket: 'five_hour', model: null, usedFraction: 0, resetsAt: null });
  assert.equal(r.length, 3);
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => NOW });
  allowances.record('claude-a', r, NOW.toISOString(), { verified: false });
  assert.equal(allowances.view('claude-a', 'opus').state, 'exhausted', 'the full week still binds');
  assert.equal(parseClaudeUsage('Current session: 0% used · resets', NOW), null, 'a reset half-stated is unreadable');
});

test('P37 a page with the week but no session line reads as a session not yet started (live /usage)', () => {
  const live = 'You are currently using your subscription to power your Claude Code usage\n\nCurrent week (all models): 48% used · resets Nov 2 at 7pm (America/New_York)\nCurrent week (Fable): 19% used · resets Nov 2 at 7pm (America/New_York)\n\nWhat\'s contributing to your limits usage?';
  const r = parseClaudeUsage(live, new Date('2026-10-31T21:04:00Z'));
  assert.ok(r, 'readable');
  assert.deepEqual(r.find((b) => b.bucket === 'five_hour'), { bucket: 'five_hour', model: null, usedFraction: 0, resetsAt: null });
  assert.equal(r.find((b) => b.bucket === 'seven_day' && b.model === null)?.usedFraction, 0.48);
  assert.equal(r.length, 3);
  const allowances = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date('2026-10-31T21:04:00Z') });
  allowances.record('claude-a', r, '2026-10-31T21:04:00.000Z', { verified: false });
  assert.equal(allowances.view('claude-a', 'opus').state, 'ok', 'a healthy seat stays in the pool');
  // No week line, or only a per-model week, is still no verdict: the session is never invented without the week.
  for (const page of ['Current week (Fable): 19% used · resets Nov 2 at 7pm (America/New_York)', 'You are currently using your subscription', ''])
    assert.equal(parseClaudeUsage(page, NOW)?.some((b) => b.bucket === 'five_hour') ?? false, false, page);
  // A session line that is present keeps its own reading.
  const both = parseClaudeUsage(`Current session: 40% used · resets 7:10pm (America/New_York)\n${live}`, NOW);
  assert.equal(both?.filter((b) => b.bucket === 'five_hour').length, 1);
  assert.equal(both?.find((b) => b.bucket === 'five_hour')?.usedFraction, 0.4);
});

test('P38 a page with no session line still lets a job\'s own limit hold, and a per-model session line stays unknown', async () => {
  const t = Date.parse('2026-11-01T12:00:00Z');
  const page = 'Current week (all models): 48% used · resets Nov 2 at 7pm (America/New_York)';
  const at = (ms: number) => new Date(t + ms).toISOString();
  // A job hit a limit with a stated reset an hour out. A reading with no session line taken after the resetless wait
  // (35 min) but before the reset does not lift it: only the stated reset explains the hold; after it, the reading counts.
  const stated = (after: number) => {
    const l = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t + after) });
    l.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: at(3_600_000), observedAt: at(0) });
    l.record('claude-a', parseClaudeUsage(page, new Date(t + after))!, at(after), { verified: false });
    return l.view('claude-a', 'opus').state;
  };
  assert.equal(stated(RESETLESS_LIMIT_WAIT_MS + 5 * 60_000), 'exhausted', 'a stated reset still holds');
  assert.equal(stated(3_660_000), 'ok', 'after the stated reset, the reading counts');
  // A limit that stated no reset waits RESETLESS_LIMIT_WAIT_MS before a reading may lift it.
  const resetless = (after: number) => {
    const l = new AllowanceLedger({ freshnessMs: 15 * 60_000, now: () => new Date(t + after) });
    l.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: null, observedAt: at(0) });
    l.record('claude-a', parseClaudeUsage(page, new Date(t + after))!, at(after), { verified: false });
    return l.view('claude-a', 'opus').state;
  };
  assert.equal(resetless(600_000), 'exhausted', 'too soon after a resetless limit');
  assert.equal(resetless(RESETLESS_LIMIT_WAIT_MS + 60_000), 'ok', 'after the wait, the reading counts');
  // A per-model session line is not the account's own session: the whole page reads unknown, nothing is assumed.
  // The control, the same line without the model, reads ok: the model qualifier is what makes it unknown.
  const base = fixture('claude-usage.signed-in').stdout;
  for (const [session, state] of [['Current session (Fable)', 'unknown'], ['Current session', 'ok']]) {
    const cli = fake('claude', { ...signedInClaude(), usage: { stdout: { ...base, result: `${session}: 5% used · resets 7pm (America/New_York)\n${page}` }, exit: 0 } });
    assert.equal((await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }))).allowance.state, state, session);
  }
});

test('P39 an Ultra subscription is a subscription login (the plan renamed from Max 20x, 2026-10-30)', async () => {
  const stdout = { ...fixture('claude-auth-status.signed-in').stdout, subscriptionType: 'ultra' };
  const cli = fake('claude', { ...signedInClaude(), auth: { stdout, exit: 0 } });
  assert.equal((await probeAccount(claudeAccount, opts({ cli: { claude: cli.path } }))).identity.state, 'signed-in');
});

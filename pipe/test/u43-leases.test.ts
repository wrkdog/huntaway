import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { availability } from '../src/availability.ts';
import { startHttp } from '../src/http.ts';
import type { AccountConfig } from '../src/identity.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import { startPipe } from '../src/service.ts';
import { Store, type DispatchEvidence, type NewRequest } from '../src/store.ts';

const NOW = Date.parse('2026-10-28T12:00:00Z'), TOKEN = 'u43-fixture-token'.repeat(3);
const POLICY = { claude: { models: { opus: 'default' as const }, efforts: ['high'] } };
const account = (id = 'a', maxConcurrency = 2): AccountConfig => ({ id, provider: 'claude', enabled: true,
  loginDir: `/fixture/${id}`, fingerprint: 'abcd1234', maxConcurrency });
const input = { holder: 'WrkDog lane lead (A)/owner@example.org', ttlSeconds: 60, purpose: 'lane lead' };
const request = (extra = {}): NewRequest => ({ requester: 'fixture', project: 'pipe', kind: 'chat', provider: 'claude',
  model: 'opus', effort: 'high', reason: 'lease acceptance test', prompt: 'OK', priority: 'interactive', mutating: false, ...extra });
const evidence = (id: string, now = NOW): DispatchEvidence => ({ accountId: id, model: 'opus',
  observedAt: new Date(now).toISOString(), verdict: { state: 'available', headroom: .5 }, grant: [] });
function fixture(t: TestContext, heartbeat = true) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u43-')), path = join(root, 'record.sqlite');
  let time = NOW, store = new Store(path, { now: () => new Date(time) });
  if (heartbeat) store.sweepExpiredLeases();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, get store() { return store; }, now: () => new Date(time), advance: (ms: number) => { time += ms; },
    reopen: () => { store.close(); store = new Store(path, { now: () => new Date(time) }); } };
}

// Real HTTP handlers, with only the loopback listener replaced for the builder sandbox.
function transport(t: TestContext) {
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  const original = http.createServer;
  http.createServer = ((cb: typeof handler) => {
    handler = cb;
    return Object.assign(new EventEmitter(), { listen(_p: number, _h: string, ready: () => void) { ready(); },
      address: () => ({ port: 12345 }), close(done: () => void) { done(); }, closeAllConnections() {} });
  }) as typeof http.createServer;
  syncBuiltinESMExports();
  t.after(() => { http.createServer = original; syncBuiltinESMExports(); });
  return (method: string, path: string, body?: unknown, token = TOKEN, headers?: Record<string, string>) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP did not answer')), 5000);
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = Object.assign(Readable.from(text === undefined ? [] : [Buffer.from(text)]), { method, url: path,
      headers: headers ?? { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(text === undefined ? {} : { 'content-length': String(Buffer.byteLength(text)) }) } });
    let status = 0;
    handler(req as IncomingMessage, { writeHead(code: number) { status = code; }, end(answer: string) {
      clearTimeout(timer); resolve({ status, json: JSON.parse(answer) });
    } } as unknown as ServerResponse);
  });
}
async function api(t: TestContext) {
  const f = fixture(t), call = transport(t), accounts = [account(), account('disabled'), account('single', 1)];
  accounts[1]!.enabled = false;
  await startHttp({ token: TOKEN, store: f.store, policy: POLICY, accounts: () => [], models: () => ({}),
    accountIds: () => accounts.map(a => a.id), draining: () => true, drain: async () => {}, cancel() {},
    leaseAccount: (id: string) => { const a = accounts.find(a => a.id === id); return a ? { account: a, headroom: .5 } : undefined; } });
  return { ...f, call, accounts };
}

test('L1 take, renew, list and idempotent release use the store clock; expiry cannot revive', async t => {
  const f = await api(t);
  const made = await f.call('POST', '/v1/leases', { ...input, account: 'a' });
  assert.equal(made.status, 201); const lease = made.json.lease;
  assert.equal(lease.accountId, 'a'); assert.equal(lease.holder, input.holder);
  assert.equal(lease.createdAt, new Date(NOW).toISOString()); assert.equal(lease.headroomAtStart, .5);
  assert.equal(lease.expiresAt, new Date(NOW + 60_000).toISOString());
  assert.deepEqual((await f.call('GET', '/v1/leases')).json.leases, [lease]);
  assert.equal(f.store.activeLeaseCount('a'), 1);
  f.advance(30_000); f.store.sweepExpiredLeases();
  const renewed = await f.call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 120 });
  assert.equal(renewed.status, 200); assert.equal(renewed.json.lease.expiresAt, new Date(NOW + 150_000).toISOString());
  assert.equal(renewed.json.lease.renewedAt, new Date(NOW + 30_000).toISOString());
  assert.equal(renewed.json.lease.createdAt, lease.createdAt);
  const released = await f.call('POST', `/v1/leases/${lease.id}/release`);
  assert.equal(released.status, 200);
  f.advance(1000);
  assert.deepEqual((await f.call('POST', `/v1/leases/${lease.id}/release`)).json, released.json);
  assert.equal((await f.call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 60 })).status, 410);
  assert.equal(f.store.activeLeaseCount('a'), 0);
  const next = (await f.call('POST', '/v1/leases', { ...input, account: 'a' })).json.lease;
  f.advance(60_000);
  assert.equal(f.store.activeLeaseCount('a'), 1, 'exact expiry retains grace load');
  assert.deepEqual((await f.call('GET', '/v1/leases')).json.leases, []);
  f.store.sweepExpiredLeases();
  assert.equal((await f.call('POST', `/v1/leases/${next.id}/renew`, { ttlSeconds: 60 })).status, 410);
  assert.equal((await f.call('POST', '/v1/leases/missing/renew', { ttlSeconds: 60 })).status, 404);
  assert.equal((await f.call('POST', '/v1/leases/missing/release')).status, 404);
});

test('L2 leases count in placement and atomic claims, then released capacity takes work again', t => {
  const f = fixture(t), a = account(), b = account('b');
  const lease = f.store.takeLease(a, input);
  const running = f.store.startAttempt(f.store.submit(request()).id, a, evidence('a'));
  assert.ok(running.ok);
  const statuses = (): AccountStatus[] => [a, b].map(account => ({ account, running: f.store.runningCount(account.id),
    leased: f.store.activeLeaseCount(account.id), evidence: () => evidence(account.id) }));
  const pick = (r: ReturnType<Store['submit']>) => plan([r], statuses(), { now: f.now(), pinWaitMs: 60_000,
    evidenceMaxAgeMs: 60_000, load: f.store.requesterLoad() });
  const r = f.store.submit(request());
  assert.equal(pick(r).dispatch[0]?.accountId, 'b');
  assert.equal(f.store.startAttempt(r.id, a, evidence('a')).ok, false, 'claim checks leases even with an available verdict');
  const pinned = f.store.submit(request({ pin: 'a' }));
  assert.match(pick(pinned).waits[0]!.reason, /is busy \(1 running, 1 leased, 2\/2\)/);
  assert.equal(f.store.runningCount('a'), 1, 'running remains jobs only');
  const onB = f.store.startAttempt(f.store.submit(request()).id, b, evidence('b')); assert.ok(onB.ok);
  f.store.releaseLease(lease.id);
  assert.equal(pick(r).dispatch[0]?.accountId, 'a', 'equal job load returns to stable id order');
  assert.ok(f.store.startAttempt(r.id, a, evidence('a')).ok);
});

test('L3 availability reports jobs and leased count separately, and planner retains it in busy text', t => {
  const f = fixture(t), a = account();
  const verdict = availability({ account: a, identities: { view: () => ({ accountId: 'a', signedIn: true,
    fingerprint: a.fingerprint, observedAt: f.now().toISOString() }) }, allowances: { view: () => ({ accountId: 'a', state: 'ok', headroom: .5, binding: 'weekly' }) },
    running: 1, leased: 1, now: f.now(), identityMaxAgeMs: 60_000 });
  assert.deepEqual(verdict, { state: 'busy', running: 1, max: 2, leased: 1 });
  const r = f.store.submit(request({ pin: 'a' }));
  const result = plan([r], [{ account: a, running: 1, leased: 1, evidence: () => ({ ...evidence('a'), verdict }) }],
    { now: f.now(), pinWaitMs: 60_000, evidenceMaxAgeMs: 60_000, load: new Map() });
  assert.match(result.waits[0]!.reason, /is busy \(1 running, 1 leased, 2\/2\)/);
});

test('L4 validation, auth and the reserved pipe slot hold, including while draining', async t => {
  const f = await api(t);
  for (const extra of [{ account: 'missing' }, { account: 'disabled' }, { holder: '' }, { holder: 'x'.repeat(81) },
    { holder: 'bad\nname' }, { holder: 'lane\n' }, { holder: 'lane\r' }, { holder: '💥' }, { ttlSeconds: 59 }, { ttlSeconds: 3601 }, { ttlSeconds: 60.5 }, { ttlSeconds: '60' },
    { purpose: 'x'.repeat(201) }, { purpose: 'x\u0000y' }, { purpose: 'x\u007fy' }, { purpose: 1 }]) {
    const result = await f.call('POST', '/v1/leases', { ...input, account: 'a', ...extra });
    assert.equal(result.status, 400, JSON.stringify(extra));
  }
  for (const [method, path, body] of [['GET', '/v1/leases'], ['POST', '/v1/leases', { ...input, account: 'a' }],
    ['POST', '/v1/leases/missing/renew', { ttlSeconds: 60 }], ['POST', '/v1/leases/missing/release']] as const)
    assert.equal((await f.call(method, path, body, 'wrong')).status, 401);
  const first = await f.call('POST', '/v1/leases', { ...input, account: 'a' }); assert.equal(first.status, 201);
  for (const account of ['a', 'single']) {
    const full = await f.call('POST', '/v1/leases', { ...input, account });
    assert.equal(full.status, 409); assert.equal(full.json.error.code, 'lease_limit');
  }
  for (const ttlSeconds of [undefined, 59, 3601, '60', null])
    assert.equal((await f.call('POST', `/v1/leases/${first.json.lease.id}/renew`, { ttlSeconds })).status, 400);
  assert.equal((await f.call('POST', '/v1/leases', [])).status, 400);
  assert.equal((await f.call('POST', '/v1/leases/%zz/renew', { ttlSeconds: 60 })).status, 400);
});

test('L5 leases survive reopen; an old record gains the table without changing its jobs', t => {
  const f = fixture(t), r = f.store.submit(request());
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE IF EXISTS leases'); db.close();
  f.reopen();
  const upgraded = new DatabaseSync(f.path);
  assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'leases'").get()); upgraded.close();
  assert.equal(f.store.get(r.id)!.state, 'queued');
  f.store.sweepExpiredLeases();
  const lease = f.store.takeLease(account(), input);
  f.reopen(); assert.deepEqual(f.store.activeLeases(), [lease]);
  f.advance(60_000); f.reopen(); assert.equal(f.store.activeLeaseCount('a'), 1);
  f.store.sweepExpiredLeases();
  assert.throws(() => f.store.renewLease(lease.id, 60, () => account()), (e: any) => e.status === 410);
});

test('L6 real service accounts expose leases and jobs separately; leases work during drain', async t => {
  const f = fixture(t), call = transport(t), loginDir = join(f.root, 'login'); mkdirSync(loginDir);
  const service = await startPipe({ accounts: [{ ...account(), loginDir }], policy: POLICY, token: TOKEN, cli: {},
    env: { PATH: '' }, storePath: join(f.root, 'service.sqlite'), worktreeRoot: join(f.root, 'worktrees'),
    reachable: async () => false, tickMs: 100, minFreeGb: 0 });
  t.after(() => service.stop());
  assert.equal((await call('POST', '/v1/drain')).status, 200);
  const made = await call('POST', '/v1/leases', { ...input, account: 'a' }); assert.equal(made.status, 201);
  const a = (await call('GET', '/v1/accounts')).json.accounts[0];
  assert.equal(a.running, 0);
  assert.deepEqual(a.leases, [{ id: made.json.lease.id, holder: input.holder, purpose: input.purpose,
    since: made.json.lease.createdAt, expiresAt: made.json.lease.expiresAt, headroomAtStart: null }]);
  assert.equal((await call('POST', `/v1/leases/${made.json.lease.id}/renew`, { ttlSeconds: 3600 })).status, 200);
  assert.equal((await call('GET', '/v1/leases')).json.leases.length, 1);
  assert.equal((await call('POST', `/v1/leases/${made.json.lease.id}/release`)).status, 200);
  assert.deepEqual((await call('GET', '/v1/accounts')).json.accounts[0].leases, []);
  const db = new DatabaseSync(join(f.root, 'service.sqlite'));
  db.prepare('UPDATE clock SET last = ?').run(Date.now() + 60_000); db.close();
  const behind = await call('GET', '/v1/accounts'); assert.equal(behind.status, 200);
  assert.equal(behind.json.accounts[0].leases, null, 'uncertain time does not hide the accounts or claim active leases');
  assert.equal((await call('GET', '/v1/leases')).status, 503);
});

test('L8 an expiry refusal retains its clock proof across reopen and a backward clock', t => {
  const f = fixture(t), lease = f.store.takeLease(account(), input);
  f.advance(59_000); f.store.sweepExpiredLeases(); f.advance(1000);
  assert.throws(() => f.store.renewLease(lease.id, 60, () => account()), (e: any) => e.status === 410);
  f.reopen(); f.advance(-60_000);
  assert.throws(() => f.store.renewLease(lease.id, 60, () => account()), (e: any) => e.status === 503, 'a failed renewal cannot forget observing expiry');
  // Round 2 contract: lease reads never throw on clock state; with the clock behind they count every unreleased lease.
  assert.equal(f.store.activeLeaseCount('a'), 1, 'an uncertain clock fails closed for capacity');
});

test('L11 lease reads use the supplied instant without advancing the clock high-water mark', t => {
  const f = fixture(t), lease = f.store.takeLease(account(), input);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  const before = db.prepare('SELECT last FROM clock').get()!.last;
  const later = new Date(NOW + 120_000);
  assert.equal(f.store.activeLeaseCount('a', later), 1);
  assert.equal(db.prepare('SELECT last FROM clock').get()!.last, before);
  assert.deepEqual(f.store.activeLeases(undefined, later), []);
  assert.equal(db.prepare('SELECT last FROM clock').get()!.last, before);
  assert.equal(f.store.clockIsCurrent(), true);
  assert.deepEqual(f.store.activeLeases('a'), [lease]);
});

test('L12 uncertain lease reads count all unreleased rows without changing the clock high-water mark', t => {
  const f = fixture(t), a = account('a', 3);
  const lease = f.store.takeLease(a, input), released = f.store.takeLease(a, input);
  f.store.releaseLease(released.id);
  const other = f.store.takeLease(account('b'), input);
  f.advance(90_000);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  const mark = NOW + 120_000;
  db.prepare('UPDATE clock SET last = ?').run(mark);
  for (const at of [undefined, new Date(NaN), new Date(Date.parse('0000-01-01T00:00:00Z') - 1),
    new Date(Date.parse('9999-12-31T23:59:59.999Z') + 1)]) {
    assert.equal(f.store.activeLeaseCount('a', at), 1);
    assert.equal(f.store.activeLeaseCount('b', at), 1);
    assert.equal(f.store.activeLeaseCount('missing', at), 0);
    assert.deepEqual(f.store.activeLeases('a', at), [lease]);
    assert.deepEqual(f.store.activeLeases(undefined, at).map(l => l.id).sort(), [lease.id, other.id].sort());
    assert.equal(db.prepare('SELECT last FROM clock').get()!.last, mark);
  }
});

test('L9 automatic claims refresh lease load instead of trusting a stale planning snapshot', t => {
  const f = fixture(t), a = { ...account(), provider: 'codex' as const }, b = { ...account('b'), provider: 'codex' as const };
  f.store.takeLease(a, input);
  const ask = request({ provider: 'codex', model: 'gpt-6.1-sol' });
  const proof = (id: string) => ({ ...evidence(id), model: ask.model, allowanceObservedAt: f.now().toISOString() });
  assert.ok(f.store.startAttempt(f.store.submit(ask).id, a, proof('a')).ok);
  const r = f.store.submit({ ...ask, placement: 'ordinary_headroom', automatic: { reviewReserve: .1,
    fallback: { provider: 'claude', model: 'opus', effort: 'high', reason: 'authorized fallback' } } });
  const result = f.store.startAutomatic(r.id, [a, b].map(account => ({ account, running: 0, leased: 0, evidence: () => proof(account.id) })),
    { ...POLICY, codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['high'] } }, []);
  assert.ok(result.ok); assert.equal(result.attempt.accountId, 'b');
});

test('L10 housekeeping retains inactive leases seven days and preserves active records', t => {
  const f = fixture(t), a = account('a', 3), expired = f.store.takeLease(a, input);
  const released = f.store.takeLease(a, { ...input, ttlSeconds: 3600 }); f.store.releaseLease(released.id);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  const exists = (id: string) => !!db.prepare('SELECT 1 FROM leases WHERE id = ?').get(id);
  f.advance(7 * 86_400_000 - 1); f.store.pruneLeases();
  assert.ok(exists(expired.id)); assert.ok(exists(released.id));
  f.advance(1); f.store.pruneLeases(); assert.equal(exists(released.id), false); assert.ok(exists(expired.id));
  f.store.sweepExpiredLeases();
  const active = f.store.takeLease(a, { ...input, ttlSeconds: 3600 });
  f.advance(60_000); f.store.pruneLeases(); assert.equal(exists(expired.id), false); assert.ok(exists(active.id));
  assert.equal(f.store.activeLeaseCount('a'), 1); assert.equal(f.store.activeLeaseCount('other-account'), 0);
});

function cli(args: string[], network = false) {
  const preload = `import { registerHooks } from 'node:module';
    registerHooks({load(url, context, next) { if (url.endsWith('/src/service.ts')) return {format:'module',shortCircuit:true,
      source:'export const startPipe = () => {}; export const recoverFailedStop = () => {}; export const resolveCli = x => x;'};
      return next(url, context); }});
    globalThis.fetch = async (url, init) => new Response(JSON.stringify({method:init.method,path:new URL(url).pathname,body:init.body ? JSON.parse(init.body) : null}));`;
  const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'src/cli.ts', ...args],
    { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', ...(network ? { PIPE_URL: 'http://127.0.0.1:12345', PIPE_TOKEN: TOKEN } : {}) } });
  assert.equal(r.error, undefined); return r;
}
test('L7 lease CLI JSON, escaped IDs, defaults, help, dry-run and usage errors', () => {
  const cases = [
    [['lease', 'take', 'a', '--holder', '-lane', '--ttl', '60', '--purpose', 'lane lead'], { method: 'POST', path: '/v1/leases', body: { account: 'a', holder: '-lane', ttlSeconds: 60, purpose: 'lane lead' } }],
    [['lease', 'renew', 'a/b'], { method: 'POST', path: '/v1/leases/a%2Fb/renew', body: { ttlSeconds: 300 } }],
    [['lease', 'renew', 'a/b', '--ttl', '3600'], { method: 'POST', path: '/v1/leases/a%2Fb/renew', body: { ttlSeconds: 3600 } }],
    [['lease', 'release', 'a/b'], { method: 'POST', path: '/v1/leases/a%2Fb/release', body: null }],
  ] as const;
  for (const [args, expected] of cases) {
    const dry = cli([...args, '--dry-run']); assert.equal(dry.status, 0, dry.stderr); assert.deepEqual(JSON.parse(dry.stdout), expected);
    const live = cli([...args], true); assert.equal(live.status, 0, live.stderr); assert.deepEqual(JSON.parse(live.stdout), expected);
  }
  const list = cli(['leases'], true); assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), { method: 'GET', path: '/v1/leases', body: null });
  for (const args of [['lease', 'take'], ['lease', 'renew'], ['lease', 'release'], ['leases']]) {
    const help = cli([...args, '--config', '/missing', '--unknown', '--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Usage: pipe/);
  }
  for (const args of [['lease'], ['lease', 'missing', 'x'], ['lease', 'take', 'a'], ['lease', 'take', 'a', '--holder', 'lane'],
    ['lease', 'renew', 'id', '--ttl', 'bad'], ['lease', 'release', 'id', 'stray'], ['lease', 'release', 'id', '--ttl', '60'],
    ['lease', 'renew', 'id', '--ttl', '60', '--ttl', '60'], ['lease', '--unknown'], ['leases', 'stray']]) {
    const r = cli([...args, '--config', '/missing']); assert.equal(r.status, 2, r.stderr); assert.equal(r.stdout, '');
  }
});

test('L13 take refuses jobs-first capacity and a final-slot claim from another connection', async t => {
  const f = await api(t), a = account();
  assert.ok(f.store.startAttempt(f.store.submit(request()).id, a, evidence('a')).ok);
  const other = new Store(f.path, { now: f.now }); t.after(() => other.close());
  assert.equal(f.store.runningCount('a'), 1, 'a preflight could see room');
  assert.ok(other.startAttempt(other.submit(request()).id, a, evidence('a')).ok);
  const result = await f.call('POST', '/v1/leases', { ...input, account: 'a' });
  assert.equal(result.status, 409);
  assert.deepEqual(result.json.error, { code: 'account_full', message: 'account has no free concurrency slot' });
  assert.equal(f.store.activeLeaseCount('a'), 0);
});

for (const reopen of [false, true]) test(`L14 a read then sweep permanently expires a lease, reopen=${reopen}`, t => {
  const f = fixture(t), lease = f.store.takeLease(account(), input);
  f.advance(60_000);
  assert.deepEqual(f.store.activeLeases(), [], 'read observes expiry');
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  assert.equal(db.prepare('SELECT last FROM clock').get()!.last, NOW, 'read stays pure');
  f.store.sweepExpiredLeases();
  assert.equal(db.prepare('SELECT last FROM clock').get()!.last, NOW + 60_000);
  assert.deepEqual({ ...db.prepare('SELECT released_at, ended FROM leases WHERE id = ?').get(lease.id) },
    { released_at: new Date(NOW + 60_000).toISOString(), ended: 'expired' });
  if (reopen) f.reopen();
  f.advance(-30_000);
  assert.throws(() => f.store.renewLease(lease.id, 60, () => account()), (e: any) => e.status === 503);
  assert.throws(() => f.store.sweepExpiredLeases(), (e: any) => e.status === 503);
  f.advance(30_000); f.store.sweepExpiredLeases();
  assert.throws(() => f.store.renewLease(lease.id, 60, () => account()), (e: any) => e.status === 410);
});

for (const reopen of [false, true]) test(`L15 renew inside the final tick before expiry is refused, reopen=${reopen}`, t => {
  const f = fixture(t), lease = f.store.takeLease(account(), input);
  if (reopen) f.reopen();
  f.advance(59_000); f.store.sweepExpiredLeases(); // the last heartbeat before expiry
  f.advance(1000); assert.deepEqual(f.store.activeLeases(), []);
  f.advance(-500);
  assert.equal(f.store.clockIsCurrent(), true);
  assert.throws(() => f.store.renewLease(lease.id, 60), (e: any) => e.status === 410 && e.code === 'lease_inactive');
});

test('L16 swept expiry retains capacity until the exact grace boundary; explicit release has none', t => {
  const f = fixture(t), a = account(), lease = f.store.takeLease(a, input);
  f.advance(60_000); f.store.sweepExpiredLeases();
  assert.deepEqual(f.store.activeLeases(), []);
  f.reopen();
  const claim = () => f.store.startAttempt(f.store.submit(request()).id, a, evidence('a', f.now().getTime()));
  assert.ok(claim().ok);
  f.advance(59_999); f.store.sweepExpiredLeases(); assert.equal(f.store.activeLeaseCount('a'), 1);
  assert.equal(claim().ok, false);
  assert.throws(() => f.store.takeLease(a, input), (e: any) => e.code === 'lease_limit');
  assert.throws(() => f.store.renewLease(lease.id, 60, () => a), (e: any) => e.status === 410);
  f.advance(1); assert.equal(f.store.activeLeaseCount('a'), 0);
  assert.ok(claim().ok);
  const b = account('b'), explicit = f.store.takeLease(b, input); f.store.releaseLease(explicit.id);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  assert.equal(db.prepare('SELECT ended FROM leases WHERE id = ?').get(explicit.id)!.ended, 'released');
  assert.equal(f.store.activeLeaseCount('b'), 0);
});

test('L17 renewal rechecks disabled accounts and a lowered lease cap', async t => {
  const f = await api(t), a = f.accounts[0]!; a.maxConcurrency = 3;
  const leases: { id: string }[] = [];
  for (let i = 0; i < 2; i++) leases.push((await f.call('POST', '/v1/leases', { ...input, account: 'a' })).json.lease);
  const renew = () => f.call('POST', `/v1/leases/${leases[0]!.id}/renew`, { ttlSeconds: 60 });
  a.enabled = false;
  const disabled = await renew(); assert.equal(disabled.status, 409); assert.equal(disabled.json.error.code, 'account_unavailable');
  a.enabled = true; a.maxConcurrency = 2;
  const lowered = await renew(); assert.equal(lowered.status, 409); assert.equal(lowered.json.error.code, 'account_unavailable');
  await f.call('POST', `/v1/leases/${leases[1]!.id}/release`);
  assert.equal((await renew()).status, 200);
});

test('L18 purposes count code points and reject lone surrogates and Unicode format characters', async t => {
  const f = await api(t);
  for (const purpose of ['\ud800', '\udfff', 'x\ud800y', 'x\u200by', 'x\u202ey', 'x\u2066y', '\ufeff', '💥'.repeat(201)])
    assert.equal((await f.call('POST', '/v1/leases', { ...input, account: 'a', purpose })).status, 400, JSON.stringify(purpose));
  const accepted = await f.call('POST', '/v1/leases', { ...input, account: 'a', purpose: '💥'.repeat(200) });
  assert.equal(accepted.status, 201);
});

test('L19 busy verdict wait text uses jobs plus leases without double counting', t => {
  const f = fixture(t), a = account(), r = f.store.submit(request({ pin: 'a' }));
  const result = plan([r], [{ account: a, running: 1, leased: 1, evidence: () => ({ ...evidence('a'),
    verdict: { state: 'busy', running: 1, leased: 1, max: 2 } }) }],
    { now: f.now(), pinWaitMs: 60_000, evidenceMaxAgeMs: 60_000, load: new Map() });
  assert.match(result.waits[0]!.reason, /is busy \(1 running, 1 leased, 2\/2\)/);
});

for (const behind of [true, false]) test(`L20 lease pruning cannot gate worktree pruning, behind=${behind}`, async t => {
  const f = fixture(t), call = transport(t), repo = join(f.root, 'repo'), trees = join(f.root, 'trees');
  mkdirSync(repo); mkdirSync(trees);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@localhost');
  writeFileSync(join(repo, 'seed'), 'seed\n'); git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'seed');
  const path = join(f.root, 'service.sqlite'), seed = new Store(path), a = { ...account(), loginDir: f.root };
  const r = seed.submit(request({ mutating: true, kind: 'code', cwd: repo }));
  const started = seed.startAttempt(r.id, a, evidence('a', Date.now())); assert.ok(started.ok);
  const worktree = join(trees, r.id), branch = `pipe/${r.id}`, commit = git('rev-parse', 'HEAD');
  git('worktree', 'add', '-b', branch, worktree);
  seed.finishAttempt(started.attempt.id, { kind: 'completed', result: 'done', workspace: { path: worktree, branch, commit, startCommit: commit } });
  seed.close();
  const logs: string[] = [];
  t.mock.method(process.stderr, 'write', (...args: unknown[]) => { logs.push(String(args[0])); return true; });
  const service = await startPipe({ accounts: [a], policy: POLICY, token: TOKEN, cli: {}, env: { PATH: process.env.PATH },
    storePath: path, worktreeRoot: trees, worktreeKeepHours: 0, reachable: async () => false, tickMs: 100, minFreeGb: 0 });
  t.after(() => service.stop());
  const db = new DatabaseSync(path); t.after(() => db.close());
  if (behind) db.prepare('UPDATE clock SET last = ?').run(Date.now() + 60_000);
  else db.exec('DROP TABLE leases');
  const result = await call('POST', '/v1/worktrees/prune');
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(existsSync(worktree), false, 'worktree is pruned despite unavailable lease housekeeping');
  if (!behind) assert.ok(logs.some(line => line.includes('pipe lease prune:')));
});

test('L21 the real service tick sweeps expired leases while draining and never with a backward clock', async t => {
  const f = fixture(t), call = transport(t), path = join(f.root, 'service.sqlite');
  const service = await startPipe({ accounts: [{ ...account(), loginDir: f.root }], policy: POLICY, token: TOKEN, cli: {},
    env: { PATH: '' }, storePath: path, worktreeRoot: join(f.root, 'trees'), reachable: async () => false, tickMs: 10, minFreeGb: 0 });
  t.after(() => service.stop());
  await call('POST', '/v1/drain');
  const made = await call('POST', '/v1/leases', { ...input, account: 'a' }); assert.equal(made.status, 201);
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.prepare('UPDATE leases SET expires_at = ?').run(Date.now() - 1);
  const mark = Date.now() + 60_000; db.prepare('UPDATE clock SET last = ?').run(mark);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(db.prepare('SELECT released_at FROM leases').get()!.released_at, null);
  assert.equal(db.prepare('SELECT last FROM clock').get()!.last, mark);
  db.prepare('UPDATE clock SET last = ?').run(Date.now());
  for (let i = 0; i < 100 && db.prepare('SELECT ended FROM leases').get()!.ended !== 'expired'; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(db.prepare('SELECT ended FROM leases').get()!.ended, 'expired');
});

test('L22 real CLI lease renew sends JSON Content-Type to the real HTTP server', async t => {
  const f = fixture(t), a = account(), lease = f.store.takeLease(a, input);
  const started = await startHttp({ token: TOKEN, store: f.store, policy: POLICY, accounts: () => [], models: () => ({}),
    accountIds: () => ['a'], draining: () => false, drain: async () => {}, cancel() {}, leaseAccount: () => ({ account: a, headroom: .5 }) })
    .catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EPERM') throw e; t.skip('sandbox refuses loopback listeners'); return null; });
  if (!started) return;
  const { server, url } = started;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  let contentType: string | undefined;
  server.prependListener('request', req => { contentType = req.headers['content-type']; });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.ts', 'lease', 'renew', lease.id, '--ttl', '120'],
      { env: { PATH: process.env.PATH, PIPE_URL: url, PIPE_TOKEN: TOKEN, NODE_NO_WARNINGS: '1' }, timeout: 5000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(contentType, 'application/json');
  assert.equal(JSON.parse(result.stdout).lease.expiresAt, new Date(NOW + 120_000).toISOString());
});


test('L23 reopening a pre-ended lease table migrates explicit releases without losing jobs or leases', t => {
  const f = fixture(t), a = account('a', 3), live = f.store.takeLease(a, input), released = f.store.takeLease(a, input);
  f.store.releaseLease(released.id);
  const r = f.store.submit(request());
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.exec('ALTER TABLE leases DROP COLUMN ended');
  f.reopen();
  assert.deepEqual(f.store.activeLeases(), [live]);
  assert.equal(db.prepare('SELECT ended FROM leases WHERE id = ?').get(released.id)!.ended, 'released');
  assert.equal(f.store.get(r.id)!.state, 'queued');
});


test('L24 real CLI JSON headers are accepted by the real HTTP handlers without a listener', async t => {
  const f = await api(t), made = await f.call('POST', '/v1/leases', { ...input, account: 'a' });
  const preload = `globalThis.fetch = async (url, init) => new Response(JSON.stringify({
    method:init.method,path:new URL(url).pathname,headers:init.headers,body:JSON.parse(init.body)}));`;
  const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'src/cli.ts',
    'lease', 'renew', made.json.lease.id, '--ttl', '120'], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, PIPE_URL: 'http://127.0.0.1:12345', PIPE_TOKEN: TOKEN, NODE_NO_WARNINGS: '1' } });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const sent = JSON.parse(child.stdout);
  assert.equal(sent.headers['content-type'], 'application/json');
  const result = await f.call(sent.method, sent.path, sent.body, TOKEN, sent.headers);
  assert.equal(result.status, 200);
  assert.equal(result.json.lease.expiresAt, new Date(NOW + 120_000).toISOString());
});

test('L25 an explicit release also clears a swept expired lease grace load', t => {
  const f = fixture(t), lease = f.store.takeLease(account(), input);
  f.advance(60_000); f.store.sweepExpiredLeases();
  assert.equal(f.store.activeLeaseCount('a'), 1);
  const released = f.store.releaseLease(lease.id);
  assert.equal(f.store.activeLeaseCount('a'), 0);
  assert.deepEqual(f.store.releaseLease(lease.id), released);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  assert.equal(db.prepare('SELECT ended FROM leases').get()!.ended, 'released');
});


test('L26 a read at expiry then rollback beyond one tick refuses HTTP renewal and listings', async t => {
  const f = await api(t), lease = f.store.takeLease(account(), input);
  f.advance(59_000); f.store.sweepExpiredLeases();
  f.advance(1000); assert.deepEqual(f.store.activeLeases(), []);
  f.advance(-30_000);
  assert.equal(f.store.clockIsCurrent(), false);
  const renewed = await f.call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 60 });
  assert.equal(renewed.status, 503); assert.equal(renewed.json.error.code, 'clock_unavailable');
  assert.equal((await f.call('GET', '/v1/leases')).status, 503);
  assert.equal(f.store.activeLeaseCount('a'), 1);
});

test('L27 every sweep stamps the heartbeat with no expired leases, including an empty table', t => {
  const f = fixture(t), db = new DatabaseSync(f.path); t.after(() => db.close());
  f.advance(1000); f.store.sweepExpiredLeases();
  assert.equal(db.prepare('SELECT last FROM clock').get()!.last, NOW + 1000);
  const lease = f.store.takeLease(account(), input);
  f.advance(1000); f.store.sweepExpiredLeases();
  assert.equal(db.prepare('SELECT last FROM clock').get()!.last, NOW + 2000);
  assert.deepEqual(f.store.activeLeases(), [lease]);
  f.reopen(); f.advance(-1);
  assert.equal(f.store.clockIsCurrent(), false, 'even an idle heartbeat survives restart');
});

test('L28 renewal refuses a clock behind the lease own renewed_at even with a lower high-water mark', async t => {
  const f = await api(t), lease = f.store.takeLease(account(), input);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.prepare('UPDATE leases SET renewed_at = ? WHERE id = ?').run(new Date(NOW + 500).toISOString(), lease.id);
  assert.equal(f.store.clockIsCurrent(), true, 'exercise the independent per-lease guard');
  const renewed = await f.call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 60 });
  assert.equal(renewed.status, 503); assert.equal(renewed.json.error.code, 'clock_unavailable');
  assert.equal(db.prepare('SELECT renewed_at FROM leases WHERE id = ?').get(lease.id)!.renewed_at, new Date(NOW + 500).toISOString());
});

test('L29 a throwing lease sweep logs its fixed code and still reaches dispatch in that tick', async t => {
  const f = fixture(t); transport(t);
  const capture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/u4/${name}.json`, import.meta.url), 'utf8')).stdout;
  const auth = capture('claude-auth-status.signed-in'), cli = join(f.root, 'claude');
  writeFileSync(cli, `#!${process.execPath}
const args = process.argv.slice(2);
const out = args[0] === '--version' ? ${JSON.stringify(capture('claude-version'))} : JSON.stringify(args[0] === 'auth' ? ${JSON.stringify(auth)} : ${JSON.stringify(capture('claude-usage.signed-in'))});
process.stdout.write(out);
`); chmodSync(cli, 0o755);
  const path = join(f.root, 'service.sqlite'), seed = new Store(path), r = seed.submit(request()); seed.close();
  const logs: string[] = []; let sweeps = 0, dispatched = false;
  t.mock.method(process.stderr, 'write', (...args: unknown[]) => { logs.push(String(args[0])); return true; });
  t.mock.method(Store.prototype, 'sweepExpiredLeases', () => { sweeps++; throw new Error('fixture SQLITE_BUSY'); });
  t.mock.method(Store.prototype, 'startAttempt', (id: string) => {
    if (id === r.id) dispatched = true;
    return { ok: false, reason: 'fixture stops at dispatch boundary' };
  });
  const service = await startPipe({ accounts: [{ ...account(), loginDir: f.root,
    fingerprint: createHash('sha256').update(auth.orgId).digest('hex').slice(0, 8) }],
    policy: POLICY, token: TOKEN, cli: { claude: cli }, env: { PATH: process.env.PATH }, storePath: path,
    worktreeRoot: join(f.root, 'trees'), reachable: async () => true, tickMs: 10, minFreeGb: 0 });
  t.after(() => service.stop());
  for (let i = 0; i < 100 && !dispatched; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(sweeps > 0); assert.equal(dispatched, true, 'sweep failure cannot skip dispatch');
  assert.ok(logs.some(line => line.includes('pipe lease sweep:')));
});


test('L30 take and renew require a successful sweep since start, including reopen', async t => {
  const f = fixture(t, false), call = transport(t);
  await startHttp({ token: TOKEN, store: f.store, policy: POLICY, accounts: () => [], models: () => ({}),
    accountIds: () => ['a', 'b'], draining: () => false, drain: async () => {}, cancel() {},
    leaseAccount: id => ({ account: account(id), headroom: .5 }) });
  const take = () => call('POST', '/v1/leases', { ...input, account: 'a' });
  const missing = await take();
  assert.equal(missing.status, 503); assert.equal(missing.json.error.code, 'clock_unavailable');
  f.store.sweepExpiredLeases();
  const lease = (await take()).json.lease;
  f.reopen();
  assert.throws(() => f.store.renewLease(lease.id, 60), (e: any) => e.status === 503 && e.code === 'clock_unavailable');
  assert.throws(() => f.store.takeLease(account('b'), input), (e: any) => e.status === 503 && e.code === 'clock_unavailable');
  f.store.sweepExpiredLeases(); assert.ok(f.store.renewLease(lease.id, 60));
});

test('L31 skipped or failed sweeps make HTTP take and renew unavailable after 30 seconds', async t => {
  const f = await api(t), lease = f.store.takeLease(account(), input);
  const renew = () => f.call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 60 });
  f.advance(30_000);
  assert.equal((await renew()).status, 200, 'exactly 30 seconds remains fresh');
  assert.equal((await f.call('POST', '/v1/leases', { ...input, account: 'single' })).status, 409);
  f.advance(1);
  for (const result of [await renew(), await f.call('POST', '/v1/leases', { ...input, account: 'a' })]) {
    assert.equal(result.status, 503); assert.equal(result.json.error.code, 'clock_unavailable');
  }
  f.store.sweepExpiredLeases(); assert.equal((await renew()).status, 200);
  const doomed = f.store.takeLease(account('b'), input), db = new DatabaseSync(f.path); t.after(() => db.close());
  db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(NOW, doomed.id);
  db.exec("CREATE TRIGGER fail_sweep BEFORE UPDATE ON leases BEGIN SELECT RAISE(ABORT, 'fixture sweep failure'); END");
  f.advance(30_001);
  assert.throws(() => f.store.sweepExpiredLeases(), /fixture sweep failure/);
  f.store.submit(request()); // unrelated clock stamping must not refresh a failed heartbeat
  for (const result of [await renew(), await f.call('POST', '/v1/leases', { ...input, account: 'a' })]) {
    assert.equal(result.status, 503); assert.equal(result.json.error.code, 'clock_unavailable');
  }
  db.exec('DROP TRIGGER fail_sweep'); f.store.sweepExpiredLeases();
  assert.equal((await renew()).status, 200);
});

test('L32 uncertain capacity ignores swept rows whose expiry plus grace reaches the high-water mark', t => {
  const f = fixture(t), a = account('a', 6);
  const old = f.store.takeLease(a, input), boundary = f.store.takeLease(a, input), recent = f.store.takeLease(a, input);
  const unswept = f.store.takeLease(a, { ...input, ttlSeconds: 3600 }), released = f.store.takeLease(a, input);
  f.store.releaseLease(released.id);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(NOW + 59_000, old.id);
  db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(NOW + 61_000, recent.id);
  f.advance(61_000); f.store.sweepExpiredLeases();
  db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run(NOW, unswept.id);
  db.prepare('UPDATE clock SET last = ?').run(NOW + 120_000);
  for (const at of [undefined, new Date(NaN)]) {
    assert.equal(f.store.activeLeaseCount('a', at), 2, 'only recent grace and the unreleased row retain load');
    assert.equal(db.prepare('SELECT last FROM clock').get()!.last, NOW + 120_000, 'count remains pure');
  }
  assert.ok(db.prepare('SELECT 1 FROM leases WHERE id = ?').get(boundary.id), 'inactive rows remain retained');
});

test('L33 renewal accepts the exact window boundary and refuses the next millisecond', t => {
  const f = fixture(t), lease = f.store.takeLease(account(), input), edge = f.store.takeLease(account('b'), input);
  f.advance(59_000); f.store.sweepExpiredLeases();
  assert.ok(f.store.renewLease(edge.id, 60));
  f.advance(1);
  assert.throws(() => f.store.renewLease(lease.id, 60), (e: any) => e.status === 410 && e.code === 'lease_inactive');
});

test('L34 slow ticks start; lease TTLs require three ticks and heartbeats tolerate two', async t => {
  const f = fixture(t), call = transport(t);
  await t.test('a 60000 ms tick starts with a TTL warning', async t => {
    const logs: string[] = [];
    t.mock.method(process.stderr, 'write', (...args: unknown[]) => { logs.push(String(args[0])); return true; });
    const pipe = await startPipe({ accounts: [], policy: POLICY, token: TOKEN, port: 0, cli: {}, env: { PATH: '' },
      storePath: join(f.root, 'service.sqlite'), worktreeRoot: join(f.root, 'trees'),
      reachable: async () => false, minFreeGb: 0, tickMs: 60_000 });
    await pipe.stop();
    assert.deepEqual(logs.filter(line => line.startsWith('pipe lease TTL warning:')),
      ['pipe lease TTL warning: TTLs below 180000 ms (3 ticks) will be refused\n']);
  });
  let time = NOW;
  const store = new Store(join(f.root, 'slow.sqlite'), { leaseTickMs: 60_000, now: () => new Date(time) });
  t.after(() => store.close()); store.sweepExpiredLeases();
  await startHttp({ token: TOKEN, store, policy: POLICY, accounts: () => [], models: () => ({}),
    accountIds: () => [], draining: () => false, drain: async () => {}, cancel() {},
    leaseAccount: id => ({ account: account(id), headroom: .5 }) });
  const invalid = { error: { code: 'invalid_request', message: 'ttlSeconds must be at least 3 ticks' } };
  await t.test('take refuses a TTL below three ticks without creating a lease', async () => {
    const result = await call('POST', '/v1/leases', { ...input, account: 'take', ttlSeconds: 179 });
    assert.equal(result.status, 400); assert.deepEqual(result.json, invalid);
    assert.deepEqual(store.activeLeases('take'), []);
    assert.equal((await call('POST', '/v1/leases', { ...input, account: 'take', ttlSeconds: 180 })).status, 201);
  });
  await t.test('renew checks the requested TTL without changing the existing lease', async () => {
    const lease = store.takeLease(account('renew'), { ...input, ttlSeconds: 3600 });
    const result = await call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 179 });
    assert.equal(result.status, 400); assert.deepEqual(result.json, invalid);
    assert.deepEqual(store.activeLeases('renew'), [lease]);
    assert.equal((await call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 180 })).status, 200);
  });
  await t.test('two-tick freshness accepts equality and refuses the next millisecond', async () => {
    const lease = store.takeLease(account('heartbeat'), { ...input, ttlSeconds: 180 });
    time += 120_000;
    const renew = () => call('POST', `/v1/leases/${lease.id}/renew`, { ttlSeconds: 180 });
    assert.equal((await renew()).status, 200, 'renewal at the one-tick margin with a two-tick-old heartbeat');
    assert.equal((await call('POST', '/v1/leases', { ...input, account: 'fresh', ttlSeconds: 180 })).status, 201);
    time++;
    for (const result of [await renew(), await call('POST', '/v1/leases', { ...input, account: 'stale', ttlSeconds: 180 })]) {
      assert.equal(result.status, 503); assert.equal(result.json.error.code, 'clock_unavailable');
    }
    store.sweepExpiredLeases(); assert.equal((await renew()).status, 200);
  });
});

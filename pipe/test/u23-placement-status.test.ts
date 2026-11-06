import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, type NewRequest, type DispatchEvidence } from '../src/store.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import { startHttp } from '../src/http.ts';
import { startPipe } from '../src/service.ts';
import { AllowanceLedger } from '../src/allowance.ts';
import { IdentityLedger } from '../src/availability.ts';

const NOW = new Date('2026-10-03T12:00:00Z');
const mode = { placement: 'ordinary_headroom' } as const;
const request = (extra = {}): NewRequest => ({ requester: 'fixture', project: 'fixture', kind: 'code', provider: 'codex',
  model: 'test-model', effort: 'high', reason: 'fixture test', prompt: 'SECRET_PROMPT', priority: 'interactive', mutating: false, ...extra });
const account = (id: string) => ({ id, provider: 'codex' as const, loginDir: '/SECRET_LOGIN', fingerprint: 'SECRET_FINGERPRINT', enabled: true, maxConcurrency: 2 });
const evidence = (id: string, headroom = .9, extra = {}): DispatchEvidence => ({ accountId: id, model: 'test-model', observedAt: NOW.toISOString(),
  verdict: { state: 'available', headroom }, grant: ['SECRET_GRANT'], ...extra });
const status = (id: string, room: number, running = 0, extra = {}): AccountStatus => ({ account: account(id), running, evidence: () => evidence(id, room, extra) });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u23-')), path = join(root, 'record.sqlite');
  const store = new Store(path, { now: () => NOW, retryBackoffMs: 0 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, path, root };
}
const options = { now: NOW, pinWaitMs: 60_000, evidenceMaxAgeMs: 60_000, load: new Map() };

test('P1 opt-in chooses busy 90% before idle 20%; default still spreads', (t) => {
  const { store } = fixture(t), accounts = [status('a', .9, 1), status('b', .2)];
  assert.equal(plan([store.submit(request(mode))], accounts, options).dispatch[0]?.accountId, 'a');
  assert.equal(plan([store.submit(request())], accounts, options).dispatch[0]?.accountId, 'b');
});

test('P2 equal headroom uses load then deterministic ID; full and exhausted accounts yield', (t) => {
  const { store } = fixture(t), r = store.submit(request(mode));
  assert.equal(plan([r], [status('b', .9), status('a', .9)], options).dispatch[0]?.accountId, 'a');
  assert.equal(plan([r], [status('a', .9, 1), status('b', .9)], options).dispatch[0]?.accountId, 'b');
  const next = store.submit(request(mode));
  assert.deepEqual(plan([r, next], [status('a', .9, 1), status('b', .2)], options).dispatch.map(d => d.accountId), ['a', 'b']);
  const exhausted = status('a', 0, 0, { verdict: { state: 'unavailable', reason: 'exhausted', until: null } });
  assert.equal(plan([next], [exhausted, status('b', .2)], options).dispatch[0]?.accountId, 'b');
});

test('P3 opt-in excludes credits and malformed evidence; default credits remain authorized', (t) => {
  const { store } = fixture(t), r = store.submit(request(mode));
  const credit = status('a', .05, 0, { verdict: { state: 'available', headroom: .05, via: 'credits' } });
  for (const bad of [credit, status('a', .9, 0, { accountId: 'other' }), status('a', .9, 0, { model: 'other' }),
    status('a', .9, 0, { observedAt: '2026-10-03T11:58:00Z' }), status('a', .9, 0, { observedAt: '2026-10-03T12:01:00Z' }),
    status('a', .9, 0, { observedAt: null }), status('a', NaN), status('a', 0), status('a', 2),
    status('a', .9, 0, { verdict: { state: 'available', headroom: .9, via: 'invented' } }), status('a', .9, 0, { verdict: null })]) {
    assert.equal(plan([r], [bad, status('b', .2)], options).dispatch[0]?.accountId, 'b', JSON.stringify(bad.evidence(r.model)));
  }
  assert.equal(plan([store.submit(request())], [credit], options).dispatch[0]?.accountId, 'a');
});

test('P4 pins narrow opt-in placement and never promote credit, busy or excluded slots', (t) => {
  const { store } = fixture(t), r = store.submit(request({ ...mode, pin: 'b' }));
  assert.equal(plan([r], [status('a', .9), status('b', .2)], options).dispatch[0]?.accountId, 'b');
  for (const b of [status('b', .2, 2), status('b', .05, 0, { verdict: { state: 'available', headroom: .05, via: 'credits' } })]) {
    assert.equal(plan([r], [status('a', .9), b], options).waits[0]?.kind, 'pinned_account');
  }
  const held = { ...r, waiting: { reason: 'ordinary window full', until: null, stoppedSince: '2026-10-03T11:00:00Z' } };
  const credit = status('b', .05, 0, { verdict: { state: 'available', headroom: .05, via: 'credits' } });
  assert.equal(plan([held], [credit], options).waits[0]?.kind, 'pinned_account', 'known ordinary exhaustion outwaits pin patience');
  assert.equal(plan([{ ...r, exclude: ['b'] }], [status('a', .9), status('b', .2)], options).dispatch.length, 0);
});

test('P5 placement validates and persists; malformed stored/planner modes fail closed', (t) => {
  const { store, path } = fixture(t);
  for (const placement of [null, '', 'auto', true, 1, {}, []]) {
    assert.throws(() => store.submit(request({ placement })), /placement/);
    const r = store.submit(request());
    assert.equal(plan([{ ...r, placement } as any], [status('a', .9)], options).fail.length, 1);
  }
  const r = store.submit(request(mode)), again = new Store(path, { now: () => NOW });
  try { assert.equal((again.get(r.id) as any).placement, mode.placement); }
  finally { again.close(); }
  assert.equal(Object.hasOwn(store.submit(request()), 'placement'), false);
});

test('P6 claim rechecks opt-in credits, current slots, binding, time and pin', (t) => {
  const { store, path } = fixture(t), r = store.submit(request(mode)), a = account('a');
  const other = new Store(path, { now: () => NOW }); t.after(() => other.close());
  for (const bad of [evidence('a', .05, { verdict: { state: 'available', headroom: .05, via: 'credits' } }),
    evidence('other'), evidence('a', 0), evidence('a', .9, { observedAt: '2026-10-03T11:58:00Z' }),
    evidence('a', .9, { verdict: { state: 'available', headroom: .9, via: 'invented' } }),
    evidence('a', .9, { verdict: { state: 'unknown', reason: 'lost current capacity' } })]) {
    assert.equal(store.startAttempt(r.id, a, bad).ok, false);
  }
  for (let i = 0; i < 2; i++) assert.equal(other.startAttempt(other.submit(request()).id, a, evidence('a')).ok, true);
  assert.equal(store.startAttempt(r.id, a, evidence('a')).ok, false);
  assert.equal(store.startAttempt(r.id, account('b'), evidence('b')).ok, true);
  assert.equal(other.startAttempt(r.id, account('c'), evidence('c')).ok, false);
  const pinned = store.submit(request({ ...mode, pin: 'a' }));
  assert.equal(store.startAttempt(pinned.id, account('b'), evidence('b')).ok, false);
});

test('P7 status binds durable attempts through retry/completion; queued is unselected and secrets stay private', (t) => {
  const { store, path } = fixture(t), r = store.submit(request(mode));
  const read = () => (store as any).requestStatus(r.id);
  assert.deepEqual(read(), { id: r.id, state: 'queued', selection: null, attempts: [] });
  const evaluatedAt = new Date(NOW.getTime() - 10_000).toISOString();
  const first = store.startAttempt(r.id, account('a'), evidence('a', .9, { observedAt: evaluatedAt })); assert.ok(first.ok);
  assert.equal(read().selection.attemptId, first.attempt.id, 'durable before runner starts');
  assert.deepEqual(read().selection.allowance, { provenance: 'claim_verdict', headroom: .9, basis: 'ordinary', evaluatedAt, observedAt: null });
  assert.equal(read().selection.selectedAt, NOW.toISOString());
  assert.equal(read().selection.reportedModel, null);
  store.finishAttempt(first.attempt.id, { kind: 'failed', errorKind: 'transient', message: 'SECRET_FAILURE' });
  assert.equal(read().selection, null); assert.equal(read().attempts[0].accountId, 'a');
  const second = store.startAttempt(r.id, account('b'), evidence('b', .2)); assert.ok(second.ok);
  store.noteModel(second.attempt.id, 'actual-model');
  store.finishAttempt(second.attempt.id, { kind: 'completed', result: 'SECRET_RESULT' });
  const again = new Store(path, { now: () => NOW });
  try {
    const final = (again as any).requestStatus(r.id);
    assert.equal(final.selection.accountId, 'b'); assert.equal(final.selection.attemptId, second.attempt.id);
    assert.equal(final.selection.provider, 'codex'); assert.equal(final.selection.requestedModel, 'test-model');
    assert.equal(final.selection.reportedModel, 'actual-model'); assert.equal(final.selection.selectedAt, NOW.toISOString());
    assert.deepEqual(final.attempts.map((a: any) => a.accountId), ['a', 'b']);
    assert.doesNotMatch(JSON.stringify(final), /SECRET|dispatch|fingerprint|prompt|grant|runner/);
  } finally { again.close(); }
});

test('P8 legacy allowance stays unknown; new credit snapshots stay labelled; mutating uncertainty keeps original binding', (t) => {
  const { store, root, path } = fixture(t), r = store.submit(request({ mutating: true, cwd: root }));
  const claim = store.startAttempt(r.id, account('a'), evidence('a', .05, { verdict: { state: 'available', headroom: .05, via: 'credits' } })); assert.ok(claim.ok);
  assert.equal((store as any).requestStatus(r.id).selection.allowance.basis, 'credits');
  const db = new DatabaseSync(path);
  db.prepare("UPDATE attempts SET dispatch = json_remove(dispatch, '$.allowance') WHERE id = ?").run(claim.attempt.id); db.close();
  store.finishAttempt(claim.attempt.id, { kind: 'interrupted', message: 'uncertain' });
  const result = (store as any).requestStatus(r.id);
  assert.equal(result.state, 'failed'); assert.equal(result.selection.accountId, 'a');
  assert.equal(result.selection.allowance, null); assert.equal(result.selection.reportedModel, null);
  assert.equal(store.startAttempt(r.id, account('b'), evidence('b')).ok, false);
});

// Exercise the real HTTP handler, with transport only replaced; no listening socket or live service.
test('P9 authenticated status route is narrow; HTTP submission validates placement', async (t) => {
  const { store } = fixture(t); let handler: any;
  const server = Object.assign(new EventEmitter(), { listen(_p: number, _h: string, cb: () => void) { cb(); }, address() { return { port: 12345 }; } });
  t.mock.method(http, 'createServer', (cb: any) => { handler = cb; return server; }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', store, policy: { codex: { models: { 'test-model': 'default' }, efforts: ['high'] } },
    accounts: () => { throw Error('must not join current accounts'); }, models: () => ({}), accountIds: () => ['a'], draining: () => false, drain: async () => {}, cancel: () => {} });
  const send = (method: string, url: string, input?: unknown, auth = true): Promise<{ code: number; body: any }> => new Promise(resolve => {
    const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { method, url,
      headers: { authorization: auth ? 'Bearer fixture-token' : '', 'content-type': 'application/json' } });
    let code: number;
    handler(req, { writeHead(c: number) { code = c; }, end(data: string) { resolve({ code, body: JSON.parse(data) }); } });
  });
  const r = store.submit(request(mode)), path = `/v1/requests/${r.id}/status`;
  assert.equal((await send('GET', path, undefined, false)).code, 401);
  assert.deepEqual((await send('GET', path)).body, { status: { id: r.id, state: 'queued', selection: null, attempts: [] } });
  assert.equal((await send('GET', '/v1/requests/missing/status')).code, 404);
  assert.equal((await send('POST', path)).code, 404); assert.equal(store.get(r.id)!.state, 'queued');
  const claim = store.startAttempt(r.id, account('a'), evidence('a')); assert.ok(claim.ok);
  store.finishAttempt(claim.attempt.id, { kind: 'completed', result: 'SECRET_RESULT' });
  const terminal = await send('GET', path); assert.equal(terminal.body.status.selection.accountId, 'a');
  assert.doesNotMatch(JSON.stringify(terminal.body), /SECRET|prompt|dispatch|fingerprint/);
  for (const placement of [null, 'auto', true, {}]) assert.equal((await send('POST', '/v1/requests', request({ placement }))).code, 400);
  for (const extra of [{}, mode]) {
    const response = await send('POST', '/v1/requests', request(extra)); assert.equal(response.code, 201);
    assert.equal((store.get(response.body.request.id) as any).placement, (extra as any).placement);
  }
});

test('P11 malformed or mismatched retained snapshots remain unknown; caller metadata is never copied', (t) => {
  const { store, path } = fixture(t), r = store.submit(request(mode));
  const claim = store.startAttempt(r.id, account('a'), evidence('a', .9, { allowance: { secret: 'SECRET' } })); assert.ok(claim.ok);
  const db = new DatabaseSync(path); t.after(() => db.close());
  const saved = JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE id = ?').get(claim.attempt.id)!.dispatch));
  assert.equal(saved.allowance.secret, undefined);
  for (const patch of [{ headroom: .3 }, { basis: 'credits' }, { observedAt: NOW.toISOString() }, { evaluatedAt: 'tomorrow' },
    { evaluatedAt: '2026-10-03T12:01:00Z' }, { headroom: '0.9' }, { provenance: 'live_reading' }]) {
    db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify({ ...saved, allowance: { ...saved.allowance, ...patch } }), claim.attempt.id);
    assert.equal(store.requestStatus(r.id)!.selection!.allowance, null, JSON.stringify(patch));
  }
  for (const patch of [{ accountId: 'other' }, { model: 'other' }]) {
    db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify({ ...saved, ...patch }), claim.attempt.id);
    assert.equal(store.requestStatus(r.id)!.selection!.allowance, null);
  }
  for (const reportedModel of [null, '', '   ', 42, {}]) {
    db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify({ ...saved, reportedModel }), claim.attempt.id);
    assert.equal(store.requestStatus(r.id)!.selection!.reportedModel, null);
  }
  for (const dispatch of ['null','{','{}']) {
    db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(dispatch, claim.attempt.id);
    const selection = store.requestStatus(r.id)!.selection!;
    assert.equal(selection.allowance, null); assert.equal(selection.provider, null); assert.equal(selection.requestedModel, null);
  }

});

for (const change of ['allowance', 'identity'] as const) test(`P12 service re-evaluates ${change} after planning, before durable claim`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pipe-u23-service-')), path = join(root, 'record.sqlite');
    const rows = JSON.parse(readFileSync(new URL('./fixtures/u4/codex-app-server.signed-in.json', import.meta.url), 'utf8'));
    const cli = join(root, 'fake-codex.cjs');
    writeFileSync(cli, `#!${process.execPath}
const rows = ${JSON.stringify(rows)};
if (process.argv[2] === '--version') console.log('codex-cli 0.156.1');
else if (process.argv[2] === 'login') console.error('Logged in using ChatGPT');
else if (process.argv[2] === 'app-server') {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m = JSON.parse(line), r = rows.find(r => r.method === m.method);
    if (r) console.log(JSON.stringify({...r.response, id:m.id}));
  });
} else { require('node:fs').readFileSync(0); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}})); }
`); chmodSync(cli, 0o755);
    t.mock.method(http.Server.prototype, 'listen', function(this: http.Server, ...args: unknown[]) { queueMicrotask(() => (args.at(-1) as () => void)()); return this; });
    t.mock.method(http.Server.prototype, 'address', () => ({ port: 1, address: '127.0.0.1', family: 'IPv4' }));
    t.mock.method(http.Server.prototype, 'close', function(this: http.Server, cb?: () => void) { queueMicrotask(() => cb?.()); return this; });
    let reads = 0, armed = false, accepted: boolean | null = null;
    const fingerprint = createHash('sha256').update('<chatgptAccountId>').digest('hex').slice(0, 8);
    t.mock.method(AllowanceLedger.prototype, 'view', (accountId: string) => {
      if (armed && change === 'allowance' && ++reads > 1) return { state: 'exhausted', accountId, bucket: 'fixture', until: null };
      return { state: 'ok', accountId, headroom: .9, binding: 'fixture' };
    });
    t.mock.method(IdentityLedger.prototype, 'view', (accountId: string) => ({ accountId,
      signedIn: true, fingerprint: armed && change === 'identity' && ++reads > 1 ? 'wrong-login' : fingerprint, observedAt: new Date(Date.now() - 1000).toISOString() }));
    const start = Store.prototype.startAttempt;
    t.mock.method(Store.prototype, 'startAttempt', function(this: Store, ...args: Parameters<typeof start>) {
      const result = start.apply(this, args); accepted = result.ok;
      return { ok: false, reason: 'fixture checks the claim without starting a runner' };
    });
    const pipe = await startPipe({ accounts: [{ ...account('a'), fingerprint, loginDir: root }],
      policy: { codex: { models: { 'gpt-6-sol': 'default' }, efforts: ['high'] } }, storePath: path, worktreeRoot: join(root, 'trees'),
      cli: { codex: cli }, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, token: 'fixture-token-for-local-test-only',
      reachable: async () => true, tickMs: 25, minFreeGb: 0 });
    const store = new Store(path);
    try {
      armed = true; const r = store.submit(request({ ...mode, model: 'gpt-6-sol' }));
      const deadline = Date.now() + 3000;
      while (accepted === null && Date.now() < deadline) await sleep(10);
      assert.equal(accepted, false, 'a claim was checked and refused on current evidence');
      assert.equal(store.get(r.id)!.state, 'queued'); assert.deepEqual(store.attempts(r.id), []);
    } finally { await pipe.stop(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('P10 CLI validates placement before transport, and supports narrow status explicitly', () => {
  const preload = 'globalThis.fetch = async (url, init) => new Response(JSON.stringify({url, body: init.body ? JSON.parse(init.body) : null}));';
  const run = (args: string[], input = '') => spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'src/cli.ts', ...args],
    { input, encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PIPE_URL: 'http://127.0.0.1:12345', PIPE_TOKEN: 'fixture-token' } });
  for (const placement of [null, 'auto', true, {}]) { const r = run(['submit'], JSON.stringify(request({ placement }))); assert.notEqual(r.status, 0); assert.match(r.stderr, /placement/); }
  const good = run(['submit'], JSON.stringify(request(mode))); assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).body.placement, mode.placement);
  for (const flag of ['--selection=false','--selection=true','--unknown']) assert.notEqual(run(['status','original-id',flag]).status,0);
  const status = run(['status', 'original-id', '--selection']); assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).url, 'http://127.0.0.1:12345/v1/requests/original-id/status');
});

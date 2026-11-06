import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { AllowanceLedger } from '../src/allowance.ts';
import { availability, IdentityLedger } from '../src/availability.ts';
import { startHttp } from '../src/http.ts';
import { plan } from '../src/queue.ts';
import { getReview, refreshReviews, submitReview, type Review } from '../src/review.ts';
import { Store } from '../src/store.ts';

const now = new Date('2026-10-04T12:00:00Z');
const mode = { placement: 'ordinary_headroom' } as const;
const seats = [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
  { provider: 'claude', model: 'opus', effort: 'high' }];
const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const }, efforts: ['high'] },
  claude: { models: { opus: 'hard' as const }, efforts: ['high'] } };
const badValues = [null, '', 'auto', 'ordinary', 'ORDINARY_HEADROOM', false, 1, {}, []];
const options = { now, pinWaitMs: 60_000, evidenceMaxAgeMs: 60_000, load: new Map() };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-review-placement-')), repo = join(root, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'inert\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD'), path = join(root, 'record.sqlite');
  const open = () => new Store(path, { now: () => now, retryBackoffMs: 0 });
  let store = open();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { requester: 'fixture', reason: 'security review binding fixture', repo, head, base: head,
    brief: 'Check omission, clock steps, malformed values and cross-account evidence.', seats,
    builders: [{ family: 'openai', context: 'builder-fixture' }] };
  const submit = (extra = {}) => submitReview(store, policy, join(root, 'trees'), { ...input, ...extra }, env);
  return { root, path, input, env, submit, get store() { return store; }, reopen() { store.close(); store = open(); } };
}

function allowance(provider: 'codex' | 'claude', kind: 'ordinary' | 'credits' | 'unknown' | 'exhausted') {
  const account = { id: provider, provider, enabled: true, maxConcurrency: 1, loginDir: '/inert', fingerprint: 'fixture' };
  const identities = new IdentityLedger({ now: () => now }); identities.record(provider, { signedIn: true, fingerprint: 'fixture' });
  const ledger = new AllowanceLedger({ now: () => now, freshnessMs: 60_000 });
  if (kind !== 'unknown') ledger.record(provider, [{ bucket: 'week', model: null,
    usedFraction: kind === 'ordinary' ? .2 : kind === 'credits' ? .95 : 1,
    resetsAt: '2026-10-05T12:00:00Z', ...(kind === 'credits' ? { via: 'credits' as const } : {}) }]);
  return { account, running: 0, evidence: (model: string) => ({ accountId: provider, model, observedAt: now.toISOString(),
    verdict: availability({ account, identities, allowances: ledger, model, running: 0, now, identityMaxAgeMs: 60_000 }) }) };
}

test('RP1 snapshots placement before async setup, persists it before worktree creation and gives it to both native seats', async t => {
  const f = fixture(t), raw: Record<string, unknown> = { ...f.input, ...mode };
  let original: Record<string, unknown> | undefined;
  const insert = f.store.insertReview.bind(f.store);
  t.mock.method(f.store, 'insertReview', (id: string, state: string, body: object) => {
    original = JSON.parse(JSON.stringify(body));
    assert.equal(existsSync((body as Review).worktree), false);
    insert(id, state, body);
  });
  const pending = submitReview(f.store, policy, join(f.root, 'trees'), raw, f.env);
  delete raw.placement; // Caller's object must not weaken admission while git is awaited.
  const review = await pending;
  assert.equal(original?.placement, mode.placement);
  assert.equal((review as Review).placement, mode.placement);
  assert.deepEqual(review.receipt.builders, f.input.builders);
  assert.equal(review.head, f.input.head);
  assert.deepEqual(review.seats.map(({ provider, model, effort }) => ({ provider, model, effort })), seats);
  assert.equal(new Set(review.seats.map(s => s.requestId)).size, 2);
  for (const seat of review.seats) {
    const child = f.store.get(seat.requestId)!;
    assert.equal(child.placement, mode.placement); assert.equal(child.mutating, false);
    assert.match(child.prompt, new RegExp(review.head)); assert.match(child.prompt, new RegExp(review.briefSha256));
    assert.match(child.prompt, /omission, clock steps, malformed values and cross-account evidence/);
    assert.notEqual(child.cwd, f.input.repo); assert.equal(child.model, seat.model); assert.equal(child.effort, seat.effort);
  }
});

test('RP2 API rejects malformed placement before creating review/worktree/requests; Gemini cannot bypass the guard', async t => {
  const f = fixture(t);
  for (const placement of badValues) await assert.rejects(f.submit({ placement }), /placement/);
  await assert.rejects(f.submit({ ...mode, seats: [{ provider: 'gemini', model: 'gemini-3.8-pro', effort: 'high' }] }), /ordinary_headroom.*native/);
  assert.deepEqual(f.store.runningReviewIds(), []); assert.deepEqual(f.store.list(), []);
  assert.equal(existsSync(join(f.root, 'trees')), false);
});

for (const kind of ['credits', 'unknown', 'exhausted'] as const) test(`RP3 ordinary review waits on ${kind}; real allowance/planner/claim`, async t => {
  const f = fixture(t), review = await f.submit(mode);
  for (const seat of review.seats) {
    const child = f.store.get(seat.requestId)!, a = allowance(seat.provider as 'codex' | 'claude', kind);
    const p = plan([child], [a], options);
    assert.equal(p.dispatch.length, 0); assert.equal(p.waits.length, 1); assert.deepEqual(p.fail, []);
    assert.equal(f.store.startAttempt(child.id, a.account, { ...a.evidence(child.model), grant: [] }).ok, false);
    f.store.setWaiting(child.id, p.waits[0]!);
    assert.deepEqual(f.store.attempts(child.id), []);
  }
  refreshReviews(f.store, () => assert.fail('unexpected refresh failure'), f.env);
  const held = getReview(f.store, review.id)!;
  assert.equal(held.state, 'running'); assert.deepEqual(held.receipt.votes, []); assert.equal(held.receipt.quorum.approved, false);
  assert.ok(held.seats.every(s => s.status === 'waiting'));
  f.reopen();
  assert.equal((getReview(f.store, review.id) as Review).placement, mode.placement);
});

for (const kind of ['credits', 'unknown', 'exhausted'] as const) test(`RP4 allowance becomes ${kind} between plan and claim`, async t => {
  const f = fixture(t), review = await f.submit(mode);
  for (const seat of review.seats) {
    const child = f.store.get(seat.requestId)!, good = allowance(seat.provider as 'codex' | 'claude', 'ordinary');
    assert.equal(plan([child], [good], options).dispatch[0]?.requestId, child.id);
    const changed = allowance(seat.provider as 'codex' | 'claude', kind);
    assert.equal(f.store.startAttempt(child.id, changed.account, { ...changed.evidence(child.model), grant: [] }).ok, false);
    assert.equal(f.store.get(child.id)!.state, 'queued'); assert.deepEqual(f.store.attempts(child.id), []);
  }
});

test('RP5 omitted placement preserves existing credit admission for native review seats', async t => {
  const f = fixture(t), review = await f.submit();
  assert.equal(Object.hasOwn(review, 'placement'), false);
  for (const seat of review.seats) {
    const child = f.store.get(seat.requestId)!, a = allowance(seat.provider as 'codex' | 'claude', 'credits');
    assert.equal(Object.hasOwn(child, 'placement'), false);
    assert.equal(plan([child], [a], options).dispatch[0]?.requestId, child.id);
    const claim = f.store.startAttempt(child.id, a.account, { ...a.evidence(child.model), grant: [] }); assert.ok(claim.ok);
    f.store.finishAttempt(claim.attempt.id, { kind: 'failed', errorKind: 'auth', message: 'inert' });
  }
});

test('RP6 original review and children keep placement through wait, retry, restart and Stop without duplicate seats or votes', async t => {
  const f = fixture(t), review = await f.submit(mode), ids = review.seats.map(s => s.requestId);
  const child = f.store.get(ids[0]!)!, a = allowance('codex', 'ordinary');
  const claim = () => f.store.startAttempt(child.id, a.account, { ...a.evidence(child.model), grant: [] });
  const first = claim(); assert.ok(first.ok);
  f.store.finishAttempt(first.attempt.id, { kind: 'failed', errorKind: 'quota_exhausted', message: 'inert limit' });
  const held = plan([f.store.get(child.id)!], [allowance('codex', 'credits')], options);
  assert.equal(held.dispatch.length, 0); assert.equal(held.waits.length, 1);
  f.store.setWaiting(child.id, held.waits[0]!); f.reopen();
  assert.ok(f.store.get(child.id)!.waiting);
  const second = claim(); assert.ok(second.ok); // Pre-spawn only; no executable or inference.
  f.reopen(); f.store.reconcile('inert crash before spawn', 'interrupted');
  for (let i = 0; i < 3; i++) refreshReviews(f.store, () => assert.fail('unexpected refresh failure'), f.env);
  const recovered = getReview(f.store, review.id)!;
  assert.equal(recovered.id, review.id); assert.equal((recovered as Review).placement, mode.placement);
  assert.deepEqual(recovered.seats.map(s => s.requestId), ids); assert.equal(f.store.list().length, 2);
  assert.deepEqual(recovered.receipt.votes, []); assert.equal(recovered.receipt.quorum.approved, false);
  for (const id of ids) assert.equal(f.store.get(id)!.placement, mode.placement);
  assert.equal(f.store.attempts(child.id).length, 2);
  const credit = allowance('codex', 'credits');
  assert.equal(f.store.startAttempt(child.id, credit.account, { ...credit.evidence(child.model), grant: [] }).ok, false);
  const third = claim(); assert.ok(third.ok);
  assert.equal(f.store.cancel(child.id, 'fixture Stop', 'fixture'), true);
  refreshReviews(f.store, () => {}, f.env); assert.ok(existsSync(f.store.get(child.id)!.cwd!));
  f.store.finishAttempt(third.attempt.id, { kind: 'cancelled' });
  refreshReviews(f.store, () => {}, f.env);
  assert.equal(getReview(f.store, review.id)!.seats[0]!.status, 'failed');
  assert.deepEqual(getReview(f.store, review.id)!.receipt.votes, []);
});

test('RP7 interrupted seat admission retains saved placement and accounts for the missing seat without resubmission', async t => {
  const f = fixture(t), submit = f.store.submitReviewSeat.bind(f.store); let calls = 0;
  t.mock.method(f.store, 'submitReviewSeat', (...args: Parameters<Store['submitReviewSeat']>) => {
    if (++calls === 2) throw Error('inert interruption');
    return submit(...args);
  });
  await assert.rejects(f.submit(mode), /inert interruption/);
  const id = f.store.runningReviewIds()[0]!; f.reopen();
  assert.equal((getReview(f.store, id) as Review).placement, mode.placement);
  const originalId = getReview(f.store, id)!.seats[0]!.requestId;
  for (let i = 0; i < 100 && getReview(f.store, id)!.state !== 'finished'; i++) {
    refreshReviews(f.store, () => assert.fail('unexpected refresh failure'), f.env);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const recovered = getReview(f.store, id)!;
  assert.equal(recovered.state, 'finished'); assert.equal(recovered.seats.length, 2);
  assert.equal(recovered.seats[0]!.requestId, originalId); assert.equal(recovered.seats[1]!.requestId, '');
  assert.ok(recovered.seats.every(s => s.status === 'failed')); assert.equal(f.store.get(originalId)!.placement, mode.placement);
  assert.deepEqual(recovered.receipt.votes, []); assert.equal(calls, 2);
});

test('RP8 real HTTP review boundary accepts/persists placement and explicitly rejects malformed values (socket-free)', async t => {
  const f = fixture(t); let handler: any;
  const server = Object.assign(new EventEmitter(), { listen(_p: number, _h: string, cb: () => void) { cb(); }, address() { return { port: 1 }; } });
  t.mock.method(http, 'createServer', (cb: any) => { handler = cb; return server; }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture', store: f.store, policy, accounts: () => [], accountIds: () => [], models: () => ({}),
    draining: () => false, drain: async () => {}, cancel: () => {}, reviews: {
      submit: raw => submitReview(f.store, policy, join(f.root, 'trees'), raw, f.env), get: id => getReview(f.store, id), vote: () => undefined } });
  const send = (body: unknown): Promise<{ code: number; body: any }> => new Promise(resolve => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/v1/reviews',
      headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' } });
    let code: number;
    handler(req, { writeHead(c: number) { code = c; }, end(data: string) { resolve({ code, body: JSON.parse(data) }); } });
  });
  for (const placement of badValues) {
    const response = await send({ ...f.input, placement }); assert.equal(response.code, 400); assert.match(response.body.error.message, /placement/);
  }
  assert.deepEqual(f.store.runningReviewIds(), []);
  const response = await send({ ...f.input, ...mode }); assert.equal(response.code, 201);
  assert.equal(response.body.review.placement, mode.placement);
  for (const seat of response.body.review.seats) assert.equal(f.store.get(seat.requestId)!.placement, mode.placement);
});

function client(f: ReturnType<typeof fixture>, file: string, args: string[], input = '') {
  const capture = join(f.root, 'transport.json'); rmSync(capture, { force: true });
  const preload = `import {writeFileSync} from 'node:fs'; globalThis.fetch = async (url, init) => {
    writeFileSync(${JSON.stringify(capture)}, JSON.stringify({url, body: JSON.parse(init.body)}));
    return new Response(JSON.stringify({review:{id:'fixture-review'}})); };`;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, file, ...args],
    { input, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      HOME: f.root, PIPE_URL: 'http://127.0.0.1:1', PIPE_TOKEN: 'fixture' } });
  return { ...result, sent: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : undefined };
}

test('RP9 real CLI parser exposes placement; omitted, malformed, duplicate and missing arguments are exact', async t => {
  const f = fixture(t), brief = join(f.root, 'brief.txt'); writeFileSync(brief, f.input.brief);
  const args = ['review', '--repo', f.input.repo, '--head', f.input.head, '--brief', brief,
    '--seat', 'codex:gpt-6-astra:high', '--seat', 'claude:opus:high'];
  for (const extra of [[], ['--placement', mode.placement]]) {
    writeFileSync(brief, `${f.input.brief}\nCLI placement fixture: ${extra.length ? mode.placement : 'omitted'}.`);
    const r = client(f, 'src/cli.ts', [...args, ...extra]); assert.equal(r.status, 0, r.stderr);
    assert.equal(r.sent.body.placement, extra.length ? mode.placement : undefined);
    const review = await f.submit(r.sent.body);
    for (const seat of review.seats) assert.equal(f.store.get(seat.requestId)!.placement, r.sent.body.placement);
  }
  for (const extra of [['--placement'], ['--placement', ''], ['--placement', 'auto'], ['--placement', '--reason', 'x'],
    ['--placement=ordinary_headroom'], ['--placement', mode.placement, '--placement', 'auto'],
    ['--placement', mode.placement, '--placement']]) {
    const r = client(f, 'src/cli.ts', [...args, ...extra]); assert.notEqual(r.status, 0); assert.match(r.stderr, /placement/); assert.equal(r.sent, undefined);
  }
});

test('RP10 MCP advertises the single optional placement and validates it before transport', async t => {
  const f = fixture(t);
  const frame = (method: string, params?: unknown) => `${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`;
  const listed = client(f, 'src/mcp.ts', [], frame('tools/list'));
  assert.equal(listed.status, 0, listed.stderr);
  const schema = JSON.parse(listed.stdout).result.tools.find((tool: any) => tool.name === 'pipe_review').inputSchema;
  assert.deepEqual(schema.properties.placement, { type: 'string', enum: [mode.placement] });
  assert.equal(schema.required.includes('placement'), false);
  for (const extra of [{}, mode]) {
    const brief = `${f.input.brief}\nMCP placement fixture: ${'placement' in extra ? mode.placement : 'omitted'}.`;
    const result = client(f, 'src/mcp.ts', [], frame('tools/call', { name: 'pipe_review', arguments: { ...f.input, brief, ...extra } }));
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result.isError, undefined);
    const review = await f.submit(result.sent.body);
    for (const seat of review.seats) assert.equal(f.store.get(seat.requestId)!.placement, (extra as Partial<typeof mode>).placement);
  }
  for (const placement of badValues) {
    const r = client(f, 'src/mcp.ts', [], frame('tools/call', { name: 'pipe_review', arguments: { ...f.input, placement } }));
    assert.equal(JSON.parse(r.stdout).result.isError, true); assert.match(r.stdout, /placement/); assert.equal(r.sent, undefined);
  }
});

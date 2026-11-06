/** Independent R13 oracle: the keyless-reuse and child-outcome rulings, and the E1 contract.
 * Lesson/rule: interrupted setup cannot release a keyless binding while a submitted
 * native child owns live work; replacement requires terminal children and closed attempts.
 * Evidence: real seat transactions, Store reopen, refresh, claims and closed outcomes.
 * New-case-only scope: the implementation author must carry this lesson into the docs.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { startHttp } from '../src/http.ts';
import { getReview, refreshReviews, submitReview, type Review as StoredReview } from '../src/review.ts';
import { Store, type NewRequest } from '../src/store.ts';

type Review = NonNullable<ReturnType<typeof getReview>>;
type Reply = { status: number; body: { review?: Review; error?: { code: string } } };
const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const, 'gpt-6.1-sol': 'default' as const }, efforts: ['high'] },
  claude: { models: { opus: 'default' as const }, efforts: ['high'] } };
const seats = [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
  { provider: 'claude', model: 'opus', effort: 'high' }];

async function fixture(t: TestContext, submitted: boolean, running = false) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-e1-r13-'));
  const repo = join(root, 'repo'), trees = join(root, 'reviews'), path = join(root, 'record.sqlite');
  let store: Store | undefined;
  const errors: unknown[] = [];
  t.after(() => {
    try { assert.deepEqual(errors, [], 'real refresh must finish without fixture errors'); }
    finally {
      store?.close(); t.mock.restoreAll(); syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
  { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'fixture.txt'), 'head\n'); git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  const reviewInput = { requester: 'requester-a', repository: 'fixture/repository', repo, head, base, seats,
    brief: 'Check omission, clock steps, malformed values and cross-account evidence.',
    evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1',
    reason: 'Astra and Opus at high effort exercise the independent interrupted-setup oracle' };
  store = new Store(path);
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
  });
  // Keep real HTTP admission and Git; replace socket transport only. No provider is run.
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  const token = 'e1-r13-fixture-token-with-32-characters';
  const connect = () => startHttp({ token, policy, store: store!, env, accounts: () => [], models: () => ({}),
    accountIds: () => ['codex', 'claude'], draining: () => false, drain: async () => {}, cancel: () => {}, log: () => {},
    reviews: { submit: input => submitReview(store!, policy, trees, input, env,
      { E6_CAPACITY_HOOK: true, landing_rank_bound: 1 }), get: id => getReview(store!, id), vote: () => undefined } });
  await connect();
  const post = (input: unknown = reviewInput): Promise<Reply> => new Promise(resolve => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
      method: 'POST', url: '/v1/reviews', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    let status = 0;
    handler!(request as IncomingMessage, { writeHead(code: number) { status = code; },
      end(data: string) { resolve({ status, body: JSON.parse(data) }); } } as ServerResponse);
  });
  const create = async () => {
    const reply = await post();
    assert.equal(reply.status, 201, JSON.stringify(reply.body)); assert.ok(reply.body.review);
    return reply.body.review;
  };
  // Capacity admission supplies the real key/body binding without running all seat insertions.
  // Release it and stop after zero or one real seat transaction: the persisted restart boundary.
  const held = await post({ ...reviewInput, landing_rank: 2 });
  assert.equal(held.status, 201); assert.ok(held.body.review);
  const id = held.body.review.id;
  assert.equal(held.body.review.admissionState, 'queued-for-capacity');
  assert.equal(store.releaseReview(id), true);
  const setup = store.review(id)! as StoredReview;
  if (submitted) git('worktree', 'add', '--detach', setup.worktree, head);
  delete setup.preparing;
  store.updateReview(id, 'running', setup);
  // RED author R13: bind the request literal to NewRequest (types only, lead 10-26).
  const child = submitted ? store.submitReviewSeat(id, { requester: reviewInput.requester, project: 'review',
    kind: 'code', mutating: false, cwd: setup.worktree, ...seats[0]!, priority: 'background',
    repository: reviewInput.repository, head, base, evidenceVersion: reviewInput.evidenceVersion,
    policyVersion: reviewInput.policyVersion, prompt: 'Review the inert fixture.', reason: reviewInput.reason } as NewRequest,
  { ...seats[0]!, family: 'openai', setupCancelled: false }) : undefined;
  assert.equal(Object.hasOwn(reviewInput, 'idempotencyKey'), false);
  assert.equal(getReview(store, id)!.seats.length, submitted ? 1 : 0);
  assert.equal(getReview(store, id)!.setupFailed, false, 'refresh, not the fixture, must diagnose the missing seat');
  const claim = () => {
    assert.ok(child);
    const started = store!.startAttempt(child.id, { id: 'codex', provider: 'codex', enabled: true,
      maxConcurrency: 10, loginDir: root, fingerprint: 'fixture' }, { accountId: 'codex', model: 'gpt-6-astra',
      observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.8 }, grant: ['Read'] });
    assert.ok(started.ok, 'inert fixture uses a real atomic claim');
    return started.attempt.id;
  };
  const openAttempt = running ? claim() : undefined;
  store.close(); store = new Store(path); await connect();
  assert.equal(getReview(store, id)!.seats.length, submitted ? 1 : 0, 'partial insertion survives a real Store reopen');
  if (openAttempt) assert.deepEqual(store.openAttempts().map(a => ({ id: a.id, endedAt: a.endedAt, closedAt: a.closedAt })),
    [{ id: openAttempt, endedAt: null, closedAt: null }], 'restart preserves ownership of the running child');
  refreshReviews(store, (_where, error) => errors.push(error), env);
  const first = getReview(store, id)!;
  assert.equal(first.setupFailed, true);
  const missing = first.seats.filter(s => s.requestId === '');
  assert.equal(missing.length, submitted ? 1 : 2);
  assert.ok(missing.every(s => s.status === 'failed' && s.setupCancelled && /^never submitted:/.test(s.reason!)));
  assert.equal(first.state, submitted ? 'running' : 'finished');
  return { first, child, post, create, claim, get store() { return store!; },
    effects: () => ({ reviews: store!.runningReviewIds(), requests: store!.list(),
      attempts: store!.list().flatMap(r => store!.attempts(r.id)), worktrees: git('worktree', 'list', '--porcelain') }),
    finish(attempt: string) {
      assert.equal(store!.noteClosed(attempt), true, 'inert runner has no process or streams');
      assert.equal(store!.finishAttempt(attempt, { kind: 'completed', result: 'No verdict from this inert fixture.' }).recorded, true);
    } };
}

test('R13 F1 setup failure cannot duplicate a queued or running submitted child after restart', async t => {
  const observations = [];
  for (const state of ['queued', 'running'] as const) {
    const f = await fixture(t, true, state === 'running');
    assert.equal(f.store.get(f.child!.id)!.state, state);
    assert.equal(f.store.openAttempts().length, state === 'running' ? 1 : 0);
    const original = getReview(f.store, f.first.id), before = f.effects(), reply = await f.post();
    observations.push({ state, safeResponse: reply.status === 201
      ? reply.body.review?.id === f.first.id && reply.body.review?.reuse?.requestId === f.first.id
      : reply.status >= 400 && reply.status < 600 && !reply.body.review,
    children: f.store.list().length, unchanged: isDeepStrictEqual(f.effects(), before),
    originalRetained: isDeepStrictEqual(getReview(f.store, f.first.id), original) });
  }
  assert.deepEqual(observations, ['queued', 'running'].map(state => ({ state, safeResponse: true,
    children: 1, unchanged: true, originalRetained: true })),
  'setupFailed cannot authorize a second review, checkout or native execution while a submitted child is live');
});

test('R13 F1 terminal submitted child permits replacement with predecessorId after restart', async t => {
  const f = await fixture(t, true), attempt = f.claim();
  f.finish(attempt); // Resend before any refresh projects this terminal native outcome.
  assert.equal(f.store.get(f.child!.id)!.state, 'completed');
  assert.deepEqual(f.store.openAttempts(), []);
  const original = getReview(f.store, f.first.id), child = f.store.get(f.child!.id), history = f.store.attempts(f.child!.id);
  const next = await f.create();
  assert.notEqual(next.id, f.first.id); assert.equal(next.predecessorId, f.first.id);
  assert.equal(next.admissionKey, f.first.admissionKey); assert.equal(next.reuse, null);
  assert.equal(f.store.list().length, 3); assert.equal(next.seats.length, 2);
  assert.ok(next.seats.every(s => s.requestId !== f.child!.id)); assert.deepEqual(next.receipt.votes, []);
  assert.deepEqual(getReview(f.store, f.first.id), original);
  assert.deepEqual(f.store.get(f.child!.id), child); assert.deepEqual(f.store.attempts(f.child!.id), history);
  const before = f.effects(), replay = await f.create();
  assert.equal(replay.id, next.id); assert.equal(replay.reuse?.requestId, next.id);
  assert.deepEqual(f.effects(), before, 'later resends follow the replacement binding exactly once');
});

test('R13 F1 control: setup failure without a submitted child permits immediate replacement', async t => {
  const f = await fixture(t, false), original = getReview(f.store, f.first.id);
  assert.deepEqual(f.store.list(), []); assert.deepEqual(f.store.openAttempts(), []);
  const next = await f.create();
  assert.notEqual(next.id, f.first.id); assert.equal(next.predecessorId, f.first.id);
  assert.equal(next.admissionKey, f.first.admissionKey); assert.equal(next.reuse, null);
  assert.equal(f.store.list().length, 2); assert.equal(next.seats.length, 2);
  assert.deepEqual(next.receipt.votes, []); assert.deepEqual(getReview(f.store, f.first.id), original);
});

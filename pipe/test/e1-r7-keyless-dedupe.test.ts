/** Independent R7 oracle: a ruling supersedes unconditional keyless reuse.
 * A terminal failure is history, never a successful resend. Existing assertions stay untouched.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { startHttp } from '../src/http.ts';
import { getReview, refreshReviews, submitReview } from '../src/review.ts';
import { Store, type AttemptOutcome } from '../src/store.ts';

type Namespace = 'request' | 'review';
type Phase = 'failed' | 'cancelled' | 'setupFailed' | 'completed' | 'running' | 'queued';
type PublicAdmission = { id: string; admissionKey: string; dispatchClass: string;
  reuse: { requestId: string; verdict: string | null; timeSavedMs: number | null } | null;
  receipt?: unknown; seats?: Array<{ requestId: string }> };
type Reply = { status: number; body: { request?: PublicAdmission; review?: PublicAdmission;
  error?: { code: string; message: string } } };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const, 'gpt-6.1-sol': 'default' as const },
  efforts: ['high', 'medium'] }, claude: { models: { opus: 'hard' as const }, efforts: ['high', 'medium'] } };
const seats = [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
  { provider: 'claude', model: 'opus', effort: 'high' }];

async function fixture(t: TestContext) {
  // Same isolated SQLite and socket-free HTTP pattern as e1-admission.test.ts; no provider runs.
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-e1-r7-'));
  const repo = join(root, 'repo'), trees = join(root, 'reviews');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'fixture.txt'), 'head\n'); git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  let clock = Date.parse('2026-10-25T20:00:00Z'), dispatches = 0;
  const store = new Store(join(root, 'record.sqlite'), { now: () => new Date(clock), retryBackoffMs: 1 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const common = { requester: 'fixture', project: 'fixture', reason: 'explicit high effort for the independent lifecycle oracle',
    repository: 'fixture/repository', head, base, evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1',
    contextPacket: 'Context packet A.' };
  const jobInput = { ...common, kind: 'code', mutating: true, provider: 'codex', model: 'gpt-6-astra', effort: 'high',
    cwd: repo, priority: 'interactive', prompt: 'Check the inert fixture.' };
  const reviewInput = { ...common, repo, brief: jobInput.prompt, seats };
  let capacity = false;
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
  });
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', policy, store, env, accounts: () => [], models: () => ({}),
    accountIds: () => ['codex', 'claude'], draining: () => false, drain: async () => {}, cancel: () => {},
    log: () => {}, reviews: {
      submit: input => submitReview(store, policy, trees, input, env,
        capacity ? { E6_CAPACITY_HOOK: true, landing_rank_bound: 1 } : {}),
      get: id => getReview(store, id), vote: () => undefined,
    } });
  const send = (namespace: Namespace, input: unknown): Promise<Reply> => new Promise(resolve => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
      method: 'POST', url: namespace === 'request' ? '/v1/requests' : '/v1/reviews',
      headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    });
    let status = 0;
    handler!(request as IncomingMessage, { writeHead(code: number) { status = code; },
      end(data: string) { resolve({ status, body: JSON.parse(data) }); } } as ServerResponse);
  });
  const claim = (id: string) => {
    const r = store.get(id)!;
    const account = { id: r.provider, provider: r.provider, enabled: true, maxConcurrency: 10,
      loginDir: root, fingerprint: 'fixture' };
    const started = store.startAttempt(id, account, { accountId: account.id, model: r.model,
      observedAt: new Date(clock).toISOString(), verdict: { state: 'available', headroom: 0.8 }, grant: ['Read'] });
    assert.ok(started.ok, `fixture must claim ${id}: ${!started.ok && started.reason}`);
    dispatches++;
    return started.attempt.id;
  };
  const finish = (id: string, outcome: AttemptOutcome) => {
    clock += 1_000;
    assert.equal(store.noteClosed(id), true, 'the fake runner has no process or streams');
    assert.equal(store.finishAttempt(id, outcome).recorded, true);
  };
  const complete = (id: string) => finish(claim(id), { kind: 'completed',
    result: JSON.stringify({ verdict: 'APPROVE', head, findings: [], unknowns: [] }) });
  const finishReview = async (id: string) => {
    const deadline = performance.now() + 10_000;
    do {
      refreshReviews(store, (_where, error) => { throw error; }, env);
      const review = getReview(store, id)!;
      if (review.state === 'finished') return review;
      await delay(10);
    } while (performance.now() < deadline);
    assert.fail('fixture review did not reach its terminal state');
  };
  const effects = () => ({ requests: store.list().map(r => ({ id: r.id, state: r.state,
    attempts: store.attempts(r.id).map(a => ({ id: a.id, endedAt: a.endedAt, closedAt: a.closedAt })) })),
    worktrees: git('worktree', 'list', '--porcelain'), dispatches });
  return { store, send, jobInput, reviewInput, claim, finish, complete, finishReview, effects,
    advance(ms: number) { clock += ms; },
    holdReviews() { capacity = true; },
    executeQueued() { for (const r of store.list('queued')) complete(r.id); } };
}

async function original(t: TestContext, namespace: Namespace, phase: Phase) {
  const f = await fixture(t);
  const input = namespace === 'request' ? f.jobInput : { ...f.reviewInput, ...(phase === 'queued' ? { landing_rank: 2 } : {}) };
  assert.equal(Object.hasOwn(input, 'idempotencyKey'), false, 'all R40 cases are keyless');
  if (namespace === 'review' && phase === 'queued') f.holdReviews();
  // Exercise the actual setup-failure catch and durable flag, without a malformed stored review.
  const failure = namespace === 'review' && phase === 'setupFailed'
    ? t.mock.method(f.store, 'submitReviewSeat', () => { throw new Error('injected pre-seat setup failure'); }) : undefined;
  const first = await f.send(namespace, input);
  failure?.mock.restore();
  assert.equal(first.status, failure ? 500 : 201, JSON.stringify(first.body));
  const id = failure ? f.store.runningReviewIds()[0]! : first.body[namespace]!.id;
  assert.ok(id);
  const ids = namespace === 'request' ? [id] : getReview(f.store, id)!.seats.map(s => s.requestId);
  if (phase === 'setupFailed' && namespace === 'request') {
    // Requests have no setupFailed field: two closed, untouched setup timeouts are the real terminal path.
    for (let n = 0; n < 2; n++) {
      f.finish(f.claim(id), { kind: 'failed', errorKind: 'setup_timeout', message: 'injected setup deadline', untouched: true });
      f.advance(1); // Cross the recorded back-off before the second claim.
    }
    assert.equal(f.store.get(id)!.error?.kind, 'setup_timeout');
  } else if (phase !== 'queued' && phase !== 'setupFailed') for (const requestId of ids) {
    if (phase === 'cancelled') assert.equal(f.store.cancel(requestId), true);
    else if (phase === 'running') f.claim(requestId);
    else if (phase === 'completed') f.complete(requestId);
    else f.finish(f.claim(requestId), { kind: 'failed', errorKind: 'other', message: 'injected terminal failure' });
  }
  if (namespace === 'review' && !['queued', 'running'].includes(phase)) await f.finishReview(id);
  if (namespace === 'request') assert.equal(f.store.get(id)!.state, phase === 'setupFailed' ? 'failed' : phase);
  else {
    const review = getReview(f.store, id)!;
    assert.equal(review.state, phase === 'queued' ? 'queued-for-capacity' : phase === 'running' ? 'running' : 'finished');
    assert.equal(review.setupFailed, phase === 'setupFailed');
    if (phase === 'completed') assert.equal(review.receipt.quorum.approved, true);
    if (phase === 'failed' || phase === 'cancelled') {
      assert.ok(ids.length > 0);
      for (const requestId of ids) assert.equal(f.store.get(requestId)!.state, phase);
    }
  }
  const expectedKey = sha256(JSON.stringify([input.repository, input.head, input.base,
    namespace === 'request' ? ['openai'] : ['anthropic', 'openai'],
    sha256(f.jobInput.prompt), input.evidenceVersion, input.policyVersion]));
  assert.equal((namespace === 'request' ? f.store.get(id) : getReview(f.store, id))!.admissionKey, expectedKey,
    'independent seven-field tuple oracle; packet/model/effort/reason are outside this tuple');
  return { ...f, input, id, expectedKey };
}

// R40 specifies predecessor provenance but no new field spelling. Inspect the public receipt for the exact
// prior execution ID outside reuse, without importing identity code or inventing an API property name.
function namesPrior(value: unknown, priorId: string): boolean {
  if (value === priorId) return true;
  return value !== null && typeof value === 'object' && Object.entries(value)
    .some(([key, entry]) => key !== 'reuse' && namesPrior(entry, priorId));
}

for (const namespace of ['request', 'review'] as const) {
  for (const phase of ['failed', 'cancelled', 'setupFailed'] as const) {
    test(`R40 ${namespace}: ${phase} original creates a new execution and names its predecessor`, async t => {
      const f = await original(t, namespace, phase), before = f.effects();
      const response = await f.send(namespace, f.input);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const next = response.body[namespace]!;
      assert.deepEqual({ newId: next.id !== f.id, key: next.admissionKey, reuse: next.reuse,
        namesPrior: namesPrior({ ...next, id: undefined }, f.id), newRequests: f.store.list().length - before.requests.length },
      { newId: true, key: f.expectedKey, reuse: null, namesPrior: true, newRequests: namespace === 'request' ? 1 : 2 },
      'terminal failure/cancellation/setup failure must not reuse an original or its decision');
      if (namespace === 'review') {
        assert.deepEqual(getReview(f.store, next.id)!.receipt.votes, [], 'a fresh review borrows no votes');
        assert.equal(getReview(f.store, next.id)!.setupFailed, false);
      }
      f.executeQueued();
      assert.equal(f.effects().dispatches - before.dispatches, namespace === 'request' ? 1 : 2);
      assert.ok(namespace === 'request' ? f.store.get(f.id) : getReview(f.store, f.id), 'keep the predecessor record');
    });
  }

  for (const phase of ['completed', 'running', 'queued'] as const) {
    test(`R40 ${namespace}: ${phase} original reuses a full match without new dispatch`, async t => {
      const f = await original(t, namespace, phase), before = f.effects();
      const receipt = namespace === 'review' ? getReview(f.store, f.id)!.receipt : undefined;
      const response = await f.send(namespace, f.input);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const next = response.body[namespace]!;
      assert.equal(next.id, f.id);
      assert.equal(next.admissionKey, f.expectedKey);
      assert.equal(next.dispatchClass, 'repeat');
      assert.deepEqual(next.reuse, { requestId: f.id,
        verdict: namespace === 'review' && phase === 'completed' ? 'APPROVE' : null,
        timeSavedMs: phase === 'completed' ? namespace === 'review' ? 2_000 : 1_000 : null });
      if (namespace === 'review') assert.deepEqual(next.receipt, receipt);
      if (phase === 'completed') f.executeQueued();
      assert.deepEqual(f.effects(), before, 'no extra requests, attempts, worktrees or dispatches');
    });
  }

  // Each changed body remains policy-valid and preserves the independently checked tuple.
  for (const phase of ['completed', 'running', 'queued'] as const) for (const field of ['model', 'effort', 'reason', 'packet hash'] as const) {
    test(`R40 ${namespace}: ${phase} original conflicts on changed ${field} within the same tuple`, async t => {
      const f = await original(t, namespace, phase), before = f.effects();
      const changed = field === 'packet hash' ? { contextPacket: 'Context packet B.' }
        : field === 'reason' ? { reason: 'a different policy-valid execution rationale' }
        : namespace === 'request' ? { [field]: field === 'model' ? 'gpt-6.1-sol' : 'medium' }
        : { seats: seats.map((seat, i) => i ? seat : { ...seat, [field]: field === 'model' ? 'gpt-6.1-sol' : 'medium' }) };
      const response = await f.send(namespace, { ...f.input, ...changed });
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.error?.code, 'idempotency_conflict');
      assert.equal(typeof response.body.error?.message, 'string');
      assert.equal(response.body.request, undefined);
      assert.equal(response.body.review, undefined);
      if (phase === 'completed') f.executeQueued();
      assert.deepEqual(f.effects(), before, 'conflict precedes checkout, child creation and dispatch');
    });
  }
}

test('R40 identical keyless tuples remain independent across request and review namespaces', async t => {
  const f = await fixture(t);
  const request = await f.send('request', f.jobInput);
  const review = await f.send('review', { ...f.reviewInput, seats: [seats[0]!] });
  assert.equal(request.status, 201); assert.equal(review.status, 201);
  const job = request.body.request!, decision = review.body.review!;
  assert.equal(job.admissionKey, decision.admissionKey, 'same tuple has the same key, independent of endpoint');
  assert.notEqual(job.id, decision.id);
  assert.equal(job.reuse, null); assert.equal(decision.reuse, null);
  const before = f.effects();
  assert.equal((await f.send('request', f.jobInput)).body.request!.reuse?.requestId, job.id);
  assert.equal((await f.send('review', { ...f.reviewInput, seats: [seats[0]!] })).body.review!.reuse?.requestId, decision.id);
  assert.deepEqual(f.effects(), before);
});

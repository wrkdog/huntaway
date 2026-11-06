/** Independent R11 oracles for keyless reuse and child outcomes, plus F1/F2/F3.
 * Lesson/rule: native terminal outcomes determine replacement without a refresh; an open
 * attempt still owns its execution, and drain/Stop precedes conflicts and git preflight.
 * Evidence: these RED cases use real claims/outcomes and the service's admission callback.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
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
import { startPipe } from '../src/service.ts';
import { Store } from '../src/store.ts';

type Review = NonNullable<ReturnType<typeof getReview>>;
type Reply = { status: number; body: { review?: Review; error?: { code: string }; draining?: boolean } };
const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const, 'gpt-6.1-sol': 'default' as const }, efforts: ['high'] },
  claude: { models: { opus: 'default' as const }, efforts: ['high'] } };
const seats = [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
  { provider: 'claude', model: 'opus', effort: 'high' }];

async function until(label: string, check: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() >= deadline) assert.fail(`fixture deadline: ${label}`);
    await delay(5);
  }
}

async function fixture(t: TestContext, service = false) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-e1-r11-'));
  const repo = join(root, 'repo'), trees = join(root, 'reviews'), path = join(root, 'record.sqlite');
  let store: Store | undefined, pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  let pendingClose: (() => void) | undefined, deferClose = false;
  t.after(async () => {
    deferClose = false; pendingClose?.();
    await pipe?.stop();
    store?.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'fixture.txt'), 'head\n'); git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  const reviewInput = { requester: 'requester-a', repository: 'fixture/repository', repo, head, base, seats,
    brief: 'Check omission, clock steps, malformed values and cross-account evidence.',
    evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1',
    reason: 'Astra and Opus at high effort exercise the independent admission oracle' };
  let gitCalls = 0;
  const realSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof realSpawn>) => {
    if (args[0] === 'git') gitCalls++;
    return realSpawn(...args);
  });
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
    closeAllConnections() {}, close(done: () => void) { if (deferClose) pendingClose = done; else done(); },
  });
  // Retain the real handler and service callback; replace only socket transport and observe git.
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  const token = 'e1-r11-fixture-token-with-32-characters';
  if (service) {
    // No accounts means no provider probes or dispatch. Claims below are inert Store transitions.
    pipe = await startPipe({ accounts: [], policy, storePath: path, worktreeRoot: trees, workDir: root,
      cli: {}, env, token, port: 0, minFreeGb: 0, tickMs: 60_000,
      E6_CAPACITY_HOOK: true, landing_rank_bound: 1 });
    store = new Store(path);
  } else {
    store = new Store(path);
    await startHttp({ token, policy, store, env, accounts: () => [], models: () => ({}), accountIds: () => [],
      draining: () => false, drain: async () => {}, cancel: () => {}, log: () => {}, reviews: {
        submit: input => submitReview(store!, policy, trees, input, env),
        get: id => getReview(store!, id), vote: () => undefined,
      } });
  }
  const send = (method: string, url: string, input?: unknown): Promise<Reply> => new Promise(resolve => {
    const request = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), {
      method, url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    let status = 0;
    handler!(request as IncomingMessage, { writeHead(code: number) { status = code; },
      end(data: string) { resolve({ status, body: JSON.parse(data) }); } } as ServerResponse);
  });
  const post = (input: unknown = reviewInput) => send('POST', '/v1/reviews', input);
  const create = async () => {
    const reply = await post();
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.ok(reply.body.review);
    return reply.body.review;
  };
  const claim = (requestId: string) => {
    const r = store!.get(requestId)!;
    const started = store!.startAttempt(requestId, { id: r.provider, provider: r.provider, enabled: true,
      maxConcurrency: 10, loginDir: root, fingerprint: 'fixture' }, { accountId: r.provider, model: r.model,
      observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.8 }, grant: ['Read'] });
    assert.ok(started.ok, 'inert fixture uses a real atomic claim');
    return started.attempt.id;
  };
  const complete = (requestId: string, result: string) => {
    const attempt = claim(requestId);
    assert.equal(store!.noteClosed(attempt), true, 'the in-process fake runner has no process or streams');
    assert.equal(store!.finishAttempt(attempt, { kind: 'completed', result }).recorded, true);
    assert.equal(store!.get(requestId)!.state, 'completed');
  };
  return { reviewInput, post, create, claim, complete, get store() { return store!; },
    gitCalls: () => gitCalls,
    refresh() { refreshReviews(store!, (_where, error) => { throw error; }, env); },
    effects: () => ({ reviews: store!.runningReviewIds(), requests: store!.list(),
      attempts: store!.list().flatMap(r => store!.attempts(r.id)), worktrees: git('worktree', 'list', '--porcelain') }),
    async pause(boundary: 'draining' | 'stopped') {
      assert.ok(pipe);
      if (boundary === 'draining') {
        const reply = await send('POST', '/v1/drain?wait=0');
        assert.equal(reply.status, 200); assert.equal(reply.body.draining, true);
      } else {
        // Hold transport close so an already accepted handler can observe the real Stop flag.
        deferClose = true;
        const stopping = pipe.stop();
        await until('Stop reached transport close', () => pendingClose !== undefined);
        void stopping; // Teardown releases close and awaits the same stop promise.
      }
    },
  };
}

for (const outcomes of ['failed-and-approve', 'two-non-verdicts'] as const) {
  test(`R11 F1 keyless ${outcomes} children require replacement without refresh`, async t => {
    const f = await fixture(t), first = await f.create(), [a, b] = first.seats;
    assert.equal(Object.hasOwn(f.reviewInput, 'idempotencyKey'), false);
    assert.equal(first.seats.length, 2);
    if (outcomes === 'failed-and-approve') {
      assert.equal(f.store.fail(a!.requestId, 'injected terminal child failure'), true);
      f.complete(b!.requestId, JSON.stringify({ verdict: 'APPROVE', head: first.head, findings: [], unknowns: [] }));
    } else {
      f.complete(a!.requestId, 'completed analysis without a verdict');
      f.complete(b!.requestId, 'completed analysis without a verdict');
    }
    const ids = first.seats.map(s => s.requestId);
    assert.deepEqual(ids.map(id => f.store.get(id)!.state), outcomes === 'failed-and-approve'
      ? ['failed', 'completed'] : ['completed', 'completed']);
    assert.deepEqual(f.store.openAttempts(), []);
    const original = getReview(f.store, first.id)!;
    assert.equal(original.state, 'running');
    assert.ok(original.seats.every(s => s.status === 'waiting'), 'no refresh projected the native outcomes');
    assert.deepEqual(original.receipt.votes, []);
    const history = ids.map(id => ({ request: f.store.get(id), attempts: f.store.attempts(id) }));
    const next = await f.create(); // No refresh, review GET callback or service tick between outcomes and resend.
    assert.deepEqual({ newId: next.id !== first.id, predecessorId: next.predecessorId, reuse: next.reuse,
      childCount: f.store.list().length, votes: next.receipt.votes },
    { newId: true, predecessorId: first.id, reuse: null, childCount: 4, votes: [] },
    'terminal unsuccessful native children require a fresh execution even while seat projections are stale');
    assert.equal(next.admissionKey, first.admissionKey);
    assert.ok(next.seats.every(s => !ids.includes(s.requestId)));
    assert.deepEqual(ids.map(id => ({ request: f.store.get(id), attempts: f.store.attempts(id) })), history);
    assert.deepEqual(getReview(f.store, first.id), original, 'preserve the original review and receipt');
    const before = f.effects(), replay = await f.create();
    assert.equal(replay.id, next.id); assert.equal(replay.reuse?.requestId, next.id);
    assert.deepEqual(f.effects(), before, 'subsequent resends reuse only the new execution');
  });
}

for (const active of ['queued', 'running'] as const) {
  test(`R11 F1 control: failed plus ${active} native children still reuse`, async t => {
    const f = await fixture(t), first = await f.create(), [failed, live] = first.seats;
    assert.equal(f.store.fail(failed!.requestId, 'injected terminal child failure'), true);
    if (active === 'running') f.claim(live!.requestId);
    assert.deepEqual(first.seats.map(s => f.store.get(s.requestId)!.state), ['failed', active]);
    const before = f.effects(), replay = await f.create();
    assert.equal(replay.id, first.id); assert.equal(replay.reuse?.requestId, first.id);
    assert.deepEqual(f.effects(), before, 'one live child prevents duplicate execution');
  });
}

for (const boundary of ['draining', 'stopped'] as const) {
  test(`R11 F2 conflicting replay while ${boundary} returns admission_paused before conflict`, async t => {
    const f = await fixture(t, true), first = await f.create();
    assert.ok(first.seats.every(s => f.store.get(s.requestId)!.state === 'queued'));
    const conflict = { ...f.reviewInput, reason: 'A different reason conflicts with the same computed admission key' };
    const openReply = await f.post(conflict);
    assert.equal(openReply.status, 409, 'control: this body really conflicts while admission is open');
    assert.equal(openReply.body.error?.code, 'idempotency_conflict');
    await f.pause(boundary);
    const before = f.effects(), gitBefore = f.gitCalls(), reply = await f.post(conflict);
    assert.deepEqual({ status: reply.status, code: reply.body.error?.code, review: reply.body.review,
      gitCalls: f.gitCalls() - gitBefore },
    { status: 503, code: 'admission_paused', review: undefined, gitCalls: 0 });
    assert.deepEqual(f.effects(), before, 'paused conflicts leave the reusable original untouched');
  });

  test(`R11 F2 new admission while ${boundary} returns admission_paused before any git preflight`, async t => {
    const f = await fixture(t, true);
    await f.create();
    assert.ok(f.gitCalls() > 0, 'control: the observer sees real git preflight and checkout');
    await f.pause(boundary);
    const before = f.effects(), gitBefore = f.gitCalls();
    const reply = await f.post({ ...f.reviewInput, brief: 'A distinct new review admission.' });
    assert.deepEqual({ status: reply.status, code: reply.body.error?.code, review: reply.body.review,
      gitCalls: f.gitCalls() - gitBefore },
    { status: 503, code: 'admission_paused', review: undefined, gitCalls: 0 },
    'paused admission must refuse before even read-only repository preflight');
    assert.deepEqual(f.effects(), before, 'paused new admission creates no review, children or checkout');
  });
}

for (const refreshed of [false, true]) {
  test(`R11 F3 cancelled child with open attempt prevents replacement ${refreshed ? 'after' : 'before'} refresh`, async t => {
    const f = await fixture(t), first = await f.create(), [failed, closing] = first.seats;
    assert.equal(f.store.fail(failed!.requestId, 'injected terminal child failure'), true);
    const attempt = f.claim(closing!.requestId);
    assert.equal(f.store.cancel(closing!.requestId), true);
    assert.equal(f.store.get(closing!.requestId)!.state, 'cancelled');
    assert.deepEqual(f.store.openAttempts().map(a => ({ id: a.id, endedAt: a.endedAt, closedAt: a.closedAt })),
      [{ id: attempt, endedAt: null, closedAt: null }], 'cancellation has not proved seat process closure');
    if (refreshed) {
      f.refresh();
      const projected = getReview(f.store, first.id)!;
      assert.equal(projected.state, 'running');
      assert.deepEqual(projected.seats.map(s => s.status), ['failed', 'waiting'],
        'refresh retains the cancelled child as waiting while its attempt remains open');
    }
    const before = f.effects(), replay = await f.create();
    assert.deepEqual({ id: replay.id, reuseId: replay.reuse?.requestId, childCount: f.store.list().length },
      { id: first.id, reuseId: first.id, childCount: 2 },
      'admission must agree with refresh: no replacement while the predecessor seat is still closing');
    assert.deepEqual(f.effects(), before);
    assert.equal(f.store.noteClosed(attempt), true, 'the inert runner now has no process or streams');
    assert.equal(f.store.finishAttempt(attempt, { kind: 'cancelled' }).recorded, true);
    const next = await f.create();
    assert.notEqual(next.id, first.id);
    assert.equal(next.predecessorId, first.id); assert.equal(next.reuse, null);
  });
}

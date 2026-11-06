/** Independent R8 oracles: E1 durable explicit bindings, R40 terminal-failure exclusion,
 * and service drain/stop admission. Lesson/rule: replay must preserve the stored grant
 * and current admission boundary; cleanup-pending is not proof of reusable execution.
 * Evidence is this RED packet; additions-only scope leaves existing lessons/tests intact.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

type Namespace = 'request' | 'review';
type Admission = { id: string; admissionKey: string; dispatchClass: string; predecessorId?: string | null;
  reuse: { requestId: string } | null; seats?: Array<{ requestId: string }> };
type Reply = { status: number; body: { request?: Admission; review?: Admission;
  error?: { code: string; message: string }; draining?: boolean; drained?: boolean } };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
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
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-e1-r8-'));
  const repo = join(root, 'repo'), trees = join(root, 'reviews'), path = join(root, 'record.sqlite');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'fixture.txt'), 'head\n'); git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  const common = { requester: 'fixture', project: 'fixture', repository: 'fixture/repository', head, base,
    evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1',
    reason: 'Astra and Opus at high effort exercise the independent admission oracle' };
  const prompt = 'Check omission, clock steps, malformed values and cross-account evidence.';
  const jobInput = { ...common, kind: 'code', mutating: true, provider: 'codex', model: 'gpt-6-astra',
    effort: 'high', cwd: repo, priority: 'interactive', prompt };
  const reviewInput = { ...common, repo, brief: prompt, seats };
  // Independent documented seven-field tuple, without importing the identity implementation.
  const computedKey = (namespace: Namespace) => sha256(JSON.stringify([common.repository, head, base,
    namespace === 'request' ? ['openai'] : ['anthropic', 'openai'], sha256(prompt), common.evidenceVersion, common.policyVersion]));

  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  let deferClose = false, pendingClose: (() => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
    closeAllConnections() {}, close(done: () => void) { if (deferClose) pendingClose = done; else done(); },
  });
  // Real HTTP handler and service callbacks; only the socket transport is replaced.
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  let store: Store | undefined, pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  t.after(async () => {
    deferClose = false; pendingClose?.();
    await pipe?.stop();
    store?.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const token = 'e1-r8-fixture-token-with-32-characters';
  if (service) {
    // No configured accounts means no provider probe or runner can execute.
    pipe = await startPipe({ accounts: [], policy, storePath: path, worktreeRoot: trees, workDir: root,
      cli: {}, env, token, port: 0, minFreeGb: 0, tickMs: 60_000,
      E6_CAPACITY_HOOK: true, landing_rank_bound: 1 });
    store = new Store(path); // Observer connection; admission stays in the real service's store.
  } else {
    store = new Store(path);
    await startHttp({ token, policy, get store() { return store!; }, env,
      accounts: () => [], models: () => ({}), accountIds: () => [], draining: () => false,
      drain: async () => {}, cancel: () => {}, log: () => {}, reviews: {
        submit: input => submitReview(store!, policy, trees, input, env),
        get: id => getReview(store!, id), vote: () => undefined,
      } });
  }
  const send = (url: string, input: unknown = {}): Promise<Reply> => new Promise(resolve => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
      method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    let status = 0;
    handler!(request as IncomingMessage, { writeHead(code: number) { status = code; },
      end(data: string) { resolve({ status, body: JSON.parse(data) }); } } as ServerResponse);
  });
  const post = (namespace: Namespace, input: unknown) => send(namespace === 'request' ? '/v1/requests' : '/v1/reviews', input);
  return { root, env, git, jobInput, reviewInput, computedKey, post, send,
    get store() { return store!; },
    reopen() { assert.equal(service, false); store!.close(); store = new Store(path); },
    effects: () => ({ requests: store!.list().map(r => ({ id: r.id, state: r.state, attempts: store!.attempts(r.id) })),
      worktrees: git('worktree', 'list', '--porcelain') }),
    async beginStop() {
      assert.ok(pipe);
      deferClose = true;
      // Model a callback already accepted before server.close: stopped is set synchronously,
      // while an outstanding transport close keeps the service store alive for that callback.
      const stopping = pipe.stop();
      await until('service reached transport close after setting stopped', () => pendingClose !== undefined);
      return { done: stopping };
    },
  };
}

for (const boundary of ['draining', 'stopped'] as const) test(`R8 F1 held review replay cannot release seats while ${boundary}`, async t => {
  const f = await fixture(t, true);
  const input = { ...f.reviewInput, idempotencyKey: 'held-boundary-review' };
  const first = await f.post('review', { ...input, landing_rank: 2 });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = first.body.review!.id, held = f.store.review(id)!;
  assert.equal(held.admissionState, 'queued-for-capacity');
  assert.deepEqual(held.seats, []);
  assert.equal(existsSync(held.worktree as string), false);
  if (boundary === 'draining') {
    const drained = await f.send('/v1/drain?wait=100');
    assert.equal(drained.status, 200);
    assert.equal(drained.body.draining, true);
    assert.equal(drained.body.drained, true);
  } else await f.beginStop();
  const before = f.effects();
  const replay = await f.post('review', { ...input, landing_rank: 1 });
  const current = f.store.review(id)!;
  assert.deepEqual({ refused: replay.status >= 400 && replay.status < 600,
    admissionGuard: /drain|stopp|shut/i.test(`${replay.body.error?.code} ${replay.body.error?.message}`),
    state: current.admissionState, seats: current.seats, heldSetup: current.capacitySetup,
    worktreeExists: existsSync(held.worktree as string), effects: f.effects() },
  { refused: true, admissionGuard: true, state: 'queued-for-capacity', seats: [], heldSetup: held.capacitySetup,
    worktreeExists: false, effects: before },
  'replay must refuse at the current service boundary without releasing durable setup or creating checkout/children');
});

for (const namespace of ['request', 'review'] as const) test(`R8 F2 ${namespace}: explicit computed-hash binding survives cancelled keyless resend and restart`, async t => {
  const f = await fixture(t), input = namespace === 'request' ? f.jobInput : f.reviewInput;
  const key = f.computedKey(namespace), explicit = { ...input, idempotencyKey: key };
  const first = await f.post(namespace, explicit);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const id = first.body[namespace]!.id;
  assert.equal(first.body[namespace]!.admissionKey, key, 'explicit key equals the independent computed-key oracle');
  const childIds = namespace === 'request' ? [id] : getReview(f.store, id)!.seats.map(seat => seat.requestId);
  assert.ok(childIds.length > 0);
  for (const childId of childIds) assert.equal(f.store.cancel(childId), true);
  if (namespace === 'review') {
    refreshReviews(f.store, (_where, error) => { throw error; }, f.env);
    await until('cancelled review cleanup completes', () => getReview(f.store, id)!.state === 'finished');
  }
  f.reopen();
  const before = f.effects();
  assert.equal(Object.hasOwn(input, 'idempotencyKey'), false);
  const keyless = await f.post(namespace, input);
  assert.equal(keyless.status, 201, JSON.stringify(keyless.body));
  f.reopen();
  const replay = await f.post(namespace, explicit);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  // Check the final explicit receipt too: a keyless caller must not move an explicit binding.
  assert.deepEqual({ keylessId: keyless.body[namespace]!.id, keylessReuse: keyless.body[namespace]!.reuse?.requestId,
    explicitId: replay.body[namespace]!.id, explicitReuse: replay.body[namespace]!.reuse?.requestId, effects: f.effects() },
  { keylessId: id, keylessReuse: id, explicitId: id, explicitReuse: id, effects: before },
  'stored explicit-key semantics survive an incoming keyless identity with the same key/body; no replacement execution');
});

for (const outcome of ['failed', 'invalid'] as const) for (const failures of [1, 9, 10]) {
  test(`R8 F3 keyless review with ${outcome} seats is not reusable after ${failures} failed removals`, async t => {
    const f = await fixture(t), first = await f.post('review', f.reviewInput);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const id = first.body.review!.id, original = f.store.review(id)!;
    const children = getReview(f.store, id)!.seats.map(seat => seat.requestId);
    assert.equal(children.length, 2);
    for (const requestId of children) {
      if (outcome === 'failed') assert.equal(f.store.fail(requestId, 'injected terminal seat failure'), true);
      else {
        const r = f.store.get(requestId)!;
        const claim = f.store.startAttempt(requestId, { id: r.provider, provider: r.provider, enabled: true,
          maxConcurrency: 10, loginDir: f.root, fingerprint: 'fixture' }, { accountId: r.provider, model: r.model,
          observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.8 }, grant: ['Read'] });
        assert.ok(claim.ok);
        assert.equal(f.store.noteClosed(claim.attempt.id), true, 'in-process fake runner has no process or streams');
        assert.equal(f.store.finishAttempt(claim.attempt.id, { kind: 'completed', result: 'not a review verdict' }).recorded, true);
      }
    }
    // Real Git refuses --force removal of a locked worktree; do not forge review rows or cleanup counters.
    f.git('worktree', 'lock', original.worktree as string, '--reason', 'independent cleanup failure fixture');
    const removalErrors: unknown[] = [];
    for (let n = 1; n <= failures; n++) {
      refreshReviews(f.store, (where, error) => {
        if (!where.startsWith('remove review worktree ')) throw error;
        removalErrors.push(error);
      }, f.env);
      await until(`recorded removal failure ${n}`, () => {
        const current = f.store.review(id)!;
        return n === 10 ? current.state === 'finished' : current.cleanupFailures === n;
      });
    }
    assert.ok(removalErrors.length > 0, 'the real removal command failed');
    assert.equal(f.store.review(id)!.state, failures === 10 ? 'finished' : 'running');
    assert.ok(getReview(f.store, id)!.seats.every(seat => seat.status === outcome));
    assert.deepEqual(getReview(f.store, id)!.receipt.votes, []);
    assert.equal(existsSync(original.worktree as string), true, 'failed cleanup retains the original checkout');
    assert.deepEqual(f.store.openAttempts(), []);
    f.reopen(); // Eligibility must survive restart without relying on a pending refresh task.
    const before = f.effects(), predecessor = f.store.review(id);
    const replay = await f.post('review', f.reviewInput);
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    const next = replay.body.review!;
    assert.deepEqual({ differentId: next.id !== id, reuse: next.reuse, predecessorId: next.predecessorId,
      addedRequests: f.store.list().length - before.requests.length },
    { differentId: true, reuse: null, predecessorId: id, addedRequests: 2 },
    'terminal failed/invalid seats cannot become a repeat merely because checkout cleanup is pending');
    assert.deepEqual(f.store.review(id), predecessor, 'keep original failure/cleanup evidence');
    assert.deepEqual(getReview(f.store, next.id)!.receipt.votes, [], 'new execution borrows no decision');
    assert.deepEqual(f.store.openAttempts(), [], 'setup alone runs; no provider is dispatched');
  });
}

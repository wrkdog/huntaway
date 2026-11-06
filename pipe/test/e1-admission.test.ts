/** Independent RED packet for idempotent admission. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { startHttp } from '../src/http.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import { getReview, refreshReviews, submitReview } from '../src/review.ts';
import { Store } from '../src/store.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const seats = [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' },
  { provider: 'claude', model: 'opus', effort: 'high' }];
const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const }, efforts: ['high'] },
  claude: { models: { opus: 'hard' as const }, efforts: ['high'] } };
type CapacityOptions = NonNullable<Parameters<typeof submitReview>[5]> & {
  E6_CAPACITY_HOOK?: boolean; landing_rank_bound?: number;
};
type Admission = { id: string; admissionKey?: string; dispatchClass?: string; admissionState?: string;
  reuse?: { requestId: string; verdict: string | null; timeSavedMs: number | null } | null };
type Reply = { status: number; body: { request?: Admission; review?: Admission;
  requests?: Admission[]; error?: { code: string; message: string } } };

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-e1-admission-'));
  const repo = join(root, 'repo'), trees = join(root, 'review-trees'), jobs = join(root, 'fake-worktrees');
  mkdirSync(repo); mkdirSync(jobs);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'fixture.txt'), 'head\n'); git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  const path = join(root, 'pipe.sqlite');
  let clock = Date.parse('2026-10-25T16:30:00Z');
  const open = () => new Store(path, { now: () => new Date(clock) });
  let store = open(), capacity: CapacityOptions = {};
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const reviewInput = { requester: 'fixture', reason: 'independent admission review', repository: 'fixture/repository',
    repo, head, base, brief: 'Check omission, clock steps, malformed values and cross-account evidence.',
    seats, evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1' };
  const jobInput = { requester: 'fixture', project: 'fixture', kind: 'code', mutating: true,
    provider: 'codex', model: 'gpt-6-astra', effort: 'high', reason: 'deterministic fake executor',
    priority: 'interactive', cwd: repo, prompt: 'Change the inert fixture.', repository: 'fixture/repository',
    head, base, evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1' };

  // Existing RP8 pattern: run the real HTTP handler without listen, loopback or socket bind.
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
  });
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', policy, get store() { return store; }, env,
    accounts: () => [], models: () => ({}), accountIds: () => ['codex', 'claude'],
    draining: () => false, drain: async () => {}, cancel: () => {}, reviews: {
      submit: input => submitReview(store, policy, trees, input, env, capacity),
      get: id => getReview(store, id), vote: () => undefined,
    } });
  const send = (method: string, url: string, input?: unknown): Promise<Reply> => new Promise(resolve => {
    const request = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), {
      method, url, headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    });
    let status = 0;
    handler!(request as IncomingMessage, { writeHead(code: number) { status = code; },
      end(data: string) { resolve({ status, body: JSON.parse(data) }); } } as ServerResponse);
  });
  let dispatches = 0;
  const execute = () => {
    const accounts: AccountStatus[] = (['codex', 'claude'] as const).map(provider => ({
      account: { id: provider, provider, enabled: true, maxConcurrency: 10, loginDir: root, fingerprint: 'fixture' },
      running: 0, evidence: model => ({ accountId: provider, model, observedAt: new Date(clock).toISOString(),
        verdict: { state: 'available', headroom: 0.8 } }),
    }));
    const selected = plan(store.list('queued'), accounts, { now: new Date(clock), pinWaitMs: 60_000,
      evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.deepEqual(selected.fail, [], 'fixture has valid routes and fresh ordinary room');
    for (const d of selected.dispatch) {
      const account = accounts.find(a => a.account.id === d.accountId)!.account;
      const claim = store.startAttempt(d.requestId, account, { ...d.evidence, grant: ['Read', 'Edit'] });
      assert.ok(claim.ok, 'fake executor uses the real atomic claim');
      dispatches++;
      const request = store.get(d.requestId)!;
      const workspace = request.mutating ? { path: join(jobs, request.id), branch: `pipe/${request.id}`, startCommit: head, commit: head } : undefined;
      if (workspace) mkdirSync(workspace.path); // One actual inert folder per changing dispatch; no model/CLI runs.
      clock += 1_000;
      store.finishAttempt(claim.attempt.id, { kind: 'completed',
        result: JSON.stringify({ verdict: 'APPROVE', head, findings: [], unknowns: [] }), ...(workspace ? { workspace } : {}) });
    }
  };
  const finishReview = async (id: string) => {
    execute();
    const deadline = performance.now() + 10_000;
    do {
      refreshReviews(store, (_where, error) => { throw error; }, env);
      if (getReview(store, id)?.state === 'finished') return getReview(store, id)!;
      await delay(10);
    } while (performance.now() < deadline);
    assert.fail('fixture review cleanup did not finish');
  };
  return { root, repo, head, base, trees, reviewInput, jobInput, send, execute, finishReview, git,
    get store() { return store; }, get dispatches() { return dispatches; },
    worktrees: () => readdirSync(jobs).length,
    registeredTrees: () => git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length - 1,
    reopen() { store.close(); store = open(); },
    capacity(value: CapacityOptions) { capacity = value; },
    advance(ms: number) { clock += ms; } };
}

test('test_duplicate_review_request_reuses_receipt', async t => {
  const f = await fixture(t), input = { ...f.reviewInput, idempotencyKey: 'e1-review-lost-response' };
  const first = await f.send('POST', '/v1/reviews', input);
  assert.equal(first.status, 201);
  const id = first.body.review!.id, decided = await f.finishReview(id);
  assert.equal(decided.receipt.quorum.approved, true, 'both real seat records yielded bound approvals');
  const originalSeats = decided.seats.map(s => s.requestId), before = f.dispatches;
  f.reopen(); f.advance(30_000); // The key and receipt must survive a service/store restart.
  const second = await f.send('POST', '/v1/reviews', input);
  assert.equal(second.status, 201);
  f.execute();
  const reused = second.body.review!;
  assert.deepEqual({ id: reused.id, receipt: (reused as typeof reused & { receipt: unknown }).receipt,
    admissionKey: reused.admissionKey, dispatchClass: reused.dispatchClass, reuse: reused.reuse,
    requests: f.store.list().map(r => r.id).sort(), extraDispatches: f.dispatches - before, extraTrees: f.registeredTrees() },
  { id, receipt: decided.receipt, admissionKey: input.idempotencyKey, dispatchClass: 'repeat',
    reuse: { requestId: id, verdict: 'APPROVE', timeSavedMs: 2_000 },
    requests: originalSeats.sort(), extraDispatches: 0, extraTrees: 0 },
  'identical review admission must reuse the durable receipt without new seats, checkout or dispatch');
});

// Distinguish fresh transport fixtures from duplicate-placement admission.
test('test_duplicate_review_different_placement_preserves_stored_requests', async t => {
  const f = await fixture(t), placement = 'ordinary_headroom';
  const first = await f.send('POST', '/v1/reviews', f.reviewInput);
  assert.equal(first.status, 201);
  const id = first.body.review!.id, original = getReview(f.store, id)!;
  const requestIds = original.seats.map(s => s.requestId), trees = f.registeredTrees();
  assert.equal(original.placement, undefined);
  for (const requestId of requestIds) assert.equal(f.store.get(requestId)!.placement, undefined);
  f.reopen();
  const second = await f.send('POST', '/v1/reviews', { ...f.reviewInput, placement });
  assert.equal(second.status, 201);
  const reused = second.body.review! as Admission & { placement?: string; receipt: unknown };
  assert.equal(reused.id, id);
  assert.equal(reused.admissionKey, first.body.review!.admissionKey);
  assert.equal(reused.dispatchClass, 'repeat');
  assert.equal(reused.reuse?.requestId, id);
  assert.equal(reused.placement, placement, 'the reuse response reports the sent placement');
  assert.deepEqual(reused.receipt, original.receipt);
  const stored = getReview(f.store, id)!;
  assert.equal(stored.placement, undefined, 'the original review retains its first placement');
  assert.deepEqual(stored.seats.map(s => s.requestId), requestIds);
  for (const requestId of requestIds) assert.equal(f.store.get(requestId)!.placement, undefined);
  assert.equal(f.store.list().length, requestIds.length);
  assert.equal(f.registeredTrees(), trees);
  assert.equal(f.dispatches, 0);
});

test('test_same_key_different_body_refused', async t => {
  const f = await fixture(t), results = [];
  for (const [url, body, changed] of [
    ['/v1/requests', f.jobInput, { prompt: 'A different task under the same key.' }],
    ['/v1/reviews', f.reviewInput, { brief: 'A different brief under the same key.' }],
  ] as const) {
    const input = { ...body, idempotencyKey: `e1-conflict-${url}` };
    assert.equal((await f.send('POST', url, input)).status, 201);
    const count = f.store.list().length, trees = f.registeredTrees();
    const response = await f.send('POST', url, { ...input, ...changed });
    results.push({ url, status: response.status, code: response.body.error?.code,
      message: typeof response.body.error?.message, addedRequests: f.store.list().length - count,
      addedTrees: f.registeredTrees() - trees });
  }
  assert.deepEqual(results, ['/v1/requests', '/v1/reviews'].map(url => ({ url, status: 409,
    code: 'idempotency_conflict', message: 'string', addedRequests: 0, addedTrees: 0 })),
  'a reused explicit key with a changed body must give a typed conflict before effects on both entry points');
});

test('test_key_computed_when_absent', async t => {
  const f = await fixture(t);
  // Independent tuple oracle: fixed field order and UTF-8 SHA-256, never imported from the implementation.
  const expectedKey = sha256(JSON.stringify([f.jobInput.repository, f.head, f.base, ['openai'],
    sha256(f.jobInput.prompt), 'evidence-v1', 'policy-v1']));
  const [first, second] = await Promise.all([
    f.send('POST', '/v1/requests', f.jobInput),
    f.send('POST', '/v1/requests', { ...f.jobInput }),
  ]); // Concurrent admission closes check-then-submit; no key is supplied by either caller.
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  f.execute(); f.reopen();
  const third = await f.send('POST', '/v1/requests', f.jobInput);
  assert.equal(third.status, 201); f.execute();
  assert.deepEqual({ sameId: first.body.request!.id === second.body.request!.id && first.body.request!.id === third.body.request!.id,
    keys: [first, second, third].map(r => r.body.request!.admissionKey),
    storedKey: (f.store.get(first.body.request!.id) as Admission).admissionKey,
    requests: f.store.list().length, worktrees: f.worktrees(), dispatches: f.dispatches },
  { sameId: true, keys: [expectedKey, expectedKey, expectedKey], storedKey: expectedKey, requests: 1, worktrees: 1, dispatches: 1 },
  'omitting a key must still deduplicate atomically and durably, including a lost response');
});

test('test_dispatch_class_recorded', async t => {
  const f = await fixture(t), classes: Array<string | undefined> = [], childClasses: Array<string | undefined> = [];
  const submit = async (extra = {}) => {
    const r = await f.send('POST', '/v1/reviews', { ...f.reviewInput, ...extra }); assert.equal(r.status, 201);
    classes.push(r.body.review!.dispatchClass);
    const children = getReview(f.store, r.body.review!.id)!.seats;
    childClasses.push(...children.map(s => (f.store.get(s.requestId) as Admission).dispatchClass));
    return r.body.review!.id;
  };
  const first = await submit(); await f.finishReview(first);
  const confirm = await submit({ brief: `${f.reviewInput.brief}\nConfirm the unchanged evidence.` });
  await f.finishReview(confirm);
  const reassess = await submit({ evidenceVersion: 'evidence-v2' }); await f.finishReview(reassess);
  const repeated = await submit({ evidenceVersion: 'evidence-v2' });
  // Repeat metadata belongs to its response, not the stored admission.
  const original = await f.send('GET', `/v1/reviews/${reassess}`); assert.equal(original.status, 200);
  // A new head is a fresh decision, with no votes borrowed from the previous exact head (F1).
  writeFileSync(join(f.repo, 'fixture.txt'), 'new head\n'); f.git('commit', '-qam', 'new head');
  const next = await submit({ head: f.git('rev-parse', 'HEAD') });
  const fresh = getReview(f.store, next)!;
  const listed = await f.send('GET', '/v1/requests'); assert.equal(listed.status, 200);
  assert.deepEqual({ classes, childClasses, repeatedId: repeated === reassess, newId: next !== reassess,
    originalClass: original.body.review!.dispatchClass, originalReuse: original.body.review!.reuse,
    freshVotes: fresh.receipt.votes, freshApproved: fresh.receipt.quorum.approved,
    listClasses: listed.body.requests!.map(r => r.dispatchClass).sort() },
  { classes: ['first', 'confirm', 'reassess', 'repeat', 'first'],
    childClasses: ['first', 'first', 'confirm', 'confirm', 'reassess', 'reassess', 'reassess', 'reassess', 'first', 'first'],
    originalClass: 'reassess', originalReuse: null,
    repeatedId: true, newId: true, freshVotes: [], freshApproved: false,
    listClasses: ['first', 'first', 'first', 'first', 'confirm', 'confirm', 'reassess', 'reassess'].sort() },
  'history-derived classes must persist on the review and every native request and appear in the pipe list projection');
});

test('test_capacity_hook_off_by_default_unchanged_behaviour', async t => {
  const f = await fixture(t);
  const off = await f.send('POST', '/v1/reviews', { ...f.reviewInput, landing_rank: 99 });
  assert.equal(off.status, 201); await f.finishReview(off.body.review!.id);
  assert.equal(f.dispatches, 2, 'omitted feature flag ignores landing_rank and dispatches both existing seats');
  f.capacity({ E6_CAPACITY_HOOK: true, landing_rank_bound: 1 });
  const input = { ...f.reviewInput, brief: `${f.reviewInput.brief}\nCapacity fixture.`, idempotencyKey: 'e1-capacity', landing_rank: 2 };
  const held = await f.send('POST', '/v1/reviews', input); assert.equal(held.status, 201);
  const id = held.body.review!.id, before = f.dispatches;
  f.execute();
  const heldFacts = { state: held.body.review!.admissionState, dispatches: f.dispatches - before,
    seats: getReview(f.store, id)!.seats.length, worktrees: f.registeredTrees() };
  f.reopen();
  const durableState = (f.store.review(id) as Admission).admissionState;
  const released = await f.send('POST', '/v1/reviews', { ...input, landing_rank: 1 });
  assert.equal(released.status, 201); f.execute();
  const replay = await f.send('POST', '/v1/reviews', { ...input, landing_rank: 1 });
  assert.equal(replay.status, 201); f.execute();
  assert.deepEqual({ heldFacts, durableState, sameId: released.body.review!.id === id,
    replayId: replay.body.review!.id === id,
    releasedState: released.body.review!.admissionState, releaseDispatches: f.dispatches - before,
    releaseSeats: getReview(f.store, id)!.seats.length },
  { heldFacts: { state: 'queued-for-capacity', dispatches: 0, seats: 0, worktrees: 0 },
    durableState: 'queued-for-capacity', sameId: true, replayId: true, releasedState: 'admitted', releaseDispatches: 2, releaseSeats: 2 },
  'opt-in rank gating must persist accepted intent and release the same review exactly once at the bound');
});

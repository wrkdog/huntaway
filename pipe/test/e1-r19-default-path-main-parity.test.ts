/** Independent oracle: the opt-in admission ruling as amended, and the round-19 F4 contract.
 * The amendment admits only predecessorId:null, admissionState, requester, finishedAt
 * and the native-child stored fields named below, beyond main's exact key sets.
 * The supplied "main" SHA 556d7ee4c75afa9443ceb37bd3b67c461c74e000 checks
 * policy/packets before cwd; F4 still requires the quoted refusal order and wording.
 * Message oracles at that SHA: store.ts:169,204 (cwd type), :449 (missing directory).
 * Lesson/rule: explicit field admissions preserve exact response/storage boundaries;
 * they do not admit other keys or change refusal precedence. Exact checks enforce it.
 * Fixtures follow r16: real HTTP handlers and SQLite, socket-free, no provider calls.
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
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { startHttp } from '../src/http.ts';
import type { Projects } from '../src/projects.ts';
import { getReview, refreshReviews, submitReview } from '../src/review.ts';
import { Store } from '../src/store.ts';

const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const }, efforts: ['high'] } };
const keys = (value: object) => Object.keys(value).sort();
const REVIEW_KEYS = ['id', 'state', 'createdAt', 'updatedAt', 'repository', 'repo', 'head', 'base',
  'briefSha256', 'project', 'requestedSeats', 'seats', 'setupFailed', 'lane', 'round', 'receipt',
  'admissionState', 'requester'].sort();
type ReviewBody = { id: string; state: string; seats: { requestId: string }[] };
type Reply = { status: number; body: { request?: Record<string, unknown>; review?: ReviewBody;
  hint?: string; error?: { code: string; message: string } } };

async function fixture(t: TestContext, brokenPacket = false) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-e1-r19-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const store = new Store(path, { now: () => new Date('2026-10-26T00:00:00Z') });
  t.after(() => store.close());
  const common = { requester: 'fixture', project: 'fixture', repository: 'fixture/repository', head, base,
    reason: 'Astra high effort exercises admission parity without a provider' };
  const jobInput = { ...common, kind: 'code', mutating: true, provider: 'codex', model: 'gpt-6-astra',
    effort: 'high', cwd: repo, priority: 'interactive', prompt: 'Check the inert fixture.' };
  const reviewInput = { ...common, repo, brief: jobInput.prompt,
    seats: [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' }] };
  const projects: Projects | undefined = brokenPacket
    ? { fixture: { contextPacket: { path: join(root, 'missing-packet') } } } : undefined;
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
  });
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', policy, store, env, projects,
    accounts: () => [], models: () => ({}), accountIds: () => [], draining: () => false,
    drain: async () => {}, cancel: () => {}, log: () => {}, reviews: {
      submit: input => submitReview(store, policy, trees, input, env, { projects }),
      get: id => getReview(store, id), vote: () => undefined,
    } });
  const send = (url: string, input?: unknown): Promise<Reply> => new Promise((resolve, reject) => {
    if (input !== undefined) for (const key of ['idempotencyKey', 'evidenceVersion', 'policyVersion']) {
      assert.equal(Object.hasOwn(input as object, key), false, `${key} must be omitted on the wire`);
    }
    const timeout = setTimeout(() => reject(new Error('HTTP fixture did not answer')), 10_000);
    const request = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), {
      method: input === undefined ? 'GET' : 'POST', url,
      headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    });
    let status = 0;
    handler!(request as IncomingMessage, { writeHead(code: number) { status = code; },
      end(data: string) { clearTimeout(timeout); resolve({ status, body: JSON.parse(data) }); } } as ServerResponse);
  });
  const review = async () => {
    const answer = await send('/v1/reviews', reviewInput);
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    assert.equal(answer.body.review!.state, 'running', 'real review setup succeeded');
    assert.equal(answer.body.review!.seats.length, 1, 'one real native child was submitted');
    return answer;
  };
  return { root, path, store, env, send, review, jobInput };
}

test('F1 request: default POST has exactly main keys plus predecessorId:null and the existing hint', async t => {
  const f = await fixture(t), answer = await f.send('/v1/requests', f.jobInput);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(typeof answer.body.hint, 'string');
  assert.deepEqual(keys(answer.body), ['hint', 'request']);
  const r = f.store.get(answer.body.request!.id as string)!;
  // The amendment: admit exactly predecessorId:null beyond main's request reply keys.
  assert.deepEqual(answer.body.request, { id: r.id, state: r.state, seq: r.seq, createdAt: r.createdAt, predecessorId: null });
});

for (const method of ['POST', 'GET'] as const) test(`F1 review: default ${method} has exactly main keys plus admissionState/requester`, async t => {
  const f = await fixture(t), created = await f.review();
  const answer = method === 'POST' ? created : await f.send(`/v1/reviews/${created.body.review!.id}`);
  assert.equal(answer.status, method === 'POST' ? 201 : 200);
  assert.deepEqual(keys(answer.body), method === 'POST' ? ['hint', 'review'] : ['review']);
  // The amendment: admit exactly admissionState/requester beyond main's unfinished review keys.
  assert.deepEqual(keys(answer.body.review!), REVIEW_KEYS);
});

test('F1 review: a finished default GET adds exactly finishedAt to the admitted review keys', async t => {
  const f = await fixture(t), created = await f.review(), id = created.body.review!.id;
  assert.equal(f.store.cancel(created.body.review!.seats[0]!.requestId, 'fixture completion'), true);
  const errors: unknown[] = [];
  refreshReviews(f.store, (_where, error) => errors.push(error), f.env);
  // Exercise the real asynchronous cleanup/completion path, not a synthetic finished row.
  for (let n = 0; n < 500 && getReview(f.store, id)?.state !== 'finished'; n++) await delay(10);
  assert.deepEqual(errors, []);
  const answer = await f.send(`/v1/reviews/${id}`);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.review!.state, 'finished', 'cleanup reached real completion');
  // The amendment: admit exactly finishedAt once finished, alongside admissionState/requester.
  assert.deepEqual(keys(answer.body.review!), [...REVIEW_KEYS, 'finishedAt'].sort());
});

test('F1 children: a default review stores exactly main fields plus the admitted native fields', async t => {
  const f = await fixture(t), created = await f.review();
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const child = created.body.review!.seats[0]!.requestId;
    const row = db.prepare('SELECT body FROM requests WHERE id = ?').get(child)!;
    const body = JSON.parse(String(row.body));
    assert.equal(f.store.list().length, 1);
    // Check durable raw fields so a public projection cannot conceal extra writes.
    // The amendment: admit repository/head/base/evidenceVersion/policyVersion (review.ts:331-332; store.ts:414-416).
    assert.deepEqual(keys(body), ['requester', 'project', 'kind', 'mutating', 'cwd', 'provider',
      'model', 'effort', 'reason', 'prompt', 'priority', 'repository', 'head', 'base',
      'evidenceVersion', 'policyVersion'].sort());
  } finally { db.close(); }
});

for (const competing of ['policy', 'project packet'] as const) {
  test(`F4 cwd: a nonexistent directory wins before ${competing}`, async t => {
    const f = await fixture(t, competing === 'project packet');
    const input = { ...f.jobInput, cwd: join(f.root, 'missing-cwd'),
      ...(competing === 'policy' ? { model: 'outside-policy' } : {}) };
    const answer = await f.send('/v1/requests', input);
    assert.equal(f.store.list().length, 0, 'refusal has no request effects');
    // Message: supplied SHA store.ts:449. Precedence: F4 quoted acceptance;
    // supplied SHA http.ts:105-120 instead runs the competing checks first.
    assert.deepEqual(answer, { status: 400, body: { error: {
      code: 'invalid_request', message: 'cwd must be an existing directory',
    } } });
  });
}

test('F4 cwd: non-string cwd keeps the legacy validation message', async t => {
  const f = await fixture(t), answer = await f.send('/v1/requests', { ...f.jobInput, cwd: 42 });
  assert.equal(f.store.list().length, 0);
  // Supplied SHA store.ts:169 and :203-204.
  assert.deepEqual(answer, { status: 400, body: { error: {
    code: 'invalid_request', message: "the request's cwd must be an absolute path when given",
  } } });
});

test('F4 cwd: expectedStartCommit with a nonexistent cwd keeps the directory refusal', async t => {
  const f = await fixture(t), answer = await f.send('/v1/requests', {
    ...f.jobInput, cwd: join(f.root, 'missing-cwd'), expectedStartCommit: 'a'.repeat(40),
  });
  assert.equal(f.store.list().length, 0);
  // Message: supplied SHA store.ts:449. F4 requires it before saved-source lookup;
  // supplied SHA store.ts:414-430 actually bypasses :449 and gives another error.
  assert.deepEqual(answer, { status: 400, body: { error: {
    code: 'invalid_request', message: 'cwd must be an existing directory',
  } } });
});

/** Independent oracle: the opt-in ruling narrows idempotent admission: compute a keyless admission key
 * only when evidenceVersion or policyVersion is sent; explicit keys remain unchanged.
 * Tuple oracle: docs/lanes/E1-IDEMPOTENT-ADMISSION-BRIEF.md:20–27.
 * Fixture pattern: test/e1-r7-keyless-dedupe.test.ts:33–87 (SQLite, socket-free real HTTP,
 * real submitReview and atomic claims; no provider). One native seat makes each review
 * admission exactly one dispatch, without changing the production quorum rules.
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
import { startHttp } from '../src/http.ts';
import { getReview, submitReview } from '../src/review.ts';
import { Store } from '../src/store.ts';

type Namespace = 'request' | 'review';
type Admission = { id: string; admissionKey?: string;
  reuse?: { requestId: string } | null };
type Reply = { status: number; body: { request?: Admission; review?: Admission;
  error?: { code: string } } };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const }, efforts: ['high'] } };

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-e1-r16-'));
  const repo = join(root, 'repo'), trees = join(root, 'reviews');
  mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'fixture.txt'), 'head\n'); git('commit', '-qam', 'head');
  const head = git('rev-parse', 'HEAD');
  const now = new Date('2026-10-26T00:00:00Z');
  const store = new Store(join(root, 'record.sqlite'), { now: () => now });
  t.after(() => store.close());
  const common = { requester: 'fixture', project: 'fixture', repository: 'fixture/repository', head, base,
    reason: 'Astra high effort exercises the independent admission oracle without a provider' };
  const jobInput = { ...common, kind: 'code', mutating: true, provider: 'codex', model: 'gpt-6-astra',
    effort: 'high', cwd: repo, priority: 'interactive', prompt: 'Check the inert fixture.' };
  const reviewInput = { ...common, repo, brief: jobInput.prompt,
    seats: [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' }] };

  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
  });
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', policy, store, env, accounts: () => [], models: () => ({}),
    accountIds: () => ['codex'], draining: () => false, drain: async () => {}, cancel: () => {},
    log: () => {}, reviews: {
      submit: input => submitReview(store, policy, trees, input, env),
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
  let dispatches = 0;
  const dispatchQueued = () => {
    for (const request of store.list('queued')) {
      const account = { id: 'codex', provider: 'codex' as const, enabled: true, maxConcurrency: 10,
        loginDir: root, fingerprint: 'fixture' };
      const claim = store.startAttempt(request.id, account, { accountId: account.id, model: request.model,
        observedAt: now.toISOString(), verdict: { state: 'available', headroom: 0.8 }, grant: ['Read'] });
      assert.ok(claim.ok, `fixture must claim ${request.id}: ${!claim.ok && claim.reason}`);
      dispatches++;
    }
  };
  const records = (namespace: Namespace) => namespace === 'request'
    ? store.list().map(r => r.id).sort() : store.runningReviewIds().sort();
  return { store, send, jobInput, reviewInput, dispatchQueued, records,
    get dispatches() { return dispatches; } };
}

const cases = [
  { id: 'L1', description: 'identical legacy bodies create distinct requests', extra: {}, reuse: false, changed: false },
  { id: 'L2', description: 'changed legacy requester creates a distinct request without conflict', extra: {}, reuse: false, changed: true },
  { id: 'V1', description: 'both versions opt into keyless reuse',
    extra: { evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1' }, reuse: true, changed: false },
  { id: 'V2', description: 'policyVersion alone opts into keyless reuse',
    extra: { policyVersion: 'policy-v1' }, reuse: true, changed: false },
  { id: 'K1', description: 'an explicit key without versions retains reuse',
    extra: { idempotencyKey: 'explicit-r16' }, reuse: true, changed: false },
] as const;

for (const namespace of ['request', 'review'] as const) for (const c of cases) {
  test(`opt-in ${c.id} ${namespace}: ${c.description}`, async t => {
    const f = await fixture(t);
    const input = { ...(namespace === 'request' ? f.jobInput : f.reviewInput), ...c.extra };
    // Omission is on the wire, not an undefined/default version that could enable admission.
    for (const key of ['idempotencyKey', 'evidenceVersion', 'policyVersion']) {
      assert.equal(Object.hasOwn(input, key), Object.hasOwn(c.extra, key));
    }
    const first = await f.send(namespace, input);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const original = first.body[namespace]!;
    assert.ok(original.id);
    f.dispatchQueued();
    assert.equal(f.dispatches, 1, 'the original admission dispatches once');
    const second = await f.send(namespace, c.changed ? { ...input, requester: 'another-fixture' } : input);
    f.dispatchQueued();
    const next = second.body[namespace];
    const expectedIds = c.reuse ? [original.id] : [original.id, next?.id].sort();
    assert.deepEqual({ statuses: [first.status, second.status],
      errors: [first.body.error?.code ?? null, second.body.error?.code ?? null],
      hasSecondId: typeof next?.id === 'string', sameId: next?.id === original.id,
      reuse: next?.reuse?.requestId ?? null, records: f.records(namespace),
      nativeRecords: f.store.list().length,
      attempts: f.store.list().reduce((n, r) => n + f.store.attempts(r.id).length, 0), dispatches: f.dispatches },
    { statuses: [201, 201], errors: [null, null], hasSecondId: true, sameId: c.reuse,
      reuse: c.reuse ? original.id : null, records: expectedIds,
      nativeRecords: c.reuse ? 1 : 2, attempts: c.reuse ? 1 : 2, dispatches: c.reuse ? 1 : 2 },
    'opt-in: omitted versions and key preserve independent admission; an opt-in reuses one durable record and dispatch');
    if (c.reuse) {
      const key = c.id === 'K1' ? 'explicit-r16' : sha256(JSON.stringify([
        input.repository, input.head, input.base, ['openai'], sha256(f.jobInput.prompt),
        c.id === 'V1' ? 'evidence-v1' : 'unversioned', 'policy-v1',
      ]));
      assert.equal(original.admissionKey, key, 'independent tuple or verbatim explicit-key oracle');
      assert.equal(next!.admissionKey, key);
    }
    for (const id of expectedIds) {
      assert.ok(id);
      assert.ok(namespace === 'request' ? f.store.get(id) : getReview(f.store, id), 'each returned ID has a durable record');
    }
  });
}

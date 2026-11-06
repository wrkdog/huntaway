/** Round 6 M2: identical packet bytes do not prove identical seat instructions.
 * Oracle: docs/SPEC.md's always-added inline text and E1's execution-input fingerprint contract.
 * Lesson/rule: an advisory rank may release only the original effective prompt, once.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Admission } from '../src/admission.ts';
import { getReview, submitReview } from '../src/review.ts';
import { Store } from '../src/store.ts';

const PACKET = '# Fixture context\nKeep evidence bound to its account.\n';
const packetHash = createHash('sha256').update(PACKET).digest('hex');
const policy = { codex: { models: { 'gpt-6-astra': 'hard' as const }, efforts: ['high'] },
  claude: { models: { opus: 'hard' as const }, efforts: ['high'] } };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-e1-context-')), repo = join(root, 'repo');
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'fixture.txt'), 'inert\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD'), packet = join(root, 'packet.md'), path = join(root, 'record.sqlite');
  writeFileSync(packet, PACKET);
  const open = () => new Store(path);
  let store = open();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { requester: 'fixture', reason: 'context insertion regression fixture', repository: 'fixture/repository',
    repo, head, base: head, project: 'fixture', brief: `${PACKET}\nCheck omission, clock steps, malformed values and cross-account evidence.`,
    seats: [{ provider: 'codex', model: 'gpt-6-astra', effort: 'high' }, { provider: 'claude', model: 'opus', effort: 'high' }] };
  const submit = (extra: Record<string, unknown> = {}) => submitReview(store, policy, join(root, 'trees'), { ...input, ...extra }, env,
    { E6_CAPACITY_HOOK: true, landing_rank_bound: 1, projects: { fixture: { contextPacket: { path: packet } } } });
  return { input, submit, get store() { return store; },
    reopen() { store.close(); store = open(); },
    treeCount: () => git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length - 1 };
}

test('M2 inline and implicit packets with identical bytes have different real review fingerprints', async t => {
  const f = fixture(t), identities: Admission[] = [];
  const lookup = f.store.hasReviewAdmission.bind(f.store);
  t.mock.method(f.store, 'hasReviewAdmission', (identity: Admission) => { identities.push(identity); return lookup(identity); });
  const implicit = await f.submit({ idempotencyKey: 'implicit-fingerprint', landing_rank: 2 });
  const inline = await f.submit({ idempotencyKey: 'inline-fingerprint', landing_rank: 2, contextPacket: PACKET });
  assert.equal(implicit.admissionState, 'queued-for-capacity');
  assert.equal(inline.admissionState, 'queued-for-capacity');
  assert.equal(implicit.contextPacketSha256, packetHash);
  assert.equal(inline.contextPacketSha256, packetHash);
  assert.equal(identities.length, 2, 'observe the identities built by the real review entry point');
  assert.notEqual(identities[0]!.fingerprint, identities[1]!.fingerprint,
    'inline forces a packet prefix while implicit suppresses it for this brief; packet hash alone loses that distinction');
});

for (const firstInline of [false, true]) test(`M2 a held ${firstInline ? 'inline' : 'implicit'} review cannot be released by the other insertion mode`, async t => {
  const f = fixture(t), idempotencyKey = 'held-context-mode';
  const held = await f.submit({ idempotencyKey, landing_rank: 2, ...(firstInline ? { contextPacket: PACKET } : {}) });
  assert.equal(held.admissionState, 'queued-for-capacity');
  assert.equal(held.contextPacketSha256, packetHash);
  assert.equal(held.seats.length, 0);
  assert.equal(f.treeCount(), 0);
  const original = f.store.review(held.id)!;
  assert.equal(existsSync(original.worktree as string), false);
  f.reopen();
  const replay = await f.submit({ idempotencyKey, landing_rank: 1, ...(!firstInline ? { contextPacket: PACKET } : {}) })
    .then(review => ({ status: 201, code: null, id: review.id }), (error: { status?: number; code?: string }) =>
      ({ status: error.status, code: error.code, id: null }));
  const stored = getReview(f.store, held.id)!;
  assert.deepEqual({ replay, state: stored.admissionState, seats: stored.seats.length,
    requests: f.store.list().length, trees: f.treeCount(), worktreeExists: existsSync(original.worktree as string) },
  { replay: { status: 409, code: 'idempotency_conflict', id: null }, state: 'queued-for-capacity',
    seats: 0, requests: 0, trees: 0, worktreeExists: false },
  'changed effective seat instructions must conflict before releasing the original held review or creating work');
});

test('M2 identical inline forms release the original held review once with the forced packet prefix', async t => {
  const f = fixture(t), input = { idempotencyKey: 'same-inline-context', contextPacket: PACKET };
  const held = await f.submit({ ...input, landing_rank: 2 });
  assert.equal(held.admissionState, 'queued-for-capacity');
  assert.equal(f.treeCount(), 0);
  f.reopen();
  const released = await f.submit({ ...input, landing_rank: 1 });
  assert.equal(released.id, held.id);
  assert.equal(released.admissionState, 'admitted');
  assert.equal(released.reuse?.requestId, held.id);
  assert.equal(released.seats.length, 2);
  const requestIds = released.seats.map(seat => seat.requestId);
  for (const id of requestIds) {
    const request = f.store.get(id)!;
    assert.equal(request.contextPacketSha256, packetHash);
    assert.ok(request.prompt.startsWith(`Project context for fixture, SHA-256 ${packetHash}:`));
    assert.equal(request.prompt.split(PACKET).length - 1, 2, 'inline packet is inserted even though the brief already holds it');
  }
  const repeated = await f.submit({ ...input, landing_rank: 1 });
  assert.equal(repeated.id, held.id);
  assert.deepEqual(repeated.seats.map(seat => seat.requestId), requestIds);
  assert.deepEqual(f.store.list().map(request => request.id).sort(), [...requestIds].sort());
  assert.equal(f.treeCount(), 1);
  assert.deepEqual(f.store.openAttempts(), [], 'only admission/setup runs; no CLI is dispatched');
});

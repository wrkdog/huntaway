import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { card } from '../src/cards.ts';
import { saveWorktree } from '../src/disk.ts';
import { submitReview, refreshReviews, getReview } from '../src/review.ts';
import { dailyStats, reviewSetupFailed } from '../src/telemetry.ts';

const ZERO = { files: 0, insertions: 0, deletions: 0 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pipe-telemetry-'));
  let now = Date.parse('2026-10-13T00:00:00Z');
  const db = join(root, 'store.sqlite'), store = new Store(db, { now: () => new Date(now) });
  const account = { id: 'a', provider: 'codex' as const, fingerprint: '00000000', loginDir: root, enabled: true, maxConcurrency: 4 };
  const build = (wait: number, lines?: number) => {
    const r = store.submit({ requester: 'test', project: 'test', kind: 'code', provider: 'codex', model: 'gpt-6.1-sol',
      effort: 'high', reason: 'fixture', prompt: 'SECRET', mutating: true, priority: 'interactive', cwd: root });
    now += wait * 1000;
    const a = store.startAttempt(r.id, account, { accountId: 'a', model: r.model, observedAt: new Date(now).toISOString(),
      verdict: { state: 'available', headroom: 1 }, grant: ['Read', 'Edit'] });
    assert.ok(a.ok);
    store.finishAttempt(a.attempt.id, { kind: 'completed', result: 'SECRET', workspace: {
      path: '/SECRET', branch: 'pipe/test', commit: 'uncommitted', startCommit: 'a'.repeat(40) } });
    if (lines !== undefined) store.recordWorkspaceCommit(r.id, lines ? 'b'.repeat(40) : 'a'.repeat(40), !!lines,
      { files: lines ? 1 : 0, insertions: lines, deletions: 0 });
    return r.id;
  };
  return { root, db, store, build, nextDay: () => { now = Date.parse('2026-10-14T00:00:00Z'); },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('unsafe numeric samples stay unknown without losing healthy stats or boundary values', () => {
  const f = fixture(), db = new DatabaseSync(f.db), max = Number.MAX_SAFE_INTEGER;
  try {
    f.store.insertReview('round', 'finished', { seats: [], receipt: { quorum: { approved: true } } });
    const id = f.build(0, 4);
    const workspace = f.store.get(id)!.workspace!;
    for (const round of [max + 1, 1e20, 1e100, -1, 1.5, '9', null]) {
      db.prepare('UPDATE reviews SET body = ? WHERE id = ?').run(JSON.stringify({ round }), 'round');
      assert.equal(f.store.stats('2026-10-13').days[0]!.reviews.roundMax, null);
    }
    for (const diff of [
      { files: 1, insertions: max, deletions: 1 }, { files: 1, insertions: max, deletions: max },
      ...['insertions', 'deletions', 'files'].flatMap(k => [-1, 1.5, max + 1, 1e20, 1e100, '9', null]
        .map(v => ({ files: 1, insertions: 2, deletions: 2, [k]: v }))),
    ]) {
      db.prepare('UPDATE requests SET workspace = ? WHERE id = ?').run(JSON.stringify({ ...workspace, diff }), id);
      const day = f.store.stats('2026-10-13').days[0]!;
      assert.equal(day.builds.linesMedian, null); assert.equal(day.builds.linesP90, null);
      assert.equal(day.builds.count, 1); assert.equal(day.builds.waitMedianSec, 0);
    }
    db.prepare('UPDATE reviews SET body = ? WHERE id = ?').run(JSON.stringify({ round: max }), 'round');
    db.prepare('UPDATE requests SET workspace = ? WHERE id = ?').run(JSON.stringify({ ...workspace,
      diff: { files: max, insertions: max - 1, deletions: 1 } }), id);
    assert.equal(f.store.stats('2026-10-13').days[0]!.reviews.roundMax, max);
    assert.equal(f.store.stats('2026-10-13').days[0]!.builds.linesP90, max);
    db.prepare('UPDATE reviews SET body = ? WHERE id = ?').run(JSON.stringify({ round: 0 }), 'round');
    assert.equal(f.store.stats('2026-10-13').days[0]!.reviews.roundMax, 0);
    f.build(0, 4);
    f.store.insertReview('healthy-round', 'finished', { repository: 'r', lane: 'healthy', receipt: { quorum: { approved: true } } });
    db.prepare('UPDATE reviews SET body = ? WHERE id = ?').run(JSON.stringify({ round: max + 1 }), 'round');
    db.prepare('UPDATE requests SET workspace = ? WHERE id = ?').run(JSON.stringify({ ...workspace,
      diff: { files: 1, insertions: max, deletions: max } }), id);
    const day = f.store.stats('2026-10-13').days[0]!;
    assert.equal(day.builds.linesMedian, 4); assert.equal(day.builds.linesP90, 4);
    assert.equal(day.builds.count, 2);
    assert.equal(day.reviews.roundMax, 1); assert.equal(day.reviews.approved, 1); assert.equal(day.reviews.count, 2);
  } finally { db.close(); f.close(); }
});

test('each Store registers the setup SQL function once, across repeated stats calls', () => {
  const original = DatabaseSync.prototype.function;
  let registrations = 0;
  // The overloaded signature needs a cast to be replaced in a test (lead, 2026-10-14: tsc 7.0.2 rejected the direct form).
  DatabaseSync.prototype.function = function (this: DatabaseSync, ...args: unknown[]) {
    if (args[0] === 'review_setup_failed') registrations++;
    return Reflect.apply(original, this, args);
  } as unknown as DatabaseSync['function'];
  try {
    const f = fixture();
    try {
      assert.equal(registrations, 1);
      f.store.stats('2026-10-13'); f.store.stats('2026-10-13');
      assert.equal(registrations, 1);
    } finally { f.close(); }
  } finally { DatabaseSync.prototype.function = original; }
});

test('individually safe line counts cannot contribute an unsafe total', () => {
  const f = fixture(), db = new DatabaseSync(f.db);
  try {
    const id = f.build(0, 4), workspace = f.store.get(id)!.workspace!;
    db.prepare('UPDATE requests SET workspace = ? WHERE id = ?').run(JSON.stringify({ ...workspace,
      diff: { files: 1, insertions: Number.MAX_SAFE_INTEGER, deletions: 1 } }), id);
    const day = f.store.stats('2026-10-13').days[0]!;
    assert.equal(day.builds.linesMedian, null); assert.equal(day.builds.linesP90, null);
    assert.equal(day.builds.count, 1);
  } finally { db.close(); f.close(); }
});

test('stats derives setup failure once per review row', () => {
  const f = fixture(), db = new DatabaseSync(f.db);
  try {
    for (let i = 0; i < 3; i++) f.store.insertReview(`r${i}`, 'finished', { seats: [] });
    let calls = 0;
    db.function('review_setup_failed', { deterministic: true }, b => {
      calls++; return Number(reviewSetupFailed(JSON.parse(String(b))));
    });
    assert.equal(dailyStats(db, '2026-10-13', new Date('2026-10-13')).days[0]!.reviews.count, 3);
    assert.equal(calls, 3);
  } finally { db.close(); f.close(); }
});

test('a dedicated seat setup marker overrides cancellation prose while history retains its fallback', () => {
  const f = fixture();
  try {
    const seats = [
      { requestId: 'operator', status: 'failed', reason: 'review submission failed', setupCancelled: false },
      { requestId: 'setup', status: 'failed', reason: 'different prose', setupCancelled: true },
      { requestId: 'historical', status: 'failed', reason: 'review submission failed' },
    ];
    seats.forEach((seat, i) => f.store.insertReview(`marker-${i}`, 'finished', { seats: [seat], receipt: { builders: [], votes: [] } }));
    assert.deepEqual(seats.map((_, i) => getReview(f.store, `marker-${i}`)?.setupFailed), [false, true, true]);
    const stats = f.store.stats('2026-10-13').days[0]!.reviews;
    assert.equal(stats.setupFailed, 2); assert.equal(stats.seatFailed, 1);
  } finally { f.close(); }
});

test('new seats persist setup cancellation separately from an operator cancellation with identical prose', async () => {
  const f = fixture(), repo = join(f.root, 'repo'), trees = join(f.root, 'trees');
  mkdirSync(repo); mkdirSync(trees);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const original = f.store.submitReviewSeat.bind(f.store);
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, 'base'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
    const raw = { requester: 'test', reason: 'test', repo, head: git('rev-parse', 'HEAD'), brief: 'test',
      seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] };
    const policy = { codex: { models: { 'gpt-6.1-sol': 'default' as const }, efforts: ['high'] } };
    const normal = await submitReview(f.store, policy, trees, raw);
    const normalSeat = normal.seats[0]!;
    assert.equal(normalSeat.setupCancelled, false);
    f.store.cancel(normalSeat.requestId, 'review submission failed');
    refreshReviews(f.store, () => {});
    assert.equal(getReview(f.store, normal.id)?.setupFailed, false);
    let submitted = 0;
    f.store.submitReviewSeat = (...args: Parameters<Store['submitReviewSeat']>) => {
      if (++submitted === 2) throw new Error('injected second-seat submission failure');
      return original(...args);
    };
    await assert.rejects(submitReview(f.store, policy, trees, { ...raw, seats: [...raw.seats, ...raw.seats] }), /second-seat/);
    const id = f.store.runningReviewIds().find(id => id !== normal.id)!;
    const failed = f.store.review(id) as { seats: Array<{ setupCancelled?: boolean }> };
    assert.equal(failed.seats[0]?.setupCancelled, true);
    refreshReviews(f.store, () => {});
    assert.equal(getReview(f.store, id)?.setupFailed, true);
    for (let i = 0; f.store.runningReviewIds().length && i < 250; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(f.store.runningReviewIds(), []);
  } finally { f.close(); }
});

test('historical setup evidence is derived identically for finished reads and stats, excluding setup-stopped seats', () => {
  const f = fixture();
  try {
    const body = { seats: [], receipt: { builders: [], votes: [] } };
    const cases = [
      { setupFailed: true, seats: [{ requestId: 'submitted', status: 'failed' }] },
      { seats: [{ requestId: '', status: 'failed', reason: 'never submitted: interrupted' }] },
      { seats: [{ requestId: 'gemini-id', status: 'failed', reason: 'review submission failed' }] },
      { seats: [{ requestId: 'native-id', status: 'failed', reason: 'review submission failed' }] },
      { seats: [{ requestId: 'ran', status: 'failed', reason: 'runner failed' }] },
      { seats: [{ requestId: '', status: 'failed', reason: 'other' }] },
      { seats: [{ requestId: 'ran', status: 'failed', reason: 'never submitted: invalid evidence' }] },
      { seats: [{ requestId: 'waiting', status: 'waiting', reason: 'review submission failed' }] },
    ];
    cases.forEach((c, i) => f.store.insertReview(`old-${i}`, 'finished', { ...body, ...c }));
    assert.deepEqual(cases.map((_, i) => getReview(f.store, `old-${i}`)?.setupFailed), [true, true, true, true, false, false, false, false]);
    assert.deepEqual(f.store.stats('2026-10-13').days[0]?.reviews,
      { count: 8, approved: 0, revise: 0, setupFailed: 4, seatFailed: 2, roundMax: null });
  } finally { f.close(); }
});

for (const field of ['seats', 'votes']) test(`scalar ${field} and invalid JSON cannot disable healthy daily aggregates`, () => {
  const f = fixture();
  try {
    for (const [i, scalar] of ['unexpected', null, 42, true, ['nested']].entries()) {
      f.store.insertReview(`bad-${i}`, 'finished', { seats: field === 'seats' ? [scalar] : [], receipt: { votes: field === 'votes' ? [scalar] : [] } });
      assert.doesNotThrow(() => f.store.stats('2026-10-13'));
    }
    f.store.insertReview('broken', 'finished', {});
    f.store.insertReview('healthy', 'finished', { seats: [{ requestId: 'ran', status: 'failed' }],
      receipt: { quorum: { approved: true }, votes: [{ verdict: 'REVISE' }] } });
    const db = new DatabaseSync(f.db);
    try { db.prepare('UPDATE reviews SET body = ? WHERE id = ?').run('{broken', 'broken'); } finally { db.close(); }
    const r = f.store.stats('2026-10-13').days[0]!.reviews;
    assert.equal(r.approved, 1); assert.equal(r.revise, 1); assert.equal(r.setupFailed, 0); assert.equal(r.seatFailed, 1);
  } finally { f.close(); }
});

test('stats bounds since by the store UTC day before querying, including the exact 31-day boundary', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.store.stats('2026-09-12'), { days: [] });
    assert.throws(() => f.store.stats('2026-09-11'), /31 days/);
    f.nextDay();
    assert.throws(() => f.store.stats('2026-09-12'), /31 days/);
    assert.deepEqual(f.store.stats('2026-09-13'), { days: [] });
  } finally { f.close(); }
});

test('build stats use a date-range index without extracting prompt-bearing request bodies', () => {
  const f = fixture(), db = new DatabaseSync(f.db);
  try {
    const plan = db.prepare(`EXPLAIN SELECT id, state, created_at, workspace FROM requests WHERE created_at >= ?
      AND json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.mutating') = 1`).all('2026-10-13');
    assert.equal(plan.some(row => row.opcode === 'Function' && /json_/.test(String(row.p4))), false);
    const range = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM requests WHERE created_at >= ?
      AND json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.mutating') = 1`).all('2026-10-13');
    assert.match(JSON.stringify(range), /requests_build_created.*created_at>/);
  } finally { db.close(); f.close(); }
});

test('daily SQL telemetry uses first waits, median and nearest-rank p90; empty samples stay null and dates are strict', () => {
  const f = fixture();
  try {
    for (const [wait, lines] of [[1, 0], [3, 2], [5, 4], [7, 10]]) f.build(wait!, lines);
    const body = { repository: 'SECRET', lane: 'x', seats: [], receipt: { quorum: { approved: false }, votes: [] } };
    f.store.insertReview('r1', 'finished', { ...body, setupFailed: true });
    f.store.insertReview('r2', 'finished', { ...body, receipt: { quorum: { approved: true }, votes: [{ verdict: 'APPROVE' }] } });
    f.store.insertReview('r3', 'finished', { ...body, seats: [{ requestId: 'submitted', status: 'failed' }],
      receipt: { quorum: { approved: false }, votes: [{ verdict: 'REVISE' }] } });
    f.store.insertReview('r4', 'finished', { ...body, repository: 'other' });
    f.store.insertReview('r5', 'finished', { repository: 'SECRET', seats: [{ requestId: '', status: 'failed' }], receipt: body.receipt });
    assert.deepEqual(['r1', 'r2', 'r3', 'r4', 'r5'].map(id => f.store.review(id)?.round), [1, 2, 3, 1, null]);
    f.nextDay(); f.build(9);
    const stats = f.store.stats('2026-10-13');
    assert.deepEqual(stats.days, [
      { day: '2026-10-13', builds: { count: 4, waitMedianSec: 4, waitP90Sec: 7, linesMedian: 3, linesP90: 10 },
        reviews: { count: 5, approved: 1, revise: 1, setupFailed: 1, seatFailed: 1, roundMax: 3 } },
      { day: '2026-10-14', builds: { count: 1, waitMedianSec: 9, waitP90Sec: 9, linesMedian: null, linesP90: null },
        reviews: { count: 0, approved: 0, revise: 0, setupFailed: 0, seatFailed: 0, roundMax: null } },
    ]);
    assert.equal(JSON.stringify(stats).includes('SECRET'), false);
    assert.equal(f.store.stats('2026-10-14').days.length, 1);
    for (const date of ['', 'yesterday', '2026-02-29', '2026-13-01', '2026-10-14T00:00:00Z']) assert.throws(() => f.store.stats(date));
    assert.deepEqual(f.store.stats('2028-02-29'), { days: [] });
  } finally { f.close(); }
});

test('save numstat handles binary files and hostile names, preserves save on diff failure, and records zero changes', async () => {
  const f = fixture(), repo = join(f.root, 'repo'), trees = join(f.root, 'trees');
  mkdirSync(repo); mkdirSync(trees);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, 'base'), 'one\ntwo\n'); git('add', '-A'); git('commit', '-qm', 'base');
    const startCommit = git('rev-parse', 'HEAD'), path = join(trees, 'w'), branch = 'pipe/test';
    git('worktree', 'add', '-b', branch, path, startCommit);
    const id = f.build(0), r = f.store.get(id)!;
    r.cwd = repo; r.workspace = { path, branch, commit: 'uncommitted', startCommit };
    const clean = await saveWorktree(r, trees, repo);
    assert.ok('commit' in clean); assert.deepEqual(clean.diff, ZERO);
    writeFileSync(join(path, 'base'), 'one\n');
    writeFileSync(join(path, 'tab\tline\nname'), 'a\nb\nc\n');
    writeFileSync(join(path, 'binary'), Buffer.from([0, 1, 2]));
    const saved = await saveWorktree(r, trees, repo);
    assert.ok('commit' in saved); assert.deepEqual(saved.diff, { files: 3, insertions: 3, deletions: 1 });
    f.store.recordWorkspaceCommit(id, saved.commit, saved.saved, saved.diff);
    const c = card(f.store.get(id)!, [], { alias: () => null, runnerAlive: () => false, draining: false });
    assert.deepEqual(c.saved?.diff, saved.diff);
    r.workspace.startCommit = saved.commit;
    renameSync(join(path, 'tab\tline\nname'), join(path, 'renamed\tfile'));
    const renamed = await saveWorktree(r, trees, repo);
    assert.ok('commit' in renamed); assert.deepEqual(renamed.diff, { files: 1, insertions: 0, deletions: 0 });
    r.workspace.startCommit = 'f'.repeat(40);
    const failed = await saveWorktree(r, trees, repo);
    assert.ok('commit' in failed); assert.equal(failed.diff, undefined);
    const bin = join(f.root, 'bin'); mkdirSync(bin);
    const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" --numstat "*) exit 128;; esac\nexec "${real}" "$@"\n`); chmodSync(join(bin, 'git'), 0o755);
    r.workspace.startCommit = startCommit; writeFileSync(join(path, 'new'), 'new\n');
    const diffError = await saveWorktree(r, trees, repo, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.ok('commit' in diffError); assert.equal(diffError.saved, true); assert.equal(diffError.diff, undefined);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) exit 128;; esac\nexec "${real}" "$@"\n`);
    await assert.rejects(submitReview(f.store, { codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['high'] } }, trees,
      { requester: 'test', reason: 'test', repo, repository: 'r', head: startCommit, brief: 'test', lane: 'failed',
        seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] }, { ...process.env, PATH: `${bin}:${process.env.PATH}` }));
    const failedReview = getReview(f.store, f.store.runningReviewIds()[0]!)!;
    assert.equal(failedReview.setupFailed, true); assert.equal(failedReview.round, 1);
    refreshReviews(f.store, () => {}); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.store.stats('2026-10-13').days[0]?.reviews, { count: 1, approved: 0, revise: 0, setupFailed: 1, seatFailed: 0, roundMax: 1 });
  } finally { f.close(); }
});

test('lane validation precedes setup and restart accounting distinguishes seats never submitted', async () => {
  const f = fixture();
  try {
    const raw = { requester: 'test', reason: 'test', repo: f.root, head: 'a'.repeat(40), brief: 'test',
      seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] };
    const policy = { codex: { models: { 'gpt-6.1-sol': 'default' as const }, efforts: ['high'] } };
    for (const lane of ['', '   ', 'x'.repeat(81), 7, null]) await assert.rejects(submitReview(f.store, policy, f.root, { ...raw, lane }), /lane/);
    f.store.insertReview('interrupted', 'running', { repository: 'r', repo: f.root, head: raw.head, briefSha256: 'b',
      requestedSeats: raw.seats, seats: [], worktree: join(f.root, 'missing'), receipt: { builders: [], votes: [], revision: raw.head, briefSha256: 'b' } });
    refreshReviews(f.store, () => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getReview(f.store, 'interrupted')?.setupFailed, true);
    assert.equal(f.store.stats('2026-10-13').days[0]?.reviews.seatFailed, 0);
  } finally { f.close(); }
});

test('CLI stats and review lane, and MCP lane schema/validation, use the existing transport', () => {
  const f = fixture(), stub = join(f.root, 'fetch.mjs');
  writeFileSync(stub, `globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.pathname === '/v1/stats' && u.search === '?since=2026-10-13') return new Response('{"days":[]}');
    if (u.pathname === '/v1/reviews' && JSON.parse(options.body).lane === 'label') return new Response('{"review":{"id":"r"}}');
    throw new Error('unexpected transport');
  };`);
  const env = { ...process.env, PIPE_URL: 'http://127.0.0.1:1', PIPE_TOKEN: 'test-token' };
  const run = (file: string, args: string[], input?: string) => execFileSync(process.execPath,
    ['--import', stub, fileURLToPath(new URL(`../src/${file}.ts`, import.meta.url)), ...args], { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    assert.deepEqual(JSON.parse(run('cli', ['stats', '--since', '2026-10-13'])), { days: [] });
    for (const args of [['stats'], ['stats', '--since', '2026-02-29'], ['stats', '--since=2026-10-13'],
      ['stats', '--since', '2026-10-13', '--since', '2026-10-14'], ['review', '--lane'], ['review', '--lane', '']]) {
      assert.throws(() => run('cli', args));
    }
    const brief = join(f.root, 'brief'); writeFileSync(brief, 'test');
    assert.deepEqual(JSON.parse(run('cli', ['review', '--repo', f.root, '--head', 'a'.repeat(40), '--brief', brief, '--lane', 'label'])), { review: { id: 'r' } });
    const frames = [{ id: 1, method: 'tools/list' }, ...['label', '', 'x'.repeat(81), null, 7].map((lane, i) =>
      ({ id: i + 2, method: 'tools/call', params: { name: 'pipe_review', arguments: { lane } } }))];
    const output = run('mcp', [], frames.map(v => JSON.stringify(v)).join('\n') + '\n').trim().split('\n').map(v => JSON.parse(v));
    const schema = output.find(v => v.id === 1).result.tools.find((v: { name: string }) => v.name === 'pipe_review').inputSchema;
    assert.deepEqual(schema.properties.lane, { type: 'string', minLength: 1, maxLength: 80 });
    assert.equal(output.find(v => v.id === 2).result.isError, undefined);
    for (const id of [3, 4, 5, 6]) assert.match(output.find(v => v.id === id).result.content[0].text, /lane/);
  } finally { f.close(); }
});

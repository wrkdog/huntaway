import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { capLog, pruneEnded, validateRetention } from '../src/retention.ts';
import { startPipe } from '../src/service.ts';

const DAY = 86_400_000;
const account = { id: 'a', provider: 'codex' as const, fingerprint: '00000000', enabled: true, maxConcurrency: 8 };
const removed = { removedAt: '2026-08-02T00:00:00.000Z' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pipe-retention-')), tmp = join(root, 'tmp');
  mkdirSync(tmp);
  let now = Date.parse('2026-08-01T00:00:00Z');
  const samples: number[] = [];
  const path = join(root, 'store.sqlite'), store = new Store(path, { now: () => new Date(samples.shift() ?? now) }), db = new DatabaseSync(path);
  const submit = (extra: Record<string, unknown> = {}) => store.submit({ requester: 'test', project: 'test', kind: 'code', provider: 'codex',
    model: 'gpt-6.1-sol', effort: 'high', reason: 'fixture', prompt: 'p', mutating: false, priority: 'interactive', ...extra } as never);
  const start = (id: string) => {
    const a = store.startAttempt(id, { ...account, loginDir: root }, { accountId: 'a', model: 'gpt-6.1-sol', observedAt: new Date(now).toISOString(),
      verdict: { state: 'available', headroom: 1 }, grant: ['Read'] });
    assert.ok(a.ok); return a.attempt.id;
  };
  const ended = (extra: Record<string, unknown> = {}, workspace?: Record<string, unknown>) => {
    const r = submit(extra), attempt = start(r.id);
    store.finishAttempt(attempt, workspace ? { kind: 'completed', result: 'r', workspace: workspace as never } : { kind: 'completed', result: 'r' });
    return { id: r.id, attempt };
  };
  const built = (name: string) => ended({ mutating: true, cwd: root }, { path: join(root, name), branch: `pipe/${name}`, commit: 'uncommitted', startCommit: 'a'.repeat(40) });
  const has = (table: string, id: string) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  return { root, tmp, path, store, db, submit, start, ended, built, has, samples, now: () => now, advance: (ms: number) => { now += ms; },
    close: () => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const review = (f: ReturnType<typeof fixture>, id: string, state: string, extra: Record<string, unknown> = {}) => {
  const seat = f.ended();
  f.store.insertReview(id, state, { repository: 'r', head: 'h', seats: [{ provider: 'codex', requestId: seat.id, status: 'voted' }, { provider: 'claude', requestId: '', status: 'failed' }], ...extra });
  return seat.id;
};

test('R1 keepRecordsDays defaults to 90 and never goes below the 32 days /v1/stats can ask for; logMaxMb defaults to 10 MiB, 0 is off', () => {
  assert.deepEqual(validateRetention(), { keepRecordsDays: 90, logMaxBytes: 10 * 1024 * 1024 });
  assert.deepEqual(validateRetention({ keepRecordsDays: 32, logMaxMb: 0 }), { keepRecordsDays: 32, logMaxBytes: 0 });
  for (const bad of [{ keepRecordsDays: 31 }, { keepRecordsDays: 40.5 }, { keepRecordsDays: 3661 }, { logMaxMb: -1 }, { logMaxMb: 2048 }, { logMaxMb: Number.NaN }])
    assert.throws(() => validateRetention(bad), RangeError, JSON.stringify(bad));
});

test('R2 an ended request past its age goes with its attempts and admission key; what something still needs stays', (t) => {
  const f = fixture(); t.after(f.close);
  const old = f.ended({ idempotencyKey: 'key-old' });
  const gone = f.built('gone'); f.store.noteWorkspaceHousekeeping(gone.id, removed);
  const worktree = f.built('kept');
  const emptyReceipt = f.built('empty'); f.store.noteWorkspaceHousekeeping(emptyReceipt.id, { removedAt: '' });
  const undated = f.ended(); f.db.prepare("UPDATE requests SET finished_at = '' WHERE id = ?").run(undated.id);
  const impossible = f.ended(); f.db.prepare("UPDATE requests SET finished_at = '2000-19-39T29:00:00.000Z' WHERE id = ?").run(impossible.id);
  const hour24 = f.ended(); f.db.prepare("UPDATE requests SET finished_at = '2000-01-01T24:59:59.999Z' WHERE id = ?").run(hour24.id);
  const badReceipt = f.built('bad'); f.store.noteWorkspaceHousekeeping(badReceipt.id, { removedAt: '2000-00-00T29:00:00.000Z' });
  const scratch = f.ended(); mkdirSync(join(f.tmp, scratch.attempt));
  const source = f.ended();
  const queued = f.submit();
  const running = f.submit(); f.start(running.id);
  const stopping = f.submit(); f.start(stopping.id); assert.ok(f.store.cancel(stopping.id));
  assert.equal(f.store.get(stopping.id)?.state, 'cancelled', 'ended, with its attempt still open');
  f.db.prepare("UPDATE requests SET body = json_set(body, '$.startSource', json_object('requestId', ?)) WHERE id = ?").run(source.id, queued.id);
  f.advance(90 * DAY - 1);
  const recent = f.ended();
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 0, reviews: 0 }, 'nothing is 90 days old yet');
  f.advance(2);
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 2, reviews: 0 });
  for (const g of [old, gone]) { assert.equal(f.has('requests', g.id), false); assert.equal(f.has('attempts', g.attempt), false); }
  assert.equal(f.db.prepare('SELECT count(*) n FROM admissions').get()!.n, 0, 'the admission key went with its request');
  for (const kept of [worktree, emptyReceipt, undated, impossible, hour24, badReceipt, scratch, source, queued, running, stopping, recent]) assert.ok(f.has('requests', kept.id), kept.id);
  rmSync(join(f.tmp, scratch.attempt), { recursive: true });
  const link = join(f.root, 'link'); symlinkSync(join(f.root, 'unmounted', 'tmp'), link);
  for (const unseen of [join(f.root, 'unmounted', 'tmp'), link, join(f.tmp, '..', 'store.sqlite')])
    assert.deepEqual(f.store.pruneEndedRecords(90, unseen), { requests: 0, reviews: 0 }, `${unseen} rules out no scratch`);
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 1, reviews: 0 }, 'its scratch folder is gone now');
  assert.equal(f.store.get(old.id), undefined);
  assert.notEqual(f.submit({ idempotencyKey: 'key-old' }).id, old.id, 'a reused key admits afresh');
});

test('R3 a finished review past its age goes with its seats; a running review, a failed cleanup, an open seat and a recent review stay', (t) => {
  const f = fixture(); t.after(f.close);
  const done = review(f, 'done', 'finished'), running = review(f, 'running', 'running'), stuck = review(f, 'stuck', 'finished', { cleanup: 'Review worktree could not be removed: busy' });
  const open = f.submit(); f.store.insertReview('open-seat', 'finished', { repository: 'r', head: 'h', seats: [{ provider: 'codex', requestId: open.id, status: 'waiting' }] });
  f.store.insertReview('undated', 'finished', { repository: 'r', head: 'h', seats: [] }); f.db.prepare("UPDATE reviews SET updated_at = '' WHERE id = 'undated'").run();
  f.db.prepare("INSERT INTO admissions (namespace, admission_key, request_id, fingerprint, scope, basis, history, explicit) VALUES ('review', 'k', 'done', 'f', 's', 'b', '[]', 1)").run();
  f.advance(91 * DAY);
  const recent = review(f, 'recent', 'finished');
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 1, reviews: 1 }, 'the review first, then its seat in the same pass');
  assert.equal(f.has('reviews', 'done'), false); assert.equal(f.has('requests', done), false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM admissions WHERE namespace = 'review'").get()!.n, 0);
  for (const id of ['running', 'stuck', 'open-seat', 'undated', 'recent']) assert.ok(f.has('reviews', id), id);
  for (const id of [running, stuck, recent, open.id]) assert.ok(f.has('requests', id), id);
});

test('R4 every old review can go: a lane\'s rounds continue from lane_rounds, which a store first opened before u51 backfills', (t) => {
  const f = fixture(); t.after(f.close);
  for (const id of ['L1', 'L2', 'L3']) f.store.insertReview(id, 'finished', { repository: 'r', lane: 'L', seats: [] });
  f.store.insertReview('plain', 'finished', { repository: 'r', seats: [] });
  f.db.exec('DROP TABLE lane_rounds');   // a record from before u51, with lane reviews stored before rounds were
  const at = new Date(f.now()).toISOString();
  for (const id of ['O1', 'O2', 'O3']) f.db.prepare("INSERT INTO reviews (id, state, body, created_at, updated_at) VALUES (?, 'finished', ?, ?, ?)").run(id, JSON.stringify({ repository: 'r', lane: 'O', seats: [] }), at, at);
  for (const [id, lane] of [['n1', 1], ['s1', '1']] as const)   // a number and a string that a TEXT key would make one
    f.db.prepare("INSERT INTO reviews (id, state, body, created_at, updated_at) VALUES (?, 'finished', ?, ?, ?)").run(id, JSON.stringify({ repository: 'r', lane, seats: [] }), at, at);
  const store = new Store(f.path, { now: () => new Date(f.now()) }); t.after(() => store.close());
  f.advance(91 * DAY);
  assert.deepEqual(store.pruneEndedRecords(90, f.tmp), { requests: 0, reviews: 9 });
  assert.equal(f.db.prepare('SELECT count(*) n FROM reviews').get()!.n, 0);
  for (const [id, lane, round] of [['L4', 'L', 4], ['O4', 'O', 4], ['N1', 'N', 1], ['N2', 'N', 2], ['S2', '1', 2]] as const) {
    store.insertReview(id, 'finished', { repository: 'r', lane, seats: [] });
    assert.equal(store.review(id)?.round, round, id);
  }
  f.advance(91 * DAY);
  assert.deepEqual(store.pruneEndedRecords(90, f.tmp), { requests: 0, reviews: 5 });
  store.insertReview('N3', 'finished', { repository: 'r', lane: 'N', seats: [] });
  assert.equal(store.review('N3')?.round, 3, 'each new round raises the lane\'s stored highest');
});

test('R5 unreadable seats or saved starts keep every request, and a malformed seat keeps its review', (t) => {
  const f = fixture(); t.after(f.close);
  const old = f.ended();
  f.store.insertReview('odd', 'finished', { repository: 'r', seats: ['not an object'] });
  f.advance(91 * DAY);
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 0, reviews: 0, unreadable: true });
  f.db.prepare(`UPDATE reviews SET body = json_set(body, '$.seats', json('[{"provider":"codex"}]')) WHERE id = 'odd'`).run();
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 0, reviews: 0, unreadable: true }, 'a seat with no request id is unreadable too');
  f.db.prepare("UPDATE reviews SET body = json_set(body, '$.seats', json('[]')) WHERE id = 'odd'").run();
  const queued = f.submit(); f.db.prepare("UPDATE requests SET body = json_set(body, '$.startSource', 7) WHERE id = ?").run(queued.id);
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 0, reviews: 1, unreadable: true }, 'the review is readable now; the saved start is not');
  f.db.prepare("UPDATE requests SET body = json_remove(body, '$.startSource') WHERE id = ?").run(queued.id);
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 1, reviews: 0 });
  assert.equal(f.has('requests', old.id), false);
});

test('R6 the clock is sampled once: behind its high-water mark nothing goes, and a later sample cannot move the cutoff', (t) => {
  const f = fixture(); t.after(f.close);
  const old = f.ended();
  f.advance(200 * DAY); f.submit(); f.advance(-100 * DAY);
  assert.deepEqual(f.store.pruneEndedRecords(32, f.tmp), { requests: 0, reviews: 0 });
  f.advance(150 * DAY);
  const recent = f.ended();
  f.samples.push(f.now(), f.now() + 3650 * DAY);
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 1, reviews: 0 });
  assert.equal(f.has('requests', old.id), false); assert.ok(f.has('requests', recent.id));
});

test('R7 a pass scans a bounded window and resumes after it, so records it must keep never starve later ones', (t) => {
  const f = fixture(); t.after(f.close);
  const kept = [f.ended(), f.ended()], later = f.ended();
  for (const k of kept) mkdirSync(join(f.tmp, k.attempt));
  f.advance(91 * DAY);
  const before = new Date(f.now() - 90 * DAY).toISOString(), pass = (after: number) => pruneEnded(f.db, before, f.tmp, after, 1, 2);
  const first = pass(0);
  assert.deepEqual({ ...first }, { requests: 0, reviews: 0, next: 2 }, 'the first window holds only kept records');
  assert.deepEqual(pass(first.next), { requests: 1, reviews: 0, next: 0 }, 'the next window reaches the later record and wraps');
  assert.equal(f.has('requests', later.id), false);
  const more = [f.ended(), f.ended()];
  assert.deepEqual(pruneEnded(f.db, new Date(f.now() + DAY).toISOString(), f.tmp, 0, 1, 10), { requests: 1, reviews: 0, next: 4 }, 'a full budget resumes at the next candidate');
  assert.ok(f.has('requests', more[1]!.id));
  // The store keeps the cursor between passes: 5,000 undated rows fill its first window, the next pass reaches past them.
  f.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000) INSERT INTO requests (id, requester, state, body, created_at, updated_at, finished_at)
    SELECT 'undated-' || i, 'test', 'cancelled', '{}', '', '', '' FROM n`);
  const last = f.ended(); f.advance(91 * DAY);
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 1, reviews: 0 }, 'the first window ends inside the undated rows');
  assert.ok(f.has('requests', last.id));
  assert.deepEqual(f.store.pruneEndedRecords(90, f.tmp), { requests: 1, reviews: 0 });
  assert.equal(f.has('requests', last.id), false);
});

test('R8 the service refuses a retention below 32 days; its housekeeping pass prunes, except while a restart still has outcomes to replay', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-retention-svc-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const storePath = join(root, 'store.sqlite'), seed = new Store(storePath, { now: () => new Date(Date.now() - 100 * DAY) });
  const r = seed.submit({ requester: 'test', project: 'test', kind: 'code', provider: 'codex', model: 'gpt-6.1-sol', effort: 'low',
    reason: 'fixture', prompt: 'p', mutating: false, priority: 'interactive' } as never);
  seed.cancel(r.id, 'test'); seed.close();
  const config = { accounts: [], policy: { codex: { models: { 'gpt-6.1-sol': 'default' as const }, efforts: ['low'] } }, storePath,
    token: 't'.repeat(40), cli: {}, worktreeRoot: join(root, 'trees'), minFreeGb: 0, port: 0 };
  await assert.rejects(startPipe({ ...config, housekeeping: { keepRecordsDays: 31 } } as never), /keepRecordsDays must be whole days from 32/);
  const logs: string[] = [], write = process.stderr.write;
  t.mock.method(process.stderr, 'write', ((line: unknown) => { logs.push(String(line)); return true; }) as typeof write);
  const service = await startPipe(config as never); t.after(() => service.stop());
  const db = new DatabaseSync(storePath); t.after(() => db.close());
  const exists = (id: string) => db.prepare('SELECT 1 FROM requests WHERE id = ?').get(id) !== undefined;
  for (let i = 0; i < 100 && exists(r.id); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(exists(r.id), false, 'the first housekeeping pass pruned it');
  const prune = async () => assert.equal((await fetch(`${service.url}/v1/worktrees/prune`, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}` } })).status, 200);
  for (const file of [`${storePath}.pipe-journal`, `${storePath}.pipe-failed-stop`, `${storePath}.pipe-outcome-${'0'.repeat(64)}`]) {
    db.prepare("INSERT INTO requests (id, requester, state, body, created_at, updated_at, finished_at) VALUES ('held', 'test', 'cancelled', '{}', ?, ?, ?)")
      .run(...Array(3).fill('2000-01-01T00:00:00.000Z'));
    writeFileSync(file, '');
    await prune();
    assert.ok(exists('held'), `${file} keeps every record a replay could name`);
    await prune();
    rmSync(file);
    await prune();
    assert.equal(exists('held'), false);
  }
  assert.equal(logs.filter(l => l.includes('ended records are kept while outcomes wait for a restart')).length, 3, 'said once per hold, each time it starts');
  const abandoned = `${storePath}.pipe-outcome-${'0'.repeat(64)}.${'1'.repeat(8)}`;   // an interrupted write recovery never replays
  db.prepare("INSERT INTO requests (id, requester, state, body, created_at, updated_at, finished_at) VALUES ('held', 'test', 'cancelled', '{}', ?, ?, ?)")
    .run(...Array(3).fill('2000-01-01T00:00:00.000Z'));
  writeFileSync(abandoned, '');
  await prune();
  assert.equal(exists('held'), false, 'it holds nothing back');
});

test('R9 capLog keeps the newest whole lines of a log it writes to, under half its cap, after one line saying so', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-log-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'pipe.log'), lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}\n`);
  writeFileSync(path, lines.join(''));
  const fd = openSync(path, 'a+'), again = openSync(path, 'a+'); t.after(() => { closeSync(fd); closeSync(again); });
  assert.equal(capLog(1_000_000, [fd]), 0, 'under its cap it is left alone');
  assert.equal(capLog(0, [fd]), 0, '0 is off');
  const before = statSync(path).size, removedBytes = capLog(1000, [fd, again]);
  const text = readFileSync(path, 'utf8'), [note, ...rest] = text.split('\n');
  assert.match(note!, new RegExp(`^pipe log: trimmed at ${before} bytes, keeping the newest \\d+ \\(housekeeping.logMaxMb\\)$`));
  assert.ok(text.length <= 1000, `${text.length} bytes`);
  assert.equal(rest.join('\n'), lines.slice(-rest.length + 1).join(''), 'whole lines, the newest ones');
  assert.ok(rest.length > 5);
  assert.equal(removedBytes, before - Buffer.byteLength(rest.join('\n')));
  writeSync(again, 'after\n');
  assert.ok(readFileSync(path, 'utf8').endsWith(`${lines.at(-1)}after\n`), 'the next line lands at the new end');
  writeFileSync(path, 'y'.repeat(5000));
  capLog(1000, [fd]);
  assert.match(readFileSync(path, 'utf8'), /^pipe log: trimmed at 5000 bytes, keeping the newest 0 \(housekeeping.logMaxMb\)\n$/, 'no whole line, none kept');
});

test('R10 a write-only log keeps no old lines; a log not opened for append is trimmed once, reported, then left; a pipe is skipped', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-log-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const only = join(root, 'only.log'), plain = join(root, 'plain.log');
  writeFileSync(only, 'y\n'.repeat(2500)); writeFileSync(plain, 'z'.repeat(5000));
  const w = openSync(only, 'a'); t.after(() => closeSync(w));
  capLog(1000, [w]);
  assert.match(readFileSync(only, 'utf8'), /^pipe log: trimmed at 5000 bytes, keeping the newest 0 \(housekeeping.logMaxMb\)\n$/);
  const r = openSync(plain, 'r+'); t.after(() => closeSync(r));
  writeSync(r, 'z'.repeat(5000));   // its own offset now sits at the old end
  assert.throws(() => capLog(1000, [r]), /descriptor \d+ is not opened for append/);
  writeSync(r, 'z'.repeat(5000));
  assert.equal(capLog(1000, [r]), 0, 'left alone after the report');
  assert.equal(capLog(1000, [0]), 0, 'stdin of the test runner is not a file it writes');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type NewRequest, type AttemptOutcome } from '../src/store.ts';
import { card } from '../src/cards.ts';

const pin = 'a'.repeat(40), observed = 'b'.repeat(40);
const body = (cwd: string): NewRequest => ({ requester: 'fixture', project: 'p183', kind: 'code', provider: 'codex',
  model: 'fixture', effort: 'high', reason: 'local fixture', prompt: 'private content', mutating: true,
  priority: 'interactive', cwd });
const mismatch = { kind: 'failed', errorKind: 'start_mismatch', message: `requested ${pin}; observed ${observed}` } as AttemptOutcome;
const claim = (store: Store, id: string) => {
  const result = store.startAttempt(id, { id: 'fixture', provider: 'codex', loginDir: '/unused', fingerprint: 'fixture', enabled: true, maxConcurrency: 1 },
    { accountId: 'fixture', model: 'fixture', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 1 }, grant: [] });
  assert.ok(result.ok); return result.attempt;
};

test('P183 legacy CHECK upgrades with attempts, indexes, change cursor and terminal timestamp intact', t => {
  const root = mkdtempSync(join(tmpdir(), 'pipe183-migration-')), path = join(root, 'db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new Store(path); const r = store.submit(body(root)), attempt = claim(store, r.id);
  const before = store.changedAfter(0, 100).next; store.close();
  // Build the pre-feature schema even when this test runs against the new implementation.
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = OFF');
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'requests'").get()!.sql as string;
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (type = 'trigger' OR type = 'index' AND tbl_name = 'requests')").all();
  for (const o of objects) if (o.type === 'trigger') db.exec(`DROP TRIGGER "${o.name}"`);
  db.exec(schema.replace('CREATE TABLE requests', 'CREATE TABLE requests_old').replace(", 'start_mismatch'", ''));
  db.exec('INSERT INTO requests_old SELECT * FROM requests; DROP TABLE requests; ALTER TABLE requests_old RENAME TO requests');
  for (const o of objects) db.exec(String(o.sql).replace(", 'start_mismatch'", ''));
  db.prepare("UPDATE sqlite_sequence SET seq = 900 WHERE name = 'requests'").run();
  db.close();
  store = new Store(path); t.after(() => store.close());
  assert.equal(store.attempts(r.id)[0]!.id, attempt.id);
  assert.deepEqual(store.changedAfter(0, 100).next, before, 'migration does not masquerade as a job update');
  store.noteClosed(attempt.id); store.finishAttempt(attempt.id, mismatch);
  const refused = store.get(r.id)!;
  assert.equal(refused.state, 'start_mismatch'); assert.ok(refused.finishedAt);
  assert.equal(store.list('start_mismatch').length, 1); assert.equal(store.openRequests().length, 0);
  assert.equal(store.cancel(r.id), false); assert.equal(store.get(r.id)!.state, 'start_mismatch');
  assert.deepEqual(store.get(r.id)!.avoid, []);
  const c = card(refused, store.attempts(r.id), { alias: () => 'fixture', runnerAlive: () => false, draining: false });
  assert.equal(c.finishedAt, refused.finishedAt); assert.equal(c.startCommit, null);
  assert.equal(JSON.stringify(c).includes(pin), false); assert.equal(JSON.stringify(c).includes('private content'), false);
  const check = new DatabaseSync(path); t.after(() => check.close());
  assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'requests_build_created'").get());
  assert.ok(store.submit(body(root)).seq > 900, 'deleted submission numbers are never reused');
});

test('P183 pinned records refuse older engines and never downgrade after ordinary/automatic submission', t => {
  const root = mkdtempSync(join(tmpdir(), 'pipe183-format-')), path = join(root, 'db');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(path); t.after(() => store.close());
  store.submit({ ...body(root), pinnedStartCommit: pin } as NewRequest);
  store.submit({ ...body(root), provider: 'codex', model: 'gpt-6.1-sol', placement: 'ordinary_headroom',
    automatic: { fallback: { provider: 'claude', model: 'opus', effort: 'high', reason: 'fixture' }, reviewReserve: 0.1 } });
  const db = new DatabaseSync(path); t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
});

test('P183 bounded cleanliness reading still refuses a large dirty tree as start_mismatch', async t => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { run } = await import('../src/runner.ts');
  const root = mkdtempSync(join(tmpdir(), 'pipe183-dirt-')), repo = join(root, 'repo'); mkdirSync(repo);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', ...args], { env, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('commit', '--allow-empty', '-m', 'seed'); const sha = git('rev-parse', 'HEAD');
  for (let i = 0; i < 60; i++) writeFileSync(join(repo, `untracked-${i}-${'x'.repeat(40)}`), 'dirt');
  const events = [];
  for await (const e of run({ ...body(repo), requestId: 'fixture', accountId: 'fixture', cwd: repo, provider: 'codex', loginDir: root,
    pinnedStartCommit: sha, requireCleanStart: true }, { cli: { codex: '/usr/bin/false' }, env, worktreeRoot: join(root, 'trees'), gitTimeoutMs: 5000 })) events.push(e);
  assert.equal(events.at(-1)?.type, 'failed');
  assert.equal((events.at(-1) as { errorKind?: string }).errorKind, 'start_mismatch', JSON.stringify(events));
});

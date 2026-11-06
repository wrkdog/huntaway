import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { RequestLog } from '../src/core/request-log.ts';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'huntaway-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'requests.sqlite');
}

test('an existing empty SQLite file initializes once and reopens', t => {
  const path = fixture(t);
  const native = new DatabaseSync(path); native.close();
  const first = new RequestLog(path);
  assert.deepEqual(first.recovery(), { closed: false, epoch: 0 });
  first.close();
  const second = new RequestLog(path);
  assert.deepEqual(second.recovery(), { closed: false, epoch: 0 });
  second.close();
});

test('a foreign version-zero schema is refused without changing its main file', t => {
  const path = fixture(t);
  const native = new DatabaseSync(path);
  native.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
  native.close();
  const before = readFileSync(path);
  assert.throws(() => new RequestLog(path), /Unsupported database schema/);
  assert.deepEqual(readFileSync(path), before);
});

test('orphan WAL refuses missing or empty main file without discarding evidence', t => {
  const path = fixture(t);
  const wal = `${path}-wal`;
  writeFileSync(wal, 'crash-evidence');
  assert.throws(() => new RequestLog(path), /Database requires recovery/);
  assert.equal(readFileSync(wal, 'utf8'), 'crash-evidence');
  writeFileSync(path, '');
  assert.throws(() => new RequestLog(path), /Database requires recovery/);
  assert.equal(readFileSync(wal, 'utf8'), 'crash-evidence');
});

test('a rollback-journal sidecar refuses startup without touching it', t => {
  const path = fixture(t);
  const journal = `${path}-journal`;
  writeFileSync(journal, 'possible-hot-journal');
  assert.throws(() => new RequestLog(path), /Database requires recovery/);
  assert.equal(readFileSync(journal, 'utf8'), 'possible-hot-journal');
});

test('existing symlink resolves to the database target and dangling alias refuses', t => {
  const alias = fixture(t);
  const target = `${alias}.target`;
  const created = new RequestLog(target);
  created.close();
  symlinkSync(target, alias);
  const reopened = new RequestLog(alias);
  assert.deepEqual(reopened.recovery(), { closed: false, epoch: 0 });
  reopened.close();
  const dangling = `${alias}.dangling`;
  symlinkSync(`${target}.missing`, dangling);
  assert.throws(() => new RequestLog(dangling), /Database target unavailable/);
});

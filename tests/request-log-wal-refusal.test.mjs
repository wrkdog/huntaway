import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestLog } from '../src/core/request-log.ts';

const input = {
  team: 'T1', channel: 'C1', ts: '1.000001', agent: 'research',
  thread: '1.000001', contentHash: 'a'.repeat(64),
};

test('rejecting a committed invalid WAL after writer death preserves durable data files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'huntaway-wal-refusal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'requests.sqlite');
  const log = new RequestLog(path);
  log.record(input);
  log.close();

  const child = spawnSync(process.execPath, [
    '--experimental-strip-types', '-e',
    `const { DatabaseSync } = require('node:sqlite');
     const db = new DatabaseSync(process.argv[1]);
     db.exec("UPDATE requests SET state = 'answered'");
     process.kill(process.pid, 'SIGKILL');`,
    path,
  ], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);

  // SQLite may rebuild its disposable -shm index during a read-only open.
  // The durable main database and committed WAL must remain byte-identical.
  const names = [path, `${path}-wal`];
  const snapshot = () => names.map(name => {
    if (!existsSync(name)) return null;
    const bytes = readFileSync(name);
    return { length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const before = snapshot();
  assert.ok(before[1]?.length, 'writer death must leave a WAL to exercise recovery');
  assert.throws(() => new RequestLog(path), /Invalid request history/);
  assert.deepEqual(snapshot(), before, 'refusal rewrote or removed durable data files');
});

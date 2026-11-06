import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { RequestLog } from '../src/core/request-log.ts';

const input = { team: 'T1', channel: 'C1', ts: '1.000001', agent: 'research', thread: '1.000001', contentHash: 'a'.repeat(64) };

for (const [name, sql] of [
  ['unexpected journal-erasing trigger', 'CREATE TRIGGER erase_journal AFTER INSERT ON journal BEGIN DELETE FROM journal; END;'],
  ['journal table without its foreign key', `ALTER TABLE journal RENAME TO old_journal;
    CREATE TABLE journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, version INTEGER NOT NULL);
    INSERT INTO journal SELECT * FROM old_journal; DROP TABLE old_journal;`],
  ['missing journal history', 'DELETE FROM journal'],
  ['row state differs from history', "UPDATE requests SET state = 'answered'"],
  ['row version differs from history', 'UPDATE requests SET version = 7'],
  ['identity differs from its key', "UPDATE requests SET team = 'OtherTeam'"],
  ['journal skips a version', 'UPDATE journal SET version = 7 WHERE version = 1'],
  ['journal has an impossible edge', "UPDATE journal SET from_state = 'posting' WHERE version = 1"],
  ['request is from a future recovery epoch', 'UPDATE requests SET epoch = 99'],
]) {
  test(`opening refuses ${name} without repairing or modifying the database`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'huntaway-integrity-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'requests.sqlite');
    const log = new RequestLog(path);
    const r = log.record(input).request; log.transition(r.key, r.version, 'queued'); log.close();
    const native = new DatabaseSync(path); native.exec(sql); native.close();
    const before = readFileSync(path);
    let unexpected;
    try { assert.throws(() => { unexpected = new RequestLog(path); }); }
    finally { unexpected?.close(); }
    assert.deepEqual(readFileSync(path), before, 'opening silently modified the invalid database');
  });
}

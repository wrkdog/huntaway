import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestLog } from '../src/core/request-log.ts';

const input = { team: 'T1', channel: 'C1', ts: '1.000001', agent: 'research', thread: '1.000001', contentHash: 'a'.repeat(64) };
const paths = [
  ['refused'], ['queued', 'refused'], ['queued', 'cancelled'], ['queued', 'expired'],
  ['queued', 'submitting', 'failed'], ['queued', 'submitting', 'uncertain'],
  ['queued', 'submitting', 'dispatched', 'failed'],
  ['queued', 'submitting', 'dispatched', 'uncertain'],
  ['queued', 'submitting', 'dispatched', 'posting', 'failed'],
  ['queued', 'submitting', 'dispatched', 'posting', 'uncertain'],
  ['queued', 'submitting', 'dispatched', 'posting', 'answered'],
];

for (const path of paths) {
  test(`approved path received -> ${path.join(' -> ')} is durable and terminal`, () => {
    const db = new RequestLog(':memory:');
    try {
      let request = db.record(input).request;
      for (const state of path) request = db.transition(request.key, request.version, state);
      assert.equal(request.state, path.at(-1));
      assert.deepEqual(db.journal(request.key).map(entry => entry.to), ['received', ...path]);
      for (const next of ['received', 'queued', 'submitting', 'dispatched', 'posting', 'answered', 'failed', 'uncertain']) {
        assert.throws(() => db.transition(request.key, request.version, next));
      }
      assert.equal(db.journal(request.key).length, path.length + 1);
    } finally { db.close(); }
  });
}

test('reopened recovery preserves the epoch fence on an old in-flight request', t => {
  const directory = mkdtempSync(join(tmpdir(), 'huntaway-epoch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'log.sqlite');
  const first = new RequestLog(path);
  let stale = first.record(input).request;
  for (const state of ['queued', 'submitting', 'dispatched']) stale = first.transition(stale.key, stale.version, state);
  first.close();
  const second = new RequestLog(path);
  const epoch = second.beginRecovery(); second.finishRecovery(epoch); second.close();
  const third = new RequestLog(path);
  try {
    assert.equal(third.recovery().closed, false);
    assert.throws(() => third.transition(stale.key, stale.version, 'posting'));
    const current = third.record({ ...input, channel: 'C2' }).request;
    assert.equal(current.epoch, epoch);
    assert.equal(third.transition(current.key, current.version, 'queued').state, 'queued');
  } finally { third.close(); }
});

test('closed recovery permits reconciliation state but never a stale answer', () => {
  const db = new RequestLog(':memory:');
  try {
    let request = db.record(input).request;
    request = db.transition(request.key, request.version, 'queued');
    request = db.transition(request.key, request.version, 'submitting');
    const epoch = db.beginRecovery();
    assert.equal(db.record(input).created, false, 'a duplicate must remain idempotent');
    request = db.transition(request.key, request.version, 'dispatched');
    assert.throws(() => db.transition(request.key, request.version, 'posting'));
    request = db.transition(request.key, request.version, 'uncertain');
    assert.equal(request.state, 'uncertain');
    db.finishRecovery(epoch);
    assert.throws(() => db.transition(request.key, request.version, 'answered'));
  } finally { db.close(); }
});

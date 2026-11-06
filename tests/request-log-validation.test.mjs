import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestLog } from '../src/core/request-log.ts';

test('runtime validation refuses coercible non-string names before writing', () => {
  const db = new RequestLog(':memory:');
  const good = { team: 'T1', channel: 'C1', ts: '1.000001', agent: 'research', thread: '1.000001', contentHash: 'a'.repeat(64) };
  try {
    for (const agent of [123, true, null, undefined, ['research']]) {
      assert.throws(() => db.record({ ...good, agent }), `accepted non-string agent: ${typeof agent}`);
    }
    assert.equal(db.record(good).created, true);
  } finally { db.close(); }
});

test('timestamps are canonical and bounded, so one message cannot acquire alternate identities', () => {
  const db = new RequestLog(':memory:');
  const good = { team: 'T1', channel: 'C1', ts: '1.000001', agent: 'research', thread: '1.000001', contentHash: 'a'.repeat(64) };
  try {
    for (const timestamp of ['01.000001', '0001.000001', '1234567890123.000001']) {
      assert.throws(() => db.record({ ...good, ts: timestamp }));
      assert.throws(() => db.record({ ...good, thread: timestamp }));
    }
    assert.equal(db.record(good).created, true);
    assert.equal(db.record({ ...good, ts: '0.000000' }).created, true);
  } finally { db.close(); }
});

test('input fields are copied once before validation and use', () => {
  const db = new RequestLog(':memory:'); let reads = 0;
  const input = { team: 'T1', channel: 'C1', ts: '1.000001', get agent() { reads += 1; return reads === 1 ? 'research' : 'changed'; }, thread: '1.000001', contentHash: 'a'.repeat(64) };
  try {
    const result = db.record(input);
    assert.equal(reads, 1); assert.equal(result.request.agent, 'research');
  } finally { db.close(); }
});

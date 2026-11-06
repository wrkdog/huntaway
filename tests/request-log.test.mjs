import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RequestLog } from '../src/core/request-log.ts';

const input = { team: 'T1', channel: 'C1', ts: '1234567890.123456', agent: 'research', thread: '1234567890.123456', contentHash: 'a'.repeat(64) };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'huntaway-journal-'));
  const path = join(directory, 'requests.sqlite');
  const handles = [];
  t.after(() => { for (const db of handles) { try { db.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  return { path, open() { const db = new RequestLog(path); handles.push(db); return db; } };
}
function advance(db, request, ...states) {
  for (const state of states) request = db.transition(request.key, request.version, state);
  return request;
}

test('record survives close/reopen; duplicate returns original without another journal entry', t => {
  const f = fixture(t); const db = f.open();
  const first = db.record(input);
  assert.equal(first.created, true); assert.equal(first.request.state, 'received'); assert.equal(first.request.version, 0);
  db.close(); const reopened = f.open();
  const second = reopened.record(input);
  assert.equal(second.created, false); assert.deepEqual(second.request, first.request);
  assert.deepEqual(reopened.get(first.request.key), first.request);
  assert.equal(reopened.get('not-recorded'), null);
  const journal = reopened.journal(first.request.key);
  assert.equal(journal.length, 1); assert.equal(journal[0].from, null); assert.equal(journal[0].to, 'received');
});

test('duplicate identity refuses changed immutable data and leaves the original untouched', t => {
  const db = fixture(t).open(); const original = db.record(input).request;
  for (const change of [{ agent: 'other' }, { thread: '1234567891.000001' }, { contentHash: 'b'.repeat(64) }]) {
    assert.throws(() => db.record({ ...input, ...change }));
    assert.deepEqual(db.get(original.key), original); assert.equal(db.journal(original.key).length, 1);
  }
});

test('tuple identity includes team and channel, without ambiguous concatenation', t => {
  const db = fixture(t).open();
  const keys = [input, { ...input, team: 'T2' }, { ...input, channel: 'C2' }, { ...input, team: 'a-b', channel: 'c' }, { ...input, team: 'a', channel: 'b-c' }].map(x => db.record(x).request.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('refuses malformed identity and hash without writing a valid request', t => {
  const db = fixture(t).open();
  for (const invalid of [{ ts: '1.1' }, { ts: '-1.000000' }, { ts: '1.0000000' }, { thread: 'bad' }, { team: '' }, { team: 'x'.repeat(129) }, { agent: "x'); DROP TABLE requests;--" }, { channel: '../secret' }, { contentHash: 'A'.repeat(64) }, { contentHash: 'short' }]) {
    assert.throws(() => db.record({ ...input, ...invalid }));
  }
  assert.equal(db.record(input).created, true);
});

test('allowed transitions append a durable, ordered journal, with no replay from terminal state', t => {
  const f = fixture(t); const db = f.open(); const first = db.record(input).request;
  const last = advance(db, first, 'queued', 'submitting', 'dispatched', 'posting', 'answered');
  assert.equal(last.version, 5); assert.equal(last.state, 'answered');
  const entries = db.journal(first.key);
  assert.deepEqual(entries.map(x => x.to), ['received', 'queued', 'submitting', 'dispatched', 'posting', 'answered']);
  assert.deepEqual(entries.map(x => x.version), [0, 1, 2, 3, 4, 5]);
  assert.ok(entries.every((entry, i) => i === 0 || entry.sequence > entries[i - 1].sequence));
  assert.throws(() => db.transition(first.key, last.version, 'submitting'));
  db.close(); assert.equal(f.open().get(first.key).state, 'answered');
});

test('invalid edge and stale version change neither the request nor journal', t => {
  const db = fixture(t).open(); const r = db.record(input).request;
  assert.throws(() => db.transition(r.key, r.version, 'answered'));
  const queued = db.transition(r.key, r.version, 'queued');
  for (const [version, state] of [[r.version, 'submitting'], [queued.version, 'received'], [queued.version, "failed';DELETE"]]) {
    assert.throws(() => db.transition(r.key, version, state));
    assert.deepEqual(db.get(r.key), queued); assert.equal(db.journal(r.key).length, 2);
  }
});

test('two database connections cannot both win a version transition', t => {
  const f = fixture(t); const a = f.open(); const b = f.open();
  const r = a.record(input).request;
  assert.equal(b.record(input).created, false);
  a.transition(r.key, r.version, 'queued');
  assert.throws(() => b.transition(r.key, r.version, 'refused'));
  assert.equal(b.get(r.key).state, 'queued'); assert.equal(b.journal(r.key).length, 2);
});

test('every supported early terminal is permanent', t => {
  const db = fixture(t).open();
  for (const [index, states] of [['refused'], ['queued', 'cancelled'], ['queued', 'expired'], ['queued', 'submitting', 'failed'], ['queued', 'submitting', 'uncertain']].entries()) {
    const r = advance(db, db.record({ ...input, channel: `C${index}` }).request, ...states);
    for (const state of ['received', 'queued', 'submitting', 'dispatched', 'posting', 'answered']) assert.throws(() => db.transition(r.key, r.version, state));
    assert.equal(db.journal(r.key).length, states.length + 1);
  }
});

test('recovery barrier persists across restart and refuses intake, dispatch and posting', t => {
  const f = fixture(t); const db = f.open();
  const queued = advance(db, db.record(input).request, 'queued');
  const dispatched = advance(db, db.record({ ...input, channel: 'C2' }).request, 'queued', 'submitting', 'dispatched');
  const epoch = db.beginRecovery(); db.close(); const next = f.open();
  assert.deepEqual(next.recovery(), { closed: true, epoch });
  assert.throws(() => next.record({ ...input, channel: 'C3' }));
  assert.throws(() => next.transition(queued.key, queued.version, 'submitting'));
  assert.throws(() => next.transition(dispatched.key, dispatched.version, 'posting'));
  assert.equal(next.journal(dispatched.key).length, 4);
});

test('old in-flight completion cannot post or answer even after recovery reopens', t => {
  const f = fixture(t); const db = f.open();
  const dispatched = advance(db, db.record(input).request, 'queued', 'submitting', 'dispatched');
  const posting = advance(db, db.record({ ...input, channel: 'C2' }).request, 'queued', 'submitting', 'dispatched', 'posting');
  const epoch = db.beginRecovery(); db.finishRecovery(epoch);
  assert.throws(() => db.transition(dispatched.key, dispatched.version, 'posting'));
  assert.throws(() => db.transition(posting.key, posting.version, 'answered'));
  const current = advance(db, db.record({ ...input, channel: 'C3' }).request, 'queued', 'submitting');
  assert.equal(current.epoch, epoch); assert.equal(current.state, 'submitting');
});

test('an older recovery operation cannot reopen a newer barrier', t => {
  const db = fixture(t).open(); const first = db.beginRecovery(); const second = db.beginRecovery();
  assert.ok(second > first); assert.throws(() => db.finishRecovery(first));
  assert.deepEqual(db.recovery(), { closed: true, epoch: second });
});

test('unknown database schema version is refused and preserved', t => {
  const f = fixture(t); const native = new DatabaseSync(f.path);
  native.exec('PRAGMA user_version = 999'); native.close();
  assert.throws(() => f.open());
  const check = new DatabaseSync(f.path); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 999); check.close();
});

test('committed submission survives abrupt process death without reverting to queued', async t => {
  const f = fixture(t); const moduleUrl = new URL('../src/core/request-log.ts', import.meta.url).href;
  const script = `import {RequestLog} from ${JSON.stringify(moduleUrl)}; const db=new RequestLog(process.argv[1]); let r=db.record(${JSON.stringify(input)}).request; r=db.transition(r.key,0,'queued'); r=db.transition(r.key,1,'submitting'); process.stdout.write(r.key+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, f.path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = ''; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const key = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not commit: ${stderr}`)), 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', () => { clearTimeout(timer); if (!output.includes('\n')) reject(new Error(`child exited early: ${stderr}`)); });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); resolve(output.trim()); } });
  });
  const died = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await died;
  const db = f.open(); assert.equal(db.get(key).state, 'submitting'); assert.equal(db.journal(key).length, 3);
  assert.throws(() => db.transition(key, 2, 'queued'));
});

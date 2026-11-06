/** Round 6 M1: persisted receipt lookup precedes mutable cwd checks.
 * Oracle: the E1 same-key/body receipt contract; a new admission still requires a real directory.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startHttp } from '../src/http.ts';
import { Store } from '../src/store.ts';

type Reply = { status: number; body: {
  request?: { id: string; state: string; seq: number; createdAt: string; admissionKey: string;
    dispatchClass: string; reuse: { requestId: string; verdict: null; timeSavedMs: null } | null };
  error?: { code: string; message: string };
} };

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-e1-cwd-replay-')), cwd = join(root, 'cwd');
  mkdirSync(cwd);
  const path = join(root, 'record.sqlite'), open = () => new Store(path);
  let store = open();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(_port: number, _host: string, ready: () => void) { ready(); }, address() { return { port: 1 }; },
  });
  // Same socket-free real-handler harness as e1-admission.test.ts; no loopback or provider process.
  t.mock.method(http, 'createServer', (cb: typeof handler) => { handler = cb; return server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', get store() { return store; },
    policy: { codex: { models: { 'gpt-6-astra': 'hard' }, efforts: ['high'] } },
    accounts: () => [], models: () => ({}), accountIds: () => [],
    draining: () => false, drain: async () => {}, cancel: () => {} });
  const input = { requester: 'fixture', project: 'fixture', kind: 'code', mutating: true,
    provider: 'codex', model: 'gpt-6-astra', effort: 'high', reason: 'receipt regression fixture',
    priority: 'interactive', cwd, prompt: 'Change the inert fixture.' };
  const post = (body: unknown): Promise<Reply> => new Promise(resolve => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', url: '/v1/requests',
      headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    });
    let status = 0;
    handler!(req as IncomingMessage, { writeHead(code: number) { status = code; },
      end(data: string) { resolve({ status, body: JSON.parse(data) }); } } as ServerResponse);
  });
  return { cwd, input, post, get store() { return store; },
    reopen() { store.close(); store = open(); } };
}

for (const explicit of [true, false]) test(`M1 ${explicit ? 'explicit' : 'computed'} key reuses the original HTTP receipt after cwd disappears and store reopens`, async t => {
  // Computed-key replay opts in by version; leave explicit-key inputs unchanged.
  const f = await fixture(t), input = { ...f.input, ...(explicit ? { idempotencyKey: 'cwd-replay' }
    : { evidenceVersion: 'evidence-v1', policyVersion: 'policy-v1' }) };
  const first = await f.post(input);
  assert.equal(first.status, 201);
  const original = first.body.request!;
  assert.equal(original.reuse, null);
  rmSync(f.cwd, { recursive: true });
  f.reopen();
  const replay = await f.post(input);
  assert.ok(replay.status === 200 || replay.status === 201,
    `persisted identical admission must survive cwd loss; received ${replay.status}: ${JSON.stringify(replay.body)}`);
  assert.deepEqual(replay.body.request, { ...original, dispatchClass: 'repeat',
    reuse: { requestId: original.id, verdict: null, timeSavedMs: null } });
  assert.deepEqual(f.store.list().map(r => r.id), [original.id]);
  assert.deepEqual(f.store.attempts(original.id), [], 'replay creates no attempt');
});

test('M1 a new body with a fresh key in the vanished cwd still gets 400 without admission', async t => {
  const f = await fixture(t), first = await f.post({ ...f.input, idempotencyKey: 'original-cwd-job' });
  assert.equal(first.status, 201);
  rmSync(f.cwd, { recursive: true });
  f.reopen();
  const fresh = await f.post({ ...f.input, prompt: 'A new task.', idempotencyKey: 'fresh-cwd-job' });
  assert.equal(fresh.status, 400);
  assert.equal(fresh.body.error?.code, 'invalid_request');
  assert.match(fresh.body.error!.message, /cwd must be an existing directory/);
  assert.deepEqual(f.store.list().map(r => r.id), [first.body.request!.id]);
  assert.deepEqual(f.store.openAttempts(), []);
});

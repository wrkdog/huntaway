import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store, type NewRequest } from '../src/store.ts';
import { plan } from '../src/queue.ts';

const now = new Date('2026-10-05T12:00:00Z'), hash = 'a'.repeat(40), savedHash = 'b'.repeat(40);
const secret = 'SECRET_PROMPT_RESULT_CREDENTIAL_FINGERPRINT_PATH';
const request = (extra = {}): NewRequest => ({ requester: 'fixture', project: 'fixture', provider: 'codex', model: 'fixture',
  effort: 'high', reason: secret, prompt: secret, kind: 'code', mutating: false, priority: 'interactive', ...extra });
const account = { id: 'fixture', provider: 'codex' as const, enabled: true, loginDir: '/' + secret, fingerprint: secret, maxConcurrency: 1 };
const evidence = (credits = false) => ({ accountId: account.id, model: 'fixture', observedAt: now.toISOString(),
  verdict: { state: 'available' as const, headroom: .5, ...(credits ? { via: 'credits' as const } : {}) }, grant: [secret] });

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u28-')), db = join(root, 'record.sqlite'), capture = join(root, 'transport.json');
  const store = new Store(db, { now: () => now });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  // Actual MCP -> client -> HTTP handler -> public Store/card projection. No sockets or live service.
  const preload = join(root, 'transport.mjs');
  writeFileSync(preload, `
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { Store } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
import { startHttp } from ${JSON.stringify(new URL('../src/http.ts', import.meta.url).href)};
let handler;
http.createServer = cb => { handler = cb; return Object.assign(new EventEmitter(), {
  listen(_p, _h, cb) { cb(); }, address() { return { port: 1 }; }, close(cb) { cb(); }
}); };
syncBuiltinESMExports();
const store = new Store(${JSON.stringify(db)}, { now: () => new Date(${JSON.stringify(now.toISOString())}) });
await startHttp({ token: 'fixture-token', store, policy: { codex: { models: { fixture: 'default' }, efforts: ['high'] } },
  accounts: () => [], models: () => ({}), accountIds: () => ['fixture'], draining: () => false,
  drain: async () => {}, cancel() {}, cards: { alias: () => 'Fixture', runnerAlive: () => null, health: () => ({}) } });
globalThis.fetch = async (url, init) => {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url, body: init.body ? JSON.parse(init.body) : null }));
  return new Promise(resolve => {
    const input = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
      url: new URL(url).pathname, method: init.method, headers: init.headers });
    let status;
    handler(input, { writeHead(code) { status = code; }, end(body) { resolve(new Response(body, { status })); } });
  });
};
process.on('exit', () => store.close());
`);
  function frame(method: string, params?: unknown) {
    rmSync(capture, { force: true });
    const r = spawnSync(process.execPath, ['--import', preload, 'src/mcp.ts'], { encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root, PIPE_URL: 'http://127.0.0.1:1', PIPE_TOKEN: 'fixture-token' },
      input: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) + '\n' });
    assert.equal(r.status, 0, r.stderr); const response = JSON.parse(r.stdout); assert.equal(response.id, 7);
    return response.result;
  }
  const call = (name: string, args: unknown) => frame('tools/call', { name, arguments: args });
  const data = (name: string, args: unknown) => {
    const result = call(name, args); assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text.split('\n').slice(1).join('\n'));
  };
  return { root, db, store, capture, frame, call, data };
}

test('M1 MCP catalog advertises optional submit placement, selection status and card; keeps start selector/review placement', t => {
  const f = fixture(t), catalog = f.frame('tools/list').tools;
  const schema = (name: string) => catalog.find((v: any) => v.name === name)?.inputSchema;
  assert.deepEqual(schema('pipe_submit').properties.placement, { type: 'string', enum: ['ordinary_headroom'] });
  assert.equal(schema('pipe_submit').required.includes('placement'), false);
  assert.equal(schema('pipe_submit').properties.expectedStartCommit.type, 'string');
  assert.deepEqual(schema('pipe_review').properties.placement, { type: 'string', enum: ['ordinary_headroom'] });
  assert.equal(schema('pipe_status').properties.selection.type, 'boolean');
  assert.deepEqual(schema('pipe_card').required, ['id']);
});

test('M2 malformed submit placement is rejected before transport', t => {
  const f = fixture(t);
  for (const placement of [null, '', 'auto', 'ordinary', 'ORDINARY_HEADROOM', false, 1, {}, []]) {
    const out = f.call('pipe_submit', request({ placement })); assert.equal(out.isError, true); assert.match(out.content[0].text, /placement/);
    assert.throws(() => readFileSync(f.capture), /ENOENT/);
  }
  assert.deepEqual(f.store.list(), []);
});

test('M3 MCP omission preserves spreading and credit admission; explicit placement excludes credits at plan and claim', t => {
  const f = fixture(t);
  for (const placement of [undefined, 'ordinary_headroom']) {
    const out = f.data('pipe_submit', request(placement ? { placement } : {})), r = f.store.get(out.request.id)!;
    assert.equal(r.placement, placement); assert.equal(Object.hasOwn(r, 'placement'), !!placement);
    const status = (id: string, room: number, running: number) => ({ account: { ...account, id, maxConcurrency: 2 }, running,
      evidence: () => ({ ...evidence(), accountId: id, verdict: { state: 'available' as const, headroom: room } }) });
    const options = { now, pinWaitMs: 60000, evidenceMaxAgeMs: 60000, load: new Map() };
    assert.equal(plan([r], [status('a', .9, 1), status('b', .2, 0)], options).dispatch[0]?.accountId, placement ? 'a' : 'b');
    const credit = evidence(true);
    assert.equal(plan([r], [{ account, running: 0, evidence: () => credit }], options).dispatch.length, placement ? 0 : 1);
    const claim = f.store.startAttempt(r.id, account, credit); assert.equal(claim.ok, !placement);
    if (claim.ok) f.store.finishAttempt(claim.attempt.id, { kind: 'completed', result: secret });
  }
});

test('M4 narrow MCP status/card keep original ID and exclude content; full status/wait remain compatible', t => {
  const f = fixture(t), r = f.store.submit(request({ mutating: true, cwd: f.root })), claim = f.store.startAttempt(r.id, account, evidence()); assert.ok(claim.ok);
  f.store.noteClosed(claim.attempt.id); f.store.finishAttempt(claim.attempt.id, { kind: 'completed', result: secret });
  const db = new DatabaseSync(f.db);
  const body = JSON.parse(String((db.prepare('SELECT body FROM requests WHERE id = ?').get(r.id) as any).body));
  body.expectedStartCommit = hash;
  body.startSource = { requestId: 'source', cwd: '/' + secret, path: '/' + secret, branch: 'pipe/source', commit: hash,
    startCommit: hash, repository: '/' + secret, device: secret, inode: secret };
  db.prepare('UPDATE requests SET body = ? WHERE id = ?').run(JSON.stringify(body), r.id); db.close();
  for (const [name, args, field, path] of [
    ['pipe_status', { id: r.id, selection: true }, 'status', `/v1/requests/${r.id}/status`],
    ['pipe_card', { id: r.id }, 'card', `/v1/cards/${r.id}`],
  ] as const) {
    const out = f.data(name, args); assert.equal(out[field].id, r.id); assert.equal(out[field].state, 'completed');
    assert.equal(JSON.stringify(out).includes(secret), false); assert.equal(Object.hasOwn(out, 'request'), false);
    assert.doesNotMatch(JSON.stringify(out), /"(?:prompt|result|fingerprint|startSource|device|inode|cwd|path|repository|grant)":/);
    assert.equal(new URL(JSON.parse(readFileSync(f.capture, 'utf8')).url).pathname, path);
  }
  for (const [name, extra] of [['pipe_status', {}], ['pipe_status', { selection: false }], ['pipe_wait', { timeoutSeconds: 0 }]] as const) {
    const out = f.data(name, { id: r.id, includePrompt: true, ...extra }); assert.equal(out.request.prompt, secret); assert.equal(out.request.result, secret);
    assert.equal(out.request.startSource.device, secret);
  }
  for (const selection of [null, '', 'true', 1, {}, []]) {
    assert.equal(f.call('pipe_status', { id: r.id, selection }).isError, true); assert.throws(() => readFileSync(f.capture), /ENOENT/);
  }
  for (const name of ['pipe_card', 'pipe_status']) {
    assert.equal(f.call(name, { id: '' }).isError, true);
    assert.equal(f.call(name, { id: 'unknown-id', selection: true }).isError, true);
  }
});

test('M5 cards expose recorded start and proven save only; unknown proofs stay null without reading result content', t => {
  const f = fixture(t);
  for (const state of ['queued', 'running', 'pending', 'saved', 'no_changes', 'not_saved', 'unknown', 'legacy']) {
    const r = f.store.submit(request({ mutating: true, cwd: f.root }));
    const workspace = { path: '/' + secret, branch: 'pipe/fixture', commit: hash, ...(state !== 'legacy' ? { startCommit: hash } : {}) };
    let open: string | undefined;
    if (state !== 'queued') {
      const a = f.store.startAttempt(r.id, account, evidence()); assert.ok(a.ok); f.store.noteWorkspace(a.attempt.id, workspace);
      if (state !== 'running') {
        f.store.noteClosed(a.attempt.id); f.store.finishAttempt(a.attempt.id, { kind: 'completed', result: secret, workspace });
        if (state === 'saved' || state === 'no_changes') f.store.recordWorkspaceCommit(r.id, state === 'saved' ? savedHash : hash, state === 'saved');
        if (state === 'not_saved') f.store.noteWorkspaceNotSaved(r.id);
        if (state === 'unknown') {
          const db = new DatabaseSync(f.db); db.prepare("UPDATE requests SET workspace = json_set(workspace, '$.saved', 'unknown') WHERE id = ?").run(r.id); db.close();
        }
      } else open = a.attempt.id;
    }
    const c = f.data('pipe_card', { id: r.id }).card;
    assert.equal(c.state, state === 'queued' || state === 'running' ? state : 'completed');
    assert.equal(c.id, r.id); assert.equal(c.startCommit, ['queued', 'legacy'].includes(state) ? null : hash);
    assert.deepEqual(c.proof, { tests: null, review: null, backup: null });
    assert.equal(c.saved?.commit ?? null, state === 'saved' ? savedHash : null);
    if (state === 'no_changes') assert.equal(c.saved.state, 'no_changes');
    if (['pending', 'not_saved', 'unknown'].includes(state)) assert.equal(c.saved.state, state);
    assert.equal(JSON.stringify(c).includes(secret), false);
    if (open) f.store.finishAttempt(open, { kind: 'cancelled' });
  }
});

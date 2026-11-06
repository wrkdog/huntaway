import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { startHttp } from '../src/http.ts';
import { DatabaseSync } from 'node:sqlite';
import { Store, type NewRequest, type RequestRecord } from '../src/store.ts';
import { saveWorktree } from '../src/disk.ts';
import { run } from '../src/runner.ts';
import { startPipe, type PipeConfig } from '../src/service.ts';
import { AllowanceLedger } from '../src/allowance.ts';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const req = (cwd: string, extra = {}): NewRequest => ({ requester: 'synthetic', project: 'fixture', kind: 'code',
  provider: 'codex', model: 'fixture', effort: 'high', reason: 'inert saved-base test', prompt: 'unused',
  priority: 'interactive', mutating: true, cwd, ...extra });
const account = { id: 'fixture', provider: 'codex' as const, loginDir: '/unused', fingerprint: 'fixture', maxConcurrency: 1, enabled: true };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgsign=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-C', cwd, ...args],
{ encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// The fallback makes the pre-change red run exercise the actual dropping serializer.
const submit = (s: Store, r: NewRequest): Promise<RequestRecord> => Promise.resolve((s as any).submitChecked ? (s as any).submitChecked(r) : s.submit(r));
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u27-')), repo = join(root, 'repo'), trees = join(root, 'trees'), dbPath = join(root, 'store.sqlite');
  mkdirSync(repo); mkdirSync(trees); git(repo, 'init', '-b', 'catalog');
  writeFileSync(join(repo, 'file'), 'B\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'B'); const B = git(repo, 'rev-parse', 'HEAD');
  const cleanup: Array<() => Promise<void>> = [];
  const store = new Store(dbPath); t.after(async () => { for (const close of cleanup) await close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const original = store.submit(req(repo));
  const claim = store.startAttempt(original.id, account, { accountId: account.id, model: 'fixture', observedAt: new Date().toISOString(),
    verdict: { state: 'available', headroom: 1 }, grant: ['Read', 'Edit'] }); assert.ok(claim.ok);
  const branch = `pipe/${original.id}`, path = join(trees, original.id);
  git(repo, 'worktree', 'add', '-b', branch, path, B);
  const workspace = { path, branch, commit: 'uncommitted', startCommit: B };
  store.noteWorkspace(claim.attempt.id, workspace); store.noteClosed(claim.attempt.id);
  writeFileSync(join(path, 'file'), 'A\n');
  store.finishAttempt(claim.attempt.id, { kind: 'completed', result: 'synthetic', workspace });
  const saved = await saveWorktree(store.get(original.id)!, trees, undefined); assert.ok('commit' in saved);
  assert.ok(store.recordWorkspaceCommit(original.id, saved.commit, saved.saved));
  return { cleanup, root, repo, trees, dbPath, store, original, workspace, A: saved.commit, B, attemptId: claim.attempt.id };
}
async function execute(f: Awaited<ReturnType<typeof fixture>>, r: RequestRecord) {
  const abort = new AbortController(); let start: string | undefined, bytes: string | undefined;
  const events = [];
  for await (const e of run({ ...r, requestId: r.id, accountId: account.id, provider: 'codex', cwd: r.cwd!, loginDir: '/unused' } as any,
    { cli: { codex: '/not-launched-inert' }, worktreeRoot: join(f.root, 'new-trees'), signal: abort.signal,
      savedStartSource: (id: string) => (f.store as any).savedStartSource(id),
      onWorkspace: (w: { path: string }, origin: string) => { start = origin; bytes = readFileSync(join(w.path, 'file'), 'utf8'); abort.abort(); },
      onBeforeSpawn: () => assert.fail('no CLI launch authorized'), onSpawn: () => assert.fail('no CLI launch authorized'),
    } as any)) events.push(e);
  return { start, bytes, events };
}

test('SB1 selected saved A survives Store restart and native workspace creation while catalog HEAD is B', async t => {
  const f = await fixture(t), before = new DatabaseSync(f.dbPath);
  const schema = () => JSON.stringify(before.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all());
  const originalSchema = schema(), version = before.prepare('PRAGMA user_version').get(); t.after(() => before.close());
  const r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
  const reopened = new Store(f.dbPath); t.after(() => reopened.close()); const restored = reopened.get(r.id)!;
  assert.equal((restored as any).expectedStartCommit, f.A); assert.ok((restored as any).startSource?.requestId === f.original.id);
  assert.equal(schema(), originalSchema); assert.deepEqual(before.prepare('PRAGMA user_version').get(), version);
  const result = await execute({ ...f, store: reopened }, restored);
  assert.equal(result.start, f.A); assert.equal(result.bytes, 'A\n'); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.B);
  assert.equal(reopened.get(r.id)?.state, 'queued', 'inert seam proves creation only, never completion/save');
});
test('SB2 moving catalog HEAD while queued does not change selected A', async t => {
  const f = await fixture(t), r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
  writeFileSync(join(f.repo, 'file'), 'C\n'); git(f.repo, 'commit', '-am', 'C');
  assert.equal((await execute(f, r)).start, f.A);
});
test('SB26 saved start is admitted when its worktree registration is beyond 64 KiB', async t => {
  const f = await fixture(t), padding = join(f.root, 'padding', 'a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200));
  mkdirSync(padding, { recursive: true });
  for (let i = 0; i < 128; i++) git(f.repo, 'worktree', 'add', '--detach', '--no-checkout', join(padding, String(i)), f.B);
  const registry = git(f.repo, 'worktree', 'list', '--porcelain');
  const offset = registry.indexOf(`worktree ${realpathSync(f.workspace.path)}\n`);
  assert.ok(offset >= 0, 'saved worktree is registered');
  assert.ok(Buffer.byteLength(registry) > 64 * 1024, 'registry exceeds the old output cap');
  assert.ok(Buffer.byteLength(registry.slice(0, offset)) > 64 * 1024, 'saved entry follows the first 64 KiB');
  const r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
  assert.equal(r.state, 'queued'); assert.equal(r.expectedStartCommit, f.A);
  assert.equal(r.startSource?.requestId, f.original.id);
});
test('SB3 omission retains execution-time catalog HEAD', async t => {
  const f = await fixture(t), r = f.store.submit(req(f.repo));
  writeFileSync(join(f.repo, 'file'), 'C\n'); git(f.repo, 'commit', '-am', 'C'); const C = git(f.repo, 'rev-parse', 'HEAD');
  assert.equal((await execute(f, r)).start, C); assert.equal(Object.hasOwn(r, 'expectedStartCommit'), false);
});
test('SB4 malformed hashes, symbolic/tag/blob objects, missing hashes and nonchanging selectors refuse admission', async t => {
  const f = await fixture(t); git(f.repo, 'tag', '-a', 'tag', '-m', 'tag', f.A);
  for (const expectedStartCommit of [null, '', true, {}, f.A.slice(0, 12), f.A.toUpperCase(), 'HEAD', 'tag',
    git(f.repo, 'rev-parse', 'tag'), git(f.repo, 'rev-parse', `${f.A}:file`), 'a'.repeat(40)]) {
    await assert.rejects(submit(f.store, req(f.repo, { expectedStartCommit })), /expectedStartCommit|saved|source|commit/i);
  }
  await assert.rejects(submit(f.store, req(f.repo, { expectedStartCommit: f.A, mutating: false })), /changing|mutating/i);
});
test('SB5 a matching pipe branch prefix without a saved receipt grants nothing', async t => {
  const f = await fixture(t); git(f.repo, 'branch', 'pipe/impostor', f.B);
  await assert.rejects(submit(f.store, req(f.repo, { expectedStartCommit: f.B })), /saved|source/i);
});
for (const fault of ['foreign', 'unsaved', 'wrong-branch', 'wrong-job', 'missing-object', 'moved-head', 'pruned', 'dirty', 'partial', 'alternates']) {
  test(`SB6 admission refuses ${fault}`, async t => {
    const f = await fixture(t); let cwd = f.repo;
    if (fault === 'foreign') { cwd = join(f.root, 'foreign'); git(f.root, 'clone', '--no-hardlinks', f.repo, cwd); }
    if (fault === 'unsaved') {
      const db = new DatabaseSync(f.dbPath); db.prepare("UPDATE requests SET workspace=json_set(workspace,'$.saved','not_saved') WHERE id=?").run(f.original.id); db.close();
    }
    if (fault === 'wrong-branch') git(f.workspace.path, 'checkout', '-b', 'pipe/impostor');
    if (fault === 'wrong-job') {
      const db = new DatabaseSync(f.dbPath); db.prepare("UPDATE attempts SET outcome=json_set(outcome,'$.workspace.path','/wrong') WHERE id=?").run(f.attemptId); db.close();
    }
    if (fault === 'missing-object') rmSync(join(f.repo, '.git', 'objects', f.A.slice(0, 2), f.A.slice(2)));
    if (fault === 'moved-head') git(f.workspace.path, 'reset', '--hard', f.B);
    if (fault === 'pruned') git(f.repo, 'worktree', 'remove', f.workspace.path);
    if (fault === 'partial') git(f.repo, 'config', 'remote.fixture.promisor', 'true');
    if (fault === 'alternates') writeFileSync(join(f.repo, '.git', 'objects', 'info', 'alternates'), '');
    if (fault === 'dirty') writeFileSync(join(f.workspace.path, 'file'), 'unsaved\n');
    await assert.rejects(submit(f.store, req(cwd, { expectedStartCommit: f.A })), /saved|source|commit/i);
    assert.equal(existsSync(join(f.root, 'new-trees')), false);
  });
}
for (const fault of ['moved-head', 'missing-object', 'pruned', 'repository-replaced', 'receipt-changed']) {
  test(`SB7 queued ${fault} refuses before workspace or CLI effects`, async t => {
    const f = await fixture(t), r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
    if (fault === 'moved-head') git(f.workspace.path, 'reset', '--hard', f.B);
    if (fault === 'missing-object') rmSync(join(f.repo, '.git', 'objects', f.A.slice(0, 2), f.A.slice(2)));
    if (fault === 'pruned') git(f.repo, 'worktree', 'remove', f.workspace.path);
    if (fault === 'repository-replaced') { renameSync(join(f.repo, '.git'), join(f.repo, '.old-git')); git(f.repo, 'init'); }
    if (fault === 'receipt-changed') f.store.recordWorkspaceCommit(f.original.id, f.B, true);
    const result = await execute(f, r); assert.equal(result.start, undefined);
    assert.equal(existsSync(join(f.root, 'new-trees')), false);
    assert.ok(result.events.some(e => e.type === 'failed' && e.errorKind === 'other' && /saved|source|commit/i.test(e.message)));
  });
}


test('SB8 HTTP validates the selector using the real Store without a listening socket', async t => {
  const f = await fixture(t); let handler: any;
  const server = Object.assign(new EventEmitter(), { listen(_p: number, _h: string, cb: () => void) { cb(); }, address() { return { port: 1 }; } });
  t.mock.method(http, 'createServer', (cb: any) => { handler = cb; return server; }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', store: f.store, policy: { codex: { models: { fixture: 'default' }, efforts: ['high'] } },
    accounts: () => [], accountIds: () => [], models: () => ({}), draining: () => false, drain: async () => {}, cancel: () => {} });
  const send = (input: unknown): Promise<{ code: number; body: any }> => new Promise(resolve => {
    const inputStream = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: 'POST', url: '/v1/requests',
      headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' } });
    let code: number; handler(inputStream, { writeHead(c: number) { code = c; }, end(data: string) { resolve({ code, body: JSON.parse(data) }); } });
  });
  for (const expectedStartCommit of ['HEAD', f.B, null, 'a'.repeat(40)]) assert.equal((await send(req(f.repo, { expectedStartCommit }))).code, 400);
  const response = await send(req(f.repo, { expectedStartCommit: f.A })); assert.equal(response.code, 201);
  const r = f.store.get(response.body.request.id)!; assert.equal((r as any).expectedStartCommit, f.A);
  assert.equal((await execute(f, r)).start, f.A);
  assert.equal((await send(req(f.repo))).code, 201);
});

function client(f: Awaited<ReturnType<typeof fixture>>, file: string, input: string, args: string[] = []) {
  const capture = join(f.root, 'transport.json'); rmSync(capture, { force: true });
  const preload = `import {writeFileSync} from 'node:fs'; globalThis.fetch = async (url, init) => {
    writeFileSync(${JSON.stringify(capture)}, init.body); return new Response(JSON.stringify({request:{id:'inert'}})); };`;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, file, ...args],
    { input, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: f.root,
      PIPE_URL: 'http://127.0.0.1:1', PIPE_TOKEN: 'fixture-token' } });
  return { ...result, sent: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : undefined };
}
for (const tool of ['cli', 'mcp']) test(`SB9 ${tool} threads optional selector into real durable admission`, async t => {
  const f = await fixture(t);
  const input = req(f.repo, { expectedStartCommit: f.A });
  const payload = tool === 'cli' ? JSON.stringify(input) : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pipe_submit', arguments: input } }) + '\n';
  const result = client(f, `src/${tool}.ts`, payload, tool === 'cli' ? ['submit'] : []);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.sent.expectedStartCommit, f.A);
  const stored = await submit(f.store, result.sent); assert.equal((stored as any).expectedStartCommit, f.A);
  assert.equal((await execute(f, stored)).start, f.A);
});
test('SB10 MCP advertises the optional exact-commit contract', async t => {
  const f = await fixture(t), result = client(f, 'src/mcp.ts', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const schema = JSON.parse(result.stdout).result.tools.find((tool: any) => tool.name === 'pipe_submit').inputSchema;
  assert.equal(schema.properties.expectedStartCommit.type, 'string'); assert.equal(schema.required.includes('expectedStartCommit'), false);
  assert.equal(new RegExp(schema.properties.expectedStartCommit.pattern).test('HEAD'), false);
});
test('SB11 input mutation and client-supplied proof cannot replace admission ownership', async t => {
  const f = await fixture(t), input = req(f.repo, { expectedStartCommit: f.A });
  const pending = submit(f.store, input); (input as any).expectedStartCommit = f.B; input.cwd = '/missing';
  const r = await pending; assert.equal((r as any).expectedStartCommit, f.A); assert.equal(r.cwd, f.repo);
  await assert.rejects(submit(f.store, req(f.repo, { expectedStartCommit: f.A, startSource: (r as any).startSource })), /internal|source/i);
});
test('SB12 missing persisted binding and bare runner selectors fail closed', async t => {
  const f = await fixture(t), r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
  const bare = { ...r }; delete (bare as any).startSource;
  assert.equal((await execute(f, bare)).start, undefined); assert.equal(existsSync(join(f.root, 'new-trees')), false);
  const db = new DatabaseSync(f.dbPath); db.prepare("UPDATE requests SET body=json_remove(body,'$.startSource') WHERE id=?").run(r.id); db.close();
  assert.equal(f.store.get(r.id), undefined);
  const check = new DatabaseSync(f.dbPath);
  assert.equal(check.prepare('SELECT state FROM requests WHERE id=?').get(r.id)!.state, 'failed'); check.close();
});
test('SB13 replace refs cannot change the bytes of the selected commit', async t => {
  const f = await fixture(t), r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
  git(f.repo, 'replace', f.A, f.B);
  const result = await execute(f, r);
  assert.ok(result.start === undefined || result.start === f.A && result.bytes === 'A\n');
});

test('SB14 an orphaned internal binding cannot degrade to the omitted-field path', async t => {
  const f = await fixture(t), r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
  const bare = { ...r }; delete (bare as any).expectedStartCommit;
  assert.equal((await execute(f, bare)).start, undefined);
  const db = new DatabaseSync(f.dbPath); db.prepare("UPDATE requests SET body=json_remove(body,'$.expectedStartCommit') WHERE id=?").run(r.id); db.close();
  assert.equal(f.store.get(r.id), undefined);
});

test('SB15 the internal proof counts toward the existing stored-body limit', async t => {
  const f = await fixture(t), input = req(f.repo, { expectedStartCommit: f.A });
  input.prompt += 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(input)) - 10);
  await assert.rejects(submit(f.store, input), /1 MiB|limit/);
});

// V19's shared core.worktree adversary, using only generated external repositories.
function redirect(f: Awaited<ReturnType<typeof fixture>>, dirty = true, same = false) {
  const target = join(f.root, 'redirect');
  if (same) symlinkSync(f.workspace.path, target);
  else { mkdirSync(target); writeFileSync(join(target, 'file'), 'A\n'); }
  if (dirty) writeFileSync(join(f.workspace.path, 'file'), 'unsaved\n');
  git(f.repo, 'config', 'core.repositoryformatversion', '1');
  git(f.repo, 'config', 'extensions.worktreeConfig', 'true');
  git(f.repo, 'config', 'core.worktree', target);
  assert.equal(git(f.workspace.path, 'status', '--porcelain'), '', 'attack supplies a different clean checkout');
  return target;
}
for (const phase of ['admission', 'execution']) for (const dirty of [false, true]) {
  test(`SB16 ${phase} refuses wrong effective realpath with ${dirty ? 'dirty' : 'clean'} recorded source before status`, async t => {
    const f = await fixture(t), r = phase === 'execution' ? await submit(f.store, req(f.repo, { expectedStartCommit: f.A })) : undefined;
    redirect(f, dirty);
    const spawn = childProcess.spawn; let statuses = 0;
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
      if ((args[1] as string[]).includes('status')) statuses++;
      return spawn(...args);
    }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    if (r) { const result = await execute(f, r); assert.equal(result.start, undefined); assert.ok(result.events.some(e => e.type === 'failed')); }
    else await assert.rejects(submit(f.store, req(f.repo, { expectedStartCommit: f.A })), /saved|source/i);
    assert.equal(statuses, 0, 'refuse redirection before reading contents through status');
    assert.equal(readFileSync(join(f.workspace.path, 'file'), 'utf8'), dirty ? 'unsaved\n' : 'A\n');
    assert.equal(existsSync(join(f.root, 'new-trees')), false);
  });
}
test('SB17 canonical effective source accepts a symlink alias to the same clean worktree', async t => {
  const f = await fixture(t); redirect(f, false, true);
  assert.equal(realpathSync(git(f.workspace.path, 'rev-parse', '--show-toplevel')), realpathSync(f.workspace.path));
  const r = await submit(f.store, req(f.repo, { expectedStartCommit: f.A }));
  // Shared core.worktree also affects newly made trees; remove it before testing normal creation.
  git(f.repo, 'config', '--unset', 'core.worktree');
  assert.equal((await execute(f, r)).start, f.A);
});

async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < end, 'bounded synthetic service wait'); await sleep(20); }
}
async function serviceFixture(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, extra: Partial<PipeConfig> = {}, ids = [account.id]) {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/u4/codex-app-server.signed-in.json', import.meta.url), 'utf8').replaceAll('gpt-6-sol', 'gpt-6.1-sol'));
  const limits = rows.find((r: any) => r.method === 'account/rateLimits/read').response.result;
  for (const v of [limits.rateLimits, ...Object.values(limits.rateLimitsByLimitId)] as any[]) {
    v.primary.usedPercent = 20; v.primary.resetsAt = Math.floor(Date.now() / 1000) + 3600;
  }
  const cli = join(f.root, 'inert-codex.cjs');
  writeFileSync(cli, `#!${process.execPath}
const rows=JSON.parse(${JSON.stringify(JSON.stringify(rows))}.replaceAll('<chatgptAccountId>',require('node:path').basename(process.env.CODEX_HOME)));
if(process.argv[2]==='--version')console.log('codex-cli 0.156.1');
else if(process.argv[2]==='login')console.error('Logged in using ChatGPT');
else if(process.argv[2]==='app-server')require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),r=rows.find(r=>r.method===m.method);if(r)console.log(JSON.stringify({...r.response,id:m.id}));});
else {require('node:fs').writeFileSync(${JSON.stringify(join(f.root, 'UNEXPECTED-CLI'))},'refused');process.exit(1);}
`); chmodSync(cli, 0o755);
  let handler: any;
  const server = Object.assign(new EventEmitter(), { listen(_p: number, _h: string, cb: () => void) { cb(); }, address() { return { port: 1 }; }, closeAllConnections() {}, close(cb: () => void) { cb(); } });
  t.mock.method(http, 'createServer', (cb: any) => { handler = cb; return server; });
  const call = (url: string, body?: unknown): Promise<any> => new Promise(resolve => {
    const input = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method: 'POST', url, headers: { authorization: 'Bearer fixture-token-local-only-0000000000000000', 'content-type': 'application/json' } });
    handler(input, { writeHead(code: number) { assert.ok(code === 200 || code === 201, `HTTP ${code}`); }, end(data: string) { resolve(JSON.parse(data)); } });
  });
  const stats = { claims: 0, scratch: 0, workspaces: [] as string[], starts: [] as string[], spawns: 0 };
  const start = Store.prototype.startAttempt, auto = Store.prototype.startAutomatic, mkdir = fs.mkdirSync, note = Store.prototype.noteWorkspace;
  t.mock.method(Store.prototype, 'startAttempt', function(this: Store, ...args: Parameters<typeof start>) { stats.claims++; return start.apply(this, args); });
  t.mock.method(Store.prototype, 'startAutomatic', function(this: Store, ...args: Parameters<typeof auto>) { stats.claims++; return auto.apply(this, args); });
  const scratch = join(f.root, 'service-scratch');
  t.mock.method(fs, 'mkdirSync', (...args: Parameters<typeof mkdir>) => { if (String(args[0]).startsWith(scratch + '/')) stats.scratch++; return mkdir(...args); });
  t.mock.method(Store.prototype, 'noteWorkspace', function(this: Store, ...args: Parameters<typeof note>) {
    stats.workspaces.push(args[1].path); stats.starts.push(args[1].startCommit!); note.apply(this, args);
    // Cancel synchronously through the real HTTP/service hook, before any native spawn.
    void call(`/v1/requests/${this.openAttempts().find(a => a.id === args[0])!.requestId}/cancel`);
  });
  t.mock.method(Store.prototype, 'noteMayStart', () => { stats.spawns++; throw new Error('no native CLI authorized'); });
  syncBuiltinESMExports();
  for (const id of ids) mkdirSync(join(f.root, id));
  const pipe = await startPipe({ accounts: ids.map(id => ({ ...account, id, loginDir: join(f.root, id), fingerprint: createHash('sha256').update(id).digest('hex').slice(0, 8) })),
    policy: { codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['high'] }, claude: { models: { opus: 'default' }, efforts: ['high'] } },
    storePath: f.dbPath, worktreeRoot: join(f.root, 'new-trees'), tmpRoot: scratch, cli: { codex: cli },
    env: { PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root }, token: 'fixture-token-local-only-0000000000000000',
    reachable: async () => true, tickMs: 20, minFreeGb: 0, worktreeKeepHours: 1000000, ...extra });
  f.cleanup.push(async () => { await pipe.stop(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { ...pipe, stats, call };
}
const automatic = { fallback: { provider: 'claude', model: 'opus', effort: 'high', reason: 'inert fallback' }, reviewReserve: .1 };
test('SB25 recovered automatic job omitting selector retains terminal pause refusal, matching HTTP and 5ba067f1', async t => {
  const f = await fixture(t); let paused = true, writes = 0;
  const save = Store.prototype.saveLimits;
  f.store.saveLimits(account.id, [{ bucket: null, model: null, resetsAt: new Date(Date.now() - 1000).toISOString(), observedAt: new Date(Date.now() - 2000).toISOString() }]);
  t.mock.method(Store.prototype, 'saveLimits', function(this: Store, ...args: Parameters<typeof save>) {
    if (paused) { writes++; throw new Error('synthetic pending hold write'); } return save.apply(this, args);
  });
  const input = req(f.repo, { model: 'gpt-6.1-sol', automatic, placement: 'ordinary_headroom' });
  const r = await submit(f.store, input); // Durable queued intent exists before the service reopens its store.
  const p = await serviceFixture(t, f);
  try {
    await sleep(160); assert.ok(writes > 1, 'resolved probe produced a pending, retried hold write');
    const http = await p.call('/v1/requests', input);
    assert.equal(http.request.state, 'failed'); assert.equal(f.store.get(http.request.id)?.error?.kind, 'admission_unknown');
    assert.equal(f.store.get(r.id)?.state, 'failed');
    assert.equal(f.store.get(r.id)?.error?.kind, 'admission_unknown');
    assert.deepEqual(f.store.attempts(r.id), []); assert.equal(p.stats.scratch, 0); assert.equal(p.stats.spawns, 0);
  } finally { paused = false; }
});
for (const auto of [false, true]) for (const fault of ['moved-head', 'pruned', 'dirty', 'receipt-changed', 'redirected']) {
  test(`SB18 real service ${auto ? 'automatic' : 'ordinary'} queued ${fault} consumes no attempt or scratch`, async t => {
    const f = await fixture(t), p = await serviceFixture(t, f);
    const selected = await submit(f.store, req(f.repo, { model: 'gpt-6.1-sol', expectedStartCommit: f.A, ...(auto ? { automatic, placement: 'ordinary_headroom' } : {}) }));
    // Submission returns before the next tick; the fault is synchronous and precedes claim.
    if (fault === 'moved-head') git(f.workspace.path, 'reset', '--hard', f.B);
    if (fault === 'pruned') git(f.repo, 'worktree', 'remove', f.workspace.path);
    if (fault === 'dirty') writeFileSync(join(f.workspace.path, 'file'), 'unsaved\n');
    if (fault === 'receipt-changed') f.store.recordWorkspaceCommit(f.original.id, f.B, true);
    if (fault === 'redirected') redirect(f);
    await until(() => ['failed', 'cancelled'].includes(f.store.get(selected.id)!.state));
    assert.equal(f.store.attempts(selected.id).length, 0); assert.equal(f.store.get(selected.id)?.state, 'failed');
    assert.equal(p.stats.claims, 0); assert.equal(p.stats.scratch, 0); assert.equal(p.stats.workspaces.length, 0); assert.equal(p.stats.spawns, 0);
    assert.equal(f.store.runningCount(account.id), 0); assert.equal(f.store.get(selected.id)?.workspace, null);
    assert.equal(existsSync(join(f.root, 'new-trees')), false); assert.equal(existsSync(join(f.root, 'UNEXPECTED-CLI')), false);
  });
}
for (const selector of [false, true]) test(`SB19 real service ${selector ? 'selected saved A' : 'omitted catalog B'} reaches native workspace once`, async t => {
  const f = await fixture(t), p = await serviceFixture(t, f);
  const r = await submit(f.store, req(f.repo, { model: 'gpt-6.1-sol', ...(selector ? { expectedStartCommit: f.A } : {}) }));
  await until(() => !!f.store.attempts(r.id).at(-1)?.endedAt);
  assert.equal(f.store.attempts(r.id).length, 1); assert.equal(p.stats.claims, 1); assert.equal(p.stats.scratch, 1);
  assert.deepEqual(p.stats.starts, [selector ? f.A : f.B]); assert.equal(p.stats.spawns, 0);
  assert.equal(f.store.get(r.id)?.state, 'cancelled'); assert.equal(existsSync(join(f.root, 'UNEXPECTED-CLI')), false);
});
test('SB20 a source changed after service prevalidation closes the one legitimate attempt without retry', async t => {
  const f = await fixture(t), p = await serviceFixture(t, f);
  const start = Store.prototype.startAttempt;
  t.mock.method(Store.prototype, 'startAttempt', function(this: Store, ...args: Parameters<typeof start>) {
    const out = start.apply(this, args); if (out.ok) writeFileSync(join(f.workspace.path, 'file'), 'raced\n'); return out;
  });
  const r = await submit(f.store, req(f.repo, { model: 'gpt-6.1-sol', expectedStartCommit: f.A }));
  await until(() => f.store.get(r.id)?.state === 'failed'); await sleep(100);
  const attempts = f.store.attempts(r.id); assert.equal(attempts.length, 1); assert.ok(attempts[0]?.endedAt); assert.ok(attempts[0]?.closedAt);
  assert.equal(p.stats.scratch, 1); assert.equal(p.stats.workspaces.length, 0); assert.equal(p.stats.spawns, 0);
  assert.equal(f.store.runningCount(account.id), 0); assert.equal(existsSync(join(f.root, 'new-trees')), false);
});
for (const auto of [false, true]) for (const action of ['cancel', 'stop', 'drain']) test(`SB21 ${action} during ${auto ? 'automatic' : 'ordinary'} service saved-source validation cannot claim`, async t => {
  const f = await fixture(t), p = await serviceFixture(t, f);
  const r = await submit(f.store, req(f.repo, { model: 'gpt-6.1-sol', expectedStartCommit: f.A, ...(auto ? { automatic, placement: 'ordinary_headroom' } : {}) }));
  const source = Store.prototype.savedStartSource; let triggered = false, reads = 0, settled: Promise<unknown> | undefined;
  t.mock.method(Store.prototype, 'savedStartSource', function(this: Store, id: string) {
    const out = source.call(this, id); reads++;
    if (!triggered) {
      triggered = true;
      settled = action === 'stop' ? p.stop() : p.call(action === 'cancel' ? `/v1/requests/${r.id}/cancel` : '/v1/drain');
    }
    return out;
  });
  await until(() => triggered); await settled; assert.equal(p.stats.claims, 0);
  if (action !== 'stop') await until(() => reads >= 2);
  if (action === 'drain') { await sleep(100); assert.equal(reads, 2, 'drain starts no further validation'); }
  assert.equal(p.stats.claims, 0); assert.equal(p.stats.scratch, 0); assert.equal(f.store.attempts(r.id).length, 0);
  assert.equal(f.store.get(r.id)?.state, action === 'cancel' ? 'cancelled' : 'queued');
  assert.equal(p.stats.workspaces.length, 0); assert.equal(p.stats.spawns, 0);
});

test('SB22 automatic HTTP response retains one ID after source changes between submission and claim', async t => {
  const f = await fixture(t), p = await serviceFixture(t, f), checked = Store.prototype.submitChecked;
  t.mock.method(Store.prototype, 'submitChecked', async function(this: Store, ...args: Parameters<typeof checked>) {
    const r = await checked.apply(this, args); writeFileSync(join(f.workspace.path, 'file'), 'queued change\n'); return r;
  });
  const result = await p.call('/v1/requests', req(f.repo, { model: 'gpt-6.1-sol', expectedStartCommit: f.A, automatic, placement: 'ordinary_headroom' }));
  assert.equal(result.request.state, 'failed'); assert.equal(f.store.get(result.request.id)?.state, 'failed');
  assert.equal(f.store.attempts(result.request.id).length, 0); assert.equal(p.stats.claims, 0); assert.equal(p.stats.scratch, 0);
});

// Change evidence only once Git has started the awaited service validator. All claims remain real.
for (const mode of ['credits', 'ranking', 'credit-only', 'pin', 'exclude', 'held', 'unknown', 'busy']) {
  test(`SB23 service replans current ${mode} evidence after saved validation`, async t => {
    const f = await fixture(t), p = await serviceFixture(t, f, {}, ['A', 'B']);
    let changed = false, validations = 0, receipts = 0;
    const view = AllowanceLedger.prototype.view;
    t.mock.method(AllowanceLedger.prototype, 'view', function(this: AllowanceLedger, ...args: Parameters<typeof view>) {
      const v = view.apply(this, args); assert.equal(v.state, 'ok', 'synthetic probe established actual room');
      const id = args[0];
      if (changed && mode === 'unknown') return { state: 'unknown', accountId: id, reason: 'synthetic missing reading' };
      return { state: 'ok', accountId: id, binding: 'synthetic', headroom: id === 'A' ? changed ? .1 : .9 : .5,
        ...(changed && (mode === 'credit-only' || mode !== 'ranking' && id === 'A') ? { via: 'credits' as const } : {}) };
    });
    const r = await submit(f.store, req(f.repo, { model: 'gpt-6.1-sol', expectedStartCommit: f.A,
      ...(['ranking', 'credit-only'].includes(mode) ? { placement: 'ordinary_headroom' } : {}),
      ...(mode === 'pin' ? { pin: 'A' } : {}), ...(mode === 'exclude' ? { exclude: ['B'] } : {}) }));
    const spawn = childProcess.spawn, hold = Store.prototype.authHoldUntil, running = Store.prototype.runningCount, source = Store.prototype.savedStartSource;
    t.mock.method(Store.prototype, 'savedStartSource', function(this: Store, id: string) { receipts++; return source.call(this, id); });
    t.mock.method(Store.prototype, 'authHoldUntil', function(this: Store, id: string) { return changed && mode === 'held' ? Date.now() + 60000 : hold.call(this, id); });
    t.mock.method(Store.prototype, 'runningCount', function(this: Store, id: string) { return changed && mode === 'busy' ? 1 : running.call(this, id); });
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      if (!changed && args[0] === 'git') { validations++; queueMicrotask(() => { changed = true; }); }
      return child;
    }); syncBuiltinESMExports();
    await until(() => changed);
    const waits = ['credit-only', 'held', 'unknown', 'busy'].includes(mode);
    if (waits) {
      await until(() => receipts >= 2); await sleep(120);
      assert.equal(f.store.attempts(r.id).length, 0); assert.equal(p.stats.claims, 0, 'no current route must not even attempt a claim');
      assert.equal(f.store.get(r.id)?.state, 'queued'); assert.equal(p.stats.scratch, 0);
    } else {
      await until(() => !!f.store.attempts(r.id).at(-1)?.endedAt);
      const attempts = f.store.attempts(r.id); assert.equal(attempts.length, 1); assert.equal(p.stats.claims, 1);
      assert.equal(attempts[0]?.accountId, ['pin', 'exclude'].includes(mode) ? 'A' : 'B');
      assert.equal(attempts[0]?.requestId, r.id); assert.equal(f.store.get(r.id)?.startSource?.requestId, f.original.id);
      assert.equal(f.store.get(r.id)?.expectedStartCommit, f.A); assert.deepEqual(p.stats.starts, [f.A]);
    }
    assert.equal(validations, 1); assert.equal(p.stats.spawns, 0);
    assert.equal(f.store.list().length, 2, 'only original saved source and one accepted request');
  });
}

for (const pause of ['disk', 'clock', 'holds', 'drain']) test(`SB24 automatic selector ${pause} pause does not repeatedly validate`, async t => {
  const f = await fixture(t); let paused = true, writes = 0;
  const clock = Store.prototype.clockIsCurrent, save = Store.prototype.saveLimits;
  if (pause === 'holds') {
    // Persist a real hold first; the resolved synthetic CLI probe reaches saveHolds and its failed write.
    f.store.saveLimits(account.id, [{ bucket: null, model: null, resetsAt: new Date(Date.now() - 1000).toISOString(), observedAt: new Date(Date.now() - 2000).toISOString() }]);
    t.mock.method(Store.prototype, 'saveLimits', function(this: Store, ...args: Parameters<typeof save>) {
      if (paused) { writes++; throw new Error('synthetic pending hold write'); } return save.apply(this, args);
    });
  }
  const p = await serviceFixture(t, f, pause === 'disk' ? { minFreeGb: 1, diskFree: () => paused ? 0 : 10e9 } : {});
  if (pause === 'clock') t.mock.method(Store.prototype, 'clockIsCurrent', function(this: Store, ...args: Parameters<typeof clock>) { return !paused && clock.apply(this, args); });
  const r = await submit(f.store, req(f.repo, { model: 'gpt-6.1-sol', expectedStartCommit: f.A, automatic, placement: 'ordinary_headroom' }));
  if (pause === 'drain') await p.call('/v1/drain');
  let reads = 0, gitCalls = 0; const source = Store.prototype.savedStartSource, spawn = childProcess.spawn;
  t.mock.method(Store.prototype, 'savedStartSource', function(this: Store, id: string) { reads++; return source.call(this, id); });
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => { if (args[0] === 'git') gitCalls++; return spawn(...args); }); syncBuiltinESMExports();
  try {
    await sleep(220);
    assert.equal(reads, 0, 'paused ticks never enter saved-source validation'); assert.equal(gitCalls, 0);
    assert.equal(p.stats.claims, 0); assert.equal(f.store.get(r.id)?.state, 'queued'); assert.equal(f.store.attempts(r.id).length, 0);
    if (pause === 'holds') assert.ok(writes > 2, 'pause has a retried pending write from a resolved probe');
  } finally { paused = false; }
  if (pause !== 'drain') {
    await until(() => !!f.store.attempts(r.id).at(-1)?.endedAt);
    assert.equal(p.stats.claims, 1); assert.equal(f.store.attempts(r.id).length, 1); assert.deepEqual(p.stats.starts, [f.A]);
    assert.equal(reads, 4, 'one service validation and one final runner validation, each with two receipt reads');
  }
  assert.equal(p.stats.spawns, 0);
});

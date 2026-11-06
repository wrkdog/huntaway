/** Round-2 independent acceptance: helpers copied locally from the frozen round-1 file.
 * Temporary repositories/stores and inert CLIs only; real Git, Store, HTTP handlers and service.
 * No model, network, install or live Pipe state.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { Store, type AttemptOutcome, type NewRequest, type RequestRecord, type Workspace } from '../src/store.ts';
import { run, type RunSpec } from '../src/runner.ts';
import { startHttp } from '../src/http.ts';
import { startPipe } from '../src/service.ts';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { saveWorktree } from '../src/disk.ts';

// Same explicit pin and inert fixture contract as round 1.
type Pin = { pinnedStartCommit?: string; requireCleanStart?: boolean };
const input = (cwd: string, extra = {}): NewRequest & Pin => ({ requester: 'fixture', project: 'pipe183', kind: 'code',
  provider: 'codex', model: 'fixture', effort: 'high', reason: 'inert acceptance fixture; no model call',
  prompt: 'synthetic build', mutating: true, priority: 'interactive', cwd, ...extra });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=fixture',
  '-c', 'user.email=fixture@localhost', '-C', cwd, ...args], { encoding: 'utf8', timeout: 10000,
  env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe183-r2-'))), repo = join(root, 'repo');
  const trees = join(root, 'trees'), login = join(root, 'login'), db = join(root, 'store.sqlite');
  mkdirSync(repo); mkdirSync(login); mkdirSync(trees);
  git(repo, 'init', '-b', 'catalog');
  const commit = (bytes: string) => {
    writeFileSync(join(repo, 'file'), bytes); git(repo, 'add', 'file'); git(repo, 'commit', '-m', bytes.trim());
    return git(repo, 'rev-parse', 'HEAD');
  };
  const A = commit('A\n'), store = new Store(db);
  const marker = join(root, 'worker.json'), cli = join(root, 'inert-cli.cjs');
  const stream = readFileSync(new URL('./fixtures/codex-success.jsonl', import.meta.url), 'utf8');
  // Same subprocess/replayed-stream technique as u3-runners.lead.test.ts. No Git/model in the worker.
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, cwd: process.cwd(),
  bytes: fs.readFileSync('file', 'utf8'), untracked: fs.existsSync('untracked.txt')}));
fs.readFileSync(0, 'utf8');
fs.writeFileSync('built.txt', 'inert build\\n');
process.stdout.write(${JSON.stringify(stream)});
`); chmodSync(cli, 0o755);
  const account = { id: 'fixture', provider: 'codex' as const, loginDir: login,
    fingerprint: 'synthetic', maxConcurrency: 1, enabled: true };
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, repo, trees, db, store, A, commit, marker, cli, account, env };
}
type Fixture = ReturnType<typeof fixture>;

async function httpFixture(t: TestContext, f: Fixture) {
  let handler: any;
  const server = Object.assign(new EventEmitter(), {
    listen(_p: number, _h: string, cb: () => void) { cb(); }, address() { return { port: 1 }; },
  });
  t.mock.method(http, 'createServer', (cb: any) => { handler = cb; return server; });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await startHttp({ token: 'fixture-token', store: f.store, env: f.env,
    policy: { codex: { models: { fixture: 'default' }, efforts: ['high'] } },
    accounts: () => [], accountIds: () => ['fixture'], models: () => ({}),
    draining: () => false, drain: async () => {}, cancel: () => {} });
  return (method: string, url: string, body?: unknown): Promise<{ code: number; body: any }> => new Promise(resolve => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, url, headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    });
    let code: number;
    handler(req, { writeHead(c: number) { code = c; }, end(data: string) { resolve({ code, body: JSON.parse(data) }); } });
  });
}

async function execute(f: Fixture, r: RequestRecord, pin: Pin = {}) {
  const claim = f.store.startAttempt(r.id, f.account, { accountId: f.account.id, model: 'fixture',
    observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 1 }, grant: ['Read', 'Edit'] });
  assert.ok(claim.ok);
  let workspace: Workspace | undefined, beforeSpawn = 0, spawns = 0, head: string | undefined;
  const events = [];
  const spec: RunSpec & Pin = { ...r, ...pin, requestId: r.id, accountId: f.account.id,
    provider: 'codex', cwd: f.repo, loginDir: f.account.loginDir,
    ...(r.workspace ? { workspaceKey: claim.attempt.id } : {}) };
  for await (const event of run(spec, { cli: { codex: f.cli }, env: f.env, worktreeRoot: f.trees,
    signal: AbortSignal.timeout(15000), killGraceMs: 20, gitTimeoutMs: 5000,
    savedStartSource: id => f.store.savedStartSource(id),
    onWorkspace: (w, startCommit) => {
      workspace = { ...w, startCommit, commit: 'uncommitted' };
      head = git(w.path, 'rev-parse', 'HEAD'); f.store.noteWorkspace(claim.attempt.id, workspace);
    },
    onBeforeSpawn: () => { beforeSpawn++; f.store.noteMayStart(claim.attempt.id); },
    onSpawn: runner => { spawns++; f.store.noteRunner(claim.attempt.id, runner); },
    onClosed: () => f.store.noteClosed(claim.attempt.id),
  })) events.push(event);
  const terminal = events.filter(e => e.type === 'completed' || e.type === 'failed');
  assert.equal(terminal.length, 1, 'one runner terminal event');
  const last = terminal[0]!;
  // Mirror the existing service event-to-outcome boundary, without fabricating refusal evidence.
  const outcome = last.type === 'completed' ? { kind: 'completed', result: last.result, workspace }
    : { kind: 'failed', errorKind: last.errorKind, message: last.message, ...(last.workspace ? { workspace } : {}) };
  f.store.finishAttempt(claim.attempt.id, outcome as AttemptOutcome);
  return { request: f.store.get(r.id)!, workspace, head, beforeSpawn, spawns, events };
}

async function saved(f: Fixture) {
  const r = f.store.submit(input(f.repo)), done = await execute(f, r);
  assert.equal(done.request.state, 'completed');
  const result = await saveWorktree(done.request, f.trees, undefined, f.env); assert.ok('commit' in result);
  assert.ok(f.store.recordWorkspaceCommit(r.id, result.commit, result.saved));
  assert.notEqual(result.commit, f.A);
  rmSync(f.marker);
  return result.commit;
}

for (const selector of ['pinnedStartCommit', 'expectedStartCommit'] as const) {
  for (const namespace of ['tags', 'heads']) {
    test(`P183-R2-O1 ${selector}: refs/${namespace}/<SHA> cannot redirect the object`, async t => {
      const f = fixture(t), hash = selector === 'pinnedStartCommit' ? f.A : await saved(f);
      const B = f.commit('B\n');
      if (selector === 'pinnedStartCommit') git(f.repo, 'reset', '--hard', f.A);
      // Create the collision after admission, so it exercises the runner's shared branch creation.
      const r = await f.store.submitChecked(input(f.repo, { [selector]: hash }), f.env);
      git(f.repo, 'update-ref', `refs/${namespace}/${hash}`, B);
      assert.equal(git(f.repo, 'rev-parse', `refs/${namespace}/${hash}`), B);
      const done = await execute(f, r);
      if (done.request.state !== 'completed') {
        assert.ok(['failed', 'start_mismatch'].includes(done.request.state), 'refusal must be terminal');
        assert.equal(done.beforeSpawn, 0); assert.equal(done.spawns, 0);
        assert.equal(existsSync(f.marker), false);
        assert.equal(f.store.attempts(r.id)[0]!.runner, null);
        return;
      }
      assert.equal(done.spawns, 1);
      // Check worker-visible bytes first: the recorded start alone can lie about the checkout.
      assert.equal(JSON.parse(readFileSync(f.marker, 'utf8')).bytes, 'A\n', 'never build the shadow ref B');
      assert.equal(readFileSync(join(done.workspace!.path, 'file'), 'utf8'), 'A\n');
      assert.equal(done.head, hash);
      assert.equal(git(done.workspace!.path, 'rev-parse', 'HEAD'), hash);
      assert.equal(done.request.workspace?.startCommit, hash);
    });
  }
}

// Real service execution and probe/planner path; only the HTTP listener is socket-free.
async function serviceFixture(t: TestContext, f: Fixture) {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/u4/codex-app-server.signed-in.json', import.meta.url), 'utf8')
    .replaceAll('gpt-6-sol', 'gpt-6.1-sol'));
  const limits = rows.find((x: any) => x.method === 'account/rateLimits/read').response.result;
  for (const v of [limits.rateLimits, ...Object.values(limits.rateLimitsByLimitId)] as any[]) {
    for (const window of [v.primary, v.secondary]) if (window) {
      window.usedPercent = 10; window.resetsAt = Math.floor(Date.now() / 1000) + 86400;
    }
  }
  const worker = readFileSync(f.cli, 'utf8').split('\n').slice(1).join('\n');
  writeFileSync(f.cli, `#!${process.execPath}
const rows = ${JSON.stringify(rows)};
if (process.argv[2] === '--version') console.log('codex-cli 0.156.1');
else if (process.argv[2] === 'login') console.error('Logged in using ChatGPT');
else if (process.argv[2] === 'app-server') require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line), r = rows.find(r => r.method === m.method);
  if (r) console.log(JSON.stringify({...r.response, id: m.id}));
});
else { ${worker} }
`);
  let handler: any;
  const server = Object.assign(new EventEmitter(), {
    listen(_p: number, _h: string, cb: () => void) { cb(); }, address() { return { port: 1 }; },
    closeAllConnections() {}, close(cb: () => void) { cb(); },
  });
  t.mock.method(http, 'createServer', (cb: any) => { handler = cb; return server; });
  syncBuiltinESMExports();
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  const stop = async () => { await pipe?.stop(); t.mock.restoreAll(); syncBuiltinESMExports(); };
  try {
    pipe = await startPipe({ accounts: [{ ...f.account,
      fingerprint: createHash('sha256').update('<chatgptAccountId>').digest('hex').slice(0, 8) }],
      policy: { codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['high'] } },
      storePath: f.db, worktreeRoot: f.trees, tmpRoot: join(f.root, 'scratch'), workDir: f.repo,
      cli: { codex: f.cli }, env: f.env, token: 'fixture-token-local-only-0000000000000000',
      reachable: async () => true, tickMs: 25, minFreeGb: 0, saveOnCompletion: false });
  } catch (e) { await stop(); throw e; }
  const call = (method: string, url: string, body?: unknown): Promise<{ code: number; body: any }> => new Promise(resolve => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
      method, url, headers: { authorization: 'Bearer fixture-token-local-only-0000000000000000', 'content-type': 'application/json' },
    });
    let code: number;
    handler(req, { writeHead(c: number) { code = c; }, end(data: string) { resolve({ code, body: JSON.parse(data) }); } });
  });
  return { call, stop };
}

for (const matching of [false, true]) test(`P183-R2-S1 service forwards pin: ${matching ? 'matching' : 'mismatching'} source HEAD`, async t => {
  const f = fixture(t);
  if (!matching) f.commit('B\n');
  const service = await serviceFixture(t, f);
  try {
    const submitted = await service.call('POST', '/v1/requests', input(f.repo, {
      model: 'gpt-6.1-sol', pinnedStartCommit: f.A, requireCleanStart: true,
    }));
    assert.equal(submitted.code, 201);
    const id = submitted.body.request.id, deadline = Date.now() + 15000;
    let status: RequestRecord;
    do {
      const response = await service.call('GET', `/v1/requests/${id}`);
      assert.equal(response.code, 200); status = response.body.request;
      if (!['queued', 'running'].includes(status.state)) break;
      await sleep(25);
    } while (Date.now() < deadline);
    assert.equal(status.state, matching ? 'completed' : 'start_mismatch');
    assert.equal(f.store.attempts(id).length, 1);
    assert.equal(f.store.openAttempts().length, 0);
    if (matching) {
      assert.equal(status.workspace?.startCommit, f.A);
      assert.equal(git(status.workspace!.path, 'rev-parse', 'HEAD'), f.A);
      assert.equal(JSON.parse(readFileSync(f.marker, 'utf8')).bytes, 'A\n');
    } else {
      assert.equal(status.error?.kind, 'start_mismatch');
      assert.equal(status.workspace, null); assert.equal(existsSync(f.marker), false);
      assert.equal(f.store.attempts(id)[0]!.runner, null);
    }
  } finally { await service.stop(); }
});

test('P183-R2-K1 refusal retains the workspace from an unstarted recovered attempt for prune', async t => {
  const f = fixture(t), r = await f.store.submitChecked(input(f.repo, { pinnedStartCommit: f.A }), f.env);
  const first = f.store.startAttempt(r.id, f.account, { accountId: f.account.id, model: 'fixture',
    observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 1 }, grant: ['Read', 'Edit'] });
  assert.ok(first.ok);
  const path = join(f.trees, 'retained'), branch = `pipe/${r.id}`;
  git(f.repo, 'worktree', 'add', '-b', branch, path, f.A);
  const workspace: Workspace = { path, branch, startCommit: f.A, commit: 'uncommitted' };
  f.store.noteWorkspace(first.attempt.id, workspace);
  assert.equal(f.store.attempts(r.id)[0]!.runner, null);
  // A fresh Store sees the durable pre-spawn record left by the stopped service.
  const recovery = new Store(f.db);
  try {
    assert.equal(recovery.reconcile('fixture stop before CLI', 'interrupted').length, 1);
    assert.equal(recovery.get(r.id)!.state, 'queued');
    assert.deepEqual(recovery.get(r.id)!.workspace, workspace);
    assert.equal(recovery.attempts(r.id)[0]!.outcome?.kind, 'unstarted');
  } finally { recovery.close(); }
  f.commit('B\n');
  const done = await execute(f, f.store.get(r.id)!);
  assert.equal(done.request.state, 'start_mismatch');
  assert.equal(done.beforeSpawn, 0); assert.equal(done.spawns, 0);
  assert.equal(existsSync(f.marker), false); assert.equal(done.workspace, undefined);
  assert.equal(readFileSync(join(path, 'file'), 'utf8'), 'A\n');
  assert.equal(git(path, 'rev-parse', 'HEAD'), f.A);
  const reopened = new Store(f.db);
  try {
    // Check both public read paths together, so evidence includes cleanup discoverability.
    assert.deepEqual({ request: reopened.get(r.id)!.workspace,
      cleanup: reopened.finishedWorkspaces().find(x => x.id === r.id)?.workspace },
    { request: workspace, cleanup: workspace });
  } finally { reopened.close(); }
});

test('P183-R2-R1 HEAD moves at branch-exists check, before branch creation', async t => {
  const f = fixture(t), r = await f.store.submitChecked(input(f.repo, { pinnedStartCommit: f.A }), f.env);
  const B = f.commit('B\n'); git(f.repo, 'reset', '--hard', f.A);
  const spawn = childProcess.spawn; let moved = false, branchMade = false;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const argv = args[1] as string[];
    if (!moved && argv.includes('rev-parse') && argv.includes(`refs/heads/pipe/${r.id}`)) {
      assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.A);
      assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', `refs/heads/pipe/${r.id}`), '');
      git(f.repo, 'reset', '--hard', B); moved = true;
    }
    if (argv.includes('branch') && argv.includes(`pipe/${r.id}`)) {
      assert.equal(moved, true, 'source must move before branch creation, not during/after it'); branchMade = true;
    }
    return spawn(...args);
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const done = await execute(f, r);
  assert.equal(moved, true); assert.equal(branchMade, true);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), B);
  assert.equal(done.request.state, 'completed'); assert.equal(done.head, f.A);
  assert.equal(done.request.workspace?.startCommit, f.A);
  assert.equal(git(done.workspace!.path, 'rev-parse', 'HEAD'), f.A);
  assert.equal(JSON.parse(readFileSync(f.marker, 'utf8')).bytes, 'A\n');
});

test('P183-R2-D1 clean-start check leaves a stat-dirty source index byte- and time-identical', async t => {
  const f = fixture(t), r = await f.store.submitChecked(input(f.repo, { pinnedStartCommit: f.A, requireCleanStart: true }), f.env);
  const file = join(f.repo, 'file'), index = join(f.repo, '.git', 'index');
  const beforeFile = statSync(file), older = new Date(beforeFile.mtimeMs - 60000);
  utimesSync(file, older, older);
  assert.notEqual(statSync(file).mtimeMs, beforeFile.mtimeMs, 'force stat-cache dirt without changing bytes');
  assert.equal(readFileSync(file, 'utf8'), 'A\n');
  const before = { bytes: readFileSync(index), mtime: statSync(index, { bigint: true }).mtimeNs };
  const done = await execute(f, r);
  assert.equal(done.request.state, 'completed'); assert.equal(done.head, f.A);
  assert.equal(done.request.workspace?.startCommit, f.A);
  assert.deepEqual({ bytes: readFileSync(index), mtime: statSync(index, { bigint: true }).mtimeNs }, before,
    'a read-only cleanliness check must not refresh/write the source index');
  assert.equal(existsSync(`${index}.lock`), false);
});

test('P183-R2-V1 requireCleanStart true without a pin is refused at Store and HTTP admission', async t => {
  const f = fixture(t), call = await httpFixture(t, f), body = input(f.repo, { requireCleanStart: true });
  // Record both outcomes before asserting either, to exercise both actual validation paths on RED.
  let error: unknown;
  try { await f.store.submitChecked(body, f.env); } catch (e) { error = e; }
  const response = await call('POST', '/v1/requests', body);
  assert.deepEqual({ storeRefused: error instanceof Error, http: response.code }, { storeRefused: true, http: 400 });
  assert.match((error as Error).message, /requireCleanStart.*pinnedStartCommit|pinnedStartCommit.*requireCleanStart/i);
  assert.match(JSON.stringify(response.body), /requireCleanStart.*pinnedStartCommit|pinnedStartCommit.*requireCleanStart/i);
  assert.deepEqual(f.store.list(), []);
});

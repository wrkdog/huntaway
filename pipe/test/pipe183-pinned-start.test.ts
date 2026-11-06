/** Independent acceptance contract for pinned starts.
 * No live service, credentials, network or model: only temporary repositories and an inert CLI.
 * Like u27, use socket-free real HTTP handlers and real Store/runner Git operations.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { Store, type AttemptOutcome, type NewRequest, type RequestRecord, type Workspace } from '../src/store.ts';
import { run, type RunSpec } from '../src/runner.ts';
import { startHttp } from '../src/http.ts';
import { saveWorktree } from '../src/disk.ts';

// Local extension types let the contract run RED before product types grow.
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe183-'))), repo = join(root, 'repo');
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
  // The explicit override exercises the runner even while main drops pin fields in Store.
  // Admission/persistence tests separately require the fields to survive without this seam.
  const spec: RunSpec & Pin = { ...r, ...pin, requestId: r.id, accountId: f.account.id,
    provider: 'codex', cwd: f.repo, loginDir: f.account.loginDir };
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

function noBuild(f: Fixture, result: Awaited<ReturnType<typeof execute>>) {
  assert.equal(result.beforeSpawn, 0, 'refusal precedes the worker pre-spawn boundary');
  assert.equal(result.spawns, 0, 'no worker process');
  assert.equal(existsSync(f.marker), false, 'worker body never ran');
  assert.equal(result.workspace, undefined, 'no workspace creation callback');
  assert.equal(result.request.workspace, null, 'no workspace commit or invented start');
  assert.deepEqual(readdirSync(f.trees), [], 'no leftover job worktree');
  assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/pipe/'), '', 'no job branch/commit');
  assert.equal(f.store.attempts(result.request.id)[0]?.runner, null);
}

for (const length of [40, 64]) test(`P183-V1 accepts and durably retains a lowercase ${length}-hex pin through HTTP`, async t => {
  const f = fixture(t), call = await httpFixture(t, f), pin = length === 40 ? f.A : 'abcdef01'.repeat(8);
  const response = await call('POST', '/v1/requests', input(f.repo, { pinnedStartCommit: pin }));
  assert.equal(response.code, 201);
  const reopened = new Store(f.db); t.after(() => reopened.close());
  assert.equal((reopened.get(response.body.request.id) as RequestRecord & Pin).pinnedStartCommit, pin);
  assert.equal((await call('GET', `/v1/requests/${response.body.request.id}`)).body.request.pinnedStartCommit, pin);
});

for (const [label, pin] of Object.entries({ uppercase: 'A'.repeat(40), short: 'a'.repeat(39),
  '63-hex': 'a'.repeat(63), 'non-hex': 'g'.repeat(40), symbolic: 'HEAD', null: null })) {
  test(`P183-V2 rejects ${label} pins at Store and HTTP admission`, async t => {
    const f = fixture(t), call = await httpFixture(t, f), body = input(f.repo, { pinnedStartCommit: pin });
    const response = await call('POST', '/v1/requests', body);
    assert.equal(response.code, 400, 'HTTP must refuse, not silently discard the pin');
    await assert.rejects(f.store.submitChecked(body, f.env), /pinnedStartCommit|commit|hash/i);
    assert.deepEqual(f.store.list(), []);
  });
}
for (const [label, extra] of Object.entries({ readonly: { mutating: false }, 'no-cwd': { cwd: undefined } })) {
  test(`P183-V3 rejects ${label} pinned jobs`, async t => {
    const f = fixture(t), call = await httpFixture(t, f), body = input(f.repo, { pinnedStartCommit: f.A, ...extra });
    assert.equal((await call('POST', '/v1/requests', body)).code, 400);
    await assert.rejects(f.store.submitChecked(body, f.env), /changing|mutating|cwd/i);
    assert.deepEqual(f.store.list(), []);
  });
}
test('P183-V4 retains the explicit clean-start option across restart', async t => {
  const f = fixture(t), r = await f.store.submitChecked(input(f.repo, { pinnedStartCommit: f.A, requireCleanStart: true }), f.env);
  const reopened = new Store(f.db); t.after(() => reopened.close());
  assert.equal((reopened.get(r.id) as RequestRecord & Pin).requireCleanStart, true);
});
test('P183-V5 refuses a nonboolean clean-start option', async t => {
  const f = fixture(t), call = await httpFixture(t, f);
  const body = input(f.repo, { pinnedStartCommit: f.A, requireCleanStart: 'true' });
  assert.equal((await call('POST', '/v1/requests', body)).code, 400);
  await assert.rejects(f.store.submitChecked(body, f.env), /requireCleanStart|boolean|true or false/i);
});

test('P183-M1 matching HEAD builds and HTTP status retains workspace.startCommit', async t => {
  const f = fixture(t), call = await httpFixture(t, f), pin = { pinnedStartCommit: f.A, requireCleanStart: true };
  const submitted = await call('POST', '/v1/requests', input(f.repo, pin)); assert.equal(submitted.code, 201);
  const r = f.store.get(submitted.body.request.id)!, done = await execute(f, r);
  assert.equal(done.request.state, 'completed'); assert.equal(done.spawns, 1);
  assert.equal(done.head, f.A); assert.equal(done.request.workspace?.startCommit, f.A);
  assert.equal(readFileSync(join(done.workspace!.path, 'built.txt'), 'utf8'), 'inert build\n');
  const status = await call('GET', `/v1/requests/${r.id}`);
  assert.equal(status.code, 200); assert.equal(status.body.request.workspace.startCommit, f.A);
  const reopened = new Store(f.db); t.after(() => reopened.close());
  assert.equal(reopened.get(r.id)?.workspace?.startCommit, f.A);
});

test('P183-R1 mismatching HEAD refuses before any worker or workspace commit', async t => {
  const f = fixture(t), B = f.commit('B\n'), pin = { pinnedStartCommit: f.A };
  const r = await f.store.submitChecked(input(f.repo, pin), f.env), done = await execute(f, r, pin);
  noBuild(f, done);
  assert.equal(done.request.state, 'start_mismatch');
  assert.equal(done.request.error?.kind, 'start_mismatch');
  assert.ok(done.request.error?.message.includes(f.A)); assert.ok(done.request.error?.message.includes(B));
});
test('P183-R2 moving source HEAD after submission refuses the accepted original ID', async t => {
  const f = fixture(t), call = await httpFixture(t, f);
  const submitted = await call('POST', '/v1/requests', input(f.repo, { pinnedStartCommit: f.A }));
  assert.equal(submitted.code, 201); const r = f.store.get(submitted.body.request.id)!;
  const B = f.commit('B\n'), done = await execute(f, r);
  assert.equal(done.request.id, r.id); assert.equal(done.request.state, 'start_mismatch');
  noBuild(f, done);
  assert.ok(done.request.error?.message.includes(f.A)); assert.ok(done.request.error?.message.includes(B));
  assert.equal(f.store.attempts(r.id).length, 1); assert.deepEqual(f.store.list('queued'), []);
});
test('P183-R3 source moves after the HEAD check: worktree still builds the pinned object', async t => {
  const f = fixture(t), pin = { pinnedStartCommit: f.A }, r = await f.store.submitChecked(input(f.repo, pin), f.env);
  const B = f.commit('B\n'); git(f.repo, 'reset', '--hard', f.A);
  const spawn = childProcess.spawn; let moved = false;
  // Real Git still runs. Interpose exactly at branch creation, after the source HEAD read,
  // before any job branch/worktree or worker. A sleep cannot establish this race.
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const argv = args[1] as string[];
    if (!moved && argv.includes('branch') && argv.includes(`pipe/${r.id}`)) {
      assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.A);
      git(f.repo, 'reset', '--hard', B); moved = true;
    }
    return spawn(...args);
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const done = await execute(f, r, pin);
  assert.equal(moved, true, 'race seam must actually fire');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), B);
  assert.equal(done.request.state, 'completed'); assert.equal(done.head, f.A);
  assert.equal(done.request.workspace?.startCommit, f.A);
  assert.equal(git(done.workspace!.path, 'rev-parse', 'HEAD'), f.A);
  assert.equal(JSON.parse(readFileSync(f.marker, 'utf8')).bytes, 'A\n');
});

for (const dirt of ['unstaged', 'staged', 'untracked']) test(`P183-D1 clean-start refuses ${dirt} source changes`, async t => {
  const f = fixture(t), pin = { pinnedStartCommit: f.A, requireCleanStart: true };
  const r = await f.store.submitChecked(input(f.repo, pin), f.env);
  writeFileSync(join(f.repo, dirt === 'untracked' ? 'untracked.txt' : 'file'), 'dirty\n');
  if (dirt === 'staged') git(f.repo, 'add', 'file');
  const done = await execute(f, r, pin);
  assert.equal(done.request.state, 'start_mismatch'); noBuild(f, done);
  assert.match(done.request.error?.message ?? '', /dirty|clean|uncommitted/i);
  assert.ok(done.request.error?.message.includes(f.A));
});
for (const clean of [undefined, false]) test(`P183-D2 clean-start ${String(clean)} excludes source dirt from the build`, async t => {
  const f = fixture(t), pin = { pinnedStartCommit: f.A, ...(clean === undefined ? {} : { requireCleanStart: clean }) };
  const r = await f.store.submitChecked(input(f.repo, pin), f.env);
  writeFileSync(join(f.repo, 'file'), 'dirty\n'); writeFileSync(join(f.repo, 'untracked.txt'), 'untracked\n');
  const done = await execute(f, r, pin), worker = JSON.parse(readFileSync(f.marker, 'utf8'));
  assert.equal(done.request.state, 'completed'); assert.equal(done.head, f.A);
  assert.equal(done.request.workspace?.startCommit, f.A);
  assert.equal(worker.bytes, 'A\n'); assert.equal(worker.untracked, false);
  assert.equal(readFileSync(join(f.repo, 'file'), 'utf8'), 'dirty\n');
});

test('P183-S1 refused status gives reason and both SHAs durably and remains terminal', async t => {
  const f = fixture(t), call = await httpFixture(t, f), pin = { pinnedStartCommit: f.A };
  const r = await f.store.submitChecked(input(f.repo, pin), f.env), B = f.commit('B\n');
  await execute(f, r);
  const response = await call('GET', `/v1/requests/${r.id}`), status = response.body.request;
  assert.equal(response.code, 200); assert.equal(status.state, 'start_mismatch');
  assert.equal(status.error.kind, 'start_mismatch'); assert.match(status.error.message, /HEAD|start|commit|mismatch/i);
  assert.ok(status.error.message.includes(f.A)); assert.ok(status.error.message.includes(B));
  assert.equal(status.workspace, null, 'a refused job has no invented workspace start');
  const reopened = new Store(f.db); t.after(() => reopened.close());
  assert.deepEqual(reopened.get(r.id)?.error, status.error);
  assert.equal(reopened.get(r.id)?.state, 'start_mismatch');
  assert.deepEqual(reopened.list('queued'), []); assert.deepEqual(reopened.openAttempts(), []);
  assert.equal(reopened.list('start_mismatch').length, 1);
  assert.equal(reopened.cancel(r.id), false, 'terminal refusal cannot become cancelled');
});

test('P183-U1 omitted pin still chooses execution-time source HEAD', async t => {
  const f = fixture(t), r = f.store.submit(input(f.repo)), B = f.commit('B\n'), done = await execute(f, r);
  assert.equal(done.request.state, 'completed'); assert.equal(done.request.workspace?.startCommit, B);
  assert.equal(done.head, B); assert.equal(Object.hasOwn(done.request, 'pinnedStartCommit'), false);
});

async function saved(f: Fixture) {
  const r = f.store.submit(input(f.repo)), done = await execute(f, r);
  assert.equal(done.request.state, 'completed');
  const result = await saveWorktree(done.request, f.trees, undefined, f.env); assert.ok('commit' in result);
  assert.ok(f.store.recordWorkspaceCommit(r.id, result.commit, result.saved));
  assert.notEqual(result.commit, f.A, 'saved build differs from source HEAD');
  rmSync(f.marker);
  return result.commit;
}
test('P183-U2 expectedStartCommit still chains from a saved workspace despite a different source HEAD', async t => {
  const f = fixture(t), hash = await saved(f), B = f.commit('B\n');
  const r = await f.store.submitChecked(input(f.repo, { expectedStartCommit: hash }), f.env);
  const done = await execute(f, r);
  assert.equal(done.request.state, 'completed'); assert.equal(done.head, hash);
  assert.equal(done.request.workspace?.startCommit, hash); assert.equal(git(f.repo, 'rev-parse', 'HEAD'), B);
});
test('P183-V6 pin and a genuinely valid saved-source selector are mutually exclusive', async t => {
  const f = fixture(t), hash = await saved(f), call = await httpFixture(t, f);
  // A valid receipt prevents a false PASS caused merely by expectedStartCommit admission failing.
  const control = await f.store.submitChecked(input(f.repo, { expectedStartCommit: hash }), f.env);
  assert.equal(control.expectedStartCommit, hash);
  const body = input(f.repo, { expectedStartCommit: hash, pinnedStartCommit: f.A });
  assert.equal((await call('POST', '/v1/requests', body)).code, 400);
  await assert.rejects(f.store.submitChecked(body, f.env), /exclusive|combine|both|pinnedStartCommit/i);
});

/** Round-3 independent acceptance. Real Git and inert workers only; no timing sleeps. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { Store, type AttemptOutcome, type NewRequest, type RequestRecord, type Workspace } from '../src/store.ts';
import { run, type RunSpec } from '../src/runner.ts';
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe183-r3-'))), repo = join(root, 'repo');
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

async function execute(f: Fixture, r: RequestRecord, pin: Pin = {}, rejectWorkspace = false) {
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
      if (rejectWorkspace) throw new Error('inert fixture forces setup cleanup');
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

type Selector = 'pinnedStartCommit' | 'expectedStartCommit';
async function selected(t: TestContext, selector: Selector) {
  const f = fixture(t), A = selector === 'pinnedStartCommit' ? f.A : await saved(f);
  const B = f.commit('B\n'), C = f.commit('C\n');
  if (selector === 'pinnedStartCommit') git(f.repo, 'reset', '--hard', A);
  const r = await f.store.submitChecked(input(f.repo, { [selector]: A }), f.env);
  return { f, A, B, C, r, ref: `refs/heads/pipe/${r.id}` };
}

function intercept(t: TestContext, hook: (argv: string[], launch: () => ReturnType<typeof childProcess.spawn>) => ReturnType<typeof childProcess.spawn>) {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => hook(args[1] as string[], () => spawn(...args)));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function refused(f: Fixture, r: RequestRecord, done: Awaited<ReturnType<typeof execute>>) {
  assert.ok(['failed', 'start_mismatch'].includes(done.request.state), 'refusal must be terminal');
  assert.equal(done.beforeSpawn, 0); assert.equal(done.spawns, 0);
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.store.attempts(r.id)[0]!.runner, null);
}

for (const selector of ['pinnedStartCommit', 'expectedStartCommit'] as const) {
  test(`P183-R3-T1 ${selector}: A-to-B-to-A cannot record A while running B's tree`, async t => {
    const { f, A, B, r, ref } = await selected(t, selector);
    let moved = false, restored = false, checkedOut: { file: string; index: string; head: string } | undefined;
    intercept(t, (argv, launch) => {
      if (!moved && argv.includes('worktree') && argv.includes('add')) {
        assert.equal(git(f.repo, 'rev-parse', ref), A, 'runner created its branch at A');
        git(f.repo, 'update-ref', ref, B, A); moved = true;
        const child = launch();
        // Registered before runGit sees close: restoration precedes every post-checkout proof.
        child.once('close', code => {
          assert.equal(code, 0);
          const path = join(f.trees, r.id);
          checkedOut = { file: readFileSync(join(path, 'file'), 'utf8'), index: git(path, 'show', ':file'),
            head: git(path, 'rev-parse', 'HEAD') };
          git(f.repo, 'update-ref', ref, A, B); restored = true;
          assert.equal(git(f.repo, 'rev-parse', ref), A);
        });
        return child;
      }
      return launch();
    });
    const done = await execute(f, r);
    assert.equal(moved, true); assert.equal(restored, true); assert.ok(checkedOut);
    // A fixed implementation may check out the object directly, or refuse the inconsistent tree.
    if (done.request.state !== 'completed') { refused(f, r, done); return; }
    assert.equal(done.spawns, 1);
    assert.deepEqual({ worker: JSON.parse(readFileSync(f.marker, 'utf8')).bytes,
      file: readFileSync(join(done.workspace!.path, 'file'), 'utf8'),
      index: git(done.workspace!.path, 'show', ':file'),
      indexTree: git(done.workspace!.path, 'write-tree'),
      recorded: done.request.workspace?.startCommit },
    { worker: 'A\n', file: 'A\n', index: 'A', indexTree: git(f.repo, 'rev-parse', `${A}^{tree}`), recorded: A },
    `checkout at the race boundary was ${JSON.stringify(checkedOut)}; ref hashes alone do not prove the tree`);
  });

  for (const existing of [false, true]) {
    test(`P183-R3-S1 ${selector}: symbolic create race preserves ${existing ? 'existing C' : 'absent'} unrelated ref`, async t => {
      const { f, A, C, r, ref } = await selected(t, selector), unrelated = 'refs/heads/unrelated';
      if (existing) git(f.repo, 'update-ref', unrelated, C);
      let injected = false, checkedAbsent = false, unexpectedTargetCreation = false;
      intercept(t, (argv, launch) => {
        if (argv.includes('rev-parse') && argv.includes(ref) && !injected) checkedAbsent = true;
        if (!injected && (argv.includes('update-ref') || argv.includes('branch')) &&
            (argv.includes(ref) || argv.includes(`pipe/${r.id}`))) {
          assert.equal(checkedAbsent, true, 'inject after the runner existence check');
          assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', ref), '');
          git(f.repo, 'symbolic-ref', ref, unrelated); injected = true;
          const child = launch();
          child.once('close', () => {
            // Latch the write: later cleanup cannot hide an unauthorized target creation.
            if (!existing) unexpectedTargetCreation = git(f.repo, 'for-each-ref', '--format=%(refname)', unrelated) !== '';
          });
          return child;
        }
        return launch();
      });
      // If creation is safe, deliberately fail recording to exercise setup cleanup as well.
      const done = await execute(f, r, {}, true);
      assert.equal(injected, true); refused(f, r, done);
      assert.equal(unexpectedTargetCreation, false, 'create-only update must never follow a dangling symbolic ref');
      assert.equal(git(f.repo, 'for-each-ref', '--format=%(objectname)', unrelated), existing ? C : '',
        'cleanup must preserve the unrelated ref exactly');
      if (existing) {
        assert.equal(git(f.repo, 'symbolic-ref', ref), unrelated, 'the competing symbolic ref is not owned by this runner');
      }
    });
  }

  test(`P183-R3-S2 ${selector}: cleanup cannot delete a substituted symbolic ref to C`, async t => {
    const { f, C, r, ref } = await selected(t, selector), unrelated = 'refs/heads/unrelated';
    git(f.repo, 'update-ref', unrelated, C);
    let injected = false;
    intercept(t, (argv, launch) => {
      if (!injected && argv.includes('update-ref') && argv.includes('-d') && argv.includes(ref)) {
        git(f.repo, 'symbolic-ref', ref, unrelated); injected = true;
      }
      return launch();
    });
    const done = await execute(f, r, {}, true);
    assert.equal(injected, true, 'force the race at cleanup after the owned workspace is removed');
    refused(f, r, done);
    assert.equal(git(f.repo, 'rev-parse', unrelated), C, 'cleanup never deletes another owner\'s C');
    assert.equal(git(f.repo, 'symbolic-ref', ref), unrelated, 'a substituted ref remains for inspection');
  });
}

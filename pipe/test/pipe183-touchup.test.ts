/** Rule-19 scoped touch-up: independent acceptance, real Git, inert workers, no sleeps. */
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe183-touchup-'))), repo = join(root, 'repo');
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
fs.writeFileSync('file', 'built from ' + fs.readFileSync('file', 'utf8'));
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

function symbolicTarget(repo: string, ref: string): string | null {
  try { return git(repo, 'symbolic-ref', '--quiet', ref); } catch { return null; }
}

for (const selector of ['pinnedStartCommit', 'expectedStartCommit'] as const) {
  test(`P183-TU-C1 ${selector}: cleanup preserves a competing symbolic ref targeting the same A`, async t => {
    const { f, A, r, ref } = await selected(t, selector), keepme = 'refs/heads/keepme';
    git(f.repo, 'update-ref', keepme, A);
    let injected = false;
    intercept(t, (argv, launch) => {
      if (!injected && argv.includes('update-ref') && argv.includes('-d') && argv.includes(ref)) {
        assert.equal(symbolicTarget(f.repo, ref), null, 'runner branch was direct before replacement');
        assert.equal(git(f.repo, 'rev-parse', ref), A, 'replacement preserves the compared object id');
        git(f.repo, 'symbolic-ref', ref, keepme); injected = true;
      }
      return launch();
    });
    const done = await execute(f, r, {}, true);
    assert.equal(injected, true, 'replace after cleanup ownership read, before conditional deletion');
    refused(f, r, done);
    assert.deepEqual({ target: git(f.repo, 'for-each-ref', '--format=%(objectname)', keepme),
      symbolic: symbolicTarget(f.repo, ref), retained: done.request.workspace?.branch ?? null },
    { target: A, symbolic: keepme, retained: `pipe/${r.id}` },
    'same hash is not type/ownership proof: preserve both refs and report the workspace');
    const terminal = done.events.find(e => e.type === 'failed');
    assert.ok(terminal && terminal.type === 'failed' && terminal.workspace);
    assert.equal(terminal.workspace.path, join(f.trees, r.id));
  });

  test(`P183-TU-C2 ${selector}: create race never replaces or deletes a dangling symbolic ref`, async t => {
    const { f, r, ref } = await selected(t, selector), unrelated = 'refs/heads/unrelated';
    t.diagnostic(git(f.repo, '--version'));
    let checkedAbsent = false, injected = false;
    const observedTargets: (string | null)[] = [];
    intercept(t, (argv, launch) => {
      if (!injected && argv.includes('rev-parse') && argv.includes(ref)) checkedAbsent = true;
      if (!injected && (argv.includes('update-ref') || argv.includes('branch')) &&
          (argv.includes(ref) || argv.includes(`pipe/${r.id}`))) {
        assert.equal(checkedAbsent, true, 'race follows the preliminary existence check');
        assert.equal(symbolicTarget(f.repo, ref), null);
        assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', ref), '');
        assert.equal(git(f.repo, 'for-each-ref', '--format=%(refname)', unrelated), '');
        git(f.repo, 'symbolic-ref', ref, unrelated); injected = true;
        const child = launch();
        // Capture the immediate result too: cleanup cannot conceal an overwrite.
        child.once('close', () => { observedTargets.push(symbolicTarget(f.repo, ref)); });
        return child;
      }
      return launch();
    });
    const done = await execute(f, r);
    assert.equal(injected, true, 'install the dangling symbolic ref at the real create boundary');
    assert.deepEqual({ afterCreate: observedTargets, afterRun: symbolicTarget(f.repo, ref),
      target: git(f.repo, 'for-each-ref', '--format=%(refname)', unrelated),
      beforeSpawn: done.beforeSpawn, spawns: done.spawns, marker: existsSync(f.marker) },
    { afterCreate: [unrelated], afterRun: unrelated, target: '', beforeSpawn: 0, spawns: 0, marker: false },
    'create-only --no-deref alone must not overwrite a dangling symbolic ref, even transiently');
    refused(f, r, done);
  });

  test(`P183-TU-S1 ${selector}: changed work saves on pipe/id with parent A`, async t => {
    const { f, A, r, ref } = await selected(t, selector);
    const original = git(f.repo, 'show', `${A}:file`) + '\n';
    const catalog = git(f.repo, 'rev-parse', 'HEAD');
    const done = await execute(f, r);
    assert.equal(done.request.state, 'completed');
    assert.equal(done.spawns, 1);
    assert.equal(done.request.workspace?.startCommit, A);
    assert.ok(f.store.attempts(r.id)[0]!.closedAt, 'save only after recorded runner closure');
    assert.equal(readFileSync(join(done.workspace!.path, 'file'), 'utf8'), `built from ${original}`);
    const result = await saveWorktree(done.request, f.trees, undefined, f.env);
    assert.ok('commit' in result, `completed selected work must be saveable: ${JSON.stringify(result)}`);
    assert.equal(result.saved, true);
    assert.notEqual(result.commit, A);
    assert.equal(git(f.repo, 'rev-parse', ref), result.commit, 'save advances the owned pipe branch');
    assert.equal(git(f.repo, 'show', '-s', '--format=%P', result.commit), A, 'one parent, exactly selected A');
    assert.equal(git(f.repo, 'show', `${result.commit}:file`) + '\n', `built from ${original}`);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), catalog, 'saving does not move the catalog');
    assert.ok(f.store.recordWorkspaceCommit(r.id, result.commit, result.saved));
    assert.equal(f.store.get(r.id)!.workspace?.commit, result.commit);
  });
}

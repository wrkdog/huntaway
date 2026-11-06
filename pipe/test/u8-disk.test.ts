import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneWorktrees } from '../src/disk.ts';
import { run } from '../src/runner.ts';
import { Store } from '../src/store.ts';

function fixture(format?: 'sha256', retryBackoffMs?: number) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u8-prune-'));
  const repo = join(root, 'repo'), trees = join(root, 'trees');
  mkdirSync(repo); mkdirSync(trees);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main', ...(format ? ['--object-format=sha256'] : []));
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const store = new Store(join(root, 'pipe.sqlite'), { retryBackoffMs });
  const request = store.submit({ requester: 'test', project: 'test', kind: 'code', provider: 'claude', model: 'opus',
    effort: 'high', reason: 'verify retention', prompt: 'edit', mutating: true, priority: 'interactive', cwd: repo });
  const account = { id: 'claude-a', provider: 'claude' as const, loginDir: root, fingerprint: '00000000', enabled: true, maxConcurrency: 1 };
  const evidence = { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(),
    verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read', 'Edit'] };
  const started = store.startAttempt(request.id, account, evidence);
  assert.equal(started.ok, true);
  const path = join(trees, request.id), branch = `pipe/${request.id}`;
  git('branch', branch); git('worktree', 'add', path, branch);
  const workspace = { path, branch, commit: 'uncommitted' };
  store.noteWorkspace(started.attempt.id, workspace);
  const close = () => {
    store.close();
    if (existsSync(path)) git('worktree', 'remove', path);
    rmSync(root, { recursive: true, force: true });
  };
  return { store, request, attempt: started.attempt, path, trees, workspace, git, close };
}

test('a cancelled request keeps its worktree while its attempt is still open', async () => {
  const f = fixture();
  try {
    f.store.cancel(f.request.id, 'requester cancelled');
    const report = await pruneWorktrees(f.store, f.trees, 0, () => {}, () => true);
    assert.equal(report.removed.length, 0, JSON.stringify(report));
    assert.equal(existsSync(f.path), true);
  } finally { f.close(); }
});

test('a failed commit-record write leaves the worktree for a later prune pass', async () => {
  const f = fixture();
  try {
    f.store.finishAttempt(f.attempt.id, { kind: 'completed', result: 'OK', workspace: f.workspace });
    f.store.recordWorkspaceCommit = () => { throw new Error('store is unwritable'); };
    const report = await pruneWorktrees(f.store, f.trees, 0, () => {}, () => true);
    assert.equal(report.failed.length, 1, JSON.stringify(report));
    assert.equal(existsSync(f.path), true, 'the worktree remains available for retry');
  } finally { f.close(); }
});

test('a recorded path reused by another repository is never committed', async () => {
  const f = fixture();
  try {
    const foreign = join(f.trees, 'foreign');
    mkdirSync(foreign);
    const other = (...args: string[]) => execFileSync('git', ['-C', foreign, ...args], { encoding: 'utf8' }).trim();
    other('init', '-q', '-b', 'main');
    other('config', 'user.name', 'Foreign'); other('config', 'user.email', 'foreign@localhost');
    writeFileSync(join(foreign, 'file.txt'), 'base\n');
    other('add', '-A'); other('commit', '-qm', 'base');
    writeFileSync(join(foreign, 'file.txt'), 'private edit\n');
    f.store.finishAttempt(f.attempt.id, { kind: 'completed', result: 'OK',
      workspace: { path: foreign, branch: f.workspace.branch, commit: 'uncommitted' } });
    await pruneWorktrees(f.store, f.trees, 0, () => {}, () => true);
    assert.match(other('status', '--porcelain'), /file.txt/, 'foreign changes stay uncommitted');
  } finally { f.close(); }
});

test('an untouched disk-full setup failure waits without blaming the account', () => {
  const f = fixture();
  try {
    const ended = f.store.finishAttempt(f.attempt.id, { kind: 'failed', errorKind: 'disk_full',
      message: 'ENOSPC: no space left on device', untouched: true });
    assert.equal(ended.request?.state, 'queued');
    assert.deepEqual(ended.request?.avoid, []);
    assert.ok(ended.request?.notBefore);
  } finally { f.close(); }
});

test('the tenth disk-full outcome ends the request', () => {
  const f = fixture(undefined, 0);
  try {
    let attempt = f.attempt;
    for (let n = 1; n <= 10; n++) {
      const ended = f.store.finishAttempt(attempt.id, { kind: 'failed', errorKind: 'disk_full',
        message: 'ENOSPC', untouched: true });
      assert.equal(ended.request?.state, n === 10 ? 'failed' : 'queued');
      if (n < 10) {
        const next = f.store.startAttempt(f.request.id, { id: 'claude-a', provider: 'claude', loginDir: f.trees,
          fingerprint: '00000000', enabled: true, maxConcurrency: 1 }, { accountId: 'claude-a', model: 'opus',
          observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Edit'] });
        assert.equal(next.ok, true);
        attempt = next.attempt;
      } else assert.match(ended.request?.error?.message ?? '', /after 10 disk-full failures/);
    }
  } finally { f.close(); }
});

test('a failed worktree add reports disk_full and untouched after cleanup', async () => {
  const f = fixture();
  const bin = join(f.trees, '..', 'bin');
  try {
    mkdirSync(bin);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) echo 'No space left on device' >&2; exit 128;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const events = [];
    for await (const event of run({ requestId: 'setup-disk-test', accountId: 'claude-a', provider: 'claude', model: 'opus',
      effort: 'high', prompt: 'edit', mutating: true, cwd: join(f.trees, '..', 'repo'), loginDir: f.trees },
    { cli: { claude: '/bin/true' }, env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, worktreeRoot: f.trees })) events.push(event);
    const failure = events.find((event) => event.type === 'failed');
    assert.equal(failure?.type === 'failed' ? failure.errorKind : null, 'disk_full');
    assert.equal(failure?.type === 'failed' ? failure.untouched : null, true);
    assert.equal(existsSync(join(f.trees, 'setup-disk-test')), false);
  } finally { f.close(); }
});

test('a changing disk-full failure without untouched proof keeps its worktree and fails', () => {
  const f = fixture();
  try {
    const ended = f.store.finishAttempt(f.attempt.id, { kind: 'failed', errorKind: 'disk_full',
      message: 'disk is full', workspace: f.workspace });
    assert.equal(ended.request?.state, 'failed');
    assert.equal(ended.request?.workspace?.path, f.path);
  } finally { f.close(); }
});

test('a changed path with a clean filter is kept before git can run the filter', async () => {
  const f = fixture();
  const script = join(f.path, 'clean.sh'), marker = join(f.path, 'ran');
  try {
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    f.git('config', 'filter.test.clean', `"${script}"`);
    writeFileSync(join(f.git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'attributes'), 'work.txt filter=test\n');
    writeFileSync(join(f.path, 'work.txt'), 'changed\n');
    f.store.finishAttempt(f.attempt.id, { kind: 'completed', result: 'OK', workspace: f.workspace });
    const report = await pruneWorktrees(f.store, f.trees, 0, () => {}, () => true);
    assert.match(report.kept[0]?.reason ?? '', /clean filter/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(f.path), true);
  } finally {
    rmSync(join(f.path, 'work.txt'), { force: true });
    rmSync(script, { force: true });
    f.close();
  }
});

test('a modified tracked path under a clean filter is kept before status reads it', async () => {
  const f = fixture();
  const script = join(f.path, 'clean.sh'), marker = join(f.path, 'ran');
  try {
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    f.git('config', 'filter.test.clean', `"${script}"`);
    writeFileSync(join(f.git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'attributes'), 'README.md filter=test\n');
    writeFileSync(join(f.path, 'README.md'), 'edit\n');
    f.store.finishAttempt(f.attempt.id, { kind: 'completed', result: 'OK', workspace: f.workspace });
    const report = await pruneWorktrees(f.store, f.trees, 0, () => {}, () => true);
    assert.match(report.kept[0]?.reason ?? '', /clean filter/);
    assert.equal(existsSync(marker), false);
  } finally {
    f.git('config', '--unset', 'filter.test.clean');
    writeFileSync(join(f.path, 'README.md'), 'base\n');
    rmSync(script, { force: true });
    f.close();
  }
});

test('an aborted prune ends a hung git command and leaves the worktree', async () => {
  const f = fixture();
  const bin = join(f.trees, '..', 'bin'), marker = join(bin, 'hung.pid');
  const abort = new AbortController();
  try {
    mkdirSync(bin);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status "*) echo $$ > "${marker}"; exec sleep 3600;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    f.store.finishAttempt(f.attempt.id, { kind: 'completed', result: 'OK', workspace: f.workspace });
    const pass = pruneWorktrees(f.store, f.trees, 0, () => {}, () => true, undefined,
      { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, abort.signal);
    const deadline = Date.now() + 3_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), 'prune reached git status');
    abort.abort();
    const report = await pass;
    assert.equal(report.removed.length, 0);
    assert.equal(existsSync(f.path), true);
    const pid = Number(readFileSync(marker, 'utf8'));
    const endedBy = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < endedBy) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, 'the hung git child ended');
  } finally { abort.abort(); f.close(); }
});

test('an aborted prune ends a SIGTERM-ignoring git and its output-holding child', async () => {
  const f = fixture();
  const bin = join(f.trees, '..', 'bin'), marker = join(bin, 'hung.pid');
  const abort = new AbortController();
  try {
    mkdirSync(bin);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status "*) trap '' TERM; sleep 3600 & echo $! > "${marker}"; wait;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    f.store.finishAttempt(f.attempt.id, { kind: 'completed', result: 'OK', workspace: f.workspace });
    const pass = pruneWorktrees(f.store, f.trees, 0, () => {}, () => true, undefined,
      { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, abort.signal);
    const deadline = Date.now() + 3_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), 'prune reached git status');
    const started = Date.now();
    abort.abort();
    const report = await pass;
    assert.ok(Date.now() - started < 10_000, 'abort settles promptly');
    assert.equal(report.removed.length, 0);
    const pid = Number(readFileSync(marker, 'utf8'));
    const endedBy = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < endedBy) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(alive, false, 'the output-holding child ended');
  } finally { abort.abort(); f.close(); }
});

test('a SHA-256 branch is saved, recorded and pruned', async () => {
  const f = fixture('sha256');
  try {
    writeFileSync(join(f.path, 'work.txt'), 'changed\n');
    f.store.finishAttempt(f.attempt.id, { kind: 'completed', result: 'OK', workspace: f.workspace });
    const report = await pruneWorktrees(f.store, f.trees, 0, () => {}, () => true);
    assert.equal(report.removed.length, 1, JSON.stringify(report));
    assert.match(report.removed[0]!.commit, /^[0-9a-f]{64}$/);
    assert.equal(f.store.get(f.request.id)?.workspace?.commit, report.removed[0]!.commit);
    assert.equal(existsSync(f.path), false);
  } finally { f.close(); }
});

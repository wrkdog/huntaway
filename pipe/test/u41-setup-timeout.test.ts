import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, setupKind } from '../src/runner.ts';
import { runGit } from '../src/disk.ts';
import { Store } from '../src/store.ts';
import { submitReview } from '../src/review.ts';
import { parsePolicy } from '../src/policy.ts';

const at = new Date('2026-10-21T15:47:56Z');
const account = { id: 'claude-a', provider: 'claude' as const, loginDir: '/tmp', fingerprint: '00000000', enabled: true, maxConcurrency: 1 };
const evidence = { accountId: account.id, model: 'opus', observedAt: at.toISOString(), verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read'] };
const timeout = { kind: 'failed' as const, errorKind: 'setup_timeout' as const, message: 'git command timed out after 2000 ms', untouched: true };
function fixture(maxAttempts = 1) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u41-extra-'))), file = join(dir, 'record.sqlite');
  execFileSync('git', ['init', '-q', dir]);
  let clock = new Date(at);
  let store = new Store(file, { now: () => clock, maxAttempts, retryBackoffMs: 1234 });
  const request = store.submit({ requester: 'test', project: 'test', kind: 'code', provider: 'claude', model: 'opus', effort: 'high', reason: 'test setup safety', prompt: 'read', mutating: false, priority: 'interactive', cwd: dir });
  return { get store() { return store; }, id: request.id, dir,
    start() { const started = store.startAttempt(request.id, account, { ...evidence, observedAt: clock.toISOString() }); assert.equal(started.ok, true, JSON.stringify(started)); return started.attempt.id; },
    advance() { clock = new Date(clock.getTime() + 1234); },
    reopen() { store.close(); store = new Store(file, { now: () => clock, maxAttempts, retryBackoffMs: 1234 }); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('disk-full classification wins even when a setup diagnostic also contains timeout text', () => {
  assert.equal(setupKind('ENOSPC; git command timed out after 2000 ms'), 'disk_full');
});

test('read-only setup timeout requires untouched proof and retains a leftover workspace', () => {
  for (const left of [false, true]) {
    const f = fixture();
    try {
      const workspace = { path: join(f.dir, 'retained'), branch: 'pipe/retained', commit: 'uncommitted' };
      const result = f.store.finishAttempt(f.start(), { ...timeout, untouched: false, ...(left ? { workspace } : {}) }).request!;
      assert.equal(result.state, 'failed');
      assert.equal(result.workspace?.path ?? null, left ? workspace.path : null);
    } finally { f.close(); }
  }
});

test('setup timeout count survives restart and does not consume the ordinary attempt budget', () => {
  const f = fixture();
  try {
    for (let i = 1; i <= 2; i++) {
      const result = f.store.finishAttempt(f.start(), timeout).request!;
      assert.equal(result.state, i === 2 ? 'failed' : 'queued');
      if (i < 2) assert.equal(result.notBefore, new Date(at.getTime() + i * 1234).toISOString());
      else assert.match(result.error!.message, /gave up after 2 setup timeouts/);
      f.reopen();
      f.advance();
      assert.equal(f.store.get(f.id)!.error!.kind, 'setup_timeout');
    }
  } finally { f.close(); }
});

test('a later ordinary failure keeps its own retry budget after setup timeouts', () => {
  const f = fixture(2);
  try {
    f.store.finishAttempt(f.start(), timeout);
    f.advance();
    const result = f.store.finishAttempt(f.start(), { kind: 'failed', errorKind: 'transient', message: 'temporary stream failure' }).request!;
    assert.equal(result.state, 'queued');
    assert.deepEqual(result.avoid, []);
  } finally { f.close(); }
});

test('worktree-add deadlines reject invalid timers before setup and accept both integer boundaries', async (t) => {
  const signal = AbortSignal.abort();
  const spec = { requestId: 'invalid-timer', accountId: 'claude-a', provider: 'claude' as const, model: 'opus', effort: 'high',
    prompt: 'edit', mutating: true, cwd: '/unused', loginDir: '/unused' };
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1, '1', null, 1, 2_147_483_647]) {
    await t.test(String(value), async () => {
      const events = [];
      for await (const event of run(spec, { cli: { claude: '/bin/true' }, signal, worktreeAddTimeoutMs: value as number })) events.push(event);
      const valid = value === 1 || value === 2_147_483_647;
      assert.equal(events.length, 1);
      const end = events.find(event => event.type === 'failed');
      assert.ok(end);
      assert.equal(end.errorKind, valid ? 'cancelled' : 'other');
      assert.equal(end.message, valid ? 'cancelled before the CLI started' : 'worktreeAddTimeoutMs must be whole milliseconds from 1 to 2147483647');
    });
  }
});

test('a review timeout retains its registered worktree without inline removal or prune', { timeout: 20_000 }, async () => {
  const f = fixture();
  const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
    writeFileSync(join(f.dir, 'README.md'), 'base\n'); git('add', 'README.md'); git('commit', '-qm', 'base');
    const head = git('rev-parse', 'HEAD'), bin = join(f.dir, 'bin'), trees = join(f.dir, 'trees');
    mkdirSync(bin);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) "${realGit}" "$@" || exit $?; exec /bin/sleep 4159.2653;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    execFileSync(join(bin, 'git'), ['--version']);
    await assert.rejects(submitReview(f.store, parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } }), trees,
      { requester: 'test', reason: 'verify cleanup', repo: f.dir, head, brief: 'Review this commit.', seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] },
      { ...process.env, PATH: `${bin}:${process.env.PATH}` }, { worktreeAddTimeoutMs: 2000 }),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 503 && 'code' in error && error.code === 'setup_timeout');
    const reviews = f.store.runningReviews();
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.setupFailed, true);
    assert.deepEqual(reviews[0]!.seats, []);
    assert.equal(existsSync(reviews[0]!.worktree as string), true);
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 2);
    assert.equal(reviews[0]!.cleanupFailures, undefined);
  } finally { f.close(); }
});

test('a stopped git retries EPERM group probes until ESRCH proves closure', { timeout: 15_000 }, async () => {
  const f = fixture(), kill = process.kill;
  let probes = 0;
  try {
    writeFileSync(join(f.dir, 'git'), '#!/bin/sh\nexec /bin/sleep 4100\n', { mode: 0o755 });
    process.kill = ((pid, signal) => {
      if (pid < 0 && signal === 0 && ++probes <= 3) throw Object.assign(new Error('unknown group'), { code: 'EPERM' });
      return kill(pid, signal);
    }) as typeof process.kill;
    await assert.rejects(runGit(f.dir, ['status'], { ...process.env, PATH: `${f.dir}:${process.env.PATH}` }, undefined, undefined,
      { timeoutMs: 1000 }), (e: any) => { assert.equal(e.groupClosed, true); return true; });
    assert.ok(probes > 3, 'EPERM was retried rather than accepted as closure');
  } finally { process.kill = kill; f.close(); }
});

test('unproven stopped setup groups retain the claimed path and forbid untouched retry', { timeout: 20_000 }, async () => {
  const f = fixture(), kill = process.kill, trees = join(f.dir, 'trees'), bin = join(f.dir, 'bin');
  const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
    writeFileSync(join(f.dir, 'base'), 'base'); git('add', 'base'); git('commit', '-qm', 'base');
    mkdirSync(bin);
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) exec /bin/sleep 4200;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    process.kill = ((pid, signal) => {
      if (pid < 0 && signal === 0) throw Object.assign(new Error('unknown group'), { code: 'EPERM' });
      return kill(pid, signal);
    }) as typeof process.kill;
    const events = [];
    for await (const event of run({ requestId: 'uncertain', accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
      prompt: 'edit', mutating: true, cwd: f.dir, loginDir: f.dir }, { cli: { claude: '/bin/true' }, worktreeRoot: trees,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, worktreeAddTimeoutMs: 1000 })) events.push(event);
    const end = events.find(e => e.type === 'failed');
    assert.equal(end?.errorKind, 'setup_timeout');
    assert.notEqual(end?.untouched, true);
    assert.equal(end?.workspace?.path, join(trees, 'uncertain'));
    assert.equal(existsSync(join(trees, 'uncertain')), true);
    assert.equal(git('branch', '--list', 'pipe/uncertain'), 'pipe/uncertain');
  } finally { process.kill = kill; f.close(); }
});

test('locked review timeouts preserve base bookkeeping without inline cleanup commands', { timeout: 20_000 }, async () => {
  for (const command of ['list', 'remove', 'prune']) {
    const f = fixture(), bin = join(f.dir, 'bin'), calls = join(f.dir, 'cleanup-calls');
    const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' }).trim();
    try {
      git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
      writeFileSync(join(f.dir, 'base'), 'base'); git('add', 'base'); git('commit', '-qm', 'base');
      mkdirSync(bin);
      const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      writeFileSync(calls, '');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) "${realGit}" "$@" || exit $?; for a; do prev2=$prev; prev=$a; done; "${realGit}" -C "$prev2" worktree lock --reason initializing "$prev2" || exit $?; exec /bin/sleep 4300;; *" worktree list "*|*" worktree remove "*|*" worktree prune "*) echo "$*" >> "${calls}";; esac\ncase " $* " in *" worktree ${command} "*) exit 1;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
      await assert.rejects(submitReview(f.store, parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } }), join(f.dir, 'trees'),
        { requester: 'test', reason: 'cleanup', repo: f.dir, head: git('rev-parse', 'HEAD'), brief: 'Review.', seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] },
        { ...process.env, PATH: `${bin}:${process.env.PATH}` }, { worktreeAddTimeoutMs: 1000 }),
        (e: any) => { assert.equal(e.status, 503); assert.equal(e.code, 'setup_timeout'); assert.match(e.message, /review setup timed out.*review was not started/); return true; });
      const review = f.store.runningReviews()[0]!;
      assert.equal(review.setupFailed, true);
      assert.equal(review.preparing, undefined);
      assert.deepEqual(review.seats, []);
      assert.equal(review.cleanupFailures, undefined);
      assert.equal(existsSync(review.worktree as string), true);
      assert.equal(readFileSync(calls, 'utf8'), '', 'submission ran no list, removal or prune');
      assert.match(git('worktree', 'list', '--porcelain'), /locked initializing/);
    } finally { f.close(); }
  }
});

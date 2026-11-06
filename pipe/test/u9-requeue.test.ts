import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, type RunEvent } from '../src/runner.ts';
import { Store, type NewRequest } from '../src/store.ts';
import type { AccountConfig } from '../src/identity.ts';

const account: AccountConfig = { id: 'a', provider: 'claude', loginDir: '/tmp/a', fingerprint: 'a', maxConcurrency: 1, enabled: true };
const request = (cwd: string): NewRequest => ({ requester: 'r', project: 'p', kind: 'code', provider: 'claude',
  model: 'opus', effort: 'high', reason: 'change', prompt: 'change a file', mutating: true, cwd, priority: 'interactive' });

test('an untouched changing sign-in failure clears its old workspace, retries, and spends the limit budget', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pipe-u9-cwd-'));
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u9-store-')), 'pipe.sqlite'), { maxLimits: 2 });
  try {
    const id = store.submit(request(cwd)).id;
    for (let n = 1; n <= 2; n++) {
      const evidence = { accountId: 'a', model: 'opus', observedAt: new Date().toISOString(),
        verdict: { state: 'available' as const, headroom: 1 }, grant: ['Read'] };
      const claimed = store.startAttempt(id, account, evidence);
      assert.equal(claimed.ok, true);
      if (!claimed.ok) break;
      store.noteWorkspace(claimed.attempt.id, { path: join(cwd, 'old'), branch: 'pipe/old', commit: 'uncommitted' });
      const row = store.finishAttempt(claimed.attempt.id,
        { kind: 'failed', errorKind: 'auth', message: '401', untouched: true }).request;
      assert.equal(row.state, n === 2 ? 'failed' : 'queued');
      assert.equal(row.workspace, null);
      assert.deepEqual(row.avoid, []);
      assert.equal(store.attempts(id)[n - 1]?.outcome?.kind, 'failed');
      assert.equal((store.attempts(id)[n - 1]?.outcome as { errorKind?: string }).errorKind, 'auth');
      if (n === 2) assert.match(row.error?.message ?? '', /gave up after 2 repeated sign-in failures/);
    }
  } finally { store.close(); }
});

test('a changing failure without untouched proof keeps its workspace and fails', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pipe-u9-cwd-'));
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u9-store-')), 'pipe.sqlite'));
  try {
    const id = store.submit(request(cwd)).id;
    const claimed = store.startAttempt(id, account, { accountId: 'a', model: 'opus', observedAt: new Date().toISOString(),
      verdict: { state: 'available', headroom: 1 }, grant: ['Read'] });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    const work = { path: join(cwd, 'kept'), branch: 'pipe/kept', commit: 'uncommitted' };
    store.noteWorkspace(claimed.attempt.id, work);
    const row = store.finishAttempt(claimed.attempt.id, { kind: 'failed', errorKind: 'auth', message: '401', workspace: work }).request;
    assert.equal(row.state, 'failed');
    assert.deepEqual(row.workspace, work);
  } finally { store.close(); }
});

test('an abort after a reported model cannot erase the worktree on a temporary failure', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pipe-u9-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'README.md'), 'original\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  const cli = join(mkdtempSync(join(tmpdir(), 'pipe-u9-cli-')), 'claude');
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'system',subtype:'init',model:'wrong',session_id:'s'})+'\\n'+JSON.stringify({type:'result',subtype:'error',is_error:true,errors:['401 unauthorized']})+'\\n'); process.exitCode=1;\n`);
  chmodSync(cli, 0o755);
  const abort = new AbortController();
  let end: Extract<RunEvent, { type: 'failed' }> | undefined;
  for await (const event of run({ requestId: 'abort-mismatch', accountId: 'a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'change', mutating: true, cwd, loginDir: cwd }, { cli: { claude: cli }, worktreeRoot: mkdtempSync(join(tmpdir(), 'pipe-u9-wt-')),
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, signal: abort.signal, reachable: async () => true })) {
    if (event.type === 'started') abort.abort();
    if (event.type === 'failed') end = event;
  }
  assert.equal(end?.type, 'failed');
  assert.ok(end?.type === 'failed' && end.workspace, 'the aborted run keeps its workspace for a model mismatch');
});

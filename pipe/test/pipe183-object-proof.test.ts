import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunEvent } from '../src/runner.ts';

for (const fault of ['branch', 'detached HEAD', 'create race']) {
  test(`P183-R2-O2 ${fault} cannot bypass selector object proof`, async t => {
    // [fixture rule: realpath of the temp folder]
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe183-object-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo'), trees = join(root, 'trees'), login = join(root, 'login');
    for (const path of [repo, trees, login]) mkdirSync(path);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, 'file'), 'A\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'A');
    const A = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'file'), 'B\n'); git(repo, 'commit', '-qam', 'B');
    const B = git(repo, 'rev-parse', 'HEAD'); git(repo, 'reset', '--hard', A);
    const id = 'object-proof', branch = `pipe/${id}`, path = join(trees, id);
    const spawn = childProcess.spawn;
    let injected = false, beforeSpawn = 0, workspaces = 0;
    t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
      const argv = args[1] as string[];
      if (!injected && fault === 'create race' && (argv.includes('branch') || argv.includes('update-ref')) &&
          (argv.includes(branch) || argv.includes(`refs/heads/${branch}`))) {
        git(repo, 'update-ref', `refs/heads/${branch}`, B); injected = true;
      }
      const child = spawn(...args);
      if (!injected && fault !== 'create race' && argv.includes('worktree') && argv.includes('add')) {
        child.once('close', code => {
          assert.equal(code, 0);
          if (fault === 'branch') git(repo, 'update-ref', `refs/heads/${branch}`, B);
          else git(path, 'checkout', '--detach', B);
          injected = true;
        });
      }
      return child;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const events: RunEvent[] = [];
    for await (const event of run({ requestId: id, accountId: 'fixture', provider: 'codex',
      model: 'fixture', effort: 'high', prompt: 'Never reaches a worker', mutating: true,
      cwd: repo, loginDir: login, pinnedStartCommit: A }, {
      cli: { codex: process.execPath }, worktreeRoot: trees,
      env: { PATH: process.env.PATH, HOME: root }, killGraceMs: 0,
      onBeforeSpawn: () => { beforeSpawn++; throw new Error('worker boundary reached'); },
      onWorkspace: () => { workspaces++; },
    })) events.push(event);
    assert.equal(injected, true, 'the real-Git fault must occur');
    assert.equal(beforeSpawn, 0); assert.equal(workspaces, 0);
    const last = events.at(-1);
    assert.equal(last?.type, 'failed');
    if (last?.type === 'failed') {
      assert.equal(last.errorKind, 'other');
      assert.deepEqual(last.workspace, { path, branch }, 'uncertain work/branch stays owned');
    }
    assert.equal(git(repo, 'rev-parse', `refs/heads/${branch}`), fault === 'detached HEAD' ? A : B);
  });
}

/**
 * Lead acceptance tests: saving and pruning worktrees in repositories with untouched submodules (proposal
 * R1). The builder must not edit this file.
 *
 * Evidence (pipe.sqlite and pipe.log, 2026-10-14): 1,572 of 2,460 kept worktrees (~64% of ~889 GB) are kept only
 * because `saveWorktree` refuses any repository with a gitlink ("it contains a submodule; save it by hand", 788 log
 * lines). A real repository may hold gitlinks the builders never touch, and the pipe never initialises submodules.
 *
 * This lane tests only the save rule; setup serialisation is tracked separately.
 *
 * Interface under test:
 * - `saveWorktree` saves a worktree whose gitlinks (mode 160000), in both the index and HEAD, are exactly those of the
 *   run's start commit (`workspace.startCommit`): the same paths with the same commits, none added, none removed.
 *   When neither the index nor HEAD holds any gitlink, the start commit is not read (main's behaviour; a gitlink the
 *   builder removed and committed is then saved, since the removal is in the commit).
 * - Each such gitlink's path in the worktree must be an existing, empty, real directory: what `git worktree add`
 *   leaves for a submodule that was never initialised. Absent, a file, a symlink, or any content there keeps the
 *   worktree. An absent path is kept because prune's plain `git worktree remove` would report it as deleted and
 *   refuse (review 75a2edae, Opus).
 * - Anything else keeps the worktree with a reason matching /submodule/, before any `git status`, add or commit runs,
 *   so nothing inside a submodule is ever read. A record without `startCommit` keeps any gitlink, as today.
 * - A saved worktree is then removed by prune's ordinary `git worktree remove`, its work committed on its branch.
 *
 * Review round 1 of this change adds M11–M15:
 * - Git refuses to remove a worktree whose administrative directory holds `modules` (left when a submodule was
 *   initialised there, even after deinit). Such a worktree is kept with a /submodule/ reason; prune never fails on it.
 * - An index entry that hides changes (skip-worktree, assume-unchanged) or is unmerged keeps the worktree in every
 *   repository, with its own reason matching /hidden|unmerged/ (not /submodule/).
 * - A symlinked parent of a gitlink path keeps the worktree.
 * - Any error while inspecting a gitlink path (for example a directory without permissions) keeps the worktree
 *   quietly: prune records it as kept, never as failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneWorktrees, saveWorktree } from '../src/disk.ts';
import { Store } from '../src/store.ts';

const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const gitIn = (cwd: string, ...args: string[]) => execFileSync(realGit, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
  { encoding: 'utf8', stdio: 'pipe' }).trim();

/** A repository whose tree holds a gitlink (lib/sub) and a .gitmodules, as some real repositories do; the submodule is never cloned. */
function repoWithSubmodule(): { dir: string; seed: string; link: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u34-repo-')));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'lead@example.invalid'); gitIn(dir, 'config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'file.txt'), 'seed\n');
  writeFileSync(join(dir, '.gitmodules'), '[submodule "lib/sub"]\n\tpath = lib/sub\n\turl = https://example.invalid/sub.git\n');
  gitIn(dir, 'add', 'file.txt', '.gitmodules');
  const link = 'a'.repeat(40);
  gitIn(dir, 'update-index', '--add', '--cacheinfo', `160000,${link},lib/sub`);
  gitIn(dir, 'commit', '-qm', 'seed with a submodule');
  return { dir, seed: gitIn(dir, 'rev-parse', 'HEAD'), link };
}

/** A finished changing request whose worktree is on its own pipe branch, as the service leaves it. */
function finishedWorktree(r: { dir: string; seed: string }, startCommit: string | null = r.seed) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u34-save-'))), trees = join(root, 'trees');
  mkdirSync(trees);
  const store = new Store(join(root, 'record.sqlite'));
  const request = store.submit({ requester: 'fixture', project: 'fixture', kind: 'code', provider: 'claude', model: 'opus',
    effort: 'high', reason: 'save proof', prompt: 'inert', mutating: true, priority: 'interactive', cwd: r.dir });
  const account = { id: 'fixture', provider: 'claude' as const, loginDir: root, fingerprint: '00000000', enabled: true, maxConcurrency: 1 };
  const claim = store.startAttempt(request.id, account, { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(),
    verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Edit'] });
  assert.ok(claim.ok);
  const path = join(trees, request.id), branch = `pipe/${request.id}`;
  gitIn(r.dir, 'worktree', 'add', '-q', '-b', branch, path, r.seed);
  const workspace = { path, branch, commit: 'uncommitted', ...(startCommit === null ? {} : { startCommit }) };
  store.noteWorkspace(claim.attempt.id, workspace);
  store.finishAttempt(claim.attempt.id, { kind: 'completed', result: 'OK', workspace });
  return { root, trees, store, request, path, branch, env: { PATH: process.env.PATH, HOME: root, TMPDIR: root } };
}

type Fixture = ReturnType<typeof finishedWorktree>;
const cleanup = (r: { dir: string }, f: Fixture) => { f.store.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(r.dir, { recursive: true, force: true }); };
const save = (r: { dir: string }, f: Fixture) => saveWorktree(f.store.get(f.request.id)!, f.trees, r.dir, f.env);
const prune = (r: { dir: string }, f: Fixture) => {
  const logged: string[] = [];
  return pruneWorktrees(f.store, f.trees, 0, (where, e) => logged.push(`${where}: ${String(e)}`), () => true, r.dir, f.env)
    .then(report => ({ report, logged }));
};

/** Expects the save to keep the worktree for a submodule reason, with the builder's edit still uncommitted in place. */
async function kept(r: { dir: string; seed: string }, f: Fixture) {
  const before = gitIn(r.dir, 'rev-parse', `refs/heads/${f.branch}`);
  const result = await save(r, f);
  assert.ok('keep' in result, JSON.stringify(result));
  assert.match(result.keep, /submodule/i);
  assert.equal(gitIn(r.dir, 'rev-parse', `refs/heads/${f.branch}`), before, 'the save committed nothing');
  const { report } = await prune(r, f);
  assert.equal(report.removed.length, 0, JSON.stringify(report));
  assert.match(JSON.stringify(report.kept), /submodule/i, JSON.stringify(report));
  assert.ok(existsSync(f.path), 'prune leaves the worktree in place');
  assert.equal(gitIn(r.dir, 'rev-parse', `refs/heads/${f.branch}`), before, 'prune committed nothing');
}

test('M1 an untouched, uninitialised submodule: the save commits the work and prune removes the worktree', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    assert.ok(existsSync(join(f.path, 'lib', 'sub')), 'git worktree add leaves an empty directory for the gitlink');
    writeFileSync(join(f.path, 'file.txt'), 'changed by the builder\n');
    writeFileSync(join(f.path, 'new.txt'), 'a new file\n');
    const { report, logged } = await prune(r, f);
    assert.deepEqual(report.failed, [], JSON.stringify(report));
    assert.equal(report.removed.length, 1, JSON.stringify({ report, logged }));
    const commit = report.removed[0]!.commit;
    assert.equal(report.removed[0]!.saved, true);
    assert.ok(!existsSync(f.path), 'the worktree folder is gone');
    assert.equal(gitIn(r.dir, 'rev-parse', `refs/heads/${f.branch}`), commit, 'the branch holds the saved commit');
    assert.equal(gitIn(r.dir, 'show', `${commit}:file.txt`), 'changed by the builder');
    assert.equal(gitIn(r.dir, 'show', `${commit}:new.txt`), 'a new file');
    assert.match(gitIn(r.dir, 'ls-tree', commit, 'lib/sub'), new RegExp(`^160000 commit ${r.link}\\s+lib/sub$`), 'the gitlink is unchanged');
    assert.equal(f.store.get(f.request.id)!.workspace!.commit, commit, 'the record names the saved commit');
  } finally { cleanup(r, f); }
});

test('M2 an untouched submodule and a builder commit: saved without a new commit, then removed', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    writeFileSync(join(f.path, 'file.txt'), 'committed by the builder\n');
    gitIn(f.path, 'add', 'file.txt');
    gitIn(f.path, '-c', 'user.name=b', '-c', 'user.email=b@example.invalid', 'commit', '-qm', 'builder commit');
    const head = gitIn(f.path, 'rev-parse', 'HEAD');
    const result = await save(r, f);
    assert.ok('commit' in result, JSON.stringify(result));
    assert.equal(result.commit, head);
    assert.equal(result.saved, false);
  } finally { cleanup(r, f); }
});

test('M3 a gitlink moved in the index keeps the worktree', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    gitIn(f.path, 'update-index', '--cacheinfo', `160000,${'b'.repeat(40)},lib/sub`);
    await kept(r, f);
  } finally { cleanup(r, f); }
});

test('M4 a gitlink moved by a builder commit keeps the worktree', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    gitIn(f.path, 'update-index', '--cacheinfo', `160000,${'c'.repeat(40)},lib/sub`);
    gitIn(f.path, '-c', 'user.name=b', '-c', 'user.email=b@example.invalid', 'commit', '-qm', 'move the submodule');
    await kept(r, f);
  } finally { cleanup(r, f); }
});

test('M5 a gitlink added by the builder keeps the worktree', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    mkdirSync(join(f.path, 'lib', 'other'), { recursive: true });
    gitIn(f.path, 'update-index', '--add', '--cacheinfo', `160000,${'d'.repeat(40)},lib/other`);
    await kept(r, f);
  } finally { cleanup(r, f); }
});

test('M6 a gitlink removed by the builder keeps the worktree', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    gitIn(f.path, 'rm', '-q', '--cached', 'lib/sub');
    await kept(r, f);
  } finally { cleanup(r, f); }
});

test('M7 content inside the submodule path keeps the worktree, even with its gitlink unchanged', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    writeFileSync(join(f.path, 'lib', 'sub', 'inner.txt'), 'work inside the submodule\n');
    await kept(r, f);
  } finally { cleanup(r, f); }
});

test('M8 an absent submodule directory keeps the worktree, so prune never meets a removal git refuses', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    rmdirSync(join(f.path, 'lib', 'sub'));
    await kept(r, f);
  } finally { cleanup(r, f); }
});

test('M9 a file or a symlink at the submodule path keeps the worktree', async () => {
  for (const plant of ['file', 'symlink'] as const) {
    const r = repoWithSubmodule(), f = finishedWorktree(r);
    try {
      writeFileSync(join(f.path, 'file.txt'), 'changed\n');
      const at = join(f.path, 'lib', 'sub');
      rmdirSync(at);
      if (plant === 'file') writeFileSync(at, 'not a directory\n');
      else { const target = join(f.root, 'elsewhere'); mkdirSync(target); symlinkSync(target, at); }
      await kept(r, f);
    } finally { cleanup(r, f); }
  }
});

test('M10 a record without a start commit keeps any gitlink, as today', async () => {
  // null, not undefined: undefined would take the parameter's default.
  const r = repoWithSubmodule(), f = finishedWorktree(r, null);
  try {
    writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    await kept(r, f);
  } finally { cleanup(r, f); }
});

// ---- Review round 1 (b3dddf21) ---------------------------------------------------------------------------------------

/** A repository without any submodule. */
function plainRepo(): { dir: string; seed: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u34-plain-')));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'lead@example.invalid'); gitIn(dir, 'config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'file.txt'), 'seed\n');
  gitIn(dir, 'add', 'file.txt'); gitIn(dir, 'commit', '-qm', 'seed');
  return { dir, seed: gitIn(dir, 'rev-parse', 'HEAD') };
}

/** Like kept(), with a reason pattern of the caller's choosing. */
async function keptFor(r: { dir: string; seed: string }, f: Fixture, reason: RegExp) {
  const before = gitIn(r.dir, 'rev-parse', `refs/heads/${f.branch}`);
  const result = await save(r, f);
  assert.ok('keep' in result, JSON.stringify(result));
  assert.match(result.keep, reason);
  const { report } = await prune(r, f);
  assert.deepEqual(report.failed, [], JSON.stringify(report));
  assert.equal(report.removed.length, 0, JSON.stringify(report));
  assert.ok(existsSync(f.path), 'prune leaves the worktree in place');
  assert.equal(gitIn(r.dir, 'rev-parse', `refs/heads/${f.branch}`), before, 'nothing was committed');
  return result.keep;
}

test('M11 a modules folder in the worktree\'s git metadata keeps the worktree: git would refuse to remove it', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    const admin = gitIn(f.path, 'rev-parse', '--path-format=absolute', '--git-dir');
    mkdirSync(join(admin, 'modules'));
    await keptFor(r, f, /submodule/i);
  } finally { cleanup(r, f); }
});

test('M12 a hidden or unmerged index entry keeps the worktree in any repository, with its own reason', async () => {
  for (const kind of ['assume-unchanged', 'skip-worktree'] as const) {
    for (const make of [plainRepo, repoWithSubmodule]) {
      const r = make(), f = finishedWorktree(r);
      try {
        gitIn(f.path, 'update-index', `--${kind}`, 'file.txt');
        writeFileSync(join(f.path, 'file.txt'), 'an edit git status would not show\n');
        const reason = await keptFor(r, f, /hidden|unmerged/i);
        assert.doesNotMatch(reason, /submodule/i, `${kind}: the reason names what was found`);
      } finally { cleanup(r, f); }
    }
  }
});

test('M13 a symlinked parent of the submodule path keeps the worktree', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    rmSync(join(f.path, 'lib'), { recursive: true });
    const elsewhere = join(f.root, 'elsewhere');
    mkdirSync(join(elsewhere, 'sub'), { recursive: true });
    symlinkSync(elsewhere, join(f.path, 'lib'));
    await keptFor(r, f, /submodule/i);
  } finally { cleanup(r, f); }
});

test('M14 a gitlink the builder removed and committed is saved, and prune removes the worktree', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  try {
    gitIn(f.path, 'rm', '-q', '--cached', 'lib/sub');
    gitIn(f.path, '-c', 'user.name=b', '-c', 'user.email=b@example.invalid', 'commit', '-qm', 'drop the submodule');
    const { report } = await prune(r, f);
    assert.equal(report.removed.length, 1, JSON.stringify(report));
    assert.equal(gitIn(r.dir, 'ls-tree', report.removed[0]!.commit, 'lib/sub'), '', 'the removal is in the saved commit');
  } finally { cleanup(r, f); }
});

test('M15 an unreadable submodule path keeps the worktree quietly: prune records it as kept, not failed', async () => {
  const r = repoWithSubmodule(), f = finishedWorktree(r);
  const at = join(f.path, 'lib', 'sub');
  try {
    writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    chmodSync(at, 0o000);
    await keptFor(r, f, /submodule/i);
  } finally { chmodSync(at, 0o755); cleanup(r, f); }
});

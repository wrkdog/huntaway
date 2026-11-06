// A clean worktree is not a saved change; keep the owned start separate from the save result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/runner.ts';
import { saveWorktree, pruneWorktrees } from '../src/disk.ts';
import { Store, type Workspace } from '../src/store.ts';
import { card } from '../src/cards.ts';
import { startPipe } from '../src/service.ts';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Server } from 'node:http';

function fixture(format: 'sha1' | 'sha256' = 'sha1') {
  const root = mkdtempSync(join(tmpdir(), 'pipe-save-origin-')), repo = join(root, 'repo'), trees = join(root, 'trees');
  mkdirSync(repo); mkdirSync(trees);
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(repo, 'init', '-q', '-b', 'main', `--object-format=${format}`);
  git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@localhost');
  writeFileSync(join(repo, 'file.txt'), 'seed\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'seed');
  const seed = git(repo, 'rev-parse', 'HEAD'), db = join(root, 'record.sqlite');
  let store = new Store(db);
  const request = store.submit({ requester: 'fixture', project: 'fixture', kind: 'code', provider: 'claude', model: 'opus',
    effort: 'high', reason: 'local save proof', prompt: 'inert fixture', mutating: true, priority: 'interactive', cwd: repo });
  const account = { id: 'fixture', provider: 'claude' as const, loginDir: root, fingerprint: '00000000', enabled: true, maxConcurrency: 1 };
  const claim = store.startAttempt(request.id, account, { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(),
    verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Edit'] });
  assert.ok(claim.ok);
  const path = join(trees, request.id), branch = `pipe/${request.id}`;
  const finish = (workspace: Workspace) => store.finishAttempt(claim.attempt.id, { kind: 'completed', result: 'OK', workspace });
  const make = (origin = true) => {
    git(repo, 'worktree', 'add', '-b', branch, path, seed);
    const workspace = { path, branch, commit: 'uncommitted', ...(origin ? { startCommit: seed } : {}) };
    store.noteWorkspace(claim.attempt.id, workspace); finish(workspace); return workspace;
  };
  const save = async () => {
    const result = await saveWorktree(store.get(request.id)!, trees, repo, env);
    assert.ok('commit' in result, JSON.stringify(result));
    store.recordWorkspaceCommit(request.id, result.commit, result.saved);
    return store.get(request.id)!.workspace!;
  };
  return { root, repo, trees, env, git, seed, request, claim, path, branch, make, save, finish,
    get store() { return store; },
    reopen() { store.close(); store = new Store(db); },
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const format of ['sha1', 'sha256'] as const) test(`unchanged ${format} run keeps its owned start through record, restart, save and prune`, async () => {
  const f = fixture(format);
  try {
    const cli = join(f.root, 'fake-claude.cjs');
    writeFileSync(cli, `#!${process.execPath}\nrequire('fs').readFileSync(0);\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK'}));\n`);
    chmodSync(cli, 0o755);
    let origin: string | undefined, completed = false;
    const failures: unknown[] = [];
    for await (const event of run({ requestId: f.request.id, accountId: 'fixture', provider: 'claude', model: 'opus', effort: 'high',
      prompt: 'inert fixture', mutating: true, cwd: f.repo, loginDir: f.root }, { cli: { claude: cli }, env: f.env, worktreeRoot: f.trees,
      onWorkspace: (w, start?: string) => { origin = start; f.store.noteWorkspace(f.claim.attempt.id,
        { ...w, commit: 'uncommitted', ...(origin ? { startCommit: origin } : {}) }); },
    })) {
      if (event.type === 'failed') failures.push(event);
      if (event.type === 'completed') {
        assert.ok(event.workspace); completed = true;
        f.finish({ ...event.workspace, commit: 'uncommitted', ...(origin ? { startCommit: origin } : {}) });
      }
    }
    assert.ok(completed, JSON.stringify(failures));
    f.reopen();
    const saved = await f.save();
    assert.equal(saved.saved, 'no_changes'); // RED on base: saved at the seed.
    assert.equal(origin, f.seed);
    assert.equal(saved.startCommit, f.seed);
    assert.equal(saved.commit, f.seed);
    const c = card(f.store.get(f.request.id)!, f.store.attempts(f.request.id), { alias: (id) => id, runnerAlive: () => false, draining: false });
    assert.deepEqual(c.saved, { state: 'no_changes', branch: f.branch, commit: null, diff: { files: 0, insertions: 0, deletions: 0 } });
    const report = await pruneWorktrees(f.store, f.trees, 0, () => {}, () => true, f.repo, f.env);
    assert.equal(report.removed.length, 1, JSON.stringify(report));
    assert.equal(f.store.get(f.request.id)!.workspace!.saved, 'no_changes');
    assert.equal(f.git(f.repo, 'rev-parse', f.branch), f.seed);
    assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), f.seed);
    assert.equal(existsSync(f.path), false);
  } finally { f.close(); }
});

test('an unreadable start with a gitlink quietly keeps the worktree on repeated saves', async () => {
  const f = fixture();
  try {
    f.make();
    f.git(f.path, 'update-index', '--add', '--cacheinfo', `160000,${f.seed},sub`);
    mkdirSync(join(f.path, 'sub'));
    writeFileSync(join(f.path, 'file.txt'), 'keep this edit\n');
    const request = f.store.get(f.request.id)!;
    request.workspace!.startCommit = 'f'.repeat(40);
    for (let pass = 0; pass < 2; pass++) {
      const result = await saveWorktree(request, f.trees, f.repo, f.env);
      assert.ok('keep' in result && /submodule/.test(result.keep), JSON.stringify(result));
      assert.equal(f.git(f.path, 'rev-parse', 'HEAD'), f.seed);
      assert.equal(readFileSync(join(f.path, 'file.txt'), 'utf8'), 'keep this edit\n');
    }
  } finally { f.close(); }
});

test('a clean legacy placeholder supplies no origin proof', async () => {
  const f = fixture();
  try { f.make(false); assert.equal((await f.save()).saved, 'unknown'); }
  finally { f.close(); }
});

for (const changed of [false, true]) test(`a refused/failed save retries with retained origin, changed=${changed}`, async () => {
  const f = fixture();
  try {
    f.make();
    if (changed) writeFileSync(join(f.path, 'file.txt'), 'changed\n');
    // Lose the record after a successful save: a later clean pass must identify the retained commit.
    const result = await saveWorktree(f.store.get(f.request.id)!, f.trees, f.repo, f.env);
    assert.ok('commit' in result);
    f.store.noteWorkspaceNotSaved(f.request.id); f.reopen();
    const saved = await f.save();
    assert.equal(saved.saved, changed ? 'saved' : 'no_changes');
    assert.equal(saved.commit, result.commit);
    assert.equal(saved.startCommit, f.seed);
    assert.equal((await f.save()).saved, saved.saved);
  } finally { f.close(); }
});

test('clean builder commits and previously recorded saves remain saved', async () => {
  const f = fixture();
  try {
    f.make(); writeFileSync(join(f.path, 'file.txt'), 'builder committed\n');
    f.git(f.path, 'add', '-A'); f.git(f.path, 'commit', '-qm', 'builder commit');
    const head = f.git(f.path, 'rev-parse', 'HEAD');
    assert.notEqual(head, f.seed);
    assert.equal((await f.save()).saved, 'saved');
    f.reopen(); assert.equal((await f.save()).saved, 'saved');
    assert.equal(f.store.get(f.request.id)!.workspace!.commit, head);
    assert.equal(f.git(f.repo, 'rev-list', '--count', `${f.seed}..${f.branch}`), '1');
  } finally { f.close(); }
});

test('manual-save refusals retain the seed, work and branch without executing a filter', async () => {
  const f = fixture();
  try {
    f.make(); writeFileSync(join(f.path, 'file.txt'), 'manual\n');
    f.git(f.repo, 'config', 'filter.denied.clean', 'exit 99');
    writeFileSync(join(f.repo, '.git', 'info', 'attributes'), 'file.txt filter=denied\n');
    const result = await saveWorktree(f.store.get(f.request.id)!, f.trees, f.repo, f.env);
    assert.ok('keep' in result && /clean filter/.test(result.keep));
    f.store.noteWorkspaceNotSaved(f.request.id);
    assert.equal(f.store.get(f.request.id)!.workspace!.saved, 'not_saved');
    assert.equal(readFileSync(join(f.path, 'file.txt'), 'utf8'), 'manual\n');
    assert.equal(f.git(f.repo, 'rev-parse', f.branch), f.seed);
  } finally { f.close(); }
});

test('origin hashes are exact and malformed outcomes cannot close the attempt', () => {
  const f = fixture();
  try {
    for (const startCommit of [f.seed.slice(0, 7), 'HEAD', f.seed.toUpperCase(), '', null, 42]) {
      assert.throws(() => f.finish({ path: f.path, branch: f.branch, commit: 'uncommitted', startCommit } as Workspace));
      assert.equal(f.store.attempts(f.request.id)[0]!.endedAt, null);
    }
  } finally { f.close(); }
});

test('a later owner HEAD does not replace the worktree origin', async () => {
  const f = fixture();
  try {
    f.make();
    writeFileSync(join(f.repo, 'file.txt'), 'later owner work\n');
    f.git(f.repo, 'add', '-A'); f.git(f.repo, 'commit', '-qm', 'owner advanced');
    const ownerHead = f.git(f.repo, 'rev-parse', 'HEAD');
    assert.notEqual(ownerHead, f.seed);
    const saved = await f.save();
    assert.equal(saved.saved, 'no_changes');
    assert.equal(saved.startCommit, f.seed);
    assert.equal(saved.commit, f.seed);
    assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), ownerHead);
  } finally { f.close(); }
});

test('a staged edit restored in the worktree creates no empty save commit', async () => {
  const f = fixture();
  try {
    f.make(); writeFileSync(join(f.path, 'file.txt'), 'staged only\n'); f.git(f.path, 'add', '-A');
    writeFileSync(join(f.path, 'file.txt'), 'seed\n');
    const saved = await f.save();
    assert.equal(saved.saved, 'no_changes');
    assert.equal(saved.commit, f.seed);
    assert.equal(f.git(f.repo, 'rev-parse', f.branch), f.seed);
    assert.equal(f.git(f.path, 'status', '--porcelain'), '');
  } finally { f.close(); }
});

test('the service persists the owned origin before the fake CLI, then records no_changes on completion', async (t) => {
  // Only HTTP binding is inert; probe, runner, completion and record paths are real with local fake CLIs.
  t.mock.method(Server.prototype, 'listen', function(this: Server, ...args: unknown[]) {
    queueMicrotask(() => (args.at(-1) as () => void)()); return this;
  });
  t.mock.method(Server.prototype, 'address', () => ({ port: 1, address: '127.0.0.1', family: 'IPv4' }));
  t.mock.method(Server.prototype, 'close', function(this: Server, cb?: () => void) { queueMicrotask(() => cb?.()); return this; });
  const f = fixture();
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  try {
    f.store.finishAttempt(f.claim.attempt.id, { kind: 'completed', result: 'fixture setup only' });
    const cli = join(f.root, 'fake-claude.cjs');
    const auth = JSON.parse(readFileSync(new URL('./fixtures/u4/claude-auth-status.signed-in.json', import.meta.url), 'utf8')).stdout;
    writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
if (a[0] === '--version') console.log('2.1.80 (Claude Code)');
else if (a[0] === 'auth') console.log(JSON.stringify(${JSON.stringify(auth)}));
else if (a[0] === '-p' && a[1] === '/usage') {
  const at = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(new Date(ms)).map(x => [x.type,x.value])); return p.month+' '+p.day+' at '+p.hour+':'+p.minute+p.dayPeriod.toLowerCase(); };
  console.log(JSON.stringify({type:'result',is_error:false,num_turns:0,total_cost_usd:0,duration_api_ms:0,result:'Current session: 16% used · resets '+at(Date.now()+3600000)+' (America/New_York)\\nCurrent week (all models): 16% used · resets '+at(Date.now()+86400000)+' (America/New_York)'}));
} else {
  fs.readFileSync(0);
  const db = new (require('node:sqlite').DatabaseSync)(path.join(__dirname,'record.sqlite'), {readOnly:true});
  const w = db.prepare('SELECT workspace FROM requests WHERE id = ?').get(path.basename(process.cwd()));
  db.close(); fs.writeFileSync(path.join(__dirname,'before-prompt.json'), w.workspace);
  console.log(JSON.stringify({type:'system',subtype:'init',model:'opus',session_id:'fixture'}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'OK'}));
}
`);
    chmodSync(cli, 0o755);
    pipe = await startPipe({ accounts: [{ id: 'fixture', provider: 'claude', loginDir: f.root,
      fingerprint: createHash('sha256').update('<orgId>').digest('hex').slice(0, 8), enabled: true, maxConcurrency: 1 }],
      policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      storePath: join(f.root, 'record.sqlite'), worktreeRoot: f.trees, cli: { claude: cli }, env: f.env,
      token: 'local-fixture-token-00000000000000000000', port: 0, reachable: async () => true, tickMs: 25, minFreeGb: 0 });
    const job = f.store.submit({ requester: 'fixture', project: 'fixture', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
      reason: 'test completion save', prompt: 'inert fixture', mutating: true, priority: 'interactive', cwd: f.repo });
    const deadline = Date.now() + 10_000;
    while (!f.store.get(job.id)?.workspace?.saved && Date.now() < deadline) await sleep(25);
    const after = f.store.get(job.id)!;
    assert.equal(after.workspace?.saved, 'no_changes', JSON.stringify(after));
    const before = JSON.parse(readFileSync(join(f.root, 'before-prompt.json'), 'utf8'));
    assert.equal(before.startCommit, f.seed);
    assert.equal(before.commit, 'uncommitted');
    assert.equal(after.workspace.commit, f.seed);
    assert.equal(f.git(f.repo, 'rev-parse', after.workspace.branch), f.seed);
  } finally { await pipe?.stop(); f.close(); }
});

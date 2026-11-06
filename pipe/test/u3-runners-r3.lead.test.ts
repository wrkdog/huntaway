/**
 * Acceptance grader, lane U3 round 3 (lead-authored), from the round-2 reviews of 4cdb630. Gemini
 * and a fresh Anthropic seat both approved. The Anthropic seat's four minors are fixed here,
 * tests first:
 *   R10  a limit whose service names no bucket says so (bucket null), instead of the made-up
 *        'unknown' that no probe reading could ever clear (U1 now holds and clears it);
 *   R11  a reachability probe that throws or rejects still ends the run with one terminal event;
 *   R12  quota wording is tied to allowance terms: token, turn, recursion or disk limits are not
 *        an exhausted allowance;
 *   R13  a worktree whose creation failed half-way leaves no branch or worktree behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunEvent, type RunOptions, type RunSpec } from '../src/runner.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8').split('\n').filter((l) => l.trim() !== '');
type Step = { line?: string; stderr?: string };
function fakeCli(steps: Step[], exitCode = 0) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-cli-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps, exitCode }));
  const script = join(dir, 'cli');
  writeFileSync(script, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
try { fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(path.join(__dirname, 'record-' + process.pid + '.json'), JSON.stringify({ argv: process.argv.slice(2) }));
for (const s of sc.steps) { if (s.line !== undefined) process.stdout.write(s.line + '\\n'); if (s.stderr !== undefined) process.stderr.write(s.stderr + '\\n'); }
process.exit(sc.exitCode);
`);
  chmodSync(script, 0o755);
  return { path: script, runs: () => readdirSync(dir).filter((f) => f.startsWith('record-')).length };
}
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lead@example.invalid');
  git('config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}
const branches = (dir: string) => execFileSync('git', ['-C', dir, 'branch', '--list', '--format=%(refname:short)', 'pipe/*'], { encoding: 'utf8' }).trim();
const worktrees = (dir: string) => execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).length;
const spec = (over: Partial<RunSpec> = {}): RunSpec => ({
  requestId: `req-${Math.random().toString(36).slice(2, 10)}`, accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
  prompt: 'say OK', mutating: false, cwd: realpathSync(tmpdir()), loginDir: realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-login-'))), ...over,
});
const opts = (over: Partial<RunOptions> & { claude?: string; codex?: string } = {}): RunOptions => {
  const { claude, codex, ...rest } = over;
  return { cli: { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }, reachable: async () => false, ...rest };
};
async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
function terminalOf(events: RunEvent[]): RunEvent {
  const terminals = events.filter((e) => e.type === 'completed' || e.type === 'failed');
  assert.equal(terminals.length, 1, `exactly one terminal event: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(events.at(-1), terminals[0]);
  return terminals[0]!;
}
const kindOf = (e: RunEvent) => (e.type === 'failed' ? e.errorKind : e.type);
/**
 * The pipe runs git as `git -c <option>… -C <repo> <subcommand> …` (U12). A wrapper's `view` skips the `-c` pairs, so
 * C is the repository, SUB the subcommand and A4-A6 the words after it; the real git still gets every argument.
 */
const VIEW = 'view() { while [ "$1" = -c ]; do shift 2; done; C="$2"; SUB="$3"; A4="$4"; A5="$5"; A6="$6"; }\nview "$@"\n';
/** A git on PATH that runs the real `worktree add`, then `after` (the worktree is $A5), then fails, as a hook would. */
function failAfterAdd(after: string): NodeJS.ProcessEnv {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-gitwrap-')));
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${VIEW}if [ "$SUB" = worktree ] && [ "$A4" = add ]; then "${realGit}" "$@"; ${after}\n  exit 1\nfi\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' };
}
const INIT = fixture('claude-success.jsonl')[0]!;
const codexFails = (message: string) => [
  { line: '{"type":"thread.started","thread_id":"t-1"}' },
  { line: JSON.stringify({ type: 'error', message }) },
  { line: JSON.stringify({ type: 'turn.failed', error: { message } }) },
];

test('R10 a limit whose service names no bucket carries bucket null, never a made-up name', async () => {
  const codex = fakeCli(fixture('codex-usage-limit.jsonl').map((line) => ({ line })), 1);
  const limits = (await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol', accountId: 'codex-a' }), opts({ codex: codex.path })))).filter((e) => e.type === 'limit');
  assert.equal(limits.length, 1);
  assert.equal(limits[0]!.type === 'limit' ? limits[0]!.bucket : 'x', null, 'Codex names no bucket');
  const unnamed = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000 } });
  const claude = fakeCli([{ line: INIT }, { line: unnamed }], 1);
  const climits = (await collect(run(spec(), opts({ claude: claude.path })))).filter((e) => e.type === 'limit');
  assert.equal(climits[0]?.type === 'limit' ? climits[0]!.bucket : 'x', null, 'a Claude limit without rateLimitType names no bucket');
});

test('R11 a reachability probe that throws or rejects still ends the run with one terminal event, as offline', async () => {
  for (const reachable of [async () => { throw new Error('probe broke'); }, () => Promise.reject(new Error('rejected')), (() => { throw new Error('sync throw'); }) as never]) {
    const cli = fakeCli([{ line: 'Not logged in · Please run /login' }], 1);
    assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: cli.path, reachable }))))), 'offline');
  }
});

test('R12 quota wording is tied to allowance terms: token, turn, recursion or disk limits are not an exhausted allowance', async () => {
  const notQuota = ['Error: reached the token limit for this request', 'hit the max_tokens limit', 'Error: reached the turn limit',
    'hit the recursion limit', 'Disk quota exceeded', 'reached the context limit'];
  for (const said of notQuota) {
    const claude = fakeCli([{ line: INIT }, { stderr: said }], 1);
    // U8: a full or over-quota disk is its own temporary kind, disk_full; it is still never an allowance.
    assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: claude.path }))))), /disk/i.test(said) ? 'disk_full' : 'other', `claude: ${said}`);
    const codex = fakeCli(codexFails(said), 1);
    const events = await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol', accountId: 'codex-a' }), opts({ codex: codex.path })));
    assert.equal(events.filter((e) => e.type === 'limit').length, 0, `codex: no limit for ${said}`);
    assert.notEqual(kindOf(terminalOf(events)), 'quota_exhausted', `codex: ${said}`);
  }
  const quota = ["You've hit your usage limit", 'you have reached your weekly limit', "You've reached your 5-hour limit", 'Error: insufficient_quota', 'You are out of credits'];
  for (const said of quota) {
    const claude = fakeCli([{ line: INIT }, { stderr: said }], 1);
    assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: claude.path }))))), 'quota_exhausted', said);
  }
});

test('R13 a worktree whose creation failed half-way leaves no branch or worktree behind', async () => {
  const origin = repo();
  const env = failAfterAdd('');   // git has made the branch and the worktree when this fails
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const done = terminalOf(await collect(run(spec({ mutating: true, cwd: origin }), opts({ claude: cli.path, worktreeRoot, env }))));
  assert.equal(kindOf(done), 'other');
  assert.equal(cli.runs(), 0, 'the CLI never starts');
  assert.equal(branches(origin), '', 'the half-made branch is removed');
  assert.equal(worktrees(origin), 1, 'and so is the half-made worktree');
});

test('R13b when git leaves a branch but no worktree, the branch is still removed', async () => {
  const origin = repo();
  const env = failAfterAdd('rm -rf "$A5"');   // the worktree folder is gone; its branch remains
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const done = terminalOf(await collect(run(spec({ mutating: true, cwd: origin }), opts({ claude: cli.path, worktreeRoot, env }))));
  assert.equal(kindOf(done), 'other');
  assert.equal(branches(origin), '', 'removing a missing worktree fails, but the branch is still removed');
});

test('R14 a request that already has a branch or worktree is refused, and what exists is kept (L9)', async () => {
  const origin = repo();
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const s = spec({ mutating: true, cwd: origin });
  // An earlier attempt's work, kept for inspection: its branch and worktree, with a change in it.
  execFileSync('git', ['-C', origin, 'worktree', 'add', '-b', `pipe/${s.requestId}`, join(worktreeRoot, s.requestId), 'HEAD'], { stdio: 'pipe' });
  writeFileSync(join(worktreeRoot, s.requestId, 'KEPT.md'), 'earlier work\n');
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const done = terminalOf(await collect(run(s, opts({ claude: cli.path, worktreeRoot }))));
  assert.equal(kindOf(done), 'other');
  assert.equal(cli.runs(), 0, 'the CLI never starts');
  assert.equal(branches(origin), `pipe/${s.requestId}`, 'the earlier branch is kept');
  assert.equal(readFileSync(join(worktreeRoot, s.requestId, 'KEPT.md'), 'utf8'), 'earlier work\n', 'and so is its work');
  const onlyBranch = repo();
  const t = spec({ mutating: true, cwd: onlyBranch });
  execFileSync('git', ['-C', onlyBranch, 'branch', `pipe/${t.requestId}`], { stdio: 'pipe' });
  const again = terminalOf(await collect(run(t, opts({ claude: cli.path, worktreeRoot }))));
  assert.equal(kindOf(again), 'other');
  assert.equal(branches(onlyBranch), `pipe/${t.requestId}`, 'a branch alone is kept too');
});

test('R13c when git has this run\'s branch but cannot make the worktree, the branch and the claimed folder are removed', async () => {
  const origin = repo();
  const admin = join(origin, '.git', 'worktrees');
  mkdirSync(admin, { recursive: true });
  chmodSync(admin, 0o555);   // `git worktree add` cannot record the worktree, after `git branch` made the branch
  try {
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
    const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
    const done = terminalOf(await collect(run(spec({ mutating: true, cwd: origin }), opts({ claude: cli.path, worktreeRoot }))));
    assert.equal(kindOf(done), 'other');
    assert.match(JSON.stringify(done), /could not create the worktree/u, 'it got as far as the worktree, not refused early');
    assert.equal(cli.runs(), 0);
    assert.equal(branches(origin), '', 'the branch this run made is removed');
    assert.deepEqual(readdirSync(worktreeRoot), [], 'and so is the folder it claimed');
  } finally {
    if (existsSync(admin)) chmodSync(admin, 0o755);   // prune removes it once empty
  }
});

// Added after the Anthropic seat's review of 5d13461 (round 3 minors).

test('R15 a reachability probe that never settles is bounded: the run still ends, as offline', async () => {
  const cli = fakeCli([{ line: 'Not logged in · Please run /login' }], 1);
  const started = Date.now();
  const done = terminalOf(await collect(run(spec(), opts({ claude: cli.path, reachable: () => new Promise<boolean>(() => {}) }))));
  assert.equal(kindOf(done), 'offline');
  assert.ok(Date.now() - started < 10_000, 'bounded, not a hang');
});

test('R16 when git cannot say whether the branch exists, nothing is made', async () => {
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-notrepo-')));
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const done = terminalOf(await collect(run(spec({ mutating: true, cwd: notRepo }), opts({ claude: cli.path, worktreeRoot }))));
  assert.equal(kindOf(done), 'other');
  // Refused before git is asked to make anything: a failed add is cleaned up with `branch -D`,
  // which would delete an earlier attempt's branch that git merely could not see (L9).
  assert.match(JSON.stringify(done), /could not tell whether pipe\/[^ ]+ exists/u);
  assert.equal(cli.runs(), 0);
  assert.deepEqual(readdirSync(worktreeRoot), [], 'no folder was claimed');
});

test('R17 an existing empty folder at the worktree path is someone else\'s: refused and kept', async () => {
  const origin = repo();
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const s = spec({ mutating: true, cwd: origin });
  mkdirSync(join(worktreeRoot, s.requestId));
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const done = terminalOf(await collect(run(s, opts({ claude: cli.path, worktreeRoot }))));
  assert.equal(kindOf(done), 'other');
  assert.match(JSON.stringify(done), /something already exists at /u);
  assert.equal((done as { workspace?: { path?: string } | null }).workspace?.path, join(worktreeRoot, s.requestId), 'the refusal says where to look');
  assert.equal(cli.runs(), 0);
  assert.ok(existsSync(join(worktreeRoot, s.requestId)), 'the folder is kept');
  assert.equal(branches(origin), '', 'no branch was made');
});

// Added after the Anthropic seat's review of 3a5043e (batch minors).

test('R18 a branch someone else makes after the check is theirs: kept, and only the claimed folder is removed (L9)', async () => {
  const origin = repo();
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-gitwrap-')));
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  // Another actor creates the branch in the window between the run's check and its `git branch`.
  // (The run makes its branch at an exact commit: \`git -C <repo> branch <name> <commit>\`.)
  writeFileSync(join(bin, 'git'), `#!/bin/sh\n${VIEW}if [ "$SUB" = branch ] && [ -n "$A5" ]; then "${realGit}" "$@" >/dev/null 2>&1; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const s = spec({ mutating: true, cwd: origin });
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const done = terminalOf(await collect(run(s, opts({ claude: cli.path, worktreeRoot,
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' } }))));
  assert.equal(kindOf(done), 'other');
  assert.match(JSON.stringify(done), /could not create pipe\//u);
  assert.equal(cli.runs(), 0);
  assert.equal(branches(origin), `pipe/${s.requestId}`, 'the other actor\'s branch is kept');
  assert.deepEqual(readdirSync(worktreeRoot), [], 'the run removed only its own claim');
});

test('R19 a worktreeRoot that cannot be used ends the run with one failed event, not a throw', async () => {
  const notAFolder = join(realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-file-'))), 'root');
  writeFileSync(notAFolder, 'a file where the worktree root should be\n');
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const events = await collect(run(spec({ mutating: true, cwd: repo() }), opts({ claude: cli.path, worktreeRoot: notAFolder })));
  assert.equal(events.length, 1);
  assert.equal(kindOf(terminalOf(events)), 'other');
  assert.match(JSON.stringify(events[0]), /could not use the worktreeRoot/u);
  assert.equal(cli.runs(), 0);
});

test('R20 cleanup that removed its own worktree prunes nothing: another checkout\'s record on a missing volume survives', async () => {
  const origin = repo();
  const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-volume-'))), 'other');
  execFileSync('git', ['-C', origin, 'worktree', 'add', '-b', 'someone-else', elsewhere, 'HEAD'], { stdio: 'pipe' });
  rmSync(elsewhere, { recursive: true, force: true });   // its volume is unmounted: the record stays, the folder is gone
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  // The worktree is made, then the CLI cannot start, so the unused worktree is discarded.
  const done = terminalOf(await collect(run(spec({ mutating: true, cwd: origin }), opts({ claude: join(worktreeRoot, 'no-such-cli'), worktreeRoot }))));
  assert.equal(kindOf(done), 'other');
  assert.deepEqual(readdirSync(worktreeRoot), [], 'the run\'s own worktree is gone');
  const list = execFileSync('git', ['-C', origin, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  assert.match(list, new RegExp(`worktree ${elsewhere.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'the other record was not pruned');
});

// Added after Sol 6's review of b203298 (U4 round 1).

test('R21 cleanup deletes only the commit this run made its branch at: a branch replaced since is kept (L9)', async () => {
  const origin = repo();
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-gitwrap-')));
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  // Between the run's `git branch` and its worktree, another actor moves the branch, then the add fails.
  writeFileSync(join(bin, 'git'), `#!/bin/sh
${VIEW}if [ "$SUB" = worktree ] && [ "$A4" = add ]; then
  other=$("${realGit}" -C "$C" commit-tree "HEAD^{tree}" -p HEAD -m "someone else's work")
  "${realGit}" -C "$C" update-ref "refs/heads/$A6" "$other"
  echo "$other" > "${bin}/other"
  exit 1
fi
exec "${realGit}" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const s = spec({ mutating: true, cwd: origin });
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const done = terminalOf(await collect(run(s, opts({ claude: cli.path, worktreeRoot,
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' } }))));
  assert.equal(kindOf(done), 'other');
  assert.equal(cli.runs(), 0);
  const other = readFileSync(join(bin, 'other'), 'utf8').trim();
  const now = execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/pipe/${s.requestId}`], { encoding: 'utf8' }).trim();
  assert.equal(now, other, 'the other actor\'s branch is kept, at their commit');
});

test('R22 the branch is made at a commit read beforehand: a move right after creation is never taken for the run\'s own', async () => {
  const origin = repo();
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-worktrees-')));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r3-gitwrap-')));
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  // Right after the run creates its branch, another actor moves it; then the worktree add fails.
  writeFileSync(join(bin, 'git'), `#!/bin/sh
${VIEW}if [ "$SUB" = branch ] && [ -n "$A5" ]; then
  "${realGit}" "$@" || exit $?
  other=$("${realGit}" -C "$C" commit-tree "HEAD^{tree}" -p HEAD -m "someone else's work")
  "${realGit}" -C "$C" update-ref "refs/heads/$A4" "$other"
  echo "$other" > "${bin}/other"
  exit 0
fi
if [ "$SUB" = worktree ] && [ "$A4" = add ]; then exit 1; fi
exec "${realGit}" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const s = spec({ mutating: true, cwd: origin });
  const cli = fakeCli(fixture('claude-success.jsonl').map((line) => ({ line })));
  const done = terminalOf(await collect(run(s, opts({ claude: cli.path, worktreeRoot,
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' } }))));
  assert.equal(kindOf(done), 'other');
  const other = readFileSync(join(bin, 'other'), 'utf8').trim();
  assert.equal(execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/pipe/${s.requestId}`], { encoding: 'utf8' }).trim(), other);
});

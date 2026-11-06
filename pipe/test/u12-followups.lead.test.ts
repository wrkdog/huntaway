/**
 * Acceptance grader, lane U12: follow-ups from the U8, U9 and U11 reviews (lead-authored; the implementation
 * lane must not edit it).
 *
 * The prune's git (U8) runs in its own process group with a deadline, and answers only after its output closes. The
 * runner's own git does not: worktree setup, the untouched check and `discard` wait on git for as long as it runs, so a
 * hung fsmonitor, hook or filter holds an attempt, and a stop, forever. Every git command the pipe runs itself gets the
 * same runner: a deadline, the attempt's abort signal, and no repository hooks or fsmonitor. A git that is stopped or
 * times out gives no answer, so a check it was part of is not proved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunEvent, type RunOptions, type RunSpec } from '../src/runner.ts';
import { startPipe } from '../src/service.ts';
import { createHash } from 'node:crypto';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIX), 'utf8').split('\n').filter((l) => l.trim() !== '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INIT = (() => { const o = JSON.parse(fixture('claude-success.jsonl')[0]!); o.model = 'opus'; return JSON.stringify(o); })();
const SIGN_IN = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's-1',
  errors: [{ message: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }] });
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lead@example.invalid');
  git('config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}
/** A fake Claude CLI that prints the given lines and exits 1; it leaves a marker when it runs. */
function fakeCli(lines: string[]): { cli: string; ran: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-cli-')));
  const ran = join(dir, 'ran');
  writeFileSync(join(dir, 'cli'), `#!${process.execPath}
require('fs').writeFileSync(${JSON.stringify(ran)}, '');
try { require('fs').readFileSync(0, 'utf8'); } catch {}
for (const l of ${JSON.stringify(lines)}) process.stdout.write(l + String.fromCharCode(10));
process.exitCode = 1;
`);
  chmodSync(join(dir, 'cli'), 0o755);
  return { cli: join(dir, 'cli'), ran };
}
/**
 * A git on PATH that hangs, ignoring SIGTERM, when its arguments contain `match`; every other call runs the real git.
 * The hanging shell writes its pid, which leads its process group when the pipe starts git in a group of its own.
 */
function hangingGit(match: string): { path: string; pidFile: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-git-')));
  const pidFile = join(dir, 'hung.pid');
  writeFileSync(join(dir, 'git'), `#!/bin/sh
case " $* " in *"${match}"*) echo $$ > "${pidFile}"; trap '' TERM; sleep 600 & echo $! > "${pidFile}.child"; wait; exit 1 ;; esac
exec "${REAL_GIT}" "$@"
`);
  chmodSync(join(dir, 'git'), 0o755);
  return { path: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, pidFile };
}
function changing(cwd: string): { spec: RunSpec; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-wt-')));
  return { root, spec: {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`, accountId: 'claude-a', provider: 'claude',
    model: 'opus', effort: 'high', prompt: 'change the readme', mutating: true, cwd,
    loginDir: realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-login-'))),
  } };
}
/**
 * `gitTimeoutMs` is the runner's deadline for each git command it runs. The tests shorten it, but not below what ordinary
 * setup git needs on a loaded machine: it bounds every command, not only the hanging one.
 */
const opts = (cli: string, path: string, worktreeRoot: string, extra: Record<string, unknown> = {}): RunOptions => ({
  cli: { claude: cli }, env: { PATH: path, HOME: process.env.HOME ?? '/tmp' }, worktreeRoot,
  reachable: async () => true, killGraceMs: 500, ...extra,
} as RunOptions);
async function terminal(events: AsyncIterable<RunEvent>): Promise<Extract<RunEvent, { type: 'completed' | 'failed' }>> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  const ends = out.filter((e) => e.type === 'completed' || e.type === 'failed');
  assert.equal(ends.length, 1, JSON.stringify(out.map((e) => e.type)));
  return ends[0] as Extract<RunEvent, { type: 'completed' | 'failed' }>;
}
/** Whether any process is left in the group the hung git led: a signal-0 probe finds no member. */
async function groupGone(pidFile: string): Promise<boolean> {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  for (let i = 0; i < 60; i++) {
    try { process.kill(-pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    await sleep(50);
  }
  return false;
}
/** Ends a hung git the pipe left behind (a failing run only): the exact recorded processes, never a pattern. */
function reap(pidFile: string): void {
  for (const file of [pidFile, `${pidFile}.child`]) {
    if (!existsSync(file)) continue;
    try { process.kill(Number(readFileSync(file, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
  }
}
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

// ---- Item 3: the filter overrides, on this machine's git ----------------------------------------------------------

test('F1 the prune\'s filter overrides make a configured clean, smudge and process driver inert', async () => {
  const disk = await import('../src/disk.ts') as Record<string, unknown>;
  assert.equal(typeof disk.noFilters, 'function', 'src/disk.ts exports noFilters, so its overrides can be checked here');
  const noFilters = disk.noFilters as (cwd: string, env: NodeJS.ProcessEnv) => Promise<string[]>;
  const dir = repo();
  const marks = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-filter-')));
  const driver = (kind: string, body: string) => {
    const path = join(marks, `${kind}.sh`);
    writeFileSync(path, `#!/bin/sh\ntouch "${join(marks, `${kind}-ran`)}"\n${body}\n`);
    chmodSync(path, 0o755);
    return `"${path}"`;   // git runs filter commands through the shell, and test folders may contain spaces
  };
  writeFileSync(join(dir, 'a.txt'), 'plain\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'a file before any filter']);
  const config = (key: string, value: string) => execFileSync('git', ['-C', dir, 'config', key, value]);
  config('filter.x.clean', driver('clean', 'tr a-z A-Z'));
  config('filter.x.smudge', driver('smudge', 'cat'));
  config('filter.x.required', 'true');
  config('filter.p.process', driver('process', 'exit 1'));
  config('filter.p.required', 'true');
  writeFileSync(join(dir, '.git', 'info', 'attributes'), 'a.txt filter=x\nb.txt filter=p\n');
  writeFileSync(join(dir, 'a.txt'), 'edit!\n');   // the same size, so git must read the content
  writeFileSync(join(dir, 'b.txt'), 'new\n');
  const nf = await noFilters(dir, { PATH: process.env.PATH, HOME: process.env.HOME });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...nf, ...args], { encoding: 'utf8' });
  git('status', '--porcelain');
  git('add', '-A');
  assert.equal(git('show', ':a.txt'), 'edit!\n', 'the staged content is the file as written, not cleaned');
  git('commit', '-q', '-m', 'saved with the overrides');
  unlinkSync(join(dir, 'a.txt'));
  git('checkout', 'HEAD', '--', 'a.txt');
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'edit!\n', 'the checked-out file is the blob, not smudged');
  for (const kind of ['clean', 'smudge', 'process']) assert.ok(!existsSync(join(marks, `${kind}-ran`)), `no ${kind} driver ran`);
});

// ---- Item 1: the runner's own git has a deadline and stops with the attempt ----------------------------------------

test('F2 a runner git that hangs past its deadline ends the attempt, and its whole process group is gone', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const git = hangingGit(' worktree add ');
  try {
    const cli = fakeCli([INIT, SIGN_IN]);
    const end = await within(30_000, 'the attempt', terminal(run(spec, opts(cli.cli, git.path, root, { gitTimeoutMs: 4_000 }))));
    assert.equal(end.type, 'failed');
    assert.ok(existsSync(git.pidFile), 'the hanging git was the one used');
    assert.ok(await groupGone(git.pidFile), 'the timed-out git and everything it started are gone');
    assert.ok(!existsSync(cli.ran), 'the CLI never ran');
  } finally { reap(git.pidFile); }
});

test('F3 a stop during a hung runner git ends the attempt promptly, and the git\'s group is gone', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const git = hangingGit(' worktree add ');
  try {
    const cli = fakeCli([INIT, SIGN_IN]);
    const stop = new AbortController();
    const ending = terminal(run(spec, opts(cli.cli, git.path, root, { signal: stop.signal })));
    for (let i = 0; i < 200 && !existsSync(git.pidFile); i++) await sleep(25);
    assert.ok(existsSync(git.pidFile), 'the hanging git was the one used');
    stop.abort();
    const end = await within(8_000, 'the stopped attempt', ending);
    assert.equal(end.type, 'failed');
    assert.ok(await groupGone(git.pidFile), 'the stopped git and everything it started are gone');
    assert.ok(!existsSync(cli.ran), 'the CLI never ran');
  } finally { reap(git.pidFile); }
});

test('F4 a hung git in the untouched check proves nothing: the worktree is kept, and the run still ends', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  // Only the untouched check asks for ignored files; setup and the CLI run normally, then the check hangs.
  const git = hangingGit(' --ignored');
  try {
    const cli = fakeCli([INIT, SIGN_IN]);
    const end = await within(30_000, 'the attempt', terminal(run(spec, opts(cli.cli, git.path, root, { gitTimeoutMs: 4_000 }))));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(existsSync(cli.ran), 'the CLI ran');
    assert.equal(end.errorKind, 'auth', end.message);
    assert.ok(existsSync(git.pidFile), 'the check reached the hanging git');
    assert.ok(end.workspace, 'a check that timed out is not proof: the worktree is kept, and the work is never re-run');
    assert.ok(existsSync(end.workspace.path));
    assert.ok(await groupGone(git.pidFile), 'the timed-out git is gone');
  } finally { reap(git.pidFile); }
});

// ---- Round 2 (Sol on 6b13357) -----------------------------------------------------------------------------------

test('F5 a git deadline beyond what a timer can hold is refused, never turned into an instant timeout', async () => {
  const work = repo();
  for (const gitTimeoutMs of [2_147_483_648, 0, -1, 1.5]) {
    const { spec, root } = changing(work);
    const cli = fakeCli([INIT, SIGN_IN]);
    const end = await terminal(run(spec, opts(cli.cli, process.env.PATH ?? '/usr/bin:/bin', root, { gitTimeoutMs })));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') continue;
    assert.equal(end.errorKind, 'other', `${gitTimeoutMs}: ${end.message}`);
    assert.match(end.message, /gitTimeoutMs/, `${gitTimeoutMs}: the refusal names the option`);
    assert.ok(!existsSync(cli.ran), `${gitTimeoutMs}: nothing ran`);
  }
  // The largest a timer can hold is accepted.
  const { spec, root } = changing(work);
  const cli = fakeCli([INIT, SIGN_IN]);
  const end = await terminal(run(spec, opts(cli.cli, process.env.PATH ?? '/usr/bin:/bin', root, { gitTimeoutMs: 2_147_483_647 })));
  assert.ok(existsSync(cli.ran), `the largest timer value is a valid deadline: ${JSON.stringify(end)}`);
});

// ---- Round 3 (Sol on a48166d) -----------------------------------------------------------------------------------

test('F6 a git that exits while something still holds its output gives no answer: a branch check it made proves nothing', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  // The branch check exits 1 ("no such branch"), but a descendant keeps its output open past the grace.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-git-')));
  const held = join(dir, 'held.pid');
  writeFileSync(join(dir, 'git'), `#!/bin/sh
case " $* " in *" rev-parse --verify --quiet refs/heads/pipe/"*) /bin/sleep 6 & echo $! > "${held}"; exit 1 ;; esac
exec "${REAL_GIT}" "$@"
`);
  chmodSync(join(dir, 'git'), 0o755);
  const cli = fakeCli([INIT, SIGN_IN]);
  try {
    const end = await within(30_000, 'the attempt', terminal(run(spec, opts(cli.cli, `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, root))));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(existsSync(held), 'the held branch check was the one used');
    assert.match(end.message, /could not tell/, `an unfinished answer is not "no branch": ${end.message}`);
    assert.ok(!existsSync(cli.ran), 'nothing is made, and the CLI never runs');
    // The grace ends everything still holding git's output, so nothing of that git is left running (round 4).
    const pid = Number(readFileSync(held, 'utf8').trim());
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await sleep(50); } catch { alive = false; } }
    assert.ok(!alive, 'the descendant holding the output was stopped');
  } finally {
    if (existsSync(held)) { try { process.kill(Number(readFileSync(held, 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ } }
  }
});

// ---- Round 4 (Sol on 64c4342) -----------------------------------------------------------------------------------

test('F7 what git writes to stderr between its exit and its output closing still classifies the failure', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  // The worktree add exits 1 at once; its full-disk message arrives on stderr a moment later, before the output closes.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-git-')));
  writeFileSync(join(dir, 'git'), `#!/bin/sh
case " $* " in *" worktree add "*) ( /bin/sleep 0.3; echo "fatal: could not write index: No space left on device" >&2 ) & exit 1 ;; esac
exec "${REAL_GIT}" "$@"
`);
  chmodSync(join(dir, 'git'), 0o755);
  const cli = fakeCli([INIT, SIGN_IN]);
  const end = await within(30_000, 'the attempt', terminal(run(spec, opts(cli.cli, `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, root))));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'disk_full', `the late stderr counts: ${end.message}`);
  assert.ok(!existsSync(cli.ran), 'the CLI never ran');
});

// ---- Round 5 (Sol on 5e35750) -----------------------------------------------------------------------------------

test('F8 a git that has settled never signals its process group afterwards', async () => {
  const { runGit } = await import('../src/disk.ts');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-git-')));
  const bystander = join(dir, 'bystander.pid');
  // git succeeds at once, leaving a child in its group that has let go of git's output (as a daemon would).
  writeFileSync(join(dir, 'git'), `#!/bin/sh
( exec </dev/null >/dev/null 2>&1; /bin/sleep 6 ) & echo $! > "${bystander}"
exit 0
`);
  chmodSync(join(dir, 'git'), 0o755);
  try {
    await runGit(dir, ['status'], { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' });
    await sleep(3_000);   // past the output grace and a stop's escalation
    const pid = Number(readFileSync(bystander, 'utf8').trim());
    assert.doesNotThrow(() => process.kill(pid, 0), 'a settled command sent no signal to its group');
  } finally {
    if (existsSync(bystander)) { try { process.kill(Number(readFileSync(bystander, 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ } }
  }
});

// ---- Round 6 (Sol on a37a976) -----------------------------------------------------------------------------------

test('F9 a requester who cancels while the worktree is being made is told where anything left behind is', async () => {
  const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
  const work = repo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-svc-')));
  const login = join(root, 'login-claude-a');
  mkdirSync(login, { recursive: true });
  // A Claude that answers the account probes; it is never given a job here.
  const claude = join(root, 'claude');
  writeFileSync(join(root, 'scenario.json'), JSON.stringify({ version: u4('claude-version').stdout,
    authStatus: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout }));
  writeFileSync(claude, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '--version') process.stdout.write(sc.version);
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.authStatus));
else if (a[0] === '-p' && a[1] === '/usage') {
  const at = (ms) => { const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return q.month + ' ' + q.day + ' at ' + q.hour + ':' + q.minute + q.dayPeriod.toLowerCase(); };
  const NL = String.fromCharCode(10), RESET = new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m', 'u');
  process.stdout.write(JSON.stringify({ ...sc.usage, result: sc.usage.result.split(NL).map((l) => l.replace(RESET, 'resets ' + at(Date.now() + (l.startsWith('Current session') ? 3 : 96) * 3600000))).join(NL) }));
} else { fs.writeFileSync(p.join(__dirname, 'job-ran'), ''); process.exitCode = 1; }
`);
  chmodSync(claude, 0o755);
  // The worktree add makes the worktree, something writes into it, and then the add hangs until it is stopped.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u12-git-')));
  const made = join(bin, 'made');
  writeFileSync(join(bin, 'git'), `#!/bin/sh
view() { while [ "$1" = -c ]; do shift 2; done; SUB="$3"; A4="$4"; W="$5"; }
view "$@"
if [ "$SUB" = worktree ] && [ "$A4" = add ]; then "${REAL_GIT}" "$@" || exit $?; echo stray > "$W/stray.txt"; touch "${made}"; exec /bin/sleep 30; fi
exec "${REAL_GIT}" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
  const handle = await startPipe({
    accounts: [{ id: 'claude-a', provider: 'claude', loginDir: login, fingerprint: createHash('sha256').update('<orgId>').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true }],
    policy: { claude: { models: { opus: 'default' }, efforts: ['high'] }, codex: { models: { 'gpt-6-sol': 'default' }, efforts: ['high'] } },
    storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'), cli: { claude },
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000,
  } as Parameters<typeof startPipe>[0]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  try {
    const made1 = await call('POST', '/v1/requests', { requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus',
      effort: 'high', reason: 'a change', prompt: 'change the readme', mutating: true, cwd: work, priority: 'interactive' });
    assert.equal(made1.status, 201, made1.text);
    const id = made1.json.request.id;
    for (let i = 0; i < 400 && !existsSync(made); i++) await sleep(50);
    assert.ok(existsSync(made), 'the worktree was made and written into');
    const cancelled = await call('POST', `/v1/requests/${id}/cancel`, {});
    assert.equal(cancelled.status, 200, cancelled.text);
    let request: Record<string, any> = {};
    for (let i = 0; i < 300; i++) {
      request = (await call('GET', `/v1/requests/${id}`)).json.request;
      if (request?.workspace) break;
      await sleep(100);
    }
    assert.equal(request.state, 'cancelled');
    assert.ok(request.workspace && existsSync(request.workspace.path), `the kept worktree is named: ${JSON.stringify(request)}`);
    assert.ok(existsSync(join(request.workspace.path, 'stray.txt')), 'with what was written into it');
    assert.ok(!existsSync(join(root, 'job-ran')), 'the CLI never ran');
  } finally { await handle.stop(); }
});

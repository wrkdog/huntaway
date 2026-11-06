/**
 * Acceptance grader, lane U8: disk hygiene (lead-authored; the implementation lane must not edit it).
 *
 * On 2026-09-26 the drive holding the pipe's data filled, and a job failed with "No space left on device".
 * The pipe's rule applies: a temporary condition such as a full disk makes work wait, and is never marked permanent.
 * T: each attempt gets its own temp folder, removed when it ends. W: finished worktrees are kept for a while,
 * then saved and removed, keeping their branches. D: below a free-space floor, work waits instead of failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type RunEvent } from '../src/runner.ts';
import { startPipe } from '../src/service.ts';
import { Store, type DispatchEvidence } from '../src/store.ts';
import type { AccountConfig } from '../src/identity.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
/** Runs the CLI without blocking this process, which hosts the pipe it calls. */
const runCli = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env }, (err, stdout, stderr) =>
    resolve({ status: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
});
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
const GB = 2 ** 30;
const POLICY = {
  claude: { models: { opus: 'default', fable: 'hard', 'claude-opus-5-5': 'hard' }, efforts: ['low', 'medium', 'high', 'max'] },
  codex: { models: { 'gpt-6-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'ultra'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withModel = (jsonl: string, model: string) => jsonl.trim().split('\n').map((l) => {
  const o = JSON.parse(l); if (o.type === 'system' && o.subtype === 'init') o.model = model; return JSON.stringify(o);
}).join('\n') + '\n';

/**
 * A fake `claude` answering the U4 probe captures. Each job appends `{ tmp, cwd }` to `runs.jsonl`, writes a file
 * and a mkdtemp folder into its TMPDIR, and, when the prompt says EDIT, changes README.md and adds work.txt in its cwd.
 * Job n follows `plan[n]` when given: 'enospc' fails the way a CLI reports a full disk.
 */
function fakeClaude(plan: Array<'ok' | 'enospc'> = []): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-claude-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    version: u4('claude-version').stdout, auth: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout,
    ok: withModel(readFileSync(new URL('claude-success.jsonl', FIX), 'utf8'), 'claude-opus-5-5'), plan,
    full: withModel(readFileSync(new URL('claude-success.jsonl', FIX), 'utf8'), 'claude-opus-5-5').split('\n')[0] + '\n'
      + JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [{ message: 'ENOSPC: no space left on device, write' }] }) + '\n',
  }));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '--version') process.stdout.write(sc.version);
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.auth));
else if (a[0] === '-p' && a[1] === '/usage') {
  const at = (ms) => { const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return q.month + ' ' + q.day + ' at ' + q.hour + ':' + q.minute + q.dayPeriod.toLowerCase(); };
  const NL = String.fromCharCode(10), RESET = new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m', 'u');
  const result = sc.usage.result.split(NL).map((l) => l.replace(RESET, 'resets ' + at(Date.now() + (l.startsWith('Current session') ? 3 : 96) * 3600000))).join(NL);
  process.stdout.write(JSON.stringify({ ...sc.usage, result }));
} else {
  let prompt = ''; try { prompt = fs.readFileSync(0, 'utf8'); } catch {}
  const count = p.join(__dirname, 'jobs'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));
  if (sc.plan[n] === 'enospc') { process.stdout.write(sc.full); process.exit(1); }
  const tmp = process.env.TMPDIR;
  fs.appendFileSync(p.join(__dirname, 'runs.jsonl'), JSON.stringify({ tmp, cwd: process.cwd() }) + String.fromCharCode(10));
  fs.writeFileSync(p.join(tmp, 'scratch.txt'), 'left behind by a test inside the job');
  fs.mkdtempSync(p.join(tmp, 'suite-'));
  if (prompt.includes('SAMESIZE')) fs.writeFileSync(p.join(process.cwd(), 'README.md'), 'HELLO' + String.fromCharCode(10));
  if (prompt.includes('EDIT')) {
    fs.appendFileSync(p.join(process.cwd(), 'README.md'), 'changed by the job' + String.fromCharCode(10));
    fs.writeFileSync(p.join(process.cwd(), 'work.txt'), 'new work' + String.fromCharCode(10));
  }
  process.stdout.write(sc.ok);
}
`);
  chmodSync(path, 0o755);
  return path;
}

function account(root: string): AccountConfig {
  const loginDir = join(root, 'login-claude-a');
  mkdirSync(loginDir, { recursive: true });
  return { id: 'claude-a', provider: 'claude', loginDir, fingerprint: sha8('<orgId>'), maxConcurrency: 1, enabled: true };
}

function repo(format: 'sha1' | 'sha256' = 'sha1'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main', `--object-format=${format}`);
  git('config', 'user.email', 'lead@example.invalid');
  git('config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}
const gitOut = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const listedWorktrees = (dir: string) => gitOut(dir, 'worktree', 'list', '--porcelain').split('\n')
  .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));

/**
 * A `git` placed first on the jobs' PATH, passing everything to the real one, except:
 * with a `hang` file beside it, `status` never returns (it records its pid); with `stubborn`, it also ignores SIGTERM and
 * leaves a child holding its output open; with an `enospc` file, `worktree add` fails the way git reports a full disk.
 */
function fakeGit(): { dir: string; set: (flag: 'hang' | 'stubborn' | 'enospc' | 'switch' | 'attr' | 'attr-tracked' | 'redirect', on: boolean) => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-git-')));
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), `#!/bin/sh
d="$(dirname "$0")"
case " $* " in *" status "*) if [ -e "$d/hang" ]; then echo $$ > "$d/hung.pid"; exec sleep 3600; fi ;; esac
case " $* " in *" status "*) if [ -e "$d/stubborn" ]; then trap '' TERM; sleep 3600 & echo $! > "$d/hung.pid"; wait; fi ;; esac
case " $* " in *" worktree add "*) if [ -e "$d/enospc" ]; then echo "fatal: could not create work tree dir: No space left on device" >&2; exit 128; fi ;; esac
# While prune checks a worktree's status, something else changes it: its branch, or its attributes.
case " $* " in *" status --porcelain -z "*)
  w=""; prev=""; for a in "$@"; do [ "$prev" = "-C" ] && w="$a"; prev="$a"; done
  if [ -e "$d/switch" ] && [ ! -e "$d/switched" ]; then touch "$d/switched"; "${real}" -c core.hooksPath=/dev/null -C "$w" checkout -q -b switched; fi
  if [ -e "$d/attr" ] && [ ! -e "$d/attred" ]; then touch "$d/attred"; common="$("${real}" -C "$w" rev-parse --path-format=absolute --git-common-dir)"; echo "work.txt filter=x" >> "$common/info/attributes"; fi
  if [ -e "$d/attr-tracked" ] && [ ! -e "$d/attred" ]; then touch "$d/attred"; common="$("${real}" -C "$w" rev-parse --path-format=absolute --git-common-dir)"; echo "README.md filter=x" >> "$common/info/attributes"; fi ;;
esac
# A process still inside the worktree points its .git file at the owning repository's own git dir, mid-save (L64).
case " $* " in *" add -A "*)
  w=""; prev=""; for a in "$@"; do [ "$prev" = "-C" ] && w="$a"; prev="$a"; done
  if [ -e "$d/redirect" ] && [ ! -e "$d/redirected" ]; then touch "$d/redirected"; printf 'gitdir: %s\n' "$("${real}" -C "$w" rev-parse --path-format=absolute --git-common-dir)" > "$w/.git"; fi ;;
esac
exec "${real}" "$@"
`);
  chmodSync(join(dir, 'git'), 0o755);
  return { dir, set: (flag, on) => { if (on) writeFileSync(join(dir, flag), ''); else rmSync(join(dir, flag), { force: true }); } };
}

type Extra = { tmpRoot?: string; worktreeKeepHours?: number; pruneIntervalMs?: number; minFreeGb?: number; diskFree?: (path: string) => number;
  retryBackoffMs?: number; saveOnCompletion?: boolean };
async function pipe(o: { root?: string; extra?: Extra; plan?: Array<'ok' | 'enospc'>; gitDir?: string } = {}) {
  const root = o.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-')));
  const fake = fakeClaude(o.plan);
  // The service's own TMPDIR: an attempt must never be handed this shared one.
  const shared = join(root, 'shared-tmp');
  mkdirSync(shared, { recursive: true });
  const handle = await startPipe({
    accounts: [account(root)], policy: POLICY, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'),
    cli: { claude: fake }, env: { PATH: `${o.gitDir ? `${o.gitDir}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp', TMPDIR: shared },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000,
    ...(o.extra ?? {}),
  } as Parameters<typeof startPipe>[0]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  const runs = (): Array<{ tmp: string; cwd: string }> => {
    try { return readFileSync(join(fake, '..', 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; }
  };
  const jobsRun = () => { try { return Number(readFileSync(join(fake, '..', 'jobs'), 'utf8')); } catch { return 0; } };
  return { ...handle, call, runs, jobsRun, root, shared };
}
const ask = (over: Record<string, unknown> = {}) => ({ requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high',
  reason: 'a routine check', prompt: 'say OK', mutating: false, priority: 'interactive', ...over });
async function until<T>(what: string, get: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await get(); if (ok(v)) return v; if (Date.now() > end) assert.fail(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`); await sleep(50); }
}
type P = Awaited<ReturnType<typeof pipe>>;
/** Collects this process's stderr, where the in-process service logs, until restored. */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [], write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { chunks.push(String(chunk)); return (write as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
  return { text: () => chunks.join(''), restore: () => { process.stderr.write = write; } };
}
async function finished(p: P, id: string) {
  const r = await until(`request ${id} to finish`, () => p.call('GET', `/v1/requests/${id}`),
    (x) => ['completed', 'failed', 'cancelled'].includes(x.json.request?.state));
  assert.equal(r.json.request.state, 'completed', r.text);
  return r.json.request as { id: string; workspace: { path: string; branch: string; commit: string } | null };
}
async function submit(p: P, over: Record<string, unknown> = {}): Promise<string> {
  const r = await p.call('POST', '/v1/requests', ask(over));
  assert.equal(r.status, 201, r.text);
  return r.json.request.id;
}

// ---- T: a temp folder per attempt ---------------------------------------------------------------------------------

test('T1 each attempt gets its own TMPDIR under tmpRoot, never the shared one, and it is removed when the attempt ends', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-t1-')));
  const tmpRoot = join(root, 'tmp');
  const p = await pipe({ root, extra: { tmpRoot } });
  try {
    await finished(p, await submit(p));
    await finished(p, await submit(p));
    const seen = p.runs();
    assert.equal(seen.length, 2, JSON.stringify(seen));
    const [a, b] = seen.map((r) => r.tmp);
    assert.notEqual(a, b, 'two attempts never share a temp folder');
    for (const dir of [a!, b!]) {
      assert.ok(dir.startsWith(tmpRoot + '/'), `${dir} is inside tmpRoot ${tmpRoot}`);
      assert.notEqual(dir, p.shared);
      await until(`${dir} to be removed`, () => existsSync(dir), (v) => v === false, 5_000);
    }
    assert.ok(existsSync(tmpRoot), 'tmpRoot itself stays');
  } finally { await p.stop(); }
});

test('T2 at start, old ended-attempt scratch without runner proof and unrelated folders stay untouched', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-t2-')));
  const tmpRoot = join(root, 'tmp');
  const acct = account(root);
  const store = new Store(join(root, 'pipe.sqlite'));
  const made = store.submit(ask() as Parameters<Store['submit']>[0]);
  const evidence: DispatchEvidence = { accountId: acct.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] };
  const started = store.startAttempt(made.id, acct, evidence);
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  store.finishAttempt(started.attempt.id, { kind: 'completed', result: 'OK' });
  store.close();
  // A pipe that stopped hard left scratch with no recorded runner identity. It
  // cannot infer group exit from the completed request or the old folder age.
  const left = join(tmpRoot, started.attempt.id);
  mkdirSync(join(left, 'suite-x'), { recursive: true });
  writeFileSync(join(left, 'scratch.txt'), 'x');
  const old = new Date(Date.now() - 74 * 3_600_000);
  utimesSync(left, old, old);
  const other = join(tmpRoot, 'keep-me');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'notes.txt'), 'not the pipe\'s');
  const p = await pipe({ root, extra: { tmpRoot } });
  try {
    assert.ok(existsSync(join(left, 'scratch.txt')), 'startup retains the unproven ended attempt');
    assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'not the pipe\'s');
  } finally { await p.stop(); }
});

// ---- W: worktree retention (prune's own save: these tests turn the completion save off, L64) ----------------------------------------------------------------------------------------

test('W1 a clean worktree of a finished request is removed after worktreeKeepHours; its branch and commit stay', async () => {
  const work = repo();
  const p = await pipe({ extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 200 } });
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work });
    const done = await finished(p, id);
    const kept = done.workspace!;
    assert.ok(kept && kept.path, 'changing work records its worktree');
    await until(`${kept.path} to be removed`, () => existsSync(kept.path), (v) => v === false, 10_000);
    const head = gitOut(work, 'rev-parse', `refs/heads/${kept.branch}`);
    assert.match(head, /^[0-9a-f]{40}$/, 'the branch stays');
    assert.ok(!listedWorktrees(work).includes(kept.path), 'git no longer lists the worktree');
    const after = await until('the record to name the saved commit', () => p.call('GET', `/v1/requests/${id}`),
      (x) => x.json.request?.workspace?.commit !== 'uncommitted');
    assert.equal(after.json.request.workspace.commit, head, 'the record names the commit the branch holds');
  } finally { await p.stop(); }
});

test('W2 `POST /v1/worktrees/prune` first saves uncommitted work as a commit on its branch (hooks skipped), then removes the worktree', async () => {
  const work = repo();
  const base = gitOut(work, 'rev-parse', 'HEAD');
  // A repository hook that refuses every commit: saving must not depend on it.
  const hook = join(work, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const p = await pipe({ extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' });
    const kept = (await finished(p, id)).workspace!;
    assert.equal(readFileSync(join(kept.path, 'work.txt'), 'utf8'), 'new work\n', 'the job left uncommitted work');
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    assert.ok(JSON.stringify(r.json).includes(id), `the report names the request: ${r.text}`);
    await until(`${kept.path} to be removed`, () => existsSync(kept.path), (v) => v === false, 10_000);
    const saved = gitOut(work, 'rev-parse', `refs/heads/${kept.branch}`);
    assert.notEqual(saved, base, 'the work was saved as a new commit');
    assert.equal(gitOut(work, 'rev-parse', `${saved}^`), base, 'on top of the commit the job started from');
    assert.equal(gitOut(work, 'show', `${saved}:work.txt`), 'new work', 'an untracked file is saved');
    assert.match(gitOut(work, 'show', `${saved}:README.md`), /changed by the job/, 'a changed file is saved');
    const after = await p.call('GET', `/v1/requests/${id}`);
    assert.equal(after.json.request.workspace.commit, saved, 'the record names the saved commit');
  } finally { await p.stop(); }
});

test('W3 inside worktreeKeepHours, nothing is removed, and `GET /v1/worktrees` and `pipe worktrees` list what is kept', async () => {
  const work = repo();
  const p = await pipe({ extra: { saveOnCompletion: false } });
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' });
    const kept = (await finished(p, id)).workspace!;
    const pruned = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(pruned.status, 200, pruned.text);
    assert.ok(existsSync(join(kept.path, 'work.txt')), 'a worktree inside the default 72 hours stays, work and all');
    const listed = await p.call('GET', '/v1/worktrees');
    assert.equal(listed.status, 200, listed.text);
    const entry = (listed.json.worktrees as Array<Record<string, unknown>>).find((w) => w.requestId === id);
    assert.ok(entry, `listed: ${listed.text}`);
    assert.equal(entry!.path, kept.path);
    assert.equal(entry!.branch, kept.branch);
    const cli = await runCli(['worktrees'], { ...process.env, PIPE_URL: p.url, PIPE_TOKEN: TOKEN });
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(cli.stdout.includes(id) && cli.stdout.includes(kept.path), cli.stdout);
    const prune = await runCli(['prune'], { ...process.env, PIPE_URL: p.url, PIPE_TOKEN: TOKEN });
    assert.equal(prune.status, 0, prune.stderr);
    assert.ok(existsSync(kept.path));
  } finally { await p.stop(); }
});

test('W4 a locked worktree, or a recorded path outside worktreeRoot, is never removed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-w4-')));
  const work = repo();
  // A finished request whose record points outside worktreeRoot (a hand-edited or foreign record).
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-outside-')));
  writeFileSync(join(outside, 'precious.txt'), 'never the pipe\'s to remove');
  const acct = account(root);
  const store = new Store(join(root, 'pipe.sqlite'));
  const made = store.submit(ask({ kind: 'code', mutating: true, cwd: work }) as Parameters<Store['submit']>[0]);
  const evidence: DispatchEvidence = { accountId: acct.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] };
  const started = store.startAttempt(made.id, acct, evidence);
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  const foreign = { path: outside, branch: `pipe/${made.id}`, commit: 'uncommitted' };
  store.noteWorkspace(started.attempt.id, foreign);
  store.finishAttempt(started.attempt.id, { kind: 'completed', result: 'OK', workspace: foreign });
  store.close();
  const p = await pipe({ root, extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' });
    const kept = (await finished(p, id)).workspace!;
    execFileSync('git', ['-C', work, 'worktree', 'lock', '--reason', 'the lead is still reading it', kept.path]);
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    await sleep(500);
    assert.ok(existsSync(join(kept.path, 'work.txt')), 'a locked worktree stays');
    assert.equal(readFileSync(join(outside, 'precious.txt'), 'utf8'), 'never the pipe\'s to remove');
  } finally { await p.stop(); }
});

// ---- D: the disk-space guard --------------------------------------------------------------------------------------

test('D1 below minFreeGb, requests wait with "disk nearly full" instead of failing, and run once space returns', async () => {
  const work = repo();
  let free = 1 * GB;
  const asked = new Set<string>();
  const p = await pipe({ extra: { saveOnCompletion: false, minFreeGb: 20, diskFree: (path: string) => { asked.add(path); return free; } } });
  try {
    const quiet = await submit(p);
    const change = await submit(p, { kind: 'code', mutating: true, cwd: work });
    for (const id of [quiet, change]) {
      const r = await until(`${id} to say why it waits`, () => p.call('GET', `/v1/requests/${id}`),
        (x) => /disk nearly full/i.test(String(x.json.request?.waiting?.reason ?? '')));
      assert.equal(r.json.request.state, 'queued', r.text);
    }
    await sleep(600);
    assert.equal(p.runs().length, 0, 'nothing ran while the disk was nearly full');
    for (const id of [quiet, change]) assert.equal((await p.call('GET', `/v1/requests/${id}`)).json.request.state, 'queued', 'waiting, never failed');
    assert.ok(asked.size > 0, 'the guard asked for free space');
    free = 100 * GB;
    await finished(p, quiet);
    await finished(p, change);
  } finally { await p.stop(); }
});

test('D2 the new settings are checked at start', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-d2-')));
  const base = { accounts: [account(root)], policy: POLICY, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'),
    cli: { claude: fakeClaude() }, token: TOKEN, port: 0, reachable: async () => true };
  for (const bad of [{ minFreeGb: -1 }, { minFreeGb: Number.NaN }, { worktreeKeepHours: -1 }, { worktreeKeepHours: Number.POSITIVE_INFINITY }, { pruneIntervalMs: 0 }]) {
    let started: Awaited<ReturnType<typeof startPipe>> | undefined;
    try { started = await startPipe({ ...base, ...bad } as Parameters<typeof startPipe>[0]); }
    catch (e) { assert.ok(e instanceof RangeError, `${JSON.stringify(bad)}: ${String(e)}`); continue; }
    await started.stop();
    assert.fail(`${JSON.stringify(bad)} was accepted`);
  }
});

test('S8 the lane stays small: its own src/disk.ts holds at most 580 non-blank lines, with no dependency', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  const lines = readFileSync(new URL('../src/disk.ts', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() !== '').length;
  // Raised from 220 by the lead: the review rounds added process-group git, name-only checks and re-checks.
  // U10 shares runGit with reviews: a deadline, an output cap and truncation as options. U12 makes it the runner's too,
  // and settles its answer only at close (the lead, 2026-09-26).
  // Prune's save becomes saveWorktree, which a completed changing job
  // also calls, so builders save their own work: +10; its review round pins every save's git to the metadata the pipe
  // made and checks worktreeRoot inside the save: +3 (the lead).
  // 2026-10-08: the cleanup retry queue (one minute, ten minutes, then hourly; logged once) and prune's
  // keep-without-git for a deleted repository, after 1.6 million retry lines filled a 928 MB log: +30 (the lead).
  // The 2026-10-08 merge with the live line adds its saved-base staged-diff check: +1 (the lead).
  // Velocity telemetry: the saved build's diff (numstat) recorded at save: +6 (the lead).
  // Save worktrees whose submodules are untouched (R1, split out): the gitlink comparison against the
  // start commit, hidden-flag and unmerged checks, and the empty-directory walk that replace the blanket refusal: +29 (the lead).
  // Review b3dddf21: the admin modules check, the hidden-entry reason and the quiet keep on inspection errors: +5 (the lead).
  // review round 1: a stopped git proves its whole process group gone (signal-0 probe, SIGKILL
  // escalation, groupClosed on the error) before it rejects: +13 (354 -> 367; the lead).
  // u44 housekeeping (round 3, no archiving; 2026-10-29): disk-pressure tiers, bounded passes, kept kinds, the save capacity guard, save backoff and strikes, and cached health counts: +157 (367 → 524), the lead.
  // u49 round 2 (2026-10-31): canonical non-overlapping previous worktree roots, per-volume tiers and the restored disk.ts rationale comments (round 1 had moved them out to fit): +29 (524 → 553), the lead.
  // u49 round 3 (2026-10-31): finalization-first membership, narrowed previous-root rules, one resolved location set and hung-volume short-circuits: +23 (553 → 576), the lead.
  // u44.2 merged into u49 (2026-10-31): the pressure yield floor and repeat cadence: +4 (576 → 580), the lead.
  assert.ok(lines <= 580, `src/disk.ts holds ${lines} non-blank lines; its budget is 580`);
});

// ---- Round 2 (Sol and Google on a02ae12) ------------------------------------------------------------------------

test('W5 a save runs no repository code: fsmonitor is off, and a dirty path under a clean filter keeps its worktree', async () => {
  const plain = repo(), filtered = repo();
  const p = await pipe({ extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    const a = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: plain, prompt: 'EDIT the readme' }))).workspace!;
    const b = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: filtered, prompt: 'EDIT the readme' }))).workspace!;
    // Configured after the jobs, so only the prune pass could run them.
    const marker = (name: string) => join(p.root, `${name}-ran`);
    // The fsmonitor script answers at once; the clean filter passes its input through, as a real one would.
    const script = (name: string, pass: boolean) => { const f = join(p.root, `${name}.sh`); writeFileSync(f, `#!/bin/sh\ntouch "${marker(name)}"\n${pass ? 'cat\n' : ''}`); chmodSync(f, 0o755); return f; };
    // Git runs these through the shell, so the paths are quoted (test folders may contain spaces).
    execFileSync('git', ['-C', plain, 'config', 'core.fsmonitor', `"${script('fsmonitor', false)}"`]);
    execFileSync('git', ['-C', filtered, 'config', 'filter.x.clean', `"${script('clean', true)}"`]);
    writeFileSync(join(gitOut(filtered, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'attributes'), 'work.txt filter=x\n');
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    await until(`${a.path} to be removed`, () => existsSync(a.path), (v) => v === false, 10_000);
    assert.equal(gitOut(plain, 'show', `${a.branch}:work.txt`), 'new work', 'the plain worktree was saved');
    assert.ok(!existsSync(marker('fsmonitor')), 'no fsmonitor command ran');
    assert.ok(existsSync(join(b.path, 'work.txt')), 'a dirty path under a clean filter keeps its worktree');
    assert.match(JSON.stringify(r.json.kept ?? []), /filter/i, `the report says why: ${r.text}`);
    assert.ok(!existsSync(marker('clean')), 'no clean filter ran');
  } finally { await p.stop(); }
});

test('W6 stop completes promptly while a prune git command hangs, and the hung command is ended', async () => {
  const work = repo();
  const git = fakeGit();
  const p = await pipe({ gitDir: git.dir, extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  let stopped = false;
  try {
    const kept = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' }))).workspace!;
    git.set('hang', true);
    void p.call('POST', '/v1/worktrees/prune').catch(() => {});
    await until('the prune pass to reach git status', () => existsSync(join(git.dir, 'hung.pid')), (v) => v, 10_000);
    const started = Date.now();
    await p.stop();
    stopped = true;
    assert.ok(Date.now() - started < 10_000, `stop took ${Date.now() - started} ms`);
    const pid = Number(readFileSync(join(git.dir, 'hung.pid'), 'utf8'));
    await until('the hung git to end', () => { try { process.kill(pid, 0); return true; } catch { return false; } }, (alive) => !alive, 5_000);
    assert.ok(existsSync(kept.path), 'an interrupted pass leaves the worktree as it was');
  } finally { git.set('hang', false); if (!stopped) await p.stop(); }
});

test('W7 a SHA-256 repository is saved and pruned like any other, and its 64-character commit is recorded', async () => {
  const work = repo('sha256');
  const p = await pipe({ extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' });
    const kept = (await finished(p, id)).workspace!;
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    await until(`${kept.path} to be removed`, () => existsSync(kept.path), (v) => v === false, 10_000);
    const saved = gitOut(work, 'rev-parse', `refs/heads/${kept.branch}`);
    assert.match(saved, /^[0-9a-f]{64}$/);
    assert.equal((await p.call('GET', `/v1/requests/${id}`)).json.request.workspace.commit, saved);
  } finally { await p.stop(); }
});

test('D3 a full disk when the worktree is made sends a changing request back to wait, and it runs once there is room', async () => {
  const work = repo();
  const git = fakeGit();
  git.set('enospc', true);
  const p = await pipe({ gitDir: git.dir, extra: { saveOnCompletion: false, retryBackoffMs: 300 } });
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' });
    const waiting = await until('the first attempt to end', () => p.call('GET', `/v1/requests/${id}`),
      (x) => x.json.request?.state !== 'running' && /space/i.test(JSON.stringify(x.json.request?.error ?? '')));
    assert.equal(waiting.json.request.state, 'queued', `a full disk never fails the request: ${waiting.text}`);
    assert.deepEqual(waiting.json.request.avoid, [], 'nor blames the account');
    git.set('enospc', false);
    await finished(p, id);
  } finally { git.set('enospc', false); await p.stop(); }
});

test('D4 a job that fails on a full disk is retried without blame, and gives up only after repeated failures', async () => {
  const once = await pipe({ plan: ['enospc', 'ok'], extra: { saveOnCompletion: false, retryBackoffMs: 50 } });
  try {
    const id = await submit(once);
    const done = await finished(once, id);
    assert.equal(once.jobsRun(), 2);
    assert.deepEqual((done as unknown as { avoid: string[] }).avoid, [], 'the account is not avoided');
  } finally { await once.stop(); }
  const always = await pipe({ plan: Array(30).fill('enospc'), extra: { saveOnCompletion: false, retryBackoffMs: 20 } });
  try {
    const id = await submit(always);
    const end = await until(`request ${id} to end`, () => always.call('GET', `/v1/requests/${id}`),
      (x) => ['completed', 'failed'].includes(x.json.request?.state), 30_000);
    assert.equal(end.json.request.state, 'failed');
    assert.match(String(end.json.request.error?.message), /disk|space/i);
    assert.ok(always.jobsRun() >= 5 && always.jobsRun() <= 12, `bounded: ${always.jobsRun()} jobs`);
  } finally { await always.stop(); }
});

// ---- Round 3 (Sol on 08d2fda) -----------------------------------------------------------------------------------

test('W8 no clean filter runs even for a modified tracked file: its worktree is kept before git reads any content', async () => {
  const work = repo();
  const p = await pipe({ extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    // The same size, so git must read the file (and filter it) to see the change.
    const kept = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'SAMESIZE' }))).workspace!;
    const marker = join(p.root, 'clean-ran');
    const script = join(p.root, 'clean.sh');
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    execFileSync('git', ['-C', work, 'config', 'filter.x.clean', `"${script}"`]);
    writeFileSync(join(gitOut(work, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'attributes'), 'README.md filter=x\n');
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    assert.ok(!existsSync(marker), 'no clean filter ran');
    assert.equal(readFileSync(join(kept.path, 'README.md'), 'utf8'), 'HELLO\n', 'the worktree and its change are kept');
    assert.match(JSON.stringify(r.json.kept ?? []), /filter/i, r.text);
  } finally { await p.stop(); }
});

test('W9 stop completes when a prune git ignores SIGTERM and leaves a child holding its output, and both are ended', async () => {
  const work = repo();
  const git = fakeGit();
  const p = await pipe({ gitDir: git.dir, extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  let stopped = false;
  try {
    await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' }));
    git.set('stubborn', true);
    void p.call('POST', '/v1/worktrees/prune').catch(() => {});
    await until('the prune pass to reach git status', () => existsSync(join(git.dir, 'hung.pid')), (v) => v, 10_000);
    const started = Date.now();
    await p.stop();
    stopped = true;
    assert.ok(Date.now() - started < 15_000, `stop took ${Date.now() - started} ms`);
    const pid = Number(readFileSync(join(git.dir, 'hung.pid'), 'utf8'));
    await until('the stubborn child to end', () => { try { process.kill(pid, 0); return true; } catch { return false; } }, (alive) => !alive, 10_000);
  } finally { git.set('stubborn', false); if (!stopped) await p.stop(); }
});

test('T3 a temp folder that cannot be made fails the request once, and never loops', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-t3-')));
  const tmpRoot = join(root, 'not-a-folder');
  writeFileSync(tmpRoot, 'a file where the temp folders should go');
  const p = await pipe({ root, extra: { saveOnCompletion: false, tmpRoot, retryBackoffMs: 20 } });
  try {
    const id = await submit(p);
    const end = await until(`request ${id} to end`, () => p.call('GET', `/v1/requests/${id}`),
      (x) => ['completed', 'failed'].includes(x.json.request?.state), 10_000);
    assert.equal(end.json.request.state, 'failed', end.text);
    assert.match(String(end.json.request.error?.message), /temp/i);
    await sleep(500);
    assert.equal(p.jobsRun(), 0, 'no CLI ran');
  } finally { await p.stop(); }
  const store = new Store(join(root, 'pipe.sqlite'));
  try {
    const [only] = store.list();
    assert.equal(store.attempts(only!.id).length, 1, 'one attempt, no loop');
  } finally { store.close(); }
});

test('D5 the disk-full bound is exact: the tenth disk-full failure ends the request', async () => {
  const p = await pipe({ plan: Array(30).fill('enospc'), extra: { saveOnCompletion: false, retryBackoffMs: 20 } });
  try {
    const id = await submit(p);
    const end = await until(`request ${id} to end`, () => p.call('GET', `/v1/requests/${id}`),
      (x) => ['completed', 'failed'].includes(x.json.request?.state), 30_000);
    assert.equal(end.json.request.state, 'failed');
    assert.equal(p.jobsRun(), 10);
    assert.match(String(end.json.request.error?.message), /after 10 disk-full failures/);
  } finally { await p.stop(); }
});

// ---- Round 4 (Sol on 361f029) -----------------------------------------------------------------------------------

test('W10 a worktree that contains a submodule is kept for a manual save: its files and filters are never read', async () => {
  const work = repo();
  // A gitlink, as a submodule records itself; git status would look inside a populated one.
  const head = gitOut(work, 'rev-parse', 'HEAD');
  execFileSync('git', ['-C', work, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/lib`]);
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', 'a submodule']);
  const p = await pipe({ extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    const kept = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' }))).workspace!;
    // Populate the submodule with a repository whose clean filter would leave a marker, and give it a same-size edit.
    const sub = join(kept.path, 'vendor', 'lib');
    execFileSync('git', ['clone', '-q', work, sub]);
    const marker = join(p.root, 'submodule-filter-ran'), script = join(p.root, 'submodule-clean.sh');
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    execFileSync('git', ['-C', sub, 'config', 'filter.x.clean', `"${script}"`]);
    writeFileSync(join(sub, '.git', 'info', 'attributes'), 'README.md filter=x\n');
    writeFileSync(join(sub, 'README.md'), 'HELLO\n');
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    assert.ok(existsSync(join(kept.path, 'work.txt')), 'the worktree and its work are kept');
    assert.match(JSON.stringify(r.json.kept ?? []), /submodule/i, r.text);
    assert.ok(!existsSync(marker), 'no filter inside the submodule ran');
  } finally { await p.stop(); }
});

// ---- Round 5 (Sol on eb5546b) -----------------------------------------------------------------------------------

test('D6 a full disk before the CLI gets its prompt (recording the pre-spawn state) is disk_full and untouched, not other', async () => {
  const work = repo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-d6-')));
  const events: RunEvent[] = [];
  for await (const e of run({ requestId: 'req-d6', accountId: 'codex-a', provider: 'codex', model: 'gpt-6-sol', effort: 'high',
    prompt: 'change it', mutating: true, cwd: work, loginDir: root }, {
    cli: { codex: '/usr/bin/false' }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    worktreeRoot: join(root, 'worktrees'), reachable: async () => true,
    onBeforeSpawn: () => { throw new Error('SQLITE_FULL: database or disk is full'); } })) events.push(e);
  const end = events.at(-1)!;
  assert.equal(end.type, 'failed', JSON.stringify(events));
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'disk_full', end.message);
  assert.equal(end.workspace, null, 'nothing is left behind');
  assert.equal(end.untouched, true, 'and it says so');
  assert.equal(gitOut(work, 'branch', '--list', 'pipe/*'), '');
});

// ---- Round 6 (Sol on fd8e1e9) -----------------------------------------------------------------------------------

test('D7 a full disk while recording a spawned CLI, before its prompt, is disk_full; an untouched worktree is removed', async () => {
  const work = repo();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-d7-')));
  const events: RunEvent[] = [];
  for await (const e of run({ requestId: 'req-d7', accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'change it', mutating: true, cwd: work, loginDir: root }, {
    cli: { claude: '/bin/cat' }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    worktreeRoot: join(root, 'worktrees'), reachable: async () => true, killGraceMs: 200,
    onSpawn: () => { throw new Error('SQLITE_FULL: database or disk is full'); } })) events.push(e);
  const end = events.at(-1)!;
  assert.equal(end.type, 'failed', JSON.stringify(events));
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'disk_full', end.message);
  assert.equal(end.workspace, null, 'the prompt was never sent and the worktree is as made, so it is removed');
  assert.equal(end.untouched, true);
  assert.equal(gitOut(work, 'branch', '--list', 'pipe/*'), '');
});

// ---- Round 7 (Sol on 421bd9c) -----------------------------------------------------------------------------------

test('D8 an ignored file written before the CLI was stopped means the worktree is not untouched: it is kept', async () => {
  const work = repo();
  writeFileSync(join(work, '.gitignore'), '.cache/\n');
  execFileSync('git', ['-C', work, 'add', '.gitignore']);
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', 'ignore the cache']);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-d8-')));
  const cli = join(root, 'cli');
  writeFileSync(cli, '#!/bin/sh\nmkdir -p .cache && echo state > .cache/state\nexec sleep 30\n');
  chmodSync(cli, 0o755);
  const events: RunEvent[] = [];
  let workspacePath = '';
  for await (const e of run({ requestId: 'req-d8', accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'change it', mutating: true, cwd: work, loginDir: root }, {
    cli: { claude: cli }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    worktreeRoot: join(root, 'worktrees'), reachable: async () => true, killGraceMs: 200,
    onWorkspace: (workspace) => { workspacePath = workspace.path; },
    onSpawn: () => {
      // Wait for the evidence instead of guessing how long a process launch takes.
      const state = join(workspacePath, '.cache', 'state');
      const deadline = Date.now() + 5_000;
      while (!existsSync(state) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      assert(existsSync(state), 'fixture CLI wrote its ignored file before recording failed');
      throw new Error('SQLITE_FULL: database or disk is full');
    } })) events.push(e);
  const end = events.at(-1)!;
  assert.equal(end.type, 'failed', JSON.stringify(events));
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'disk_full');
  assert.ok(end.workspace && existsSync(join(end.workspace.path, '.cache', 'state')), 'the worktree and its ignored file are kept');
  assert.notEqual(end.untouched, true);
});

test('D9 a request whose untouched changing attempt failed for good keeps no workspace path', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-d9-')));
  const acct = account(root);
  const store = new Store(join(root, 'pipe.sqlite'));
  try {
    const made = store.submit(ask({ kind: 'code', mutating: true, cwd: root }) as Parameters<Store['submit']>[0]);
    const evidence: DispatchEvidence = { accountId: acct.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Edit'] };
    const started = store.startAttempt(made.id, acct, evidence);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.noteWorkspace(started.attempt.id, { path: join(root, 'worktrees', made.id), branch: `pipe/${made.id}`, commit: 'uncommitted' });
    const { request } = store.finishAttempt(started.attempt.id, { kind: 'failed', errorKind: 'other', message: 'could not record', untouched: true });
    assert.equal(request.state, 'failed');
    assert.equal(request.workspace, null, 'the removed worktree is not named');
  } finally { store.close(); }
});

// ---- Round 9 (Sol on ba9fe9c) -----------------------------------------------------------------------------------

/**
 * A git on PATH that runs the real `worktree add`, then `after` (the new worktree is $W), then fails. The pipe runs its
 * own git with hooks off (U12), so this stands in for a hook or another process acting while the worktree is made.
 */
function failAfterAdd(after: string): { PATH: string; HOME: string } {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-gitwrap-')));
  const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh
view() { while [ "$1" = -c ]; do shift 2; done; SUB="$3"; A4="$4"; W="$5"; }
view "$@"
if [ "$SUB" = worktree ] && [ "$A4" = add ]; then "${real}" "$@"; ${after}
  exit 1
fi
exec "${real}" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' };
}

test('D10 a half-made worktree that something wrote into (another process) is kept for inspection, never force-removed', async () => {
  const work = repo();
  const env = failAfterAdd('echo "written by the hook" > "$W/from-hook.txt"');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-d10-')));
  const events: RunEvent[] = [];
  for await (const e of run({ requestId: 'req-d10', accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'change it', mutating: true, cwd: work, loginDir: root }, {
    cli: { claude: '/bin/cat' }, env,
    worktreeRoot: join(root, 'worktrees'), reachable: async () => true })) events.push(e);
  const end = events.at(-1)!;
  assert.equal(end.type, 'failed', JSON.stringify(events));
  if (end.type !== 'failed') return;
  assert.ok(end.workspace, 'the worktree is reported');
  assert.equal(readFileSync(join(end.workspace.path, 'from-hook.txt'), 'utf8'), 'written by the hook\n', 'and kept, with what was written');
  assert.notEqual(end.untouched, true);
});

test('D11 when the half-made worktree cannot be removed, its branch is kept with it, never deleted alone', async () => {
  const work = repo();
  // Something locks the new worktree, then the add fails: git will refuse to remove a locked worktree.
  const env = failAfterAdd('"$(command -v git)" -C "$W" worktree lock --reason "held by another process" "$W"');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u8-d11-')));
  const events: RunEvent[] = [];
  for await (const e of run({ requestId: 'req-d11', accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'change it', mutating: true, cwd: work, loginDir: root }, {
    cli: { claude: '/bin/cat' }, env,
    worktreeRoot: join(root, 'worktrees'), reachable: async () => true })) events.push(e);
  const end = events.at(-1)!;
  assert.equal(end.type, 'failed', JSON.stringify(events));
  if (end.type !== 'failed') return;
  assert.ok(end.workspace && existsSync(end.workspace.path), 'the worktree is kept and reported');
  assert.equal(gitOut(work, 'branch', '--list', '--format=%(refname:short)', 'pipe/req-d11'), 'pipe/req-d11', 'and so is its branch');
});

// ---- Round 11 (Sol on 5c3b9a3): the pass re-checks before each step --------------------------------------------------

test('W11 a worktree whose branch changes during the pass is kept, and no save lands on any branch', async () => {
  const work = repo();
  const base = gitOut(work, 'rev-parse', 'HEAD');
  const git = fakeGit();
  const p = await pipe({ gitDir: git.dir, extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    const kept = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' }))).workspace!;
    git.set('switch', true);
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    assert.ok(existsSync(join(kept.path, 'work.txt')), 'the worktree and its work are kept');
    assert.equal(gitOut(work, 'rev-parse', `refs/heads/${kept.branch}`), base, 'no save on the recorded branch');
    assert.equal(gitOut(work, 'rev-parse', 'refs/heads/switched'), base, 'nor on the branch it switched to');
  } finally { git.set('switch', false); await p.stop(); }
});

test('W12 a filter that applies only after the first check never runs: the pass checks again before saving', async () => {
  const work = repo();
  const git = fakeGit();
  const p = await pipe({ gitDir: git.dir, extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    const kept = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' }))).workspace!;
    const marker = join(p.root, 'late-filter-ran'), script = join(p.root, 'late-clean.sh');
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    execFileSync('git', ['-C', work, 'config', 'filter.x.clean', `"${script}"`]);
    git.set('attr', true);
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    assert.ok(!existsSync(marker), 'the late filter never ran');
    assert.ok(existsSync(join(kept.path, 'work.txt')), 'the worktree is kept');
  } finally { git.set('attr', false); await p.stop(); }
});

// ---- Round 12 (Sol on 417f511) ----------------------------------------------------------------------------------

test('W13 no filter can run during a prune, even one that applies to a modified tracked file while status is reading it', async () => {
  const work = repo();
  const git = fakeGit();
  const p = await pipe({ gitDir: git.dir, extra: { saveOnCompletion: false, worktreeKeepHours: 0, pruneIntervalMs: 3_600_000 } });
  try {
    // A same-size edit, so git must read README.md (and would filter it) to see the change.
    const kept = (await finished(p, await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'SAMESIZE' }))).workspace!;
    const marker = join(p.root, 'tracked-filter-ran'), script = join(p.root, 'tracked-clean.sh');
    writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(script, 0o755);
    execFileSync('git', ['-C', work, 'config', 'filter.x.clean', `"${script}"`]);
    git.set('attr-tracked', true);
    const r = await p.call('POST', '/v1/worktrees/prune');
    assert.equal(r.status, 200, r.text);
    assert.ok(!existsSync(marker), 'no filter ran, even during status');
    assert.equal(readFileSync(join(kept.path, 'README.md'), 'utf8'), 'HELLO\n', 'the worktree and its change are kept');
  } finally { git.set('attr-tracked', false); await p.stop(); }
});

// ---- B: a builder saves its own work. The CLI's sandbox can edit its worktree but never write the git metadata in the owning repository,
// so the pipe itself saves a completed job's work as a commit on the job's own branch, after recording the outcome.

test('B1 a completed changing job saves its own work: one commit on its branch when it ends (hooks skipped), named in its record', async () => {
  const work = repo();
  const base = gitOut(work, 'rev-parse', 'HEAD');
  // A repository hook that refuses every commit: saving must not depend on it, or run it.
  const hook = join(work, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  // No prune can run during this test: only the completion itself may save.
  const p = await pipe({ extra: { worktreeKeepHours: 72, pruneIntervalMs: 3_600_000 } });
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' });
    const kept = (await finished(p, id)).workspace!;
    const after = await until('the record to name the saved commit', () => p.call('GET', `/v1/requests/${id}`),
      (x) => x.json.request?.workspace?.commit !== 'uncommitted', 10_000);
    const saved = gitOut(work, 'rev-parse', `refs/heads/${kept.branch}`);
    assert.equal(after.json.request.state, 'completed', 'the outcome is unchanged');
    assert.equal(after.json.request.workspace.commit, saved, 'the record names the commit its branch holds');
    assert.equal(gitOut(work, 'rev-parse', `${saved}^`), base, 'one commit on top of the commit the job started from');
    assert.equal(gitOut(work, 'show', `${saved}:work.txt`), 'new work', 'a new file is saved');
    assert.match(gitOut(work, 'show', `${saved}:README.md`), /changed by the job/, 'a changed file is saved');
    assert.equal(gitOut(kept.path, 'status', '--porcelain'), '', 'nothing is left uncommitted');
    assert.ok(existsSync(kept.path), 'the worktree stays for its retention period');
    assert.equal(gitOut(work, 'rev-parse', 'HEAD'), base, "the requester's own branch is untouched");
  } finally { await p.stop(); }
});

test('B2 a completion save runs no repository code and never changes the outcome: a clean-filtered path stays unsaved', async () => {
  const filtered = repo();
  const marker = join(filtered, '..', `${filtered.split('/').pop()}-clean-ran`);
  const clean = join(filtered, '..', `${filtered.split('/').pop()}-clean.sh`);
  writeFileSync(clean, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(clean, 0o755);
  // Configured before the job, so the save at its end is the first git that could run the filter.
  execFileSync('git', ['-C', filtered, 'config', 'filter.x.clean', `"${clean}"`]);
  writeFileSync(join(gitOut(filtered, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'attributes'), 'work.txt filter=x\n');
  const p = await pipe({ extra: { worktreeKeepHours: 72, pruneIntervalMs: 3_600_000 } });
  const log = captureStderr();
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: filtered, prompt: 'EDIT the readme' });
    const kept = (await finished(p, id)).workspace!;
    await until('the save to refuse', () => log.text(), (t) => t.includes(`pipe save ${id}: a path uses a clean filter`), 10_000);
    const after = await p.call('GET', `/v1/requests/${id}`);
    assert.equal(after.json.request.state, 'completed', 'the outcome is unchanged');
    assert.equal(after.json.request.workspace.commit, 'uncommitted', 'a clean-filtered worktree is kept for a manual save');
    assert.equal(readFileSync(join(kept.path, 'work.txt'), 'utf8'), 'new work\n', 'its work stays in the worktree');
    assert.ok(!existsSync(marker), 'no clean filter ran');
  } finally { log.restore(); await p.stop(); }
});

test('B3 a save never trusts the worktree\'s .git file: pointing it at the owner mid-save cannot touch the requester\'s index or branch', async () => {
  const work = repo();
  const base = gitOut(work, 'rev-parse', 'HEAD');
  const git = fakeGit();
  git.set('redirect', true);
  const p = await pipe({ gitDir: git.dir, extra: { worktreeKeepHours: 72, pruneIntervalMs: 3_600_000 } });
  const log = captureStderr();
  try {
    const id = await submit(p, { kind: 'code', mutating: true, cwd: work, prompt: 'EDIT the readme' });
    await finished(p, id);
    await until('the save to settle', () => log.text(), (t) => t.includes(`pipe save ${id}:`), 10_000);
    assert.ok(existsSync(join(git.dir, 'redirected')), 'the .git file was pointed at the owner during the save');
    assert.equal(gitOut(work, 'diff', '--cached', '--name-only'), '', "nothing was staged in the requester's index");
    assert.equal(gitOut(work, 'rev-parse', 'HEAD'), base, "the requester's branch is untouched");
    assert.equal(gitOut(work, 'status', '--porcelain'), '', "the requester's checkout is untouched");
  } finally { log.restore(); git.set('redirect', false); await p.stop(); }
});

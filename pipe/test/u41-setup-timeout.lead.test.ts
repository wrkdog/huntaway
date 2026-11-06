/**
 * Acceptance grader: a loaded minute must not fail a whole job at worktree setup (lead-authored; the
 * builder must not edit it).
 *
 * Why. On 2026-10-21 at 15:47Z, under heavy load (1-minute load 13-16), a Codex job failed with "could not
 * create the worktree: git command timed out after 120000 ms", review seats 30a02007 and 203d46e3 failed setup, and
 * three review submissions got HTTP 500 "request could not be handled" with nothing logged. Minutes later the same
 * `git worktree add` on the same seed took 2.4 s. Job and review setup give `git worktree add` a fixed 120 s, and a
 * setup timeout is kind `other`, which fails changing work outright even when setup left nothing behind.
 *
 * Interface the builder must provide:
 * - src/runner.ts exports `WORKTREE_ADD_TIMEOUT_MS` = 300_000, the limit for `git worktree add` in job setup and in
 *   review setup. The run options gain `worktreeAddTimeoutMs?: number` (default WORKTREE_ADD_TIMEOUT_MS).
 * - A new error kind `setup_timeout` (RunErrorKind and the store's error kinds). `setupKind(text)` returns it for a git
 *   timeout ("git command timed out after N ms"); disk-full text stays `disk_full`; anything else stays `other`.
 * - The store treats an untouched `setup_timeout` with no workspace as temporary, for changing and read-only work: the
 *   request is re-queued with `notBefore` = now + retryBackoffMs and an empty `avoid`, once: the second setup timeout
 *   ends it as `failed` with a message containing "after 2 setup timeouts" (the owner approved "retry once"). A `setup_timeout` that left a workspace fails
 *   and keeps that workspace.
 * - src/review.ts: `submitReview` gains a last optional argument `{ worktreeAddTimeoutMs?: number }` (default
 *   `REVIEW_WORKTREE_ADD_TIMEOUT_MS` = 120_000, exported from src/review.ts: the base limit, unchanged). Review
 *   submission is answered synchronously and the shipped clients use fetch, whose default header deadline is 300 s;
 *   with the base 120 s limit and no new inline cleanup, the refusal arrives inside it (rounds 1-2).
 *   When its worktree add times out it rejects with an error whose `status` is 503, whose `code` is 'setup_timeout' and
 *   whose message says the review was not started; the review is recorded as setupFailed, exactly as before.
 *   Round 3 descopes review cleanup: submission adds no inline worktree removal and never a repository-wide
 *   `git worktree prune`; the review's worktree is left to the existing periodic refresh, as at base (closure-aware
 *   review cleanup and a whole-submission deadline are a separate issue). A locked ('initializing') registration and
 *   a failing `git worktree remove` are still answered 503 setup_timeout, never a 500.
 * - Process groups (round 1): a git stopped at its deadline must not leave a member of its process group alive.
 *   A setup timeout may be reported untouched (and so retried) only after the whole group is proven gone; otherwise the
 *   attempt is not untouched.
 * - src/http.ts: `HttpContext` gains `log?(where: string, error: unknown): void`. Every response 500 calls it once with
 *   a `where` naming the method and path (for example `http POST /v1/reviews`) and the thrown error; the reply stays
 *   500 `internal_error` / 'request could not be handled'. An error carrying a `status` and a string `code` is answered
 *   with that status and that code. src/service.ts passes its own logger.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { run } from '../src/runner.ts';
import { Store } from '../src/store.ts';
import { parsePolicy } from '../src/policy.ts';

const runner = async () => await import('../src/runner.ts') as Record<string, any>;
const review = async () => await import('../src/review.ts') as Record<string, any>;
const http = async () => await import('../src/http.ts') as Record<string, any>;
const root = (tag: string) => realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), `pipe-u41-${tag}-`)));
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const T0 = new Date('2026-10-21T15:47:56.000Z');
const BACKOFF = 60_000;

function repoAt(dir: string) {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
  writeFileSync(join(dir, 'README.md'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base');
  return git;
}

/** A git that hangs on `worktree add` (marked so the test can prove the hang was stopped) and is real otherwise. */
function slowGit(dir: string, mark: string): string {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) exec /bin/sleep ${mark};; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  execFileSync(join(bin, 'git'), ['--version']);   // let macOS scan the new executable before any deadline runs
  return bin;
}
/** A sleep length unique to this test run, so a process left by any earlier run can never be mistaken for this one's. */
const uniq = () => `${1000 + Math.floor(Math.random() * 9000)}.${process.pid}${Date.now() % 100000}`;
const sleeping = (mark: string) => spawnSync('/usr/bin/pgrep', ['-f', `/bin/sleep ${mark}`], { encoding: 'utf8' }).stdout.trim();

function storeFixture(mutating: boolean) {
  const dir = root('store'), repo = join(dir, 'repo');
  repoAt(repo);
  let clock = T0;
  const store = new Store(join(dir, 'pipe.sqlite'), { retryBackoffMs: BACKOFF, now: () => clock });
  const request = store.submit({ requester: 'test', project: 'test', kind: 'code', provider: 'claude', model: 'opus',
    effort: 'high', reason: 'setup timeout', prompt: 'edit', mutating, priority: 'interactive', cwd: repo });
  const account = { id: 'claude-a', provider: 'claude' as const, loginDir: dir, fingerprint: '00000000', enabled: true, maxConcurrency: 1 };
  const evidence = () => ({ accountId: account.id, model: 'opus', observedAt: clock.toISOString(),
    verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read', 'Edit'] });
  const start = () => { const s = store.startAttempt(request.id, account, evidence()); assert.equal(s.ok, true, JSON.stringify(s)); return s.attempt; };
  const advance = () => { clock = new Date(clock.getTime() + BACKOFF); };   // past the recorded back-off
  return { dir, repo, store, request, start, advance, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const TIMEOUT_TEXT = 'could not create the worktree: git command timed out after 300000 ms';

test('S1 job worktree creation gets 300 s; review worktree creation keeps the base 120 s, inside the client 300 s header deadline', async () => {
  const r = await runner();
  assert.equal(r.WORKTREE_ADD_TIMEOUT_MS, 300_000);
  assert.equal((await review()).REVIEW_WORKTREE_ADD_TIMEOUT_MS, 120_000);
});

test('S2 a git timeout during setup is setup_timeout; disk-full text stays disk_full; anything else stays other', async () => {
  const r = await runner();
  assert.equal(r.setupKind(TIMEOUT_TEXT), 'setup_timeout');
  assert.equal(r.setupKind('could not create pipe/x: git command timed out after 60000 ms'), 'setup_timeout');
  assert.equal(r.setupKind('could not create the worktree: fatal: No space left on device'), 'disk_full');
  assert.equal(r.setupKind('could not create the worktree: fatal: invalid reference: main'), 'other');
});

test('S3 an untouched setup timeout re-queues changing work after the back-off, without blaming the account', () => {
  const f = storeFixture(true);
  try {
    const ended = f.store.finishAttempt(f.start().id, { kind: 'failed', errorKind: 'setup_timeout' as any, message: TIMEOUT_TEXT, untouched: true });
    assert.equal(ended.request?.state, 'queued', JSON.stringify(ended.request?.error));
    assert.deepEqual(ended.request?.avoid, []);
    assert.equal(ended.request?.notBefore, new Date(T0.getTime() + BACKOFF).toISOString());
    assert.equal(ended.request?.error?.kind, 'setup_timeout');
  } finally { f.close(); }
});

test('S4 read-only work is re-queued the same way', () => {
  const f = storeFixture(false);
  try {
    const ended = f.store.finishAttempt(f.start().id, { kind: 'failed', errorKind: 'setup_timeout' as any, message: TIMEOUT_TEXT, untouched: true });
    assert.equal(ended.request?.state, 'queued', JSON.stringify(ended.request?.error));
    assert.equal(ended.request?.notBefore, new Date(T0.getTime() + BACKOFF).toISOString());
  } finally { f.close(); }
});

test('S5 a setup timeout is retried once: the second one ends the request', () => {
  const f = storeFixture(true);
  try {
    const states: string[] = [];
    for (let n = 1; n <= 2; n++) {
      const ended = f.store.finishAttempt(f.start().id, { kind: 'failed', errorKind: 'setup_timeout' as any, message: TIMEOUT_TEXT, untouched: true });
      states.push(ended.request!.state);
      f.advance();
      if (n === 2) assert.match(ended.request?.error?.message ?? '', /after 2 setup timeouts/);
    }
    assert.deepEqual(states, ['queued', 'failed']);
  } finally { f.close(); }
});

test('S6 a setup timeout that left a workspace fails and keeps it', () => {
  const f = storeFixture(true);
  try {
    const workspace = { path: join(f.dir, 'trees', 'kept'), branch: 'pipe/kept', commit: 'uncommitted' };
    const ended = f.store.finishAttempt(f.start().id, { kind: 'failed', errorKind: 'setup_timeout' as any, message: TIMEOUT_TEXT, workspace });
    assert.equal(ended.request?.state, 'failed');
    assert.equal(ended.request?.workspace?.path, workspace.path);
  } finally { f.close(); }
});

test('S7 a hung worktree add is stopped at the run limit and reported as an untouched setup_timeout', { timeout: 60_000 }, async () => {
  const dir = root('run'), repo = join(dir, 'repo'), trees = join(dir, 'trees'), mark = uniq();
  repoAt(repo); mkdirSync(trees);
  const bin = slowGit(dir, mark);
  try {
    const started = Date.now(), events: any[] = [];
    for await (const event of run({ requestId: 'setup-timeout-run', accountId: 'claude-a', provider: 'claude', model: 'opus',
      effort: 'high', prompt: 'edit', mutating: true, cwd: repo, loginDir: dir },
    { cli: { claude: '/bin/true' }, env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, worktreeRoot: trees,
      worktreeAddTimeoutMs: 2_000 } as any)) events.push(event);
    const failure = events.find((event) => event.type === 'failed');
    assert.equal(failure?.errorKind, 'setup_timeout', failure?.message);
    assert.equal(failure?.untouched, true);
    assert.match(failure?.message ?? '', /timed out after 2000 ms/);
    assert.ok(Date.now() - started < 30_000, `the limit, not the default, ended it (${Date.now() - started} ms)`);
    assert.equal(existsSync(join(trees, 'setup-timeout-run')), false, 'nothing is left in the worktree root');
    assert.equal(execFileSync('git', ['-C', repo, 'branch', '--list', 'pipe/setup-timeout-run'], { encoding: 'utf8' }).trim(), '', 'the branch it made is gone');
    assert.equal(sleeping(mark), '', 'the hung git was stopped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S8 a review whose worktree add times out is refused with 503 setup_timeout and leaves no worktree', { timeout: 60_000 }, async () => {
  const rv = await review();
  const dir = root('review'), repo = join(dir, 'repo'), mark = uniq();
  const git = repoAt(repo);
  const bin = slowGit(dir, mark);
  const store = new Store(join(dir, 'record.sqlite'));
  try {
    const policy = parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } });
    const started = Date.now();
    const error = await rv.submitReview(store, policy, join(dir, 'worktrees'), { requester: 'unit', reason: 'check code', repo,
      head: git('rev-parse', 'HEAD'), brief: 'Check the commit.', seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] },
    { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, { worktreeAddTimeoutMs: 2_000 }).then(() => null, (e: unknown) => e);
    assert.ok(error, 'the review is refused');
    assert.equal((error as any).status, 503, String(error));
    assert.equal((error as any).code, 'setup_timeout');
    assert.match(String((error as Error).message), /not started/i);
    assert.ok(Date.now() - started < 30_000, 'the review limit, not 120 s, ended it');
    const reviews = store.runningReviews() as Array<{ setupFailed?: boolean; seats: unknown[] }>;
    assert.equal(reviews.length <= 1, true);
    if (reviews.length) { assert.equal(reviews[0]!.setupFailed, true); assert.equal(reviews[0]!.seats.length, 0); }
    const registered = git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length;
    assert.equal(registered, 1, 'only the main worktree is registered');
    assert.equal(sleeping(mark), '', 'the hung git was stopped');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function httpFixture(submit: () => Promise<unknown>) {
  const h = await http();
  const dir = root('http'), store = new Store(join(dir, 'pipe.sqlite')), logged: Array<[string, unknown]> = [];
  const token = 'u41-synthetic-token';
  const { server } = await h.startHttp({ store, token, policy: parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } }),
    accounts: () => [], accountIds: () => [], models: () => ({}), draining: () => false, drain: async () => {}, cancel: () => {},
    reviews: { submit, get: () => undefined, vote: () => undefined }, log: (where: string, error: unknown) => { logged.push([where, error]); } });
  const call = () => new Promise<{ status: number; body: any }>((resolve) => {
    const json = JSON.stringify({ requester: 'unit' });
    const req = Object.assign(Readable.from([Buffer.from(json)]), { method: 'POST', url: '/v1/reviews',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(json)) } });
    let status = 0;
    server.emit('request', req, { writeHead(code: number) { status = code; }, setHeader() {}, end(data: string) { resolve({ status, body: JSON.parse(data) }); } });
  });
  return { call, logged, close: () => { server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('S9 an unexpected error is logged with its route and still answered 500 request could not be handled', async () => {
  const thrown = new Error('git command timed out after 120000 ms');
  const f = await httpFixture(async () => { throw thrown; });
  try {
    const reply = await f.call();
    assert.equal(reply.status, 500);
    assert.deepEqual(reply.body, { error: { code: 'internal_error', message: 'request could not be handled' } });
    assert.equal(f.logged.length, 1, 'logged once');
    assert.match(f.logged[0]![0], /POST \/v1\/reviews/);
    assert.equal(f.logged[0]![1], thrown);
  } finally { f.close(); }
});

test('S10 an error with a status and a code is answered with both, and is not a 500', async () => {
  const f = await httpFixture(async () => { throw Object.assign(new Error('review setup timed out; the review was not started'), { status: 503, code: 'setup_timeout' }); });
  try {
    const reply = await f.call();
    assert.equal(reply.status, 503);
    assert.equal(reply.body?.error?.code, 'setup_timeout');
    assert.match(reply.body?.error?.message ?? '', /not started/);
    assert.equal(f.logged.length, 0, 'an answered refusal is not an internal error');
  } finally { f.close(); }
});

test('S11 the service passes its logger to the HTTP layer', async () => {
  // Static check: startPipe's startHttp call includes a log function (the 500s on 10-21 left nothing in pipe.log).
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'service.ts'), 'utf8');
  const at = source.indexOf('startHttp({');
  assert.ok(at >= 0, 'startPipe calls startHttp({ ... })');
  // The top-level keys of the object passed to startHttp (strings and template literals skipped).
  const keys: string[] = [];
  let depth = 0, segment = '', quote = '';
  for (let i = at + 'startHttp('.length; i < source.length; i++) {
    const c = source[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; if (depth === 1) segment += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('({['.includes(c)) { depth++; if (depth === 1) continue; }
    if (')}]'.includes(c)) { depth--; if (depth === 0) { keys.push(segment.trim()); break; } }
    if (depth === 1 && c === ',') { keys.push(segment.trim()); segment = ''; continue; }
    if (depth === 1) segment += c;
  }
  assert.ok(keys.some((k) => /^log\b/.test(k)), `startHttp receives a top-level log (keys: ${keys.map((k) => k.split(/[:\s(]/)[0]).join(', ')})`);
});

/** A git whose `worktree add` (optionally after really adding) leaves a background child that ignores TERM and has
 * closed its output, then hangs in the foreground. Every other command is real, except those `fail` names. */
function trickyGit(dir: string, opts: { child?: string; hang: string; realAdd?: boolean; lock?: boolean; fail?: string }): string {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const add = [
    opts.realAdd ? `"${realGit}" "$@" || exit $?` : '',
    opts.lock ? `for a; do prev2=$prev; prev=$a; done; "${realGit}" -C "$prev2" worktree lock --reason initializing "$prev2" || exit $?` : '',
    opts.child ? `( trap '' TERM; exec /bin/sleep ${opts.child} ) </dev/null >/dev/null 2>&1 &` : '',
    `exec /bin/sleep ${opts.hang}`,
  ].filter(Boolean).join('\n');
  const fail = opts.fail ? `*" ${opts.fail} "*) echo 'synthetic failure' >&2; exit 1;; ` : '';
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in ${fail}*" worktree add "*)\n${add}\n;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  execFileSync('/bin/sh', ['-n', join(bin, 'git')]);   // the fake must at least parse
  execFileSync(join(bin, 'git'), ['--version']);
  return bin;
}
const reviewPolicy = () => parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } });
const registered = (git: (...a: string[]) => string) => git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));

test('S12 a stopped setup git leaves no member of its process group alive before its timeout is reported untouched', { timeout: 60_000 }, async () => {
  const dir = root('group'), repo = join(dir, 'repo'), trees = join(dir, 'trees'), child = uniq(), hang = uniq();
  repoAt(repo); mkdirSync(trees);
  const bin = trickyGit(dir, { child, hang });
  try {
    const events: any[] = [];
    for await (const event of run({ requestId: 'setup-timeout-group', accountId: 'claude-a', provider: 'claude', model: 'opus',
      effort: 'high', prompt: 'edit', mutating: true, cwd: repo, loginDir: dir },
    { cli: { claude: '/bin/true' }, env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, worktreeRoot: trees,
      worktreeAddTimeoutMs: 2_000 } as any)) events.push(event);
    const failure = events.find((event) => event.type === 'failed');
    assert.equal(failure?.errorKind, 'setup_timeout', failure?.message);
    assert.equal(sleeping(child), '', 'the TERM-ignoring child of the stopped git is gone when the run reports');
    assert.equal(sleeping(hang), '');
    assert.equal(failure?.untouched, true, 'with the whole group proven gone, the setup is untouched');
  } finally {
    for (const pid of [sleeping(child), sleeping(hang)].join('\n').split('\n').filter(Boolean)) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S13 review timeout cleanup never prunes another worktree record of the repository', { timeout: 60_000 }, async () => {
  const rv = await review();
  const dir = root('noprune'), repo = join(dir, 'repo'), hang = uniq();
  const git = repoAt(repo);
  const other = join(dir, 'other-worktree');
  git('worktree', 'add', '-q', '--detach', other, 'HEAD');
  rmSync(other, { recursive: true, force: true });            // a stale record a prune would drop
  const bin = trickyGit(dir, { hang });
  const store = new Store(join(dir, 'record.sqlite'));
  try {
    const error = await rv.submitReview(store, reviewPolicy(), join(dir, 'worktrees'), { requester: 'unit', reason: 'check code', repo,
      head: git('rev-parse', 'HEAD'), brief: 'Check the commit.', seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] },
    { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, { worktreeAddTimeoutMs: 2_000 }).then(() => null, (e: unknown) => e);
    assert.equal((error as any)?.status, 503, String(error));
    assert.ok(registered(git).includes(realpathSync(dir) + '/other-worktree') || registered(git).includes(other), `the stale record survives: ${registered(git).join(', ')}`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('S14 a review whose own worktree was registered and locked (initializing), or whose worktree remove fails, is still refused 503', { timeout: 90_000 }, async () => {
  const rv = await review();
  for (const failRemove of [false, true]) {
    const dir = root(failRemove ? 'cleanfail' : 'locked'), repo = join(dir, 'repo'), hang = failRemove ? uniq() : uniq();
    const git = repoAt(repo);
    const bin = trickyGit(dir, { hang, realAdd: true, lock: true, ...(failRemove ? { fail: 'worktree remove' } : {}) });
    const store = new Store(join(dir, 'record.sqlite'));
    try {
      const error = await rv.submitReview(store, reviewPolicy(), join(dir, 'worktrees'), { requester: 'unit', reason: 'check code', repo,
        head: git('rev-parse', 'HEAD'), brief: 'Check the commit.', seats: [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' }] },
      { ...process.env, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }, { worktreeAddTimeoutMs: 2_000 }).then(() => null, (e: unknown) => e);
      assert.equal((error as any)?.status, 503, `${failRemove ? 'failing cleanup' : 'locked'}: ${String(error)}`);
      assert.equal((error as any)?.code, 'setup_timeout');
      assert.equal(sleeping(hang), '', 'the hung git was stopped');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

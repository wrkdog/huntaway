/**
 * Acceptance grader, lane U3 round 2 (lead-authored), from the two-family review of f32012a.
 * Sol 6 asked for a revision with six majors; Gemini approved, with a minor and two nits that
 * overlap Sol's. Every test names the finding it pins.
 *   R1 (Sol 1)   a limit is evidence: it names its account, its model scope and the pipe's time;
 *   R2 (Sol 2)   completed only when the process exited cleanly, or the runner stopped it after
 *                its outcome;
 *   R3 (Sol 3)   the kill grace is validated, and escalation runs on a monotonic clock;
 *   R4 (Sol 4)   "Not logged in" alone is not proof of a sign-out: without a reachable service
 *                it is offline (L11);
 *   R5 (Sol 5, Gemini nit)  rate limits and quota exhaustion stay distinct, in either CLI;
 *   R6 (Sol 6, Gemini minor)  a worktree made for a run that never started is removed, and a
 *                failed changing run says where its work is;
 *   R7 (Sol minor)  newer reset evidence for the same bucket is reported;
 *   R8 (Sol minor, Gemini nit)  text before the CLI's init cannot hide the reported model;
 *   R9 (Sol nit)  only read-only Codex runs skip the git-repository check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunEvent, type RunOptions, type RunSpec } from '../src/runner.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8').split('\n').filter((l) => l.trim() !== '');

type Step = { line?: string; stderr?: string; sleepMs?: number };
type Scenario = { steps: Step[]; exitCode?: number; ignoreTerm?: boolean; hang?: boolean; killSelf?: string };

function fakeCli(scenario: Scenario) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r2-cli-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const script = join(dir, 'cli');
  writeFileSync(script, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(path.join(__dirname, 'record-' + process.pid + '.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
if (sc.ignoreTerm) process.on('SIGTERM', () => {});
(async () => {
  for (const step of sc.steps) {
    if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
    if (step.line !== undefined) process.stdout.write(step.line + '\\n');
    if (step.stderr !== undefined) process.stderr.write(step.stderr + '\\n');
  }
  if (sc.killSelf) { await new Promise((r) => setTimeout(r, 50)); process.kill(process.pid, sc.killSelf); }
  if (sc.hang) await new Promise(() => { setInterval(() => {}, 1000); });
  process.exit(sc.exitCode ?? 0);
})();
`);
  chmodSync(script, 0o755);
  const records = () => readdirSync(dir).filter((f) => f.startsWith('record-'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { argv: string[]; cwd: string; pid: number });
  return { path: script, records };
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r2-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lead@example.invalid');
  git('config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}
const branches = (dir: string) => execFileSync('git', ['-C', dir, 'branch', '--list', 'pipe/*'], { encoding: 'utf8' }).trim();
const worktrees = (dir: string) => execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).length;

function spec(over: Partial<RunSpec> = {}): RunSpec {
  const login = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r2-login-')));
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`, accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'say OK', mutating: false, cwd: realpathSync(tmpdir()), loginDir: login, ...over,
  };
}
const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'en_US.UTF-8' });
/** Every test decides reachability itself: the real network never decides a result here. */
const offline = async () => false;
const online = async () => true;
const opts = (over: Partial<RunOptions> & { claude?: string; codex?: string } = {}): RunOptions => {
  const { claude, codex, ...rest } = over;
  return { cli: { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) }, env: env(), reachable: offline, ...rest };
};

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
function terminalOf(events: RunEvent[]): RunEvent {
  const terminals = events.filter((e) => e.type === 'completed' || e.type === 'failed');
  assert.equal(terminals.length, 1, `exactly one terminal event: ${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(events.at(-1), terminals[0], 'the terminal event is the last one');
  return terminals[0]!;
}
const kindOf = (e: RunEvent) => (e.type === 'failed' ? e.errorKind : e.type);
const INIT = fixture('claude-success.jsonl')[0]!;
const SUCCESS = fixture('claude-success.jsonl');

test('R1 a limit names its account, its model scope and the pipe\'s time; a run with no account never starts', async () => {
  const at = new Date('2026-09-24T12:00:00Z');
  const cli = fakeCli({ steps: fixture('claude-weekly-limit.jsonl').map((line) => ({ line })), exitCode: 1 });
  const events = await collect(run(spec({ accountId: 'claude-b' }), opts({ claude: cli.path, now: () => at })));
  const limit = events.find((e) => e.type === 'limit');
  assert.deepEqual(limit, {
    type: 'limit', accountId: 'claude-b', bucket: 'seven_day', model: null,
    resetsAt: new Date(1790000000 * 1000).toISOString(), observedAt: at.toISOString(),
  }, 'the service names no model scope, so the limit holds the whole account; the pipe\'s clock stamps it');
  for (const accountId of ['', undefined, 7, '-x'] as never[]) {
    const unused = fakeCli({ steps: SUCCESS.map((line) => ({ line })) });
    const done = terminalOf(await collect(run(spec({ accountId }), opts({ claude: unused.path }))));
    assert.equal(kindOf(done), 'other', `accountId ${JSON.stringify(accountId)}`);
    assert.equal(unused.records().length, 0, 'the CLI never starts for a run with no account');
  }
  const bad = fakeCli({ steps: SUCCESS.map((line) => ({ line })) });
  const done = terminalOf(await collect(run(spec(), opts({ claude: bad.path, now: () => new Date(Number.NaN) }))));
  assert.equal(kindOf(done), 'other', 'a pipe clock that cannot tell the time starts nothing');
  assert.equal(bad.records().length, 0);
});

test('R2 completed means the process exited cleanly, or was stopped by the runner after reporting success', async () => {
  const nonzero = fakeCli({ steps: SUCCESS.map((line) => ({ line })), exitCode: 3 });
  assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: nonzero.path }))))), 'other', 'a success line then exit 3 is a failure');
  const killed = fakeCli({ steps: SUCCESS.map((line) => ({ line })), killSelf: 'SIGKILL' });
  assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: killed.path }))))), 'other', 'a success line then a fatal signal is a failure');
  const lingers = fakeCli({ steps: SUCCESS.map((line) => ({ line })), hang: true, ignoreTerm: true });
  const done = terminalOf(await collect(run(spec(), opts({ claude: lingers.path, killGraceMs: 200 }))));
  assert.deepEqual(done, { type: 'completed', result: 'OK', workspace: null }, 'a CLI that reports success and lingers is stopped, and the run completes');
});

test('R3 the kill grace must be a real duration; escalation does not wait on the wall clock', async () => {
  for (const killGraceMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 120_000]) {
    const cli = fakeCli({ steps: SUCCESS.map((line) => ({ line })) });
    assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: cli.path, killGraceMs }))))), 'other', `killGraceMs ${killGraceMs}`);
    assert.equal(cli.records().length, 0, 'nothing starts on a malformed grace');
  }
  const cli = fakeCli({ steps: [{ line: INIT }], hang: true, ignoreTerm: true });
  const controller = new AbortController();
  const events: RunEvent[] = [];
  const real = Date.now;
  let stepped = false;
  Date.now = () => real() - (stepped ? 3_600_000 : 0);
  try {
    const running = (async () => { for await (const e of run(spec(), opts({ claude: cli.path, signal: controller.signal, killGraceMs: 300 }))) events.push(e); })();
    const until = real() + 5_000;
    while (!events.some((e) => e.type === 'started') && real() < until) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    setTimeout(() => { stepped = true; }, 50);   // the wall clock steps back an hour mid-escalation
    const ended = await Promise.race([running.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 4_000))]);
    assert.equal(ended, true, 'the run ended within 4 s of a SIGTERM-ignoring CLI, despite the clock step');
    assert.equal(kindOf(terminalOf(events)), 'cancelled');
  } finally {
    Date.now = real;
  }
});

test('R4 "Not logged in" alone is not a sign-out: without a reachable service it is offline (L11)', async () => {
  const ambiguous: Scenario = { steps: [{ line: 'Not logged in · Please run /login' }], exitCode: 1 };
  const cases: Array<[string, Scenario, () => Promise<boolean>, string]> = [
    ['ambiguous wording, service unreachable', ambiguous, offline, 'offline'],
    ['ambiguous wording, service reachable', ambiguous, online, 'auth'],
    ['the service refused the credentials', { steps: [{ stderr: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }], exitCode: 1 }, offline, 'auth'],
    ['connection error beside the login wording', { steps: [{ stderr: 'Error: getaddrinfo ENOTFOUND api.anthropic.com' }, { line: 'Not logged in · Please run /login' }], exitCode: 1 }, online, 'offline'],
  ];
  for (const [what, scenario, reachable, kind] of cases) {
    const cli = fakeCli(scenario);
    assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: cli.path, reachable }))))), kind, what);
  }
});

test('R5 rate limits and quota exhaustion stay distinct, whatever the CLI\'s wording', async () => {
  const claude: Array<[string, string]> = [
    ['Rate limit reached for requests', 'rate_limited'],
    ['API Error: 429 Too Many Requests', 'rate_limited'],
    ['Error: you have reached your weekly limit', 'quota_exhausted'],
    ["You've hit your usage limit", 'quota_exhausted'],
  ];
  for (const [said, kind] of claude) {
    const cli = fakeCli({ steps: [{ line: INIT }, { stderr: said }], exitCode: 1 });
    assert.equal(kindOf(terminalOf(await collect(run(spec(), opts({ claude: cli.path }))))), kind, said);
  }
  const codex = (message: string) => [
    { line: '{"type":"thread.started","thread_id":"t-1"}' },
    { line: JSON.stringify({ type: 'error', message }) },
    { line: JSON.stringify({ type: 'turn.failed', error: { message } }) },
  ];
  const rate = fakeCli({ steps: codex('Rate limit reached for gpt-6-sol. Please try again in 20s.'), exitCode: 1 });
  const rateEvents = await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol', accountId: 'codex-a' }), opts({ codex: rate.path })));
  assert.equal(kindOf(terminalOf(rateEvents)), 'rate_limited');
  assert.equal(rateEvents.filter((e) => e.type === 'limit').length, 0, 'a rate limit is not an exhausted bucket: nothing is held');
  const weekly = fakeCli({ steps: codex('You have reached your weekly limit.'), exitCode: 1 });
  const weeklyEvents = await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol', accountId: 'codex-a' }), opts({ codex: weekly.path })));
  assert.equal(kindOf(terminalOf(weeklyEvents)), 'quota_exhausted');
  assert.equal(weeklyEvents.filter((e) => e.type === 'limit').length, 1, 'Codex quota wording beyond "usage limit" is reported as a limit');
});

test('R6 a worktree made for a run that never started is removed; a failed changing run says where its work is', async () => {
  const worktreeRoot = () => realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r2-worktrees-')));
  const missing = repo();
  const noCli = terminalOf(await collect(run(spec({ mutating: true, cwd: missing }), opts({ claude: '/nonexistent/claude-cli', worktreeRoot: worktreeRoot() }))));
  assert.equal(kindOf(noCli), 'other');
  assert.equal(branches(missing), '', 'the branch made for a CLI that never started is removed');
  assert.equal(worktrees(missing), 1, 'and so is its worktree');
  const early = repo();
  const controller = new AbortController();
  controller.abort();
  const unused = fakeCli({ steps: SUCCESS.map((line) => ({ line })) });
  const cancelled = terminalOf(await collect(run(spec({ mutating: true, cwd: early }), opts({ claude: unused.path, worktreeRoot: worktreeRoot(), signal: controller.signal }))));
  assert.equal(kindOf(cancelled), 'cancelled');
  assert.equal(unused.records().length, 0);
  assert.equal(branches(early), '', 'a run cancelled before its CLI started leaves no branch');
  assert.equal(worktrees(early), 1, 'and no worktree');
  // Cancelled while its worktree was being made: the signal reads live once, then aborted.
  const racing = repo();
  let reads = 0;
  const midway = { get aborted() { reads += 1; return reads > 1; }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
  const late = fakeCli({ steps: SUCCESS.map((line) => ({ line })) });
  const lateDone = terminalOf(await collect(run(spec({ mutating: true, cwd: racing }), opts({ claude: late.path, worktreeRoot: worktreeRoot(), signal: midway }))));
  assert.equal(kindOf(lateDone), 'cancelled');
  assert.equal(late.records().length, 0);
  assert.equal(branches(racing), '', 'a run cancelled while its worktree was made removes the branch');
  assert.equal(worktrees(racing), 1, 'and the worktree');
  const partial = repo();
  const crashes = fakeCli({ steps: [{ line: INIT }, { stderr: 'Segmentation fault' }], exitCode: 139 });
  const s = spec({ mutating: true, cwd: partial });
  const done = terminalOf(await collect(run(s, opts({ claude: crashes.path, worktreeRoot: worktreeRoot() }))));
  assert.equal(done.type, 'failed');
  const workspace = done.type === 'failed' ? done.workspace : null;
  assert.ok(workspace && existsSync(workspace.path), 'the failed run names its worktree, which is kept for inspection');
  assert.equal(workspace?.branch, `pipe/${s.requestId}`);
  const readOnly = fakeCli({ steps: [{ line: INIT }], exitCode: 2 });
  const plain = terminalOf(await collect(run(spec(), opts({ claude: readOnly.path }))));
  assert.equal(plain.type === 'failed' ? plain.workspace : 'not failed', null, 'read-only work has no workspace');
});

test('R7 newer reset evidence for the same bucket is reported; an exact repeat is not', async () => {
  const limit = (resetsAt: number) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt } });
  const cli = fakeCli({ steps: [{ line: INIT }, { line: limit(1790000000) }, { line: limit(1790000000) }, { line: limit(1790003600) }], exitCode: 1 });
  const limits = (await collect(run(spec(), opts({ claude: cli.path })))).filter((e) => e.type === 'limit');
  assert.deepEqual(limits.map((e) => (e.type === 'limit' ? e.resetsAt : null)),
    [new Date(1790000000 * 1000).toISOString(), new Date(1790003600 * 1000).toISOString()]);
});

test('R8 text before the CLI\'s init cannot hide the model the service reported', async () => {
  const text = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'early' }] } });
  const cli = fakeCli({ steps: [{ line: text }, { line: INIT }, ...SUCCESS.slice(1).map((line) => ({ line }))] });
  const events = await collect(run(spec(), opts({ claude: cli.path })));
  assert.equal(events[0]!.type, 'started');
  assert.equal(events.filter((e) => e.type === 'started').length, 1);
  assert.equal(events[0]!.type === 'started' ? events[0]!.reportedModel : null, 'claude-sonnet-5');
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'early'), 'the early text is still delivered');
  assert.equal(kindOf(terminalOf(events)), 'completed');
});

test('R9 only a read-only Codex run skips the git-repository check', async () => {
  const lines = fixture('codex-success.jsonl').map((line) => ({ line }));
  const readOnly = fakeCli({ steps: lines });
  terminalOf(await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol', accountId: 'codex-a' }), opts({ codex: readOnly.path }))));
  assert.ok(readOnly.records()[0]!.argv.includes('--skip-git-repo-check'), 'read-only work may run outside a repository');
  const changing = fakeCli({ steps: lines });
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3r2-worktrees-')));
  terminalOf(await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol', accountId: 'codex-a', mutating: true, cwd: repo() }), opts({ codex: changing.path, worktreeRoot }))));
  assert.ok(!changing.records()[0]!.argv.includes('--skip-git-repo-check'), 'changing work always runs in a worktree');
});

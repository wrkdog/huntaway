/**
 * Acceptance grader, lane U9: changing work that never started is requeued (lead-authored; the
 * implementation lane must not edit it).
 *
 * On 2026-09-25 an outage at OpenAI's end made every Codex call on one account fail with 401. Three changing requests
 * were failed for good although they had done nothing: their worktrees were clean. The pipe's rule applies: a temporary
 * outage is never marked permanent. A changing attempt that fails with a temporary kind (sign-in, a limit) before any
 * work goes back to the queue. "Before any work" means that no tool call ran, and its worktree is exactly as made: the
 * same HEAD and an empty `git status`. Anything else fails as today, with its worktree kept for inspection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunEvent, type RunOptions, type RunSpec } from '../src/runner.ts';
import { startPipe } from '../src/service.ts';
import { Store } from '../src/store.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIX), 'utf8').split('\n').filter((l) => l.trim() !== '');
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
const POLICY = {
  claude: { models: { opus: 'default', fable: 'hard', 'claude-opus-5-5': 'hard' }, efforts: ['low', 'medium', 'high', 'max'] },
  codex: { models: { 'gpt-6-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'ultra'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withModel = (lines: string[], model: string) => lines.map((l) => {
  const o = JSON.parse(l); if (o.type === 'system' && o.subtype === 'init') o.model = model; return JSON.stringify(o);
});

// ---- What the CLIs say ------------------------------------------------------------------------------------------

const INIT = withModel([fixture('claude-success.jsonl')[0]!], 'opus')[0]!;
const claudeFails = (message: string) => JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's-1', errors: [{ message }] });
const SIGN_IN = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
const RATE = 'API Error: 429 Too Many Requests: rate limit reached, please slow down';
const WEEKLY = 'You\'ve hit your weekly usage limit. Resets Sep 21 at 2:13pm (UTC).';
const CLAUDE_TOOL = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'true' } }] } });
const CODEX_401 = 'unexpected status 401 Unauthorized: Incorrect API key provided';
const CODEX_TOOL = JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'true', status: 'in_progress' } });
const codexFails = (message: string) => [
  JSON.stringify({ type: 'error', message }),
  JSON.stringify({ type: 'turn.failed', error: { message } }),
];

// ---- Runner-level harness ---------------------------------------------------------------------------------------

/** A step prints a line, or changes the worktree it runs in without saying so (as a hook or a stray write might). */
type Step = { line: string } | { write: string } | { commit: true } | { holdOpen: number };
function fakeCli(steps: Step[], exitCode = 1) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u9-cli-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ steps, exitCode }));
  const script = join(dir, 'cli');
  writeFileSync(script, `#!${process.execPath}
const fs = require('fs'), path = require('path'), cp = require('child_process');
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
try { fs.readFileSync(0, 'utf8'); } catch {}
for (const s of sc.steps) {
  if (s.line !== undefined) process.stdout.write(s.line + String.fromCharCode(10));
  else if (s.write !== undefined) fs.appendFileSync(path.join(process.cwd(), s.write), 'changed' + String.fromCharCode(10));
  else if (s.commit) cp.execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'moved'], { cwd: process.cwd() });
  // A descendant in a group of its own keeps stdout open after this process exits.
  else if (s.holdOpen) cp.spawn('sleep', [String(s.holdOpen)], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
}
process.exitCode = sc.exitCode;   // not exit(): let a large write flush first
`);
  chmodSync(script, 0o755);
  return script;
}
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u9-repo-')));
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
function changing(cwd: string, provider: 'claude' | 'codex' = 'claude'): { spec: RunSpec; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u9-wt-')));
  return { root, spec: {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`, accountId: provider === 'claude' ? 'claude-a' : 'codex-a', provider,
    model: provider === 'claude' ? 'opus' : 'gpt-6-sol', effort: 'high', prompt: 'change the readme', mutating: true, cwd,
    loginDir: realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u9-login-'))),
  } };
}
const opts = (cli: string, provider: 'claude' | 'codex', worktreeRoot: string, killGraceMs?: number): RunOptions => ({
  cli: { [provider]: cli }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
  worktreeRoot, reachable: async () => true, ...(killGraceMs === undefined ? {} : { killGraceMs }),
});
async function terminal(events: AsyncIterable<RunEvent>): Promise<Extract<RunEvent, { type: 'completed' | 'failed' }>> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  const ends = out.filter((e) => e.type === 'completed' || e.type === 'failed');
  assert.equal(ends.length, 1, JSON.stringify(out.map((e) => e.type)));
  return ends[0] as Extract<RunEvent, { type: 'completed' | 'failed' }>;
}

// ---- Runner: what counts as "before any work" -------------------------------------------------------------------

test('U1 a changing Claude run that fails on sign-in before any tool, with its worktree untouched, leaves nothing behind', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'auth', end.message);
  assert.equal(end.workspace, null, 'an untouched worktree is not kept');
  assert.equal(branches(work), '', 'its branch is removed');
  assert.equal(worktrees(work), 1, 'only the main worktree is left');
});

test('U2 a limit (rate or allowance) before any work is treated the same way', async () => {
  for (const message of [RATE, WEEKLY]) {
    const work = repo();
    const { spec, root } = changing(work);
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: claudeFails(message) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(['rate_limited', 'quota_exhausted'].includes(end.errorKind), `${message}: ${end.errorKind}`);
    assert.equal(end.workspace, null, `${message}: an untouched worktree is not kept`);
    assert.equal(branches(work), '', message);
  }
});

test('U3 a tool call before the failure means work may have happened: the worktree is kept', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: CLAUDE_TOOL }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'auth');
  assert.ok(end.workspace && existsSync(end.workspace.path), 'the worktree is kept for inspection');
  assert.notEqual(branches(work), '');
});

test('U4 a changed file, or a moved HEAD, keeps the worktree even with no tool call reported', async () => {
  for (const change of [{ write: 'README.md' }, { write: 'new.txt' }, { commit: true }] as Step[]) {
    const work = repo();
    const { spec, root } = changing(work);
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, change, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(end.workspace && existsSync(end.workspace.path), `${JSON.stringify(change)}: the worktree is kept`);
  }
});

test('U5 Codex: a 401 before any item is untouched; a command item before it keeps the worktree', async () => {
  const quiet = repo();
  const a = changing(quiet, 'codex');
  const first = await terminal(run(a.spec, opts(fakeCli([{ line: '{"type":"thread.started","thread_id":"t-1"}' }, ...codexFails(CODEX_401).map((line) => ({ line }))]), 'codex', a.root)));
  assert.equal(first.type, 'failed');
  if (first.type !== 'failed') return;
  assert.equal(first.errorKind, 'auth', first.message);
  assert.equal(first.workspace, null);
  assert.equal(branches(quiet), '');
  const busy = repo();
  const b = changing(busy, 'codex');
  const second = await terminal(run(b.spec, opts(fakeCli([{ line: '{"type":"thread.started","thread_id":"t-2"}' }, { line: CODEX_TOOL }, ...codexFails(CODEX_401).map((line) => ({ line }))]), 'codex', b.root)));
  assert.equal(second.type, 'failed');
  if (second.type !== 'failed') return;
  assert.ok(second.workspace && existsSync(second.workspace.path), 'a started command keeps the worktree');
});

test('U6 a failure that is not temporary keeps the worktree as today, untouched or not', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: claudeFails('the model refused the task') }]), 'claude', root)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'other');
  assert.ok(end.workspace && existsSync(end.workspace.path));
});

// ---- Service: the request goes back to the queue ----------------------------------------------------------------

/** One fake `claude` for the service: probes answer from the U4 captures; job n runs plan[n]; jobs past the plan succeed. */
function fakeClaude(plan: Array<'auth' | 'auth-after-tool' | 'ok'>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u9-claude-')));
  const ok = withModel(fixture('claude-success.jsonl'), 'claude-opus-5-5').join('\n') + '\n';
  const init = withModel([fixture('claude-success.jsonl')[0]!], 'claude-opus-5-5')[0]!;
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    version: u4('claude-version').stdout, authStatus: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout,
    ok, fail: `${init}\n${claudeFails(SIGN_IN)}\n`, tool: `${init}\n${CLAUDE_TOOL}\n${claudeFails(SIGN_IN)}\n`, plan,
  }));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '--version') process.stdout.write(sc.version);
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.authStatus));
else if (a[0] === '-p' && a[1] === '/usage') {
  const at = (ms) => { const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return q.month + ' ' + q.day + ' at ' + q.hour + ':' + q.minute + q.dayPeriod.toLowerCase(); };
  const NL = String.fromCharCode(10), RESET = new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m', 'u');
  const result = sc.usage.result.split(NL).map((l) => l.replace(RESET, 'resets ' + at(Date.now() + (l.startsWith('Current session') ? 3 : 96) * 3600000))).join(NL);
  process.stdout.write(JSON.stringify({ ...sc.usage, result }));
} else {
  try { fs.readFileSync(0); } catch {}
  const count = p.join(__dirname, 'jobs'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));
  const step = sc.plan[n] ?? 'ok';
  if (step === 'auth') { process.stdout.write(sc.fail); process.exitCode = 1; }
  else if (step === 'auth-after-tool') { process.stdout.write(sc.tool); process.exitCode = 1; }
  else process.stdout.write(sc.ok);
}
`);
  chmodSync(path, 0o755);
  return path;
}

async function pipe(o: { plan: Array<'auth' | 'auth-after-tool' | 'ok'>; maxLimits?: number; authHoldMs?: number }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u9-')));
  const login = join(root, 'login-claude-a');
  mkdirSync(login, { recursive: true });
  const fake = fakeClaude(o.plan);
  const storePath = join(root, 'pipe.sqlite');
  const handle = await startPipe({
    accounts: [{ id: 'claude-a', provider: 'claude', loginDir: login, fingerprint: sha8('<orgId>'), maxConcurrency: 1, enabled: true }],
    policy: POLICY, storePath, worktreeRoot: join(root, 'worktrees'),
    cli: { claude: fake }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000,
    ...(o.maxLimits === undefined ? {} : { maxLimits: o.maxLimits }),
    ...(o.authHoldMs === undefined ? {} : { authHoldMs: o.authHoldMs, authHoldMaxMs: o.authHoldMs }),
  } as Parameters<typeof startPipe>[0]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  const jobsRun = () => { try { return Number(readFileSync(join(fake, '..', 'jobs'), 'utf8')); } catch { return 0; } };
  return { ...handle, call, jobsRun, storePath };
}
const ask = (cwd: string) => ({ requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
  reason: 'a routine change', prompt: 'change the readme', mutating: true, cwd, priority: 'interactive' });
async function settled(p: Awaited<ReturnType<typeof pipe>>, id: string, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await p.call('GET', `/v1/requests/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(r.json.request?.state)) return r.json.request as Record<string, any>;
    if (Date.now() > end) assert.fail(`request ${id} did not finish: ${r.text.slice(0, 400)}`);
    await sleep(50);
  }
}

test('S1 a changing request whose first attempt failed on sign-in before any work runs again and completes', async () => {
  const work = repo();
  const p = await pipe({ plan: ['auth', 'ok'] });
  let id = '';
  try {
    const made = await p.call('POST', '/v1/requests', ask(work));
    assert.equal(made.status, 201, made.text);
    id = made.json.request.id;
    const done = await settled(p, id);
    assert.equal(done.state, 'completed', JSON.stringify(done.error));
    assert.equal(p.jobsRun(), 2);
    assert.ok(done.workspace && existsSync(done.workspace.path), 'the completed attempt\'s worktree is the one kept');
    assert.equal(branches(work).split('\n').filter(Boolean).length, 1, `one pipe branch: ${branches(work)}`);
  } finally { await p.stop(); }
  const store = new Store(p.storePath);
  try {
    const attempts = store.attempts(id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.outcome?.kind, 'failed');
    assert.equal((attempts[0]!.outcome as { errorKind?: string }).errorKind, 'auth', 'the record keeps the real cause');
  } finally { store.close(); }
});

test('S2 a changing request that failed on sign-in after a tool call fails as before, with its worktree kept', async () => {
  const work = repo();
  const p = await pipe({ plan: ['auth-after-tool'] });
  try {
    const made = await p.call('POST', '/v1/requests', ask(work));
    const done = await settled(p, made.json.request.id);
    assert.equal(done.state, 'failed');
    assert.match(String(done.error?.message), /never re-run/);
    assert.ok(done.workspace && existsSync(done.workspace.path));
    assert.equal(p.jobsRun(), 1, 'it is not run again');
  } finally { await p.stop(); }
});

test('S3 requeueing is bounded: repeated sign-in failures before any work end the request, leaving nothing behind', async () => {
  const work = repo();
  const p = await pipe({ plan: ['auth', 'auth', 'auth', 'auth', 'auth', 'auth'], maxLimits: 2, authHoldMs: 50 });
  try {
    const made = await p.call('POST', '/v1/requests', ask(work));
    const done = await settled(p, made.json.request.id);
    assert.equal(done.state, 'failed');
    assert.match(String(done.error?.message), /sign-in/);
    assert.ok(p.jobsRun() >= 2 && p.jobsRun() <= 3, `bounded by maxLimits: ${p.jobsRun()} jobs`);
    assert.equal(branches(work), '', 'no attempt left a branch');
    assert.equal(worktrees(work), 1);
  } finally { await p.stop(); }
});

// ---- With U8: a full disk is temporary too ------------------------------------------------------------

test('U7 a changing run that fails on a full disk before any tool, with its worktree untouched, leaves nothing behind', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: claudeFails('ENOSPC: no space left on device, write') }]), 'claude', root)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'disk_full', end.message);
  assert.equal(end.workspace, null, 'an untouched worktree is not kept');
  assert.equal(branches(work), '');
});

// ---- Round 2 (Sol on 6e086b7) -----------------------------------------------------------------------------------

test('U8 a stdout line too large to read might have been a tool call: the worktree is kept, never untouched', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  // A tool_use event padded past the runner's 1 MiB line limit: it is dropped unread.
  const huge = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'Bash', input: { command: 'true', pad: 'x'.repeat(1_100_000) } }] } });
  const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: huge }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.equal(end.errorKind, 'auth');
  assert.ok(end.workspace && existsSync(end.workspace.path), 'without proof of no tool call, the worktree is kept');
  assert.notEqual((end as { untouched?: boolean }).untouched, true);
});

test('U9 Claude tool detection fails closed: an assistant block that is not text or thinking, or a tool result, counts', async () => {
  for (const line of [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'mcp_tool_use', id: 'x', name: 'y', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }),
  ]) {
    const work = repo();
    const { spec, root } = changing(work);
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(end.workspace && existsSync(end.workspace.path), `${line.slice(0, 80)}: the worktree is kept`);
  }
});

// ---- Round 3 (Sol on d13e397) -----------------------------------------------------------------------------------

test('U10 a stdout the runner had to cut off before its end was not fully read: the worktree is kept', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: claudeFails(SIGN_IN) }, { holdOpen: 3 }]), 'claude', root, 200)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.ok(end.workspace && existsSync(end.workspace.path), 'without reading stdout to its end, there is no proof of no tool call');
  assert.notEqual((end as { untouched?: boolean }).untouched, true);
});

test('U11 a malformed Claude content block counts as a possible tool call', async () => {
  const work = repo();
  const { spec, root } = changing(work);
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [null, ['x'], 'text?'] } });
  const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.ok(end.workspace && existsSync(end.workspace.path), 'the worktree is kept');
});

test('U12 any stdout line that is not a JSON event might have been a tool call: both CLIs write only JSON there', async () => {
  // Round 6: a banner counts too (event-like text need not start with a brace).
  const cases: Array<[string, boolean]> = [['{"type":"assistant","message":{"content":[{"type":"tool_use"', true], ['Welcome to the CLI', true],
    ['event: {"type":"assistant","message":{"content":[{"type":"tool_use"}]}}', true]];
  for (const [line, keeps] of cases) {
    const work = repo();
    const { spec, root } = changing(work);
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.equal(!!(end.workspace && existsSync(end.workspace.path)), keeps, `${line}: ${keeps ? 'kept' : 'untouched and removed'}`);
  }
});

// ---- Round 4 (Sol on 953314a) -----------------------------------------------------------------------------------

test('U13 a Claude assistant event without a message, or with content that is not text or a block list, counts', async () => {
  for (const event of [
    { type: 'assistant', message: { role: 'assistant', content: { type: 'tool_use', id: 'x', name: 'Bash', input: {} } } },
    { type: 'assistant', message: { role: 'assistant' } },
    { type: 'assistant' },
  ]) {
    const work = repo();
    const { spec, root } = changing(work);
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: JSON.stringify(event) }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(end.workspace && existsSync(end.workspace.path), `${JSON.stringify(event)}: the worktree is kept`);
  }
});

test('U14 Codex: every item event counts, item.updated included', async () => {
  const work = repo();
  const { spec, root } = changing(work, 'codex');
  const updated = JSON.stringify({ type: 'item.updated', item: { id: 'item_1', type: 'command_execution', command: 'true', status: 'in_progress' } });
  const end = await terminal(run(spec, opts(fakeCli([{ line: '{"type":"thread.started","thread_id":"t-3"}' }, { line: updated }, ...codexFails(CODEX_401).map((line) => ({ line }))]), 'codex', root)));
  assert.equal(end.type, 'failed');
  if (end.type !== 'failed') return;
  assert.ok(end.workspace && existsSync(end.workspace.path), 'a command reported by item.updated keeps the worktree');
});

// ---- Round 5 (Sol on b2fc26a) -----------------------------------------------------------------------------------

test('U15 only provably plain output is exempt: a text or thinking block with a malformed payload counts, for both CLIs', async () => {
  for (const block of [{ type: 'text', text: { cmd: 'rm' } }, { type: 'thinking' }, { type: 'redacted_thinking', data: 7 }]) {
    const work = repo();
    const { spec, root } = changing(work);
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [block] } });
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(end.workspace && existsSync(end.workspace.path), `${JSON.stringify(block)}: the worktree is kept`);
  }
  for (const item of [{ id: 'i', type: 'agent_message', text: { cmd: 'rm' } }, { id: 'r', type: 'reasoning', text: 1 },
    { id: 'e', type: 'error' }, { id: 't', type: 'todo_list', items: 'x' }]) {
    const w = repo();
    const c = changing(w, 'codex');
    const odd = JSON.stringify({ type: 'item.completed', item });
    const end = await terminal(run(c.spec, opts(fakeCli([{ line: '{"type":"thread.started","thread_id":"t-4"}' }, { line: odd }, ...codexFails(CODEX_401).map((line) => ({ line }))]), 'codex', c.root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(end.workspace && existsSync(end.workspace.path), `a Codex ${item.type} with a malformed payload keeps the worktree`);
  }
});

// ---- Round 6 (Sol on 8a7a958) -----------------------------------------------------------------------------------

test('U16 Claude: string content, and any user event, count as possible tool calls', async () => {
  for (const event of [
    { type: 'assistant', message: { role: 'assistant', content: 'plain text' } },
    { type: 'user', message: { role: 'user', content: 'anything' } },
    { type: 'user' },
  ]) {
    const work = repo();
    const { spec, root } = changing(work);
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line: JSON.stringify(event) }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.ok(end.workspace && existsSync(end.workspace.path), `${JSON.stringify(event)}: the worktree is kept`);
  }
});

// ---- Round 7 (Sol on 294404c) -----------------------------------------------------------------------------------

test('U17 a whitespace-only stdout line is not a JSON event: it counts; an empty line carries nothing and does not', async () => {
  for (const [line, keeps] of [['   \t', true], ['', false]] as Array<[string, boolean]>) {
    const work = repo();
    const { spec, root } = changing(work);
    const end = await terminal(run(spec, opts(fakeCli([{ line: INIT }, { line }, { line: claudeFails(SIGN_IN) }]), 'claude', root)));
    assert.equal(end.type, 'failed');
    if (end.type !== 'failed') return;
    assert.equal(!!(end.workspace && existsSync(end.workspace.path)), keeps, `${JSON.stringify(line)}: ${keeps ? 'kept' : 'untouched'}`);
  }
});

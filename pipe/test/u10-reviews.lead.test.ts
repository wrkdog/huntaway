/**
 * Acceptance grader, lane U10: reviews as a service (lead-authored; the implementation lane must not edit it).
 *
 * The aim: a proper multi-family review that is easy to submit. A requester sends
 * a repository, an exact head, a brief and the seats it wants. The pipe makes a clean detached worktree at that head,
 * runs each seat as a read-only request through itself, parses one JSON verdict per seat, and writes an approval
 * receipt with its quorum. It never merges. Seats the pipe cannot run itself (Gemini, which runs only in its own seat
 * session) add their votes afterwards; those votes are marked external.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startPipe } from '../src/service.ts';
import { lastVerdict } from '../src/review.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
/** Runs the CLI without blocking this process, which hosts the pipe it calls. */
const runCli = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env }, (err, stdout, stderr) =>
    resolve({ status: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
});
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
const POLICY = {
  claude: { models: { opus: 'default', 'claude-opus-5-5': 'hard' }, efforts: ['low', 'medium', 'high', 'max'] },
  codex: { models: { 'gpt-6.1-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'ultra'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codexApp = Object.fromEntries((u4('codex-app-server.signed-in') as Array<{ method: string; response: object }>).map((e) => [e.method, e.response]));
// The recorded model list (CLI 0.156.1) predates GPT-6.1 Sol; a current CLI (0.159.1 and later) offers it, and Sol 6.0
// was retired on 2026-09-30. The recording stays as evidence; this copy adds the current model.
const listed = codexApp['model/list'] as { result: { data: Array<Record<string, unknown>> } };
listed.result.data = [{ ...listed.result.data.find((m) => m.id === 'gpt-6-sol'), id: 'gpt-6.1-sol' }, ...listed.result.data];

/**
 * What a seat answers. `approve`/`revise` answer with a verdict naming the commit its worktree is at (approve with a
 * 12-character prefix, as reviewers often do);
 * `wrong-head` names another commit; `prose` has no JSON verdict; `fail` ends the job with an error; `slow` keeps
 * working, shrugging off SIGTERM, and records whether its folder vanished while it still ran.
 */
type Answer = 'approve' | 'revise' | 'wrong-head' | 'prose' | 'fail' | 'slow' | 'old-opus-approve' | 'old-opus-revise';

/** A fake CLI for either provider: probes answer from the U4 captures; each job records its prompt, cwd, HEAD and status. */
function fakeCli(kind: 'claude' | 'codex', answer: Answer): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pipe-u10-${kind}-`)));
  const init = JSON.parse(readFileSync(new URL('claude-success.jsonl', FIX), 'utf8').split('\n')[0]!);
  init.model = 'claude-opus-5-5';
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    kind, answer, init, app: codexApp,
    version: kind === 'claude' ? u4('claude-version').stdout : u4('codex-version').stdout,
    authStatus: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout,
  }));
  const path = join(dir, kind);
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path'), cp = require('child_process');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2), NL = String.fromCharCode(10);
const out = (o) => process.stdout.write(JSON.stringify(o) + NL);
if (a[0] === '--version') process.stdout.write(sc.version);
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.authStatus));
else if (a[0] === '-p' && a[1] === '/usage') {
  const at = (ms) => { const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return q.month + ' ' + q.day + ' at ' + q.hour + ':' + q.minute + q.dayPeriod.toLowerCase(); };
  const RESET = new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m', 'u');
  const result = sc.usage.result.split(NL).map((l) => l.replace(RESET, 'resets ' + at(Date.now() + (l.startsWith('Current session') ? 3 : 96) * 3600000))).join(NL);
  process.stdout.write(JSON.stringify({ ...sc.usage, result }));
} else if (a[0] === 'app-server') {
  // The recorded Codex limits reset at a fixed instant (2026-09-28 19:03:47 UTC); keep them in the future, as the
  // Claude usage above is, so the fixture never expires into an unknown allowance.
  const fresh = (k, v) => k === 'resetsAt' && typeof v === 'number' ? Math.floor(Date.now() / 1000) + 96 * 3600 : v;
  let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { buf += chunk; let n;
    while ((n = buf.indexOf(NL)) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue; process.stdout.write(JSON.stringify({ id: m.id, ...(sc.app[m.method] || { result: {} }) }, fresh) + NL); }
  });
} else {
  let prompt = ''; try { prompt = fs.readFileSync(0, 'utf8'); } catch {}
  const git = (...args) => { try { return cp.execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim(); } catch (e) { return 'git failed'; } };
  const n = fs.readdirSync(__dirname).filter((f) => f.startsWith('job-')).length;
  const aTs = p.join(process.cwd(), 'src', 'a.ts');
  fs.writeFileSync(p.join(__dirname, 'job-' + n + '.json'), JSON.stringify({ prompt, cwd: process.cwd(), head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), argv: a,
    a: fs.existsSync(aTs) ? fs.readFileSync(aTs, 'utf8') : null }));
  if (sc.answer === 'slow') {
    // A CLI still finishing its turn: it ignores SIGTERM until SIGKILL, and watches the folder it runs in.
    const here = process.cwd(), nap = new Int32Array(new SharedArrayBuffer(4));
    process.on('SIGTERM', () => {});
    fs.writeFileSync(p.join(__dirname, 'slow-started'), '');
    for (const end = Date.now() + 8000; Date.now() < end;) {
      if (!fs.existsSync(here)) { fs.writeFileSync(p.join(__dirname, 'cwd-vanished'), ''); break; }
      Atomics.wait(nap, 0, 0, 50);
    }
  }
  // A reviewer names the commit it checked: the one its worktree is at.
  const shown = git('rev-parse', 'HEAD');
  const verdict = (v, head) => JSON.stringify({ verdict: v, head, findings: v === 'REVISE' ? [{ severity: 'major', file: 'src/a.ts', line: 1, summary: 'a real problem' }] : [], unknowns: [] });
  const text = sc.answer === 'approve' || sc.answer === 'old-opus-approve' ? 'Checked the diff.' + NL + verdict('APPROVE', shown.slice(0, 12))
    : sc.answer === 'revise' || sc.answer === 'old-opus-revise' ? verdict('REVISE', shown)
    : sc.answer === 'wrong-head' ? verdict('APPROVE', 'deadbeefdeadbeef')
    : 'Looks fine to me, approve.';
  if (sc.kind === 'claude') {
    // The opus alias resolved to an older Opus: the same family, so no model mismatch, but off the review list.
    out(sc.answer.startsWith('old-opus-') ? { ...sc.init, model: 'claude-opus-4-7' } : sc.init);
    if (sc.answer === 'fail') { out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [{ message: 'the model refused the task' }] }); process.exitCode = 1; }
    else { out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }); out({ type: 'result', subtype: 'success', is_error: false, result: text }); }
  } else {
    out({ type: 'thread.started', thread_id: 'thread-' + n });
    if (sc.answer === 'fail') { out({ type: 'turn.failed', error: { message: 'the model refused the task' } }); process.exitCode = 1; }
    else { out({ type: 'item.completed', item: { id: 'i-1', type: 'agent_message', text } }); out({ type: 'turn.completed', usage: {} }); }
  }
}
`);
  chmodSync(path, 0o755);
  return path;
}
const jobs = (cli: string): Array<{ prompt: string; cwd: string; head: string; status: string; argv: string[]; a: string | null }> =>
  readdirSync(join(cli, '..')).filter((f) => f.startsWith('job-')).sort().map((f) => JSON.parse(readFileSync(join(cli, '..', f), 'utf8')));

function repo(): { dir: string; base: string; head: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u10-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lead@example.invalid');
  git('config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the change under review');
  const head = git('rev-parse', 'HEAD');
  // The requester's own checkout is dirty and elsewhere: the review must not use it.
  writeFileSync(join(dir, 'README.md'), 'uncommitted edits in the requester\'s checkout\n');
  return { dir, base, head };
}
const worktreeCount = (dir: string) => execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('worktree ')).length;

async function pipe(answers: { claude: Answer; codex: Answer }, gitDir?: string, reuse?: string) {
  // `reuse` restarts on another pipe's store and worktree root, as after a crash.
  const root = reuse ?? realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u10-')));
  const claude = fakeCli('claude', answers.claude), codex = fakeCli('codex', answers.codex);
  const login = (id: string) => { const d = join(root, `login-${id}`); mkdirSync(d, { recursive: true }); return d; };
  const handle = await startPipe({
    accounts: [
      { id: 'claude-a', provider: 'claude', loginDir: login('claude-a'), fingerprint: sha8('<orgId>'), maxConcurrency: 1, enabled: true },
      { id: 'codex-a', provider: 'codex', loginDir: login('codex-a'), fingerprint: sha8('<chatgptAccountId>'), maxConcurrency: 1, enabled: true },
    ],
    policy: POLICY, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'),
    cli: { claude, codex }, env: { PATH: `${gitDir ? `${gitDir}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000,
  } as Parameters<typeof startPipe>[0]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  return { ...handle, call, claude, codex, root };
}
type P = Awaited<ReturnType<typeof pipe>>;

const BRIEF = 'Review lane X.\nCost fence: prepaid subscriptions only; stop on any limit.\nCheck that src/a.ts exports a.\n';
const SEATS = [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { provider: 'claude', model: 'opus', effort: 'high' }];
const BUILDERS = [{ family: 'openai', context: 'pipe-request-builder-1' }];
const review = (r: { dir: string; base: string; head: string }, over: Record<string, unknown> = {}) => ({
  requester: 'lead', reason: 'the two-family gate for lane X', repository: 'example/repo', repo: r.dir, head: r.head, base: r.base,
  brief: BRIEF, seats: SEATS, builders: BUILDERS, priority: 'interactive', ...over,
});
async function finished(p: P, id: string, ms = 20_000): Promise<Record<string, any>> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await p.call('GET', `/v1/reviews/${id}`);
    assert.equal(r.status, 200, r.text);
    if (r.json.review?.state === 'finished') return r.json.review;
    if (Date.now() > end) assert.fail(`review ${id} did not finish: ${r.text.slice(0, 600)}`);
    await sleep(100);
  }
}
async function submitted(p: P, body: unknown): Promise<string> {
  const r = await p.call('POST', '/v1/reviews', body);
  assert.equal(r.status, 201, r.text);
  assert.ok(typeof r.json.review?.id === 'string', r.text);
  return r.json.review.id;
}

// ---- The happy path, and the receipt ----------------------------------------------------------------------------

test('V1 two seats from two families approve: the receipt binds the head and the brief, and the quorum is approved', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const rv = await finished(p, await submitted(p, review(r)));
    const receipt = rv.receipt;
    assert.equal(receipt.kind, 'approval');
    assert.equal(receipt.repository, 'example/repo');
    assert.equal(receipt.revision, r.head);
    assert.equal(receipt.briefSha256, sha256(BRIEF));
    assert.deepEqual(receipt.builders, BUILDERS);
    assert.equal(receipt.votes.length, 2, JSON.stringify(receipt.votes));
    const byFamily = Object.fromEntries(receipt.votes.map((v: Record<string, string>) => [v.family, v]));
    assert.deepEqual(Object.keys(byFamily).sort(), ['anthropic', 'openai']);
    for (const v of receipt.votes) {
      assert.equal(v.verdict, 'APPROVE');
      assert.equal(v.revision, r.head, 'each vote binds the full head');
      assert.equal(v.briefSha256, sha256(BRIEF), 'each vote binds the brief');
      assert.match(v.context, /^pipe-request-[0-9a-f-]{8,}$/, 'the seat is named by its own pipe request');
      assert.ok(!BUILDERS.some((b) => b.context === v.context));
      assert.match(v.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
      assert.equal(typeof v.reportedModel, 'string');
    }
    assert.equal(byFamily.openai.requestedModel, 'gpt-6.1-sol');
    assert.equal(byFamily.anthropic.requestedModel, 'opus');
    assert.equal(byFamily.anthropic.reportedModel, 'claude-opus-5-5', 'the model the CLI reported');
    assert.equal(byFamily.openai.reportedModel, 'unknown', 'Codex names no model in its stream: unknown, never guessed');
    assert.equal(receipt.quorum?.approved, true, JSON.stringify(receipt.quorum));
  } finally { await p.stop(); }
});

test('V2 each seat runs read-only in a clean detached worktree at the head, never the requester\'s checkout, with the fixed prompt', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const rv = await finished(p, await submitted(p, review(r)));
    const ran = [...jobs(p.claude), ...jobs(p.codex)];
    assert.equal(ran.length, 2);
    for (const job of ran) {
      assert.notEqual(job.cwd, r.dir, 'never the requester\'s checkout');
      assert.equal(job.head, r.head, 'the worktree is at the exact head');
      assert.equal(job.status, '', 'and clean');
      assert.ok(job.prompt.includes(BRIEF), 'the brief, verbatim');
      assert.ok(job.prompt.includes(r.head), 'the full head');
      assert.ok(job.prompt.includes(sha256(BRIEF)), 'the brief\'s sha256');
      assert.match(job.prompt, /do not (?:edit|change)/i, 'a no-edit line');
      for (const word of ['APPROVE', 'REVISE', 'REJECT']) assert.ok(job.prompt.includes(word), `the verdict contract names ${word}`);
      assert.match(job.prompt, /one JSON object/i, 'the answer is one JSON object');
    }
    for (const seat of rv.seats) {
      const req = await p.call('GET', `/v1/requests/${seat.requestId}`);
      assert.equal(req.json.request.mutating, false, 'seats are read-only requests');
    }
    assert.equal(worktreeCount(r.dir), 1, 'the review worktree is removed when the review finishes');
    assert.equal(readFileSync(join(r.dir, 'README.md'), 'utf8'), 'uncommitted edits in the requester\'s checkout\n', 'the requester\'s checkout is untouched');
  } finally { await p.stop(); }
});

// ---- What is refused, and what never counts ---------------------------------------------------------------------

test('V3 a review is refused unless the head is a full commit in the repository, and the brief and seats are given', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['a short head', { head: r.head.slice(0, 12) }],
      ['a head that is not in the repository', { head: 'a'.repeat(40) }],
      ['a folder that is not a repository', { repo: realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u10-plain-'))) }],
      ['an empty brief', { brief: '' }],
      ['no seats', { seats: [] }],
      ['a seat on a model the policy does not allow', { seats: [{ provider: 'codex', model: 'gpt-4', effort: 'high' }] }],
    ];
    for (const [what, over] of bad) {
      const res = await p.call('POST', '/v1/reviews', review(r, over));
      assert.equal(res.status, 400, `${what}: ${res.text}`);
    }
    await sleep(300);
    assert.equal(jobs(p.claude).length + jobs(p.codex).length, 0, 'nothing ran');
  } finally { await p.stop(); }
});

test('V4 a seat that fails, answers without a verdict, or names another head is reported and never counted', async () => {
  for (const answer of ['fail', 'prose', 'wrong-head'] as Answer[]) {
    const r = repo();
    const p = await pipe({ claude: answer, codex: 'approve' });
    try {
      const rv = await finished(p, await submitted(p, review(r)));
      const claudeSeat = rv.seats.find((s: Record<string, string>) => s.provider === 'claude');
      assert.ok(claudeSeat && claudeSeat.status !== 'voted', `${answer}: ${JSON.stringify(claudeSeat)}`);
      assert.ok(typeof claudeSeat.reason === 'string' && claudeSeat.reason.length > 0, `${answer}: the seat says why`);
      assert.ok(!rv.receipt.votes.some((v: Record<string, string>) => v.family === 'anthropic'), `${answer}: no anthropic vote`);
      assert.equal(rv.receipt.quorum.approved, false, `${answer}: one family is no quorum`);
    } finally { await p.stop(); }
  }
});

test('V5 the quorum needs both OpenAI and Anthropic to approve, each through a fresh context, a building family included', async () => {
  const r = repo();
  const revise = await pipe({ claude: 'revise', codex: 'approve' });
  try {
    const rv = await finished(revise, await submitted(revise, review(r)));
    assert.equal(rv.receipt.votes.find((v: Record<string, string>) => v.family === 'anthropic').verdict, 'REVISE');
    assert.equal(rv.receipt.quorum.approved, false, 'a REVISE from one of two families blocks');
  } finally { await revise.stop(); }
  // Both families built it, and fresh seats from each approve. No family
  // outside the builders is needed, so no single family can block approval by being unavailable.
  const inside = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const both = [{ family: 'openai', context: 'pipe-request-b1' }, { family: 'anthropic', context: 'claude-session-b2' }];
    const rv = await finished(inside, await submitted(inside, review(r, { builders: both })));
    assert.equal(rv.receipt.votes.length, 2);
    assert.equal(rv.receipt.quorum.approved, true, 'fresh seats from both building families approve');
  } finally { await inside.stop(); }
});

// ---- Votes the pipe cannot cast itself ---------------------------------------------------------------------------

test('V6 an external vote joins the receipt, marked external, and must bind the same head and brief', async () => {
  const r = repo();
  const p = await pipe({ claude: 'fail', codex: 'approve' });
  try {
    const id = await submitted(p, review(r));
    const before = await finished(p, id);
    assert.equal(before.receipt.quorum.approved, false, 'one family so far');
    const vote = { family: 'google', verdict: 'APPROVE', context: 'gemini-seat-session-1', requestedModel: 'gemini-3.8-flash-high',
      reportedModel: 'gemini-3.8-flash-high', observedAt: new Date().toISOString(), revision: r.head, briefSha256: sha256(BRIEF) };
    for (const [what, over] of [['another head', { revision: r.base }], ['another brief', { briefSha256: sha256('other') }],
      ['a builder context', { context: BUILDERS[0]!.context }], ['an unknown verdict', { verdict: 'LGTM' }]] as Array<[string, Record<string, string>]>) {
      const res = await p.call('POST', `/v1/reviews/${id}/votes`, { ...vote, ...over });
      assert.equal(res.status, 400, `${what}: ${res.text}`);
    }
    const added = await p.call('POST', `/v1/reviews/${id}/votes`, vote);
    assert.equal(added.status, 200, added.text);
    const after = (await p.call('GET', `/v1/reviews/${id}`)).json.review;
    const google = after.receipt.votes.find((v: Record<string, unknown>) => v.family === 'google');
    assert.ok(google, JSON.stringify(after.receipt.votes));
    assert.equal(google.external, true);
    // Both an OpenAI and an Anthropic seat must approve; Google is optional.
    assert.equal(after.receipt.quorum.approved, false, 'openai and google approve, but no anthropic seat has');
    const opus = await p.call('POST', `/v1/reviews/${id}/votes`, { ...vote, family: 'anthropic', context: 'claude-fresh-seat-1',
      requestedModel: 'claude-opus-5-5', reportedModel: 'claude-opus-5-5' });
    assert.equal(opus.status, 200, opus.text);
    const done = (await p.call('GET', `/v1/reviews/${id}`)).json.review;
    assert.equal(done.receipt.quorum.approved, true, 'a fresh anthropic seat, voting from outside the pipe, completes it');
  } finally { await p.stop(); }
});

// ---- The command line --------------------------------------------------------------------------------------------

test('V7 `pipe review` submits from the command line, and `pipe review <id>` shows it', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const brief = join(p.root, 'brief.md');
    writeFileSync(brief, BRIEF);
    const env = { ...process.env, PIPE_URL: p.url, PIPE_TOKEN: TOKEN };
    const sub = await runCli(['review', '--repo', r.dir, '--head', r.head, '--base', r.base, '--brief', brief,
      '--seat', 'codex:gpt-6.1-sol:high', '--seat', 'claude:opus:high', '--builder', 'openai:pipe-request-builder-1',
      '--repository', 'example/repo', '--reason', 'the gate'], env);
    assert.equal(sub.status, 0, sub.stderr);
    const id = JSON.parse(sub.stdout).review.id as string;
    await finished(p, id);
    const show = await runCli(['review', id], env);
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout).review;
    assert.equal(shown.receipt.briefSha256, sha256(BRIEF), 'the brief file is sent verbatim');
    assert.equal(shown.receipt.quorum.approved, true);
  } finally { await p.stop(); }
});

test('S10 the lane stays small: its own src/review.ts holds at most 513 non-blank lines, with no dependency', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  assert.ok(existsSync(new URL('../src/review.ts', import.meta.url)), 'src/review.ts exists');
  const lines = readFileSync(new URL('../src/review.ts', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() !== '').length;
  // Review rounds 4-9 added seat accounting, bounded cleanup, and checks that repository settings cannot change what
  // a seat reviews (the lead, 2026-09-26).
  // The review policy adds the OpenAI-and-Anthropic quorum and the approved review models (the lead).
  // Round 2 adds the invalid seat for an off-list model and the quorum recomputed on read (the lead).
  // U15 adds the gemini seat's branch: submission, its google family and the hand-off to src/agy.ts (the
  // lead's delegate, 2026-09-26).
  // U15 round 2: Gemini seats merge into the stored review, fail with a failed submission, need a
  // base and wait during a drain (the lead's delegate).
  // u42: a review's project, the packet before
  // and the output contract after the seat schema, and their hashes; the file reading lives in src/projects.ts:
  // 450 -> 462, +2 over the old budget. Round 2 (review 2e903825) reads the files only for native seats: +1 (463).
  // u42 discoverability: per-call contextPacket/outputContract for a review, refused without a native seat: +3 (466).
  // shortcut:S3; come-back: split src/review.ts after 11-05.
  assert.ok(lines <= 513, `src/review.ts holds ${lines} non-blank lines; its budget is 513`);
});

// ---- Round 2 (Sol and Google on ae60960) ------------------------------------------------------------------------

test('V8 an external vote can never reuse a seat\'s context, even one that has not voted', async () => {
  const r = repo();
  const p = await pipe({ claude: 'fail', codex: 'approve' });
  try {
    const id = await submitted(p, review(r));
    const done = await finished(p, id);
    const failedSeat = done.seats.find((s: Record<string, string>) => s.provider === 'claude');
    assert.equal(failedSeat.status, 'failed');
    const res = await p.call('POST', `/v1/reviews/${id}/votes`, { family: 'google', verdict: 'APPROVE', context: `pipe-request-${failedSeat.requestId}`,
      requestedModel: 'gemini-3.8-flash-high', reportedModel: 'gemini-3.8-flash-high', observedAt: new Date().toISOString(),
      revision: r.head, briefSha256: sha256(BRIEF) });
    assert.equal(res.status, 400, `a seat's context is reserved: ${res.text}`);
  } finally { await p.stop(); }
});

test('V9 every seat is given the base diff itself, since a read-only seat may not be able to run git', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    await finished(p, await submitted(p, review(r)));
    for (const job of [...jobs(p.claude), ...jobs(p.codex)]) {
      assert.ok(job.prompt.includes('+export const a = 1;'), 'the diff base..head is in the prompt');
    }
  } finally { await p.stop(); }
});

test('V10 the service keeps answering while a review\'s git work is slow', async () => {
  const r = repo();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u10-git-')));
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // Review git runs in the jobs' allow-listed environment, so this slow git (it leaves a marker) is the one used.
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) touch "${join(dir, 'used')}"; sleep 3 ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755);
  const p = await pipe({ claude: 'approve', codex: 'approve' }, dir);
  try {
    const submitting = p.call('POST', '/v1/reviews', review(r));
    await sleep(300);
    const started = Date.now();
    const accounts = await p.call('GET', '/v1/accounts');
    assert.equal(accounts.status, 200);
    assert.ok(Date.now() - started < 1_500, `the service answered in ${Date.now() - started} ms while git ran`);
    const made = await submitting;
    assert.equal(made.status, 201, made.text);
    assert.ok(existsSync(join(dir, 'used')), 'the review used git from the jobs\' environment');
    await finished(p, made.json.review.id);
  } finally { await p.stop(); }
});

test('V11 the votes route, like submission, accepts only JSON', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const id = await submitted(p, review(r));
    const res = await fetch(`${p.url}/v1/reviews/${id}/votes`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${TOKEN}` }, body: '{}' });
    assert.equal(res.status, 415, await res.text());
  } finally { await p.stop(); }
});

// ---- Round 3 (Sol on 8edeb48) -----------------------------------------------------------------------------------

test('V12 a head whose attributes select a filter is refused before anything is checked out: no smudge filter runs', async () => {
  const r = repo();
  const marker = join(r.dir, '..', `${r.dir.split('/').pop()}-smudge-ran`);
  const script = join(r.dir, '..', `${r.dir.split('/').pop()}-smudge.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(script, 0o755);
  // Git runs filter commands through the shell, so the path is quoted (test folders may contain spaces).
  execFileSync('git', ['-C', r.dir, 'config', 'filter.x.smudge', `"${script}"`]);
  execFileSync('git', ['-C', r.dir, 'checkout', '-q', '--', 'README.md']);
  writeFileSync(join(r.dir, '.gitattributes'), 'src/*.ts filter=x\n');
  execFileSync('git', ['-C', r.dir, 'add', '.gitattributes']);
  execFileSync('git', ['-C', r.dir, 'commit', '-q', '-m', 'filtered sources']);
  const head = execFileSync('git', ['-C', r.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const res = await p.call('POST', '/v1/reviews', review({ ...r, head }));
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /filter/i, 'the refusal names the filter');
    assert.ok(!existsSync(marker), 'no smudge filter ran');
    assert.equal(worktreeCount(r.dir), 1, 'no review worktree is left');
    assert.equal(jobs(p.claude).length + jobs(p.codex).length, 0, 'no seat ran');
  } finally { await p.stop(); }
});

// ---- Round 4 (Sol on 2ccdbfa) -----------------------------------------------------------------------------------

/** A git that pauses (and leaves markers) on one subcommand, or fails it while a block file exists. */
function slowGit(step: string, mode: 'pause' | 'fail-while-blocked'): { dir: string; mark: (name: string) => string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u10-git-')));
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const mark = (name: string) => join(dir, name);
  const body = mode === 'pause'
    ? `touch "${mark('started')}"; sleep 2; "${real}" "$@"; rc=$?; touch "${mark('done')}"; exit $rc`
    : `if [ -e "${mark('block')}" ]; then touch "${mark('refused')}"; echo "fatal: blocked by the test" >&2; exit 128; fi; exec "${real}" "$@"`;
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase " $* " in *" ${step} "*) ${body} ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755);
  return { dir, mark };
}
async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await sleep(50); }
}

test('V13 a restart during submission never finishes a review short of its seats: each unsubmitted seat fails with a reason', async () => {
  const r = repo();
  const git = slowGit('worktree add', 'pause');
  const first = await pipe({ claude: 'approve', codex: 'approve' }, git.dir);
  // The service stops while the review's worktree is being made, before any seat is submitted, as in a crash.
  void first.call('POST', '/v1/reviews', review(r)).catch(() => undefined);
  await until('the review to start its worktree', () => existsSync(git.mark('started')));
  await first.stop();
  await until('the interrupted git to finish', () => existsSync(git.mark('done')));
  await sleep(1_000);
  const db = new DatabaseSync(join(first.root, 'pipe.sqlite'), { readOnly: true });
  const rows = db.prepare('SELECT id FROM reviews').all() as Array<{ id: string }>;
  db.close();
  assert.equal(rows.length, 1, 'the review was saved before its worktree was made');
  const again = await pipe({ claude: 'approve', codex: 'approve' }, undefined, first.root);
  try {
    const rv = await finished(again, rows[0]!.id);
    assert.equal(rv.seats.length, SEATS.length, `every requested seat is accounted for: ${JSON.stringify(rv.seats)}`);
    assert.deepEqual(rv.seats.map((s: Record<string, string>) => `${s.provider}/${s.model}/${s.effort}`).sort(),
      SEATS.map((s) => `${s.provider}/${s.model}/${s.effort}`).sort(), 'the seats are the ones asked for');
    for (const seat of rv.seats) {
      assert.equal(seat.status, 'failed', JSON.stringify(seat));
      assert.ok(typeof seat.reason === 'string' && seat.reason.length > 0, 'the seat says why it never ran');
    }
    assert.equal(rv.receipt.votes.length, 0);
    assert.equal(rv.receipt.quorum.approved, false);
    assert.equal(jobs(first.claude).length + jobs(first.codex).length + jobs(again.claude).length + jobs(again.codex).length, 0, 'no seat ran');
    assert.equal(worktreeCount(r.dir), 1, 'the interrupted review\'s worktree is removed');
  } finally { await again.stop(); }
});

test('V14 a review worktree that cannot be removed is retried; after ten failures the review finishes and says so', async () => {
  // A removal that fails for a while is retried, and the review finishes once its worktree is gone.
  {
    const r = repo();
    const git = slowGit('worktree remove', 'fail-while-blocked');
    writeFileSync(git.mark('block'), '');
    const p = await pipe({ claude: 'approve', codex: 'approve' }, git.dir);
    try {
      const id = await submitted(p, review(r));
      await until('a removal to be refused', () => existsSync(git.mark('refused')));
      const during = await p.call('GET', `/v1/reviews/${id}`);
      assert.equal(during.json.review.state, 'running', 'a review is not finished while its worktree remains');
      assert.equal(worktreeCount(r.dir), 2);
      rmSync(git.mark('block'));
      const rv = await finished(p, id);
      assert.equal(worktreeCount(r.dir), 1, 'the retry removed the worktree');
      assert.equal(rv.receipt.quorum.approved, true, 'the votes were kept while cleanup waited');
      assert.equal(rv.cleanup, undefined, 'a cleanup that succeeded leaves no note');
    } finally { await p.stop(); }
  }
  // A removal that keeps failing ends: the review finishes, keeps its votes, and says the worktree is left.
  {
    const r = repo();
    const git = slowGit('worktree remove', 'fail-while-blocked');
    writeFileSync(git.mark('block'), '');
    const p = await pipe({ claude: 'approve', codex: 'approve' }, git.dir);
    try {
      const rv = await finished(p, await submitted(p, review(r)), 30_000);
      assert.equal(rv.receipt.quorum.approved, true);
      assert.ok(typeof rv.cleanup === 'string' && /remov/i.test(rv.cleanup), `the review says its worktree was left: ${JSON.stringify(rv.cleanup)}`);
      assert.equal(worktreeCount(r.dir), 2, 'the worktree is left for the operator');
    } finally {
      await p.stop();
      rmSync(git.mark('block'));
      execFileSync('git', ['-C', r.dir, 'worktree', 'prune']);
    }
  }
});

test('V15 a head or base that names a tag, not a commit, is refused before any worktree is made', async () => {
  const r = repo();
  execFileSync('git', ['-C', r.dir, 'tag', '-a', 'base-tag', '-m', 'an annotated tag', r.base]);
  execFileSync('git', ['-C', r.dir, 'tag', '-a', 'head-tag', '-m', 'an annotated tag', r.head]);
  const tag = (name: string) => execFileSync('git', ['-C', r.dir, 'rev-parse', name], { encoding: 'utf8' }).trim();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    for (const [what, over] of [['base', { base: tag('base-tag') }], ['head', { head: tag('head-tag') }]] as const) {
      assert.notEqual(Object.values(over)[0], what === 'base' ? r.base : r.head, 'the tag object is not the commit');
      const res = await p.call('POST', '/v1/reviews', review(r, over));
      assert.equal(res.status, 400, `a ${what} naming a tag: ${res.text}`);
      assert.equal(worktreeCount(r.dir), 1, `no worktree is made for a ${what} naming a tag`);
    }
    await sleep(300);
    assert.equal(jobs(p.claude).length + jobs(p.codex).length, 0, 'nothing ran');
  } finally { await p.stop(); }
});

// ---- Round 5 (Sol on f1c35c5) -----------------------------------------------------------------------------------

test('V16 a cancelled seat keeps its worktree until its runner has ended: the review never removes it under a live CLI', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'slow' });
  try {
    const id = await submitted(p, review(r));
    const started = join(p.codex, '..', 'slow-started');
    const end = Date.now() + 15_000;
    while (!existsSync(started)) { if (Date.now() > end) assert.fail('the slow seat never started'); await sleep(50); }
    const seat = (await p.call('GET', `/v1/reviews/${id}`)).json.review.seats.find((s: Record<string, string>) => s.provider === 'codex');
    const cancelled = await p.call('POST', `/v1/requests/${seat.requestId}/cancel`, {});
    assert.equal(cancelled.status, 200, cancelled.text);
    const rv = await finished(p, id, 30_000);
    assert.ok(!existsSync(join(p.codex, '..', 'cwd-vanished')), 'the worktree was removed while the seat\'s CLI still ran in it');
    const done = rv.seats.find((s: Record<string, string>) => s.provider === 'codex');
    assert.equal(done.status, 'failed', JSON.stringify(done));
    assert.match(done.reason, /cancel/i);
    assert.ok(!rv.receipt.votes.some((v: Record<string, string>) => v.family === 'openai'), 'a cancelled seat never votes');
    assert.equal(worktreeCount(r.dir), 1, 'the worktree is removed once the runner has ended');
  } finally { await p.stop(); }
});

test('V17 a review record that cannot be read never stops dispatch, nor another review', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const db = new DatabaseSync(join(p.root, 'pipe.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000');
    const at = new Date().toISOString();
    db.prepare('INSERT INTO reviews (id, state, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('unreadable', 'running', '{not json', at, at);
    db.close();
    await sleep(300);
    const job = await p.call('POST', '/v1/requests', { requester: 'lead', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus',
      effort: 'high', reason: 'a plain job beside a broken review', prompt: 'hello', mutating: false, priority: 'interactive' });
    assert.equal(job.status, 201, job.text);
    const end = Date.now() + 15_000;
    for (;;) {
      const now = await p.call('GET', `/v1/requests/${job.json.request.id}`);
      if (now.json.request?.state === 'completed') break;
      if (Date.now() > end) assert.fail(`the plain job was never run: ${now.text.slice(0, 400)}`);
      await sleep(100);
    }
    const rv = await finished(p, await submitted(p, review(r)));
    assert.equal(rv.receipt.quorum.approved, true, 'another review still runs to the end');
  } finally { await p.stop(); }
});

// ---- Round 6 (Sol on 258ee82) -----------------------------------------------------------------------------------

test('V18 a replace ref never changes what a seat reviews: the worktree and the diff are the named commit\'s own', async () => {
  const r = repo();
  // A replacement for the head with another tree (the base's): git would show it wherever replace refs are honored.
  const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
  const other = git('commit-tree', `${r.base}^{tree}`, '-p', r.base, '-m', 'a replacement with other content');
  git('replace', r.head, other);
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const rv = await finished(p, await submitted(p, review(r)));
    for (const job of [...jobs(p.claude), ...jobs(p.codex)]) {
      assert.equal(job.a, 'export const a = 1;\n', 'the worktree holds the named commit\'s files');
      assert.ok(job.prompt.includes('+export const a = 1;'), 'the diff is the named commit\'s own');
    }
    assert.equal(rv.receipt.quorum.approved, true);
  } finally { await p.stop(); }
});

test('V19 a repository whose shared config sets core.worktree is refused: nothing is written into the requester\'s checkout', async () => {
  const r = repo();
  const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
  // With per-worktree config enabled, a shared core.worktree points every linked worktree at the requester's checkout.
  git('config', 'core.repositoryformatversion', '1');
  git('config', 'extensions.worktreeConfig', 'true');
  git('config', 'core.worktree', r.dir);
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const res = await p.call('POST', '/v1/reviews', review(r));
    assert.equal(res.status, 400, res.text);
    assert.match(res.text, /work ?tree/i, 'the refusal names the work tree');
    assert.equal(readFileSync(join(r.dir, 'README.md'), 'utf8'), 'uncommitted edits in the requester\'s checkout\n', 'the requester\'s checkout is untouched');
    assert.equal(worktreeCount(r.dir), 1, 'no review worktree is left');
    await sleep(300);
    assert.equal(jobs(p.claude).length + jobs(p.codex).length, 0, 'no seat ran');
  } finally { await p.stop(); }
});

// ---- Round 7 (Sol and Google on b1b385f) ------------------------------------------------------------------------

test('V20 no setting or attribute changes the bytes a seat reviews: a review gives the commit\'s own bytes, or is refused', async () => {
  const cases: Array<[string, (dir: string, git: (...a: string[]) => string) => void]> = [
    ['core.autocrlf=true', (_d, git) => git('config', 'core.autocrlf', 'true')],
    ['an eol=crlf attribute', (d, git) => { writeFileSync(join(d, '.git', 'info', 'attributes'), 'src/a.ts text eol=crlf\n'); void git; }],
    ['an ident attribute', (d, git) => { writeFileSync(join(d, '.git', 'info', 'attributes'), 'src/a.ts ident\n'); void git; }],
    ['a sparse checkout that leaves out src', (d, git) => {
      git('config', 'core.sparseCheckout', 'true');
      writeFileSync(join(d, '.git', 'info', 'sparse-checkout'), '/README.md\n');
    }],
  ];
  for (const [what, setUp] of cases) {
    const r = repo();
    // The committed file carries an $Id$ marker, so ident expansion would change it too.
    const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
    writeFileSync(join(r.dir, 'src', 'a.ts'), 'export const a = 1; // $Id$\n');
    git('commit', '-q', '-am', 'an id marker');
    const head = git('rev-parse', 'HEAD');
    setUp(r.dir, git);
    const p = await pipe({ claude: 'approve', codex: 'approve' });
    try {
      const res = await p.call('POST', '/v1/reviews', review({ ...r, head }));
      if (res.status === 201) {
        await finished(p, res.json.review.id);
        for (const job of [...jobs(p.claude), ...jobs(p.codex)]) {
          assert.equal(job.a, 'export const a = 1; // $Id$\n', `${what}: the seat reviews the commit's own bytes`);
        }
      } else {
        assert.equal(res.status, 400, `${what}: ${res.text}`);
        await sleep(300);
        assert.equal(jobs(p.claude).length + jobs(p.codex).length, 0, `${what}: a refused review runs no seat`);
      }
    } finally { await p.stop(); }
  }
});

test('V21 the diff in the prompt ignores display settings: no colour, the whole repository, submodules included', async () => {
  const r = repo();
  const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
  git('config', 'color.ui', 'always');
  git('config', 'diff.relative', 'true');
  git('config', 'diff.ignoreSubmodules', 'all');
  // The requester names a folder inside the repository that holds none of the change.
  mkdirSync(join(r.dir, 'docs'));
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    await finished(p, await submitted(p, review(r, { repo: join(r.dir, 'docs') })));
    for (const job of [...jobs(p.claude), ...jobs(p.codex)]) {
      assert.ok(job.prompt.includes('+export const a = 1;'), 'the whole change is in the diff');
      assert.ok(!job.prompt.includes('\u001b['), 'no colour escapes');
    }
  } finally { await p.stop(); }
});

test('V22 an external vote added while the review is being set up is kept', async () => {
  const r = repo();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u10-git-')));
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) touch "${join(dir, 'adding')}"; sleep 2 ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(dir, 'git'), 0o755);
  const p = await pipe({ claude: 'approve', codex: 'approve' }, dir);
  try {
    const submitting = p.call('POST', '/v1/reviews', review(r));
    for (let i = 0; i < 200 && !existsSync(join(dir, 'adding')); i++) await sleep(25);
    const db = new DatabaseSync(join(p.root, 'pipe.sqlite'), { readOnly: true });
    const id = (db.prepare('SELECT id FROM reviews').get() as { id: string }).id;
    db.close();
    const vote = await p.call('POST', `/v1/reviews/${id}/votes`, { family: 'google', verdict: 'APPROVE', context: 'gemini-seat-external-1',
      requestedModel: 'gemini-3.8-flash-high', reportedModel: 'gemini-3.8-flash-high', observedAt: new Date().toISOString(),
      revision: r.head, briefSha256: sha256(BRIEF) });
    assert.equal(vote.status, 200, vote.text);
    const made = await submitting;
    assert.equal(made.status, 201, made.text);
    const rv = await finished(p, id);
    assert.ok(rv.receipt.votes.some((v: Record<string, unknown>) => v.context === 'gemini-seat-external-1' && v.external === true),
      `the external vote survived setup: ${JSON.stringify(rv.receipt.votes)}`);
  } finally { await p.stop(); }
});

// ---- Round 8 (Sol on 9984312) -----------------------------------------------------------------------------------

test('V23 only a string verdict counts: an array, object or number that coerces to APPROVE is invalid', () => {
  const head = 'c'.repeat(40);
  for (const verdict of [['APPROVE'], { toString: 'APPROVE' }, 1]) {
    const answer = lastVerdict(`done ${JSON.stringify({ verdict, head: head.slice(0, 12) })}`, head);
    assert.ok('reason' in answer, `${JSON.stringify(verdict)} is not a verdict: ${JSON.stringify(answer)}`);
  }
  assert.deepEqual(lastVerdict(`done ${JSON.stringify({ verdict: 'APPROVE', head: head.slice(0, 12) })}`, head), { verdict: 'APPROVE' });
});

test('V24 the prompt\'s diff has git\'s own order, prefixes and context, whatever the repository configures', async () => {
  const r = repo();
  const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
  // The head also changes the middle of a longer README, so the context lines around it show.
  git('checkout', '-q', '--', 'README.md');
  writeFileSync(join(r.dir, 'README.md'), 'one\ntwo\nthree\nfour\nfive\n');
  git('commit', '-q', '-am', 'a longer readme');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'README.md'), 'one\ntwo\nTHREE\nfour\nfive\n');
  writeFileSync(join(r.dir, 'src', 'a.ts'), 'export const a = 2;\n');
  git('commit', '-q', '-am', 'the change under review');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'order'), 'src/*\n');
  git('config', 'diff.orderFile', join(r.dir, 'order'));
  git('config', 'diff.noprefix', 'true');
  git('config', 'diff.context', '0');
  git('config', 'diff.mnemonicPrefix', 'true');
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    await finished(p, await submitted(p, review({ ...r, base, head })));
    for (const job of [...jobs(p.claude), ...jobs(p.codex)]) {
      const readme = job.prompt.indexOf('diff --git a/README.md b/README.md');
      const source = job.prompt.indexOf('diff --git a/src/a.ts b/src/a.ts');
      assert.ok(readme >= 0 && source >= 0, 'the usual a/ and b/ prefixes');
      assert.ok(readme < source, 'git\'s own path order, not the repository\'s order file');
      assert.ok(job.prompt.includes('\n two\n') && job.prompt.includes('\n four\n'), 'three lines of context');
    }
  } finally { await p.stop(); }
});

test('V25 a path ending in a carriage return cannot slip past the byte check: the review is refused', async () => {
  const r = repo();
  const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
  // hash-object --stdin-paths drops a trailing \r, so "cr\r" would be checked as its sibling "cr" (the seat operator's
  // proof: the same blob in both, and an ident attribute that expands only "cr\r" on disk).
  git('checkout', '-q', '--', 'README.md');
  writeFileSync(join(r.dir, 'cr'), 'ver $Id$\n');
  writeFileSync(join(r.dir, 'cr\r'), 'ver $Id$\n');
  writeFileSync(join(r.dir, '.gitattributes'), 'cr? ident\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'two names, one blob');
  const head = git('rev-parse', 'HEAD');
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const res = await p.call('POST', '/v1/reviews', review({ ...r, head }));
    assert.equal(res.status, 400, res.text);
    await sleep(300);
    assert.equal(jobs(p.claude).length + jobs(p.codex).length, 0, 'no seat ran');
  } finally { await p.stop(); }
});

// ---- Round 9 (Google and the seat operator on 0d6f7e9) ----------------------------------------------------------

test('V26 no attribute outside the commit turns the prompt\'s diff into "Binary files differ"', async () => {
  const cases: Array<[string, (dir: string, git: (...a: string[]) => string) => void]> = [
    ['info/attributes', (d) => writeFileSync(join(d, '.git', 'info', 'attributes'), '* -diff\n')],
    ['core.attributesFile', (d, git) => { writeFileSync(join(d, '..', `${d.split('/').pop()}-attrs`), '* -diff\n'); git('config', 'core.attributesFile', join(d, '..', `${d.split('/').pop()}-attrs`)); }],
    ['an uncommitted .gitattributes in the requester\'s checkout', (d) => writeFileSync(join(d, '.gitattributes'), '* -diff\n')],
    ['a diff driver marked binary', (d, git) => { writeFileSync(join(d, '.git', 'info', 'attributes'), '*.ts diff=ts\n'); git('config', 'diff.ts.binary', 'true'); }],
  ];
  for (const [what, setUp] of cases) {
    const r = repo();
    setUp(r.dir, (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim());
    const p = await pipe({ claude: 'approve', codex: 'approve' });
    try {
      await finished(p, await submitted(p, review(r)));
      for (const job of [...jobs(p.claude), ...jobs(p.codex)]) {
        assert.ok(job.prompt.includes('+export const a = 1;'), `${what}: the change itself is in the diff`);
        assert.ok(!/Binary files .* differ/.test(job.prompt), `${what}: not reported as binary`);
      }
    } finally { await p.stop(); }
  }
});

test('V27 the prompt\'s diff is the same byte for byte whatever the repository configures, cut fallback included', async () => {
  // Two repositories with the same commits' content; one loads every diff setting a review must not honour.
  const diffOf = async (configure: boolean): Promise<string> => {
    const r = repo();
    const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
    git('checkout', '-q', '--', 'README.md');
    // Over the 200 KiB cut, so the --stat fallback is in the prompt too.
    writeFileSync(join(r.dir, 'big.txt'), Array.from({ length: 12_000 }, (_, i) => `line ${i} of a large change\n`).join(''));
    writeFileSync(join(r.dir, 'README.md'), 'hello\nfunction f() {\n  return 1;\n}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'a large change');
    const head = git('rev-parse', 'HEAD');
    if (configure) {
      writeFileSync(join(r.dir, '.git', 'info', 'attributes'), '* diff=decor\n');
      git('config', 'diff.decor.xfuncname', '^(.*)$');
      git('config', 'diff.statGraphWidth', '5');
      git('config', 'diff.statNameWidth', '5');
      git('config', 'core.abbrev', '4');
      git('config', 'color.diff', 'always');
    }
    const p = await pipe({ claude: 'approve', codex: 'approve' });
    try {
      await finished(p, await submitted(p, review({ ...r, head })));
      const prompt = jobs(p.codex)[0]!.prompt;
      const diff = prompt.slice(prompt.indexOf('BEGIN DIFF'), prompt.indexOf('END DIFF'));
      assert.ok(diff.includes('DIFF CUT AFTER 200 KiB'), 'the fallback is exercised');
      return diff.split('\n').slice(1).join('\n');   // the BEGIN line names the commits, which differ
    } finally { await p.stop(); }
  };
  const plain = await diffOf(false), configured = await diffOf(true);
  assert.equal(configured, plain, 'no setting changes the diff a seat is given');
});

// ---- After merge (Google and the seat operator on 76879be) ------------------------------------------------------

test('V28 a content line holding a carriage return or line separator before @@ keeps all its text in the prompt', async () => {
  const r = repo();
  const git = (...args: string[]) => execFileSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).trim();
  git('checkout', '-q', '--', 'README.md');
  // The seat operator's lines: JavaScript's multiline ^ also starts a line after \r, U+2028 and U+2029.
  writeFileSync(join(r.dir, 'notes.txt'), 'x\r@@ -1 +1 @@ HIDDEN TEXT\nline2  @@ -2 +2 @@ ALSO HIDDEN\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'lines that look like hunk headers');
  const head = git('rev-parse', 'HEAD');
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    await finished(p, await submitted(p, review({ ...r, head })));
    for (const job of [...jobs(p.claude), ...jobs(p.codex)]) {
      assert.ok(job.prompt.includes('HIDDEN TEXT'), 'the text after a carriage return is kept');
      assert.ok(job.prompt.includes('ALSO HIDDEN'), 'the text after a line separator is kept');
    }
  } finally { await p.stop(); }
});

// ---- The approved review models ----------------------------------------------------------------------------------

test('V29 a vote from a model below the approved floors is refused: Claude Sonnet 5 may not review', async () => {
  const r = repo();
  const p = await pipe({ claude: 'approve', codex: 'approve' });
  try {
    const id = await submitted(p, review(r));
    await finished(p, id);
    const vote = { family: 'anthropic', verdict: 'APPROVE', context: 'claude-fresh-seat-9', observedAt: new Date().toISOString(),
      revision: r.head, briefSha256: sha256(BRIEF) };
    for (const [requestedModel, reportedModel] of [['claude-sonnet-5', 'claude-sonnet-5'], ['opus', 'claude-sonnet-5'], ['sonnet', 'unknown']]) {
      const res = await p.call('POST', `/v1/reviews/${id}/votes`, { ...vote, requestedModel, reportedModel });
      assert.equal(res.status, 400, `${requestedModel}/${reportedModel}: ${res.text}`);
      assert.match(res.text, /approved|model/i);
    }
    const seat = await p.call('POST', '/v1/reviews', review(r, { seats: [{ provider: 'claude', model: 'sonnet', effort: 'high' }] }));
    assert.equal(seat.status, 400, `a Sonnet seat is refused: ${seat.text}`);
  } finally { await p.stop(); }
});

test('V30 a seat that reports a model off the review list never approves, but its dissent still counts', async () => {
  for (const [answer, approved] of [['old-opus-approve', false], ['old-opus-revise', false]] as Array<[Answer, boolean]>) {
    const r = repo();
    const p = await pipe({ claude: answer, codex: 'approve' });
    try {
      const rv = await finished(p, await submitted(p, review(r)));
      const seat = rv.seats.find((s: Record<string, string>) => s.provider === 'claude');
      if (answer === 'old-opus-approve') {
        assert.equal(seat.status, 'invalid', JSON.stringify(seat));
        assert.match(seat.reason, /claude-opus-4-7.*approved review model/);
        assert.ok(!rv.receipt.votes.some((v: Record<string, string>) => v.family === 'anthropic'), 'an off-list approval is not a vote');
      } else {
        assert.equal(seat.status, 'voted', 'a dissent is recorded whatever the model');
        assert.ok(rv.receipt.votes.some((v: Record<string, string>) => v.family === 'anthropic' && v.verdict === 'REVISE'
          && v.reportedModel === 'claude-opus-4-7'), 'the dissent is in the receipt');
        assert.ok(!rv.receipt.quorum.approvingFamilies.includes('anthropic'));
      }
      assert.equal(rv.receipt.quorum.approved, approved, answer);
    } finally { await p.stop(); }
  }
});

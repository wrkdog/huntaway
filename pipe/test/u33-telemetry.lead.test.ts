/**
 * Lead acceptance tests: pipe telemetry for proving velocity ("record lines changed per build, the round number of each review, waiting time (queued → started), and
 * seat-never-ran failures counted apart from verdicts"). The builder must not edit this file.
 *
 * Interface under test:
 * - **Lines changed per build.** When a changing job's work is saved, the pipe records
 *   `workspace.diff = { files, insertions, deletions }` for `startCommit..commit` (git numstat; a binary file counts as
 *   one file with 0 lines). The job card's `saved` gains `diff` (null until saved, or for `no_changes`
 *   `{ files: 0, insertions: 0, deletions: 0 }`).
 * - **Review rounds.** A review may carry `lane` (a non-empty label of at most 80 characters, optional). The pipe
 *   records `round` = 1 + the number of earlier reviews with the same `repository` and `lane`; with no lane, `round` is
 *   null. CLI `pipe review … --lane <label>`; MCP `pipe_review` accepts `lane`.
 * - **Setup failures apart from verdicts.** A review whose setup failed before its seats were submitted records
 *   `setupFailed: true` (else false). This is distinct from a seat that ran and failed.
 * - **`GET /v1/stats?since=YYYY-MM-DD`** (and CLI `pipe stats --since <date>`) returns
 *   `{ days: [{ day, builds: { count, waitMedianSec, waitP90Sec, linesMedian, linesP90 }, reviews: { count, approved,
 *   revise, setupFailed, seatFailed, roundMax } }] }`, per UTC day of submission. Waits are seconds from submission to
 *   the first attempt's start; lines are insertions plus deletions of saved builds. Numbers are null when there is no
 *   data. It is content-free: no prompt, result or path.
 *
 * Round 2 adds T5–T8:
 * - Historical records count. A finished review recorded before this change, whose seats were never submitted
 *   (`requestId: ''`, reason starting "never submitted"), or were cancelled by a failed submission (reason
 *   "review submission failed"), is a setup failure, both in `GET /v1/reviews/:id` (`setupFailed: true`, derived)
 *   and in stats.
 * - `seatFailed` counts only reviews with a seat that was submitted, ran and failed, never one stopped by setup.
 * - A malformed stored review (for example `seats: ["x"]` or `votes: ["x"]`) never breaks stats: it is skipped and
 *   the rest is still counted.
 * - The window is bounded: `since` more than 31 days ago is refused with 400.
 *
 * Round 3 adds T8: a stored number outside the safe integer range (a
 * review round, or a build's insertions or deletions) never breaks stats. The record is skipped for that measure, and
 * the rest is still counted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startPipe } from '../src/service.ts';
import { Store } from '../src/store.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN = 'pipe-u33-token-not-a-credential-0123456789';
const POLICY = {
  claude: { models: { opus: 'default' }, efforts: ['low', 'medium', 'high'] },
  codex: { models: { 'gpt-6.1-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high'] },
};
const runCli = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env }, (err, stdout, stderr) =>
    resolve({ status: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
});

/** One fake CLI per provider: a review prompt gets an APPROVE (or REVISE when the brief says REVISE-ME); any other
 * prompt builds src/b.ts (three lines) in its folder. */
function fakeCli(kind: 'claude' | 'codex'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `pipe-u33-${kind}-`)));
  const init = JSON.parse(readFileSync(new URL('claude-success.jsonl', FIX), 'utf8').split('\n')[0]!); init.model = 'claude-opus-5-5';
  const app = Object.fromEntries((u4('codex-app-server.signed-in') as Array<{ method: string; response: object }>).map((e) => [e.method, e.response]));
  const listed = app['model/list'] as { result: { data: Array<Record<string, unknown>> } };
  listed.result.data = [{ ...listed.result.data.find((m) => m.id === 'gpt-6-sol'), id: 'gpt-6.1-sol', model: 'gpt-6.1-sol' }, ...listed.result.data];
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ kind, init, app,
    version: kind === 'claude' ? u4('claude-version').stdout : u4('codex-version').stdout,
    authStatus: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout }));
  const path = join(dir, kind);
  writeFileSync(path, `#!${process.execPath}
const fs=require('fs'),p=require('path'),cp=require('child_process'),sc=JSON.parse(fs.readFileSync(p.join(__dirname,'scenario.json'),'utf8')),a=process.argv.slice(2),NL=String.fromCharCode(10);
const out=(o)=>process.stdout.write(JSON.stringify(o)+NL);
if(a[0]==='--version')process.stdout.write(sc.version);
else if(a[0]==='auth')process.stdout.write(JSON.stringify(sc.authStatus));
else if(a[0]==='-p'&&a[1]==='/usage'){const at=(ms)=>{const q=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(new Date(ms)).map((x)=>[x.type,x.value]));return q.month+' '+q.day+' at '+q.hour+':'+q.minute+q.dayPeriod.toLowerCase();};
  const RESET=new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m','u');process.stdout.write(JSON.stringify({...sc.usage,result:sc.usage.result.split(NL).map((l)=>l.replace(RESET,'resets '+at(Date.now()+(l.startsWith('Current session')?3:96)*3600000))).join(NL)}));}
else if(a[0]==='app-server'){const fresh=(k,v)=>k==='resetsAt'&&typeof v==='number'?Math.floor(Date.now()/1000)+96*3600:v;let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',(c)=>{buf+=c;let n;while((n=buf.indexOf(NL))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);let m;try{m=JSON.parse(line);}catch{continue;}if(m.id===undefined)continue;process.stdout.write(JSON.stringify({id:m.id,...(sc.app[m.method]||{result:{}})},fresh)+NL);}});}
else{let prompt='';try{prompt=fs.readFileSync(0,'utf8');}catch{}
  let text;
  if(prompt.startsWith('Review the exact commit')){const head=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:process.cwd(),encoding:'utf8'}).trim();
    text=JSON.stringify({verdict:prompt.includes('REVISE-ME')?'REVISE':'APPROVE',head:head.slice(0,12),findings:[],unknowns:[]});}
  else{fs.mkdirSync(p.join(process.cwd(),'src'),{recursive:true});fs.writeFileSync(p.join(process.cwd(),'src','b.ts'),'export const b = 2;'+NL+'export const c = 3;'+NL+'export const d = 4;'+NL);text='built';}
  if(sc.kind==='claude'){out(sc.init);out({type:'assistant',message:{role:'assistant',content:[{type:'text',text}]}});out({type:'result',subtype:'success',is_error:false,result:text});}
  else{out({type:'thread.started',thread_id:'t'});out({type:'item.completed',item:{id:'i',type:'agent_message',text}});out({type:'turn.completed',usage:{}});}}
`);
  chmodSync(path, 0o755);
  return path;
}
function repo(): { dir: string; base: string; head: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u33-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'lead@example.invalid'); git('config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'README.md'), 'hello\n'); git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n'); git('add', '-A'); git('commit', '-qm', 'change');
  return { dir, base, head: git('rev-parse', 'HEAD') };
}
async function pipe(gitDir?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u33-')));
  const login = (id: string) => { const d = join(root, `login-${id}`); mkdirSync(d, { recursive: true }); return d; };
  const handle = await startPipe({
    accounts: [
      { id: 'claude-a', provider: 'claude', loginDir: login('claude-a'), fingerprint: sha8('<orgId>'), maxConcurrency: 2, enabled: true },
      { id: 'codex-a', provider: 'codex', loginDir: login('codex-a'), fingerprint: sha8('<chatgptAccountId>'), maxConcurrency: 2, enabled: true },
    ],
    policy: POLICY, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'),
    cli: { claude: fakeCli('claude'), codex: fakeCli('codex') }, env: { PATH: `${gitDir ? `${gitDir}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000, minFreeGb: 0,
  } as Parameters<typeof startPipe>[0]);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  return { ...handle, call, root };
}
type P = Awaited<ReturnType<typeof pipe>>;
async function until<T>(what: string, read: () => Promise<T | undefined>, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const got = await read(); if (got !== undefined) return got; if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await sleep(100); }
}
const SEATS = [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { provider: 'claude', model: 'opus', effort: 'high' }];
const review = (r: { dir: string; base: string; head: string }, over: Record<string, unknown> = {}) => ({
  requester: 'lead', reason: 'telemetry', repository: 'example/repo', repo: r.dir, head: r.head, base: r.base, brief: 'Check it.\n',
  seats: SEATS, priority: 'interactive', ...over });
const finished = (p: P, id: string) => until(`review ${id}`, async () => {
  const r = await p.call('GET', `/v1/reviews/${id}`); return r.json.review?.state === 'finished' ? r.json.review as Record<string, any> : undefined;
});
const today = () => new Date().toISOString().slice(0, 10);

test('T1 a saved build records its lines changed, and the card shows them', async () => {
  const r = repo(), p = await pipe();
  try {
    const sub = await p.call('POST', '/v1/requests', { requester: 'foreman', project: 'pipe', kind: 'code', provider: 'codex', model: 'gpt-6.1-sol',
      effort: 'medium', reason: 'a slice', prompt: 'Add src/b.ts.', mutating: true, priority: 'interactive', cwd: r.dir });
    assert.equal(sub.status, 201, sub.text);
    const id = sub.json.request.id as string;
    const card = await until('the build to be saved', async () => {
      const c = (await p.call('GET', `/v1/cards/${id}`)).json.card; return c?.saved && c.saved.state !== 'pending' ? c : undefined;
    });
    assert.equal(card.saved.state, 'saved');
    assert.deepEqual(card.saved.diff, { files: 1, insertions: 3, deletions: 0 });
  } finally { await p.stop(); }
});

test('T2 reviews in a lane are numbered by round; another lane or no lane is separate', async () => {
  const r = repo(), p = await pipe();
  try {
    const one = await finished(p, (await p.call('POST', '/v1/reviews', review(r, { lane: 'c5s1' }))).json.review.id);
    const two = await finished(p, (await p.call('POST', '/v1/reviews', review(r, { lane: 'c5s1' }))).json.review.id);
    const other = await finished(p, (await p.call('POST', '/v1/reviews', review(r, { lane: 'k7' }))).json.review.id);
    const none = await finished(p, (await p.call('POST', '/v1/reviews', review(r))).json.review.id);
    assert.deepEqual([one.round, two.round, other.round, none.round], [1, 2, 1, null]);
    assert.equal(two.lane, 'c5s1');
    for (const lane of ['', 'x'.repeat(81), 7]) {
      const bad = await p.call('POST', '/v1/reviews', review(r, { lane }));
      assert.equal(bad.status, 400, `${JSON.stringify(lane)}: ${bad.text}`);
    }
  } finally { await p.stop(); }
});

test('T3 a review whose setup fails before its seats is counted as setupFailed, apart from verdicts', async () => {
  const r = repo();
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const gitDir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u33-git-')));
  const block = join(gitDir, 'block');
  writeFileSync(join(gitDir, 'git'), `#!/bin/sh\ncase " $* " in *" worktree add "*) if [ -e "${block}" ]; then echo "fatal: blocked by the test" >&2; exit 128; fi ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(gitDir, 'git'), 0o755);
  const p = await pipe(gitDir);
  try {
    const ok = await finished(p, (await p.call('POST', '/v1/reviews', review(r))).json.review.id);
    assert.equal(ok.setupFailed, false);
    writeFileSync(block, '');
    const failed = await p.call('POST', '/v1/reviews', review(r, { lane: 'broken' }));
    assert.notEqual(failed.status, 201, 'the submission reports the setup failure');
    const s = await p.call('GET', `/v1/stats?since=${today()}`);
    const d = s.json.days.find((x: any) => x.day === today());
    assert.equal(d.reviews.setupFailed, 1, s.text);
    assert.equal(d.reviews.seatFailed, 0, 'a setup failure is not a seat failure');
  } finally { await p.stop(); }
});

test('T4 stats: per-day builds with waits and lines, reviews with outcomes and rounds; CLI too; content-free', async () => {
  const r = repo(), p = await pipe();
  try {
    const id = (await p.call('POST', '/v1/requests', { requester: 'foreman', project: 'pipe', kind: 'code', provider: 'codex', model: 'gpt-6.1-sol',
      effort: 'medium', reason: 'a slice', prompt: 'SECRET-PROMPT-MARKER Add src/b.ts.', mutating: true, priority: 'interactive', cwd: r.dir })).json.request.id as string;
    await until('the build to be saved', async () => { const c = (await p.call('GET', `/v1/cards/${id}`)).json.card; return c?.saved?.state === 'saved' ? c : undefined; });
    await finished(p, (await p.call('POST', '/v1/reviews', review(r, { lane: 'x' }))).json.review.id);
    await finished(p, (await p.call('POST', '/v1/reviews', review(r, { lane: 'x', brief: 'REVISE-ME\n' }))).json.review.id);
    const s = await p.call('GET', `/v1/stats?since=${today()}`);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.text.includes('SECRET-PROMPT-MARKER'), false, 'content-free');
    const d = s.json.days.find((x: any) => x.day === today());
    assert.ok(d, s.text);
    assert.equal(d.builds.count, 1);
    assert.ok(Number.isFinite(d.builds.waitMedianSec) && d.builds.waitMedianSec >= 0);
    assert.equal(d.builds.linesMedian, 3);
    assert.equal(d.reviews.count, 2);
    assert.equal(d.reviews.approved, 1);
    assert.equal(d.reviews.revise, 1);
    assert.equal(d.reviews.setupFailed, 0);
    assert.equal(d.reviews.roundMax, 2);
    const bad = await p.call('GET', '/v1/stats?since=yesterday');
    assert.equal(bad.status, 400, bad.text);
    const cli = await runCli(['stats', '--since', today()], { ...process.env, PIPE_URL: p.url, PIPE_TOKEN: TOKEN });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), s.json);
  } finally { await p.stop(); }
});

// ---- Round 2 (review 477aee73) --------------------------------------------------------------------------------------

const plant = (p: P, id: string, body: unknown) => {
  const store = new Store(join(p.root, 'pipe.sqlite'));
  try { store.insertReview(id, 'finished', body as never); } finally { store.close(); }
};
const NEVER = "never submitted: the review's setup did not finish (the service stopped, or the submission failed)";
const oldReview = (r: { dir: string; base: string; head: string }, seats: unknown[]) => ({
  repository: 'example/repo', repo: r.dir, head: r.head, base: r.base, briefSha256: 'a'.repeat(64),
  requestedSeats: SEATS, seats, worktree: join(r.dir, '..', 'gone'),
  receipt: { kind: 'approval', repository: 'example/repo', revision: r.head, briefSha256: 'a'.repeat(64), builders: [], votes: [], observations: [],
    quorum: { approved: false, votingFamilies: [], approvingFamilies: [] } } });

test('T5 historical setup failures count, in the review read and in stats', async () => {
  const r = repo(), p = await pipe();
  try {
    plant(p, '00000000-0000-4000-8000-000000000001', oldReview(r, [
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', family: 'openai', requestId: '', status: 'failed', reason: NEVER },
      { provider: 'claude', model: 'opus', effort: 'high', family: 'anthropic', requestId: '', status: 'failed', reason: NEVER }]));
    plant(p, '00000000-0000-4000-8000-000000000002', oldReview(r, [
      { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', family: 'openai', requestId: 'req-killed', status: 'failed', reason: 'review submission failed' }]));
    const one = (await p.call('GET', '/v1/reviews/00000000-0000-4000-8000-000000000001')).json.review;
    assert.equal(one.setupFailed, true);
    const s = await p.call('GET', `/v1/stats?since=${today()}`);
    const d = s.json.days.find((x: any) => x.day === today());
    assert.equal(d.reviews.setupFailed, 2, s.text);
    assert.equal(d.reviews.seatFailed, 0, 'setup-stopped seats are not seat failures');
  } finally { await p.stop(); }
});

test('T6 a malformed stored review is skipped, never breaking stats', async () => {
  const r = repo(), p = await pipe();
  try {
    plant(p, '00000000-0000-4000-8000-000000000003', { ...oldReview(r, ['unexpected']), receipt: { votes: ['x'] } });
    await finished(p, (await p.call('POST', '/v1/reviews', review(r))).json.review.id);
    const s = await p.call('GET', `/v1/stats?since=${today()}`);
    assert.equal(s.status, 200, s.text);
    const d = s.json.days.find((x: any) => x.day === today());
    assert.ok(d.reviews.count >= 1 && d.reviews.approved === 1, s.text);
  } finally { await p.stop(); }
});

test('T7 the stats window is bounded to 31 days', async () => {
  const p = await pipe();
  try {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
    const r = await p.call('GET', `/v1/stats?since=${old}`);
    assert.equal(r.status, 400, r.text);
    const ok = await p.call('GET', `/v1/stats?since=${new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)}`);
    assert.equal(ok.status, 200, ok.text);
  } finally { await p.stop(); }
});

test('T8 a stored value outside the safe integer range is skipped, never breaking stats', async () => {
  const r = repo(), p = await pipe();
  try {
    plant(p, '00000000-0000-4000-8000-000000000004', { ...oldReview(r, []), lane: 'big', round: 9007199254740992 });
    const store = new Store(join(p.root, 'pipe.sqlite'));
    try {
      const req = store.submit({ requester: 'fixture', project: 'pipe', kind: 'code', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium',
        reason: 'r', prompt: 'p', mutating: true, priority: 'interactive', cwd: r.dir } as never);
      const account = { id: 'codex-a', provider: 'codex' as const, loginDir: p.root, fingerprint: '00000000', enabled: true, maxConcurrency: 1 };
      const claim = store.startAttempt(req.id, account, { accountId: account.id, model: 'gpt-6.1-sol', observedAt: new Date().toISOString(),
        verdict: { state: 'available', headroom: 0.5 }, grant: [] } as never) as { ok: boolean; attempt: { id: string } };
      if (claim.ok) {
        const ws = { path: join(r.dir, '..', 'gone-tree'), branch: 'pipe/x', commit: r.head, startCommit: r.base, saved: 'saved',
          diff: { files: 1, insertions: 9007199254740991, deletions: 9007199254740991 } };
        store.noteWorkspace(claim.attempt.id, ws as never);
        store.finishAttempt(claim.attempt.id, { kind: 'completed', result: 'OK', workspace: ws } as never);
      }
    } finally { store.close(); }
    await finished(p, (await p.call('POST', '/v1/reviews', review(r))).json.review.id);
    const s = await p.call('GET', `/v1/stats?since=${today()}`);
    assert.equal(s.status, 200, s.text);
    const d = s.json.days.find((x: any) => x.day === today());
    assert.ok(d && d.reviews.approved === 1, s.text);
  } finally { await p.stop(); }
});

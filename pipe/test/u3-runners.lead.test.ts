/**
 * Acceptance grader, lane U3: the runners (lead-authored). The implementation lane must not
 * edit this file or its fixtures.
 *
 * Sources: docs/SPEC.md concept 6 (runner) and 7 (record); docs/ROUTER-MAP.md, the Execution
 * and Failure invariants; LESSONS L2 (explicit tool grants), L6/L7 (silence is not loss),
 * L9 (say where the work landed), L11 (offline is not signed out).
 *
 * `src/runner.ts` exports `run(spec, options)`, an async iterable of events that ends with
 * exactly one terminal event (`completed` or `failed`). It runs the official CLI of the
 * account in-process as a child process group:
 *   - with the account's own login folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and an
 *     allow-listed environment: no API keys or tokens, and `PIPE_ORIGIN=runner` as a
 *     recursion guard;
 *   - read-only work in `spec.cwd` with read-only tools; changing work in a new git worktree
 *     on branch `pipe/<requestId>` under `options.worktreeRoot`, never in `spec.cwd`;
 *   - the model and effort exactly as chosen; the prompt delivered to the CLI.
 * There is no idle timeout: a CLI may think silently for as long as it likes.
 *
 * The fake CLIs used here replay streams captured from the real CLIs (test/fixtures) and
 * record their argv, stdin, environment and working folder.
 *
 * Amended for round 2 (see u3-runners-r2.lead.test.ts): a run names its account; a limit event
 * carries its account, model scope and time (X7); and "Not logged in" is a sign-out only when
 * the service is reachable, so X8 decides reachability itself (L11).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, type RunEvent, type RunSpec } from '../src/runner.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8').split('\n').filter((l) => l.trim() !== '');

type Step = { line?: string; stderr?: string; sleepMs?: number };
type Scenario = { steps: Step[]; exitCode?: number; ignoreTerm?: boolean; hang?: boolean; touch?: string; bigLineBytes?: number };

/** A fake CLI in its own temporary folder. `records()` returns what each invocation saw. */
function fakeCli(scenario: Scenario) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3-cli-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const script = join(dir, 'cli');
  writeFileSync(script, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(path.join(__dirname, 'record-' + process.pid + '.json'),
  JSON.stringify({ argv: process.argv.slice(2), stdin, env: process.env, cwd: process.cwd(), pid: process.pid }));
if (sc.ignoreTerm) process.on('SIGTERM', () => {});
if (sc.touch) fs.writeFileSync(path.join(process.cwd(), sc.touch), 'changed by the fake CLI\\n');
(async () => {
  for (const step of sc.steps) {
    if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
    if (step.line !== undefined) process.stdout.write(step.line + '\\n');
    if (step.stderr !== undefined) process.stderr.write(step.stderr + '\\n');
  }
  if (sc.bigLineBytes) process.stdout.write('x'.repeat(sc.bigLineBytes));
  if (sc.hang) await new Promise(() => { setInterval(() => {}, 1000); });
  process.exit(sc.exitCode ?? 0);
})();
`);
  chmodSync(script, 0o755);
  const records = () => readdirSync(dir).filter((f) => f.startsWith('record-'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string>; cwd: string; pid: number });
  return { path: script, records };
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3-repo-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'lead@example.invalid');
  git('config', 'user.name', 'Lead');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

function spec(over: Partial<RunSpec> = {}): RunSpec {
  const login = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3-login-')));
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`, accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'say OK', mutating: false, cwd: realpathSync(tmpdir()), loginDir: login, ...over,
  };
}

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

const SECRETS = {
  ANTHROPIC_API_KEY: 'fake-anthropic-key', OPENAI_API_KEY: 'fake-openai-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-not-pass',
  GITHUB_TOKEN: 'ghp-should-not-pass', AWS_SECRET_ACCESS_KEY: 'aws-should-not-pass', SOME_RANDOM_VAR: 'should-not-pass',
};
const parentEnv = () => ({ ...SECRETS, PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'en_US.UTF-8' });

// ── how each CLI is called ──────────────────────────────────────────────────

test('X1 Claude, read-only: the chosen model and effort, a stripped profile, read-only tools and no skipped permissions', async () => {
  const cli = fakeCli({ steps: fixture('claude-success.jsonl').map((line) => ({ line })) });
  const s = spec({ model: 'fable', effort: 'max' });
  terminalOf(await collect(run(s, { cli: { claude: cli.path }, env: parentEnv() })));
  const [rec] = cli.records();
  const argv = rec!.argv;
  const flag = (name: string) => argv[argv.indexOf(name) + 1];
  assert.equal(flag('--model'), 'fable');
  assert.equal(flag('--effort'), 'max');
  for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(argv.includes(f), `${f} in ${argv.join(' ')}`);
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
  const tools = (flag('--tools') ?? '').split(',').filter(Boolean);
  for (const writer of ['Edit', 'Write', 'Bash', 'NotebookEdit']) assert.ok(!tools.includes(writer), `read-only work cannot use ${writer}`);
  assert.ok(argv.includes('say OK') || rec!.stdin.includes('say OK'), 'the prompt reaches the CLI');
  assert.equal(rec!.cwd, s.cwd, 'read-only work runs where it was asked');
});

test('X2 Claude, changing work: its own worktree and branch, edit tools inside an OS sandbox, the original checkout untouched', async () => {
  const cli = fakeCli({ steps: fixture('claude-success.jsonl').map((line) => ({ line })), touch: 'CHANGED.md' });
  const origin = repo();
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3-worktrees-')));
  const s = spec({ mutating: true, cwd: origin });
  const events = await collect(run(s, { cli: { claude: cli.path }, env: parentEnv(), worktreeRoot }));
  const done = terminalOf(events);
  assert.equal(done.type, 'completed', JSON.stringify(done));
  const [rec] = cli.records();
  const argv = rec!.argv;
  const flag = (name: string) => argv[argv.indexOf(name) + 1];
  assert.equal(flag('--permission-mode'), 'acceptEdits');
  const settings = JSON.parse(flag('--settings') ?? '{}') as { sandbox?: Record<string, unknown> };
  assert.equal(settings.sandbox?.enabled, true);
  assert.equal(settings.sandbox?.failIfUnavailable, true, 'no silent widening when the OS sandbox is missing');
  assert.equal(settings.sandbox?.allowUnsandboxedCommands, false);
  const tools = (flag('--tools') ?? '').split(',');
  assert.ok(tools.includes('Edit') && tools.includes('Bash'), 'changing work can edit and run commands');
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
  assert.notEqual(rec!.cwd, origin, 'never in the original checkout');
  assert.ok(rec!.cwd.startsWith(worktreeRoot), `the worktree lives under worktreeRoot: ${rec!.cwd}`);
  assert.ok(existsSync(join(rec!.cwd, 'CHANGED.md')), 'the change is in the worktree');
  assert.ok(!existsSync(join(origin, 'CHANGED.md')), 'and not in the original checkout');
  const branch = execFileSync('git', ['-C', rec!.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(branch, `pipe/${s.requestId}`);
  assert.deepEqual(done.type === 'completed' ? done.workspace : null, { path: rec!.cwd, branch: `pipe/${s.requestId}` }, 'the record says where the work landed (L9)');
});

test('X3 Codex: the chosen model and effort, the right sandbox and folder, the prompt read from stdin (`-` last)', async () => {
  const cli = fakeCli({ steps: fixture('codex-success.jsonl').map((line) => ({ line })) });
  const readOnly = spec({ provider: 'codex', model: 'gpt-6-sol', effort: 'ultra' });
  terminalOf(await collect(run(readOnly, { cli: { codex: cli.path }, env: parentEnv() })));
  let argv = cli.records()[0]!.argv;
  const flag = (a: string[], name: string) => a[a.indexOf(name) + 1];
  assert.equal(argv[0], 'exec');
  for (const f of ['--ignore-user-config', '--json']) assert.ok(argv.includes(f), f);
  assert.equal(flag(argv, '-m'), 'gpt-6-sol');
  assert.ok(argv.includes('model_reasoning_effort=ultra'), argv.join(' '));
  assert.equal(flag(argv, '--sandbox'), 'read-only');
  assert.equal(flag(argv, '-C'), readOnly.cwd);
  // U5 fix round 4: the prompt goes on stdin (argv plus env is capped at 1 MiB on macOS); `-` tells codex to read it.
  assert.equal(argv.at(-1), '-');
  assert.ok(!argv.includes('say OK'), 'no request text in argv');
  const writer = fakeCli({ steps: fixture('codex-success.jsonl').map((line) => ({ line })) });
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u3-worktrees-')));
  const changing = spec({ provider: 'codex', model: 'gpt-6-astra', effort: 'high', mutating: true, cwd: repo() });
  terminalOf(await collect(run(changing, { cli: { codex: writer.path }, env: parentEnv(), worktreeRoot })));
  argv = writer.records()[0]!.argv;
  assert.equal(flag(argv, '-m'), 'gpt-6-astra');
  assert.equal(flag(argv, '--sandbox'), 'workspace-write');
  assert.ok(flag(argv, '-C')?.startsWith(worktreeRoot), 'Codex is pointed at the worktree, never the checkout');
});

test('X4 the environment is allow-listed: the account\'s own login folder, a recursion guard, no keys or tokens', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const cli = fakeCli({ steps: fixture(provider === 'claude' ? 'claude-success.jsonl' : 'codex-success.jsonl').map((line) => ({ line })) });
    const s = spec({ provider, model: provider === 'claude' ? 'opus' : 'gpt-6-sol' });
    terminalOf(await collect(run(s, { cli: { [provider]: cli.path }, env: parentEnv() })));
    const env = cli.records()[0]!.env;
    for (const name of Object.keys(SECRETS)) assert.equal(env[name], undefined, `${provider} must not see ${name}`);
    assert.equal(env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], s.loginDir);
    assert.equal(env.PIPE_ORIGIN, 'runner');
    assert.ok(env.PATH && env.HOME, 'PATH and HOME are kept');
  }
});

// ── what the CLI says back ──────────────────────────────────────────────────

test('X5 a captured Claude run: started with the service-reported model, then the text, then completed', async () => {
  const cli = fakeCli({ steps: fixture('claude-success.jsonl').map((line) => ({ line })) });
  const events = await collect(run(spec(), { cli: { claude: cli.path }, env: parentEnv() }));
  const started = events.find((e) => e.type === 'started');
  assert.ok(started && started.type === 'started');
  assert.equal(started.reportedModel, 'claude-sonnet-5', 'the record keeps the model the service reported');
  assert.equal(events[0]!.type, 'started');
  const done = terminalOf(events);
  assert.deepEqual(done, { type: 'completed', result: 'OK', workspace: null });
  assert.ok(events.some((e) => e.type === 'text' && e.text === 'OK'));
});

test('X6 a captured Codex run completes with its final message', async () => {
  const cli = fakeCli({ steps: fixture('codex-success.jsonl').map((line) => ({ line })) });
  const events = await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol' }), { cli: { codex: cli.path }, env: parentEnv() }));
  assert.equal(events[0]!.type, 'started');
  assert.deepEqual(terminalOf(events), { type: 'completed', result: 'CODEX-BACK-OK', workspace: null });
});

test('X7 a limit is reported with its reset, and fails the run as quota_exhausted', async () => {
  const claude = fakeCli({ steps: fixture('claude-weekly-limit.jsonl').map((line) => ({ line })), exitCode: 1 });
  const events = await collect(run(spec(), { cli: { claude: claude.path }, env: parentEnv() }));
  const limit = events.find((e) => e.type === 'limit');
  assert.ok(limit && limit.type === 'limit');
  assert.equal(limit.bucket, 'seven_day');
  assert.equal(limit.resetsAt, new Date(1790000000 * 1000).toISOString(), 'resetsAt is seconds, not milliseconds');
  assert.equal(limit.accountId, 'claude-a', 'the limit names its account');
  const done = terminalOf(events);
  assert.equal(done.type === 'failed' ? done.errorKind : done.type, 'quota_exhausted');
  const codex = fakeCli({ steps: fixture('codex-usage-limit.jsonl').map((line) => ({ line })), exitCode: 1 });
  const cevents = await collect(run(spec({ provider: 'codex', model: 'gpt-6-sol' }), { cli: { codex: codex.path }, env: parentEnv() }));
  const cdone = terminalOf(cevents);
  assert.equal(cdone.type === 'failed' ? cdone.errorKind : cdone.type, 'quota_exhausted');
  const climit = cevents.find((e) => e.type === 'limit');
  assert.ok(climit && climit.type === 'limit', 'the Codex limit is reported too');
  assert.ok(climit.resetsAt === null || !Number.isNaN(Date.parse(climit.resetsAt)), 'a reset is a real time or unknown, never a guess');
});

test('X8 failures say what kind they are: signed out, offline or other (L11)', async () => {
  // The service is reachable here, so "Not logged in" is a real sign-out (L11; R4 covers offline).
  const cases: Array<[string, Scenario, string]> = [
    ['signed out', { steps: [{ line: 'Not logged in · Please run /login' }], exitCode: 1 }, 'auth'],
    ['offline', { steps: [{ stderr: 'Error: getaddrinfo ENOTFOUND api.anthropic.com' }], exitCode: 1 }, 'offline'],
    ['unknown crash', { steps: [{ stderr: 'Segmentation fault' }], exitCode: 139 }, 'other'],
  ];
  for (const [what, scenario, kind] of cases) {
    const cli = fakeCli(scenario);
    const done = terminalOf(await collect(run(spec(), { cli: { claude: cli.path }, env: parentEnv(), reachable: async () => true })));
    assert.equal(done.type, 'failed', what);
    if (done.type === 'failed') {
      assert.equal(done.errorKind, kind, what);
      assert.ok(done.message.length > 0 && done.message.length <= 4_000, `${what}: a bounded, non-empty message`);
    }
  }
});

// ── time, cancellation and bounds ───────────────────────────────────────────

test('X9 silence is not loss: a CLI that thinks quietly still completes (L6, L7)', async () => {
  const lines = fixture('claude-success.jsonl');
  const cli = fakeCli({ steps: [{ line: lines[0]! }, { sleepMs: 1_500 }, ...lines.slice(1).map((line) => ({ line }))] });
  const done = terminalOf(await collect(run(spec(), { cli: { claude: cli.path }, env: parentEnv() })));
  assert.equal(done.type, 'completed');
});

test('X10 cancel stops the whole process, escalating past a CLI that ignores SIGTERM', async () => {
  for (const ignoreTerm of [false, true]) {
    const cli = fakeCli({ steps: [{ line: fixture('claude-success.jsonl')[0]! }], hang: true, ignoreTerm });
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const running = (async () => { for await (const e of run(spec(), { cli: { claude: cli.path }, env: parentEnv(), signal: controller.signal, killGraceMs: 300 })) events.push(e); })();
    const deadline = Date.now() + 5_000;
    while (!events.some((e) => e.type === 'started') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const pid = cli.records()[0]!.pid;
    controller.abort();
    await running;
    const done = terminalOf(events);
    assert.equal(done.type === 'failed' ? done.errorKind : done.type, 'cancelled', `ignoreTerm=${ignoreTerm}`);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, `the CLI (pid ${pid}) is gone, ignoreTerm=${ignoreTerm}`);
  }
});

test('X11 output is bounded: a runaway line cannot exhaust memory or break the record', async () => {
  const cli = fakeCli({ steps: [{ line: fixture('claude-success.jsonl')[0]! }], bigLineBytes: 8 * 1024 * 1024 });
  const events = await collect(run(spec(), { cli: { claude: cli.path }, env: parentEnv() }));
  terminalOf(events);
  for (const e of events) assert.ok(JSON.stringify(e).length <= 1024 * 1024, `event ${e.type} is bounded`);
});

test('S3 U1-U3 stay small and dependency-free', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  const src = new URL('../src/', import.meta.url);
  // Later lanes' own files are theirs to budget (U4: probe.ts, buckets.ts; U5: service, http, mcp, cli; U8: disk.ts; U10: review.ts; U11: client.ts, moved out of http.ts; U18: release-copy.ts; READ-CONTRACT-01: cards.ts; u51: retention.ts; U4's S4 checks its slice).
  const lines = readdirSync(src).filter((f) => f.endsWith('.ts') && !['probe.ts', 'buckets.ts', 'service.ts', 'http.ts', 'mcp.ts', 'cli.ts', 'disk.ts', 'client.ts', 'review.ts', 'agy.ts', 'telemetry.ts', 'release-copy.ts', 'cards.ts', 'projects.ts', 'retention.ts'].includes(f))
    .map((f) => readFileSync(new URL(f, src), 'utf8').split('\n').filter((l) => l.trim() !== '').length)
    .reduce((a, b) => a + b, 0);
  // U6 added the durable sign-in hold, its upgrade backfill, the claim guard and the bounded budget; U8 adds the
  // store's side of worktree retention and each attempt's own TMPDIR. S5 still caps the whole core.
  // U9 adds the runner's tool detection and untouched proof; U10 the store's reviews table and its atomic seat save
  // (the lead, 2026-09-26). U12 records a cancelled attempt's workspace in the store; U13 retires a bucket the
  // provider stops reporting, and a cached reading on a verified account only holds.
  // U15 keeps src/agy.ts under its own S15, and adds the store's one-seat AGY hold (the lead's delegate).
  // U13 follow-up adds 27 non-blank lines in this slice for two gates, cached ordering and A9's unmeasured hold.
  // READ-CONTRACT-01 step 1 (2026-09-30) keeps src/cards.ts under its own S19, and adds the wait codes, the saved state,
  // attempts(), a change number (moved by attempt writes too) and changedAfter(), the open-card read and a finish
  // stamp to the store, a proved runner liveness, and unique account display names: 105 (the Router owner).
  // READ-CONTRACT-01 step 2a (2026-09-30): the event clock, its store columns and noteEvents, and the runner's onEvent
  // hook: 38 (the Router owner).
  // Rule 49: the ledger marks a view that draws on credits and keeps credit room from
  // lifting a job's limit, and the queue ranks credit room last: 5 (the Router Architect).
  // READ-CONTRACT-01 step 2b (2026-09-30): closedAt's store column and noteClosed, and the runner's onClosed after a
  // group is proved gone and its pipes closed, or when no process was ever made: 27 (the Router owner).
  // L75: the shared planner/store slice grows by exactly 30 nonblank lines.
  // L76: atomic automatic admission/retention replaces implicit single-route waiting; measured +87 nonblank lines.
  // L78 / FIX ROUND2: exact net growth for final certificates, automatic retry proof and runner closure proof.
  // The 2026-10-08 merge of main with live line (saved bases, automatic routing, placement status, review placement and MCP narrow reads),
  // which ran live at 2,733 without this gate moving: +111, mostly store.ts and queue.ts (the lead).
  // Velocity telemetry: the store's review lane, round and setupFailed, and the saved diff (src/telemetry.ts is budgeted on its own in S5): +12 (the lead).
  // Telemetry round 3: the store's dedicated setup-cancel marker: +1 (the lead).
  // U39 account preference: +2 (the lead).
  // round 3: worktreeAddTimeoutMs is validated like gitTimeoutMs: +1 (the lead).
  // u42: src/projects.ts is budgeted on its
  // own in S5; the store's contextPacketSha256 request field: +2 (2,749 -> 2,751).
  // E1 idempotent admission: +308 (2,751 → 3,059), the lead.
  // u43 external leases (round 2): store lease table and pure reads, plus lease load in availability, planning and claims: +70 (3,059 → 3,129), the lead.
  // u43 review round 1: jobs-aware take, expiry sweep and grace: +10 (3,129 → 3,139), the lead.
  // u43 final round: renewal clock guard and sweep isolation: +3 (3,139 → 3,142), the lead.
  // u43 lead round 4: renewal window and heartbeat freshness: +4 (3,142 → 3,146), the lead.
  // u43: tick/TTL check at take and renew: +2 (3,146 → 3,148), the lead.
  // u44 housekeeping (round 3, no archiving; 2026-10-29): store housekeeping and save-strike fields, the review git deadline and src/classify.ts (regenerable ignored roots): +89 (3,148 → 3,237), the lead.
  // u44 lead round 4 (2026-10-29): byte-safe ignored listing, durable partial removal, fingerprints, write-aware capacity guard and abortable scans: +44 (3,237 → 3,281), the lead.
  // u44 lead round 5 (2026-10-29): resource-fork refusal, byte-safe walk, removal-refusal recovery, fair retries, placeholder re-listing and index-aware capacity: +38 (3,281 → 3,319), the lead.
  // u44 lead round 6 (2026-10-29): extended-attribute refusal, exit-128 removal recovery, hung-vs-slow scans, tree-aware capacity and other VCS markers: +74 (3,319 → 3,393), the lead.
  // u44 lead rounds 6b-6c (2026-10-29): removal-only xattr checks and the hung-group outcome: +2 (3,393 → 3,395), the lead.
  // u44 lead round 7 (2026-10-29): unambiguous xattr refusal, deleted-directory capacity, block-size rounding, the unproven-group gate and rethrown group failures: +41 (3,395 → 3,436), the lead.
  // u44 lead round 7c (2026-10-29): the prune group proof and file-to-directory capacity: +2 (3,436 → 3,438), the lead.
  // u49 round 2 (2026-10-31): canonical non-overlapping previous worktree roots, per-volume tiers and the restored disk.ts rationale comments (round 1 had moved them out to fit): +2 (3,438 → 3,440), the lead.
  // u49 round 5 (2026-10-31): src/worktree-roots.ts (abortable previous-root reads, per-pass availability, the root-bound proof), partly moved out of disk.ts: +109 (3,440 → 3,549), the lead.
  // u49 round 6 (2026-10-31): the no-follow walk under worktreeRoot, refresh-invalidated save proofs and unavailable-root handling: +16 (3,549 → 3,565), the lead.
  // u49 rounds 7-7b (2026-10-31): the canonical-root walk, per-pass abortable root checks, ancestor dev proof for a root created after startup and mount-point refusal: +22 (3,565 → 3,587), the lead.
  // u49 round 8 (2026-10-31): missing-root hold, guarded worktreeRoot creation and per-save root checks: +9 (3,587 → 3,596), the lead.
  // u49 round 9 (2026-10-31): unchecked or vanished-root finalization holds, startup refusal before the volume mounts and the startup-device guard: +3 (3,596 → 3,599), the lead.
  // u49.1 (2026-10-31): lost-volume detection, the optional work-volume marker and the canonical-root guard: +32 (3,599 → 3,631), the lead.
  // u51 (2026-11-01): the store's pruneEndedRecords for ended-record retention (one clock sample, a resumable scan cursor set after commit) and lane_rounds, each lane's highest round, backfilled once and raised on every review (src/retention.ts is budgeted on its own in S5): +18 (3,631 → 3,649), the Huntaway lead.
  assert.ok(lines <= 3_649, `src/ holds ${lines} non-blank lines; U1-U3 together have 3,649`);
});

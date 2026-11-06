import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import type { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { requestJson } from '../src/client.ts';
import { Store, type AttemptOutcome, type NewRequest } from '../src/store.ts';
import { claimRecord, flushLimitHolds, journalOf, markFailedStop, recheckHeld, recover, recoverFailedStop, saveLimitHolds, saveOutcomes, startPipe, stoppedOutcome } from '../src/service.ts';
import { AllowanceLedger } from '../src/allowance.ts';
import { plan } from '../src/queue.ts';
import { processStart, retireRunner, run } from '../src/runner.ts';
import { tcpReachable } from '../src/reachability.ts';

const request: NewRequest = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'routine', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'claude-a' };
const account = { id: 'claude-a', provider: 'claude' as const, loginDir: '/login', fingerprint: 'fingerprint', maxConcurrency: 1, enabled: true };
const evidence = { accountId: 'claude-a', model: 'opus', observedAt: '2026-09-24T12:00:00.000Z', verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read'] };

test('U5 restart and recorded limits keep a pinned read-only request eligible', () => {
  const now = () => new Date('2026-09-24T12:00:00.000Z');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-local-')), 'pipe.sqlite'), { now, maxAttempts: 1 });
  try {
    const a = store.submit(request);
    const started = store.startAttempt(a.id, account, evidence);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.finishAttempt(started.attempt.id, { kind: 'interrupted', message: 'service stopped' });
    assert.equal(store.get(a.id)?.state, 'queued');
    assert.deepEqual(store.get(a.id)?.avoid, []);
    const again = store.startAttempt(a.id, account, evidence);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    store.finishAttempt(again.attempt.id, { kind: 'failed', errorKind: 'rate_limited', message: 'limit', limitRecorded: true });
    assert.equal(store.get(a.id)?.state, 'queued');
    assert.deepEqual(store.get(a.id)?.avoid, []);
  } finally { store.close(); }
});

test('U5 an interrupted changing attempt records where its work remains', () => {
  const now = () => new Date('2026-09-24T12:00:00.000Z');
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-work-')), 'pipe.sqlite'), { now });
  try {
    const a = store.submit({ ...request, mutating: true, cwd: tmpdir() });
    const started = store.startAttempt(a.id, account, evidence);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const workspace = { path: '/work/branch', branch: `pipe/${a.id}`, commit: 'uncommitted' };
    store.finishAttempt(started.attempt.id, { kind: 'interrupted', message: 'service stopped', workspace });
    assert.deepEqual(store.get(a.id)?.workspace, workspace);
    assert.equal(store.get(a.id)?.state, 'failed');
  } finally { store.close(); }
});

test('U5 changing work must name an absolute working folder at submission', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-cwd-')), 'pipe.sqlite'));
  try { assert.throws(() => store.submit({ ...request, mutating: true }), /cwd/i); }
  finally { store.close(); }
});

test('U5 exclusions are validated, stored, and enforced at the attempt claim', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-exclude-')), 'pipe.sqlite'), { now: () => new Date(evidence.observedAt) });
  try {
    assert.throws(() => store.submit({ ...request, exclude: 'claude-a' } as unknown as NewRequest), /exclude/i);
    assert.throws(() => store.submit({ ...request, exclude: [''] }), /exclude/i);
    const row = store.submit({ ...request, pin: undefined, exclude: ['claude-a'] });
    assert.deepEqual(store.get(row.id)?.exclude, ['claude-a']);
    const claim = store.startAttempt(row.id, account, evidence);
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.match(claim.reason, /excluded/i);
  } finally { store.close(); }
});

test('U5 an excluded route waits with its reason and a bounded deadline', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-exclude-plan-')), 'pipe.sqlite'), { now: () => new Date(evidence.observedAt) });
  try {
    const row = store.submit({ ...request, pin: undefined, exclude: ['claude-a'] });
    const at = new Date(evidence.observedAt);
    const status = { account, running: 0, evidence: () => evidence };
    const decision = plan([row], [status], { now: at, pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.deepEqual(decision.dispatch, []);
    assert.match(decision.waits[0]?.reason ?? '', /exclude/i);
    assert.ok(decision.waits[0]?.until);
    store.setWaiting(row.id, decision.waits[0]!);
    const later = plan(store.waitingRequests(), [status], { now: new Date(at.getTime() + 1001), pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.match(later.fail[0]?.reason ?? '', /exclude/i);
    const other = { ...account, id: 'claude-b' };
    const alternative = plan([row], [status, { account: other, running: 0, evidence: () => ({ ...evidence, accountId: other.id }) }],
      { now: at, pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() });
    assert.equal(alternative.dispatch[0]?.accountId, 'claude-b');
  } finally { store.close(); }
});

test('U5 a weak token is rejected before the service binds', async () => {
  await assert.rejects(() => startPipe({ accounts: [], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
    storePath: '/tmp/not-opened.sqlite', worktreeRoot: '/tmp', cli: {}, token: 'short' }), /token/i);
});

test('U5 every limit waits without spending a try or avoiding its account', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-limits-')), 'pipe.sqlite'), { now: () => new Date(evidence.observedAt), maxAttempts: 1 });
  try {
    for (const kind of ['quota_exhausted', 'rate_limited'] as const) {
      const r = store.submit({ ...request, prompt: kind });
      const first = store.startAttempt(r.id, account, evidence);
      assert.equal(first.ok, true);
      if (!first.ok) continue;
      store.finishAttempt(first.attempt.id, { kind: 'failed', errorKind: kind, message: kind });
      assert.equal(store.get(r.id)?.state, 'queued');
      assert.deepEqual(store.get(r.id)?.avoid, []);
      const again = store.startAttempt(r.id, account, evidence);
      assert.equal(again.ok, true);
      if (again.ok) store.finishAttempt(again.attempt.id, { kind: 'completed', result: 'OK' });
    }
  } finally { store.close(); }
});

test('U5 a pre-spawn attempt can be requeued without blame after a crash', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-recover-')), 'pipe.sqlite'), { now: () => new Date(evidence.observedAt), maxAttempts: 1 });
  try {
    const r = store.submit(request);
    assert.equal(store.startAttempt(r.id, account, evidence).ok, true);
    store.reconcile('restart');
    assert.equal(store.get(r.id)?.state, 'queued');
    assert.deepEqual(store.get(r.id)?.avoid, []);
    assert.equal(store.startAttempt(r.id, account, evidence).ok, true);
  } finally { store.close(); }
});

test('U5 Codex marks the prompt-bearing spawn before it can run', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-codex-crash-')), 'pipe.sqlite'), { now: () => new Date(evidence.observedAt) });
  try {
    const codex = { ...account, id: 'codex-a', provider: 'codex' as const };
    const r = store.submit({ ...request, provider: 'codex', pin: codex.id, model: 'gpt-6-sol' });
    const started = store.startAttempt(r.id, codex, { ...evidence, accountId: codex.id, model: 'gpt-6-sol' });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.noteMayStart(started.attempt.id);
    store.reconcile('crashed at spawn');
    assert.equal(store.get(r.id)?.error?.kind, 'no_outcome');
  } finally { store.close(); }
});

test('U5 a pinned known limit waits past the pin timeout', () => {
  const r = { ...request, id: 'r', seq: 1, state: 'queued' as const, createdAt: evidence.observedAt, updatedAt: evidence.observedAt,
    waiting: { reason: 'limit', until: '2026-09-24T12:10:00.000Z', stoppedSince: '2026-09-24T11:00:00.000Z' },
    notBefore: null, avoid: [], result: null, workspace: null, error: null };
  const p = plan([r], [{ account, running: 0, evidence: () => ({ ...evidence, verdict: { state: 'unavailable', reason: 'allowance exhausted', until: '2026-09-24T12:10:00.000Z' } }) }],
    { now: new Date(evidence.observedAt), pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() });
  assert.equal(p.fail.length, 0);
  assert.equal(p.waits.length, 1);
  const hidden = plan([r], [{ account, running: 0,
    evidence: () => ({ ...evidence, verdict: { state: 'unknown', reason: 'login reading stale' } }),
    limitHold: () => ({ accountId: account.id, until: null }) }],
  { now: new Date(evidence.observedAt), pinWaitMs: 1000, evidenceMaxAgeMs: 60_000, load: new Map() });
  assert.equal(hidden.fail.length, 0, 'a recorded hold survives another unknown verdict');
});

test('U5 an unreadable dispatch does not trap an open attempt', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pipe-u5-corrupt-')), 'pipe.sqlite');
  const store = new Store(path, { now: () => new Date(evidence.observedAt) });
  const r = store.submit(request);
  const started = store.startAttempt(r.id, account, evidence);
  assert.equal(started.ok, true);
  store.close();
  if (!started.ok) return;
  const db = new DatabaseSync(path);
  db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run('{bad', started.attempt.id);
  db.close();
  const reopened = new Store(path, { now: () => new Date(evidence.observedAt) });
  try {
    assert.equal(reopened.recoveryAttempts().length, 1);
    reopened.reconcile('unreadable dispatch');
    assert.equal(reopened.openAttempts().length, 0);
    assert.equal(reopened.get(r.id)?.error?.kind, 'no_outcome');
  } finally { reopened.close(); }
});

test('U5 stored prompt and result stay below the request view budget', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-cap-')), 'pipe.sqlite'), { now: () => new Date(evidence.observedAt) });
  try {
    assert.throws(() => store.submit({ ...request, prompt: 'x'.repeat(1024 * 1024) }), /1 MiB/);
    const r = store.submit(request);
    const started = store.startAttempt(r.id, account, evidence);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.finishAttempt(started.attempt.id, { kind: 'completed', result: 'x'.repeat(9 * 1024 * 1024) });
    assert.ok(Buffer.byteLength(JSON.stringify({ request: store.get(r.id) })) < 8 * 1024 * 1024);
  } finally { store.close(); }
});

test('U5 a changing attempt records its work location while running', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'pipe-u5-workspace-')), 'pipe.sqlite'), { now: () => new Date(evidence.observedAt) });
  try {
    const r = store.submit({ ...request, mutating: true, cwd: tmpdir() });
    const started = store.startAttempt(r.id, account, evidence);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const work = { path: '/work/tree', branch: `pipe/${r.id}`, commit: 'uncommitted' };
    store.noteWorkspace(started.attempt.id, work);
    assert.deepEqual(store.get(r.id)?.workspace, work);
  } finally { store.close(); }
});

test('U5 reachability retries once and allows a ten-second TCP handshake', async () => {
  let calls = 0;
  const seen: number[] = [];
  const dial = ({ host, port }: { host: string; port: number }): Socket => {
    assert.deepEqual([host, port], ['provider.example', 443]);
    const socket = new EventEmitter() as EventEmitter & { setTimeout(ms: number, cb: () => void): void; destroy(): void };
    socket.setTimeout = (ms) => { seen.push(ms); };
    socket.destroy = () => {};
    queueMicrotask(() => socket.emit(++calls === 1 ? 'error' : 'connect', new Error('first attempt failed')));
    return socket as Socket;
  };
  assert.equal(await tcpReachable('provider.example', dial), true);
  assert.deepEqual(seen, [10_000, 10_000]);
});

test('U5 the first real model report survives a synthetic start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-u5-model-'));
  const cli = join(dir, 'cli');
  const lines = [...Array(16)].map(() => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'early' }] } }));
  lines.push(JSON.stringify({ type: 'system', subtype: 'init', model: 'wrong-model', session_id: 's' }));
  lines.push(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK' }));
  writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});\n`);
  chmodSync(cli, 0o755);
  const events = [];
  for await (const event of run({ requestId: 'model-test', accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high',
    prompt: 'OK', mutating: false, cwd: dir, loginDir: dir }, { cli: { claude: cli }, env: { PATH: process.env.PATH, HOME: process.env.HOME } })) events.push(event);
  assert.deepEqual(events.filter((e) => e.type === 'started').map((e) => e.reportedModel), [null, 'wrong-model']);
});

test('U5 a second-resolution runner mark cannot authorize a signal', async () => {
  await assert.rejects(() => retireRunner({ pid: process.pid, startedAt: 'Thu Sep 24 12:00:00 2026' }), /second-resolution/);
});

test('U5 MCP ignores nonobject frames and still answers initialize', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  try {
    child.stdin.end('null\n[]\n42\n"x"\n{"id":null}\n{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    await new Promise<void>((resolve, reject) => { child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`))); });
    assert.match(output, /"id":1/);
  } finally { child.kill(); }
});

test('U5 MCP answers an oversized frame and continues', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  try {
    child.stdin.end(`{"jsonrpc":"2.0","id":7,"method":"initialize","padding":"${'x'.repeat(1024 * 1024 + 4096)}"}\n{"jsonrpc":"2.0","id":8,"method":"initialize"}\n`);
    await new Promise<void>((resolve, reject) => child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`))));
    const frames = output.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames[0].id, null);
    assert.equal(frames[0].error.code, -32600);
    assert.equal(frames[1].id, 8);
  } finally { child.kill(); }
});

test('U5: an HTTP client never follows a redirect into another origin', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, options) => {
    calls++;
    assert.equal(options?.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'http://example.invalid/steal' } });
  };
  try {
    await assert.rejects(() => requestJson('http://127.0.0.1:8123', 'token', 'GET', '/v1/models'), /redirect/i);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('U5 client accepts a valid request view containing a large prompt and result', async () => {
  const original = globalThis.fetch;
  const request = { prompt: 'p'.repeat(900 * 1024), result: 'r'.repeat(900 * 1024) };
  globalThis.fetch = async () => new Response(JSON.stringify({ request }), { status: 200 });
  try { assert.deepEqual(await requestJson('http://127.0.0.1:8123', 'token', 'GET', '/v1/requests/id'), { request }); }
  finally { globalThis.fetch = original; }
});

test('S5: the core stays within its allocated line budget and has no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  const src = new URL('../src/', import.meta.url);
  const lines = readdirSync(src).filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(new URL(file, src), 'utf8').split('\n').filter((line) => line.trim()).length)
    .reduce((a, b) => a + b, 0);
  // U8 (disk hygiene) was budgeted 300 lines on a core of 3,708; its review rounds added the prune's
  // process-group handling, filter checks and the pre-prompt disk-full paths. U11 (remote use) added about 100
  // (the lead, 2026-09-26).
  // U9 (requeue untouched changing work) adds the runner's fail-closed tool detection (the lead, 2026-09-26).
  // U10 (reviews) adds review.ts (S10, 380) and about 130 lines of hooks and store; its review rounds 4-9
  // grew review.ts. U12 puts the runner's own git on runGit, with cancellation during setup (the lead,
  // 2026-09-26).
  // U13 adds the ledger's bucket retirement (the lead, 2026-09-26).
  // The review policy adds the review quorum's required families and approved review models (the lead).
  // U15 (Gemini review seats) adds src/agy.ts (S15, 330) and about 50 lines of review and service hooks: 384
  // over main's 4,831 (the lead's delegate, 2026-09-26).
  // U15 round 2 adds about 110 for the review's majors (the lead's delegate).
  // U15 round 4 adds 60 for K6's hostile-file hardening and the reused-PID guard (the lead).
  // U13 follow-up adds a net 42 non-blank lines for two gates, cached ordering, A9 and fail-closed version-2 migration.
  // A follow-up adds 19 lines for a durable failed/clock outcome after a rejected guarded vote write.
  // U18 adds a separately capped inert release copier; allow its 200-line budget here.
  // A completed changing job saves its own work through prune's
  // saveWorktree, queued on prune's chain so the two never share a worktree, with a saveOnCompletion switch that the
  // prune tests turn off; its review round pins the save's git and waits for the runner group; 31 lines over main's
  // 5,646 (the lead).
  // READ-CONTRACT-01 step 1 (the hub's job cards, 2026-09-30): content-free cards and health (src/cards.ts, under its
  // own S19), their three routes paged on a change number that attempt writes move too, the planner's wait codes, the
  // save's recorded result, a finish stamp set once, a runner liveness that is true only with proof, and unique account
  // display names: 195. It
  // replaces a hub reading whole records, prompts and results included, through GET /v1/requests/{id} (the Router owner).
  // READ-CONTRACT-01 step 2a (2026-09-30): the event clock that lets the hub say "Running" (src/event-clock.ts), its store
  // columns and noteEvents, the runner's onEvent hook, the service's throttled writes and the card's events: 48 (the
  // Router owner).
  // Rule 49: Codex credits the owner did not buy count as last-ranked room by opt-in
  // (`codexCredits`), with its config check; refused ordinary use fills every window; the queue ranks credit room last
  // and it never lifts a job's limit: 40 (the Router Architect).
  // READ-CONTRACT-01 step 2b (2026-09-30): closedAt, the proof a job's process group is gone that the hub's Resume needs:
  // the store column and noteClosed, the runner's onClosed, the service's records at a run's end, for an attempt that
  // never started a process and after a restart's reaper, only on proof, and the card's field: 34 (the Router owner).
  // L73: one staged-diff check replaces committing after every dirty status, even when staging clears it.
  // L75: replaces implicit-only ranking and transient-only selection reads; +32 nonblank lines.
  // L76: atomic automatic admission/retention replaces implicit single-route waiting; measured +118 nonblank lines.
  // L78 / FIX ROUND2: +8 nonblank lines replace unchecked credit exhaustion, shared save abort and proof-free auto retries.
  // L79: +12 nonblank lines replace implicit-only review admission with durable per-review ordinary placement.
  // L80: +108 nonblank lines replace implicit-only HEAD selection with optional receipt-bound saved-base admission.
  // L81 repair1: +24 nonblank lines replace runner-only validation with shared preclaim proof and canonical source checks.
  // L82 repair2: coordinator authorizes measured 6,297 -> 6,303 with zero headroom; replan after validation and gate pauses.
  // L83 / coordinator addition: measured +8 for MCP controls/card reads and omitted-selector pause compatibility; no headroom.
  // READ-CONTRACT-01 step 2c (2026-09-30): /v1/health's service.version (the pipe's own commit, read once at serve) and
  // each account's lastProbeAt and consecutiveProbeFailures: 30 (the Router owner).
  // A follow-up replaces prompt echo with bounded metadata in MCP status/wait; retain its original 14-line allocation
  // on top of main's already-reviewed 5,994-line budget. No behavioral assertion or timeout is changed.
  // The owner's finishing pass adds 15: exact-root/config-isolated release lookup, strict version projection and once-only
  // clock-gated probe stats. Replaces parent-repo/config-supplied version claims and catch-side ungated counters.
  // Exact current recount: main 6,008 + original health 30 + bounded health finish 15 = 6,053; no line packing.
  // Round1 replaces recursive submodule/filter-name execution with conservative unknown: 3 additional lines,
  // including one explanatory comment. Exact bounded core allocation is now 6,056, not a relaxed behavior gate.
  // 2026-10-08: the cleanup retry queue with back-off and one log line per failure, startup cleanup through
  // the same queue, and prune's keep-without-git for a deleted repository: 42 over main's 6,056 (the lead).
  // Merge recount: live 6,311 + 42 + main’s other growth 62 = 6,415 non-blank core lines; no headroom.
  // u29 executor host: executor hostAlias, requester-filtered listing, pipe_list MCP and pipe list/card CLI:
  // measured +27 non-blank lines (CLI +13, MCP +10, service +4), 6,415 -> 6,442; no headroom.
  // Replaces nothing; additive read surface and executor evidence.
  // U33 velocity telemetry: measured +112 (6,442 -> 6,554), no headroom. Indexed SQL aggregates, atomic lane
  // rounds and save-time numstat replace unmeasured/manual full-record reporting; no runtime dependency.
  // U33's first round also raised S2-S4 by 12, S8 by 6 and S19 by 3; those are independent per-lane caps.
  // U33 round 2 replaces flag-only setup accounting and unbounded/body-parsing reads: +13 (6,554 -> 6,567).
  // R1 (split out): the untouched-submodule save rule replaces the blanket gitlink refusal: +29 (6,567 -> 6,596; the lead).
  // Review b3dddf21: the admin modules check, the hidden-entry reason and the quiet keep: +5 (6,596 -> 6,601; the lead).
  // U39 account preference: +2 (the lead).
  // Setup timeouts under load: shared 300 s worktree-add limit, setup_timeout retry, review 503, HTTP 500 log: +20 (6,603 -> 6,623; the lead).
  // rounds 1-3: process-group closure proof, review 503 at the base 120 s limit, worktreeAddTimeoutMs validation: +19 (6,623 -> 6,642; the lead).
  // u42 per-project context packet and review output contract
  // (allocation proposed for review): src/projects.ts 47 plus 24 in review, http, service, store, CLI and
  // MCP: measured +71 (6,642 -> 6,713), no headroom. Replaces the launchers' own packet/contract concatenation, which
  // reached only briefs sent through those scripts and whose contract the service's closing schema line overrode.
  // u42 round 2 (review 2e903825): a read bounded by its cap, strict UTF-8 and native-seat-only reads: +4 (6,713 -> 6,717).
  // u42 discoverability: per-call contextPacket/outputContract, the one-time
  // hint, configured projects in /v1/capabilities and MCP pipe_capabilities: +32 (6,717 -> 6,749), no headroom.
  // u42 round 5 (review 7d07353c): well-formed per-call text, strict CLI file reads, no hint for Gemini-only reviews: +5 (6,754).
  // E1 idempotent admission: +304 (6,754 → 7,058), the lead.
  // E1 idempotent admission, amended: +4 (7058 → 7062), accepted by the lead
  // u43 external leases (round 2): store lease table and pure reads, plus lease load in availability, planning and claims: +115 (7,062 → 7,177), the lead.
  // u43 review round 1: jobs-aware take, expiry sweep and grace: +12 (7,177 → 7,189), the lead.
  // u43 final round: renewal clock guard and sweep isolation: +3 (7,189 → 7,192), the lead.
  // u43 lead round 4: renewal window and heartbeat freshness: +4 (7,192 → 7,196), the lead.
  // u43 lead round 5: +1 (7,196 → 7,197), the lead; its startup tick/TTL refusal moved to take/renew in round 6, which uses this line.
  // u43: tick/TTL check at take and renew: +1 (7,197 → 7,198), the lead.
  // u43 lead round 7 (2026-10-29): startup warning for slow ticks: +2 (7,198 → 7,200), the lead.
  // u44 housekeeping (round 3, no archiving; 2026-10-29): disk-pressure tiers, bounded passes, kept kinds, the save capacity guard, cached health counts, reset and the CLI, plus the store and classify lines above: +301 (7,200 → 7,501), the lead.
  // u44 lead round 4 (2026-10-29): byte-safe ignored listing, durable partial removal, fingerprints, write-aware capacity guard and abortable scans: +44 (7,501 → 7,545), the lead.
  // u44 lead round 5 (2026-10-29): resource-fork refusal, byte-safe walk, removal-refusal recovery, fair retries, placeholder re-listing and index-aware capacity: +37 (7,545 → 7,582), the lead.
  // u44 lead round 6 (2026-10-29): extended-attribute refusal, exit-128 removal recovery, hung-vs-slow scans, tree-aware capacity and other VCS markers: +75 (7,582 → 7,657), the lead.
  // u44 lead rounds 6b-6c (2026-10-29): removal-only xattr checks and the hung-group outcome: +2 (7,657 → 7,659), the lead.
  // u44 lead round 7 (2026-10-29): unambiguous xattr refusal, deleted-directory capacity, block-size rounding, the unproven-group gate and rethrown group failures: +41 (7,659 → 7,700), the lead.
  // u49 round 2 (2026-10-31): canonical non-overlapping previous worktree roots, per-volume tiers and the restored disk.ts rationale comments (round 1 had moved them out to fit): +36 (7,700 → 7,736), the lead.
  // u49 round 3 (2026-10-31): finalization-first membership, narrowed previous-root rules, one resolved location set and hung-volume short-circuits: +24 (7,736 → 7,760), the lead.
  // u49 round 4 (2026-10-31): startup root proof reused by saves: +2 (7,760 → 7,762), the lead.
  // u49 round 5 (2026-10-31): src/worktree-roots.ts (abortable previous-root reads, per-pass availability, the root-bound proof), partly moved out of disk.ts: +88 (7,762 → 7,850), the lead.
  // u49 round 6 (2026-10-31): the no-follow walk under worktreeRoot, refresh-invalidated save proofs and unavailable-root handling: +25 (7,850 → 7,875), the lead.
  // u49 rounds 7-7b (2026-10-31): the canonical-root walk, per-pass abortable root checks, ancestor dev proof for a root created after startup and mount-point refusal: +31 (7,875 → 7,906), the lead.
  // u49 round 8 (2026-10-31): missing-root hold, guarded worktreeRoot creation and per-save root checks: +12 (7,906 → 7,918), the lead.
  // u49 round 8b (2026-10-31): the worktreeRoot failure wrapper: +1 (7,918 → 7,919), the lead.
  // u49 round 9 (2026-10-31): unchecked or vanished-root finalization holds, startup refusal before the volume mounts and the startup-device guard: +10 (7,919 → 7,929), the lead.
  // u44.2 merged into u49 (2026-10-31): the pressure yield floor and repeat cadence: +4 (7,929 → 7,933), the lead.
  // u49.1 (2026-10-31): lost-volume drain and exit 75, the optional work-volume marker and the canonical-root guard: +40 (7,933 → 7,973), the lead.
  // 2026-11-01: a /usage page with the week but no session line reads as a session not yet started: +3 (7,973 → 7,976), the Huntaway lead.
  // u51 (2026-11-01): Huntaway cleans up only what it makes: src/retention.ts (ended-record retention
  // and the service log's size cap) 97, the store's pruneEndedRecords and lane_rounds 18, and the service's housekeeping hooks
  // with the replay-pending guard and its once-only log lines 9: +124 (7,976 → 8,100), the Huntaway lead.
  assert.ok(lines <= 8_100, `core has ${lines} non-blank lines`);
  // src/telemetry.ts keeps the per-day stats SQL in its own small file (the lead).
  const tele = readFileSync(new URL('telemetry.ts', src), 'utf8').split('\n').filter((line) => line.trim()).length;
  assert.ok(tele <= 80, `src/telemetry.ts holds ${tele} non-blank lines; its budget is 80`);
  // src/projects.ts (u42) holds the per-project packet and contract config and file reading on its own.
  const projects = readFileSync(new URL('projects.ts', src), 'utf8').split('\n').filter((line) => line.trim()).length;
  // src/retention.ts (u51) holds the ended-record retention SQL and the in-place log trim on its own.
  const retention = readFileSync(new URL('retention.ts', src), 'utf8').split('\n').filter((line) => line.trim()).length;
  assert.ok(retention <= 97, `src/retention.ts holds ${retention} non-blank lines; its budget is 97`);
  assert.ok(projects <= 70, `src/projects.ts holds ${projects} non-blank lines; its budget is 70 (47, round 2's bounded strict read 3, discoverability 17, round 5's shared strict decoder 3)`);
});

// ── Fix round 3 ─────────────────────────────────────────────────────────────

const unpinned: NewRequest = { ...request, pin: undefined };
const tempStore = (name: string) => join(mkdtempSync(join(tmpdir(), `pipe-u5-${name}-`)), 'pipe.sqlite');

test('U5 a job limit is saved with the record, restored by a fresh ledger, and dropped only when the ledger drops it', () => {
  let t = Date.parse('2026-09-24T12:00:00.000Z');
  const now = () => new Date(t);
  const path = tempStore('limits');
  const reset = '2026-09-24T12:10:00.000Z';
  const room = [{ bucket: 'five_hour', model: null, usedFraction: 0.1, resetsAt: '2026-09-24T17:00:00.000Z' }];
  const first = new AllowanceLedger({ freshnessMs: 60_000, now });
  first.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: '2026-09-24T12:05:00.000Z', observedAt: now().toISOString() });
  first.recordLimit('claude-a', { bucket: 'five_hour', model: null, resetsAt: reset, observedAt: now().toISOString() });   // supersedes the first
  const store = new Store(path, { now });
  store.saveLimits('claude-a', first.limitHolds('claude-a'));
  store.close();
  const reopened = new Store(path, { now });
  try {
    assert.deepEqual(reopened.limits(), [{ accountId: 'claude-a', hit: { bucket: 'five_hour', model: null, resetsAt: reset, observedAt: '2026-09-24T12:00:00.000Z' } }]);
    const second = new AllowanceLedger({ freshnessMs: 60_000, now });
    for (const { accountId, hit } of reopened.limits()) second.recordLimit(accountId, hit);
    t += 60_000;
    second.record('claude-a', room, undefined, { verified: false });   // a cached reading before the reset
    assert.equal(second.view('claude-a', 'opus').state, 'exhausted', 'the restored limit still holds');
    reopened.saveLimits('claude-a', second.limitHolds('claude-a'));
    assert.equal(reopened.limits().length, 1);
    t = Date.parse(reset) + 1_000;
    second.record('claude-a', room, undefined, { verified: false });   // a reading after the reset clears it
    assert.equal(second.view('claude-a', 'opus').state, 'ok');
    reopened.saveLimits('claude-a', second.limitHolds('claude-a'));
    assert.deepEqual(reopened.limits(), []);
  } finally { reopened.close(); }
});

test('U5 a restart never reruns an attempt whose old runner group may be alive; it ends the attempt once the group is gone', async () => {
  const path = tempStore('held');
  const store = new Store(path);
  const group = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    await once(group, 'spawn');
    const r = store.submit(unpinned);
    const started = store.startAttempt(r.id, account, { ...evidence, observedAt: new Date().toISOString() });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.noteRunner(started.attempt.id, { pid: group.pid!, startedAt: 'unverified:test' });
    const lines: string[] = [];
    const log = (where: string, e: unknown) => { lines.push(`${where}: ${String(e)}`); };
    const held = await recover(store, journalOf(path), log);
    assert.equal(held.size, 1);
    assert.equal(store.openAttempts().length, 1, 'the attempt stays open');
    assert.equal(store.get(r.id)?.state, 'running', 'and its request is not requeued');
    assert.match(store.get(r.id)?.waiting?.reason ?? '', /may still be alive/, 'the request says why it waits');
    assert.ok(lines.some((l) => /may still be alive/.test(l)), 'and the log says so');
    await recheckHeld(store, held, log);
    assert.equal(held.size, 1, 'still held while the group lives');
    group.kill('SIGKILL');
    await once(group, 'exit');
    await recheckHeld(store, held, log);
    assert.equal(held.size, 0);
    assert.equal(store.openAttempts().length, 0);
    assert.equal(store.get(r.id)?.state, 'queued');
    assert.equal(store.get(r.id)?.waiting, null);
  } finally { group.kill('SIGKILL'); store.close(); }
});

test('U5 an outcome a stopping pipe cannot write is journaled owner-only, then recorded at the next start: never rerun, never blamed', async () => {
  const previous = process.umask(0o022);   // an umask of 077 would make the mode check pass vacuously
  try {
    const path = tempStore('journal');
    const store = new Store(path);
    const r = store.submit(unpinned);
    const started = store.startAttempt(r.id, account, { ...evidence, observedAt: new Date().toISOString() });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.noteRunner(started.attempt.id, { pid: spawnSync(process.execPath, ['-e', '']).pid!, startedAt: 'unverified:gone' });
    let tries = 0;
    const broken = { finishAttempt: (): never => { tries++; throw new Error('disk I/O error'); } };
    const pending = new Map<string, AttemptOutcome>([[started.attempt.id, { kind: 'completed', result: 'OK' }]]);
    await saveOutcomes(broken, pending, journalOf(path), () => {});
    assert.equal(tries, 3, 'written a few times first');
    assert.equal(pending.size, 0);
    assert.equal(statSync(journalOf(path)).mode & 0o777, 0o600);
    store.close();
    const reopened = new Store(path);
    try {
      assert.equal((await recover(reopened, journalOf(path), () => {})).size, 0);
      const back = reopened.get(r.id)!;
      assert.equal(back.state, 'completed');
      assert.equal(back.result, 'OK');
      assert.deepEqual(back.avoid, []);
      assert.equal(reopened.attempts(r.id).length, 1, 'not run again');
      assert.equal(existsSync(journalOf(path)), false);
    } finally { reopened.close(); }
  } finally { process.umask(previous); }
});

test('U5 a stop before the CLI started requeues even changing work without blame', () => {
  const store = new Store(tempStore('prespawn'), { now: () => new Date(evidence.observedAt) });
  try {
    const r = store.submit({ ...unpinned, mutating: true, cwd: tmpdir() });
    const started = store.startAttempt(r.id, account, evidence);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const outcome = stoppedOutcome({ kind: 'cancelled', message: 'cancelled before the CLI started' }, false);
    assert.equal(outcome.kind, 'unstarted');
    store.finishAttempt(started.attempt.id, outcome);
    const back = store.get(r.id)!;
    assert.equal(back.state, 'queued');
    assert.deepEqual(back.avoid, []);
    assert.doesNotMatch(back.error?.message ?? '', /inspect/);
    assert.equal(stoppedOutcome({ kind: 'cancelled' }, true).kind, 'interrupted', 'once the CLI may have begun, the work is inspected');
  } finally { store.close(); }
});

test('U5 a request waits out at most 20 limits, so a failure that only looks like one cannot requeue for ever', () => {
  const store = new Store(tempStore('limit-cap'), { now: () => new Date(evidence.observedAt), maxAttempts: 1 });
  try {
    const r = store.submit(unpinned);
    for (let n = 1; n <= 20; n++) {
      const started = store.startAttempt(r.id, account, evidence);
      assert.equal(started.ok, true, `limit ${n}`);
      if (!started.ok) return;
      store.finishAttempt(started.attempt.id, { kind: 'failed', errorKind: n % 2 ? 'quota_exhausted' : 'rate_limited', message: 'usage limit reached' });
      assert.equal(store.get(r.id)?.state, n < 20 ? 'queued' : 'failed', `after limit ${n}`);
    }
    assert.match(store.get(r.id)?.error?.message ?? '', /gave up after 20 limits/);
  } finally { store.close(); }
});

test('U5 the runner stops its own group after the CLI exits, and SIGKILLs a member that ignores SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-u5-group-'));
  const cli = join(dir, 'cli');
  const out = [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's' }, { type: 'result', subtype: 'success', result: 'OK' }].map((o) => JSON.stringify(o)).join('\n');
  writeFileSync(cli, `#!${process.execPath}
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const member = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
fs.writeFileSync(path.join(__dirname, 'member.pid'), String(member.pid));
member.stdout.once('data', () => { process.stdout.write(${JSON.stringify(out + '\n')}); process.exit(0); });
`);
  chmodSync(cli, 0o755);
  const events = [];
  for await (const event of run({ requestId: 'group-test', accountId: 'claude-a', provider: 'claude', model: 'opus', effort: 'high', prompt: 'OK', mutating: false, cwd: dir, loginDir: dir },
    { cli: { claude: cli }, env: { PATH: process.env.PATH, HOME: process.env.HOME }, killGraceMs: 300 })) events.push(event);
  assert.equal(events.at(-1)?.type, 'completed');
  const member = Number(readFileSync(join(dir, 'member.pid'), 'utf8'));
  const alive = () => { try { process.kill(member, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i++) await sleep(50);
  try { assert.equal(alive(), false, 'the member left in the group is stopped'); }
  finally { if (alive()) process.kill(member, 'SIGKILL'); }
});

test('U5 a stale service lock is taken over whole, a live one is refused, and no claim file is left behind', () => {
  const path = tempStore('lock');
  const dir = join(path, '..');
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  writeFileSync(`${path}.pipe-lock`, JSON.stringify({ pid: dead, startedAt: 'Thu Jan  1 00:00:00 2026', nonce: 'old' }));
  const release = claimRecord(path);
  assert.equal(JSON.parse(readFileSync(`${path}.pipe-lock`, 'utf8')).pid, process.pid);
  assert.deepEqual(readdirSync(dir), ['pipe.sqlite.pipe-lock']);
  assert.throws(() => claimRecord(path), /already in use/);
  assert.deepEqual(readdirSync(dir), ['pipe.sqlite.pipe-lock'], 'a refused claim leaves the owner\'s lock and nothing else');
  release();
  assert.deepEqual(readdirSync(dir), []);
});

// ── Fix round 5: a failed write must remain work to do ─────────────────────

test('U5 a failed limit write remains pending and is retried on the next flush', () => {
  const ledger = new AllowanceLedger({ freshnessMs: 60_000 });
  ledger.recordLimit(account.id, { bucket: 'five_hour', model: null, resetsAt: null });
  const pending = new Set<string>([account.id]);
  const written: unknown[] = [];
  let fail = true;
  const store = { saveLimits: (_id: string, holds: unknown) => {
    if (fail) throw new Error('disk I/O error');
    written.push(holds);
  } };
  const logs: string[] = [];
  flushLimitHolds(store, ledger, pending, (where, error) => logs.push(`${where}: ${String(error)}`));
  assert.deepEqual([...pending], [account.id]);
  assert.deepEqual(written, []);
  assert.match(logs.join('\n'), /disk I\/O error/);
  fail = false;
  flushLimitHolds(store, ledger, pending, () => {});
  assert.equal(pending.size, 0);
  assert.equal(written.length, 1);
});

test('U5 a limit hold that cannot reach the record is journaled and restored before planning', async () => {
  const path = tempStore('hold-journal');
  const ledger = new AllowanceLedger({ freshnessMs: 60_000 });
  ledger.recordLimit(account.id, { bucket: 'five_hour', model: null, resetsAt: null });
  const pending = new Set([account.id]);
  await saveLimitHolds({ saveLimits: () => { throw new Error('disk I/O error'); } }, ledger, pending, journalOf(path), () => {});
  assert.equal(pending.size, 0);
  const store = new Store(path);
  try {
    await recover(store, journalOf(path), () => {});
    assert.equal(store.limits().length, 1);
    assert.equal(store.limits()[0]?.accountId, account.id);
    assert.equal(existsSync(journalOf(path)), false);
  } finally { store.close(); }
});

test('U5 a failed held-attempt reconcile is retried and the request leaves running', async () => {
  const path = tempStore('reconcile-retry');
  const store = new Store(path);
  try {
    const row = store.submit(unpinned);
    const started = store.startAttempt(row.id, account, { ...evidence, observedAt: new Date().toISOString() });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const held = new Map([[started.attempt.id, { pid: dead, startedAt: 'unverified:gone' }]]);
    let fail = true;
    const wrapped = new Proxy(store, { get(target, key) {
      if (key === 'reconcile') return (...args: Parameters<Store['reconcile']>) => {
        if (fail) throw new Error('disk I/O error');
        return target.reconcile(...args);
      };
      return Reflect.get(target, key, target);
    } });
    await assert.rejects(() => recheckHeld(wrapped, held, () => {}), /disk I\/O error/);
    assert.equal(held.size, 1);
    assert.equal(store.get(row.id)?.state, 'running');
    fail = false;
    await recheckHeld(wrapped, held, () => {});
    assert.equal(held.size, 0);
    assert.equal(store.get(row.id)?.state, 'queued');
  } finally { store.close(); }
});

test('U5 a failed store and journal leave the outcome pending and reject stop persistence', async () => {
  const path = tempStore('double-failure');
  const pending = new Map<string, AttemptOutcome>([['attempt', { kind: 'completed', result: 'OK' }]]);
  const logs: string[] = [];
  const journal = journalOf(path);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(journal); // open('a') cannot write a directory.
  await assert.rejects(() => saveOutcomes({ finishAttempt: () => { throw new Error('store unavailable'); } }, pending,
    journal, (where, error) => logs.push(`${where}: ${String(error)}`)), /unsaved|persist|outcome/i);
  assert.equal(pending.size, 1);
  assert.match(logs.join('\n'), /journal attempt/);
});

test('U5 a busy takeover gate leaves the stale lock in place', () => {
  const path = tempStore('takeover-gate');
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  const old = JSON.stringify({ pid: dead, startedAt: 'unverified:gone', nonce: 'old' });
  writeFileSync(`${path}.pipe-lock`, old);
  writeFileSync(`${path}.pipe-takeover`, 'busy');
  assert.throws(() => claimRecord(path), /takeover|busy|claim/i);
  assert.equal(readFileSync(`${path}.pipe-lock`, 'utf8'), old);
});

test('U5 a failed stop marker blocks stale takeover until the named outcome is supplied or given up', async () => {
  const path = tempStore('failed-stop-marker');
  const store = new Store(path, { now: () => new Date(evidence.observedAt) });
  const row = store.submit(request);
  const started = store.startAttempt(row.id, account, evidence);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  store.close();
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  writeFileSync(`${path}.pipe-lock`, JSON.stringify({ pid: dead, startedAt: 'unverified:gone', nonce: 'old' }));
  const pending = new Map<string, AttemptOutcome>([[started.attempt.id, { kind: 'completed', result: 'OK' }]]);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(journalOf(path));
  await assert.rejects(() => saveOutcomes({ finishAttempt: () => { throw new Error('injected outcome write failure'); } },
    pending, journalOf(path), () => {}), /could not be persisted/);
  markFailedStop(path, [...pending.keys()]);
  assert.throws(() => claimRecord(path), new RegExp(started.attempt.id));
  const config = join(path, '..', 'config.json');
  writeFileSync(config, JSON.stringify({ storePath: path }));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const show = spawnSync(process.execPath, [cli, 'recover', '--config', config], { encoding: 'utf8' });
  assert.equal(show.status, 0, show.stderr);
  assert.deepEqual(JSON.parse(show.stdout), { unresolvedAttempts: [started.attempt.id] });
  const clear = spawnSync(process.execPath, [cli, 'recover', '--config', config, '--attempt', started.attempt.id,
    '--outcome', JSON.stringify({ kind: 'completed', result: 'supplied by operator' })], { encoding: 'utf8' });
  assert.equal(clear.status, 0, clear.stderr);
  assert.deepEqual(JSON.parse(clear.stdout), { unresolvedAttempts: [] });
  const claim = claimRecord(path); claim();
  const reopened = new Store(path);
  try { assert.equal(reopened.get(row.id)?.state, 'completed'); }
  finally { reopened.close(); }
});

test('U5 a dead takeover gate is reclaimed while a live owner gate is respected', () => {
  const path = tempStore('gate-reclaim');
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  writeFileSync(`${path}.pipe-takeover`, JSON.stringify({ pid: dead, startedAt: 'unverified:gone', nonce: 'old' }));
  const release = claimRecord(path); release();
  writeFileSync(`${path}.pipe-takeover`, JSON.stringify({ pid: process.pid, startedAt: processStart(process.pid), nonce: 'live' }));
  assert.throws(() => claimRecord(path), /takeover|busy|in use/i);
  assert.equal(existsSync(`${path}.pipe-takeover`), true);
  unlinkSync(`${path}.pipe-takeover`);
});

test('U5 takeover publishes a complete gate owner with one exclusive link', () => {
  const path = tempStore('atomic-gate');
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    const path = ${JSON.stringify(path)};
    const gate = path + '.pipe-takeover';
    const original = fs.linkSync;
    let published = false;
    fs.linkSync = (from, to) => {
      if (to === gate) {
        assert.equal(fs.existsSync(gate), false);
        const owner = JSON.parse(fs.readFileSync(from, 'utf8'));
        assert.equal(owner.pid, process.pid);
        assert.ok(owner.startedAt && owner.nonce);
        published = true;
      }
      return original(from, to);
    };
    syncBuiltinESMExports();
    const { claimRecord } = await import(${JSON.stringify(new URL('../src/service.ts', import.meta.url).href)});
    const release = claimRecord(path);
    release();
    assert.equal(published, true);
    assert.equal(fs.existsSync(gate), false);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('U5 giving up a changing attempt keeps its recorded workspace', () => {
  const path = tempStore('give-up-workspace');
  const store = new Store(path, { now: () => new Date(evidence.observedAt) });
  const row = store.submit({ ...request, mutating: true, cwd: tmpdir() });
  const started = store.startAttempt(row.id, account, evidence);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const work = { path: '/work/tree', branch: `pipe/${row.id}`, commit: 'abc123' };
  store.noteWorkspace(started.attempt.id, work);
  store.close();
  markFailedStop(path, [started.attempt.id]);
  assert.deepEqual(recoverFailedStop(path, started.attempt.id), []);
  const reopened = new Store(path);
  try {
    assert.equal(reopened.get(row.id)?.state, 'failed');
    assert.deepEqual(reopened.get(row.id)?.workspace, work);
  } finally { reopened.close(); }
});

test('U5 a malformed limit observation is rejected, while an absent or undefined one means now', () => {
  const at = new Date('2026-09-25T12:00:00.000Z');
  const ledger = new AllowanceLedger({ freshnessMs: 60_000, now: () => at });
  const hit = { bucket: 'five_hour', model: null, resetsAt: null };
  assert.throws(() => ledger.recordLimit(account.id, { ...hit, observedAt: 'yesterday' }), TypeError);
  assert.throws(() => ledger.recordLimit(account.id, { ...hit, observedAt: '2026-02-30T12:00:00Z' }), TypeError);
  assert.doesNotThrow(() => ledger.recordLimit(account.id, { ...hit, observedAt: undefined }));
  ledger.recordLimit(account.id, hit);
  assert.equal(ledger.limitHolds(account.id)[0]?.observedAt, at.toISOString());
});

test('U5 journal loops over short writes and keeps a failed entry pending', async () => {
  const path = tempStore('short-journal');
  const pending = new Map<string, AttemptOutcome>([['attempt', { kind: 'completed', result: 'OK' }]]);
  let calls = 0;
  const short = (fd: number, bytes: Uint8Array, offset: number, length: number): number => {
    calls++;
    return writeSync(fd, bytes, offset, Math.min(3, length));
  };
  await saveOutcomes({ finishAttempt: () => { throw new Error('store unavailable'); } }, pending, journalOf(path), () => {}, short);
  assert.ok(calls > 1);
  assert.equal(pending.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(journalOf(path), 'utf8')), { attemptId: 'attempt', outcome: { kind: 'completed', result: 'OK' } });
  pending.set('second', { kind: 'completed', result: 'again' });
  const before = readFileSync(journalOf(path), 'utf8');
  let partial = false;
  await assert.rejects(() => saveOutcomes({ finishAttempt: () => { throw new Error('store unavailable'); } }, pending, journalOf(path), () => {},
    (fd, bytes, offset, length) => {
      if (partial) throw new Error('short write failed');
      partial = true;
      return writeSync(fd, bytes, offset, Math.min(3, length));
    }), /persisted/);
  assert.equal(pending.size, 1);
  assert.equal(readFileSync(journalOf(path), 'utf8'), before);
  const holds = new Set([account.id]);
  await assert.rejects(() => saveLimitHolds({ saveLimits: () => { throw new Error('store unavailable'); } },
    new AllowanceLedger({ freshnessMs: 60_000 }), holds, journalOf(path), () => {}, () => { throw new Error('journal unavailable'); }), /persisted/);
  assert.deepEqual([...holds], [account.id]);
});

function seededStopHold(path: string, loginDir: string): string {
  const store = new Store(path);
  try {
    store.saveLimits(account.id, [{ bucket: 'five_hour', model: null, resetsAt: null, observedAt: new Date().toISOString() }]);
  } finally { store.close(); }
  // A resolved CLI lets startup finish a probe. The probe marks the restored hold dirty,
  // while its unknown reading leaves the hold in place and the injected store write fails.
  const cli = join(loginDir, 'claude');
  writeFileSync(cli, `#!${process.execPath}\nprocess.exit(1);\n`);
  chmodSync(cli, 0o755);
  return cli;
}

test('U5 stop rejects a persistently unwritable hold and keeps the service lock', async (t) => {
  const path = tempStore('hold-stop');
  const loginDir = mkdtempSync(join(tmpdir(), 'pipe-u5-login-'));
  const cli = seededStopHold(path, loginDir);
  const original = Store.prototype.saveLimits;
  Store.prototype.saveLimits = () => { throw new Error('injected limit write failure'); };
  try {
    let pipe: Awaited<ReturnType<typeof startPipe>>;
    try { pipe = await startPipe({ accounts: [{ ...account, loginDir, enabled: false }],
      policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      storePath: path, worktreeRoot: loginDir, cli: { claude: cli },
      token: 'x'.repeat(32), port: 0, reachable: async () => false, tickMs: 10 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('sandbox denies loopback bind'); return; }
      throw e;
    }
    const { mkdirSync } = await import('node:fs');
    mkdirSync(journalOf(path));
    await assert.rejects(() => pipe.stop(), /limit hold.*could not be persisted/i);
    assert.equal(existsSync(`${path}.pipe-lock`), true);
    assert.throws(() => claimRecord(path), /already in use/);
  } finally {
    Store.prototype.saveLimits = original;
    if (existsSync(`${path}.pipe-lock`)) unlinkSync(`${path}.pipe-lock`);
  }
});

test('U5 a failed stop settles an outstanding HTTP drain and the drained promise', async (t) => {
  const path = tempStore('drain-stop');
  const loginDir = mkdtempSync(join(tmpdir(), 'pipe-u5-login-'));
  const cli = seededStopHold(path, loginDir);
  const original = Store.prototype.saveLimits;
  Store.prototype.saveLimits = () => { throw new Error('injected limit write failure'); };
  try {
    let pipe: Awaited<ReturnType<typeof startPipe>>;
    try { pipe = await startPipe({ accounts: [{ ...account, loginDir, enabled: false }],
      policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      storePath: path, worktreeRoot: loginDir, cli: { claude: cli },
      token: 'x'.repeat(32), port: 0, reachable: async () => false, tickMs: 10 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('sandbox denies loopback bind'); return; } throw e; }
    const other = new Store(path);
    try {
      const row = other.submit(request);
      assert.equal(other.startAttempt(row.id, account, { ...evidence, observedAt: new Date().toISOString() }).ok, true);
    } finally { other.close(); }
    let responded = false;
    const response = fetch(`${pipe.url}/v1/drain?wait=1000`, { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(32)}` } }).catch(() => undefined);
    void response.then(() => { responded = true; });
    await sleep(30);
    assert.equal(responded, false, 'the drain connection is still waiting for the open attempt');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(journalOf(path));
    await assert.rejects(() => Promise.race([pipe.stop(), sleep(2_000).then(() => { throw new Error('stop hung'); })]), /limit hold.*could not be persisted/i);
    await Promise.race([pipe.drained, sleep(2_000).then(() => { throw new Error('drained hung'); })]);
    await Promise.race([response, sleep(2_000).then(() => { throw new Error('HTTP drain hung'); })]);
  } finally {
    Store.prototype.saveLimits = original;
    if (existsSync(`${path}.pipe-lock`)) unlinkSync(`${path}.pipe-lock`);
  }
});

// READ-CONTRACT-01 step 2b: closedAt on job cards (docs/READ-CONTRACT-01.md).
// Proof that an attempt's process group is gone, write-once, set only by the pipe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { card } from '../src/cards.ts';
import { run, type RunEvent, type RunSpec } from '../src/runner.ts';
import { Store, type Attempt, type DispatchEvidence, type NewRequest, type RequestRecord } from '../src/store.ts';
import { journalOf, recheckHeld, recover } from '../src/service.ts';
import type { AccountConfig } from '../src/identity.ts';

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const T = (m: number) => new Date(T0 + m * 60_000).toISOString();

function openStore(path?: string) {
  const p = path ?? join(mkdtempSync(join(tmpdir(), 'pipe-u21-store-')), 'store.db');
  let currentMs = T0;
  const store = new Store(p, { now: () => new Date(currentMs) });
  const set = (minutes: number) => { currentMs = T0 + minutes * 60_000; };
  return { store, path: p, set, now: () => new Date(currentMs) };
}

function newRequest(over: Partial<NewRequest> = {}): NewRequest {
  return {
    requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
    reason: 'benchmark', prompt: 'test prompt', mutating: false, priority: 'interactive', ...over,
  };
}

const ACCOUNT: AccountConfig = {
  id: 'claude-one', provider: 'claude', loginDir: mkdtempSync(join(tmpdir(), 'pipe-u21-login-')),
  fingerprint: 'fp1', maxConcurrency: 1, enabled: true,
};

function evidence(accountId: string, model = 'opus', at = T(0)): DispatchEvidence {
  return { accountId, model, observedAt: at, verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] };
}

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
    reason: 'test', prompt: 'test', mutating: false, priority: 'interactive',
    id: 'r1', seq: 1, state: 'running', createdAt: T(0), updatedAt: T(1),
    waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null, ...over,
  };
}

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: 'a1', requestId: 'r1', accountId: 'claude-one', dispatch: evidence('claude-one'),
    startedAt: T(1), endedAt: null, outcome: null, runner: null, reportedModel: null, events: null, closedAt: null, ...over,
  };
}

const opts = (over: Partial<Parameters<typeof card>[2]> = {}): Parameters<typeof card>[2] =>
  ({ alias: (id: string) => (id === 'claude-one' ? 'Claude One' : id), runnerAlive: () => true, draining: false, ...over });

type Step = { line?: string; stderr?: string; sleepMs?: number };
type Scenario = { steps: Step[]; exitCode?: number };

function fakeCli(scenario: Scenario) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u21-cli-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const script = join(dir, 'cli');
  writeFileSync(script, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
(async () => {
  for (const step of sc.steps) {
    if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
    if (step.line !== undefined) process.stdout.write(step.line + '\\n');
    if (step.stderr !== undefined) process.stderr.write(step.stderr + '\\n');
  }
  process.exit(sc.exitCode ?? 0);
})();
`);
  chmodSync(script, 0o755);
  return { path: script };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function terminalOf(events: RunEvent[]): RunEvent {
  const terminals = events.filter((e) => e.type === 'completed' || e.type === 'failed');
  assert.equal(terminals.length, 1);
  return terminals[0]!;
}

// ── the store ───────────────────────────────────────────────────────────────

test("the store: noteClosed stamps with the pipe's clock write-once on open or ended attempts; unknown id returns false; moves change number; clock step back never stamps before start", () => {
  const { store, set } = openStore();
  try {
    set(0);
    const req = store.submit(newRequest());
    const started = store.startAttempt(req.id, ACCOUNT, evidence('claude-one'));
    assert.ok(started.ok);
    const id = started.attempt.id;
    assert.equal(store.attempts(req.id)[0]!.closedAt, null, 'an attempt without it reads closedAt: null');
    const before = store.changedAfter(0, 100).next?.after ?? 0;

    // noteClosed on an open attempt stamps the pipe's clock and returns true
    set(2);
    assert.equal(store.noteClosed(id), true, 'first noteClosed call returns true');
    assert.equal(store.attempts(req.id)[0]!.closedAt, T(2), "stamped with the pipe's clock");
    assert.deepEqual(store.changedAfter(before, 100).requests.map((r) => r.id), [req.id], 'the write moves the change number');

    // a second call returns false and keeps the first time (write-once)
    set(3);
    assert.equal(store.noteClosed(id), false, 'a second call returns false');
    assert.equal(store.attempts(req.id)[0]!.closedAt, T(2), 'keeps the first time (write-once)');
    store.finishAttempt(id, { kind: 'completed', result: 'done' });   // the account takes one job at a time

    // it works on an ended attempt too
    set(4);
    const req2 = store.submit(newRequest());
    const started2 = store.startAttempt(req2.id, ACCOUNT, evidence('claude-one', 'opus', T(4)));
    assert.ok(started2.ok);
    const id2 = started2.attempt.id;
    set(5);
    store.finishAttempt(id2, { kind: 'completed', result: 'done' });
    assert.equal(store.attempts(req2.id)[0]!.closedAt, null);
    set(6);
    assert.equal(store.noteClosed(id2), true, 'works on an ended attempt too');
    assert.equal(store.attempts(req2.id)[0]!.closedAt, T(6));
    set(7);
    assert.equal(store.noteClosed(id2), false, 'write-once on ended attempt too');
    assert.equal(store.attempts(req2.id)[0]!.closedAt, T(6));

    // an unknown id returns false
    assert.equal(store.noteClosed('unknown-attempt-id'), false, 'an unknown id returns false');

    // a clock step back never stamps before the attempt's start
    set(10);
    const req3 = store.submit(newRequest());
    const started3 = store.startAttempt(req3.id, ACCOUNT, evidence('claude-one', 'opus', T(10)));
    assert.ok(started3.ok);
    const id3 = started3.attempt.id;
    const start3 = store.attempts(req3.id)[0]!.startedAt;
    set(-60); // clock moves back an hour
    assert.equal(store.noteClosed(id3), true);
    const closed3 = store.attempts(req3.id)[0]!.closedAt!;
    assert.ok(closed3 >= start3, `never before the attempt started: ${closed3} >= ${start3}`);
    assert.ok(closed3 >= T(10) && closed3 !== T(-60), `never before the mark: ${closed3}`);
  } finally {
    store.close();
  }
});

// ── migration ───────────────────────────────────────────────────────────────

test('migration: a store file without closed_at gains it on open and reads closedAt: null', () => {
  const { store, path: dbPath } = openStore();
  const req = store.submit(newRequest());
  const started = store.startAttempt(req.id, ACCOUNT, evidence('claude-one'));
  assert.ok(started.ok);
  store.close();

  const db = new DatabaseSync(dbPath);
  db.exec('DROP TRIGGER IF EXISTS attempts_closed_once; ALTER TABLE attempts DROP COLUMN closed_at;');
  db.close();

  const reopened = new Store(dbPath, { now: () => new Date(T0 + 60_000) });
  try {
    const att = reopened.attempts(req.id)[0]!;
    assert.equal(att.closedAt, null, 'reads null after dropping closed_at');
    assert.equal(reopened.noteClosed(started.attempt.id), true, 'and noteClosed works on reopened store');
    assert.equal(reopened.attempts(req.id)[0]!.closedAt, T(1));
  } finally {
    reopened.close();
  }
});

// ── the runner ──────────────────────────────────────────────────────────────

test('the runner: with a fake CLI that exits normally, onClosed is called exactly once; a throwing onClosed does not change the run outcome', async () => {
  const fixtureLines = readFileSync(new URL('./fixtures/claude-success.jsonl', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim() !== '');
  assert.equal(fixtureLines.length, 5);

  const cli = fakeCli({ steps: fixtureLines.map((line) => ({ line })), exitCode: 0 });

  function testSpec(over: Partial<RunSpec> = {}): RunSpec {
    const login = mkdtempSync(join(tmpdir(), 'pipe-u21-login-'));
    return {
      requestId: 'req-1', accountId: 'claude-one', provider: 'claude', model: 'opus', effort: 'high',
      prompt: 'say OK', mutating: false, cwd: realpathSync(tmpdir()), loginDir: login, ...over,
    };
  }

  // onClosed called exactly once with a normally exiting CLI
  let closedCount = 0;
  const events1 = await collect(run(testSpec(), {
    cli: { claude: cli.path },
    onClosed: () => { closedCount += 1; },
  }));
  assert.equal(closedCount, 1, 'onClosed is called exactly once on normal exit');
  assert.equal(terminalOf(events1).type, 'completed');

  // a throwing onClosed does not change the run's terminal event
  let throwCount = 0;
  const events2 = await collect(run(testSpec({ requestId: 'req-2' }), {
    cli: { claude: cli.path },
    onClosed: () => { throwCount += 1; throw new Error('broken onClosed callback'); },
  }));
  assert.equal(throwCount, 1, 'throwing onClosed was invoked once');
  assert.equal(terminalOf(events2).type, 'completed', 'run still completes normally despite throwing onClosed');
});

// ── the card ───────────────────────────────────────────────────────────────

test('the card: attempts[].closedAt shows each attempt’s own value, null when unset', () => {
  const att1 = attempt({ id: 'a1', closedAt: '2026-09-30T10:05:00.000Z' });
  const att2 = attempt({ id: 'a2', closedAt: null });
  const att3 = attempt({ id: 'a3', closedAt: undefined });
  const c = card(record({ state: 'running' }), [att1, att2, att3], opts());
  assert.equal(c.attempts[0]?.closedAt, '2026-09-30T10:05:00.000Z');
  assert.equal(c.attempts[1]?.closedAt, null);
  assert.equal(c.attempts[2]?.closedAt, null);
});

// ── the service, end to end ────────────────────────────────────────────────

const TOKEN = 'y'.repeat(32);
const HEADERS = { authorization: `Bearer ${TOKEN}` };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T> | T, accept: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw new Error('condition did not arrive'); await pause(20); }
}

function serviceCli(root: string, lines: number, gapMs = 0): string {
  const cli = join(root, 'claude');
  const run = [JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }),
    ...Array.from({ length: lines - 2 }, () => JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'working' }] } })),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })];
  writeFileSync(join(root, 'run.json'), JSON.stringify({ run, gapMs }));
  writeFileSync(cli, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') console.log('2.1.280');
else if (a[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', orgId: 'owner' }));
else if (a[0] === '-p' && a[1] === '/usage') {
  const when = (h) => { const z = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(Date.now() + h * 3600000)).map((x) => [x.type, x.value])); return z.month + ' ' + z.day + ' at ' + z.hour + ':' + z.minute + z.dayPeriod.toLowerCase(); };
  console.log(JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result: 'Current session: 10% used · resets ' + when(3) + ' (America/New_York)\\nCurrent week (all models): 20% used · resets ' + when(96) + ' (America/New_York)' }));
} else {
  fs.readFileSync(0);
  const { run, gapMs } = JSON.parse(fs.readFileSync(p.join(__dirname, 'run.json'), 'utf8'));
  (async () => { for (const line of run) { process.stdout.write(line + '\\n'); if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); } })();
}
`);
  chmodSync(cli, 0o755);
  return cli;
}

async function startService(t: { skip(message: string): void }, cli: string, root: string, over: Record<string, unknown> = {}) {
  const { startPipe } = await import('../src/service.ts');
  const account = { id: 'a', provider: 'claude' as const, loginDir: root, fingerprint: createHash('sha256').update('owner').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true };
  try {
    return await startPipe({ accounts: [account], policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: join(root, 'store.sqlite'),
      worktreeRoot: root, cli: { claude: cli }, token: TOKEN, port: 0, reachable: async () => true, tickMs: 20, ...over } as Parameters<typeof startPipe>[0]);
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('loopback bind unavailable'); return undefined; } throw e; }
}

async function submit(url: string): Promise<string> {
  const body = { requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'test', prompt: 'OK', mutating: false, priority: 'interactive', pin: 'a' };
  const r = await fetch(`${url}/v1/requests`, { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await r.json()).request.id as string;
}

const readCard = async (url: string, id: string) => (await (await fetch(`${url}/v1/cards/${id}`, { headers: HEADERS })).json()).card;

test('service: a completed job through startPipe has card attempts[0].closedAt set, at or after startedAt', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u21-svc-done-'));
  const pipe = await startService(t, serviceCli(root, 7), root);
  if (!pipe) return;
  try {
    const id = await submit(pipe.url);
    const done = await until(() => readCard(pipe.url, id), (c) => c?.state === 'completed');
    const att = done.attempts[0];
    assert.ok(att, 'has an attempt');
    assert.ok(att.closedAt !== null, 'closedAt is set');
    assert.ok(att.startedAt !== null, 'startedAt is set');
    assert.ok(att.closedAt >= att.startedAt, `closedAt (${att.closedAt}) >= startedAt (${att.startedAt})`);
  } finally { await pipe.stop(); }
});

test('service: recover() with an attempt whose recorded runner group does not exist records closedAt for it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u21-svc-rec-'));
  const storePath = join(root, 'store.sqlite');
  const store = new Store(storePath, { now: () => new Date(T0 + 60_000) });   // the dispatch evidence is from T0
  try {
    const req = store.submit(newRequest());
    const started = store.startAttempt(req.id, ACCOUNT, evidence('claude-one'));
    assert.ok(started.ok);
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid!;
    store.noteRunner(started.attempt.id, { pid: deadPid, startedAt: 'unverified:gone' });
    assert.equal(store.attempts(req.id)[0]!.closedAt, null, 'closedAt is null initially');

    const held = await recover(store, journalOf(storePath), () => {});
    assert.equal(held.size, 0, 'dead runner group is not held');
    const att = store.attempts(req.id)[0]!;
    assert.ok(typeof att.closedAt === 'string', 'recover recorded closedAt');
    assert.ok(att.closedAt >= att.startedAt, `closedAt (${att.closedAt}) >= startedAt (${att.startedAt})`);
    assert.equal(att.endedAt !== null, true, 'attempt ended');
  } finally {
    store.close();
  }
});

// ── the proof's negative side: closedAt only where the pipe proved nothing of the run remains ────────────────────

const runSpec = (over: Partial<RunSpec> = {}): RunSpec => ({
  requestId: `req-${Math.random().toString(36).slice(2)}`, accountId: 'claude-one', provider: 'claude', model: 'opus', effort: 'high',
  prompt: 'say OK', mutating: false, cwd: realpathSync(tmpdir()), loginDir: mkdtempSync(join(tmpdir(), 'pipe-u21-login-')), ...over,
});
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the runner: no closedAt while a descendant that left the group still holds the run's pipes", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u21-leaver-')));
  const lines = readFileSync(new URL('./fixtures/claude-success.jsonl', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() !== '');
  writeFileSync(join(dir, 'lines.json'), JSON.stringify(lines));
  const cli = join(dir, 'cli');
  // A child in its own new session (so outside the CLI's group) that inherits stdout and outlives the CLI.
  writeFileSync(cli, `#!${process.execPath}
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
try { fs.readFileSync(0); } catch {}
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(path.join(__dirname, 'leaver.pid'), String(child.pid));
child.unref();
for (const l of JSON.parse(fs.readFileSync(path.join(__dirname, 'lines.json'), 'utf8'))) process.stdout.write(l + '\\n');
process.exit(0);
`);
  chmodSync(cli, 0o755);
  let closedCalls = 0;
  try {
    const events = await collect(run(runSpec(), { cli: { claude: cli }, killGraceMs: 300, onClosed: () => { closedCalls += 1; } }));
    assert.ok(terminalOf(events), 'the run still ends');
    assert.equal(closedCalls, 0, 'the pipes were still held by a process of this run: no proof');
  } finally {
    const leaver = Number(readFileSync(join(dir, 'leaver.pid'), 'utf8'));
    if (leaver > 1) { try { process.kill(leaver, 'SIGKILL'); } catch { /* already gone */ } }
  }
});

test('the runner: a CLI that could not be started (missing on disk) or a run cancelled before its start is closed; a failed pre-spawn record is not', async () => {
  let calls = 0;
  const missing = await collect(run(runSpec(), { cli: { claude: join(tmpdir(), 'pipe-u21-no-such-cli') }, onClosed: () => { calls += 1; } }));
  assert.equal(terminalOf(missing).type, 'failed');
  assert.equal(calls, 1, 'no process was made: closed');

  calls = 0;
  const abort = new AbortController(); abort.abort();
  const cli = fakeCli({ steps: [] });
  const cancelled = await collect(run(runSpec(), { cli: { claude: cli.path }, signal: abort.signal, onClosed: () => { calls += 1; } }));
  assert.equal(terminalOf(cancelled).type, 'failed');
  assert.equal(calls, 1, 'cancelled before the start: closed');

  calls = 0;
  const codex = await collect(run(runSpec({ provider: 'codex', model: 'gpt-6-sol' }), {
    cli: { codex: cli.path }, onBeforeSpawn: () => { throw new Error('the pre-spawn record failed'); }, onClosed: () => { calls += 1; } }));
  assert.equal(terminalOf(codex).type, 'failed');
  assert.equal(calls, 0, 'a failed pre-spawn record leaves no proof');
});

test('the store: closedAt is write-once in the database itself', () => {
  const { store, path: dbPath } = openStore();
  try {
    const req = store.submit(newRequest());
    const started = store.startAttempt(req.id, ACCOUNT, evidence('claude-one'));
    assert.ok(started.ok);
    assert.equal(store.noteClosed(started.attempt.id), true);
    const db = new DatabaseSync(dbPath);
    try {
      assert.throws(() => db.prepare('UPDATE attempts SET closed_at = ? WHERE id = ?').run('2099-01-01T00:00:00.000Z', started.attempt.id), /write-once/);
      assert.throws(() => db.prepare('UPDATE attempts SET closed_at = NULL WHERE id = ?').run(started.attempt.id), /write-once/);
    } finally { db.close(); }
  } finally { store.close(); }
});

test('recovery: a held runner group stays without closedAt; recheckHeld stamps it only once the group is proved gone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u21-held-'));
  const storePath = join(root, 'store.sqlite');
  const store = new Store(storePath, { now: () => new Date(T0 + 60_000) });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid!;
  try {
    const req = store.submit(newRequest());
    const started = store.startAttempt(req.id, ACCOUNT, evidence('claude-one'));
    assert.ok(started.ok);
    store.noteRunner(started.attempt.id, { pid, startedAt: 'unverified:held' });   // a live group with no verifiable identity
    const held = await recover(store, journalOf(storePath), () => {});
    assert.equal(held.size, 1, 'the group may be alive: held');
    assert.equal(store.attempts(req.id)[0]!.closedAt, null, 'no proof yet: no closedAt');
    await recheckHeld(store, held, () => {});
    assert.equal(store.attempts(req.id)[0]!.closedAt, null, 'still alive: still no closedAt');
    process.kill(-pid, 'SIGKILL');
    for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 20));
    await recheckHeld(store, held, () => {});
    assert.equal(held.size, 0);
    assert.equal(typeof store.attempts(req.id)[0]!.closedAt, 'string', 'the group is proved gone: closedAt');
  } finally { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } store.close(); }
});

test("service: a job cancelled mid-run is closed only by the runner's proof", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u21-svc-cancel-'));
  const pipe = await startService(t, serviceCli(root, 40, 250), root);
  if (!pipe) return;
  try {
    const id = await submit(pipe.url);
    await until(() => readCard(pipe.url, id), (c) => c?.state === 'running' && c.attempts.length > 0);
    await fetch(`${pipe.url}/v1/requests/${id}/cancel`, { method: 'POST', headers: { ...HEADERS, 'content-length': '0' } });
    const done = await until(() => readCard(pipe.url, id), (c) => c?.state === 'cancelled' && c.attempts[0]?.endedAt !== null);
    const closedAt = done.attempts[0].closedAt;
    assert.ok(closedAt === null || closedAt >= done.attempts[0].startedAt, `a proof, never a guess: ${closedAt}`);
    assert.equal(typeof closedAt, 'string', 'the runner stopped the group and saw it gone');
  } finally { await pipe.stop(); }
});

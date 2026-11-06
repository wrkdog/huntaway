// READ-CONTRACT-01 step 2: the event clock on job cards (docs/READ-CONTRACT-01.md).
// Counts a CLI's events and stamps the last event's time so cards tell live runs from silent hangs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { card } from '../src/cards.ts';
import { eventClock } from '../src/event-clock.ts';
import { run, type RunEvent, type RunSpec } from '../src/runner.ts';
import { Store, StoreError, type Attempt, type DispatchEvidence, type NewRequest, type RequestRecord } from '../src/store.ts';
import type { AccountConfig } from '../src/identity.ts';

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const T = (m: number) => new Date(T0 + m * 60_000).toISOString();

function openStore(path?: string) {
  const p = path ?? join(mkdtempSync(join(tmpdir(), 'pipe-u20-store-')), 'store.db');
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
  id: 'claude-one', provider: 'claude', loginDir: mkdtempSync(join(tmpdir(), 'pipe-u20-login-')),
  fingerprint: 'fp1', maxConcurrency: 1, enabled: true,
};

function evidence(accountId: string, model = 'opus'): DispatchEvidence {
  return { accountId, model, observedAt: T(0), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] };
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
    startedAt: T(1), endedAt: null, outcome: null, runner: null, reportedModel: null, events: null, ...over,
  };
}

const opts = (over: Partial<Parameters<typeof card>[2]> = {}): Parameters<typeof card>[2] =>
  ({ alias: (id: string) => (id === 'claude-one' ? 'Claude One' : id), runnerAlive: () => true, draining: false, ...over });

type Step = { line?: string; stderr?: string; sleepMs?: number };
type Scenario = { steps: Step[]; exitCode?: number };

function fakeCli(scenario: Scenario) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u20-cli-')));
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

test('the clock: writes at once, then at most every everyMs on a monotonic clock, the tail on end(), and nothing after', () => {
  let ms = 1_000;
  const written: number[] = [];
  let fail = false;
  const write = (count: number) => { if (fail) throw new Error('write failure'); written.push(count); };
  const clock = eventClock(write, () => ms, 15_000);
  clock.event();
  assert.deepEqual(written, [1], 'the first event is written at once');
  ms = 6_000; clock.event(); ms = 15_999; clock.event();
  assert.deepEqual(written, [1], 'events within everyMs of the last write wait');
  ms = 16_000; clock.event();
  assert.deepEqual(written, [1, 4], 'an event everyMs after the last write writes the count');
  clock.end();
  assert.deepEqual(written, [1, 4], 'end() with nothing new writes nothing');
  clock.event(); clock.end();
  assert.deepEqual(written, [1, 4], 'after end(), events are ignored');

  // A write that throws never throws out; the next write, or end(), carries the newer count.
  const second = eventClock(write, () => ms, 15_000);
  fail = true;
  assert.doesNotThrow(() => second.event());
  ms = 40_000;
  assert.doesNotThrow(() => second.event());
  assert.deepEqual(written, [1, 4], 'failed writes are not recorded');
  fail = false;
  ms = 41_000; second.event();
  assert.deepEqual(written, [1, 4], 'within everyMs of the last try, it waits');
  second.end();
  assert.deepEqual(written, [1, 4, 3], 'end() carries the unwritten tail');
});

test("the store: noteEvents stamps with the pipe's clock; a higher count wins; never on an ended attempt; the change number moves", () => {
  const { store, set } = openStore();
  try {
    set(0);
    const req = store.submit(newRequest());
    const started = store.startAttempt(req.id, ACCOUNT, evidence('claude-one'));
    assert.ok(started.ok);
    const id = started.attempt.id;
    assert.equal(store.attempts(req.id)[0]!.events, null, 'an attempt without events reads null');
    const before = store.changedAfter(0, 100).next?.after ?? 0;

    set(2);
    assert.equal(store.noteEvents(id, 5), true);
    assert.deepEqual(store.attempts(req.id)[0]!.events, { count: 5, lastAt: T(2) }, "stamped with the pipe's clock");
    assert.deepEqual(store.changedAfter(before, 100).requests.map((r) => r.id), [req.id], 'the write moves the change number');

    set(3);
    assert.equal(store.noteEvents(id, 5), false, 'an equal count changes nothing');
    assert.equal(store.noteEvents(id, 4), false, 'a lower count changes nothing');
    assert.deepEqual(store.attempts(req.id)[0]!.events, { count: 5, lastAt: T(2) });

    // The wall clock steps back an hour: a higher count still lands, stamped at the pipe's mark, never earlier.
    set(-60);
    assert.equal(store.noteEvents(id, 6), true);
    const stepped = store.attempts(req.id)[0]!.events!;
    assert.equal(stepped.count, 6);
    assert.ok(stepped.lastAt >= T(2) && stepped.lastAt !== T(-60), `never before the mark: ${stepped.lastAt}`);
    assert.ok(stepped.lastAt >= store.attempts(req.id)[0]!.startedAt, 'never before the attempt started');

    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => store.noteEvents(id, bad), StoreError);

    set(5);
    store.finishAttempt(id, { kind: 'completed', result: 'done' });
    assert.equal(store.noteEvents(id, 20), false, 'an ended attempt is not written');
    assert.equal(store.attempts(req.id)[0]!.events!.count, 6, 'and keeps its values');
  } finally {
    store.close();
  }
});

test('migration: an older file gains the event columns, each on its own, and its attempts read events: null', () => {
  for (const drop of [['event_count', 'last_event_at'], ['last_event_at']]) {
    const { store, path: dbPath } = openStore();
    const req = store.submit(newRequest());
    const started = store.startAttempt(req.id, ACCOUNT, evidence('claude-one'));
    assert.ok(started.ok);
    store.close();
    const db = new DatabaseSync(dbPath);
    for (const column of drop) db.exec(`ALTER TABLE attempts DROP COLUMN ${column}`);
    db.close();
    const reopened = new Store(dbPath, { now: () => new Date(T0 + 60_000) });
    try {
      assert.equal(reopened.attempts(req.id)[0]!.events, null, `reads null after dropping ${drop.join(' and ')}`);
      assert.equal(reopened.noteEvents(started.attempt.id, 2), true, 'and records again');
      assert.deepEqual(reopened.attempts(req.id)[0]!.events, { count: 2, lastAt: T(1) });
    } finally {
      reopened.close();
    }
  }
});

test('the runner: onEvent is called once for each stdout line, and throwing onEvent does not change the run outcome', async () => {
  const fixtureLines = readFileSync(new URL('./fixtures/claude-success.jsonl', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.trim() !== '');
  assert.equal(fixtureLines.length, 5);

  const cli = fakeCli({ steps: fixtureLines.map((line) => ({ line })), exitCode: 0 });

  function testSpec(over: Partial<RunSpec> = {}): RunSpec {
    const login = mkdtempSync(join(tmpdir(), 'pipe-u20-login-'));
    return {
      requestId: 'req-1', accountId: 'claude-one', provider: 'claude', model: 'opus', effort: 'high',
      prompt: 'say OK', mutating: false, cwd: realpathSync(tmpdir()), loginDir: login, ...over,
    };
  }

  // onEvent counting calls: count equals the number of stdout lines
  let eventCallCount = 0;
  const events1 = await collect(run(testSpec(), {
    cli: { claude: cli.path },
    onEvent: () => { eventCallCount += 1; },
  }));
  assert.equal(eventCallCount, 5, 'count equals the number of stdout lines');
  assert.equal(terminalOf(events1).type, 'completed');

  // a throwing onEvent does not change the run's terminal event
  let throwCount = 0;
  const events2 = await collect(run(testSpec({ requestId: 'req-2' }), {
    cli: { claude: cli.path },
    onEvent: () => { throwCount += 1; throw new Error('broken clock'); },
  }));
  assert.equal(throwCount, 5, 'throwing onEvent was still invoked for each line');
  assert.equal(terminalOf(events2).type, 'completed', 'run still completes normally despite throwing onEvent');
});

test('the card: carries { lastEventAt, eventCount } from open attempt, else last attempt, null when none, and content-free', () => {
  const SECRET = 'SENTINEL-CLOCK-SECRET-7c9d';
  const openAtt = attempt({
    events: { count: 42, lastAt: '2026-09-30T10:05:00.000Z' },
  });

  // running job's card carries { lastEventAt, eventCount } from its open attempt
  const runningCard = card(record({ state: 'running' }), [openAtt], opts());
  assert.deepEqual(runningCard.events, { lastEventAt: '2026-09-30T10:05:00.000Z', eventCount: 42 });

  // final job's card from its last attempt
  const endedAtt1 = attempt({
    id: 'a1', endedAt: '2026-09-30T10:06:00.000Z', outcome: { kind: 'failed', errorKind: 'transient', message: 'err' },
    events: { count: 10, lastAt: '2026-09-30T10:04:00.000Z' },
  });
  const endedAtt2 = attempt({
    id: 'a2', startedAt: '2026-09-30T10:07:00.000Z', endedAt: '2026-09-30T10:10:00.000Z',
    outcome: { kind: 'completed', result: 'done' },
    events: { count: 25, lastAt: '2026-09-30T10:09:00.000Z' },
  });
  const finalCard = card(record({ state: 'completed' }), [endedAtt1, endedAtt2], opts());
  assert.deepEqual(finalCard.events, { lastEventAt: '2026-09-30T10:09:00.000Z', eventCount: 25 }, 'from the last attempt');

  // a retry's new open attempt with no events yet shows null, never the older attempt's clock
  const retryCard = card(record({ state: 'running' }), [endedAtt1, attempt({ id: 'a3', startedAt: '2026-09-30T10:11:00.000Z', events: null })], opts());
  assert.equal(retryCard.events, null, "a new open attempt's clock, not the older one's");

  // null when none was recorded
  const noEventsCard = card(record({ state: 'running' }), [attempt({ events: null })], opts());
  assert.equal(noEventsCard.events, null);

  const noAttemptsCard = card(record({ state: 'queued' }), [], opts());
  assert.equal(noAttemptsCard.events, null);

  // content-free: sentinels never appear in card
  const secretReq = record({
    reason: `why ${SECRET}`, prompt: `do ${SECRET}`, result: `result ${SECRET}`,
    error: { kind: 'transient', message: `msg ${SECRET}` },
    waiting: { reason: `wait ${SECRET}`, until: '2026-09-30T11:00:00.000Z' },
    workspace: { path: `/wt/${SECRET}`, branch: 'pipe/r1', commit: 'c0ffee' },
  });
  const secretAtt = attempt({
    events: { count: 7, lastAt: '2026-09-30T10:00:00.000Z' },
  });
  const secretCard = card(secretReq, [secretAtt], opts());
  assert.ok(!JSON.stringify(secretCard).includes(SECRET), 'card never carries any secret content');
  assert.deepEqual(secretCard.events, { lastEventAt: '2026-09-30T10:00:00.000Z', eventCount: 7 });
});

// ── the service, end to end: jobs through startPipe with a fake claude CLI ─────────────────────────────────────────

const TOKEN = 'x'.repeat(32);
const HEADERS = { authorization: `Bearer ${TOKEN}` };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T> | T, accept: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw new Error('condition did not arrive'); await pause(20); }
}
/** A claude CLI that answers the pipe's probes, and on a run writes `lines` stdout lines: init, assistant events, result. */
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

test("service: a finished job's card counts every line its CLI wrote, stamped between its start and its finish", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u20-svc-done-'));
  const pipe = await startService(t, serviceCli(root, 7), root);
  if (!pipe) return;
  try {
    const id = await submit(pipe.url);
    const done = await until(() => readCard(pipe.url, id), (c) => c?.state === 'completed');
    assert.equal(done.events?.eventCount, 7, 'the last count is written before the outcome is recorded');
    assert.ok(done.events.lastEventAt >= done.startedAt && done.events.lastEventAt <= done.finishedAt, JSON.stringify(done.events));
  } finally { await pipe.stop(); }
});

test("service: a running job's card shows the clock moving, and the change feed returns it at each write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u20-svc-live-'));
  const pipe = await startService(t, serviceCli(root, 12, 150), root, { eventWriteMs: 100 });
  if (!pipe) return;
  try {
    const id = await submit(pipe.url);
    const first = await until(() => readCard(pipe.url, id), (c) => c?.state === 'running' && (c.events?.eventCount ?? 0) >= 1);
    const cursor = (await (await fetch(`${pipe.url}/v1/cards?after=0&limit=500`, { headers: HEADERS })).json()).next?.after ?? 0;
    const later = await until(() => readCard(pipe.url, id), (c) => (c?.events?.eventCount ?? 0) > first.events.eventCount);
    assert.ok(later.events.eventCount > first.events.eventCount);
    const feed = await (await fetch(`${pipe.url}/v1/cards?after=${cursor}&limit=500`, { headers: HEADERS })).json();
    assert.ok(feed.cards.some((c: { id: string }) => c.id === id), 'a clock write moves the card into the change feed');
    const done = await until(() => readCard(pipe.url, id), (c) => c?.state === 'completed');
    assert.equal(done.events.eventCount, 12);
  } finally { await pipe.stop(); }
});

test('service: a clock write that fails never changes the outcome; the card then shows no clock', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u20-svc-fail-'));
  const original = Store.prototype.noteEvents;
  Store.prototype.noteEvents = function () { throw new Error('injected clock write failure'); };
  const pipe = await startService(t, serviceCli(root, 5), root);
  try {
    if (!pipe) return;
    const id = await submit(pipe.url);
    const done = await until(() => readCard(pipe.url, id), (c) => c?.state === 'completed' || c?.state === 'failed');
    assert.equal(done.state, 'completed');
    assert.equal(done.events, null);
  } finally { Store.prototype.noteEvents = original; await pipe?.stop(); }
});

test('service: when the run loop throws, the clock still writes its last count before the outcome is recorded', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u20-svc-throw-'));
  const original = Store.prototype.noteModel;
  Store.prototype.noteModel = function () { throw new Error('injected: the loop throws at the first event'); };
  // Writes at most once a minute, so only end() in the catch can write more than the first event.
  const pipe = await startService(t, serviceCli(root, 6), root, { eventWriteMs: 60_000, maxAttempts: 1 });
  try {
    if (!pipe) return;
    const id = await submit(pipe.url);
    const done = await until(() => readCard(pipe.url, id), (c) => ['completed', 'failed', 'cancelled'].includes(c?.state));
    assert.equal(done.attempts[0]?.outcome, 'no_outcome');
    assert.ok((done.events?.eventCount ?? 0) > 1, `the tail was written in the catch: ${JSON.stringify(done.events)}`);
  } finally { Store.prototype.noteModel = original; await pipe?.stop(); }
});

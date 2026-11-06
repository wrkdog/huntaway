// READ-CONTRACT-01 (docs/READ-CONTRACT-01.md): what a job card may read from the pipe. A card is content-free: codes,
// times, counts, a branch and a commit, and display aliases; never a prompt, result, error message, wait wording,
// path, email, fingerprint or token. Unknown values are null, never guessed (rule 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { card, health, CARD_SCHEMA } from '../src/cards.ts';
import { startHttp } from '../src/http.ts';
import { validateAccounts, type AccountConfig } from '../src/identity.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import { Store, type Attempt, type DispatchEvidence, type NewRequest, type RequestRecord } from '../src/store.ts';

const SECRET = 'SENTINEL-7f3a';
const token = 't'.repeat(32);
const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const T = (m: number) => new Date(T0 + m * 60_000).toISOString();
const WORK = mkdtempSync(join(tmpdir(), 'pipe-u19-work-'));

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
    reason: `why ${SECRET}`, prompt: `do ${SECRET}`, mutating: true, priority: 'interactive', cwd: `/work/${SECRET}`,
    id: 'r1', seq: 7, state: 'running', createdAt: T(0), updatedAt: T(1),
    waiting: null, notBefore: null, avoid: [], result: null, workspace: null, error: null, ...over,
  };
}
function attempt(over: Partial<Attempt> = {}): Attempt {
  const dispatch: DispatchEvidence = { accountId: 'claude-one', model: 'opus', observedAt: T(1), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] };
  return {
    id: 'a1', requestId: 'r1', accountId: 'claude-one', dispatch, startedAt: T(1), endedAt: null, outcome: null,
    runner: { pid: 4242, startedAt: 'started' }, reportedModel: 'opus', ...over,
  };
}
const opts = (over: Partial<Parameters<typeof card>[2]> = {}): Parameters<typeof card>[2] =>
  ({ alias: (id: string) => (id === 'claude-one' ? 'Claude One' : id), runnerAlive: () => true, draining: false, ...over });

test('a card carries no prompt, result, message, wait wording, path, fingerprint or token (READ-CONTRACT-01 rule 1)', () => {
  const r = record({
    state: 'failed', result: `answer ${SECRET}`, error: { kind: 'transient', message: `boom ${SECRET}` },
    waiting: { reason: `waiting on ${SECRET}`, until: T(5) }, workspace: { path: `/wt/${SECRET}`, branch: 'pipe/r1', commit: 'c0ffee' },
  });
  const a = attempt({ endedAt: T(2), outcome: { kind: 'failed', errorKind: 'transient', message: `x ${SECRET}` } });
  const c = card(r, [a], opts());
  assert.ok(!JSON.stringify(c).includes(SECRET), JSON.stringify(c));
  assert.deepEqual(Object.keys(c).sort(), ['account', 'attempts', 'createdAt', 'errorKind', 'events', 'finishedAt', 'id', 'kind',
    'mutating', 'priority', 'project', 'proof', 'requester', 'saved', 'seq', 'startCommit', 'startedAt', 'state', 'updatedAt', 'waiting'].sort());
  assert.deepEqual(Object.keys(c.attempts[0]!).sort(), ['account', 'closedAt', 'endedAt', 'host', 'n', 'outcome', 'runnerAlive', 'startedAt'].sort());
  assert.equal(c.attempts[0]!.host, null, 'no recorded executor: unknown, never an inferred hostname');
});

test('a card names the state, the failure code, the first start, the finish and each attempt, by code', () => {
  const running = card(record(), [attempt()], opts());
  assert.equal(running.state, 'running');
  assert.equal(running.errorKind, null);
  assert.equal(running.startedAt, T(1));
  assert.equal(running.finishedAt, null, 'not final yet');
  assert.deepEqual(running.account, { alias: 'Claude One' });
  assert.equal(running.events, null, 'the event clock is not recorded yet: unknown, not zero');
  assert.deepEqual(running.attempts, [{ n: 1, host: null, account: { alias: 'Claude One' }, startedAt: T(1), endedAt: null, closedAt: null, outcome: null, runnerAlive: true }]);
  assert.equal(card(record(), [attempt()], opts({ runnerAlive: () => null })).attempts[0]!.runnerAlive, null, 'unknown stays unknown');

  const failed = card(record({ state: 'failed', updatedAt: T(9), error: { kind: 'offline', message: 'm' } }), [
    attempt({ endedAt: T(3), outcome: { kind: 'interrupted', message: 'm' } }),
    attempt({ id: 'a2', accountId: 'claude-two', startedAt: T(4), endedAt: T(8), outcome: { kind: 'failed', errorKind: 'offline', message: 'm' } }),
  ], opts({ runnerAlive: () => { throw new Error('an ended attempt is never probed'); } }));
  assert.equal(failed.errorKind, 'offline');
  assert.equal(failed.finishedAt, T(9), 'a final state absorbs, so its updatedAt is when it finished');
  assert.equal(failed.startedAt, T(1), 'the first attempt');
  assert.equal(failed.account, null, 'no open attempt');
  assert.deepEqual(failed.attempts.map((x) => [x.n, x.host, x.account.alias, x.outcome, x.runnerAlive]),
    [[1, null, 'Claude One', 'interrupted', null], [2, null, 'claude-two', 'failed', null]]);

  assert.equal(card(record({ state: 'queued', finishedAt: T(3) }), [], opts()).finishedAt, null, 'only a final card has a finish');
  assert.deepEqual(card(record(), [attempt({ accountId: 'gone' })], opts({ alias: () => null })).account, { alias: null },
    'an account no longer configured is unknown, never another account\'s name');
  const queued = card(record({ state: 'queued' }), [], opts());
  assert.equal(queued.startedAt, null);
  assert.deepEqual(queued.attempts, []);
  assert.equal(queued.account, null);
});

test('a queued card says why it waits by code, never by its wording; draining overrides while the pipe takes no new work', () => {
  const waiting = record({ state: 'queued', waiting: { reason: `no claude account is free: ${SECRET}`, until: T(5), kind: 'no_free_account' } });
  assert.deepEqual(card(waiting, [], opts()).waiting, { kind: 'no_free_account', until: T(5) });
  assert.deepEqual(card(waiting, [], opts({ draining: true })).waiting, { kind: 'draining', until: null });
  assert.deepEqual(card(record({ state: 'queued' }), [], opts({ draining: true })).waiting, { kind: 'draining', until: null });
  assert.equal(card(record({ state: 'queued', waiting: { reason: 'an older wait', until: null } }), [], opts()).waiting, null,
    'a wait recorded before the codes existed has no code: unknown');
  assert.equal(card(record(), [attempt()], opts({ draining: true })).waiting, null, 'a running job does not wait');
});

test('the planner gives every wait a code', () => {
  const now = new Date(T(10));
  const account = (id: string): AccountConfig => ({ id, provider: 'claude', loginDir: `/logins/${id}`, fingerprint: `fp-${id}`, maxConcurrency: 1, enabled: true });
  const status = (id: string, running: number): AccountStatus => ({
    account: account(id), running,
    evidence: (model) => ({ accountId: id, model, observedAt: now.toISOString(), verdict: { state: 'available', headroom: 0.5 } }),
  });
  const options = { now, pinWaitMs: 3_600_000, evidenceMaxAgeMs: 600_000, load: new Map() };
  const busy = plan([record({ state: 'queued', mutating: false })], [status('claude-one', 1)], options);
  assert.equal(busy.waits[0]?.kind, 'no_free_account');
  const backoff = plan([record({ state: 'queued', mutating: false, notBefore: T(20) })], [status('claude-one', 0)], options);
  assert.equal(backoff.waits[0]?.kind, 'backoff');
  const pinned = plan([record({ state: 'queued', mutating: false, pin: 'claude-one' })], [status('claude-one', 1)], options);
  assert.equal(pinned.waits[0]?.kind, 'pinned_account');
  const noRoute = plan([record({ state: 'queued', mutating: false })], [], options);
  assert.equal(noRoute.waits[0]?.kind, 'no_route');
  const paused = plan([record({ state: 'queued', mutating: false })], [status('claude-one', 0)], { ...options, pinWaitMs: Number.NaN });
  assert.equal(paused.waits[0]?.kind, 'paused');
});

test('saved: a completed changing job says what became of its work, with the commit only when it was saved', () => {
  type Saved = 'saved' | 'no_changes' | 'not_saved' | 'unknown';
  const ws = (saved?: Saved) => ({ path: `/wt/${SECRET}`, branch: 'pipe/r1', commit: 'abc123', ...(saved ? { saved } : {}) });
  const done = (saved?: Saved) =>
    card(record({ state: 'completed', workspace: ws(saved) }), [attempt({ endedAt: T(2), outcome: { kind: 'completed', result: 'r' } })], opts()).saved;
  assert.deepEqual(done(), { state: 'pending', branch: 'pipe/r1', commit: null, diff: null });
  assert.deepEqual(done('saved'), { state: 'saved', branch: 'pipe/r1', commit: 'abc123', diff: null });
  assert.deepEqual(done('no_changes'), { state: 'no_changes', branch: 'pipe/r1', commit: null, diff: { files: 0, insertions: 0, deletions: 0 } });
  assert.deepEqual(done('not_saved'), { state: 'not_saved', branch: 'pipe/r1', commit: null, diff: null });
  assert.deepEqual(done('unknown'), { state: 'unknown', branch: 'pipe/r1', commit: null, diff: null }, 'finished before saves were recorded');
  assert.equal(card(record({ state: 'completed', mutating: false }), [], opts()).saved, null, 'read-only work saves nothing');
  assert.equal(card(record({ state: 'failed', workspace: ws('saved') }), [], opts()).saved, null, 'only a completed job');
});

const HASH = (digit: string) => digit.repeat(40);
const CFG: AccountConfig = { id: 'claude-one', provider: 'claude', loginDir: '/logins/claude-one', fingerprint: 'fp1', maxConcurrency: 1, enabled: true };
const evidence = (minutes: number): DispatchEvidence =>
  ({ accountId: CFG.id, model: 'opus', observedAt: T(minutes), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] });

function openStore(path = join(mkdtempSync(join(tmpdir(), 'pipe-u19-')), 'pipe.sqlite')) {
  const clock = { now: new Date(T(0)) };
  const store = new Store(path, { now: () => clock.now });
  return { store, path, set: (m: number) => { clock.now = new Date(T(m)); } };
}
const newRequest = (over: Partial<NewRequest> = {}): NewRequest => ({
  requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'r',
  prompt: `p ${SECRET}`, mutating: false, priority: 'interactive', ...over,
});
/** A completed changing job whose save has not run yet. */
function finishedChange(store: Store, minutes = 0): string {
  const r = store.submit(newRequest({ kind: 'code', mutating: true, cwd: WORK }));
  const got = store.startAttempt(r.id, CFG, evidence(minutes));
  assert.ok(got.ok, JSON.stringify(got));
  const workspace = { path: join(WORK, 'wt'), branch: `pipe/${r.id}`, commit: HASH('0') };
  store.noteWorkspace(got.attempt.id, workspace);
  store.finishAttempt(got.attempt.id, { kind: 'completed', result: 'done', workspace });
  return r.id;
}

test('the record keeps what a save did; a later clean save never undoes "saved"; a save is a change a reader sees', () => {
  const { store, set } = openStore();
  const a = finishedChange(store);
  const finished = store.get(a)!;
  assert.equal(finished.finishedAt, finished.updatedAt, 'the final state stamps finishedAt');
  set(5);
  assert.equal(store.recordWorkspaceCommit(a, HASH('1'), true), true);
  const saved = store.get(a)!;
  assert.deepEqual(saved.workspace, { path: join(WORK, 'wt'), branch: `pipe/${a}`, commit: HASH('1'), saved: 'saved' });
  assert.equal(saved.updatedAt, finished.updatedAt, 'the full record\'s update time is left alone for older clients');
  assert.equal(saved.finishedAt, finished.finishedAt, 'finishedAt never moves');
  assert.ok(store.changedAfter(0, 100).requests.some((r) => r.id === a), 'the save is a change a reader of the feed sees');
  // Prune reaches the same worktree, now clean: its save reports no changes.
  assert.equal(store.recordWorkspaceCommit(a, HASH('1'), false), true);
  assert.equal(store.get(a)!.workspace!.saved, 'saved', 'a clean tree after a save is still saved');
  assert.equal(store.noteWorkspaceNotSaved(a), false, 'a refused save never undoes a recorded one');
  const b = finishedChange(store, 5);
  assert.equal(store.recordWorkspaceCommit(b, HASH('0'), false), true);
  assert.equal(store.get(b)!.workspace!.saved, 'no_changes');
  // The job committed its own work: HEAD moved past the base though the tree is clean.
  const d = finishedChange(store, 5);
  assert.equal(store.recordWorkspaceCommit(d, HASH('4'), false), true);
  assert.deepEqual([store.get(d)!.workspace!.saved, store.get(d)!.workspace!.commit], ['saved', HASH('4')]);
  // A save whose record failed, then a clean tree: the earlier save may have committed, so it is unknown.
  const e = finishedChange(store, 5);
  assert.equal(store.noteWorkspaceNotSaved(e), true);
  assert.equal(store.recordWorkspaceCommit(e, HASH('0'), false), true);
  assert.equal(store.get(e)!.workspace!.saved, 'unknown');
  const c = finishedChange(store, 5);
  assert.equal(store.noteWorkspaceNotSaved(c), true);
  assert.equal(store.get(c)!.workspace!.saved, 'not_saved');
  assert.equal(store.noteWorkspaceNotSaved(c), false, 'recorded once');
  assert.equal(store.recordWorkspaceCommit(c, HASH('2'), true), true, 'prune saves it later');
  assert.equal(store.get(c)!.workspace!.saved, 'saved');
  store.close();
});

test('changes page by a change number no clock can reorder: a same-instant update and one after a clock step are both seen', () => {
  const { store, set } = openStore();
  const burst = [store.submit(newRequest()).id, store.submit(newRequest()).id, store.submit(newRequest()).id];
  const read = (after: number, limit = 1) => store.changedAfter(after, limit);
  const seen: string[] = [];
  let after = 0;
  for (let i = 0; i < 10; i += 1) { const page = read(after); if (!page.next) break; seen.push(...page.requests.map((r) => r.id)); after = page.next.after; }
  assert.deepEqual(seen, burst, 'a burst stamped in one millisecond, read once each, in order');
  // Same millisecond as the last page: a lower-seq request changes after it was read.
  store.setWaiting(burst[0]!, { reason: 'r', until: null, kind: 'backoff' });
  assert.deepEqual(read(after, 10).requests.map((r) => r.id), [burst[0]]);
  after = read(after, 10).next!.after;
  // The clock steps back an hour: every stamp is held at the file's latest, yet the change is still seen.
  set(-60);
  store.fail(burst[1]!, 'stopped');
  assert.deepEqual(read(after, 10).requests.map((r) => r.id), [burst[1]]);
  after = read(after, 10).next!.after;
  assert.deepEqual(read(after, 10), { requests: [], next: null }, 'an empty page: caught up');
  // A card shows its attempts, so an attempt that ends after its request was cancelled is a change too.
  set(0);
  const running = store.submit(newRequest()).id;
  const tried = store.startAttempt(running, CFG, evidence(0));
  assert.ok(tried.ok, JSON.stringify(tried));
  store.cancel(running, 'stop', 'dev-a');
  after = read(after, 10).next!.after;
  store.finishAttempt(tried.attempt.id, { kind: 'cancelled', message: 'stopped' });
  assert.deepEqual(read(after, 10).requests.map((r) => r.id), [running], 'the attempt ending is in the feed');
  assert.deepEqual(store.attempts(burst[0]!), []);
  store.close();
});

test('an older record gains finishedAt from its last update, and its completed work an unknown save', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const first = openStore();
  const a = finishedChange(first.store);
  const queued = first.store.submit(newRequest()).id;
  first.store.close();
  const db = new DatabaseSync(first.path);
  db.exec(`DROP TRIGGER requests_finished; DROP TRIGGER requests_changed; DROP TRIGGER requests_changed_on_insert;
    DROP TRIGGER attempts_changed; DROP TRIGGER attempts_changed_on_insert;
    DROP INDEX requests_change; DROP TABLE changes; ALTER TABLE requests DROP COLUMN finished_at; ALTER TABLE requests DROP COLUMN change_seq`);
  db.close();
  const { store, set } = openStore(first.path);
  const r = store.get(a)!;
  assert.equal(r.finishedAt, r.updatedAt);
  assert.equal(r.workspace!.saved, 'unknown', 'its save was never recorded: unknown, not pending');
  assert.equal(store.get(queued)!.finishedAt, null);
  // Older rows are numbered by their last update; the next write takes the number after them, and a reader sees it.
  const numbered = store.changedAfter(0, 10);
  assert.deepEqual(numbered.requests.map((x) => x.id), [a, queued]);
  const top = numbered.next!.after;
  assert.equal(top, 2);
  assert.equal(store.recordWorkspaceCommit(a, HASH('0'), false), true);
  assert.deepEqual(store.changedAfter(top, 10).requests.map((x) => x.id), [a], 'the next write is numbered above the older rows');
  assert.equal(store.get(a)!.workspace!.saved, 'unknown', 'a clean tree proves nothing about an older save: still unknown');
  assert.equal(store.recordWorkspaceCommit(a, HASH('3'), true), true);
  assert.equal(store.get(a)!.workspace!.saved, 'saved');
  set(7);
  store.fail(queued, 'stopped');
  assert.equal(store.get(queued)!.finishedAt, T(7), 'the trigger is back for new finishes');
  store.close();
});

test('GET /v1/cards and /v1/health: authorised, content-free, strict, paged; open cards include a final job still stopping', async (t) => {
  const { store, set } = openStore();
  const q1 = store.submit(newRequest()); set(2);
  const q2 = store.submit(newRequest()); set(4);
  const q3 = store.submit(newRequest()); store.fail(q3.id, `bad ${SECRET}`);
  const q4 = store.submit(newRequest());
  assert.equal(store.setWaiting(q4.id, { reason: `waiting on ${SECRET}`, until: T(9), kind: 'backoff' }), true);
  const q5 = store.submit(newRequest());
  assert.ok(store.startAttempt(q5.id, CFG, evidence(4)).ok);
  store.cancel(q5.id, 'stop', 'dev-a');            // cancelled, but its runner has not ended yet
  let draining = false;
  let http: Awaited<ReturnType<typeof startHttp>> | null = null;
  try {
    http = await startHttp({
      token, store, policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      accounts: () => [], models: () => ({}), accountIds: () => [], draining: () => draining, drain: async () => {}, cancel: () => {},
      cards: {
        alias: (id) => id, runnerAlive: () => null,
        health: () => ({ startedAt: T(0), clockCurrent: true, accounts: [
          { alias: 'Claude One', provider: 'claude', enabled: true, running: 0, identity: { accountId: 'claude-one', signedIn: true, fingerprint: SECRET, observedAt: T(1) },
            allowance: { state: 'unknown', accountId: 'claude-one', reason: SECRET } },
        ] }),
      },
    });
    const url = http.url;
    const get = async (path: string, auth = true) => {
      const r = await fetch(`${url}${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
      return { status: r.status, body: await r.json() as Record<string, any> };
    };
    const enc = encodeURIComponent;
    assert.equal((await get('/v1/cards?open=true', false)).status, 401);
    const open = await get('/v1/cards?open=true');
    assert.equal(open.status, 200);
    assert.equal(open.body.schema, CARD_SCHEMA);
    assert.equal(open.body.clockCurrent, true);
    assert.deepEqual(open.body.cards.map((c: any) => [c.id, c.state]), [[q1.id, 'queued'], [q2.id, 'queued'], [q4.id, 'queued'], [q5.id, 'cancelled']]);
    assert.deepEqual(open.body.cards[2].waiting, { kind: 'backoff', until: T(9) }, 'the planner\'s code survives the record');
    assert.deepEqual(open.body.cards[3].account, { alias: 'claude-one' }, 'the job still stopping holds its account');
    assert.deepEqual(open.body.cards[3].attempts.map((a: any) => a.host), [null], 'no configured executor alias');
    draining = true;
    assert.deepEqual((await get('/v1/cards?open=true')).body.cards[0].waiting, { kind: 'draining', until: null });
    draining = false;

    const all = await get('/v1/cards?after=0&limit=500');
    assert.deepEqual(all.body.cards.map((c: any) => c.id).sort(), [q1.id, q2.id, q3.id, q4.id, q5.id].sort());
    const first = await get('/v1/cards?after=0&limit=1');
    assert.equal(first.body.cards.length, 1);
    assert.equal(typeof first.body.next.after, 'number');
    const rest = await get(`/v1/cards?after=${first.body.next.after}&limit=500`);
    const firstIds = first.body.cards.map((c: any) => c.id), restIds = rest.body.cards.map((c: any) => c.id);
    assert.equal(firstIds.length + restIds.length, 5);
    assert.deepEqual([...firstIds, ...restIds].sort(), [q1.id, q2.id, q3.id, q4.id, q5.id].sort(), 'every card once, across pages');
    assert.equal(rest.body.clockCurrent, true);
    const end = await get(`/v1/cards?after=${rest.body.next.after}`);
    assert.deepEqual([end.body.cards, end.body.next], [[], null], 'an empty page: caught up');
    for (const bad of ['/v1/cards', '/v1/cards?open=yes', '/v1/cards?open=true&open=true', '/v1/cards?after=-1', '/v1/cards?after=x',
      '/v1/cards?after=1.5', '/v1/cards?after=01', '/v1/cards?after=0&after=1', '/v1/cards?after=0&limit=0', '/v1/cards?after=0&limit=501',
      '/v1/cards?after=0&limit=2.5', '/v1/cards?after=0&limit=1&limit=2', '/v1/cards?after=0&other=1', `/v1/cards?updatedSince=${enc(T(0))}`]) {
      assert.equal((await get(bad)).status, 400, bad);
    }
    const one = await get(`/v1/cards/${q3.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.card.state, 'failed');
    assert.equal(one.body.card.finishedAt, T(4));
    assert.equal(one.body.clockCurrent, true);
    for (const missing of ['/v1/cards/no-such-id', `/v1/cards/${q3.id}%2Fx`, '/v1/cards/']) assert.equal((await get(missing)).status, 404, missing);
    assert.equal((await get('/v1/cards/%ZZ')).status, 400);
    const h = await get('/v1/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.schema, CARD_SCHEMA);
    assert.deepEqual(h.body.service, { host: null, version: null, startedAt: T(0), clockCurrent: true, draining: false });
    assert.deepEqual(h.body.accounts, [{ alias: 'Claude One', provider: 'claude', enabled: true, running: 0, signedIn: true,
      signedInObservedAt: T(1), allowance: { state: 'unknown', until: null }, lastProbeAt: null, consecutiveProbeFailures: null }]);
    assert.ok(!JSON.stringify([open.body, all.body, first.body, rest.body, one.body, h.body]).includes(SECRET));
  } catch (e) { if (/(?:EACCES|EPERM|listen)/.test((e as Error).message)) t.skip('loopback bind unavailable'); else throw e; }
  finally { if (http) { const h = http; await new Promise<void>((resolve) => h.server.close(() => resolve())); } store.close(); }
});

test('runnerAlive is true only with proof that the group is this runner\'s, false only when no group has its id, else unknown', async () => {
  const { runnerGroupAlive, processStart } = await import('../src/runner.ts');
  assert.equal(runnerGroupAlive(null), null);
  assert.equal(runnerGroupAlive({ pid: 1, startedAt: 'tag:x' }), null, 'pid 1 would probe every process');
  assert.equal(runnerGroupAlive({ pid: 0, startedAt: 'tag:x' }), null);
  // The tag where a runner carries it: its environment (Linux reads /proc) and its command line (macOS ps may not show
  // another process's environment).
  const tag = randomUUID();
  const child = spawn('sh', ['-c', 'sleep 30; :', `PIPE_ATTEMPT_ID=${tag}`],
    { detached: true, stdio: 'ignore', env: { ...process.env, PIPE_ATTEMPT_ID: tag } });
  await new Promise((resolve) => child.once('spawn', resolve));
  const pid = child.pid!;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    const mark = processStart(pid, tag, true);
    assert.ok(mark, 'the runner carries its tag');
    assert.equal(runnerGroupAlive({ pid, startedAt: mark! }), true);
    assert.equal(runnerGroupAlive({ pid, startedAt: `tag:${randomUUID()}` }), null, 'another runner\'s mark is not proof');
    assert.equal(runnerGroupAlive({ pid, startedAt: 'unverified:1' }), null, 'no tag is not proof');
  } finally { process.kill(-pid, 'SIGKILL'); await exited; }
  let gone: boolean | null = null;
  for (let i = 0; i < 100 && gone !== false; i += 1) { gone = runnerGroupAlive({ pid, startedAt: `tag:${tag}` }); if (gone !== false) await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(gone, false, 'no group has its id: gone');
});

test('health: the service and each account by code and time; never a fingerprint or wording; until only when exhausted', () => {
  const h = health({ startedAt: T(0), clockCurrent: false, draining: false, accounts: [
    { alias: 'Claude One', provider: 'claude', enabled: true, running: 1, identity: { accountId: 'claude-one', signedIn: true, fingerprint: SECRET, observedAt: T(1) },
      allowance: { state: 'ok', accountId: 'claude-one', headroom: 0.4, binding: `b ${SECRET}` } },
    { alias: 'claude-two', provider: 'claude', enabled: false, running: 0, identity: null,
      allowance: { state: 'exhausted', accountId: 'claude-two', bucket: SECRET, until: T(60) } },
  ] });
  assert.ok(!JSON.stringify(h).includes(SECRET));
  assert.deepEqual(h.service, { host: null, version: null, startedAt: T(0), clockCurrent: false, draining: false });
  assert.deepEqual(h.accounts[0], { alias: 'Claude One', provider: 'claude', enabled: true, running: 1, signedIn: true, signedInObservedAt: T(1),
    allowance: { state: 'ok', until: null }, lastProbeAt: null, consecutiveProbeFailures: null });
  assert.deepEqual(h.accounts[1]!.allowance, { state: 'exhausted', until: T(60) });
  assert.equal(h.accounts[1]!.signedIn, null, 'a sign-in never observed is unknown, not false');
});

test('a display name for cards: 1 to 40 characters, no surrounding spaces, control or format characters, and unique', () => {
  const login = (name: string) => mkdtempSync(join(tmpdir(), `pipe-u19-${name}-`));
  const [one, two] = [login('one'), login('two')];
  const base = (over: Record<string, unknown>) => ({ id: 'claude-one', provider: 'claude', loginDir: one, fingerprint: 'fp1',
    maxConcurrency: 1, enabled: true, ...over }) as AccountConfig;
  const defaults = { claude: join(one, 'not-the-default'), codex: join(one, 'x'), gemini: join(one, 'y') };
  validateAccounts([base({ displayName: 'Claude One' })], { defaultLoginDirs: defaults });
  validateAccounts([base({})], { defaultLoginDirs: defaults });
  const c = (code: number) => String.fromCharCode(code);
  for (const bad of ['', '   ', ' lead', 'trail ', 'x'.repeat(41), `a${c(10)}b`, `a${c(7)}b`, `a${c(0x85)}b`, `a${c(0x200b)}b`, `a${c(0x202e)}b`, `a${c(0x2028)}b`, `a${c(0x378)}b`, 7]) {
    assert.throws(() => validateAccounts([base({ displayName: bad })], { defaultLoginDirs: defaults }), /displayName/, JSON.stringify(bad));
  }
  const pair = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    [base(a), base({ id: 'claude-two', loginDir: two, fingerprint: 'fp2', ...b })];
  validateAccounts(pair({ displayName: 'One' }, { displayName: 'Two' }), { defaultLoginDirs: defaults });
  const fullwidthSame = String.fromCharCode(0xff33, 0xff41, 0xff4d, 0xff45);   // SAME in fullwidth letters
  validateAccounts(pair({ displayName: 'CLAUDE-ONE' }, {}), { defaultLoginDirs: defaults });   // its own id, another case
  for (const [a, b] of [[{ id: 'Claude-X', displayName: 'X1' }, { id: 'claude-x', displayName: 'X2' }], [{ id: 'Dup' }, { id: 'dup' }]]) {
    assert.throws(() => validateAccounts(pair(a!, b!), { defaultLoginDirs: defaults }), /whatever the case/, JSON.stringify([a, b]));
  }
  for (const [a, b] of [[{ displayName: 'Same' }, { displayName: 'same' }], [{ displayName: 'claude-two' }, {}], [{}, { displayName: 'CLAUDE-ONE' }],
    [{ displayName: 'Foo' }, { displayName: 'claude-one' }], [{ displayName: 'Same' }, { displayName: fullwidthSame }]]) {
    assert.throws(() => validateAccounts(pair(a!, b!), { defaultLoginDirs: defaults }), /displayName/, JSON.stringify([a, b]));
  }
});

test('S19: src/cards.ts stays small and pure (shared validator and type imports, no I/O)', () => {
  const text = readFileSync(new URL('../src/cards.ts', import.meta.url), 'utf8');
  const lines = text.split('\n').filter((line) => line.trim()).length;
  // The 2026-10-08 merge: main's health fields (46 → 49) plus the live line's two placement lines: 51 (the lead).
  assert.doesNotMatch(readFileSync(new URL('../src/host.ts', import.meta.url), 'utf8'), /\b(?:import|require|process)\b/, 'shared validator has no I/O dependencies');
  // Velocity telemetry: the card's saved.diff: +3 (the lead).
  // u44 housekeeping (round 3, no archiving; 2026-10-29): the health card's housekeeping block (tier, retention, last pass and kept counts by kind): +7 (54 → 61), the lead.
  // u44 lead round 7c (2026-10-29): the health card's housekeeping gate count and age: +1 (61 → 62), the lead.
  assert.ok(lines <= 62, `src/cards.ts has ${lines} non-blank lines; its budget is 62`);
  for (const line of text.split('\n').filter((l) => l.startsWith('import '))) assert.match(line, /^import type |^import \{ hostAlias \} from '\.\/host\.ts';$/, line);
});

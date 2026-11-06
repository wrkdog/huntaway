/**
 * Acceptance grader, lane U16: per-attempt temporary folders (lead-authored; the builder must not edit it).
 *
 * Interface the builder must provide
 * - Keep the exported `removeAttemptTemp(root, attemptId, log)` and add an optional fourth
 *   `groupGone: () => boolean` argument. A false answer is not proof of exit: keep the folder
 *   and let a later call retry. The pipe must pass its actual runner-group proof at completion.
 * - Keep the exported `cleanEndedTemps(root, store, log)` and add a fourth `keepHours: number`
 *   argument. Startup must call it with the same retention period used for worktrees.
 * - On removal failure, call `log('remove attempt temp folder', error)`; this fixed operation
 *   name must not contain an attempt id or filesystem path. The pipe may include detail in
 *   the error argument.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEndedTemps, removeAttemptTemp } from '../src/disk.ts';
import { startPipe } from '../src/service.ts';
import { Store, type AttemptOutcome, type DispatchEvidence } from '../src/store.ts';
import type { AccountConfig } from '../src/identity.ts';

const KEEP_HOURS = 24;
const root = () => realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-u16-')));
const log = (_where: string, _error: unknown) => {};
const remove = (at: string, id: string, logger = log, groupGone?: () => boolean) =>
  (removeAttemptTemp as unknown as (root: string, id: string, log: typeof logger, groupGone?: () => boolean) => void)(at, id, logger, groupGone);
const clean = (at: string, store: Store, keepHours = KEEP_HOURS) =>
  (cleanEndedTemps as unknown as (root: string, store: Store, logger: typeof log, keepHours: number) => void)(at, store, log, keepHours);

function record(home: string) {
  const store = new Store(join(home, 'pipe.sqlite'));
  const loginDir = join(home, 'login');
  mkdirSync(loginDir);
  const account: AccountConfig = { id: 'claude-a', provider: 'claude', loginDir,
    fingerprint: 'test-fingerprint', maxConcurrency: 1, enabled: true };
  const submit = () => store.submit({ requester: 'grader', project: 'tmp-cleanup', kind: 'chat',
    provider: 'claude', model: 'opus', effort: 'high', reason: 'test attempt temp cleanup',
    prompt: 'say OK', mutating: false, priority: 'interactive' });
  const start = () => {
    const request = submit();
    const evidence: DispatchEvidence = { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(),
      verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] };
    const started = store.startAttempt(request.id, account, evidence);
    assert.equal(started.ok, true, JSON.stringify(started));
    return { request, attempt: started.attempt };
  };
  return { store, submit, start };
}

function folder(at: string, id: string, ageHours: number) {
  const dir = join(at, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scratch'), 'scratch');
  const when = new Date(Date.now() - ageHours * 3_600_000);
  utimesSync(dir, when, when);
  return dir;
}

for (const [name, outcome] of [
  ['completed', { kind: 'completed', result: 'OK' }],
  ['failed', { kind: 'failed', errorKind: 'other', message: 'CLI failed' }],
  ['cancelled', { kind: 'cancelled', message: 'requester cancelled' }],
  ['timed-out', { kind: 'failed', errorKind: 'other', message: 'CLI timed out' }],
] as Array<[string, AttemptOutcome]>) {
  test(`An ended ${name} attempt keeps TMPDIR while its runner group may live, then removes it after proof of exit`, () => {
    const home = root();
    const at = join(home, 'tmp');
    const r = record(home);
    try {
      const { attempt } = r.start();
      r.store.finishAttempt(attempt.id, outcome);
      const dir = folder(at, attempt.id, 0);
      remove(at, attempt.id, log, () => false);
      assert.ok(existsSync(join(dir, 'scratch')), 'an unproved runner may still use TMPDIR');
      remove(at, attempt.id, log, () => true);
      assert.equal(existsSync(dir), false, 'remove TMPDIR after group-exit proof');
    } finally { r.store.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test('Startup prunes an old orphan attempt folder after the worktree retention period', () => {
  const home = root();
  const at = join(home, 'tmp');
  const r = record(home);
  try {
    const old = folder(at, randomUUID(), KEEP_HOURS + 2);
    clean(at, r.store);
    assert.equal(existsSync(old), false, 'an old orphan has no request to protect it');
  } finally { r.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('Startup retains an ended attempt folder with no recorded runner even after retention', () => {
  const home = root();
  const at = join(home, 'tmp');
  const r = record(home);
  try {
    const { attempt } = r.start();
    r.store.finishAttempt(attempt.id, { kind: 'completed', result: 'OK' });
    const young = folder(at, attempt.id, 1);
    clean(at, r.store);
    assert.ok(existsSync(young), 'retention applies even to recorded completed attempts');
    const past = new Date(Date.now() - (KEEP_HOURS + 2) * 3_600_000);
    utimesSync(young, past, past);
    clean(at, r.store);
    assert.ok(existsSync(young), 'an ended attempt without group identity has no exit proof');
  } finally { r.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('Startup retains an old Codex attempt whose spawn was possible but no runner identity was stored', () => {
  const home = root();
  const at = join(home, 'tmp');
  const r = record(home);
  try {
    const { attempt } = r.start();
    r.store.noteMayStart(attempt.id);
    r.store.finishAttempt(attempt.id, { kind: 'completed', result: 'OK' });
    const dir = folder(at, attempt.id, KEEP_HOURS + 2);
    clean(at, r.store);
    assert.ok(existsSync(dir), 'a crash before noteRunner can leave a live group with no recorded PID');
  } finally { r.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('Startup keeps an old folder for a request still queued or running', () => {
  const home = root();
  const at = join(home, 'tmp');
  const r = record(home);
  try {
    const queued = r.start();
    r.store.finishAttempt(queued.attempt.id, { kind: 'unstarted', message: 'runner stopped before prompt' });
    assert.equal(r.store.get(queued.request.id)?.state, 'queued');
    const queuedDir = folder(at, queued.attempt.id, KEEP_HOURS + 2);
    const running = r.start();
    const runningDir = folder(at, running.attempt.id, KEEP_HOURS + 2);
    clean(at, r.store);
    assert.ok(existsSync(queuedDir), 'a queued retry still owns its prior attempt folder');
    assert.ok(existsSync(runningDir), 'an open attempt still owns its folder');
  } finally { r.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('Removal does not follow a planted tmp-root symlink to an outside folder', () => {
  const home = root();
  const outside = root();
  const at = join(home, 'tmp');
  const id = 'attempt-inside-outside';
  try {
    const target = folder(outside, id, KEEP_HOURS + 2);
    symlinkSync(outside, at, 'dir');
    remove(at, id, log, () => true);
    assert.equal(readFileSync(join(target, 'scratch'), 'utf8'), 'scratch', 'outside content is intact');
    assert.ok(lstatSync(at).isSymbolicLink(), 'the planted link was not traversed');
    unlinkSync(at);
    const inside = folder(at, 'owned-attempt', 0);
    symlinkSync(outside, join(inside, 'planted-link'), 'dir');
    remove(at, 'owned-attempt', log, () => true);
    assert.equal(existsSync(inside), false, 'an owned folder containing a link is removed');
    assert.equal(readFileSync(join(target, 'scratch'), 'utf8'), 'scratch', 'the nested link never removes its target');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('A removal failure logs one fixed message and does not throw', () => {
  const home = root();
  const at = join(home, 'tmp');
  const seen: Array<{ where: string; error: unknown }> = [];
  try {
    mkdirSync(at);
    // A single overlong path component fails at the filesystem boundary on supported platforms.
    assert.doesNotThrow(() => remove(at, 'x'.repeat(300), (where, error) => seen.push({ where, error }), () => true));
    assert.equal(seen.length, 1, 'one removal failure is logged once');
    assert.equal(seen[0]!.where, 'remove attempt temp folder');
    assert.ok(seen[0]!.error instanceof Error, 'the cause is available to the operator');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Starting the pipe prunes old orphan TMPDIR folders and keeps younger ones', async () => {
  const home = root();
  const at = join(home, 'tmp');
  const old = folder(at, randomUUID(), KEEP_HOURS + 2);
  const young = folder(at, randomUUID(), 1);
  const loginDir = join(home, 'login');
  mkdirSync(loginDir);
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  try {
    pipe = await startPipe({
      accounts: [{ id: 'claude-a', provider: 'claude', loginDir, fingerprint: 'test-fingerprint',
        maxConcurrency: 1, enabled: false }],
      policy: { claude: { models: { opus: 'default' }, efforts: ['low', 'medium', 'high', 'max'] } },
      storePath: join(home, 'pipe.sqlite'), worktreeRoot: join(home, 'worktrees'), tmpRoot: at,
      worktreeKeepHours: KEEP_HOURS, minFreeGb: 0, cli: {}, token: 'pipe-test-token-not-a-credential-0123456789', port: 0,
    } as Parameters<typeof startPipe>[0]);
    assert.equal(existsSync(old), false, 'startup prunes an orphan older than worktree retention');
    assert.ok(existsSync(young), 'startup keeps a younger orphan');
  } finally { await pipe?.stop(); rmSync(home, { recursive: true, force: true }); }
});

test('Removal rejects parent traversal and keeps the tmp root itself', () => {
  const home = root();
  const at = join(home, 'tmp');
  try {
    const outside = folder(home, 'outside', 0);
    folder(at, 'owned', 0);
    remove(at, '../outside', log, () => true);
    assert.ok(existsSync(join(outside, 'scratch')), 'parent traversal never removes a sibling');
    remove(at, '.', log, () => true);
    assert.ok(existsSync(join(at, 'owned', 'scratch')), 'the tmp root cannot be an attempt');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Startup keeps a cancelled request with an open attempt and leaves unrelated old folders alone', () => {
  const home = root();
  const at = join(home, 'tmp');
  const r = record(home);
  try {
    const live = r.start();
    r.store.cancel(live.request.id, 'requester stopped');
    const held = folder(at, live.attempt.id, KEEP_HOURS + 2);
    const unrelated = folder(at, 'operator-notes', KEEP_HOURS + 2);
    clean(at, r.store);
    assert.ok(existsSync(held), 'cancellation is not proof of runner exit');
    assert.ok(existsSync(unrelated), 'only per-attempt folders are eligible');
  } finally { r.store.close(); rmSync(home, { recursive: true, force: true }); }
});

test('The service retains TMPDIR when group-exit proof is unavailable and retries cleanup after proof returns', async (t) => {
  const home = root();
  const at = join(home, 'tmp');
  const loginDir = join(home, 'login');
  mkdirSync(loginDir);
  const pidFile = join(home, 'runner-pid');
  const tmpFile = join(home, 'runner-tmp');
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/u4/${name}.json`, import.meta.url), 'utf8')).stdout;
  const cli = join(home, 'fake-claude');
  // Only this synthetic job's signal-0 probe is made uncertain. Signals used to
  // stop it still reach the real child, and the mock is always restored.
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') process.stdout.write(${JSON.stringify(fixture('claude-version'))});
else if (args[0] === 'auth') process.stdout.write(JSON.stringify(${JSON.stringify(fixture('claude-auth-status.signed-in'))}));
else if (args[0] === '-p' && args[1] === '/usage') {
  const usage = ${JSON.stringify(fixture('claude-usage.signed-in'))};
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(Date.now() + 3 * 3600000)).map(x => [x.type, x.value]));
  const reset = parts.month + ' ' + parts.day + ' at ' + parts.hour + ':' + parts.minute + parts.dayPeriod.toLowerCase();
  usage.result = usage.result.replace(/resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m/g, 'resets ' + reset);
  process.stdout.write(JSON.stringify(usage));
} else {
  fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  fs.writeFileSync(${JSON.stringify(tmpFile)}, process.env.TMPDIR);
  fs.writeFileSync(require('node:path').join(process.env.TMPDIR, 'scratch'), 'still owned');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 'synthetic' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }));
}
`);
  chmodSync(cli, 0o755);
  const realKill = process.kill.bind(process);
  let uncertain = true;
  const probe = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (uncertain && signal === 0 && existsSync(pidFile) && pid === -Number(readFileSync(pidFile, 'utf8'))) {
      throw Object.assign(new Error('synthetic unverified process group'), { code: 'EPERM' });
    }
    return realKill(pid, signal);
  });
  const token = 'pipe-test-token-not-a-credential-0123456789';
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  async function until<T>(get: () => T | Promise<T>, ok: (v: T) => boolean): Promise<T> {
    const end = performance.now() + 20000;
    for (;;) {
      const value = await get();
      if (ok(value)) return value;
      assert.ok(performance.now() < end, 'synthetic service condition did not settle');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    pipe = await startPipe({ accounts: [{ id: 'claude-a', provider: 'claude', loginDir,
      fingerprint: createHash('sha256').update('<orgId>').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true }],
      policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      storePath: join(home, 'pipe.sqlite'), worktreeRoot: join(home, 'worktrees'), tmpRoot: at,
      cli: { claude: cli }, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
      reachable: async () => true, token, port: 0, tickMs: 50, probeIntervalMs: 60000,
      minFreeGb: 0, worktreeKeepHours: KEEP_HOURS, pruneIntervalMs: 100 });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(pipe!.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok(res.ok, `${method} ${path}: ${res.status}`);
      return res.json() as Promise<any>;
    };
    const { request } = await call('POST', '/v1/requests', { requester: 'grader', project: 'pipe', kind: 'chat',
      provider: 'claude', model: 'opus', effort: 'high', prompt: 'synthetic task', reason: 'group proof test',
      mutating: false, priority: 'interactive' });
    await until(() => call('GET', `/v1/requests/${request.id}`), v => v.request.state === 'completed');
    const attemptDir = readFileSync(tmpFile, 'utf8');
    assert.ok(existsSync(join(attemptDir, 'scratch')), 'a completed response alone is not group-exit proof');
    uncertain = false;
    await until(() => existsSync(attemptDir), exists => !exists);
    assert.equal((await call('GET', `/v1/requests/${request.id}`)).request.state, 'completed', 'cleanup never replays the job');
  } finally {
    uncertain = false;
    probe.mock.restore();
    await pipe?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

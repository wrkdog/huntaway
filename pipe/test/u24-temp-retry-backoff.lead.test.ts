/**
 * Acceptance grader: cleanup must back off, log once, and never spawn git for a worktree whose
 * repository is gone (lead-authored; the builder must not edit it).
 *
 * Why. On 2026-10-08 the live pipe retried four undeletable temp folders on every 1 s tick, forever, writing
 * 1.6 million "remove attempt temp folder" lines a day into a 928 MB log, while its hourly prune ran
 * `git rev-parse` 10,000 times a day against worktrees whose lane folders had been deleted. The disk saturated
 * and the pipe's own `git worktree add` timed out. The folders were undeletable because a test fixture left a
 * read-only directory inside them.
 *
 * Interface the builder must provide (src/disk.ts, all exported):
 * - `TEMP_RETRY_DELAYS_MS: readonly number[]` = [60_000, 600_000, 3_600_000] and
 *   `tempRetryDelayMs(failures: number): number`: the delay before the next try after the Nth failed removal
 *   (1 → 1 min, 2 → 10 min, 3 or more → 1 hour).
 * - `class TempRetryQueue` with `add(id, groupGone)`, `due(now?)` (entries whose next try is at or before
 *   `now`, default Date.now()), `notYet(id)` (the runner group may still live: due again on the next tick),
 *   `failed(id, now?)` → `{ failures, firstFailure, parked }` (`parked` becomes true once at the hourly
 *   stage), `removed(id)`, `has(id)` and `size`.
 * - `pruneWorktrees(...)` keeps its signature. When a record's `cwd` is set and that folder no longer exists,
 *   the worktree is kept with a reason that starts `repository folder missing`, no git process is spawned for
 *   it, and `log('prune worktree <id>', …)` is written once per request id for the life of the process, not
 *   once per prune pass. Nothing is deleted: a later owner decision may remove such worktrees.
 * - src/service.ts: the pending-temp map becomes a `TempRetryQueue`; the tick retries only `due()` entries;
 *   a removal that throws calls `failed()`, a `groupGone() === false` calls `notYet()`. The fixed line
 *   `remove attempt temp folder` is logged only when `firstFailure` is true; one `temp folder removal parked`
 *   line is logged when `parked` first becomes true. Startup cleanup (`cleanEndedTemps`) routes its failures
 *   through the same queue.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneWorktrees } from '../src/disk.ts';
import { startPipe } from '../src/service.ts';
import { Store, type DispatchEvidence } from '../src/store.ts';
import type { AccountConfig } from '../src/identity.ts';

const root = () => realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pipe-u24-')));
const quiet = (_where: string, _error: unknown) => {};
// The new exports are read at test time, so a missing export fails only the tests that need it.
const disk = async () => await import('../src/disk.ts') as Record<string, any>;

test('T1 the retry delay grows: 1 minute, 10 minutes, then 1 hour for every later failure', async () => {
  const d = await disk();
  assert.equal(typeof d.tempRetryDelayMs, 'function', 'the builder exports tempRetryDelayMs');
  assert.deepEqual([...d.TEMP_RETRY_DELAYS_MS], [60_000, 600_000, 3_600_000]);
  assert.equal(d.tempRetryDelayMs(1), 60_000);
  assert.equal(d.tempRetryDelayMs(2), 600_000);
  assert.equal(d.tempRetryDelayMs(3), 3_600_000);
  assert.equal(d.tempRetryDelayMs(40), 3_600_000, 'the hourly stage is the ceiling');
});

test('T2 a failing folder is retried on the schedule, logged as a first failure once, and parked at the hourly stage', async () => {
  const d = await disk();
  assert.equal(typeof d.TempRetryQueue, 'function', 'the builder exports TempRetryQueue');
  const q = new d.TempRetryQueue();
  const t0 = 1_000_000_000_000;
  q.add('a', () => true);
  assert.deepEqual(q.due(t0).map((e: { id: string }) => e.id), ['a'], 'a new entry is due at once');
  const f1 = q.failed('a', t0);
  assert.deepEqual([f1.failures, f1.firstFailure, f1.parked], [1, true, false]);
  assert.deepEqual(q.due(t0 + 59_999), [], 'not due again inside the first minute');
  assert.deepEqual(q.due(t0 + 60_000).map((e: { id: string }) => e.id), ['a']);
  const f2 = q.failed('a', t0 + 60_000);
  assert.deepEqual([f2.failures, f2.firstFailure, f2.parked], [2, false, false]);
  assert.deepEqual(q.due(t0 + 60_000 + 599_999), []);
  assert.deepEqual(q.due(t0 + 60_000 + 600_000).map((e: { id: string }) => e.id), ['a']);
  const f3 = q.failed('a', t0 + 660_000);
  assert.deepEqual([f3.failures, f3.firstFailure, f3.parked], [3, false, true], 'the third failure parks it');
  const f4 = q.failed('a', t0 + 660_000 + 3_600_000);
  assert.equal(f4.parked, false, 'parked is reported once, not on every later failure');
  assert.deepEqual(q.due(t0 + 660_000 + 3_600_000 + 3_599_999), [], 'then hourly');
  assert.equal(q.size, 1);
  q.removed('a');
  assert.equal(q.has('a'), false);
  assert.equal(q.size, 0);
});

test('T3 a folder whose runner group may still live is due again on the next tick, and removal clears it', async () => {
  const d = await disk();
  const q = new d.TempRetryQueue();
  const t0 = 2_000_000_000_000;
  q.add('b', () => false);
  assert.deepEqual(q.due(t0).map((e: { id: string }) => e.id), ['b']);
  q.notYet('b');
  assert.deepEqual(q.due(t0 + 1).map((e: { id: string }) => e.id), ['b'], 'waiting for exit proof is not a failure');
  q.removed('b');
  assert.deepEqual(q.due(t0 + 2), []);
});

function fakeGit(home: string): { env: Record<string, string | undefined>; calls: string } {
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const calls = join(home, 'git-calls');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, calls };
}

function finishedWorktree(home: string, repo: string, wtRoot: string): Store {
  const store = new Store(join(home, 'pipe.sqlite'));
  const loginDir = join(home, 'login');
  mkdirSync(loginDir);
  const account: AccountConfig = { id: 'codex-a', provider: 'codex', loginDir,
    fingerprint: 'test-fingerprint', maxConcurrency: 1, enabled: true };
  const request = store.submit({ requester: 'grader', project: 'prune', kind: 'code', provider: 'codex',
    model: 'gpt-6-astra', effort: 'high', reason: 'test prune without git', prompt: 'change nothing',
    mutating: true, priority: 'background', cwd: repo });
  const evidence: DispatchEvidence = { accountId: account.id, model: 'gpt-6-astra', observedAt: new Date().toISOString(),
    verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] };
  const started = store.startAttempt(request.id, account, evidence);
  assert.equal(started.ok, true, JSON.stringify(started));
  const path = join(wtRoot, request.id);
  mkdirSync(path, { recursive: true });
  store.finishAttempt(started.attempt.id, { kind: 'completed', result: 'done',
    workspace: { path, branch: `pipe/${request.id}`, commit: 'a'.repeat(40), saved: 'not_saved' } });
  return store;
}

test('T4 prune spawns no git for a worktree whose repository folder is gone, keeps it, and logs once per process', async () => {
  const home = root();
  try {
    const repo = join(home, 'repo'); mkdirSync(repo);
    const wtRoot = join(home, 'worktrees'); mkdirSync(wtRoot);
    const store = finishedWorktree(home, repo, wtRoot);
    rmSync(repo, { recursive: true, force: true });   // the lane folder was deleted after the job finished
    const { env, calls } = fakeGit(home);
    const seen: string[] = [];
    const log = (where: string, _e: unknown) => { seen.push(where); };
    const first = await pruneWorktrees(store, wtRoot, 0, log, () => true, undefined, env);
    const second = await pruneWorktrees(store, wtRoot, 0, log, () => true, undefined, env);
    assert.equal(existsSync(calls), false, `no git process may run for a missing repository (ran: ${existsSync(calls) ? readFileSync(calls, 'utf8') : ''})`);
    assert.equal(first.removed.length + second.removed.length, 0, 'nothing is deleted');
    assert.equal(first.failed.length + second.failed.length, 0, 'a missing repository is a kept worktree, not a failure');
    assert.equal(first.kept.length, 1);
    assert.match(first.kept[0]!.reason, /^repository folder missing/);
    assert.equal(seen.length, 1, 'logged once for the life of the process, not once per prune pass');
    assert.match(seen[0]!, /^prune worktree /);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('T5 the service logs an undeletable temp folder once and stops retrying it every tick', async (t) => {
  const home = root();
  const at = join(home, 'tmp');
  const loginDir = join(home, 'login');
  mkdirSync(loginDir);
  const tmpFile = join(home, 'runner-tmp');
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/u4/${name}.json`, import.meta.url), 'utf8')).stdout;
  const cli = join(home, 'fake-claude');
  // The fake CLI leaves a read-only directory inside its TMPDIR, as the 2026-10-07 test fixture did.
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') process.stdout.write(${JSON.stringify(fixture('claude-version'))});
else if (args[0] === 'auth') process.stdout.write(JSON.stringify(${JSON.stringify(fixture('claude-auth-status.signed-in'))}));
else if (args[0] === '-p' && args[1] === '/usage') {
  const usage = ${JSON.stringify(fixture('claude-usage.signed-in'))};
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(Date.now() + 3_600_000)).map(p => [p.type, p.value]));
  const reset = parts.month + ' ' + parts.day + ' at ' + parts.hour + ':' + parts.minute + parts.dayPeriod.toLowerCase();
  usage.result = usage.result.replace(/resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m/g, 'resets ' + reset);
  process.stdout.write(JSON.stringify(usage));
} else {
  fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(tmpFile)}, process.env.TMPDIR);
  const locked = path.join(process.env.TMPDIR, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'fixture'), 'left behind');
  fs.chmodSync(locked, 0o555);
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 'synthetic' }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }));
}
`);
  chmodSync(cli, 0o755);
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  const spy = t.mock.method(process.stderr, 'write', (chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.includes('remove attempt temp folder') || text.includes('temp folder removal parked')) lines.push(text.trim());
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
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
      minFreeGb: 0, worktreeKeepHours: 24, pruneIntervalMs: 600000 });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(pipe!.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.ok(res.ok, `${method} ${path}: ${res.status}`);
      return res.json() as Promise<any>;
    };
    const { request } = await call('POST', '/v1/requests', { requester: 'grader', project: 'pipe', kind: 'chat',
      provider: 'claude', model: 'opus', effort: 'high', prompt: 'synthetic task', reason: 'retry back-off test',
      mutating: false, priority: 'interactive' });
    await until(() => call('GET', `/v1/requests/${request.id}`), v => v.request.state === 'completed');
    const attemptDir = readFileSync(tmpFile, 'utf8');
    await until(() => lines.length, n => n >= 1);               // the first failure is logged
    await new Promise(resolve => setTimeout(resolve, 3000));     // 60 ticks at 50 ms
    assert.ok(existsSync(attemptDir), 'the undeletable folder is kept, not lost');
    assert.equal(lines.filter(l => l.includes('remove attempt temp folder')).length, 1,
      `one first-failure line, not one per tick (saw ${lines.length} lines in 3 s)`);
    assert.ok(lines.length <= 2, 'at most a first-failure line and a parked line');
    assert.equal((await call('GET', `/v1/requests/${request.id}`)).request.state, 'completed', 'cleanup never replays the job');
  } finally {
    spy.mock.restore();
    await pipe?.stop();
    for (const sub of ['locked']) { try { chmodSync(join(readFileSync(tmpFile, 'utf8'), sub), 0o755); } catch { /* already gone */ } }
    rmSync(home, { recursive: true, force: true });
  }
});

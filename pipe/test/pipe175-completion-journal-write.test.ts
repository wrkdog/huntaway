/**
 * Additive actual-completion journalWrite prerequisite.
 * Contract: c60ddc38f7ea05ba25c4c4b6454d350e270db6cebf8460476553cb7ba0ee0732.
 * Fixture transport copied from u16-tmp-cleanup.lead.test.ts (not imported: that
 * file registers unrelated tests). No helper-only persistence invocation.
 * Required interface: optional PipeConfig.journalWrite, forwarded unchanged to
 * persistCompletedOutcome in execute; omission preserves the existing writer.
 *
 * Separate downstream obligations, NOT tests/proof supplied by this prerequisite:
 * D1 FIRST_REFUSAL: first terminal refusal wins over observer/reserve/abort errors.
 * D2 DURABLE_ACK: independently fail file/directory sync, observe recovery ACK;
 * readable bytes alone never acknowledge durability. A synced alternative must bind
 * the exact request/attempt/owner. Here we check the existing alternative's bytes
 * and record binding, not its fsync calls or the internal journaled ACK set.
 * D3 CLOSURE: independently keep process/group/streams unknown and inspect
 * pending ownership. Here only group proof is denied, with actual scratch registration.
 * D4 OWN_WATCHDOG: observe product watchdog settlement before caller teardown;
 * needs an independently observable deadline/settlement seam. until() below is only
 * a test failure deadline, NEVER product-watchdog or process-closure evidence.
 * No broad-contract pass may be inferred from these two prerequisite checks.
 *
 * Run on owner host: node --test test/pipe175-completion-journal-write.test.ts
 * Requires Node >=22.18, ephemeral 127.0.0.1 bind, owned temporary filesystem,
 * synthetic Node child execution and the existing runner's owned-process proof.
 * A failed loopback gate is SETUP_MISSING/UNRUN, never RED/PASS or a skip.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempRetryQueue } from '../src/disk.ts';
import { journalOf, startPipe, type PipeConfig } from '../src/service.ts';
import { Store, type Attempt, type AttemptOutcome } from '../src/store.ts';

type JournalWrite = (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
// Structural extension lets the baseline execute and fail at callback delivery,
// rather than mistaking a missing type member for the intended runtime RED.
type ProposedConfig = PipeConfig & { journalWrite?: JournalWrite };
const token = 'journal-synthetic-not-a-credential-0123456789';
async function until<T>(get: () => T | Promise<T>, ok: (value: T) => boolean): Promise<T> {
  const end = performance.now() + 20_000;
  for (;;) {
    const value = await get();
    if (ok(value)) return value;
    assert.ok(performance.now() < end, 'FIXTURE_UNSETTLED: not evidence of the journalWrite prerequisite');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function lifecycle(t: TestContext, inject: boolean) {
  const home = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'journal-write-')));
  t.diagnostic(`Owned synthetic evidence retained at ${home}; teardown is not closure proof`);
  const at = join(home, 'tmp'), storePath = join(home, 'pipe.sqlite');
  const loginDir = join(home, 'login');
  mkdirSync(loginDir);
  mkdirSync(join(home, 'worktrees'));
  const pidFile = join(home, 'runner-pid'), tmpFile = join(home, 'runner-tmp');
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/u4/${name}.json`, import.meta.url), 'utf8')).stdout;
  const cli = join(home, 'fake-claude');
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
  let deniedGroupProbes = 0;
  const probe = t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal === 0 && existsSync(pidFile) && pid === -Number(readFileSync(pidFile, 'utf8'))) {
      deniedGroupProbes++;
      throw Object.assign(new Error('synthetic unknown group closure'), { code: 'EPERM' });
    }
    return realKill(pid, signal);
  });
  let requestId = '', rejectedWrites = 0;
  const originalFinish = Store.prototype.finishAttempt;
  const storeFault = t.mock.method(Store.prototype, 'finishAttempt', function (this: Store, id: string, outcome: AttemptOutcome) {
    if (requestId && this.attempts(requestId).some(a => a.id === id)) {
      rejectedWrites++;
      assert.equal(outcome.kind, 'completed', 'the real runner must produce completion before persistence');
      throw new Error('journal test: owned store unavailable');
    }
    return originalFinish.call(this, id, outcome);
  });
  let registration: { queue: TempRetryQueue; id: string; groupGone: () => boolean } | undefined;
  const originalAdd = TempRetryQueue.prototype.add;
  const registered = t.mock.method(TempRetryQueue.prototype, 'add', function (this: TempRetryQueue, id: string, groupGone: () => boolean) {
    originalAdd.call(this, id, groupGone);
    if (existsSync(join(at, id, 'scratch'))) registration = { queue: this, id, groupGone };
  });
  const writeRefusal = new Error('journal test: readable journal bytes are not a successful write');
  let delivered = 0, readableBeforeRefusal = '', deliveredBytes = '';
  const journalWrite: JournalWrite = (fd, bytes, offset, length) => {
    delivered++;
    deliveredBytes = Buffer.from(bytes).toString('utf8');
    // Real bytes reach the owned journal; deliberately no successful return or sync.
    writeSync(fd, bytes, offset, length);
    readableBeforeRefusal = readFileSync(journalOf(storePath), 'utf8');
    throw writeRefusal;
  };
  let pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  let record: Store | undefined;
  try {
    const config: ProposedConfig = {
      accounts: [{ id: 'claude-a', provider: 'claude', loginDir,
        fingerprint: createHash('sha256').update('<orgId>').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true }],
      policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      storePath, worktreeRoot: join(home, 'worktrees'), tmpRoot: at, workDir: home,
      cli: { claude: cli }, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
      reachable: async () => true, token, port: 0, tickMs: 50, probeIntervalMs: 60000,
      minFreeGb: 0, worktreeKeepHours: 24, pruneIntervalMs: 60000,
      ...(inject ? { journalWrite } : {}),
    };
    pipe = await startPipe(config);
    const res = await fetch(`${pipe.url}/v1/requests`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requester: 'journal-test', project: 'journal-write', kind: 'chat',
        provider: 'claude', model: 'opus', effort: 'high', prompt: 'synthetic task',
        reason: 'actual completion journal propagation', mutating: false, priority: 'interactive', pin: 'claude-a' }),
    });
    assert.equal(res.ok, true, `synthetic admission: ${res.status}`);
    const body = await res.json() as { request: { id: string } };
    requestId = body.request.id;
    record = new Store(storePath);
    const owned = await until(() => registration, value => value !== undefined);
    assert.ok(owned);
    const attempts = record.attempts(requestId);
    assert.equal(attempts.length, 1, 'one actual lifecycle, no retry history reset');
    const attempt: Attempt = attempts[0]!;
    assert.equal(owned.id, attempt.id);
    assert.equal(attempt.requestId, requestId);
    assert.equal(attempt.accountId, 'claude-a');
    assert.ok(attempt.runner, 'actual runner ownership is recorded');
    assert.equal(attempt.runner.pid, Number(readFileSync(pidFile, 'utf8')));
    assert.ok(attempt.runner.startedAt);
    assert.equal(attempt.closedAt ?? null, null, 'group uncertainty must not become a closure ACK');
    assert.ok(rejectedWrites > 0, 'actual completion reached the failing store');
    assert.equal(attempt.endedAt, null, 'unsaved outcome retains its open attempt');
    assert.equal(record.get(requestId)?.state, 'running');
    assert.equal(owned.queue.has(attempt.id), true, 'scratch remains registered for retry');
    assert.equal(owned.groupGone(), false);
    assert.ok(deniedGroupProbes > 0);
    assert.equal(readFileSync(tmpFile, 'utf8'), join(at, attempt.id));
    assert.equal(readFileSync(join(at, attempt.id, 'scratch'), 'utf8'), 'still owned');
    const recovery = `${storePath}.pipe-outcome-${createHash('sha256').update(attempt.id).digest('hex')}`;
    const expected = { attemptId: attempt.id, outcome: { kind: 'completed', result: 'OK' } };
    if (inject) {
      // Baseline intended-cause failure: config is ignored, despite real completion.
      assert.equal(delivered, 1, 'J1: actual execute completion must receive PipeConfig.journalWrite');
      assert.deepEqual(JSON.parse(deliveredBytes), expected);
      assert.deepEqual(JSON.parse(readableBeforeRefusal), expected, 'readable bytes existed before refusal');
      assert.equal(readFileSync(journalOf(storePath), 'utf8'), '', 'failed write is rolled back, not acknowledged as the journal');
      assert.deepEqual(JSON.parse(readFileSync(recovery, 'utf8')), expected, 'write refusal requires the separate recovery alternative');
      assert.equal(statSync(recovery).mode & 0o777, 0o600);
    } else {
      assert.equal(delivered, 0);
      assert.equal(Object.hasOwn(config, 'journalWrite'), false, 'control omits the option entirely');
      assert.deepEqual(JSON.parse(readFileSync(journalOf(storePath), 'utf8')), expected);
      assert.equal(existsSync(recovery), false, 'default journal success needs no alternative');
    }
    // Actual pending replay, still with unknown group closure. This is before stop.
    const ownerBeforeReplay = attempt.runner;
    storeFault.mock.restore();
    await until(() => record!.get(requestId)?.state, value => value === 'completed');
    const after = record.attempts(requestId);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, attempt.id);
    assert.deepEqual(after[0]!.runner, ownerBeforeReplay);
    assert.deepEqual(after[0]!.outcome, expected.outcome);
    assert.equal(after[0]!.closedAt ?? null, null);
    assert.equal(owned.queue.has(attempt.id), true);
    assert.equal(readFileSync(join(at, attempt.id, 'scratch'), 'utf8'), 'still owned');
  } finally {
    // Caller teardown is deliberately after all evidence. Never rm scratch or
    // manufacture ESRCH by toggling the uncertainty flag as a passing assertion.
    storeFault.mock.restore();
    record?.close();
    try { await pipe?.stop(); }
    finally { registered.mock.restore(); probe.mock.restore(); }
  }
}

test('actual-completion journalWrite prerequisite', async t => {
  // Gate once, before HOME, store, fake CLI or either lifecycle. A denied host
  // stops this execution; neither subtest is skipped or retried in another profile.
  const gate = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      gate.once('error', reject);
      gate.listen(0, '127.0.0.1', resolve);
    });
  } catch (cause) {
    throw new Error('SETUP_MISSING/UNRUN: ephemeral loopback unavailable; no completion assertion ran', { cause });
  } finally {
    if (gate.listening) await new Promise<void>((resolve, reject) => gate.close(e => e ? reject(e) : resolve()));
  }
  await t.test('J0 omitted journalWrite preserves actual completion journal and retained owner', t => lifecycle(t, false));
  await t.test('J1 actual completion receives journalWrite refusal after readable bytes', t => lifecycle(t, true));
});

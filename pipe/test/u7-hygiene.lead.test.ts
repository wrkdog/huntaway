/**
 * Acceptance grader, lane U7: hygiene (lead-authored; the implementation lane must not edit it).
 *
 * A request whose cwd is missing, or is not a directory, is refused at submit.
 * A failed `--version` is not a version; a limit hit with `observedAt: undefined` is accepted.
 * Under the rule that temporary events are never marked permanent, a restart
 * never marks a request against the account it was running on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPipe } from '../src/service.ts';
import { Store, type DispatchEvidence } from '../src/store.ts';
import { AllowanceLedger } from '../src/allowance.ts';
import type { AccountConfig } from '../src/identity.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
const POLICY = {
  claude: { models: { opus: 'default', fable: 'hard', 'claude-opus-5-5': 'hard' }, efforts: ['low', 'medium', 'high', 'max'] },
  codex: { models: { 'gpt-6-sol': 'default', 'gpt-6-astra': 'hard' }, efforts: ['low', 'medium', 'high', 'ultra'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withModel = (jsonl: string, model: string) => jsonl.trim().split('\n').map((l) => {
  const o = JSON.parse(l); if (o.type === 'system' && o.subtype === 'init') o.model = model; return JSON.stringify(o);
}).join('\n') + '\n';

/** A fake `claude` answering the U4 probe captures and succeeding at every job; `versionExit` sets `--version`'s exit code. */
function fakeClaude(versionExit = 0): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u7-claude-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    version: u4('claude-version').stdout, versionExit, auth: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout,
    ok: withModel(readFileSync(new URL('claude-success.jsonl', FIX), 'utf8'), 'claude-opus-5-5'),
  }));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '--version') { process.stdout.write(sc.version); process.exitCode = sc.versionExit; }
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.auth));
else if (a[0] === '-p' && a[1] === '/usage') {
  const at = (ms) => { const q = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return q.month + ' ' + q.day + ' at ' + q.hour + ':' + q.minute + q.dayPeriod.toLowerCase(); };
  const NL = String.fromCharCode(10), RESET = new RegExp('resets [A-Z][a-z]{2} [0-9]+ at [0-9]+(:[0-9]+)?[ap]m', 'u');
  const result = sc.usage.result.split(NL).map((l) => l.replace(RESET, 'resets ' + at(Date.now() + (l.startsWith('Current session') ? 3 : 96) * 3600000))).join(NL);
  process.stdout.write(JSON.stringify({ ...sc.usage, result }));
} else {
  try { fs.readFileSync(0); } catch {}
  const count = p.join(__dirname, 'jobs'); const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0; fs.writeFileSync(count, String(n + 1));
  process.stdout.write(sc.ok);
}
`);
  chmodSync(path, 0o755);
  return path;
}

function account(root: string): AccountConfig {
  const loginDir = join(root, 'login-claude-a');
  mkdirSync(loginDir, { recursive: true });
  return { id: 'claude-a', provider: 'claude', loginDir, fingerprint: sha8('<orgId>'), maxConcurrency: 1, enabled: true };
}

async function pipe(o: { root?: string; versionExit?: number } = {}) {
  const root = o.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u7-')));
  const fake = fakeClaude(o.versionExit ?? 0);
  const handle = await startPipe({
    accounts: [account(root)], policy: POLICY, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'),
    cli: { claude: fake }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${handle.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, any> : {} };
  };
  const jobsRun = () => { try { return Number(readFileSync(join(fake, '..', 'jobs'), 'utf8')); } catch { return 0; } };
  return { ...handle, call, jobsRun, root };
}
const ask = (over: Record<string, unknown> = {}) => ({ requester: 'dev-a', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high',
  reason: 'a routine check', prompt: 'say OK', mutating: false, priority: 'interactive', ...over });
async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await get(); if (ok(v)) return v; if (Date.now() > end) assert.fail(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`); await sleep(50); }
}

test('C1 a request whose cwd does not exist is refused at submit, and no attempt starts', async () => {
  const p = await pipe();
  try {
    const r = await p.call('POST', '/v1/requests', ask({ kind: 'code', cwd: join(p.root, 'no-such-folder') }));
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, /cwd/i);
    await sleep(500);
    assert.equal(p.jobsRun(), 0);
  } finally { await p.stop(); }
});

test('C2 a request whose cwd is a file, not a directory, is refused at submit', async () => {
  const p = await pipe();
  try {
    const file = join(p.root, 'a-file.txt');
    writeFileSync(file, 'x');
    const r = await p.call('POST', '/v1/requests', ask({ kind: 'code', cwd: file }));
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, /cwd/i);
    const ok = await p.call('POST', '/v1/requests', ask({ kind: 'code', cwd: p.root }));
    assert.equal(ok.status, 201, `an existing directory is still accepted: ${ok.text}`);
  } finally { await p.stop(); }
});

test('V1 a `--version` that exits non-zero is not reported as a version', async () => {
  const p = await pipe({ versionExit: 1 });
  try {
    const r = await until('the first probe', () => p.call('GET', '/v1/accounts'), (x) => x.json.accounts?.[0]?.version?.state !== undefined);
    const version = r.json.accounts[0].version;
    assert.equal(version.state, 'unknown', JSON.stringify(version));
  } finally { await p.stop(); }
});

test('L1 a limit hit with an explicit `observedAt: undefined` is accepted and holds', () => {
  const ledger = new AllowanceLedger({ freshnessMs: 60_000 });
  assert.doesNotThrow(() => ledger.recordLimit('claude-a', { bucket: null, model: null, resetsAt: null, observedAt: undefined }));
  assert.equal(ledger.limitHolds('claude-a').length, 1);
});

test('R1 a restart never marks a request against the account it was running on', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u7-restart-')));
  const acct = account(root);
  // A pipe that stopped hard mid-attempt: the request has an open attempt and no outcome.
  const store = new Store(join(root, 'pipe.sqlite'));
  const made = store.submit(ask() as Parameters<Store['submit']>[0]);
  const evidence: DispatchEvidence = { accountId: acct.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] };
  const started = store.startAttempt(made.id, acct, evidence);
  assert.equal(started.ok, true, JSON.stringify(started));
  if (!started.ok) return;
  // Its runner had started: a real process group that is gone by the time the next pipe looks.
  const gone = spawnSync('/usr/bin/true').pid!;
  store.noteMayStart(started.attempt.id);
  store.noteRunner(started.attempt.id, { pid: gone, startedAt: `unverified:${new Date().toISOString()}` });
  store.close();
  // The next pipe reconciles that attempt, then runs the request again on the only account it has.
  const p = await pipe({ root });
  try {
    const done = await until('the request to finish', () => p.call('GET', `/v1/requests/${made.id}`),
      (r) => ['completed', 'failed', 'cancelled'].includes(r.json.request?.state));
    assert.equal(done.json.request.state, 'completed', done.text);
    assert.ok(!JSON.stringify(done.json.request.avoid ?? []).includes('claude-a'), 'the restart left no mark');
  } finally { await p.stop(); }
});


// ---- Round 3 (Sol on 1f2510b): the store guards cwd too, and a cwd that vanishes while queued fails once, never loops --

test('C3 the store itself refuses a request whose cwd does not exist', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u7-store-')));
  const store = new Store(join(root, 'pipe.sqlite'));
  try {
    assert.throws(() => store.submit(ask({ kind: 'code', cwd: join(root, 'no-such-folder') }) as Parameters<Store['submit']>[0]), /cwd/i);
    const file = join(root, 'a-file.txt');
    writeFileSync(file, 'x');
    assert.throws(() => store.submit(ask({ kind: 'code', cwd: file }) as Parameters<Store['submit']>[0]), /cwd/i);
    assert.doesNotThrow(() => store.submit(ask({ kind: 'code', cwd: root }) as Parameters<Store['submit']>[0]));
  } finally { store.close(); }
});

test('C4 a queued request whose cwd has vanished is failed at claim, naming the cwd, and is never claimed again', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u7-vanish-')));
  const gone = join(root, 'work');
  mkdirSync(gone);
  const acct = account(root);
  const store = new Store(join(root, 'pipe.sqlite'));
  try {
    const made = store.submit(ask({ kind: 'code', cwd: gone }) as Parameters<Store['submit']>[0]);
    rmSync(gone, { recursive: true });
    const evidence: DispatchEvidence = { accountId: acct.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Grep', 'Glob'] };
    const claim = store.startAttempt(made.id, acct, evidence);
    assert.equal(claim.ok, false, 'no attempt starts in a folder that is gone');
    const after = store.get(made.id)!;
    assert.equal(after.state, 'failed', 'the request ends, so the planner cannot loop on it');
    assert.match(JSON.stringify(after.error ?? ''), new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(store.attempts(made.id).length, 0);
  } finally { store.close(); }
});

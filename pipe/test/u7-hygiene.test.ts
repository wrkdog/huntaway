import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { probeAccount } from '../src/probe.ts';
import { run } from '../src/runner.ts';
import { claimRecord, recover, journalOf, recheckHeld } from '../src/service.ts';
import { Store, type NewRequest } from '../src/store.ts';

const root = () => mkdtempSync(join(tmpdir(), 'pipe-u7-local-'));
const account = { id: 'claude-a', provider: 'claude' as const, loginDir: '/tmp', fingerprint: 'owner', maxConcurrency: 1, enabled: true };
const request: NewRequest = { requester: 'dev', project: 'pipe', kind: 'chat', provider: 'claude', model: 'opus', effort: 'high', reason: 'check', prompt: 'OK', mutating: false, priority: 'interactive' };

test('claimRecord refuses, clearly, a file system without hard links', () => {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const original = fs.linkSync;
  try {
    for (const code of ['ENOTSUP', 'EOPNOTSUPP']) {
      fs.linkSync = () => { throw Object.assign(new Error('hard links unsupported'), { code }); };
      syncBuiltinESMExports();
      assert.throws(() => claimRecord(join(root(), 'pipe.sqlite')), /needs a file system with hard links/);
    }
  } finally { fs.linkSync = original; syncBuiltinESMExports(); }
});

test('a failed version command cannot publish its printed version', async () => {
  const dir = root(), cli = join(dir, 'claude');
  writeFileSync(cli, `#!${process.execPath}\nif (process.argv[2] === '--version') { console.log('2.1.280'); process.exitCode = 1; }\n`);
  chmodSync(cli, 0o755);
  const report = await probeAccount({ ...account, loginDir: dir }, { cli: { claude: cli }, timeoutMs: 1000, reachable: async () => false });
  assert.equal(report.version.state, 'unknown');
});

test('a spawn ENOENT caused by a missing cwd names the cwd', async () => {
  const cwd = join(root(), 'missing');
  const events = [];
  for await (const event of run({ requestId: 'r', accountId: account.id, provider: 'claude', model: 'opus', effort: 'high', prompt: 'OK', mutating: false, cwd, loginDir: '/tmp' },
    { cli: { claude: process.execPath } })) events.push(event);
  const failure = events.find((event) => event.type === 'failed');
  assert.equal(failure?.type, 'failed');
  if (failure?.type === 'failed') assert.match(failure.message, new RegExp(cwd));
});

test('a cwd lost after claim leaves one recorded attempt and a failed request', async () => {
  const dir = root(), store = new Store(join(dir, 'pipe.sqlite'));
  const cwd = root();
  try {
    const made = store.submit({ ...request, kind: 'code', cwd });
    const started = store.startAttempt(made.id, account, { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    rmSync(cwd, { recursive: true });
    const events = [];
    for await (const event of run({ requestId: made.id, accountId: account.id, provider: 'claude', model: 'opus', effort: 'high', prompt: 'OK', mutating: false, cwd, loginDir: '/tmp' },
      { cli: { claude: process.execPath } })) events.push(event);
    const failure = events.find((event) => event.type === 'failed');
    assert.equal(failure?.type, 'failed');
    if (failure?.type !== 'failed') return;
    assert.equal(failure.errorKind, 'other');
    store.finishAttempt(started.attempt.id, { kind: 'failed', errorKind: 'other', message: failure.message });
    assert.equal(store.get(made.id)?.state, 'failed');
    assert.match(store.get(made.id)?.error?.message ?? '', /cwd/);
    assert.equal(store.attempts(made.id).length, 1);
    assert.equal(store.startAttempt(made.id, account, { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] }).ok, false);
  } finally { store.close(); }
});

test('startup reconciliation requeues a started read-only attempt on the same account', async () => {
  const path = join(root(), 'pipe.sqlite'), store = new Store(path);
  try {
    const made = store.submit(request);
    const started = store.startAttempt(made.id, account, { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.noteMayStart(started.attempt.id);
    await recover(store, journalOf(path), () => {});
    assert.equal(store.get(made.id)?.state, 'queued');
    assert.deepEqual(store.get(made.id)?.avoid, []);
    assert.equal(store.startAttempt(made.id, account, { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] }).ok, true);
  } finally { store.close(); }
});

test('a held runner proved gone requeues without avoiding its account', async () => {
  const store = new Store(join(root(), 'pipe.sqlite'));
  try {
    const made = store.submit(request);
    const evidence = { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available' as const, headroom: 0.5 }, grant: ['Read'] };
    const started = store.startAttempt(made.id, account, evidence);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.noteMayStart(started.attempt.id);
    const held = new Map([[started.attempt.id, { pid: 99999999, startedAt: 'unverified:gone' }]]);
    await recheckHeld(store, held, () => {});
    assert.equal(held.size, 0);
    assert.equal(store.get(made.id)?.state, 'queued');
    assert.deepEqual(store.get(made.id)?.avoid, []);
  } finally { store.close(); }
});

test('restart reconciliation still fails changing work with inspection guidance', async () => {
  const path = join(root(), 'pipe.sqlite'), store = new Store(path);
  try {
    const made = store.submit({ ...request, mutating: true, cwd: '/tmp' });
    const started = store.startAttempt(made.id, account, { accountId: account.id, model: 'opus', observedAt: new Date().toISOString(), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read', 'Edit'] });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    store.noteMayStart(started.attempt.id);
    await recover(store, journalOf(path), () => {});
    assert.equal(store.get(made.id)?.state, 'failed');
    assert.match(store.get(made.id)?.error?.message ?? '', /inspect the work/);
  } finally { store.close(); }
});

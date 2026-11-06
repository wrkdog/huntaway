// READ-CONTRACT-01 step 2c: service.version and the prober's counters on /v1/health.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { health } from '../src/cards.ts';
import { releaseVersion } from '../src/cli.ts';
import { startPipe } from '../src/service.ts';

// ── 1. health() alone ──────────────────────────────────────────────────────────

test('health() alone: prints version, lastProbeAt and consecutiveProbeFailures as given; null when not set', () => {
  const accountWithStats = {
    alias: 'Claude · Main', provider: 'claude', enabled: true, running: 0,
    identity: { accountId: 'a1', signedIn: true, fingerprint: 'fp1', observedAt: '2026-09-30T10:00:00.000Z' },
    allowance: { state: 'ok' as const, accountId: 'a1', headroom: 0.5, binding: 'weekly' },
    lastProbeAt: '2026-09-30T10:01:00.000Z',
    consecutiveProbeFailures: 3,
  };
  const accountWithoutStats = {
    alias: 'Codex · Primary', provider: 'codex', enabled: true, running: 0,
    identity: null,
    allowance: { state: 'unknown' as const, accountId: 'a2', reason: 'unprobed' },
  };

  // prints version as given, stats as given, and null when not set
  const res1 = health({
    version: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    startedAt: '2026-09-30T10:00:00.000Z',
    clockCurrent: true,
    draining: false,
    accounts: [accountWithStats, accountWithoutStats],
  });
  assert.equal(res1.service.version, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(res1.accounts[0]!.lastProbeAt, '2026-09-30T10:01:00.000Z');
  assert.equal(res1.accounts[0]!.consecutiveProbeFailures, 3);
  assert.equal(res1.accounts[1]!.lastProbeAt, null);
  assert.equal(res1.accounts[1]!.consecutiveProbeFailures, null);

  // version is null when given as null
  const res2 = health({
    version: null,
    startedAt: '2026-09-30T10:00:00.000Z',
    clockCurrent: true,
    draining: false,
    accounts: [{
      alias: 'Claude · Main', provider: 'claude', enabled: true, running: 0,
      identity: null,
      allowance: { state: 'unknown' as const, accountId: 'a1', reason: 'unprobed' },
      lastProbeAt: null,
      consecutiveProbeFailures: null,
    }],
  });
  assert.equal(res2.service.version, null);
  assert.equal(res2.accounts[0]!.lastProbeAt, null);
  assert.equal(res2.accounts[0]!.consecutiveProbeFailures, null);

  // version is null when omitted
  const res3 = health({
    startedAt: '2026-09-30T10:00:00.000Z',
    clockCurrent: true,
    draining: false,
    accounts: [],
  });
  assert.equal(res3.service.version, null);
});

// ── 2. releaseVersion ─────────────────────────────────────────────────────────

test('releaseVersion: reports commit in fresh repo, -dirty after modifying tracked file, clean with untracked file, null for non-repo, and ignores GIT_DIR', () => {
  const gitEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
  };

  const repoDir = mkdtempSync(join(tmpdir(), 'pipe-u23-git-'));
  execFileSync('git', ['init', repoDir], { env: gitEnv });
  const trackedFile = join(repoDir, 'tracked.txt');
  writeFileSync(trackedFile, 'initial content\n');
  execFileSync('git', ['-C', repoDir, 'add', 'tracked.txt'], { env: gitEnv });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'initial', '--no-gpg-sign'], { env: gitEnv });

  const commit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { env: gitEnv, encoding: 'utf8' }).trim();
  assert.equal(/^[0-9a-f]{40}$/.test(commit), true, 'commit is 40 hex chars');

  // in a fresh git repository with one commit, it gives that commit
  assert.equal(releaseVersion(repoDir), commit);

  // an untracked file alone does not make it dirty
  writeFileSync(join(repoDir, 'untracked.txt'), 'untracked content\n');
  assert.equal(releaseVersion(repoDir), commit);

  // after changing a tracked file, it gives <commit>-dirty
  writeFileSync(trackedFile, 'changed content\n');
  assert.equal(releaseVersion(repoDir), `${commit}-dirty`);

  // a folder that is not a repository gives null
  const nonRepoDir = mkdtempSync(join(tmpdir(), 'pipe-u23-nonrepo-'));
  assert.equal(releaseVersion(nonRepoDir), null);

  // with GIT_DIR set in the test's own environment to another repository, it still reads the folder it was given
  const otherRepo = mkdtempSync(join(tmpdir(), 'pipe-u23-othergit-'));
  execFileSync('git', ['init', otherRepo], { env: gitEnv });
  writeFileSync(join(otherRepo, 'other.txt'), 'other content\n');
  execFileSync('git', ['-C', otherRepo, 'add', 'other.txt'], { env: gitEnv });
  execFileSync('git', ['-C', otherRepo, 'commit', '-m', 'other', '--no-gpg-sign'], { env: gitEnv });
  const otherCommit = execFileSync('git', ['-C', otherRepo, 'rev-parse', 'HEAD'], { env: gitEnv, encoding: 'utf8' }).trim();
  assert.notEqual(otherCommit, commit);

  const prevGitDir = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(otherRepo, '.git');
    assert.equal(releaseVersion(repoDir), `${commit}-dirty`);
  } finally {
    if (prevGitDir !== undefined) process.env.GIT_DIR = prevGitDir;
    else delete process.env.GIT_DIR;
  }
});

// ── 3. Through the service ───────────────────────────────────────────────────

const TOKEN = 'y'.repeat(32);
const HEADERS = { authorization: `Bearer ${TOKEN}` };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T> | T, accept: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() > end) throw new Error('condition did not arrive'); await pause(20); }
}

function serviceCli(root: string): string {
  const cli = join(root, 'claude');
  writeFileSync(cli, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') console.log('2.1.280');
else if (a[0] === 'auth') {
  if (fs.existsSync(p.join(__dirname, 'fail_auth'))) {
    process.exit(1);
  }
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', orgId: 'owner' }));
} else if (a[0] === '-p' && a[1] === '/usage') {
  const when = (h) => { const z = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(Date.now() + h * 3600000)).map((x) => [x.type, x.value])); return z.month + ' ' + z.day + ' at ' + z.hour + ':' + z.minute + z.dayPeriod.toLowerCase(); };
  console.log(JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result: 'Current session: 10% used · resets ' + when(3) + ' (America/New_York)\\nCurrent week (all models): 20% used · resets ' + when(96) + ' (America/New_York)' }));
} else {
  process.exit(0);
}
`);
  chmodSync(cli, 0o755);
  return cli;
}

async function startService(t: { skip(message: string): void }, cli: string, root: string, over: Record<string, unknown> = {}) {
  const account = { id: 'a', provider: 'claude' as const, loginDir: root, fingerprint: createHash('sha256').update('owner').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true };
  try {
    return await startPipe({
      accounts: [account],
      policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } },
      storePath: join(root, 'store.sqlite'),
      worktreeRoot: root,
      cli: { claude: cli },
      token: TOKEN,
      port: 0,
      reachable: async () => true,
      tickMs: 20,
      ...over,
    } as Parameters<typeof startPipe>[0]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('loopback bind unavailable'); return undefined; }
    throw e;
  }
}

test('service: /v1/health shows configured version, and after the first probe shows lastProbeAt and consecutiveProbeFailures: 0', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u23-svc-success-'));
  const cli = serviceCli(root);
  const pipe = await startService(t, cli, root, { version: '0123456789abcdef0123456789abcdef01234567' });
  if (!pipe) return;
  try {
    const res = await (await fetch(`${pipe.url}/v1/health`, { headers: HEADERS })).json() as Record<string, any>;
    assert.equal(res.service.version, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(res.accounts.length, 1);
    const acc = res.accounts[0];
    assert.equal(typeof acc.lastProbeAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(acc.lastProbeAt)));
    assert.equal(acc.consecutiveProbeFailures, 0);
  } finally {
    await pipe.stop();
  }
});

test('service: with a fake CLI whose probe fails, consecutiveProbeFailures rises and lastProbeAt moves', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u23-svc-fail-'));
  writeFileSync(join(root, 'fail_auth'), 'fail\n');
  const cli = serviceCli(root);
  // A full commit id: health publishes only those (owner finish), so free text such as 'v1.0.0-failing' shows null.
  const pipe = await startService(t, cli, root, { version: 'fedcba9876543210fedcba9876543210fedcba98', probeRetryMs: 50, probeIntervalMs: 50 });
  if (!pipe) return;
  try {
    const readHealth = async () => (await (await fetch(`${pipe.url}/v1/health`, { headers: HEADERS })).json()) as Record<string, any>;
    const first = await readHealth();
    assert.equal(first.service.version, 'fedcba9876543210fedcba9876543210fedcba98');
    const acc1 = first.accounts[0];
    assert.equal(typeof acc1.lastProbeAt, 'string');
    const t1 = acc1.lastProbeAt;
    assert.ok(acc1.consecutiveProbeFailures >= 1);
    const initialFailures = acc1.consecutiveProbeFailures;

    const updated = await until(readHealth, (h) => h.accounts[0].consecutiveProbeFailures > initialFailures);
    const acc2 = updated.accounts[0];
    assert.ok(acc2.consecutiveProbeFailures > initialFailures, 'counter rises');
    assert.notEqual(acc2.lastProbeAt, t1, 'lastProbeAt moves');
    assert.ok(new Date(acc2.lastProbeAt).getTime() > new Date(t1).getTime(), 'lastProbeAt advances');
  } finally {
    await pipe.stop();
  }
});

test('service: an account never probed shows null for lastProbeAt and consecutiveProbeFailures', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u23-svc-unprobed-'));
  const cli = serviceCli(root);
  // A Codex account with no Codex CLI configured is never probed; each account has a login folder of its own.
  const unprobedAccount = {
    id: 'codex-unprobed', provider: 'codex' as const, loginDir: mkdtempSync(join(tmpdir(), 'pipe-u23-codex-login-')),
    fingerprint: 'fp2', maxConcurrency: 1, enabled: true,
  };
  const pipe = await startService(t, cli, root, {
    accounts: [
      { id: 'a', provider: 'claude' as const, loginDir: root, fingerprint: createHash('sha256').update('owner').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true },
      unprobedAccount,
    ],
    // An empty PATH: the service finds no codex of its own on this machine, so that account is never probed.
    env: { PATH: mkdtempSync(join(tmpdir(), 'pipe-u23-empty-path-')), HOME: root },
  });
  if (!pipe) return;
  try {
    const res = await (await fetch(`${pipe.url}/v1/health`, { headers: HEADERS })).json() as Record<string, any>;
    const unprobed = res.accounts.find((a: any) => a.alias === 'codex-unprobed');
    assert.ok(unprobed);
    assert.equal(unprobed.lastProbeAt, null);
    assert.equal(unprobed.consecutiveProbeFailures, null);
  } finally {
    await pipe.stop();
  }
});

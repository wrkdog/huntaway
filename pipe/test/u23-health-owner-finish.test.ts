// READ-CONTRACT-01 step 2c, owner finish: releaseVersion reads only its own checkout and runs no repository code; serve
// ignores a configured version; the prober's counters move only while the service runs on a current clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { releaseVersion } from '../src/cli.ts';
import { startPipe } from '../src/service.ts';

// ── releaseVersion: git fixtures keep their metadata outside the work tree, as a pipe worktree does ─────────────────

function repo(t: { after(fn: () => void): void }, objectFormat?: 'sha256') {
  const base = mkdtempSync(join(tmpdir(), 'pipe-u23-owner-git-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Pipe Test', GIT_AUTHOR_EMAIL: 'pipe@example.com', GIT_COMMITTER_NAME: 'Pipe Test', GIT_COMMITTER_EMAIL: 'pipe@example.com' };
  const work = join(base, 'work');
  const git = (...args: string[]) => execFileSync('git', ['-C', work, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '--template=', ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
    `--separate-git-dir=${join(base, 'meta')}`, work], { env, stdio: 'ignore' });
  writeFileSync(join(work, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('commit', '-q', '--no-gpg-sign', '-m', 'one');
  return { base, work, git, commit: git('rev-parse', 'HEAD').trim() };
}

/** An executable that records each run in a marker file, then does what `body` says; quoted, since git runs it through a shell. */
function recorder(at: string, marker: string, body: string): string {
  const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
  writeFileSync(at, `#!/bin/sh\necho ran >> ${quote(marker)}\n${body}\n`);
  chmodSync(at, 0o755);
  return quote(at);
}

test('releaseVersion: only the checkout root itself has a release; a folder inside it does not inherit its commit', (t) => {
  const r = repo(t);
  const nested = join(r.work, 'nested', 'folder');
  mkdirSync(nested, { recursive: true });
  const link = join(r.base, 'link-to-work');
  symlinkSync(r.work, link);
  assert.equal(releaseVersion(r.work), r.commit);
  assert.equal(releaseVersion(link), r.commit, 'the same folder reached through a link is still the root');
  assert.equal(releaseVersion(nested), null, 'a folder inside a checkout is not that checkout');
  assert.equal(releaseVersion(join(r.work, 'nested')), null);
});

test('releaseVersion: a SHA-256 repository gives its 64-hex commit, -dirty only for a changed tracked file', (t) => {
  const r = repo(t, 'sha256');
  assert.match(r.commit, /^[0-9a-f]{64}$/);
  writeFileSync(join(r.work, 'untracked.txt'), 'new\n');
  assert.equal(releaseVersion(r.work), r.commit);
  writeFileSync(join(r.work, 'tracked.txt'), 'two\n');
  assert.equal(releaseVersion(r.work), `${r.commit}-dirty`);
});

test('releaseVersion: an fsmonitor hook that git status runs is never run', (t) => {
  const r = repo(t);
  const marker = join(r.base, 'fsmonitor-ran');
  r.git('config', 'core.fsmonitor', recorder(join(r.base, 'fsmonitor'), marker, 'exit 1'));
  assert.equal(releaseVersion(r.work), r.commit);
  assert.equal(existsSync(marker), false, 'releaseVersion ran the fsmonitor hook');
  r.git('status', '--porcelain');
  assert.equal(existsSync(marker), true, 'the fixture is admitted: plain git status runs this hook');
});

test('releaseVersion: a clean filter that git status runs is never run, and the file still reads as clean', (t) => {
  const r = repo(t);
  const marker = join(r.base, 'filter-ran');
  writeFileSync(join(r.work, '.gitattributes'), 'tracked.txt filter=probe\n');
  r.git('config', 'filter.probe.clean', recorder(join(r.base, 'clean'), marker, 'exec cat'));
  r.git('config', 'filter.probe.required', 'true');
  r.git('add', '.gitattributes', 'tracked.txt');
  r.git('commit', '-q', '--no-gpg-sign', '-m', 'filtered');
  const commit = r.git('rev-parse', 'HEAD').trim();
  rmSync(marker, { force: true });
  // A new modification time without new content: git status must compare content, through the filter.
  const later = new Date(Date.now() + 120_000);
  utimesSync(join(r.work, 'tracked.txt'), later, later);
  assert.equal(releaseVersion(r.work), commit);
  assert.equal(existsSync(marker), false, 'releaseVersion ran the clean filter');
  r.git('status', '--porcelain');
  assert.equal(existsSync(marker), true, 'the fixture is admitted: plain git status runs this filter');
});

// ── Round 1 findings: a submodule's own filters, and filter names the parent's -c overrides miss or cannot name ─────

/**
 * Commits tracked.txt under the required clean filter `name`, given as the raw bytes git keeps in its config and
 * attributes, then changes only its modification time, so that git status compares its content through the filter.
 */
function underFilter(r: ReturnType<typeof repo>, name: string | Buffer, marker: string): string {
  const bytes = Buffer.from(name);
  const command = recorder(join(r.base, 'clean'), marker, 'exec cat').replace(/[\\"]/g, '\\$&');
  appendFileSync(join(r.base, 'meta', 'config'),
    Buffer.concat([Buffer.from('[filter "'), bytes, Buffer.from(`"]\n\tclean = "${command}"\n\trequired = true\n`)]));
  writeFileSync(join(r.work, '.gitattributes'), Buffer.concat([Buffer.from('tracked.txt filter='), bytes, Buffer.from('\n')]));
  r.git('add', '.gitattributes', 'tracked.txt');
  r.git('commit', '-q', '--no-gpg-sign', '-m', 'filtered');
  rmSync(marker, { force: true });
  const later = new Date(Date.now() + 120_000);
  utimesSync(join(r.work, 'tracked.txt'), later, later);
  return r.git('rev-parse', 'HEAD').trim();
}

test('releaseVersion: a populated submodule has no release, and its own clean filter, which git status runs, is never run', (t) => {
  const r = repo(t);
  const marker = join(r.base, 'submodule-filter-ran');
  // The submodule keeps its metadata outside the work tree too; its filter is in its own config, not the parent's.
  r.git('init', '-q', '--template=', `--separate-git-dir=${join(r.base, 'submeta')}`, 'sub');
  writeFileSync(join(r.work, 'sub', '.gitattributes'), 'tracked.txt filter=inner\n');
  writeFileSync(join(r.work, 'sub', 'tracked.txt'), 'inner\n');
  r.git('-C', 'sub', 'config', 'filter.inner.clean', recorder(join(r.base, 'inner-clean'), marker, 'exec cat'));
  r.git('-C', 'sub', 'config', 'filter.inner.required', 'true');
  r.git('-C', 'sub', 'add', '.gitattributes', 'tracked.txt');
  r.git('-C', 'sub', 'commit', '-q', '--no-gpg-sign', '-m', 'inner');
  r.git('add', 'sub');
  r.git('commit', '-q', '--no-gpg-sign', '-m', 'submodule');
  assert.match(r.git('ls-files', '--stage', 'sub'), /^160000 /, 'the fixture is admitted: sub is an indexed gitlink');
  rmSync(marker, { force: true });
  const later = new Date(Date.now() + 120_000);
  utimesSync(join(r.work, 'sub', 'tracked.txt'), later, later);
  const version = releaseVersion(r.work);
  assert.equal(existsSync(marker), false, "releaseVersion ran the submodule's clean filter");
  assert.equal(version, null, 'a checkout with a submodule has no release, rather than one that hides the submodule');
  r.git('status', '--porcelain');
  assert.equal(existsSync(marker), true, "the fixture is admitted: plain git status runs the submodule's filter");
});

test('releaseVersion: a filter named with U+2028 or U+2029, which git accepts, is never run, and the file still reads as clean', async (t) => {
  for (const name of ['line\u2028sep', 'para\u2029sep']) {
    await t.test(JSON.stringify(name), (st) => {
      const r = repo(st);
      const marker = join(r.base, 'filter-ran');
      const commit = underFilter(r, name, marker);
      assert.equal(releaseVersion(r.work), commit);
      assert.equal(existsSync(marker), false, `releaseVersion ran the clean filter ${JSON.stringify(name)}`);
      r.git('status', '--porcelain');
      assert.equal(existsSync(marker), true, `the fixture is admitted: plain git status runs ${JSON.stringify(name)}`);
    });
  }
});

test('releaseVersion: a filter name that -c cannot override ("=", or bytes that are not UTF-8) gives no release and is never run', async (t) => {
  for (const name of ['a=b', Buffer.from([0x61, 0xff, 0x62])]) {
    await t.test(JSON.stringify(String(name)), (st) => {
      const r = repo(st);
      const marker = join(r.base, 'filter-ran');
      underFilter(r, name, marker);
      const version = releaseVersion(r.work);
      assert.equal(existsSync(marker), false, `releaseVersion ran the clean filter ${JSON.stringify(String(name))}`);
      assert.equal(version, null);
      r.git('status', '--porcelain');
      assert.equal(existsSync(marker), true, `the fixture is admitted: plain git status runs ${JSON.stringify(String(name))}`);
    });
  }
});

test('releaseVersion: an empty filter name gives no release and never runs its admitted clean driver', (t) => {
  const r = repo(t);
  const marker = join(r.base, 'filter-ran');
  underFilter(r, '', marker);
  r.git('status', '--porcelain');
  assert.equal(existsSync(marker), true, 'the fixture is admitted: plain git status runs the empty-name filter');
  t.diagnostic('positive control: plain git status ran the empty-name filter on this fixture');
  rmSync(marker, { force: true });
  const later = new Date(Date.now() + 240_000);
  utimesSync(join(r.work, 'tracked.txt'), later, later);
  const version = releaseVersion(r.work);
  assert.equal(existsSync(marker), false, 'releaseVersion ran the empty-name clean filter');
  assert.equal(version, null, 'an empty filter name conservatively gives no release');
});

test('releaseVersion: inherited GIT_* variables naming another repository change nothing', (t) => {
  const r = repo(t), other = repo(t);
  writeFileSync(join(other.work, 'tracked.txt'), 'changed\n');
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS'] as const;
  const saved = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }));
  process.env.GIT_DIR = join(other.base, 'meta');
  process.env.GIT_WORK_TREE = other.work;
  process.env.GIT_INDEX_FILE = join(other.base, 'meta', 'index');
  process.env.GIT_CONFIG_PARAMETERS = `'core.fsmonitor'='${join(other.base, 'missing')}'`;
  assert.equal(releaseVersion(r.work), r.commit);
});

test('serve: the release comes from the checkout, never from the config file', async (t) => {
  const { serveSettings } = await import('../src/cli.ts') as { serveSettings?: (file: object, repoDir: string) => Record<string, unknown> };
  assert.equal(typeof serveSettings, 'function', 'serve has no settings seam');
  const r = repo(t);
  const file = { tokenFile: join(r.base, 'token'), url: 'http://127.0.0.1:1', port: 0, version: 'f'.repeat(40), storePath: join(r.base, 's.sqlite') };
  const fromRepo = serveSettings!(file, r.work);
  assert.equal(fromRepo.version, r.commit);
  assert.equal(fromRepo.storePath, file.storePath);
  assert.equal('tokenFile' in fromRepo || 'url' in fromRepo, false);
  assert.equal(serveSettings!(file, join(r.base, 'meta')).version, null, 'a folder with no checkout has no release, whatever the file says');
});

// ── The prober's counters, through the service (needs a loopback listener) ─────────────────────────────────────────

const TOKEN = 'z'.repeat(32);
const HEADERS = { authorization: `Bearer ${TOKEN}` };

function serviceCli(root: string): string {
  const cli = join(root, 'claude.cjs');
  writeFileSync(cli, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') console.log('2.1.280');
else if (a[0] === 'auth') {
  if (fs.existsSync(p.join(__dirname, 'fail_auth'))) process.exit(1);
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', orgId: 'owner' }));
} else process.exit(1);
`);
  chmodSync(cli, 0o755);
  return cli;
}

/**
 * A service whose probes stop at `reachable`, after the environment and identity readings and before the allowance
 * one. The startup probe passes at once; each later probe waits for the test's answer. Answering false ends the probe
 * without another process, so it is recorded before any later I/O callback (a health read). A fixture changes only
 * while a probe is held, so it applies to the next probe; a read made once the next probe is held shows exactly the
 * probes before it.
 */
async function gatedService(t: { skip(message: string): void; after(fn: () => unknown): void }, env?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u23-owner-svc-'));
  let calls = 0, pipe: Awaited<ReturnType<typeof startPipe>> | undefined;
  const waiting: Array<(up: boolean) => void> = [], arrivals: Array<() => void> = [];
  t.after(async () => { for (const answer of waiting.splice(0)) answer(false); await pipe?.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); });
  const reachable = (): Promise<boolean> => calls++ === 0 ? Promise.resolve(true)
    : new Promise<boolean>((answer) => { waiting.push(answer); arrivals.shift()?.(); });
  /** The answer for the next probe, once that probe is held at `reachable`. */
  const held = (): Promise<(up: boolean) => void> => new Promise((resolveHeld) => {
    if (waiting.length) resolveHeld(waiting.shift()!); else arrivals.push(() => resolveHeld(waiting.shift()!));
  });
  try {
    pipe = await startPipe({
      accounts: [{ id: 'a', provider: 'claude', loginDir: root, fingerprint: createHash('sha256').update('owner').digest('hex').slice(0, 8), maxConcurrency: 1, enabled: true }],
      policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: join(root, 'store.sqlite'), worktreeRoot: root,
      cli: { claude: serviceCli(root) }, token: TOKEN, port: 0, reachable, tickMs: 20, probeIntervalMs: 20, probeRetryMs: 20, ...(env ? { env } : {}),
    } as Parameters<typeof startPipe>[0]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('loopback bind unavailable'); return undefined; }
    throw e;
  }
  const url = pipe.url;
  const read = async () => (await (await fetch(`${url}/v1/health`, { headers: HEADERS })).json()) as Record<string, any>;
  return { root, url, held, read };
}

/** An environment whose armed reading throws once (a thrown probe), after `before` runs; the probe reads it first. */
function throwingEnv(before: () => void = () => {}) {
  const fixture = { armed: false, thrownAt: 0, thrown: Promise.resolve(), threw: () => {} };
  const arm = () => { fixture.armed = true; fixture.thrown = new Promise<void>((resolveThrown) => { fixture.threw = resolveThrown; }); };
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    get LC_OWNER_FIXTURE(): string | undefined {
      if (!fixture.armed) return undefined;
      fixture.armed = false;
      before();
      fixture.thrownAt = Date.now();
      fixture.threw();
      throw new Error('synthetic probe failure at /private/owner/reason');
    },
  };
  return { env, arm, fixture };
}

test('service: a probe that throws after the clock falls behind its high-water mark leaves the counters as they were', async (t) => {
  let storePath = '';
  // The store's mark moves a day ahead, as a clock stepped back would leave it, then the probe throws.
  const { env, arm, fixture } = throwingEnv(() => {
    const db = new DatabaseSync(storePath);
    try { db.prepare('UPDATE clock SET last = ?').run(Date.now() + 86_400_000); } finally { db.close(); }
  });
  const s = await gatedService(t, env);
  if (!s) return;
  storePath = join(s.root, 'store.sqlite');
  assert.equal((await s.read()).service.clockCurrent, true);
  const answer = await s.held();
  arm();
  answer(false);   // this probe proves the identity: 0; the next one reads the armed environment
  await fixture.thrown;
  const after = await s.read();
  assert.equal(after.service.clockCurrent, false);
  assert.equal(after.accounts[0].consecutiveProbeFailures, 0, 'a thrown probe counted while the clock is behind');
  assert.ok(Date.parse(after.accounts[0].lastProbeAt) < fixture.thrownAt, 'a thrown probe moved lastProbeAt while the clock is behind');
  assert.equal(JSON.stringify(after).includes('private'), false, 'health published the private reason');
});

test('service: a probe still running when drain starts leaves the counters as they were', async (t) => {
  const s = await gatedService(t);
  if (!s) return;
  const first = await s.held();
  writeFileSync(join(s.root, 'fail_auth'), '1');
  first(false);
  const failing = await s.held();   // its identity reading is unknown
  const before = await s.read();
  assert.equal(before.accounts[0].consecutiveProbeFailures, 0);
  const drain = await (await fetch(`${s.url}/v1/drain?wait=1`, { method: 'POST', headers: HEADERS })).json() as Record<string, unknown>;
  assert.equal(drain.draining, true);
  failing(false);
  const after = await s.read();
  assert.equal(after.service.draining, true);
  assert.equal(after.accounts[0].consecutiveProbeFailures, 0, 'a probe ending during drain counted');
  assert.equal(after.accounts[0].lastProbeAt, before.accounts[0].lastProbeAt, 'a probe ending during drain moved lastProbeAt');
});

test('service: unknown and thrown probes each count once; a probe that proves the identity resets the count to zero', async (t) => {
  const { env, arm, fixture } = throwingEnv();
  const s = await gatedService(t, env);
  if (!s) return;
  const failures = async () => (await s.read()).accounts[0].consecutiveProbeFailures;
  let answer = await s.held();
  writeFileSync(join(s.root, 'fail_auth'), '1');
  answer(false);                                        // proved: 0
  answer = await s.held();
  assert.equal(await failures(), 0);
  answer(false);                                        // unknown: 1
  answer = await s.held();
  assert.equal(await failures(), 1, 'an unknown identity reading counts once');
  arm();
  answer(false);                                        // unknown: 2, then the next probe throws: 3
  await fixture.thrown;
  answer = await s.held();
  assert.equal(await failures(), 3, 'a thrown probe counts once');
  rmSync(join(s.root, 'fail_auth'));
  answer(false);                                        // read before the removal: unknown: 4
  answer = await s.held();
  assert.equal(await failures(), 4);
  answer(false);                                        // the identity is read, the allowance is offline: 0
  await s.held();
  assert.equal(await failures(), 0, 'a probe that proves the identity resets the count');
});

/**
 * Acceptance grader, lane U11: remote use over SSH (lead-authored; the implementation lane must not edit it).
 *
 * Proven by hand on 2026-09-25: `ssh <host> <home>/pipe-mcp` gives another Mac the pipe's MCP tools. No port opens,
 * the token stays on the pipe's machine, and jobs run there. macOS stops SSH sessions from reading external volumes, so
 * the entry point must live in the home folder, and a non-login SSH shell has a minimal PATH. `pipe remote install`
 * makes that entry point: a copy of the MCP server and its dependency-free client, an owner-only token copy, and a
 * launcher that needs nothing from PATH, all inside `~/.local/share/pipe` (round 3: the installer writes nowhere else).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPipe } from '../src/service.ts';

const FIX = new URL('./fixtures/', import.meta.url);
const SRC = new URL('../src/', import.meta.url);
const CLI = fileURLToPath(new URL('cli.ts', SRC));
const u4 = (name: string) => JSON.parse(readFileSync(new URL(`u4/${name}.json`, FIX), 'utf8'));
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN = 'pipe-test-token-not-a-credential-0123456789';
const POLICY = { claude: { models: { opus: 'default' }, efforts: ['high'] } };

/** Runs the CLI without blocking this process, which hosts the pipe it calls. */
const runCli = (args: string[], env: NodeJS.ProcessEnv = process.env) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', env }, (err, stdout, stderr) =>
    resolve({ status: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
});

function fakeClaude(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-claude-')));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    version: u4('claude-version').stdout, authStatus: u4('claude-auth-status.signed-in').stdout, usage: u4('claude-usage.signed-in').stdout,
  }));
  const path = join(dir, 'claude');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'), p = require('path');
const sc = JSON.parse(fs.readFileSync(p.join(__dirname, 'scenario.json'), 'utf8'));
const a = process.argv.slice(2);
if (a[0] === '--version') process.stdout.write(sc.version);
else if (a[0] === 'auth') process.stdout.write(JSON.stringify(sc.authStatus));
else if (a[0] === '-p' && a[1] === '/usage') process.stdout.write(JSON.stringify(sc.usage));
`);
  chmodSync(path, 0o755);
  return path;
}

/** A running pipe, and a config file that names its fixed port and an owner-only token file, as `serve` would use. */
async function pipe() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-')));
  const login = join(root, 'login-claude-a');
  mkdirSync(login, { recursive: true });
  const handle = await startPipe({
    accounts: [{ id: 'claude-a', provider: 'claude', loginDir: login, fingerprint: sha8('<orgId>'), maxConcurrency: 1, enabled: true }],
    policy: POLICY, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'worktrees'),
    cli: { claude: fakeClaude() }, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    token: TOKEN, port: 0, reachable: async () => true, tickMs: 100, probeIntervalMs: 60_000,
  } as Parameters<typeof startPipe>[0]);
  const tokenFile = join(root, 'pipe.token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ port: Number(new URL(handle.url).port), tokenFile, storePath: join(root, 'other.sqlite'),
    worktreeRoot: join(root, 'worktrees'), accounts: [], policy: POLICY, cli: {} }));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
  return { ...handle, root, config, home };
}

/** Speak MCP to a launcher over stdio, as `ssh <host> <launcher>` would. */
async function mcp(launcher: string, env: NodeJS.ProcessEnv, frames: object[]): Promise<Map<number, any>> {
  const child = spawn(launcher, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const answers = new Map<number, any>();
  let buf = '', err = '';
  child.stderr.on('data', (c) => { err += String(c); });
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no answer from the launcher: ${err.slice(0, 600)}`)); }, 15_000);
    child.stdout.on('data', (c) => {
      buf += String(c);
      for (let n; (n = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        try { const m = JSON.parse(line); if (typeof m.id === 'number') answers.set(m.id, m); } catch { /* not a frame */ }
      }
      if (frames.every((f) => answers.has((f as { id: number }).id))) { clearTimeout(timer); child.kill('SIGTERM'); resolve(); }
    });
    child.on('exit', () => { if (!frames.every((f) => answers.has((f as { id: number }).id))) { clearTimeout(timer); reject(new Error(`the launcher exited: ${err.slice(0, 600)}`)); } });
  });
  for (const f of frames) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...f })}\n`);
  await done;
  return answers;
}

const importsOf = (file: string) => [...readFileSync(new URL(file, SRC), 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .map((m) => m[1] ?? m[2]!);

test('R1 the MCP server and its client depend on nothing but Node\'s built-ins and each other', () => {
  assert.ok(existsSync(new URL('client.ts', SRC)), 'src/client.ts exists');
  for (const spec of importsOf('client.ts')) assert.match(spec, /^node:/, `client.ts imports ${spec}`);
  for (const spec of importsOf('mcp.ts')) assert.ok(/^node:/.test(spec) || spec === './client.ts', `mcp.ts imports ${spec}`);
});

test('R2 the client keeps the same calls, for the CLI and the MCP server alike', async () => {
  const client = await import('../src/client.ts') as Record<string, unknown>;
  assert.equal(typeof client.requestJson, 'function');
  assert.equal(typeof client.requestJsonReconnecting, 'function');
});

test('R3 `pipe remote install` makes a home-folder launcher that serves the MCP tools with no node on PATH', async () => {
  const p = await pipe();
  try {
    const r = await runCli(['remote', 'install', '--config', p.config, '--home', p.home]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { launcher: string; installed: string };
    const launcher = join(p.home, '.local', 'share', 'pipe', 'pipe-mcp');
    assert.equal(out.launcher, launcher);
    assert.ok(out.installed.startsWith(join(p.home, '.local', 'share', 'pipe') + '/'), out.installed);
    for (const f of ['mcp.ts', 'client.ts']) {
      assert.equal(readFileSync(join(out.installed, f), 'utf8'), readFileSync(new URL(f, SRC), 'utf8'), `${f} is copied verbatim`);
    }
    // A non-login SSH shell: a minimal PATH, and the home folder.
    const answers = await mcp(launcher, { PATH: '/usr/bin:/bin', HOME: p.home }, [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'pipe_accounts', arguments: {} } },
    ]);
    assert.ok(answers.get(2).result.tools.some((t: { name: string }) => t.name === 'pipe_submit'), JSON.stringify(answers.get(2)));
    const text = answers.get(3).result.content[0].text as string;
    assert.ok(!answers.get(3).result.isError, text);
    assert.match(text, /claude-a/, 'the tool reached the pipe');
  } finally { await p.stop(); }
});

test('R4 the token copy is owner-only, and the token is never written into the launcher', async () => {
  const p = await pipe();
  try {
    const r = await runCli(['remote', 'install', '--config', p.config, '--home', p.home]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'the token is never printed');
    const share = join(p.home, '.local', 'share', 'pipe');
    assert.equal(statSync(share).mode & 0o077, 0, 'the share folder is owner-only');
    const tokens = readdirSync(share, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && readFileSync(join(d.parentPath, d.name), 'utf8').includes(TOKEN));
    assert.equal(tokens.length, 1, 'exactly one token copy');
    assert.equal(statSync(join(tokens[0]!.parentPath, tokens[0]!.name)).mode & 0o077, 0, 'the token copy is owner-only');
    const launcher = readFileSync(join(p.home, '.local', 'share', 'pipe', 'pipe-mcp'), 'utf8');
    assert.ok(!launcher.includes(TOKEN), 'the launcher reads the token at run time');
    assert.equal(statSync(join(p.home, '.local', 'share', 'pipe', 'pipe-mcp')).mode & 0o022, 0, 'nobody else can change the launcher');
  } finally { await p.stop(); }
});

test('R5 installing again is idempotent: the same files make the same version folder', async () => {
  const p = await pipe();
  try {
    const first = await runCli(['remote', 'install', '--config', p.config, '--home', p.home]);
    const second = await runCli(['remote', 'install', '--config', p.config, '--home', p.home]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(first.stdout).installed, JSON.parse(second.stdout).installed);
    const versions = readdirSync(join(p.home, '.local', 'share', 'pipe'), { withFileTypes: true }).filter((d) => d.isDirectory());
    assert.equal(versions.length, 1, versions.map((d) => d.name).join(', '));
  } finally { await p.stop(); }
});

test('R6 install refuses a config without a fixed port or token file, and writes nothing', async () => {
  const p = await pipe();
  try {
    for (const drop of ['port', 'tokenFile']) {
      const cfg = JSON.parse(readFileSync(p.config, 'utf8'));
      delete cfg[drop];
      const path = join(p.root, `no-${drop}.json`);
      writeFileSync(path, JSON.stringify(cfg));
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
      const r = await runCli(['remote', 'install', '--config', path, '--home', home]);
      assert.notEqual(r.status, 0, `without ${drop}: ${r.stdout}`);
      assert.ok(!existsSync(join(home, '.local')), `without ${drop}, nothing is written`);
    }
  } finally { await p.stop(); }
});

// ---- Round 2 (Sol on 4f99e35) -----------------------------------------------------------------------------------

test('R7 the installer never writes through a symlink: a link at the launcher or token is replaced, a linked folder is refused', async () => {
  const p = await pipe();
  try {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-outside-')));
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'not the pipe\'s\n', { mode: 0o644 });
    // A link where the launcher and the token copy go.
    mkdirSync(join(p.home, '.local', 'share', 'pipe'), { recursive: true, mode: 0o700 });
    symlinkSync(victim, join(p.home, '.local', 'share', 'pipe', 'pipe-mcp'));
    symlinkSync(victim, join(p.home, '.local', 'share', 'pipe', 'token'));
    const r = await runCli(['remote', 'install', '--config', p.config, '--home', p.home]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(victim, 'utf8'), 'not the pipe\'s\n', 'the link\'s target is untouched');
    assert.equal(statSync(victim).mode & 0o777, 0o644, 'and keeps its mode');
    for (const f of [join(p.home, '.local', 'share', 'pipe', 'pipe-mcp'), join(p.home, '.local', 'share', 'pipe', 'token')]) {
      assert.ok(!lstatSync(f).isSymbolicLink(), `${f} is now a regular file`);
    }
    assert.equal(statSync(join(p.home, '.local', 'share', 'pipe', 'token')).mode & 0o077, 0);
    // A linked pipe folder is refused, and nothing lands in its target.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-elsewhere-')));
    mkdirSync(join(home, '.local', 'share'), { recursive: true });
    symlinkSync(elsewhere, join(home, '.local', 'share', 'pipe'));
    const refused = await runCli(['remote', 'install', '--config', p.config, '--home', home]);
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing is written into a linked folder');
    assert.ok(!existsSync(join(home, '.local', 'share', 'pipe', 'pipe-mcp')), 'and no launcher is made');
  } finally { await p.stop(); }
});

test('R8 the launcher sets its own PATH, so nothing it runs depends on the SSH shell\'s', async () => {
  const p = await pipe();
  try {
    const r = await runCli(['remote', 'install', '--config', p.config, '--home', p.home]);
    assert.equal(r.status, 0, r.stderr);
    const launcher = readFileSync(join(p.home, '.local', 'share', 'pipe', 'pipe-mcp'), 'utf8');
    assert.match(launcher, /^PATH=\/usr\/bin:\/bin$/m);
    assert.match(launcher, /^export\b.*\bPATH\b/m);
    const answers = await mcp(join(p.home, '.local', 'share', 'pipe', 'pipe-mcp'), { PATH: '/nonexistent', HOME: p.home },
      [{ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }]);
    assert.ok(answers.get(1).result, 'it starts with a useless PATH');
  } finally { await p.stop(); }
});

test('R9 the printed ssh command names the installed launcher exactly, even outside the default home or with spaces', async () => {
  const p = await pipe();
  try {
    const home = join(p.home, 'a home with spaces & quotes\'');
    mkdirSync(home);
    const r = await runCli(['remote', 'install', '--config', p.config, '--home', home]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { launcher: string; mcp: { command: string; args: string[] } };
    assert.equal(out.mcp.command, 'ssh');
    const remote = out.mcp.args.at(-1)!;
    // ssh hands its last argument to the remote login shell, which parses it as shell words.
    const parsed = spawnSync('/bin/sh', ['-c', `set -- ${remote}; printf %s "$1"`], { encoding: 'utf8' });
    assert.equal(parsed.stdout, out.launcher, `the remote shell reads ${remote} as the launcher`);
  } finally { await p.stop(); }
});

// ---- Round 3 (Sol on 32063db) -----------------------------------------------------------------------------------

test('R10 a linked folder anywhere between home and the pipe folder is refused, and nothing is written through it', async () => {
  const p = await pipe();
  try {
    for (const linked of [['.local'], ['.local', 'share']]) {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-elsewhere-')));
      mkdirSync(join(elsewhere, 'pipe'), { mode: 0o755 });
      if (linked.length === 2) mkdirSync(join(home, '.local'));
      symlinkSync(elsewhere, join(home, ...linked));
      const r = await runCli(['remote', 'install', '--config', p.config, '--home', home]);
      assert.notEqual(r.status, 0, `${linked.join('/')} linked: ${r.stdout}`);
      assert.match(r.stderr, /link/i, 'the refusal says a folder is a link');
      assert.equal(statSync(join(elsewhere, 'pipe')).mode & 0o777, 0o755, 'nothing is re-permissioned through the link');
      assert.deepEqual(readdirSync(join(elsewhere, 'pipe')), [], 'nothing is written through the link');
    }
  } finally { await p.stop(); }
});

test('R11 the installer writes only inside its own folder: ~/.local/bin is never touched', async () => {
  const p = await pipe();
  try {
    const r = await runCli(['remote', 'install', '--config', p.config, '--home', p.home]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(p.home, '.local', 'bin')), 'no ~/.local/bin is made or written');
    assert.equal(JSON.parse(r.stdout).launcher, join(p.home, '.local', 'share', 'pipe', 'pipe-mcp'));
  } finally { await p.stop(); }
});

// ---- Round 4 (Sol on f576644: a swap between check and use) ------------------------------------------------------

test('R12 like ssh\'s StrictModes, a home or parent folder that others can write is refused, and nothing is written', async () => {
  const p = await pipe();
  try {
    const groupHome = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
    chmodSync(groupHome, 0o775);
    const a = await runCli(['remote', 'install', '--config', p.config, '--home', groupHome]);
    assert.notEqual(a.status, 0, `a group-writable home: ${a.stdout}`);
    assert.match(a.stderr, /writable/i, 'the refusal says who else can write');
    assert.ok(!existsSync(join(groupHome, '.local')), 'nothing is made under it');
    const worldLocal = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
    mkdirSync(join(worldLocal, '.local'));
    chmodSync(join(worldLocal, '.local'), 0o777);
    const b = await runCli(['remote', 'install', '--config', p.config, '--home', worldLocal]);
    assert.notEqual(b.status, 0, `a world-writable ~/.local: ${b.stdout}`);
    assert.match(b.stderr, /writable/i);
    assert.ok(!existsSync(join(worldLocal, '.local', 'share')), 'nothing is made under it');
  } finally { await p.stop(); }
});

// ---- Round 5 (macOS ACLs grant writes the mode bits do not show) --------------------------------

/** A "deny delete" ACL stops `rm -rf`, so each ACL test strips its folders' ACLs when it ends. */
const clearAcls = (folders: string[]) => { for (const folder of folders) execFileSync('/bin/chmod', ['-R', '-N', folder]); };

test('R13 an ACL that lets another user write a folder on the path is refused; the usual deny-only home ACL is fine', { skip: process.platform !== 'darwin' && 'macOS ACLs' }, async () => {
  const p = await pipe();
  const acl: string[] = [];
  try {
    // A macOS home carries "group:everyone deny delete"; deny entries grant nothing and must not block an install.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
    acl.push(home);
    execFileSync('/bin/chmod', ['+a', 'group:everyone deny delete', home]);
    const ok = await runCli(['remote', 'install', '--config', p.config, '--home', home]);
    assert.equal(ok.status, 0, `a deny-only ACL on home is fine: ${ok.stderr}`);
    // An allow entry that lets everyone add or delete entries in ~/.local is a way to swap folders.
    const aclHome = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
    acl.push(aclHome);
    mkdirSync(join(aclHome, '.local'), { mode: 0o755 });
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow add_file,add_subdirectory,delete_child', join(aclHome, '.local')]);
    const refused = await runCli(['remote', 'install', '--config', p.config, '--home', aclHome]);
    assert.notEqual(refused.status, 0, `an allow ACL granting writes: ${refused.stdout}`);
    assert.match(refused.stderr, /acl|access control/i, 'the refusal names the ACL');
    assert.ok(!existsSync(join(aclHome, '.local', 'share')), 'nothing is made under it');
  } finally { await p.stop(); clearAcls(acl); }
});

test('R14 the pipe folder is refused if it carries any allow ACL, so nothing it holds, the token included, is shared', { skip: process.platform !== 'darwin' && 'macOS ACLs' }, async () => {
  const p = await pipe();
  const acl: string[] = [];
  try {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-u11-home-')));
    acl.push(home);
    mkdirSync(join(home, '.local', 'share', 'pipe'), { recursive: true, mode: 0o700 });
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow read,file_inherit', join(home, '.local', 'share', 'pipe')]);
    const r = await runCli(['remote', 'install', '--config', p.config, '--home', home]);
    assert.notEqual(r.status, 0, `an inheritable read ACL on the pipe folder: ${r.stdout}`);
    assert.match(r.stderr, /acl|access control/i);
    assert.ok(!existsSync(join(home, '.local', 'share', 'pipe', 'token')), 'no token is written there');
  } finally { await p.stop(); clearAcls(acl); }
});

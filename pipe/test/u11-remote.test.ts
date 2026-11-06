import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('remote install keeps a versioned MCP client and runtime token in the home folder', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'pipe-u11-install-')), "a home & quote's");
  mkdirSync(home);
  const token = join(home, 'source-token');
  const config = join(home, 'config.json');
  writeFileSync(token, 'secret-for-offline-test\n', { mode: 0o600 });
  chmodSync(token, 0o600);
  writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));

  const install = () => JSON.parse(execFileSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' }));
  const first = install(), second = install();
  assert.deepEqual(first, second);
  assert.equal(first.launcher, join(home, '.local/share/pipe/pipe-mcp'));
  assert.equal(first.mcp.command, 'ssh');
  assert.deepEqual(first.mcp.args.slice(0, 2), ['-T', '<this host>']);
  const parsed = spawnSync('/bin/sh', ['-c', `set -- ${first.mcp.args.at(-1)}; printf %s "$1"`], { encoding: 'utf8' });
  assert.equal(parsed.stdout, first.launcher);
  assert.equal(readdirSync(join(home, '.local/share/pipe'), { withFileTypes: true }).filter((item) => item.isDirectory()).length, 1);
  assert.equal(statSync(join(home, '.local/share/pipe')).mode & 0o077, 0);
  assert.equal(statSync(join(home, '.local/share/pipe/token')).mode & 0o077, 0);
  assert.equal(statSync(first.launcher).mode & 0o022, 0);
  assert.ok(!readFileSync(first.launcher, 'utf8').includes('secret-for-offline-test'));
  assert.match(readFileSync(first.launcher, 'utf8'), /^PATH=\/usr\/bin:\/bin\nexport PATH$/m);
  for (const name of ['mcp.ts', 'client.ts']) assert.equal(readFileSync(join(first.installed, name), 'utf8'), readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'));
  const result = spawnSync(first.launcher, { env: { PATH: '/nonexistent', HOME: home }, input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).result.tools.some((tool: { name: string }) => tool.name === 'pipe_submit'));
});

test('remote install replaces linked files without changing their targets', () => {
  const home = mkdtempSync(join(tmpdir(), 'pipe-u11-links-'));
  const token = join(home, 'source-token'), config = join(home, 'config.json');
  writeFileSync(token, 'secret-for-links\n', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
  const first = JSON.parse(execFileSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' }));
  const victim = join(home, 'victim');
  writeFileSync(victim, 'untouched');
  const destinations = [first.launcher, join(home, '.local/share/pipe/token'), join(first.installed, 'mcp.ts'), join(first.installed, 'client.ts')];
  for (const destination of destinations) {
    const backup = `${destination}.old`;
    // The original file is moved out of the way before the link is installed.
    renameSync(destination, backup);
    symlinkSync(victim, destination);
  }
  execFileSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home]);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  for (const destination of destinations) assert.equal(lstatSync(destination).isSymbolicLink(), false, destination);
});

test('remote install refuses a linked version folder before writing files', () => {
  const home = mkdtempSync(join(tmpdir(), 'pipe-u11-version-link-'));
  const token = join(home, 'source-token'), config = join(home, 'config.json');
  writeFileSync(token, 'secret-for-version\n', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
  const first = JSON.parse(execFileSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' }));
  const elsewhere = mkdtempSync(join(tmpdir(), 'pipe-u11-elsewhere-'));
  renameSync(first.installed, `${first.installed}.old`);
  symlinkSync(elsewhere, first.installed);
  const result = spawnSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version|directory|symlink/i);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('remote install refuses a linked pipe folder without touching its target', () => {
  const home = mkdtempSync(join(tmpdir(), 'pipe-u11-share-link-'));
  const token = join(home, 'source-token'), config = join(home, 'config.json');
  writeFileSync(token, 'secret-for-share\n', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
  mkdirSync(join(home, '.local/share'), { recursive: true });
  const elsewhere = mkdtempSync(join(tmpdir(), 'pipe-u11-linked-share-'));
  symlinkSync(elsewhere, join(home, '.local/share/pipe'));
  const result = spawnSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /directory|symlink/i);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.equal(existsSync(join(home, '.local/bin')), false);
});

test('remote install refuses links at .local and share before changing their targets', () => {
  for (const linked of ['.local', '.local/share']) {
    const home = mkdtempSync(join(tmpdir(), 'pipe-u11-parent-link-'));
    const token = join(home, 'source-token'), config = join(home, 'config.json');
    writeFileSync(token, 'secret-for-parent-link\n', { mode: 0o600 });
    writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
    const elsewhere = mkdtempSync(join(tmpdir(), 'pipe-u11-link-target-'));
    mkdirSync(join(elsewhere, 'pipe'), { mode: 0o755 });
    if (linked === '.local/share') mkdirSync(join(home, '.local'));
    symlinkSync(elsewhere, join(home, linked));
    const result = spawnSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, linked);
    assert.match(result.stderr, /link/i);
    assert.equal(statSync(join(elsewhere, 'pipe')).mode & 0o777, 0o755);
    assert.deepEqual(readdirSync(join(elsewhere, 'pipe')), []);
  }
});

test('remote install never creates or writes .local/bin', () => {
  const home = mkdtempSync(join(tmpdir(), 'pipe-u11-no-bin-'));
  const token = join(home, 'source-token'), config = join(home, 'config.json');
  writeFileSync(token, 'secret-for-no-bin\n', { mode: 0o600 });
  writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' }));
  assert.equal(result.launcher, join(home, '.local/share/pipe/pipe-mcp'));
  assert.equal(existsSync(join(home, '.local/bin')), false);
});

test('remote install refuses folders others can write before replacing files', () => {
  for (const [part, mode] of [['', 0o775], ['.local', 0o777], ['.local/share', 0o775], ['.local/share/pipe', 0o777], ['version', 0o775]] as const) {
    const home = mkdtempSync(join(tmpdir(), 'pipe-u11-writable-'));
    const token = join(home, 'source-token'), config = join(home, 'config.json');
    writeFileSync(token, 'secret-for-writable-test\n', { mode: 0o600 });
    writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
    const args = [cli, 'remote', 'install', '--config', config, '--home', home];
    const first = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
    const folder = part === 'version' ? first.installed : join(home, part);
    writeFileSync(first.launcher, 'sentinel');
    chmodSync(folder, mode);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(result.status, 0, folder);
    assert.match(result.stderr, /writable/i);
    assert.ok(result.stderr.includes(folder), result.stderr);
    assert.equal(readFileSync(first.launcher, 'utf8'), 'sentinel');
  }
});

test('remote install rejects an incomplete config before writing to home', () => {
  for (const missing of ['port', 'tokenFile']) {
    const home = mkdtempSync(join(tmpdir(), 'pipe-u11-missing-'));
    const config = join(home, 'config.json');
    writeFileSync(config, JSON.stringify(missing === 'port' ? { tokenFile: '/unused' } : { port: 8123 }));
    const result = spawnSync(process.execPath, [cli, 'remote', 'install', '--config', config, '--home', home], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(missing));
    assert.equal(existsSync(join(home, '.local')), false);
  }
});

/** A "deny delete" ACL stops `rm -rf`, so each ACL test strips its folder's ACLs when it ends. */
const clearAcls = (folder: string) => execFileSync('/bin/chmod', ['-R', '-N', folder]);

test('remote install refuses macOS ACL writes on home, .local and share, but accepts a deny-only home ACL', { skip: process.platform !== 'darwin' }, () => {
  for (const part of ['', '.local', '.local/share']) {
    const home = mkdtempSync(join(tmpdir(), 'pipe-u11-acl-parent-'));
    try {
      const token = join(home, 'source-token'), config = join(home, 'config.json');
      writeFileSync(token, 'secret\n', { mode: 0o600 });
      writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
      const args = [cli, 'remote', 'install', '--config', config, '--home', home];
      execFileSync('/bin/chmod', ['+a', 'group:everyone deny delete', home]);
      execFileSync(process.execPath, args);
      const folder = join(home, part);
      const launcher = join(home, '.local/share/pipe/pipe-mcp');
      writeFileSync(launcher, 'sentinel');
      execFileSync('/bin/chmod', ['+a', 'group:everyone allow add_file,delete_child', folder]);
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.notEqual(result.status, 0, folder);
      assert.match(result.stderr, /access control list/i);
      assert.ok(result.stderr.includes(folder), result.stderr);
      assert.equal(readFileSync(launcher, 'utf8'), 'sentinel');
    } finally { clearAcls(home); }
  }
});

test('remote install refuses any macOS allow ACL on pipe or its version folder', { skip: process.platform !== 'darwin' }, () => {
  for (const part of ['pipe', 'version']) {
    const home = mkdtempSync(join(tmpdir(), 'pipe-u11-acl-own-'));
    try {
      const token = join(home, 'source-token'), config = join(home, 'config.json');
      writeFileSync(token, 'secret\n', { mode: 0o600 });
      writeFileSync(config, JSON.stringify({ port: 8123, tokenFile: token }));
      const args = [cli, 'remote', 'install', '--config', config, '--home', home];
      const first = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
      const folder = part === 'pipe' ? join(home, '.local/share/pipe') : first.installed;
      writeFileSync(first.launcher, 'sentinel');
      execFileSync('/bin/chmod', ['+a', 'group:everyone allow read,file_inherit', folder]);
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.notEqual(result.status, 0, folder);
      assert.match(result.stderr, /access control list/i);
      assert.ok(result.stderr.includes(folder), result.stderr);
      assert.equal(readFileSync(first.launcher, 'utf8'), 'sentinel');
    } finally { clearAcls(home); }
  }
});

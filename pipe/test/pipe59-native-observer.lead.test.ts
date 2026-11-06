/** Lead-owned source diagnostics for this change. These do not authorize installation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const macOnly = { skip: process.platform !== 'darwin' };
const source = fileURLToPath(new URL('../native/protected-path-observer.c', import.meta.url));
const fakeMountSource = fileURLToPath(new URL('./fixtures/pipe59-user-mount.c', import.meta.url));
const fakeSpecialSource = fileURLToPath(new URL('./fixtures/pipe59-special-leaf.c', import.meta.url));
type Result = { schemaVersion: number; state: 'candidate' | 'refused' | 'unknown'; reasons: string[] };

async function withObserver(run: (observe: (path: string) => { code: number | null; body: Result; stdout: string }, binary: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pipe59-observer-'));
  try {
    const binary = join(root, 'observer');
    const build = spawnSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-o', binary, source], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(build.status, 0, `native observer must compile: ${build.stderr}`);
    const observe = (path: string) => {
      const result = spawnSync(binary, [path], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
      assert.equal(result.error, undefined, 'observer must terminate with a bounded response');
      assert.ok(result.stdout.length < 1024, 'response must stay bounded');
      assert.equal(result.stderr, '', 'diagnostic must not leak path or host data to stderr');
      const body = JSON.parse(result.stdout) as Result;
      assert.deepEqual(Object.keys(body).sort(), ['reasons', 'schemaVersion', 'state']);
      assert.equal(body.schemaVersion, 1);
      assert.ok(['candidate', 'refused', 'unknown'].includes(body.state));
      assert.ok(Array.isArray(body.reasons) && body.reasons.every(x => typeof x === 'string' && /^[a-z_]+$/.test(x)));
      assert.ok(!result.stdout.includes(path), 'path must not appear in output');
      return { code: result.status, body, stdout: result.stdout };
    };
    await run(observe, binary);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('P59 protected root-controlled path is a candidate, not a reject-all stub', macOnly, () => withObserver(observe => {
  const result = observe('/Library');
  assert.equal(result.code, 0);
  assert.equal(result.body.state, 'candidate');
  assert.deepEqual(result.body.reasons, []);
}));

test('P59 writable leaf, writable ancestor and symlink are not candidates', macOnly, () => withObserver(observe => {
  const leaf = observe('/private/tmp');
  assert.equal(leaf.code, 2);
  assert.equal(leaf.body.state, 'refused');
  assert.ok(leaf.body.reasons.includes('writable_leaf'));
  const ancestor = observe(`/private/tmp/pipe59-missing-${process.pid}`);
  assert.equal(ancestor.code, 2);
  assert.equal(ancestor.body.state, 'refused');
  assert.ok(ancestor.body.reasons.includes('writable_ancestor'));
  assert.ok(!ancestor.body.reasons.includes('open_failed'), 'unsafe ancestry must stop before a descendant open');
  const linked = observe('/tmp');
  assert.equal(linked.code, 2);
  assert.equal(linked.body.state, 'refused');
  assert.ok(linked.body.reasons.includes('symlink'));
}));

test('P59 an unsafe ancestor prevents inspection of its ACL-bearing descendant', macOnly, () => withObserver(observe => {
  const root = mkdtempSync(join(tmpdir(), 'pipe59-acl-'));
  try {
    const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow write', root], { encoding: 'utf8', timeout: 5000 });
    assert.equal(grant.status, 0, `ACL fixture failed: ${grant.stderr}`);
    const result = observe(root);
    assert.equal(result.code, 2);
    assert.equal(result.body.state, 'refused');
    assert.ok(result.body.reasons.some(reason => ['writable_ancestor', 'not_root_owned', 'ownership_ignored', 'untrusted_mount_owner'].includes(reason)));
    assert.ok(!result.body.reasons.includes('acl_write_allow'), 'unsafe ancestry must stop before opening the descendant');
  } finally { rmSync(root, { recursive: true, force: true }); }
}));

test('P59 bad names and a missing object cannot become candidates', macOnly, () => withObserver(observe => {
  for (const path of ['relative/path', '/Library/../tmp', '/Library//tmp', '/Library/./tmp']) {
    const result = observe(path);
    assert.equal(result.code, 2);
    assert.equal(result.body.state, 'refused');
    assert.ok(result.body.reasons.includes('invalid_path'));
  }
  const missing = observe(`/Library/pipe59-missing-${process.pid}`);
  assert.equal(missing.code, 3);
  assert.equal(missing.body.state, 'unknown');
  assert.ok(missing.body.reasons.includes('open_failed'));
}));

test('P59 an external ownership-ignored volume is refused when supplied', { skip: process.platform !== 'darwin' || !process.env.PIPE_TEST_NOOWNERS_ROOT }, () => withObserver(observe => {
  const result = observe(process.env.PIPE_TEST_NOOWNERS_ROOT!);
  assert.equal(result.code, 2);
  assert.equal(result.body.state, 'refused');
  assert.ok(result.body.reasons.some(reason => ['not_root_owned', 'ownership_ignored', 'untrusted_mount_owner'].includes(reason)),
    `observed reasons: ${result.body.reasons.join(',')}`);
}));

test('P59 observation never wakes a blocked FIFO writer beneath an unsafe ancestor', macOnly, () => withObserver(async observe => {
  const root = mkdtempSync(join(tmpdir(), 'pipe59-fifo-'));
  const fifo = join(root, 'waiting.fifo');
  const mkfifo = spawnSync('/usr/bin/mkfifo', [fifo], { encoding: 'utf8', timeout: 5000 });
  assert.equal(mkfifo.status, 0, `FIFO fixture failed: ${mkfifo.stderr}`);
  const writer = spawn(process.execPath, ['-e',
    "process.stdout.write('ready\\n'); const fd=require('node:fs').openSync(process.argv[1],'w'); process.stdout.write('opened\\n'); require('node:fs').closeSync(fd)", fifo],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const writerClosed = new Promise<void>(resolve => writer.once('close', () => resolve()));
  let output = '';
  writer.stdout!.on('data', chunk => { output += chunk.toString(); });
  try {
    for (let i = 0; i < 40 && !output.includes('ready\n'); ++i) await delay(25);
    assert.ok(output.includes('ready\n'), 'writer fixture did not reach the FIFO');
    await delay(50);
    const result = observe(fifo);
    assert.equal(result.body.state, 'refused');
    await delay(150);
    assert.equal(output, 'ready\n', 'observer opened the FIFO and woke the blocked writer');
    assert.equal(writer.exitCode, null, 'writer must remain blocked until the fixture is stopped');
  } finally {
    if (writer.exitCode === null) writer.kill('SIGKILL');
    await writerClosed;
    rmSync(root, { recursive: true, force: true });
  }
}));

test('P59 a user-owned APFS mount cannot be a candidate even when its files look root-owned', macOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe59-mount-'));
  try {
    const binary = join(root, 'fake-user-mount-observer');
    const build = spawnSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-o', binary, fakeMountSource], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(build.status, 0, `synthetic mount fixture must compile: ${build.stderr}`);
    const result = spawnSync(binary, ['/Library'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2);
    const body = JSON.parse(result.stdout) as Result;
    assert.equal(body.state, 'refused');
    assert.ok(body.reasons.includes('untrusted_mount_owner'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P59 ownership-ignored APFS is refused even when its visible files look root-owned', macOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe59-noowners-'));
  try {
    const binary = join(root, 'fake-noowners-observer');
    const build = spawnSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-DPIPE59_TEST_NOOWNERS', '-o', binary, fakeMountSource], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(build.status, 0, `synthetic noowners fixture must compile: ${build.stderr}`);
    const result = spawnSync(binary, ['/Library'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2);
    const body = JSON.parse(result.stdout) as Result;
    assert.equal(body.state, 'refused');
    assert.ok(body.reasons.includes('ownership_ignored'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P59 a protected-looking special leaf is refused before openat', macOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'pipe59-special-'));
  try {
    const binary = join(root, 'fake-special-observer');
    const build = spawnSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-o', binary, fakeSpecialSource], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(build.status, 0, `synthetic special-leaf fixture must compile: ${build.stderr}`);
    const result = spawnSync(binary, ['/Library'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2, 'status 99 means openat was called on the special leaf');
    const body = JSON.parse(result.stdout) as Result;
    assert.equal(body.state, 'refused');
    assert.ok(body.reasons.includes('special_file'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P59 a failed stdout write cannot return candidate', macOnly, () => withObserver((_observe, binary) => {
  const unreadableOutput = openSync('/Library', 'r');
  try {
    const result = spawnSync(binary, ['/Library'], { stdio: ['ignore', unreadableOutput, 'pipe'], timeout: 5000 });
    assert.notEqual(result.status, 0, 'candidate exit is unsafe when JSON could not be delivered');
  } finally { closeSync(unreadableOutput); }
}));

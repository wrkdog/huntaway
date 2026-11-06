/** Lead acceptance for an inert owner-user path diagnostic; not installation proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Result = { schemaVersion: number; state: 'candidate' | 'refused' | 'unknown'; reasons: string[] };
const macOnly = { skip: process.platform !== 'darwin' };
const source = fileURLToPath(new URL('../native/protected-path-observer.c', import.meta.url));
const syntheticMount = fileURLToPath(new URL('./fixtures/pipe59-owner-user-mount.c', import.meta.url));

function withObserver(run: (observe: (args: string[]) => { code: number | null; body: Result }, root: string) => void,
  buildSource = source, defines: string[] = []): void {
  const root = mkdtempSync(join(tmpdir(), 'pipe59-owner-user-'));
  try {
    const binary = join(root, 'observer');
    const build = spawnSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', ...defines, '-o', binary, buildSource],
      { encoding: 'utf8', timeout: 30_000 });
    assert.equal(build.status, 0, `diagnostic must compile: ${build.stderr}`);
    const observe = (args: string[]) => {
      const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
      assert.equal(result.error, undefined, 'diagnostic must terminate');
      assert.equal(result.stderr, '', 'diagnostic must not leak host paths to stderr');
      assert.ok(result.stdout.length < 1024, 'diagnostic output must stay bounded');
      const body = JSON.parse(result.stdout) as Result;
      assert.deepEqual(Object.keys(body).sort(), ['reasons', 'schemaVersion', 'state']);
      assert.equal(body.schemaVersion, 1);
      assert.ok(['candidate', 'refused', 'unknown'].includes(body.state));
      assert.ok(Array.isArray(body.reasons) && body.reasons.every(reason => /^[a-z_]+$/.test(reason)));
      for (const arg of args) assert.ok(!result.stdout.includes(arg), 'path and mode arguments stay out of output');
      return { code: result.status, body };
    };
    run(observe, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('P59-U1 explicit owner-user mode accepts this user home on ownership-enforced APFS', macOnly,
  () => withObserver(observe => {
    const result = observe(['--owner-user', homedir()]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.body, { schemaVersion: 1, state: 'candidate', reasons: [] });
  }));

test('P59-U2 root-only default is not silently relaxed by owner-user mode', macOnly,
  () => withObserver(observe => {
    const original = observe([homedir()]);
    assert.equal(original.code, 2);
    assert.ok(original.body.reasons.includes('not_root_owned'));
    const malformed = observe(['--owner-user']);
    assert.equal(malformed.code, 2);
    assert.ok(malformed.body.reasons.includes('invalid_path'));
    const unknownMode = observe(['--other-mode', homedir()]);
    assert.equal(unknownMode.code, 2);
    assert.ok(unknownMode.body.reasons.includes('invalid_path'));
  }));

test('P59-U3 owner-user mode refuses the real noowners work volume',
  { skip: process.platform !== 'darwin' || !process.env.PIPE_TEST_NOOWNERS_ROOT },
  () => withObserver(observe => {
    const result = observe(['--owner-user', process.env.PIPE_TEST_NOOWNERS_ROOT!]);
    assert.equal(result.code, 2);
    assert.equal(result.body.state, 'refused');
    assert.ok(result.body.reasons.includes('ownership_ignored'),
      `observed reasons: ${result.body.reasons.join(',')}`);
  }));

test('P59-U4 owner-user mode still refuses another owner, linked path and writable leaf', macOnly,
  () => withObserver(observe => {
    const anotherOwner = observe(['--owner-user', '/Library']);
    assert.equal(anotherOwner.code, 2);
    assert.ok(anotherOwner.body.reasons.includes('untrusted_path_owner'));
    const linked = observe(['--owner-user', '/tmp']);
    assert.equal(linked.code, 2);
    assert.ok(linked.body.reasons.includes('symlink'));
    const writable = observe(['--owner-user', '/private/tmp']);
    assert.equal(writable.code, 2);
    assert.ok(writable.body.reasons.includes('writable_leaf'));
  }));

test('P59-U5 a user-owned APFS mount is not a protected candidate even for owner-user mode', macOnly,
  () => withObserver(observe => {
    const result = observe(['--owner-user', homedir()]);
    assert.equal(result.code, 2);
    assert.ok(result.body.reasons.includes('untrusted_mount_owner'));
  }, syntheticMount, ['-DPIPE59_TEST_USER_MOUNT']));

test('P59-U6 synthetic enforced APFS keeps owner-user mode and each write refusal causal', macOnly,
  () => withObserver((observe, root) => {
    const safe = join(root, 'safe');
    writeFileSync(safe, 'disposable fixture', { mode: 0o600 });
    assert.equal(observe(['--owner-user', safe]).code, 0, 'clean owner-user regular file is a candidate');
    chmodSync(safe, 0o620);
    const writable = observe(['--owner-user', safe]);
    assert.equal(writable.code, 2);
    assert.ok(writable.body.reasons.includes('writable_leaf'));
    chmodSync(safe, 0o600);
    const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow write', safe], { encoding: 'utf8', timeout: 5000 });
    assert.equal(grant.status, 0, `ACL fixture failed: ${grant.stderr}`);
    const acl = observe(['--owner-user', safe]);
    assert.equal(acl.code, 2);
    assert.ok(acl.body.reasons.includes('acl_write_allow'));
    const writableDir = join(root, 'writable');
    mkdirSync(writableDir, { mode: 0o770 });
    chmodSync(writableDir, 0o770);
    const beneath = join(writableDir, 'leaf');
    writeFileSync(beneath, 'disposable fixture', { mode: 0o600 });
    const ancestor = observe(['--owner-user', beneath]);
    assert.equal(ancestor.code, 2);
    assert.ok(ancestor.body.reasons.includes('writable_ancestor'));
  }, syntheticMount));

test('P59-U7 owner-user mode refuses synthetic ignored ownership and non-APFS mounts', macOnly,
  () => {
    withObserver(observe => {
      const result = observe(['--owner-user', homedir()]);
      assert.equal(result.code, 2);
      assert.ok(result.body.reasons.includes('ownership_ignored'));
    }, syntheticMount, ['-DPIPE59_TEST_NOOWNERS']);
    withObserver(observe => {
      const result = observe(['--owner-user', homedir()]);
      assert.equal(result.code, 2);
      assert.ok(result.body.reasons.includes('not_apfs'));
    }, syntheticMount, ['-DPIPE59_TEST_NON_APFS']);
  });

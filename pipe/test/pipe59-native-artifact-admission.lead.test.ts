/**
 * U19A native C interface (source linked through a test-only syscall fixture):
 * int pipe_admit_artifact(int source_fd, uint64_t exact_size,
 *   const uint8_t independent_sha256[32], const char *protected_parent,
 *   const char *fresh_stage_name, int report_fd);
 * The caller inherits an already-open source FD; the primitive never opens a
 * source pathname. It returns 0 only after exact destination verification and
 * file/parent sync, 2 for refusal, or 3 for uncertainty. It writes one bounded
 * JSON object to report_fd with state admitted/refused/uncertain and a reason;
 * report failure returns nonzero. This is an inert stage, never publication.
 * The linked fixture simulates protected path facts for source testing only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const macOnly = { skip: process.platform !== 'darwin' };
const fixture = fileURLToPath(new URL('./fixtures/pipe59-artifact-admission.c', import.meta.url));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const original = Buffer.from('inert U19A candidate bytes\x00with an exact pin\n');
type Report = { state: 'admitted' | 'refused' | 'uncertain'; reason: string };

test('P59 U19A linked native artifact admission contract', macOnly, async t => {
  assert.ok(process.env.TMPDIR, 'lead must supply the external test TMPDIR');
  assert.equal(tmpdir(), process.env.TMPDIR.replace(/\/$/, ''), 'fixtures must use the supplied TMPDIR');
  const root = mkdtempSync(join(tmpdir(), 'pipe59-artifact-'));
  try {
    const binary = join(root, 'admission-test');
    const build = spawnSync('/usr/bin/cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
      '-o', binary, fixture], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4096 });
    assert.equal(build.status, 0, `native admission source must compile with test-only shims: ${build.stderr}`);
    const symbols = spawnSync('/usr/bin/nm', ['-u', binary], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    assert.equal(symbols.status, 0, `inspect native unresolved symbols: ${symbols.stderr}`);
    assert.doesNotMatch(symbols.stdout, /\b_(?:execve|posix_spawn|system|popen|dlopen)\b/,
      'admission must not link a candidate-execution primitive');

    function run(name: string, scenario: string, source = original, pin = digest(original),
      preexisting?: Buffer, stageName = 'fresh-stage', expectedSize = source.length,
      replaceSourcePath = false) {
      const caseRoot = join(root, name);
      const parent = join(caseRoot, 'protected');
      if (scenario === 'symlink_ancestor') {
        mkdirSync(caseRoot, { recursive: true });
        const outside = join(caseRoot, 'outside');
        mkdirSync(outside);
        symlinkSync(outside, parent);
      } else mkdirSync(parent, { recursive: true });
      const sourcePath = join(caseRoot, 'input');
      const stage = join(parent, stageName);
      writeFileSync(sourcePath, source);
      if (name === 'digest-mismatch') writeFileSync(join(caseRoot, 'input.sha256'), digest(source));
      if (preexisting) writeFileSync(stage, preexisting);
      if (scenario === 'stage_symlink' || scenario === 'dangling_stage_symlink') {
        const outside = join(caseRoot, 'outside-stage');
        if (scenario === 'stage_symlink') writeFileSync(outside, 'keep outside stage');
        symlinkSync(outside, stage);
      }
      const sourceFd = openSync(sourcePath, scenario === 'source_flip_during_copy' ? 'r+' : 'r');
      try {
        if (replaceSourcePath) {
          renameSync(sourcePath, join(caseRoot, 'held-original'));
          writeFileSync(sourcePath, 'attacker-replaced pathname');
        }
        const result = spawnSync(binary, [parent, stageName, String(expectedSize), pin], {
          env: { ...process.env, PIPE59_CASE: scenario },
          stdio: ['ignore', 'pipe', 'pipe', sourceFd], encoding: 'utf8', timeout: 5000, maxBuffer: 1024,
        });
        assert.equal(result.error, undefined, `${name}: bounded native call must terminate`);
        assert.ok(result.stdout.length <= 512 && result.stderr.length <= 512, `${name}: bounded output`);
        assert.equal(result.stderr, '', `${name}: no host data on stderr`);
        const report = result.stdout ? JSON.parse(result.stdout) as Report : undefined;
        if (report) {
          assert.deepEqual(Object.keys(report).sort(), ['reason', 'state']);
          assert.match(report.reason, /^[a-z_]+$/);
        }
        return { result, report, stage };
      } finally { closeSync(sourceFd); }
    }

    await t.test('positive synthetic protected parent admits exact inert bytes', () => {
      const { result, report, stage } = run('positive', 'safe');
      assert.equal(result.status, 0);
      assert.deepEqual(report, { state: 'admitted', reason: 'ok' });
      assert.deepEqual(readFileSync(stage), original);
      assert.equal(statSync(stage).mode & 0o777, 0o400, 'protected staged bytes are read-only and never executable');
    });

    await t.test('one short destination write is completed exactly', () => {
      const { result, report, stage } = run('short-success', 'short_write');
      assert.equal(result.status, 0);
      assert.deepEqual(report, { state: 'admitted', reason: 'ok' });
      assert.deepEqual(readFileSync(stage), original);
    });

    await t.test('source pathname replacement cannot redirect the inherited descriptor', () => {
      const { result, report, stage } = run('source-path-replaced', 'safe', original,
        digest(original), undefined, 'fresh-stage', original.length, true);
      assert.equal(result.status, 0);
      assert.deepEqual(report, { state: 'admitted', reason: 'ok' });
      assert.deepEqual(readFileSync(stage), original);
    });

    await t.test('independent digest beats a forged sibling value', () => {
      const altered = Buffer.from(original);
      altered[10] = altered[10]! ^ 1;
      const mismatch = run('digest-mismatch', 'safe', altered);
      assert.equal(mismatch.result.status, 2);
      assert.equal(mismatch.report?.state, 'refused');
      assert.match(mismatch.report?.reason ?? '', /digest|pin/);
    });

    await t.test('equal-length source forgery cannot satisfy the pin', () => {
      const forged = Buffer.from(original);
      forged[forged.length - 2] = forged[forged.length - 2]! ^ 1;
      assert.equal(forged.length, original.length);
      const { result, report } = run('equal-length', 'safe', forged);
      assert.equal(result.status, 2);
      assert.equal(report?.state, 'refused');
    });

    await t.test('source mutation after the first hash is caught by the copied digest', () => {
      const { result, report, stage } = run('source-flips', 'source_flip_during_copy');
      assert.equal(result.status, 3);
      assert.deepEqual(report, { state: 'uncertain', reason: 'source_changed' });
      assert.notDeepEqual(readFileSync(stage), original);
    });

    await t.test('destination corruption after copy is caught by rehash', () => {
      const { result, report, stage } = run('dest-corrupts', 'dest_corrupt_after_copy');
      assert.equal(result.status, 3);
      assert.deepEqual(report, { state: 'uncertain', reason: 'destination_digest' });
      assert.notDeepEqual(readFileSync(stage), original);
    });

    await t.test('independently supplied exact size is enforced', () => {
      const { result, report } = run('size-mismatch', 'safe', original, digest(original), undefined,
        'fresh-stage', original.length + 1);
      assert.equal(result.status, 2);
      assert.equal(report?.state, 'refused');
    });

    await t.test('invalid stage names are rejected before path access', () => {
      for (const [index, name] of ['../escape', 'bad/name', '.', '', 'bad\nname', 'bad\u0001name'].entries()) {
        const { result, report } = run(`invalid-stage-${index}`,
          'safe', original, digest(original), undefined, name);
        assert.equal(result.status, 2, `invalid name ${JSON.stringify(name)}`);
        assert.equal(report?.state, 'refused');
        assert.equal(report?.reason, 'invalid_stage_name',
          `only the stage name is malformed for ${JSON.stringify(name)}`);
      }
    });

    await t.test('special source FD is refused before any read', () => {
      const { result, report, stage } = run('special', 'special_source');
      assert.equal(result.status, 2, 'fixture exits 94 if source FD is read');
      assert.equal(report?.state, 'refused');
      assert.equal(existsSync(stage), false);
    });

    await t.test('existing destination sentinel is never replaced', () => {
      const sentinel = Buffer.from('keep existing bytes');
      const { result, report, stage } = run('collision', 'safe', original, digest(original), sentinel);
      assert.equal(result.status, 2);
      assert.equal(report?.state, 'refused');
      assert.deepEqual(readFileSync(stage), sentinel);
    });

    for (const scenario of ['unsafe_ancestor', 'unknown_ancestor', 'unsafe_parent', 'unknown_parent',
      'unsafe_mount', 'unknown_mount', 'unsafe_acl', 'unknown_acl',
      'unsafe_middle', 'unknown_middle', 'unsafe_mount_middle', 'unknown_mount_middle',
      'unsafe_acl_middle', 'unknown_acl_middle']) {
      await t.test(`${scenario} blocks before mutation`, () => {
        const { result, report, stage } = run(scenario, scenario);
        assert.ok(result.status === 2 || result.status === 3, `${scenario}: ${result.status}`);
        assert.ok(report?.state === 'refused' || report?.state === 'uncertain');
        assert.equal(existsSync(stage), false);
      });
    }

    await t.test('a symlinked parent cannot redirect the stage into its target', () => {
      const { result, report, stage } = run('symlink-ancestor', 'symlink_ancestor');
      assert.equal(result.status, 2);
      assert.equal(report?.state, 'refused');
      assert.equal(existsSync(stage), false);
    });

    await t.test('an occupied stage symlink is never followed or replaced', () => {
      const { result, report, stage } = run('stage-symlink', 'stage_symlink');
      assert.equal(result.status, 2);
      assert.equal(report?.state, 'refused');
      assert.equal(readFileSync(join(root, 'stage-symlink', 'outside-stage'), 'utf8'), 'keep outside stage');
      assert.equal(existsSync(stage), true, 'the existing link remains');
    });

    await t.test('a dangling stage symlink is not mistaken for a fresh name', () => {
      const { result, report, stage } = run('stage-dangling', 'dangling_stage_symlink');
      assert.equal(result.status, 2);
      assert.equal(report?.state, 'refused');
      assert.equal(lstatSync(stage).isSymbolicLink(), true, 'the link remains unresolved');
      assert.equal(existsSync(join(root, 'stage-dangling', 'outside-stage')), false);
    });

    await t.test('a stage with another name outside the protected parent is not admitted', () => {
      const { result, report, stage } = run('extra-hardlink', 'extra_hardlink');
      assert.notEqual(result.status, 0);
      assert.equal(report?.state, 'uncertain', 'created bytes have uncertain ownership of names');
      assert.equal(report?.reason, 'destination_stat');
      assert.deepEqual(readFileSync(stage), original);
      assert.deepEqual(readFileSync(`${join(stage, '..')}.alias`), original);
    });

    await t.test('a searchable parent is refused before a late external hard link can be added', () => {
      const { result, report, stage } = run('late-hardlink', 'late_hardlink');
      assert.equal(result.status, 2);
      assert.deepEqual(report, { state: 'refused', reason: 'stage_parent_private' });
      assert.equal(existsSync(stage), false, 'no stage was written under a searchable parent');
      assert.equal(existsSync(`${join(stage, '..')}.alias`), false);
    });

    await t.test('a parent ACL granting search is refused before writing', () => {
      const { result, report, stage } = run('search-acl-parent', 'search_acl_parent');
      assert.equal(result.status, 2);
      assert.deepEqual(report, { state: 'refused', reason: 'stage_parent_private' });
      assert.equal(existsSync(stage), false);
    });

    await t.test('an inherited destination write ACL is not admitted as protected', () => {
      const { result, report } = run('inherited-acl', 'inherited_acl');
      assert.notEqual(result.status, 0);
      assert.notEqual(report?.state, 'admitted');
      assert.equal(report?.reason, 'destination_proof');
    });

    await t.test('parent protection changing during copy is rechecked before admission', () => {
      const { result, report } = run('parent-flip', 'parent_flip');
      assert.notEqual(result.status, 0);
      assert.notEqual(report?.state, 'admitted');
      assert.equal(report?.reason, 'parent_changed');
    });

    await t.test('a detached parent path is not reported as the intended protected stage', () => {
      const { result, report, stage } = run('parent-detached', 'parent_detached');
      assert.notEqual(result.status, 0);
      assert.notEqual(report?.state, 'admitted');
      assert.equal(report?.reason, 'parent_detached');
      assert.equal(existsSync(stage), false, 'the named path now points to a different directory');
      assert.equal(existsSync(`${join(stage, '..')}.detached/fresh-stage`), true,
        'uncertain bytes remain identifiable under the detached directory');
    });

    await t.test('an oversized inherited source is refused before any read', () => {
      const { result, report, stage } = run('oversize', 'oversize', original, digest(original),
        undefined, 'fresh-stage', 512 * 1024 * 1024 + 1);
      assert.equal(result.status, 2, 'fixture exits 98 if the oversized source is read');
      assert.equal(report?.state, 'refused');
      assert.equal(existsSync(stage), false);
    });

    for (const scenario of ['zero_write', 'failed_write', 'short_then_failed_write']) {
      await t.test(`${scenario} cannot report success or hang`, () => {
        const { result, report } = run(scenario, scenario);
        assert.notEqual(result.status, 0);
        assert.notEqual(report?.state, 'admitted');
      });
    }

    for (const scenario of ['failed_file_sync', 'failed_parent_sync', 'failed_output']) {
      await t.test(`${scenario} retains uncertain protected bytes`, () => {
        const { result, report, stage } = run(scenario, scenario);
        assert.notEqual(result.status, 0);
        assert.notEqual(report?.state, 'admitted');
        assert.deepEqual(readFileSync(stage), original);
        if (scenario === 'failed_output') assert.equal(report, undefined);
        else assert.equal(report?.state, 'uncertain');
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

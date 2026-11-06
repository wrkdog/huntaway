/** Lead-owned Darwin control for U18's no-source-symlink promise. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePinnedPayload } from '../src/release-copy.ts';

const macOnly = { skip: process.platform !== 'darwin' };
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
// The source fixture belongs on the external work volume, like the untrusted release source.
const fixtureParent = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));

test('U18 Darwin kernel refuses a linked parent that O_NOFOLLOW alone accepts', macOnly, () => {
  const root = realpathSync.native(mkdtempSync(join(fixtureParent, '.pipe-u18-any-')));
  try {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real/file'), 'pinned');
    symlinkSync('real', join(root, 'link'));
    const path = join(root, 'link/file');
    assert.equal(readFileSync(path, 'utf8'), 'pinned', 'the linked-parent fixture is reachable');
    const leafOnly = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    closeSync(leafOnly);
    const anyFlags = constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000;
    const cleanAny = openSync(join(root, 'real/file'), anyFlags);
    closeSync(cleanAny);
    // The clean open rules out an unsupported flag; refusal on the linked path is the invariant.
    assert.throws(() => openSync(path, anyFlags),
      (error: unknown) => ['ELOOP', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? ''));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('U18 source parent swapped to symlink after lstat never stages a success', macOnly, () => {
  const root = realpathSync.native(mkdtempSync(join(fixtureParent, '.pipe-u18-race-')));
  const sourceRoot = join(root, 'source');
  const stageParent = join(root, 'stages');
  const sourceDir = join(sourceRoot, 'dir');
  const content = 'approved bytes\n';
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(join(sourceRoot, 'alternate'));
  mkdirSync(stageParent);
  writeFileSync(join(sourceDir, 'cli.ts'), content);
  writeFileSync(join(sourceRoot, 'alternate/cli.ts'), content);
  const inventoryBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files: [{
    path: 'dir/cli.ts', sha256: sha(content), size: Buffer.byteLength(content),
  }] }));
  const mutableFs = fs as unknown as { lstatSync: typeof fs.lstatSync };
  const original = mutableFs.lstatSync;
  let swapped = false;
  try {
    mutableFs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = original(...args);
      if (!swapped && String(args[0]) === sourceDir) {
        swapped = true;
        renameSync(sourceDir, join(sourceRoot, 'moved'));
        symlinkSync('alternate', sourceDir);
      }
      return stat;
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    let error: unknown;
    try { stagePinnedPayload({ sourceRoot, stageParent, inventoryBytes, expectedInventorySha256: sha(inventoryBytes) }); }
    catch (caught) { error = caught; }
    assert.equal(swapped, true, 'the directory was replaced after its successful lstat');
    assert.equal(readFileSync(join(sourceDir, 'cli.ts'), 'utf8'), content, 'the linked-parent path stayed readable');
    assert.equal((error as NodeJS.ErrnoException | undefined)?.code, 'ELOOP', 'the source open must refuse the linked parent');
    assert.deepEqual(readdirSync(stageParent), [], 'no staging directory survives refusal');
  } finally {
    mutableFs.lstatSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

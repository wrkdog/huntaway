/** Lead acceptance for U18's inert copy only; protected publication is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { stagePinnedPayload } from '../src/release-copy.ts';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const macOnly = { skip: process.platform !== 'darwin' };
type Entry = { path: string; sha256: string; size: number };
const inventory = (files: Entry[]) => Buffer.from(JSON.stringify({ schemaVersion: 1, files }), 'utf8');

test('U18 size budget belongs to the inert copier, not the U1/U2 core', () => {
  const source = readFileSync(new URL('../src/release-copy.ts', import.meta.url), 'utf8');
  const lines = source.split('\n').filter(line => line.trim()).length;
  assert.ok(lines <= 200, `release copier has ${lines} non-blank lines; its budget is 200`);
});

function fixture(run: (sourceRoot: string, stageParent: string, root: string) => void): void {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pipe-u18-pinned-')));
  const sourceRoot = join(root, 'source'), stageParent = join(root, 'stages');
  mkdirSync(sourceRoot);
  mkdirSync(stageParent);
  try { run(sourceRoot, stageParent, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('U18-1 a clean pinned inventory copies exact bytes into fresh inert files', macOnly, () => fixture((sourceRoot, stageParent, root) => {
  mkdirSync(join(sourceRoot, 'bin'));
  mkdirSync(join(sourceRoot, 'src'));
  const node = Buffer.from('#!/bin/sh\nprintf unexpected > "$1"\n');
  const cli = Buffer.from('export const releaseFixture = true;\n');
  writeFileSync(join(sourceRoot, 'bin/node'), node, { mode: 0o700 });
  writeFileSync(join(sourceRoot, 'src/cli.ts'), cli);
  const bytes = inventory([
    { path: 'bin/node', sha256: sha(node), size: node.length },
    { path: 'src/cli.ts', sha256: sha(cli), size: cli.length },
  ]);
  const expected = sha(bytes);
  const copied = stagePinnedPayload({ sourceRoot, stageParent, inventoryBytes: bytes, expectedInventorySha256: expected });
  assert.equal(copied.inventorySha256, expected);
  assert.equal(relative(stageParent, copied.stagingDir).startsWith(`..${sep}`), false);
  assert.notEqual(copied.stagingDir, stageParent);
  for (const [path, content] of [['bin/node', node], ['src/cli.ts', cli]] as const) {
    const file = join(copied.stagingDir, path);
    assert.deepEqual(readFileSync(file), content);
    assert.equal(lstatSync(file).mode & 0o777, 0o400, 'staged bytes are never executable');
  }
  assert.equal(existsSync(join(root, 'unexpected')), false, 'no source executable ran');
}));

test('U18-2 a forged sibling inventory loses to the independent digest before source access', () => fixture((_sourceRoot, stageParent, root) => {
  const clean = inventory([{ path: 'src/cli.ts', sha256: sha('approved'), size: 8 }]);
  const forged = inventory([{ path: 'src/cli.ts', sha256: sha('attacker'), size: 8 }]);
  assert.throws(() => stagePinnedPayload({
    sourceRoot: join(root, 'source-does-not-exist'), stageParent,
    inventoryBytes: forged, expectedInventorySha256: sha(clean),
  }), /inventory digest mismatch/);
  assert.deepEqual(readdirSync(stageParent), [], 'untrusted inventory was rejected before staging');
}));

test('U18-3 changed payload bytes cannot be published under the pinned inventory', macOnly, () => fixture((sourceRoot, stageParent, root) => {
  mkdirSync(join(sourceRoot, 'src'));
  const approved = 'approved source\n';
  const changed = 'require("fs").writeFileSync("' + join(root, 'executed') + '","bad");\n';
  writeFileSync(join(sourceRoot, 'src/cli.ts'), changed);
  const bytes = inventory([{ path: 'src/cli.ts', sha256: sha(approved), size: Buffer.byteLength(approved) }]);
  assert.throws(() => stagePinnedPayload({
    sourceRoot, stageParent, inventoryBytes: bytes, expectedInventorySha256: sha(bytes),
  }), /payload.*(digest|size)|(?:digest|size).*payload/i);
  assert.deepEqual(readdirSync(stageParent), [], 'no partial release is published');
  assert.equal(existsSync(join(root, 'executed')), false, 'no payload executed before refusal');
}));

test('U18-4 a symlink is refused even when its target has the pinned bytes', macOnly, () => fixture((sourceRoot, stageParent) => {
  mkdirSync(join(sourceRoot, 'src'));
  const content = 'same approved bytes\n';
  writeFileSync(join(sourceRoot, 'src/target.ts'), content);
  symlinkSync('target.ts', join(sourceRoot, 'src/cli.ts'));
  const bytes = inventory([{ path: 'src/cli.ts', sha256: sha(content), size: Buffer.byteLength(content) }]);
  assert.throws(() => stagePinnedPayload({
    sourceRoot, stageParent, inventoryBytes: bytes, expectedInventorySha256: sha(bytes),
  }), /symlink|regular/i);
  assert.deepEqual(readdirSync(stageParent), []);
}));

test('U18-5 unsafe and duplicate manifest paths are refused before any source read', () => fixture((_sourceRoot, stageParent, root) => {
  const valid = { path: 'src/cli.ts', sha256: sha('x'), size: 1 };
  for (const files of [
    [{ ...valid, path: '../escape' }],
    [{ ...valid, path: '/absolute' }],
    [valid, valid],
    [{ ...valid, path: 'src//cli.ts' }],
    [{ ...valid, path: 'src\\cli.ts' }],
  ]) {
    const bytes = inventory(files);
    assert.throws(() => stagePinnedPayload({
      sourceRoot: join(root, 'source-does-not-exist'), stageParent,
      inventoryBytes: bytes, expectedInventorySha256: sha(bytes),
    }), /inventory|path|duplicate/i);
    assert.deepEqual(readdirSync(stageParent), []);
  }
}));

test('U18-6 unsupported hosts refuse a valid inventory before source access', { skip: process.platform === 'darwin' }, () => fixture((_sourceRoot, stageParent, root) => {
  const bytes = inventory([]);
  assert.throws(() => stagePinnedPayload({
    sourceRoot: join(root, 'source-does-not-exist'), stageParent,
    inventoryBytes: bytes, expectedInventorySha256: sha(bytes),
  }), /unsupported|Darwin/i);
  assert.deepEqual(readdirSync(stageParent), []);
}));

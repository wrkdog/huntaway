import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';

type FileEntry = { path: string; sha256: string; size: number };
const MAX_INVENTORY = 4 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const CHUNK = 64 * 1024;
const O_NOFOLLOW_ANY = 0x20000000;
const hexDigest = /^[0-9a-f]{64}$/;

function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

// JSON.parse accepts repeated object keys. The inventory must have one unambiguous
// value for each key, so parse the small JSON grammar with duplicate detection.
function parseJson(text: string): unknown {
  let i = 0;
  const scalar = /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
  const space = () => { while (i < text.length && /[\t\n\r ]/.test(text[i]!)) i++; };
  const string = (): string => {
    if (text[i] !== '"') throw new Error('invalid inventory JSON');
    const start = i++;
    while (i < text.length) {
      const char = text[i++]!;
      if (char === '"') return JSON.parse(text.slice(start, i)) as string;
      if (char === '\\') i++;
      else if (char.charCodeAt(0) < 32) throw new Error('invalid inventory JSON');
    }
    throw new Error('invalid inventory JSON');
  };
  const value = (depth: number): unknown => {
    if (depth > 4) throw new Error('invalid inventory JSON');
    space();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; space();
      const result: Record<string, unknown> = Object.create(null);
      if (text[i] === '}') { i++; return result; }
      while (true) {
        space();
        const key = string();
        if (Object.hasOwn(result, key)) throw new Error('invalid inventory JSON');
        space();
        if (text[i++] !== ':') throw new Error('invalid inventory JSON');
        result[key] = value(depth + 1);
        space();
        const end = text[i++];
        if (end === '}') return result;
        if (end !== ',') throw new Error('invalid inventory JSON');
      }
    }
    if (text[i] === '[') {
      i++; space();
      const result: unknown[] = [];
      if (text[i] === ']') { i++; return result; }
      while (true) {
        result.push(value(depth + 1));
        space();
        const end = text[i++];
        if (end === ']') return result;
        if (end !== ',') throw new Error('invalid inventory JSON');
      }
    }
    scalar.lastIndex = i;
    const token = scalar.exec(text);
    if (!token) throw new Error('invalid inventory JSON');
    i += token[0].length;
    return JSON.parse(token[0]) as unknown;
  };
  const result = value(0);
  space();
  if (i !== text.length) throw new Error('invalid inventory JSON');
  return result;
}

function inventoryFiles(bytes: Buffer): FileEntry[] {
  if (bytes.length > MAX_INVENTORY) throw new Error('inventory too large');
  let parsed: unknown;
  try { parsed = parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw new Error('invalid inventory JSON'); }
  if (!object(parsed, ['schemaVersion', 'files']) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)
      || parsed.files.length > MAX_FILES) throw new Error('invalid inventory');
  let previous: string | undefined;
  let total = 0;
  const files: FileEntry[] = [];
  for (const item of parsed.files) {
    if (!object(item, ['path', 'sha256', 'size']) || typeof item.path !== 'string'
        || typeof item.sha256 !== 'string' || !hexDigest.test(item.sha256)
        || typeof item.size !== 'number' || !Number.isSafeInteger(item.size)
        || item.size < 0 || item.size > MAX_FILE)
      throw new Error('invalid inventory entry');
    const path = item.path;
    const parts = path.split('/');
    if (!path || Buffer.from(path).toString('utf8') !== path
        || Buffer.byteLength(path, 'utf8') > 1024 || parts.length > 64
        || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)
        || /[\\\u0000-\u001f\u007f]/.test(path) || path.startsWith('/'))
      throw new Error('invalid inventory path');
    if (previous !== undefined && (Buffer.compare(Buffer.from(previous), Buffer.from(path)) >= 0
        || path.startsWith(`${previous}/`))) throw new Error('duplicate or unsorted inventory path');
    previous = path;
    total += item.size;
    if (total > MAX_TOTAL) throw new Error('inventory payload too large');
    files.push({ path, sha256: item.sha256, size: item.size });
  }
  return files;
}

function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('source component is not a regular directory');
}

function copyFile(source: string, destination: string, entry: FileEntry): void {
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('source is not a regular file or is a symlink');
  let input = -1;
  let output = -1;
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY);
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error('source is not a regular file');
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    const buffer = Buffer.allocUnsafe(CHUNK);
    let copied = 0;
    while (true) {
      const count = readSync(input, buffer, 0, Math.min(CHUNK, entry.size - copied + 1), null);
      if (count === 0) break;
      copied += count;
      if (copied > entry.size) throw new Error('payload size mismatch');
      let written = 0;
      while (written < count) written += writeSync(output, buffer, written, count - written);
    }
    if (copied !== entry.size) throw new Error('payload size mismatch');
    fchmodSync(output, 0o400);
  } finally {
    if (output !== -1) closeSync(output);
    if (input !== -1) closeSync(input);
  }
  let verified = -1;
  try {
    verified = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(verified);
    if (!stat.isFile() || stat.size !== entry.size || (stat.mode & 0o777) !== 0o400)
      throw new Error('payload size or mode mismatch');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK);
    let read = 0;
    while (true) {
      const count = readSync(verified, buffer, 0, buffer.length, null);
      if (count === 0) break;
      read += count;
      if (read > entry.size) throw new Error('payload size mismatch');
      hash.update(buffer.subarray(0, count));
    }
    if (read !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('payload digest or size mismatch');
  } finally { if (verified !== -1) closeSync(verified); }
}

export function stagePinnedPayload(input: {
  sourceRoot: string;
  stageParent: string;
  inventoryBytes: Buffer;
  expectedInventorySha256: string;
}): { stagingDir: string; inventorySha256: string } {
  const actual = createHash('sha256').update(input.inventoryBytes).digest();
  if (!hexDigest.test(input.expectedInventorySha256)
      || !timingSafeEqual(actual, Buffer.from(input.expectedInventorySha256, 'hex')))
    throw new Error('inventory digest mismatch');
  const files = inventoryFiles(input.inventoryBytes);
  const major = process.platform === 'darwin' ? /^([0-9]+)\.[0-9]+\.[0-9]+$/.exec(release())?.[1] : undefined;
  if (major === undefined || !Number.isSafeInteger(Number(major)) || Number(major) < 20)
    throw new Error('unsupported Darwin host');
  directory(input.sourceRoot);
  directory(input.stageParent);
  let stagingDir: string | undefined;
  try {
    stagingDir = mkdtempSync(join(input.stageParent, 'pipe-release-'));
    for (const entry of files) {
      const components = entry.path.split('/');
      let sourceDir = input.sourceRoot;
      let targetDir = stagingDir;
      for (const component of components.slice(0, -1)) {
        sourceDir = join(sourceDir, component);
        directory(sourceDir);
        targetDir = join(targetDir, component);
        mkdirSync(targetDir, { mode: 0o700, recursive: true });
      }
      const name = components[components.length - 1]!;
      copyFile(join(sourceDir, name), join(targetDir, name), entry);
    }
    return { stagingDir, inventorySha256: actual.toString('hex') };
  } catch (error) {
    if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

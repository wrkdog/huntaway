/** Bounded classification of saved work and disposable ignored directories. */
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { readdir, lstat, readFile, realpath, statfs as volumeStatfs } from 'node:fs/promises';
import type { Store } from './store.ts';
import { join, basename } from 'node:path';
import { runGit, tempRetryDelayMs, worktreeDisk, type HousekeepingConfig, type DiskStatfs } from './disk.ts';
export const tempChild = (id: string): boolean => id !== '' && id !== '.' && id !== '..' && !/[\\/]/.test(id);
export function validateHousekeeping(config: HousekeepingConfig = {}): void {
  for (const [name, value] of [['batch', config.batch ?? 100], ['saveTimeoutMs', config.saveTimeoutMs ?? 120_000], ['removeTimeoutMs', config.removeTimeoutMs ?? 600_000]] as const)
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`housekeeping.${name} must be positive whole units`);
  if ((config.saveTimeoutMs ?? 120_000) < 2000) throw new RangeError('housekeeping.saveTimeoutMs must be at least 2000');
  if (config.regenerable !== undefined && (!Array.isArray(config.regenerable) || config.regenerable.some(p => typeof p !== 'string' || !tempChild(p)))) throw new RangeError('invalid regenerable components');
  for (const key of ['archiveRoot', 'archiveTimeoutMs']) if (key in config) throw new RangeError(`archiving is not available in this version; remove housekeeping.${key}`);
  if (config.tiers !== undefined && (!Array.isArray(config.tiers) || config.tiers.some(t => !t || !Number.isFinite(t.below) || t.below <= 0 || t.below > 1 ||
    !Number.isFinite(t.keepHours) || t.keepHours < 0 || typeof t.name !== 'string' || ['normal', 'unknown'].includes(t.name) || !/^[a-z][a-z0-9_]*$/.test(t.name)))) throw new RangeError('invalid housekeeping tiers');
}
export type Classification = { nested: string[]; ignored: string[]; regenerable: string[] };
export const saveTimeouts = new WeakMap<AbortSignal, number>();
export const pruneSignals = new WeakSet<AbortSignal>();
const gateEntries = new Map<object, number>();
export function pauseForGroup(gone: () => boolean): void {
  gateEntries.set(gone, performance.now());
  const poll = setInterval(() => { if (gone()) { gateEntries.delete(gone); clearInterval(poll); } }, 250);
  poll.unref();
}
export const scansPending = (): boolean => gateEntries.size > 0;
export const housekeepingGate = () => ({ entries: gateEntries.size,
  oldestAgeMs: gateEntries.size ? Math.max(0, performance.now() - Math.min(...gateEntries.values())) : null });
/** Abandoned filesystem scans are read-only; no later pass accesses the volume until they settle. */
export async function scan<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (scansPending()) throw Object.assign(new Error('hung volume'), { hungVolume: true });
  if (signal.aborted) throw gitAbortError();
  const hungScanMs = Math.min(30_000, Math.floor((saveTimeouts.get(signal) ?? 120_000) / 2));
  const token = {}, began = performance.now(); let settled = false, abandoned = false, stop = () => {};
  const work = operation().finally(() => { settled = true; if (abandoned) gateEntries.delete(token); });
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    stop = () => {
      if (!settled) { abandoned = true; gateEntries.set(token, performance.now()); }
      reject(Object.assign(gitAbortError(), abandoned ? { abandoned: true } : {},
        signal.reason?.saveTimeout && !settled && performance.now() - began > hungScanMs ? { hungVolume: true } : {}));
    };
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
  })]); } finally { signal.removeEventListener('abort', stop); }
}
/** Exact roots and ancestor membership, without a quadratic search over ignored paths. */
export function underRoot(path: string, roots: Set<string>): boolean {
  let at = path.replace(/\/$/, '');
  for (;;) { if (roots.has(at)) return true; const slash = at.lastIndexOf('/'); if (slash < 0) return false; at = at.slice(0, slash); }
}
const rootSet = (paths: string[]) => new Set(paths.map(p => p.replace(/\/$/, '')));
const repoMarkers = new Set(['.git', '.hg', '.svn', '.sl', '.bzr', '_darcs', '.fslckout', '_FOSSIL_']);
const ignorableXattrs = new Set(['com.apple.provenance', 'com.apple.quarantine', 'com.apple.lastuseddate#PS', 'com.apple.macl']);
async function xattrs(root: string, paths: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const unlistable = paths.find(p => join(root, p).includes('\n') || join(root, p).includes(': '));
  if (unlistable !== undefined) throw Object.assign(new Error(`extended attributes not listable for ${unlistable || '.'}`), { needsArchive: true });
  const known = paths.map(p => ({ rel: p || '.', full: join(root, p) })).sort((a, b) => b.full.length - a.full.length);
  let output: Buffer;
  try { const result = await runGit(root, ['-s', '-v', ...known.map(p => p.full)], env, signal, undefined,
    { executable: '/usr/bin/xattr', maxOutputBytes: 2 ** 20 });
    if (result.stderr.length) throw new Error('extended attribute listing has stderr');
    output = result.output; }
  catch (e) { if (signal.aborted) throw Object.assign(e as Error, { nonStrike: true }); throw Object.assign(new Error(`extended attribute listing failed: ${message(e)}`), { nonStrike: true, groupClosed: (e as { groupClosed?: boolean })?.groupClosed }); }
  const decoded = output.toString('utf8');
  if (!Buffer.from(decoded).equals(output)) throw Object.assign(new Error('extended attribute listing is not UTF-8'), { nonStrike: true });
  for (const line of decoded.split('\n')) {
    if (!line) continue;
    const match = known.find(p => line.startsWith(p.full + ': '));
    if (!match) throw Object.assign(new Error(`extended attributes not listable for ${paths[0] || '.'}`), { needsArchive: true });
    const name = line.slice(match.full.length + 2);
    if (name.includes(': ') || !ignorableXattrs.has(name)) throw Object.assign(new Error(`extended attribute ${name} on ${match.rel}`), { needsArchive: true });
  }
}
const nulPaths = (bytes: Buffer): Buffer[] => {
  const paths: Buffer[] = []; let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { if (i > start) paths.push(bytes.subarray(start, i)); start = i + 1; }
  if (start !== bytes.length) throw new Error('unterminated git pathname');
  return paths;
};
/** Do not follow links or enter a nested repository; give admission and the save deadline a turn at every directory. */
export async function excludedPaths(root: string, signal: AbortSignal, forkExclusions?: string[], env = process.env): Promise<{ path: string; kind: 'regenerable' | 'nested-repo' }[]> {
  const excluded: { path: string; kind: 'regenerable' | 'nested-repo' }[] = [], pending = [{ path: '', regenerable: false }];
  const disposable = rootSet(forkExclusions ?? []), attributes: string[] = [];
  if (process.platform === 'darwin' && forkExclusions) attributes.push('');
  while (pending.length) {
    await yieldTurn(); if (signal.aborted) throw gitAbortError();
    let { path, regenerable } = pending.pop()!;
    const raw = await scan(() => readdir(join(root, path), { encoding: 'buffer', withFileTypes: true }), signal);
    const entries = [];
    let checked = 0;
    for (const entry of raw) {
      if (++checked % 256 === 0) await yieldTurn(); if (signal.aborted) throw gitAbortError();
      if (!Buffer.from(entry.name.toString('utf8')).equals(entry.name)) throw Object.assign(new Error('pathname is not valid UTF-8'), { needsArchive: true });
      entries.push({ name: entry.name.toString('utf8'), isDirectory: () => entry.isDirectory(), isSymbolicLink: () => entry.isSymbolicLink(), isFile: () => entry.isFile() });
    }
    if (!path) for (const e of entries) if (e.name !== '.git' && repoMarkers.has(e.name)) excluded.push({ path: e.name, kind: 'nested-repo' });
    if (path && (entries.some(e => repoMarkers.has(e.name) || e.name.toLowerCase() === '.git') || entries.some(e => e.name === 'HEAD') && entries.some(e => e.name === 'objects' && e.isDirectory()) && entries.some(e => e.name === 'refs' && e.isDirectory()))) {
      excluded.push({ path, kind: 'nested-repo' }); continue;
    }
    if (!regenerable && REGENERABLE_ALLOWLIST.scratch.test(path)) {
      excluded.push({ path, kind: 'regenerable' }); regenerable = true;
    }
    // Inspect regenerable trees too: an embedded repository still needs its own backup.
    let visited = 0;
    for (const e of entries) {
      if (++visited % 256 === 0) await yieldTurn(); if (signal.aborted) throw gitAbortError();
      const child = path ? `${path}/${e.name}` : e.name;
      if (process.platform === 'darwin' && forkExclusions && e.isFile() && !underRoot(child, disposable)) {
        const fork = await scan(() => lstat(join(root, child, '..namedfork/rsrc')), signal).catch(e => {
          if (['ENOTDIR', 'ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) return null; throw e;
        });
        if (fork && fork.size > 0) throw Object.assign(new Error(`resource fork on ${child}`), { needsArchive: true });
      }
      if (process.platform === 'darwin' && forkExclusions && !underRoot(child, disposable) && (e.isFile() || e.isDirectory() || e.isSymbolicLink())) {
        attributes.push(child); if (attributes.length === 200) { await xattrs(root, attributes, env, signal); attributes.length = 0; }
      }
      if (e.name === '.gitmodules' && e.isSymbolicLink()) excluded.push({ path: child, kind: 'nested-repo' });
      if (e.isDirectory() && !repoMarkers.has(e.name) && e.name.toLowerCase() !== '.git') pending.push({ path: child, regenerable });
    }
  }
  if (attributes.length) await xattrs(root, attributes, env, signal);
  return excluded;
}

// Exact components, plus only the two named .scratch subtrees. Config may extend this baseline, never subtract.
export const REGENERABLE_ALLOWLIST = { components: ['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.next', '.turbo', 'dist', 'build', 'coverage', '.nyc_output', 'target', '.gradle', '.parcel-cache', '.cache'], scratch: /^\.scratch\/(?:[^/]+\/)*(?:pytest-tmp-[^/]*|pytest-cache)(?:\/|$)/ } as const;
export async function classifyWorktree(path: string, env: NodeJS.ProcessEnv, signal: AbortSignal, pin: string[], extra: string[] = [],
  exclusions?: Awaited<ReturnType<typeof excludedPaths>>): Promise<Classification> {
  const nested = (exclusions ?? await excludedPaths(path, signal)).filter(e => e.kind === 'nested-repo').map(e => e.path).sort();
  // No per-save excludes: only the owner's ignore rules establish ignored directories.
  let listed = nulPaths((await runGit(path, [...pin, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], env, signal)).output);
  const decoded = (raw: Buffer) => raw.toString('utf8');
  const valid = (raw: Buffer) => Buffer.from(decoded(raw)).equals(raw);
  const confirm = async (query: Buffer[]): Promise<Buffer[]> => {
    if (!query.length) return [];
    try { return nulPaths((await runGit(path, [...pin, 'check-ignore', '-z', '--stdin'], env, signal, Buffer.concat(query.flatMap(p => [p, Buffer.from([0])])))).output); }
    catch (e) { if (signal.aborted || (e as { exitCode?: number }).exitCode !== 1) throw e; return []; }
  };
  const confirmed = new Set((await confirm(listed)).map(raw => raw.toString('hex'))), expanded: Buffer[] = [];
  for (const raw of listed) {
    await yieldTurn(); if (signal.aborted) throw gitAbortError();
    if (valid(raw) && decoded(raw).endsWith('/') && !confirmed.has(raw.toString('hex'))) {
      expanded.push(...nulPaths((await runGit(path, [...pin, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', `:(literal)${decoded(raw)}`], env, signal)).output));
    } else expanded.push(raw);
  }
  listed = expanded;
  const ignored = listed.map(raw => valid(raw) ? decoded(raw) : `invalid UTF-8: ${raw.toString('hex')}`).sort();
  const roots = new Set<string>();
  for (const raw of listed) {
    await yieldTurn(); if (signal.aborted) throw gitAbortError();
    if (!valid(raw)) continue; const entry = decoded(raw);
    const parts = entry.split('/');
    for (let n = 1; n < parts.length; n++) {
      const dir = parts.slice(0, n).join('/');
      if ([...REGENERABLE_ALLOWLIST.components, ...extra].includes(parts[n - 1]!) || REGENERABLE_ALLOWLIST.scratch.test(dir)) roots.add(dir + '/');
    }
  }
  const matched = await confirm([...listed, ...[...roots].map(p => Buffer.from(p))]);
  const matches = new Set(matched.map(raw => raw.toString('hex')));
  const directories = new Set<string>(), regenerable: string[] = [];
  for (const raw of matched) { if (signal.aborted) throw gitAbortError(); const dir = decoded(raw); if (valid(raw) && roots.has(dir) && (await scan(() => lstat(join(path, dir)), signal)).isDirectory()) directories.add(dir); }
  for (const raw of listed) {
    if (!valid(raw) || !matches.has(raw.toString('hex'))) continue; const entry = decoded(raw);
    await yieldTurn(); if (signal.aborted) throw gitAbortError(); const parts = entry.split('/');
    if (parts.some((_, i) => directories.has(parts.slice(0, i).join('/') + '/'))) regenerable.push(entry);
  }
  return { nested, ignored, regenerable };
}

/** Bound writes for untracked and modified tracked files, with per-file and Git metadata overhead. */
export async function untrackedBytes(path: string, env: NodeJS.ProcessEnv, signal: AbortSignal, pin: string[], excluded: string[] = [], blockSize = 4096): Promise<number> {
  const paths = new Set<string>(), added = new Set<string>(), directories = new Set<string>(), omitted = rootSet(excluded.map(p => Buffer.from(p).toString('latin1')));
  for (const args of [['ls-files', '-z', '--others', '--exclude-standard'], ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD']])
    for (const name of nulPaths((await runGit(path, [...pin, ...args], env, signal)).output)) {
      const entry = name.toString('latin1'); if (underRoot(entry, omitted)) continue; paths.add(entry); if (args[0] === 'ls-files') added.add(entry);
    }
  const allocation = (bytes: number) => Math.ceil(bytes / blockSize) * blockSize;
  const entryBytes = (await runGit(path, [...pin, 'rev-parse', '--show-object-format'], env, signal)).output.toString('utf8').trim() === 'sha256' ? 40 : 28;
  const directoryTypes = new Map<string, boolean>();
  const directory = async (dir: string): Promise<boolean> => {
    let at = '';
    for (const part of ['', ...dir.split('/').filter(Boolean)]) {
      at = part ? (at ? at + '/' : '') + part : '';
      if (!directoryTypes.has(at)) {
        const st = await scan(() => lstat(Buffer.concat([Buffer.from(path + '/'), Buffer.from(at, 'latin1')])), signal)
          .catch(e => { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return null; throw e; });
        directoryTypes.set(at, !!st?.isDirectory());
      }
      if (!directoryTypes.get(at)) return false;
    }
    return true;
  };
  let bytes = 2 ** 20;
  const admin = pin.find(p => p.startsWith('--git-dir='))?.slice(10);
  if (!admin) throw new Error('index location is unknown');
  bytes += (await scan(() => lstat(join(admin, 'index')), signal).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }))?.size ?? 0;
  for (const name of added) bytes += Math.ceil((62 + Buffer.byteLength(name, 'latin1')) / 8) * 8;
  for (const name of paths) {
    await yieldTurn(); if (signal.aborted) throw gitAbortError();
    let dir = name;
    for (;;) { const slash = dir.lastIndexOf('/'); dir = slash < 0 ? '' : dir.slice(0, slash); directories.add(dir); if (!dir) break; }
    const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    if (!await directory(parent)) { bytes += allocation(4096); continue; }
    const st = await scan(() => lstat(Buffer.concat([Buffer.from(path + '/'), Buffer.from(name, 'latin1')])), signal)
      .catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; });
    if (!st || st.isDirectory()) { bytes += allocation(4096); continue; } // Deletions still rewrite index and trees.
    if (!st.isFile() && !st.isSymbolicLink()) throw new Error('untracked path is not a file or symlink');
    bytes += allocation(4096 + Math.ceil(st.size * 1.01));
    if (!Number.isSafeInteger(bytes)) throw new Error('untracked byte size is unknown');
  }
  for (const dir of directories) {
    await yieldTurn(); if (signal.aborted) throw gitAbortError();
    const entries = await directory(dir) ? await scan(() => readdir(Buffer.concat([Buffer.from(path + '/'), Buffer.from(dir, 'latin1')]), { encoding: 'buffer' }), signal) : [];
    bytes += allocation(4096 + entries.reduce((sum, entry) => sum + entryBytes + entry.length, 0));
    if (!Number.isSafeInteger(bytes)) throw new Error('tree byte size is unknown');
  }
  if (signal.aborted) throw gitAbortError(); return bytes;
}

/** Failed measurements defer capacity; Git timeouts and unproven groups retain their normal failure handling. */
export async function saveCapacity(path: string, env: NodeJS.ProcessEnv, signal: AbortSignal, pin: string[], excluded: string[], common: string,
  statfs?: DiskStatfs, minFreeGb = 5): Promise<boolean> {
  try {
    const fs = statfs ? statfs(common) : await scan(() => volumeStatfs(common), signal);
    if (!Number.isSafeInteger(fs.bsize) || fs.bsize <= 0) return false;
    const bytes = await untrackedBytes(path, env, signal, pin, excluded, Math.max(4096, fs.bsize)), space = worktreeDisk(common, () => fs).freeGiB;
    if (signal.aborted) throw gitAbortError(); return space !== null && space * 2 ** 30 >= bytes + Math.max(minFreeGb, 1) * 2 ** 30;
  } catch (e) { if (signal.aborted || (e as { hungVolume?: boolean })?.hungVolume || (e as { groupClosed?: boolean })?.groupClosed === false || /git command timed out/.test(message(e))) throw e; return false; }
}

export const message = (e: unknown): string => e instanceof Error ? e.message : String(e), gitAbortError = () => Object.assign(new Error('git was aborted'), { groupClosed: true });
export function saveFailureCounts(e: unknown): boolean {
  const error = e as { saveTimeout?: boolean; exitCode?: number; code?: string; stderr?: string };
  if ((e as { hungVolume?: boolean; nonStrike?: boolean })?.hungVolume || (e as { nonStrike?: boolean })?.nonStrike) return false;
  if (error?.saveTimeout === true || /git command timed out/.test(message(e)) || ['EACCES', 'EPERM', 'ENOENT'].includes(error?.code ?? '')) return true;
  if (/ENOSPC|no space left|index\.lock|EBUSY|resource busy/i.test(message(e))) return false;
  return typeof error?.exitCode === 'number' && error.exitCode !== 0 && /(?:index (?:file|entry)|(?:invalid|corrupt|bad) index|pathspec|unable to (?:stat|index)|invalid path|not a git repository|permission denied)/i.test(error.stderr ?? '');
}
export function noteSaveFailure(store: Store, id: string, e: unknown): void {
  const w = store.get(id)?.workspace;
  const strike = saveFailureCounts(e), failures = (w?.saveFailures ?? 0) + Number(strike), delays = strike ? (w?.saveDelays ?? 0) : (w?.saveDelays ?? 0) + 1;
  store.noteWorkspaceHousekeeping(id, { saveFailures: failures, unsaveable: failures >= 2, saveDelays: delays,
    saveRetryAt: new Date(Date.now() + (strike ? tempRetryDelayMs(Math.max(1, failures)) : [60_000, 3_600_000, 21_600_000, 86_400_000][Math.min(delays, 4) - 1]!)).toISOString() });
}

/** Metadata is always found from the recorded owner, never through the worktree's editable .git. */
export type CommonDirs = Map<string, string>;
export async function pinnedAdmin(path: string, owner: string, env: NodeJS.ProcessEnv, signal: AbortSignal, commonDirs: CommonDirs = new Map()): Promise<string> {
  if (signal.aborted) throw gitAbortError();
  if (!commonDirs.has(owner)) {
    const common = (await runGit(owner, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env, signal)).output.toString('utf8').trim();
    commonDirs.set(owner, await scan(() => realpath(common), signal));
  }
  if (signal.aborted) throw gitAbortError();
  const admin = join(commonDirs.get(owner)!, 'worktrees', basename(path));
  const binding = await scan(() => readFile(join(admin, 'gitdir'), 'utf8'), signal).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; });
  if (binding?.trim() !== join(await scan(() => realpath(path), signal), '.git')) throw Object.assign(new Error('its git metadata is not where the pipe made it'), { metadataMoved: true });
  return admin;
}
export async function housekeepingFingerprint(path: string, owner: string, env: NodeJS.ProcessEnv, signal: AbortSignal, commonDirs?: CommonDirs): Promise<string> {
  const admin = await pinnedAdmin(path, owner, env, signal, commonDirs);
  const head = await scan(() => readFile(join(admin, 'HEAD'), 'utf8'), signal);
  const top = await scan(() => lstat(path), signal), dotgit = await scan(() => lstat(join(path, '.git')), signal);
  const lock = await scan(() => lstat(join(admin, 'locked')), signal).catch(e => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e;
  });
  return JSON.stringify([head, top.mtimeMs, top.size, dotgit.mtimeMs, dotgit.size, !!lock, lock?.mtimeMs ?? null]);
}
/** Exit 128 alone is insufficient: every pinned index path must still exist before removal can retry. */
export async function removalIntact(path: string, admin: string, indexed: Buffer, timeoutMs: number): Promise<boolean> {
  const proof = new AbortController(), signal = proof.signal; saveTimeouts.set(signal, timeoutMs);
  const timer = setTimeout(() => proof.abort(Object.assign(new Error('save timed out'), { saveTimeout: true })), timeoutMs);
  try {
    if (!(await scan(() => lstat(join(path, '.git')), signal)).isFile() || !(await scan(() => lstat(admin), signal)).isDirectory() ||
      !(await scan(() => lstat(join(admin, 'gitdir')), signal)).isFile() ||
      (await scan(() => readFile(join(path, '.git'), 'utf8'), signal)).trim() !== `gitdir: ${admin}` ||
      (await scan(() => readFile(join(admin, 'gitdir'), 'utf8'), signal)).trim() !== join(await scan(() => realpath(path), signal), '.git')) return false;
    for (const entry of nulPaths(indexed)) {
      await yieldTurn(); await scan(() => lstat(Buffer.concat([Buffer.from(path + '/'), entry])), signal);
    }
    if (signal.aborted) throw gitAbortError(); return true;
  } catch (e) { if (signal.aborted || (e as { hungVolume?: boolean })?.hungVolume) throw e; return false; } finally { clearTimeout(timer); saveTimeouts.delete(signal); }
}

/** Per-attempt scratch space, retained worktrees, and a free-space dispatch guard. */
import { spawn } from 'node:child_process';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { currentRoots, sealedRoots, runtimeRoots, rootDeadline, checkCurrentRoot, currentRootMissing, currentPathSafe, insideWorktreeRoots, inside, underPreviousRoot, pathEntry, rootProof, type RootLocations } from './worktree-roots.ts';
export { validateWorktreeRoots } from './worktree-roots.ts';
import { gitAbortError, excludedPaths, classifyWorktree, saveCapacity, type Classification, housekeepingFingerprint, pinnedAdmin, removalIntact, noteSaveFailure, scansPending, housekeepingGate, pruneSignals, pauseForGroup, saveTimeouts, scan, validateHousekeeping, tempChild, message, underRoot, type CommonDirs } from './classify.ts';
import { allowList } from './runner.ts';
import type { RequestRecord, Store } from './store.ts';
import { numstat, type WorkspaceDiff } from './telemetry.ts';

export { saveFailureCounts, noteSaveFailure, validateHousekeeping } from './classify.ts';

const GB = 2 ** 30;
const finished = (r: RequestRecord): boolean => ['completed', 'failed', 'cancelled', 'start_mismatch'].includes(r.state);
export type HousekeepingConfig = { batch?: number; saveTimeoutMs?: number; removeTimeoutMs?: number; regenerable?: string[];
  tiers?: { below: number; keepHours: number; name: string }[]; keepRecordsDays?: number; logMaxMb?: number };
export type DiskStatfs = (path: string) => { bavail: number; blocks: number; bsize: number };
const PRESSURE_YIELD_FLOOR = 10, relaxed = (tier?: string): boolean => tier === undefined || tier === 'normal' || tier === 'unknown';
const TIERS = [{ below: .03, keepHours: .25, name: 'emergency' }, { below: .08, keepHours: 2, name: 'critical' },
  { below: .15, keepHours: 12, name: 'pressure' }];
export function worktreeDisk(root: string, statfs: DiskStatfs = statfsSync): { freeGiB: number | null; freeShare: number | null } {
  try {
    const at = existingParent(root), fs = statfs(at), free = statfsFree(at, () => fs), total = fs.blocks * fs.bsize;
    if (![free, total].every(Number.isFinite) || free < 0 || total <= 0 || free > total) throw new Error('invalid statfs');
    return { freeGiB: free / GB, freeShare: free / total };
  } catch { return { freeGiB: null, freeShare: null }; }
}
export function housekeepingTier(share: number | null, keepHours: number, tiers = TIERS): { tier: string; keepHours: number } {
  if (share === null || !Number.isFinite(share) || share < 0 || share > 1) return { tier: 'unknown', keepHours };
  const tier = [...tiers].sort((a, b) => a.below - b.below).find(t => share < t.below);
  return tier ? { tier: tier.name, keepHours: Math.min(keepHours, Math.max(.25, tier.keepHours)) } : { tier: 'normal', keepHours };
}
/** Worsening stays pending until a pass can start (five minutes between starts); an interval pass satisfies it too. A steady
 * pressure tier repeats every quarter of the effective keep, and a pressure pass that removed some and left more is followed. */
export class HousekeepingTrigger {
  private previous: number | null = null;
  private pending = false;
  private lastStart = -Infinity;
  observe(tier: string, now: number, tiers = TIERS, keepHours?: number): boolean {
    const rank = tier === 'unknown' ? null : tier === 'normal' ? 0 : [...tiers].sort((a, b) => b.below - a.below).findIndex(t => t.name === tier) + 1;
    if (rank !== null) { if (this.previous !== null && rank > this.previous) this.pending = true; this.previous = rank; }
    const repeat = !!rank && keepHours !== undefined && Number.isFinite(keepHours) && now - this.lastStart >= keepHours * 900_000;
    return rank !== null && (this.pending || repeat) && now - this.lastStart >= 300_000;
  }
  started(now: number): void { this.lastStart = now; this.pending = false; }
  finished(report: PruneReport): PruneReport { if (!relaxed(report.tier) && report.removed.length && report.kept.some(k => ['job admission', 'batch limit'].includes(k.reason))) this.pending = true; return report; }
}
export type HousekeepingStatus = { worktreeCount: number | null; freeGiB: number | null; freeShare: number | null; tier: string;
  keepHours: number; gate: ReturnType<typeof housekeepingGate>; unsaveable: number | null; lastPass: { at: string; durationMs: number; removed: number; kept: Record<string, number>; failed: number } | null };
export type KeptKind = 'retention' | 'unsaved' | 'unsaveable' | 'needs-archive' | 'orphan' | 'running' | 'locked' | 'deferred' | 'deferred-capacity' | 'partial-removal';
export type PruneReport = {
  at?: string; durationMs?: number; tier?: string; keepHours?: number; unsaveable?: number; worktreeCount?: number | null; keptCounts?: Record<string, number>;
  removed: { requestId: string; path: string; branch: string; commit: string; saved: boolean }[];
  kept: { requestId: string; path: string; reason: string; kind: KeptKind; keepHours?: number }[];
  failed: { requestId: string; path: string; message: string }[];
  unavailablePreviousRoots?: { path: string; retainedRecords: number; reason?: string }[];
  unavailableCurrentRoot?: { path: string; retainedRecords: number; reason: string };
};

export function attemptTemp(root: string, id: string): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const generatedAttempt = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export const TEMP_RETRY_DELAYS_MS: readonly number[] = [60_000, 600_000, 3_600_000];
export const tempRetryDelayMs = (failures: number): number => TEMP_RETRY_DELAYS_MS[failures <= 1 ? 0 : failures === 2 ? 1 : 2]!;
export class TempRetryQueue {
  private entries = new Map<string, { id: string; groupGone: () => boolean; failures: number; nextAt: number }>();
  add(id: string, groupGone: () => boolean): void {
    if (!this.has(id)) this.entries.set(id, { id, groupGone, failures: 0, nextAt: -Infinity });
  }
  due(now = Date.now()) { return [...this.entries.values()].filter((entry) => entry.nextAt <= now); }
  notYet(id: string): void {
    const entry = this.entries.get(id); if (!entry) return;
    entry.nextAt = -Infinity; this.entries.delete(id); this.entries.set(id, entry);
  }
  failed(id: string, now = Date.now()): { failures: number; firstFailure: boolean; parked: boolean } {
    const entry = this.entries.get(id); if (!entry) throw new Error('temp retry entry missing');
    const failures = ++entry.failures; entry.nextAt = now + tempRetryDelayMs(failures);
    return { failures, firstFailure: failures === 1, parked: failures === 3 };
  }
  removed(id: string): void { this.entries.delete(id); }
  has(id: string): boolean { return this.entries.has(id); }
  get size(): number { return this.entries.size; }
}
/** Only ESRCH proves group exit; EPERM and unavailable probes retain scratch. */
export function runnerGroupGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** Without a logger, propagate removal errors so the queue's caller controls logging and back-off. */
export function removeAttemptTemp(root: string, id: string, log?: (where: string, error: unknown) => void, groupGone: () => boolean = () => false): boolean {
  if (!tempChild(id)) return false;
  try { if (!groupGone()) return false;
    const entry = lstatSync(root, { throwIfNoEntry: false });
    if (!entry) return true; if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    rmSync(join(root, id), { recursive: true, force: true }); return true;
  } catch (e) {
    if (!log) throw e;
    try { log('remove attempt temp folder', e); } catch { /* Cleanup cannot fail the request. */ } return false;
  }
}

/** Prune only old generated folders whose durable request and group state permit removal. */
export function cleanEndedTemps(root: string, store: Store, log: (where: string, error: unknown) => void, keepHours: number, queue?: TempRetryQueue): void {
  if (!Number.isFinite(keepHours) || keepHours < 0) return;
  try {
    const entry = lstatSync(root, { throwIfNoEntry: false }); if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) return;
    const states = store.tempCleanupStates(); for (const child of readdirSync(root, { withFileTypes: true })) {
      if (!child.isDirectory()) continue; const state = states.get(child.name);
      if ((!state && !generatedAttempt(child.name)) || state?.protected) continue;
      const age = Date.now() - lstatSync(join(root, child.name)).mtimeMs; if (!Number.isFinite(age) || age < 0 || age < keepHours * 3_600_000) continue;
      const groupGone = () => !state?.runner || runnerGroupGone(state.runner.pid);
      if (queue) queue.add(child.name, groupGone); else removeAttemptTemp(root, child.name, log, groupGone);
    }
  } catch (e) { log('inspect old temp folders', e); }
}

function existingParent(path: string): string {
  let at = resolve(path);
  while (!existsSync(at)) {
    const parent = dirname(at); if (parent === at) break; at = parent;
  }
  return at;
}

export function diskWait(paths: string[], minFreeGb: number, diskFree: (path: string) => number): string | null {
  if (minFreeGb === 0) return null;
  let lowest = { path: '', bytes: Infinity };
  for (const path of paths) {
    const at = existingParent(path);
    const bytes = diskFree(at);
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`free space reading for ${at} is invalid`);
    if (bytes < lowest.bytes) lowest = { path: at, bytes };
  }
  return lowest.bytes < minFreeGb * GB
    ? `disk nearly full: ${(lowest.bytes / GB).toFixed(2)} GB free on ${lowest.path}, below minFreeGb ${minFreeGb}` : null;
}

export const statfsFree = (path: string, statfs: DiskStatfs = statfsSync): number => { const fs = statfs(path); return fs.bavail * fs.bsize; };

export type WorktreeEntry = { requestId: string; path: string; branch: string; finishedAt: string; dueAt: string; locked: boolean; unsaveable?: boolean; saveFailures?: number; excludedPaths?: number; saveRetryAt?: string };
type GitOptions = { proveGroup?: boolean; executable?: '/usr/bin/xattr'; timeoutMs?: number; maxOutputBytes?: number; truncateOutput?: boolean };
/** Await rejection before ending a pass; an unproven group pauses later passes until ESRCH. */
export const runGit = (cwd: string, args: string[], env = process.env, signal?: AbortSignal, input?: Buffer,
  options: GitOptions = {}): Promise<{ output: Buffer; truncated: boolean; stderr: Buffer }> =>
  new Promise((resolveGit, reject) => {
    if (signal?.aborted) { reject(gitAbortError()); return; }
    const timeoutMs = options.timeoutMs ?? 60_000, proveGroup = options.proveGroup ?? (!!signal && pruneSignals.has(signal));
    const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
    const child = spawn(options.executable ?? 'git', options.executable ? args : ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-C', cwd, ...args], { env: allowList(env), detached: true, stdio: 'pipe' });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outSize = 0, errSize = 0, stopped: Error | null = null, settled = false, truncated = false;
    let grace: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined, bound: NodeJS.Timeout | undefined, sweep: NodeJS.Timeout | undefined;
    let closed = false, normalCompletion = false, normalError: Error | undefined;
    let exited: { code: number | null; endedBy: NodeJS.Signals | null } | null = null;
    const group = (kind: NodeJS.Signals | 0): boolean => {
      if (!child.pid) return false;
      // Once git itself has exited, its pid can be reused, and a new group with that id needs a leader with that pid.
      // So the group is signalled then only while no process holds the pid: any member left is this command's.
      if (exited !== null && (kind !== 0 || !proveGroup)) {
        try { process.kill(child.pid, 0); return false; }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
      }
      // EPERM or an unavailable probe proves neither a live group nor its absence.
      try { process.kill(-child.pid, kind); return false; }
      catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const checkStopped = (): void => {
      if (settled) return;
      if (closed && group(0)) { finish(normalCompletion ? normalError : Object.assign(stopped!, { groupClosed: true })); return; }
      sweep = setTimeout(checkStopped, 50);
    };
    const stop = (reason: Error, normal = false): void => {
      if (settled) return;
      if (stopped) { if (normalCompletion && !normal) { normalCompletion = false; stopped = reason; } return; }
      stopped = reason; normalCompletion = normal; group('SIGTERM');
      escalation = setTimeout(() => { if (!settled) group('SIGKILL'); }, 2_000);
      bound = setTimeout(() => { const proven = closed && group(0); finish(proven && normalCompletion ? normalError : Object.assign(stopped!, { groupClosed: proven })); }, 5_000);
      checkStopped();
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(grace); clearTimeout(escalation); clearTimeout(bound); clearTimeout(sweep);
      signal?.removeEventListener('abort', aborted);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      if ((error as { groupClosed?: boolean })?.groupClosed === false) pauseForGroup(() => !!child.pid && runnerGroupGone(child.pid));
      if (error) reject(error); else resolveGit({ output: Buffer.concat(out), truncated, stderr: Buffer.concat(err) });
    };
    const receive = (chunks: Buffer[], isOutput: boolean) => (chunk: Buffer): void => {
      if (isOutput) outSize += chunk.length; else errSize += chunk.length;
      // Large enough for ls-files on a big repository; memory, not a file, holds it.
      if ((options.truncateOutput ? errSize : outSize + errSize) > maxOutputBytes) {
        stop(new Error(`git output exceeded ${maxOutputBytes} bytes`)); return;
      }
      if (options.truncateOutput && isOutput && outSize > maxOutputBytes) truncated = true;
      const keep = options.truncateOutput && isOutput ? Math.max(0, maxOutputBytes - (outSize - chunk.length)) : chunk.length;
      if (keep) chunks.push(chunk.subarray(0, keep));
    };
    const aborted = () => stop(gitAbortError());
    const deadline = setTimeout(() => stop(new Error(`git command timed out after ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    child.stdout.on('data', receive(out, true)); child.stderr.on('data', receive(err, false));
    child.stdin.on('error', () => { /* A command that exits before reading input reports its exit below. */ });
    child.on('error', (e) => { if (!stopped) finish(e); });
    // 'exit' can come before the last output arrives, so the answer waits for 'close'. Pipes a descendant keeps
    // open past a short grace make the command fail: a partial answer is never used.
    // A stop (deadline, abort, oversized output) always wins, even after a clean exit: its answer may be partial.
    child.on('exit', (code, endedBy) => {
      exited = { code, endedBy };
      // Output still open after the grace is no answer at all: the group is stopped like any other stop, so nothing
      // of this git is left running, and the error carries no exit code to read one from.
      grace = setTimeout(() => stop(new Error(`git ${args[0] ?? ''} exited ${code ?? endedBy}, but its output stayed open`)), 2_000);
      grace.unref();
    });
    // The error is made at close, from all of stderr: a message can arrive after the exit (a full disk, for example).
    child.on('close', () => {
      closed = true; clearTimeout(grace);
      if (settled) return;
      if (stopped) {
        if (!group(0)) group('SIGKILL');
        clearTimeout(sweep); checkStopped(); return;
      }
      if (exited === null) { finish(new Error(`git ${args[0] ?? ''} closed before it exited`)); return; }
      const { code, endedBy } = exited, stderr = Buffer.concat(err).toString('utf8');
      normalError = code === 0 ? undefined : Object.assign(new Error(`git ${args[0] ?? ''} exited ${code ?? endedBy}: ${stderr}`), { exitCode: code, stderr });
      if (proveGroup && !group(0)) { stop(new Error('git group did not close'), true); return; }
      finish(normalError);
    });
    child.stdin.end(input);
  });
const git = async (cwd: string, args: string[], env = process.env, signal?: AbortSignal, input?: Buffer): Promise<Buffer> =>
  (await runGit(cwd, args, env, signal, input, { timeoutMs: signal ? saveTimeouts.get(signal) : undefined })).output;
const gitText = async (cwd: string, args: string[], env = process.env, signal?: AbortSignal): Promise<string> =>
  (await git(cwd, args, env, signal)).toString('utf8');

function retained(store: Store): RequestRecord[] { return store.finishedWorkspaces().filter(r => finished(r) && r.workspace && existsSync(r.workspace.path)); }

/** Overrides that make every configured filter driver a no-op, so no repository filter runs during a prune. */
export async function noFilters(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, pin: string[] = []): Promise<string[]> {
  const names = new Set<string>();
  for (const key of (await gitText(cwd, [...pin, 'config', '--list', '--name-only'], env, signal)).split('\n')) {
    const found = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key.trim());
    if (found) names.add(found[1]!);
  }
  return [...names].flatMap((name) => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`,
    '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
}

/** Compare gitlinks once per immutable tree; only existing empty directories are safe to save and prune.
 * No index/HEAD gitlinks needs no start read (including committed removals); an unreadable required start quietly keeps work. */
async function unsafeIndex(cwd: string, start: string | undefined, env: NodeJS.ProcessEnv, signal: AbortSignal | undefined,
  pin: string[], trees: Map<string, Map<string, string>>): Promise<string | null> {
  const submodule = 'it contains a submodule; save it by hand';
  const links = (text: string) => new Map(text.split('\0').filter(e => e.startsWith('160000 ')).map(e => {
    const tab = e.indexOf('\t'), fields = e.slice(0, tab).split(' ');
    return [e.slice(tab + 1), fields[1] === 'commit' ? fields[2]! : fields[1]!];
  }));
  const tree = async (hash: string) => {
    if (!trees.has(hash)) trees.set(hash, links((await git(cwd, [...pin, '--no-replace-objects', 'ls-tree', '-rz', hash], env, signal)).toString('latin1')));
    return trees.get(hash)!;
  };
  const entries = (await git(cwd, [...pin, 'ls-files', '-v', '-z', '--stage'], env, signal)).toString('latin1').split('\0').filter(Boolean);
  if (entries.some(e => e[0] === 'S' || e[0] !== e[0]!.toUpperCase() || e.slice(2, e.indexOf('\t')).split(' ')[2] !== '0')) return 'an index entry is hidden or unmerged; save it by hand';
  const index = links(entries.map(e => e.slice(2)).join('\0'));
  const head = await tree((await gitText(cwd, [...pin, '--no-replace-objects', 'rev-parse', 'HEAD'], env, signal)).trim());
  const original = !index.size && !head.size ? index : start && await tree(start).catch(e => { if (signal?.aborted || (e as { hungVolume?: boolean })?.hungVolume || (e as { groupClosed?: boolean })?.groupClosed === false) throw e; return undefined; });
  if (!original) return submodule;
  for (const current of [index, head]) if (current.size !== original.size || [...current].some(([path, hash]) => original.get(path) !== hash)) return submodule;
  for (const path of original.keys()) {
    const decoded = Buffer.from(path, 'latin1').toString('utf8');
    if (Buffer.from(decoded).toString('latin1') !== path) return submodule;
    let child = cwd;
    try {
      for (const part of decoded.split('/')) {
        child = join(child, part);
        const info = await pathEntry(child, signal ?? new AbortController().signal);
        if (!info || !info.isDirectory() || info.isSymbolicLink()) return submodule;
        if (child === join(cwd, decoded) && (await scan(() => readdir(child), signal ?? new AbortController().signal)).length) return submodule;
      }
    } catch (e) { if (signal?.aborted || (e as { hungVolume?: boolean })?.hungVolume) throw e; return submodule; }
  }
  return null;
}

async function filteredPath(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, pin: string[] = []): Promise<boolean> {
  const tracked = await git(cwd, [...pin, 'ls-files', '-z'], env, signal);
  const untracked = await git(cwd, [...pin, 'ls-files', '-z', '--others', '--exclude-standard'], env, signal);
  const paths = Buffer.concat([tracked, untracked]);
  const count = paths.toString('latin1').split('\0').length - 1;
  const attrs = (await git(cwd, [...pin, 'check-attr', '-z', '--stdin', 'filter'], env, signal, paths)).toString('latin1').split('\0');
  if (attrs.length !== count * 3 + 1) throw new Error('git returned incomplete filter attributes');
  return attrs.some((value, i) => i % 3 === 2 && value !== 'unspecified' && value !== 'unset');
}

async function worktreeInfo(request: RequestRecord, fallbackRepo?: string, env = process.env, signal?: AbortSignal): Promise<{ registered: boolean; locked: boolean }> {
  const workspace = request.workspace!;
  const owner = request.cwd ?? fallbackRepo;
  if (!owner) throw new Error('the repository that owns this worktree is unknown');
  const blocks = (await gitText(owner, ['worktree', 'list', '--porcelain'], env, signal)).split(/\n\s*\n/);
  const readSignal = signal ?? new AbortController().signal, realWorkspace = await scan(() => realpath(workspace.path), readSignal);
  for (const block of blocks) {
    const lines = block.split('\n');
    const listed = lines.find((line) => line.startsWith('worktree '))?.slice(9);
    // Match the recorded path and branch before reading a listed path: other volumes may be unresponsive.
    if (!listed || ![resolve(workspace.path), realWorkspace].includes(resolve(listed)) || !lines.includes(`branch refs/heads/${workspace.branch}`)) continue;
    if (!await pathEntry(listed, readSignal) || await scan(() => realpath(listed), readSignal) !== realWorkspace) continue;
    const common = (await gitText(owner, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env, signal)).trim();
    const atWorktree = (await gitText(workspace.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env, signal)).trim();
    const branch = await gitText(workspace.path, ['symbolic-ref', '--quiet', 'HEAD'], env, signal).then((v) => v.trim(), e => { if (signal?.aborted || (e as { groupClosed?: boolean })?.groupClosed === false) throw e; return null; });
    return { registered: await scan(() => realpath(common), readSignal) === await scan(() => realpath(atWorktree), readSignal) && branch === `refs/heads/${workspace.branch}`,
      locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')) };
  }
  return { registered: false, locked: false };
}

export async function listWorktrees(store: Store, keepHours: number, fallbackRepo?: string): Promise<{ worktrees: WorktreeEntry[] }> {
  const worktrees: WorktreeEntry[] = [];
  for (const r of retained(store)) {
    const w = r.workspace!;
    let isLocked = false;
    try { isLocked = (await worktreeInfo(r, fallbackRepo)).locked; } catch { /* Listing keeps the recorded worktree visible when git is unavailable. */ }
    worktrees.push({ requestId: r.id, path: w.path, branch: w.branch, finishedAt: r.finishedAt ?? r.updatedAt,
      dueAt: new Date(Math.min(Date.parse('9999-12-31T23:59:59.999Z'), Date.parse(r.finishedAt ?? r.updatedAt) + keepHours * 3_600_000)).toISOString(), locked: isLocked, ...(w.unsaveable === undefined ? {} : { unsaveable: w.unsaveable }), ...(w.saveFailures === undefined ? {} : { saveFailures: w.saveFailures }),
      ...(w.saveRetryAt === undefined ? {} : { saveRetryAt: w.saveRetryAt }), ...(w.excludedPaths === undefined ? {} : { excludedPaths: w.excludedPaths }) });
  }
  return { worktrees };
}

/**
 * Saves a finished request's worktree as one commit on its own branch, and returns the branch commit, or why the
 * worktree was kept as it is. Prune saves before it removes; a completed changing job saves as it ends. No
 * repository code runs: hooks, fsmonitor, signing and filter drivers are off, a
 * path under a clean filter or any hidden/unmerged index entry keeps the worktree. Submodules must match startCommit
 * in index and HEAD, with readable empty real directories beneath real parents and no admin modules; each step rechecks.
 */
export async function saveWorktree(r: RequestRecord, root: string, fallbackRepo: string | undefined, env = process.env,
  signal?: AbortSignal, allowed: () => boolean = () => true, timeoutMs = 120_000, capacity: RootLocations & { previousWorktreeRoots?: string[]; proveGroup?: boolean; commonDirs?: CommonDirs; statfs?: DiskStatfs; minFreeGb?: number; regenerable?: string[]; beforeFinal?: (commit: string, saved: boolean, diff: WorkspaceDiff | undefined, excluded: number) => string | null } = {}): Promise<{ commit: string; saved: boolean; nf: string[]; admin: string; indexed: Buffer; excludedPaths: number; nestedRepo: boolean; classification: Classification; release: () => Promise<void>; diff?: WorkspaceDiff } | { keep: string }> {
  if (signal?.aborted) throw gitAbortError();
  // Completion saves never resolve previous volumes or protected locations. Prune supplies its pass proof.
  const roots = (capacity[rootProof]?.root === resolve(root) ? capacity[rootProof] : undefined) ?? sealedRoots(root, capacity.validatedRoots) ?? currentRoots(root);
  if (scansPending() && r.workspace && ![root, roots.roots[0]].some(p => p && inside(resolve(r.workspace!.path), resolve(p)))) return { keep: 'hung volume' };
  if (r.workspace?.removing) return { keep: 'partial-removal' };
  if (r.workspace?.unsaveable) return { keep: 'unsaveable' };
  let timedOut = false; const abort = new AbortController(), timer = setTimeout(() => { timedOut = true; abort.abort(Object.assign(new Error('save timed out'), { saveTimeout: true })); }, timeoutMs);
  const external = signal, stopped = () => abort.abort(external?.reason);
  external?.addEventListener('abort', stopped, { once: true });
  if (external?.aborted) stopped();
  signal = abort.signal; saveTimeouts.set(signal, timeoutMs); if (capacity.proveGroup) pruneSignals.add(signal);
  try {
    if (r.workspace && [root, roots.roots[0]].some(p => p && inside(resolve(r.workspace!.path), resolve(p))) && !await checkCurrentRoot(roots, signal, false)) {
      if (external?.aborted) throw gitAbortError();
      return { keep: 'worktreeRoot changed or unresponsive' };
    }
    const w = r.workspace!, owner = r.cwd ?? fallbackRepo!, busy = { keep: 'pipe is draining or stopping' }, moved = { keep: 'worktree changed during the save' };
    // Recheck ownership before writes; pin every Git call to the owner's metadata, never the builder's .git file.
    const trees = new Map<string, Map<string, string>>(), commonDirs = capacity.commonDirs ?? new Map();
    let nf: string[] = [], pin: string[] = [];
    const unsafe = async (checkFilters = true): Promise<string | null> => {
      if (!await insideWorktreeRoots(w.path, scansPending() ? { ...roots, roots: roots.roots.slice(0, 1) } : roots, signal!)) return 'outside worktreeRoot';
      const admin = await pinnedAdmin(w.path, owner, env, signal, commonDirs);
      pin = [`--git-dir=${admin}`, `--work-tree=${w.path}`]; nf = ['-c', 'core.trustctime=true', '-c', 'core.checkStat=default', ...await noFilters(w.path, env, signal, pin)];
      const info = await worktreeInfo(r, fallbackRepo, env, signal);
      if (!info.registered) return 'not registered on the recorded branch in its repository';
      if (info.locked) return 'locked';
      const indexReason = await unsafeIndex(w.path, w.startCommit, env, signal, pin, trees);
      if (indexReason) return indexReason;
      if (await pathEntry(join(admin, 'modules'), signal!)) return 'it contains a submodule; save it by hand';
      if (checkFilters && await filteredPath(w.path, env, signal, pin)) return 'a path uses a clean filter; save it by hand';
      return null;
    };
    const first = await unsafe(false);
    if (first) return { keep: first };
    const walked = await excludedPaths(w.path, signal);
    const classification = await classifyWorktree(w.path, env, signal, pin, capacity.regenerable, walked);
    const ignoredRoots = new Set(classification.ignored.filter(p => p.endsWith('/')).map(p => p.slice(0, -1)));
    const exclusions = walked.filter(e => e.kind === 'nested-repo' || underRoot(e.path, ignoredRoots));
    const excluded = exclusions.map(e => e.path), addExcluded = walked.filter(e => e.kind === 'nested-repo' && !underRoot(e.path, ignoredRoots)).map(e => e.path);
    if (excluded.some(path => /[\r\n]/.test(path))) throw new Error('an excluded path cannot be represented safely');
    const pathspec = ['--', '.', ...excluded.map(path => `:(exclude,literal)${path}`)];
    if (await filteredPath(w.path, env, signal, pin)) return { keep: 'a path uses a clean filter; save it by hand' };
    let dirty = (await git(w.path, [...pin, ...nf, 'status', '--porcelain', '-z', '--untracked-files=all', ...pathspec], env, signal)).length > 0;
    if (!allowed()) return busy;
    if (dirty) {
      if (!await saveCapacity(w.path, env, signal, [...pin, ...nf], excluded, commonDirs.get(owner)!, capacity.statfs, capacity.minFreeGb)) return { keep: 'deferred-capacity' };
      if (signal.aborted) throw gitAbortError();
      if (!allowed()) return busy;
      if (await unsafe()) return moved;
      await git(w.path, [...pin, ...nf, 'add', '-A', '--', '.', ...addExcluded.map(p => `:(exclude,literal)${p}`)], env, signal);
      dirty = (await git(w.path, [...pin, ...nf, 'diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv'], env, signal)).length > 0;
      if (await unsafe()) return moved;
      if (dirty) await git(w.path, [...pin, ...nf, '-c', 'user.name=pipe', '-c', 'user.email=pipe@localhost',
        'commit', '--no-verify', '-m', `pipe save request ${r.id}`], env, signal);
    }
    // A new status check protects work written after the save. Git refuses dirty worktrees.
    if ((await gitText(w.path, [...pin, ...nf, 'status', '--porcelain', '--untracked-files=all', ...pathspec], env, signal)).trim() !== '') return moved;
    if (!allowed()) return busy;
    const commit = (await gitText(owner, ['rev-parse', '--verify', `refs/heads/${w.branch}`], env, signal)).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error('the branch commit is not a 40- or 64-character hash');
    if (await unsafe()) return moved;
    let diff: WorkspaceDiff | undefined;
    try {
      if (r.workspace?.startCommit) diff = numstat(await git(owner, ['--no-replace-objects', ...nf, 'diff', '--numstat', '-z',
        '--find-renames=50%', '--no-ext-diff', '--no-textconv', '--no-relative', r.workspace.startCommit, commit, '--'], env, signal));
    } catch (e) { if ((e as { groupClosed?: boolean })?.groupClosed === false) throw e; /* Failed measurement leaves line counts unknown. */ }
    if (signal.aborted) throw gitAbortError();
    const excludedCount = exclusions.filter(e => e.kind === 'regenerable').length;
    const hold = capacity.beforeFinal?.(commit, dirty, diff, excludedCount); if (hold) return { keep: hold };
    const final = await classifyWorktree(w.path, env, signal, pin, capacity.regenerable, await excludedPaths(w.path, signal));
    if (signal.aborted) throw gitAbortError();
    if (JSON.stringify(final) !== JSON.stringify(classification)) return moved;
    return { commit, saved: dirty, nf, admin: pin[0]!.slice(10), indexed: await git(w.path, [...pin, 'ls-files', '-z', '--cached'], env, signal), excludedPaths: excludedCount,
      nestedRepo: exclusions.some(e => e.kind === 'nested-repo'), classification: final, release: async () => {}, ...(diff ? { diff } : {}) };
  } catch (e) { if ((e as { needsArchive?: boolean; metadataMoved?: boolean })?.needsArchive || (e as { metadataMoved?: boolean })?.metadataMoved) return { keep: message(e) }; if (timedOut && !external?.aborted) throw Object.assign(e instanceof Error ? e : new Error(message(e)), { saveTimeout: true }); throw e; } finally {
    clearTimeout(timer); saveTimeouts.delete(signal); external?.removeEventListener('abort', stopped);
  }
}

const missingRepositories = new Set<string>();
export async function pruneWorktrees(store: Store, root: string, keepHours: number,
  log: (where: string, error: unknown) => void, allowed: () => boolean, fallbackRepo?: string,
  env = process.env, signal?: AbortSignal, options: HousekeepingConfig & RootLocations & { previousWorktreeRoots?: string[]; statfs?: DiskStatfs; waiting?: () => boolean; minFreeGb?: number; groupGone?: (id: string) => boolean } = {}): Promise<PruneReport> {
  validateHousekeeping(options);
  const began = Date.now(), elapsed = performance.now(), pending = scansPending(), commonDirs: CommonDirs = new Map(), rootErrors = new Map<string, string>();
  let roots = currentRoots(root, pending);
  const currentOK = !!roots.roots.length && (allowed() && !signal?.aborted && !scansPending() ? await rootDeadline(options.saveTimeoutMs ?? 120_000, signal, s => checkCurrentRoot(roots, s)) : false);
  const tier = housekeepingTier(!currentOK || scansPending() ? null : worktreeDisk(roots.roots[0] ?? root, options.statfs).freeShare, keepHours, options.tiers);
  const report: PruneReport = { at: new Date(began).toISOString(), durationMs: 0, tier: tier.tier, keepHours: tier.keepHours,
    removed: [], kept: [], failed: [] };
  const records = store.finishedWorkspaces(), open = store.openRequests();
  const current = (path: string) => inside(resolve(path), resolve(root)) || !!(roots.roots[0] && inside(resolve(path), roots.roots[0]));
  if (!currentOK) report.unavailableCurrentRoot = { path: root, retainedRecords: [...records, ...open].filter(r => r.workspace && !r.workspace.removedAt && current(r.workspace.path)).length, reason: 'worktreeRoot changed or unresponsive' };
  const unavailable = (path: string) => !current(path) && roots.unavailable.some(old => underPreviousRoot(path, old, roots));
  const candidates = records.filter(r => finished(r) && r.workspace && !r.workspace.removedAt).sort((a, b) => (Date.parse(a.workspace!.lastAttemptAt ?? '') || 0) - (Date.parse(b.workspace!.lastAttemptAt ?? '') || 0) || Date.parse(a.finishedAt ?? a.updatedAt) - Date.parse(b.finishedAt ?? b.updatedAt) || a.seq - b.seq);
  let processed = 0, hungVolume = pending;
  const items = [...candidates, ...open].filter(r => r.workspace);
  let checkedPrevious = false, refreshAborted = '';
  const reportUnavailable = () => { report.unavailablePreviousRoots = roots.unavailable.map(path => ({ path, retainedRecords: [...records, ...open].filter(r => r.workspace && !r.workspace.removedAt && !current(r.workspace.path) && underPreviousRoot(r.workspace.path, path, roots)).length, ...((rootErrors.get(path) ?? roots.reason) ? { reason: rootErrors.get(path) ?? roots.reason } : {}) })); };
  const refreshPrevious = async () => {
    if (checkedPrevious) return; checkedPrevious = true;
    if (hungVolume || scansPending() || !allowed() || signal?.aborted) return;
    try { roots = await rootDeadline(options.saveTimeoutMs ?? 120_000, signal, readSignal => runtimeRoots(root, options.previousWorktreeRoots,
      { ...options, storePath: store.path, workDir: options.workDir ?? fallbackRepo, log }, env, readSignal)); }
    catch (e) { hungVolume ||= scansPending() || !!(e as { hungVolume?: boolean })?.hungVolume; refreshAborted = hungVolume ? 'hung volume' : signal?.aborted ? message(e) : 'root refresh timed out'; return; }
    reportUnavailable();
  };
  // Finish every current-root candidate, including open records, before touching any previous volume.
  for (const r of [...items.filter(r => current(r.workspace!.path)), ...items.filter(r => !current(r.workspace!.path))]) {
    const previous = !current(r.workspace!.path);
    if (previous) await refreshPrevious();
    if (!allowed() || signal?.aborted) break;
    const w = r.workspace!;
    if (previous && unavailable(w.path)) continue;
    let candidateHours = previous ? keepHours : tier.keepHours;
    const keep = (kind: KeptKind, reason: string = kind) => report.kept.push({ requestId: r.id, path: w.path, reason, kind, ...(candidateHours !== tier.keepHours ? { keepHours: candidateHours } : {}) });
    if (!previous && !currentOK && !(pending && scansPending() && roots.roots.length)) { keep(!finished(r) ? 'running' : w.removing ? 'partial-removal' : 'deferred', 'worktreeRoot changed or unresponsive'); continue; }
    if ((previous && (pending || hungVolume || refreshAborted)) || scansPending() || (!previous && !currentOK)) {
      hungVolume ||= pending || scansPending();
      const kind = !finished(r) ? 'running' : w.removing ? 'partial-removal' : Date.now() - Date.parse(r.finishedAt ?? r.updatedAt) < candidateHours * 3_600_000 ? 'retention' : 'deferred';
      keep(kind, refreshAborted || (kind === 'deferred' ? 'hung volume' : kind)); continue;
    }
    if (!roots.roots.length) roots = currentRoots(root);
    const abort = new AbortController(), timeout = options.saveTimeoutMs ?? 120_000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(Object.assign(new Error('save timed out'), { saveTimeout: true })); }, timeout);
    const stop = () => abort.abort(signal?.reason); signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    saveTimeouts.set(abort.signal, timeout); pruneSignals.add(abort.signal);
    const note = (fields: Parameters<Store['noteWorkspaceHousekeeping']>[1]) => {
      if (!store.noteWorkspaceHousekeeping(r.id, fields)) throw new Error('the finished workspace record could not be updated');
    };
    const fail = (e: unknown) => { noteSaveFailure(store, r.id, e); if (!(e as { hungVolume?: boolean })?.hungVolume) Object.assign(w, store.get(r.id)?.workspace); };
    const park = async (kind: 'locked' | 'needs-archive', saved = false) => note({ ...(saved ? { saveDelays: 0, saveFailures: 0 } : {}), housekeepingKind: kind, saveRetryAt: new Date(Date.now() + 86_400_000).toISOString(), housekeepingFingerprint: await housekeepingFingerprint(w.path, r.cwd ?? fallbackRepo!, env, abort.signal, commonDirs) });
    try {
      if (!previous && !currentPathSafe(w.path, roots)) { keep('unsaved', 'outside worktreeRoot'); continue; }
      let entry = previous ? null : lstatSync(w.path, { throwIfNoEntry: false });
      if (previous) try { entry = await pathEntry(w.path, abort.signal); } catch (e) {
        if (abort.signal.aborted || (e as { hungVolume?: boolean })?.hungVolume) throw e;
        if (['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) { note({ lastAttemptAt: new Date().toISOString() }); keep('unsaved', message(e)); continue; }
        const unavailable = options.previousWorktreeRoots?.filter(old => underPreviousRoot(w.path, old, roots)) ?? [];
        if (!unavailable.length) throw e;
        for (const root of unavailable) rootErrors.set(root, message(e));
        roots = { ...roots, unavailable: [...new Set([...roots.unavailable, ...unavailable])] }; reportUnavailable(); continue;
      }
      if (!finished(r)) {
        if (entry) report.kept.push({ requestId: r.id, path: w.path, reason: 'running', kind: 'running', ...(previous && keepHours !== tier.keepHours ? { keepHours } : {}) });
        continue;
      }
      if (!previous && (w.removing || !entry)) { if (!await rootDeadline(timeout, signal, s => checkCurrentRoot(roots, s))) { keep(w.removing ? 'partial-removal' : 'deferred', 'worktreeRoot changed or unresponsive'); continue; } entry = lstatSync(w.path, { throwIfNoEntry: false }) ?? entry; }
      if (!w.removing && !entry) continue;
      if (w.removing) {
        note({ lastAttemptAt: new Date(Date.now()).toISOString() });
        if (!entry) {
          note({ removedAt: new Date().toISOString() });
          report.removed.push({ requestId: r.id, path: w.path, branch: w.branch, commit: w.commit, saved: w.saved === 'saved' });
        } else keep('partial-removal', 'removal started but the worktree folder remains');
        continue;
      }
      if (!roots.roots.length || (options.previousWorktreeRoots?.length && !await insideWorktreeRoots(w.path, roots, abort.signal))) {
        keep('unsaved', 'outside worktreeRoot'); continue;
      }
      const groupGone = () => options.groupGone ? options.groupGone(r.id) :
        store.attempts(r.id).every(a => a.endedAt !== null && (!!a.closedAt || !a.runner || runnerGroupGone(a.runner.pid)));
      if (!groupGone()) { keep('running', 'runner may still be running'); continue; }
      if (w.unsaveable) { keep('unsaveable'); continue; }
      // Pressure can shorten retention only on the measured volume; unknown device proof keeps normal retention.
      candidateHours = keepHours;
      try { if (tier.keepHours < keepHours && (previous ? await scan(() => stat(w.path), abort.signal) : statSync(w.path)).dev === roots.dev) candidateHours = tier.keepHours; }
      catch (e) { if (abort.signal.aborted) throw e; /* Missing volume identity cannot authorize pressure cleanup. */ }
      if (Date.now() - Date.parse(r.finishedAt ?? r.updatedAt) < candidateHours * 3_600_000) { keep('retention', 'retention period'); continue; }
      const owner = r.cwd ?? fallbackRepo;
      if (!owner) { keep('orphan', 'repository folder unknown'); continue; }
      // Only ENOENT proves an orphan; other owner/stat failures belong to this item's catch.
      let ownerStat;
      try { ownerStat = previous ? await scan(() => stat(owner), abort.signal) : statSync(owner); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        keep('orphan', `repository folder missing ${owner}`);
        if (!missingRepositories.has(r.id)) { missingRepositories.add(r.id); log(`prune worktree ${r.id}`, `repository folder missing ${owner}`); }
        continue;
      }
      if (!ownerStat.isDirectory()) { keep('unsaved', `repository folder is not a directory ${owner}`); fail(new Error('repository is not a directory')); continue; }
      await yieldTurn(); if ((processed >= (relaxed(tier.tier) ? 1 : PRESSURE_YIELD_FLOOR) || w.housekeepingKind) && options.waiting?.()) { keep('deferred', 'job admission'); continue; }
      if (w.housekeepingKind && w.housekeepingFingerprint) {
        if (await housekeepingFingerprint(w.path, owner, env, abort.signal, commonDirs) === w.housekeepingFingerprint && Date.parse(w.saveRetryAt ?? '') > Date.now()) { keep(w.housekeepingKind); continue; }
        note({ housekeepingKind: '', housekeepingFingerprint: '', saveRetryAt: '' }); w.saveRetryAt = '';
      }
      if (w.saveRetryAt && Date.parse(w.saveRetryAt) > Date.now()) { keep('deferred', 'save retry backoff'); continue; }
      if (processed >= (options.batch ?? 100)) { keep('deferred', 'batch limit'); continue; }
      processed++; note({ lastAttemptAt: new Date(Date.now()).toISOString() });
      const s = await saveWorktree(r, root, fallbackRepo, env, abort.signal, allowed, timeout, { ...options, [rootProof]: roots, commonDirs, proveGroup: true,
        beforeFinal: (commit, saved, diff, excluded) => {
          if (!store.recordWorkspaceCommit(r.id, commit, saved, diff)) throw new Error('the finished workspace record could not be updated');
          note({ excludedPaths: excluded, saveRetryAt: '', ...(saved ? { saveFailures: 0 } : {}) });
          return !allowed() || abort.signal.aborted ? 'pipe is draining or stopping' : groupGone() ? null : 'runner may still be running';
        } });
      if ('keep' in s) {
        const kind: KeptKind = s.keep === 'locked' || s.keep === 'deferred-capacity' ? s.keep : ['runner may still be running', 'pipe is draining or stopping', 'worktreeRoot changed or unresponsive'].includes(s.keep) ? 'deferred' : /submodule|^resource fork on |^extended attribute |^pathname is not valid UTF-8$/.test(s.keep) ? 'needs-archive' : 'unsaved';
        if (kind === 'locked' || kind === 'needs-archive') await park(kind);
        if ((kind === 'unsaved' || kind === 'deferred-capacity') && allowed() && !abort.signal.aborted) fail(new Error(s.keep));
        keep(kind, kind === 'deferred-capacity' ? 'save capacity unknown or insufficient' : s.keep);
        continue;
      }
      const final = await classifyWorktree(w.path, env, abort.signal, [`--git-dir=${s.admin}`, `--work-tree=${w.path}`], options.regenerable, await excludedPaths(w.path, abort.signal, s.classification.regenerable, env));
      if (!allowed() || abort.signal.aborted) { keep('deferred', 'pipe is draining or stopping'); continue; }
      const regenerable = new Set(final.regenerable.map(p => p.replace(/\/$/, '')));
      if (final.nested.length || final.ignored.some(p => !underRoot(p, regenerable))) {
        await park('needs-archive', true);
        keep('needs-archive', final.nested.length ? 'worktree contains nested repositories' : 'worktree contains non-regenerable ignored content'); continue;
      }
      note({ removing: true, removingAt: new Date().toISOString(), saveFailures: 0, saveDelays: 0 }); clearTimeout(timer); // Removal has its own deadline and ignores Stop/drain.
      try { await runGit(owner, [...s.nf, '-c', 'status.showUntrackedFiles=all', 'worktree', 'remove', w.path], env, undefined, undefined,
        { proveGroup: true, timeoutMs: options.removeTimeoutMs ?? 600_000 }); } catch (e) {
        if ((e as { exitCode?: number }).exitCode === 128 && await removalIntact(w.path, s.admin, s.indexed, timeout)) note({ removing: false, removingAt: '' });
        throw e;
      }
      if (!previous && !await rootDeadline(timeout, undefined, s => checkCurrentRoot(roots, s))) { keep('partial-removal', 'worktreeRoot changed or unresponsive'); continue; }
      note({ removedAt: new Date().toISOString() });
      report.removed.push({ requestId: r.id, path: w.path, branch: w.branch, commit: s.commit, saved: s.saved });
    } catch (e) {
      // Parking needs the same deadline/group handling as saving, including a second failure in its fingerprint.
      if ((e as { needsArchive?: boolean })?.needsArchive) {
        try { await park('needs-archive'); keep('needs-archive', message(e)); continue; }
        catch (parkingError) { e = parkingError; }
      }
      const hung = (e as { groupClosed?: boolean })?.groupClosed === false || !!(e as { hungVolume?: boolean })?.hungVolume; hungVolume ||= hung || scansPending();
      if (hung) e = Object.assign(new Error('hung volume', { cause: e }), { hungVolume: true }); else if (timedOut && !signal?.aborted) e = Object.assign(new Error('save timed out', { cause: e }), { saveTimeout: true, nonStrike: (e as { nonStrike?: boolean })?.nonStrike });
      // A failed receipt write must not reject the pass, including a second failure while recording backoff.
      try { if (finished(r)) fail(!hung && !(e as { nonStrike?: boolean })?.nonStrike && timedOut ? Object.assign(new Error(message(e)), { saveTimeout: true }) : e); }
      catch (recordError) { log(`prune worktree ${r.id} backoff`, recordError); }
      keep(hung ? 'deferred' : 'unsaved', message(e));
      report.failed.push({ requestId: r.id, path: w.path, message: message(e) }); log(`prune worktree ${r.id}`, e);
      if (hung || signal?.aborted) break;
    } finally { clearTimeout(timer); saveTimeouts.delete(abort.signal); signal?.removeEventListener('abort', stop); }
    await yieldTurn();
  }
  await refreshPrevious();
  // Count retained records without a second, unbounded filesystem sweep of previous volumes.
  report.unsaveable = records.filter(r => r.workspace?.unsaveable && !r.workspace.removedAt && !store.get(r.id)?.workspace?.removedAt).length;
  report.keptCounts = Object.fromEntries(['retention', 'unsaved', 'unsaveable', 'needs-archive', 'orphan', 'running', 'locked', 'deferred', 'deferred-capacity', 'partial-removal'].map(kind => [kind, report.kept.filter(e => e.kind === kind).length]));
  try { report.worktreeCount = !currentOK || hungVolume || scansPending() ? currentRootMissing(root) && report.unavailableCurrentRoot?.retainedRecords === 0 && !hungVolume ? 0 : null : readdirSync(roots.roots[0] ?? root, { withFileTypes: true }).filter(e => e.isDirectory()).length; }
  catch (e) { report.worktreeCount = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null; }
  report.durationMs = Math.round(performance.now() - elapsed);
  return report;
}

export function housekeepingStatus(_store: Store, root: string, keepHours: number, options: HousekeepingConfig = {},
  statfs?: DiskStatfs, report?: PruneReport): HousekeepingStatus {
  const disk = scansPending() ? { freeGiB: null, freeShare: null } : worktreeDisk(root, statfs), tier = housekeepingTier(disk.freeShare, keepHours, options.tiers);
  return { worktreeCount: report?.worktreeCount ?? null, ...disk, ...tier, gate: housekeepingGate(), unsaveable: report?.unsaveable ?? null,
    lastPass: report ? { at: report.at!, durationMs: report.durationMs!, removed: report.removed.length, kept: report.keptCounts ?? {}, failed: report.failed.length } : null };
}

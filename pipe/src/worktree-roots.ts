/** Existing ancestors expose aliases; cache current roots and bind migration proof. Previous-root reads are abortable. */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { message, scan, scansPending, saveTimeouts } from './classify.ts';

type Canonical = { path: string; exists: boolean; ancestor?: string };
type Guard = readonly [string, string, boolean];
export type RootProof = Readonly<{ root: string; roots: readonly string[]; unavailable: readonly string[]; reason?: string; marker?: string; dev?: number; ancestor?: string; guards?: readonly Guard[]; origins?: readonly (readonly [string, string])[] }>;
export const rootProof = Symbol('resolved worktree roots');
const refreshed = new WeakMap<RootProof, RootProof>(), startupProofs = new WeakSet<RootProof>(), currentCache = new Map<string, RootProof>(), warnings = new Set<string>(), currentChecks = new Map<string, boolean | 'missing'>();
export type RootLocations = { worktreeVolumeMarker?: string; storePath?: string; tmpRoot?: string; workDir?: string; log?: (where: string, error: unknown) => void; validatedRoots?: RootProof; [rootProof]?: RootProof };
const lostRoots = new Map<string, string>();
export const rootLost = (root: string): string | undefined => lostRoots.get(resolve(root));
const loseRoot = (root: string, reason: string): string => { const key = resolve(root); if (!lostRoots.has(key)) lostRoots.set(key, reason); return reason; };
const markerMessage = (path: string): string => `worktreeRoot volume marker missing: ${path} (volume not mounted?); the Pipe will not start until it exists`;
async function markerReady(proof: RootProof, signal?: AbortSignal): Promise<boolean> {
  if (!proof.marker) return true;
  try { const entry = await (signal ? scan(() => lstat(proof.marker!), signal) : lstat(proof.marker));
    if (signal?.aborted) return false;
    if (entry.isFile() && !entry.isSymbolicLink()) return true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || signal?.aborted) throw e; }
  loseRoot(proof.root, markerMessage(proof.marker)); return false;
}
async function checkParent(root: string, signal?: AbortSignal): Promise<void> {
  try { await (signal ? scan(() => stat(dirname(resolve(root))), signal) : stat(dirname(resolve(root)))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !signal?.aborted) loseRoot(root, 'worktreeRoot parent missing (volume not mounted?)'); }
}
export const inside = (path: string, root: string): boolean => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
function canonical(path: string): Canonical {
  let at = resolve(path);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const ancestor = realpathSync.native(at);
  return { path: resolve(ancestor, relative(at, resolve(path))), exists: at === resolve(path), ancestor };
}
function currentProof(root: string): RootProof {
  const current = canonical(root), dev = lstatSync(current.ancestor!).dev;
  return { root: resolve(root), roots: [current.path], unavailable: [], dev, ancestor: current.ancestor };
}
export function currentRoots(root: string, pending = false): RootProof {
  const key = resolve(root), cached = currentCache.get(key);
  if (cached) return cached;
  const empty = { root: key, roots: [], unavailable: [] };
  if (pending) return empty;
  try { const proof = currentProof(root); currentCache.set(key, proof); return proof; } catch { return empty; }
}
export const sealedRoots = (root: string, proof?: RootProof): RootProof | undefined => proof?.root === resolve(root) && startupProofs.has(proof) ? refreshed.get(proof) ?? proof : undefined;
/** Create only the final directory: a missing mount parent must never be made on the boot disk. */
export async function makeWorktreeRoot(root: string): Promise<string> {
  const proof = currentRoots(root);
  if (proof.marker && !await markerReady(proof)) throw new Error(rootLost(root));
  try {
    try { await mkdir(root); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !(await stat(root)).isDirectory()) throw e;
    }
    const path = await realpath(root);
    if (path !== proof.roots[0]) throw new Error('worktreeRoot is not the folder proven at startup');
    if ((await lstat(path)).dev !== proof.dev) throw new Error(loseRoot(root, 'worktreeRoot is on a different volume than at startup'));
    return path;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { await checkParent(root); throw new Error('worktreeRoot parent missing (volume not mounted?)'); }
    throw e;
  }
}
function paths(previous: unknown): string[] {
  if (previous === undefined) return [];
  if (!Array.isArray(previous) || previous.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error('previousWorktreeRoots must be an array of absolute paths');
  return previous;
}
function locations(root: string, loc: RootLocations, env: NodeJS.ProcessEnv): Guard[] {
  const folder = loc.storePath ? dirname(resolve(loc.storePath)) : undefined;
  // Both-way guards forbid descendants too; state, HOME and default workDir may contain a work volume.
  return ([['worktreeRoot', root, true], ['tmpRoot', loc.tmpRoot ?? (folder && join(folder, 'tmp')), true],
    ['workDir', loc.workDir ?? folder, loc.workDir !== undefined], ['store', folder, false], ['store', loc.storePath, false],
    ['HOME', env.HOME || homedir(), false], ['HOME', process.env.HOME || homedir(), false]] as const)
    .flatMap(([name, path, both]) => path === undefined ? [] : [[name, path, both] as const]);
}
function proof(root: string, current: RootProof, previous: string[], resolved: Canonical[], guards: readonly Guard[], prior?: RootProof): RootProof {
  const roots = [...current.roots], unavailable: string[] = [], protectedRoots = [...guards];
  previous.forEach((path, i) => {
    const old = resolved[i]!;
    const conflict = protectedRoots.find(([, other, both]) => old.path === other || inside(other, old.path) || (both && inside(old.path, other)));
    if (conflict) throw new Error(`previousWorktreeRoots ${path} conflicts with ${conflict[0]} ${conflict[1]}`);
    protectedRoots.push([`previous root ${path}`, old.path, true]);
    if (old.exists) roots.push(old.path); else unavailable.push(path);
  });
  const origins = previous.map((path, i) => Object.freeze([path, resolved[i]!.exists ? resolved[i]!.path : prior?.origins?.find(([p]) => p === path)?.[1] ?? resolved[i]!.path] as const));
  return Object.freeze({ root: resolve(root), marker: current.marker, dev: current.dev, ancestor: current.ancestor, origins: Object.freeze(origins), roots: Object.freeze(roots), unavailable: Object.freeze(unavailable), guards: Object.freeze(guards.map(guard => Object.freeze([...guard]) as Guard)) });
}
export function validateWorktreeRoots(root: string, previous: unknown, loc: RootLocations = {}, env = process.env): RootProof {
  const old = paths(previous), base = currentProof(root), marker = loc.worktreeVolumeMarker;
  let current = base;
  if (marker !== undefined) {
    if (typeof marker !== 'string' || !marker || marker === '.' || marker === '..' || /[/\\\0]/u.test(marker)) throw new Error('worktreeVolumeMarker must be a plain file name');
    const path = join(dirname(resolve(root)), marker);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(markerMessage(path));
    current = { ...base, marker: path };
  }
  const guards = old.length ? locations(root, loc, env).map(([name, path, both]) => [name, canonical(path).path, both] as const) : [];
  const resolved = old.map(path => { try { return canonical(path); } catch { return { path: resolve(canonical(dirname(path)).path, relative(dirname(path), path)), exists: false }; } });
  const result = proof(root, current, old, resolved, guards); currentCache.set(resolve(root), current);
  // A root-only validation cannot certify the protected service locations for a later save.
  if (loc.storePath !== undefined) startupProofs.add(result);
  return result;
}
async function canonicalScan(path: string, signal: AbortSignal, previous = false): Promise<Canonical> {
  let at = resolve(path), exists = true;
  for (;;) {
    try { return { path: resolve(await scan(() => realpath(at), signal), relative(at, resolve(path))), exists }; }
    catch (e) {
      if (signal.aborted || (e as { hungVolume?: boolean })?.hungVolume || (!previous && (e as NodeJS.ErrnoException).code !== 'ENOENT')) throw e;
      if (at === dirname(at)) throw e;
      exists = false; at = dirname(at);
    }
  }
}
/** Same item deadline and hang gate for root availability, candidate metadata and open records. */
export async function rootDeadline<T>(timeout: number, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController(), stop = () => abort.abort(signal?.reason);
  const timer = setTimeout(() => abort.abort(Object.assign(new Error('save timed out'), { saveTimeout: true })), timeout);
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  saveTimeouts.set(abort.signal, timeout);
  try { return await work(abort.signal); } finally { clearTimeout(timer); saveTimeouts.delete(abort.signal); signal?.removeEventListener('abort', stop); }
}
export async function runtimeRoots(root: string, previous: string[] | undefined, loc: RootLocations, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<RootProof> {
  const current = currentRoots(root), sealed = sealedRoots(root, loc.validatedRoots);
  if (!current.roots.length) return { ...current, unavailable: previous ?? [] };
  try {
    const old = paths(previous);
    const guards: Guard[] = [];
    if (sealed?.guards?.length) guards.push(...sealed.guards);
    else if (old.length) for (const [name, path, both] of locations(root, loc, env)) guards.push([name, name === 'worktreeRoot' ? current.roots[0]! : (await canonicalScan(path, signal)).path, both]);
    const resolved: Canonical[] = [];
    for (const path of old) resolved.push(await canonicalScan(path, signal, true));
    const result = proof(root, current, old, resolved, guards, sealed);
    if (sealed) refreshed.set(loc.validatedRoots!, result);
    return result;
  } catch (e) {
    const result = { ...current, origins: sealed?.origins, guards: sealed?.guards, unavailable: previous ?? [], reason: message(e) };
    if (sealed) refreshed.set(loc.validatedRoots!, result);
    if (signal.aborted || (e as { hungVolume?: boolean })?.hungVolume) throw e;
    const reason = message(e), key = `${root}: ${reason}`;
    if (!warnings.has(key)) { warnings.add(key); loc.log?.('ignore previous worktree roots', e); }
    return result;
  }
}
/** Check the startup binding abortably per pass, finalization and save; publish only a completed check. */
export const currentRootReady = (root: string): boolean | undefined => { const checked = currentChecks.get(resolve(root)); return checked === 'missing' ? false : checked; };
export const currentRootMissing = (root: string): boolean => currentChecks.get(resolve(root)) === 'missing';
export async function checkCurrentRoot(roots: RootProof, signal: AbortSignal, pass = true): Promise<boolean> {
  if (!pass && scansPending()) throw Object.assign(new Error('hung volume'), { hungVolume: true });
  const key = resolve(roots.root); let ready: boolean | 'missing' = false;
  try {
    if (!pass) await Promise.resolve(); // Settle a queued service stop before starting an abandonable read.
    if (roots.marker && !await markerReady(roots, signal)) return false;
    if (await scan(() => realpath(roots.root), signal) !== roots.roots[0]) return false;
    const entry = await scan(() => lstat(roots.roots[0]!), signal);
    if (signal.aborted || !entry.isDirectory() || entry.isSymbolicLink() || roots.dev === undefined) return false;
    if (entry.dev !== roots.dev) { loseRoot(key, 'worktreeRoot is on a different volume than at startup'); return false; }
    ready = true; return true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { ready = 'missing'; await checkParent(key, signal); } return false; } finally { currentChecks.set(key, ready); }
}
function currentTail(path: string, roots: RootProof): string | undefined {
  const resolved = resolve(path), base = [roots.root, roots.roots[0]].find(root => root && inside(resolved, root));
  return base ? relative(base, resolved) : undefined;
}
/** Walk the lexical or canonical tail from the proven canonical root; never follow links or mount points. */
export function currentPathSafe(path: string, roots: RootProof): boolean {
  const tail = currentTail(path, roots);
  if (tail === undefined || !roots.roots[0]) return false;
  let at = roots.roots[0];
  for (const part of tail.split(sep)) {
    at = join(at, part);
    const entry = lstatSync(at, { throwIfNoEntry: false });
    if (!entry) return true; // Missing paths retain the existing missing/removing flow.
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== roots.dev) return false;
  }
  return true;
}
export async function insideWorktreeRoots(path: string, roots: RootProof, signal: AbortSignal): Promise<boolean> {
  if (!roots.roots.length) return false;
  const tail = currentTail(path, roots), current = tail !== undefined;
  try { if (current && !currentPathSafe(path, roots)) return false;
    const real = current ? realpathSync.native(join(roots.roots[0]!, tail!)) : await scan(() => realpath(path), signal); return roots.roots.some(root => inside(real, root)); }
  catch (e) { if (signal.aborted || (e as { hungVolume?: boolean })?.hungVolume) throw e; return false; }
}
export const pathEntry = (path: string, signal: AbortSignal) => scan(() => lstat(path), signal).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; });

/** Missing aliases still own records written under their last admitted canonical root. */
export const underPreviousRoot = (path: string, root: string, proof: RootProof): boolean =>
  inside(resolve(path), resolve(root)) || proof.origins?.some(([p, real]) => p === root && inside(resolve(path), real)) === true;

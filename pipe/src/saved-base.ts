/** A saved base is a Store receipt plus current repository/worktree proof, never a branch naming convention. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { noFilters, runGit } from './disk.ts';
import type { RequestRecord } from './store.ts';

export const commitHash = (v: unknown): v is string => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
export type SavedStart = { requestId: string; cwd: string; path: string; branch: string; commit: string; startCommit: string;
  repository: string; device: string; inode: string };
export function validSavedStart(v: unknown): v is SavedStart {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as SavedStart;
  return ['requestId', 'cwd', 'path', 'branch', 'repository', 'device', 'inode'].every(k => typeof (v as Record<string, unknown>)[k] === 'string' && (v as Record<string, string>)[k] !== '')
    && commitHash(p.commit) && commitHash(p.startCommit);
}
export function sourceReceipt(r: RequestRecord | undefined): Omit<SavedStart, 'repository' | 'device' | 'inode'> {
  const w = r?.workspace;
  if (!r || !r.mutating || r.state !== 'completed' || !r.cwd || !w || !['saved', 'no_changes'].includes(w.saved ?? '') || !commitHash(w.commit) || !commitHash(w.startCommit))
    throw new Error('saved source receipt is missing or not saved');
  return { requestId: r.id, cwd: r.cwd, path: w.path, branch: w.branch, commit: w.commit, startCommit: w.startCommit };
}

/** Shared preclaim and final runner check; the receipt is read again after asynchronous Git. */
export async function validateSavedStart(spec: { mutating: boolean; cwd?: string; expectedStartCommit?: string; startSource?: SavedStart },
  source: (id: string) => RequestRecord | undefined, env = process.env, signal?: AbortSignal): Promise<void> {
  if (!spec.mutating || !spec.cwd || !commitHash(spec.expectedStartCommit) || !validSavedStart(spec.startSource)) throw new Error('invalid saved source selector');
  await inspectSavedStart(spec.cwd, spec.expectedStartCommit, source(spec.startSource.requestId), env, signal, spec.startSource);
  const { repository, device, inode, ...receipt } = spec.startSource;
  if (JSON.stringify(sourceReceipt(source(spec.startSource.requestId))) !== JSON.stringify(receipt)) throw new Error('saved source receipt changed');
}

/** Every command is bounded, abortable and uses the same no-hook/group runner as execution. No object imports. */
export async function inspectSavedStart(cwd: string, commit: string, receipt: RequestRecord | undefined,
  env = process.env, signal?: AbortSignal, expected?: SavedStart): Promise<SavedStart> {
  const p = sourceReceipt(receipt);
  if (!commitHash(commit) || p.commit !== commit) throw new Error('saved source commit does not match');
  const read = async (at: string, args: string[], maxOutputBytes = 64 * 1024) => (await runGit(at, ['--no-replace-objects', ...args], env, signal,
    undefined, { timeoutMs: 10_000, maxOutputBytes })).output.toString('utf8').trim();
  const common = async (at: string) => realpathSync(await read(at, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const repository = await common(cwd), identity = statSync(repository, { bigint: true });
  const proof = { ...p, repository, device: String(identity.dev), inode: String(identity.ino) };
  if (expected && JSON.stringify(proof) !== JSON.stringify(expected)) throw new Error('saved source binding changed');
  const sourcePath = realpathSync(p.path), top = async () => realpathSync(await read(p.path, ['rev-parse', '--show-toplevel']));
  if (await top() !== sourcePath) throw new Error('saved source worktree is redirected');
  if (await common(p.cwd) !== repository || await common(p.path) !== repository) throw new Error('saved source belongs to another repository');
  if (existsSync(join(repository, 'objects', 'info', 'alternates'))) throw new Error('saved source uses an alternate object store');
  for (const at of [cwd, p.path]) if (/^(?:extensions\.partialclone|remote\..*\.promisor)$/im.test(await read(at, ['config', '--list', '--name-only'])))
    throw new Error('saved source may fetch promised objects');
  const admin = join(repository, 'worktrees', basename(p.path));
  if (readFileSync(join(admin, 'gitdir'), 'utf8').trim() !== join(realpathSync(p.path), '.git') ||
    realpathSync(await read(p.path, ['rev-parse', '--absolute-git-dir'])) !== realpathSync(admin)) throw new Error('saved source registration changed');
  const blocks = (await read(cwd, ['worktree', 'list', '--porcelain'], 16 * 1024 * 1024)).split(/\n\s*\n/);
  if (!blocks.some(b => { const lines = b.split('\n'); return lines.includes(`worktree ${realpathSync(p.path)}`) && lines.includes(`branch refs/heads/${p.branch}`); }))
    throw new Error('saved source worktree is no longer registered');
  if (await read(cwd, ['cat-file', '-t', commit]) !== 'commit' ||
    await read(cwd, ['rev-parse', '--verify', `refs/heads/${p.branch}`]) !== commit ||
    await read(p.path, ['symbolic-ref', '--quiet', 'HEAD']) !== `refs/heads/${p.branch}` ||
    await read(p.path, ['rev-parse', '--verify', 'HEAD']) !== commit) throw new Error('saved source branch or commit changed');
  const nf = await noFilters(p.path, env, signal);
  if (await read(p.path, [...nf, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'])) throw new Error('saved source has unsaved changes');
  // The final observation catches a changed repository or source during the earlier reads.
  const finalPath = await common(cwd), final = statSync(finalPath, { bigint: true });
  if (finalPath !== repository || String(final.dev) !== proof.device || String(final.ino) !== proof.inode || await top() !== sourcePath || await read(cwd, ['rev-parse', '--verify', `refs/heads/${p.branch}`]) !== commit)
    throw new Error('saved source changed during validation');
  return proof;
}

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { makeWorktreeRoot } from './worktree-roots.ts';
import { tcpReachable } from './probe.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeLimitBucket, type BucketName } from './buckets.ts';
import { runGit } from './disk.ts';
import { commitHash, validateSavedStart, type SavedStart } from './saved-base.ts';
import type { RequestRecord, RunnerIdentity } from './store.ts';

export const WORKTREE_ADD_TIMEOUT_MS = 300_000;

export type RunSpec = {
  requestId: string;
  expectedStartCommit?: string;
  pinnedStartCommit?: string;
  requireCleanStart?: boolean;
  startSource?: SavedStart;
  workspaceKey?: string;
  accountId: string;
  provider: 'claude' | 'codex';
  model: string;
  effort: string;
  prompt: string;
  mutating: boolean;
  cwd: string;
  loginDir: string;
  tmpDir?: string;
};

export type RunOptions = {
  cli: { claude?: string; codex?: string };
  env?: Record<string, string | undefined>;
  worktreeRoot?: string;
  signal?: AbortSignal;
  killGraceMs?: number;
  gitTimeoutMs?: number;
  worktreeAddTimeoutMs?: number;
  now?: () => Date;
  reachable?: (provider: RunSpec['provider']) => Promise<boolean>;
  onSpawn?: (runner: RunnerIdentity) => void;
  savedStartSource?: (id: string) => RequestRecord | undefined;
  onWorkspace?: (workspace: Workspace, startCommit: string) => void;
  onBeforeSpawn?: () => void;
  onEvent?: () => void;
  onClosed?: () => void;
};

export type RunErrorKind = 'quota_exhausted' | 'rate_limited' | 'disk_full' | 'setup_timeout' | 'offline' | 'auth' | 'cancelled' | 'other' | 'start_mismatch';
export type Workspace = { path: string; branch: string };

export type RunEvent =
  | { type: 'started'; reportedModel: string | null; sessionId: string | null }
  | { type: 'text'; text: string }
  /** `bucket` is null when the service named none (Codex never does); U1 then holds the whole account. */
  | { type: 'limit'; accountId: string; bucket: string | null; model: string | null; resetsAt: string | null; observedAt: string }
  | { type: 'completed'; result: string; workspace: Workspace | null }
  /**
   * `workspace` is set when changing work is kept for inspection or its worktree could not
   * be removed. `untouched` proves no tool use and group/stream closure; changing work also needs its clean worktree removed.
   */
  | { type: 'failed'; errorKind: RunErrorKind; message: string; workspace: Workspace | null; untouched?: boolean };

const MAX_LINE = 1024 * 1024;
const MAX_EVENT = 1024 * 1024;
const MAX_MESSAGE = 2_000;
const DIAGNOSTIC_CHARS = 8_192;
const QUEUE_HIGH = 64;
const EARLY_MAX = 16;
const MAX_GRACE = 60_000;
const SERVICE_HOST = { claude: 'api.anthropic.com', codex: 'chatgpt.com' } as const;
const PROBE_MS = 21_000;

const LOGIN_VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as const;
const ENV_KEYS: ReadonlySet<string> = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TERM']);
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'Bash'];
const SANDBOX = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: true, allowUnsandboxedCommands: false } });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PLAIN = /^[^\s-][^\s]{0,127}$/;

type Kind = RunErrorKind | 'auth?';
const DISK_FULL = /ENOSPC|no space left on device|EDQUOT|disk quota exceeded|disk is full|not enough space/i;
const KINDS: Array<[Kind, RegExp]> = [
  ['rate_limited', /\brate[ _-]?limit|too many requests|\b429\b/i],
  // Tied to allowance terms: a token, turn, recursion or disk limit is not an exhausted allowance.
  ['quota_exhausted', /(?:usage|weekly|daily|monthly|hourly|session|5-hour|five-hour|plan|subscription) limit|insufficient_quota|(?:usage|plan|account) quota|out of credits|credits? (?:are )?exhausted/i],
  ['disk_full', DISK_FULL],
  ['offline', /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|network|connection (?:error|refused|reset|closed)|socket hang up|fetch failed|unable to connect|error sending request|stream disconnected|timed out/i],
  ['auth', /authentication_error|invalid (?:x-)?api[ -]?key|unauthori[sz]ed|\b401\b|(?:oauth|access|refresh) token (?:has )?(?:expired|been revoked)|token (?:has )?expired/i],
  ['auth?', /not logged in|\/login|log ?in again|authenticat/i],
];

type Obj = Record<string, unknown>;

type Stream = {
  emit: (e: RunEvent) => void;
  accountId: string;
  model: string;
  stamp: () => string;
  outcome: { ok: true; result: string } | { ok: false; message: string } | null;
  quota: boolean;
  limits: Set<string>;
  lastMessage: string | null;
  errors: string[];
  toolSeen: boolean;
};

export async function* run(spec: RunSpec, options: RunOptions): AsyncGenerator<RunEvent, void, undefined> {
  // closedAt's proof (READ-CONTRACT-01 step 2): only where nothing of this run can remain. A throwing hook never breaks a run.
  let closedProof = false;
  const proveClosed = (): void => { closedProof = true; try { options.onClosed?.(); } catch { /* the proof's record never breaks a run */ } };
  const cli = options.cli[spec.provider];
  if (!cli) { yield failed('other', `no ${spec.provider} CLI is configured`); return; }
  if (typeof spec.accountId !== 'string' || !SAFE_ID.test(spec.accountId)) { yield failed('other', 'the run names no account, so nothing it reports could be bound to one'); return; }
  if (!PLAIN.test(spec.model) || !PLAIN.test(spec.effort)) { yield failed('other', 'the model and effort must be plain names'); return; }
  const grace = options.killGraceMs ?? 5_000;
  if (!Number.isInteger(grace) || grace < 0 || grace > MAX_GRACE) { yield failed('other', `killGraceMs must be whole milliseconds from 0 to ${MAX_GRACE}`); return; }
  if (options.gitTimeoutMs !== undefined && (!Number.isSafeInteger(options.gitTimeoutMs) || options.gitTimeoutMs <= 0 || options.gitTimeoutMs > 2_147_483_647)) {
    yield failed('other', 'gitTimeoutMs must be whole milliseconds from 1 to 2147483647'); return;
  }
  if (options.worktreeAddTimeoutMs !== undefined && (!Number.isSafeInteger(options.worktreeAddTimeoutMs) || options.worktreeAddTimeoutMs <= 0 || options.worktreeAddTimeoutMs > 2_147_483_647)) {
    yield failed('other', 'worktreeAddTimeoutMs must be whole milliseconds from 1 to 2147483647'); return;
  }
  const clock = options.now ?? (() => new Date());
  let last = clock().getTime();
  if (!Number.isFinite(last)) { yield failed('other', 'the pipe clock returned an invalid time'); return; }
  const stamp = (): string => { const t = clock().getTime(); if (Number.isFinite(t) && t > last) last = t; return new Date(last).toISOString(); };
  if (options.signal?.aborted) { proveClosed(); yield failed('cancelled', 'cancelled before the CLI started'); return; }
  const base = allowList(options.env ?? process.env);
  const gitContext: GitContext = { env: base, signal: options.signal, timeoutMs: options.gitTimeoutMs, exact: spec.expectedStartCommit !== undefined || spec.pinnedStartCommit !== undefined, closure: { proven: true } };
  const cleanupContext = (): GitContext => options.signal?.aborted ? { ...gitContext, signal: undefined } : gitContext;
  const setupFailed = (kind: RunErrorKind, message: string, left: Workspace | null = null, untouched = false): RunEvent =>
    options.signal?.aborted
      ? failed('cancelled', 'cancelled while its worktree was being made', left, untouched && gitContext.closure!.proven)
      : failed(kind, message, left, untouched && gitContext.closure!.proven);

  let workspace: Workspace | null = null;
  let created: string | null = null;
  if (spec.pinnedStartCommit !== undefined) {
    if (!spec.mutating || !commitHash(spec.pinnedStartCommit) || spec.expectedStartCommit !== undefined || spec.startSource !== undefined) {
      proveClosed(); yield failed('other', 'invalid pinnedStartCommit selector'); return;
    }
    const observed = await gitRead(spec.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], gitContext);
    if (observed === null) { proveClosed(); yield setupFailed('other', 'could not resolve source HEAD for pinnedStartCommit'); return; }
    const dirty = observed === spec.pinnedStartCommit && spec.requireCleanStart === true
      ? await runGit(spec.cwd, ['--no-replace-objects', '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'], base, options.signal, undefined,
        { timeoutMs: options.gitTimeoutMs ?? 30_000, maxOutputBytes: 1024, truncateOutput: true }).then(r => r.output.length > 0, e => { gitError(gitContext, e); return null; }) : false;
    if (dirty === null) { proveClosed(); yield setupFailed('other', 'could not establish clean source for pinnedStartCommit'); return; }
    if (observed !== spec.pinnedStartCommit || dirty) {
      proveClosed(); yield failed('start_mismatch', `requested pinnedStartCommit ${spec.pinnedStartCommit}; observed HEAD ${observed}${dirty ? '; source tree is dirty' : '; source HEAD differs'}`); return;
    }
    created = spec.pinnedStartCommit;
  }
  if (spec.expectedStartCommit !== undefined || spec.startSource !== undefined) {
    try {
      await validateSavedStart(spec, id => options.savedStartSource?.(id), base, options.signal);
      created = spec.expectedStartCommit!;
    } catch { proveClosed(); yield setupFailed('other', 'expectedStartCommit saved source is unavailable or changed'); return; }
  }
  if (spec.mutating) {
    if (!options.worktreeRoot) { yield failed('other', 'changing work needs a worktreeRoot'); return; }
    if (!SAFE_ID.test(spec.workspaceKey ?? spec.requestId)) { yield failed('other', `request id ${JSON.stringify(spec.workspaceKey ?? spec.requestId).slice(0, 200)} cannot name a branch`); return; }
    let planned: Workspace;
    try { planned = await plannedWorkspace(spec, options.worktreeRoot); }
    catch (e) { yield setupFailed(setupKind(errorText(e)), `could not use the worktreeRoot ${options.worktreeRoot}: ${errorText(e)}`, null, true); return; }
    try { await mkdir(planned.path); }
    catch (e) {
      yield (e as NodeJS.ErrnoException).code === 'EEXIST'
        ? setupFailed('other', `something already exists at ${planned.path}; it is kept for inspection, and nothing new is made`, planned)
        : setupFailed(setupKind(errorText(e)), `could not claim ${planned.path}: ${errorText(e)}`,
          existsSync(planned.path) ? planned : null, !existsSync(planned.path));
      return;
    }
    const exists = await branchExists(spec.cwd, planned.branch, gitContext);
    if (exists !== false || gitContext.exact && await gitRead(spec.cwd, ['symbolic-ref', '--quiet', `refs/heads/${planned.branch}`], gitContext) !== null || !gitContext.closure!.proven) {
      if (gitContext.closure!.proven) await rmdir(planned.path).catch(() => {});
      yield setupFailed('other', exists
        ? `request ${spec.requestId} already has ${planned.branch}; it is kept for inspection, and nothing new is made`
        : `could not tell whether ${planned.branch} exists in ${spec.cwd}; nothing is made`, gitContext.closure!.proven ? null : planned);
      return;
    }
    created ??= await gitRead(spec.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], gitContext);
    if (created === null) {
      if (gitContext.closure!.proven) await rmdir(planned.path).catch(() => {});
      yield setupFailed('other', `could not read the commit to branch from in ${spec.cwd}; nothing is made`, gitContext.closure!.proven ? null : planned);
      return;
    }
    try {
      if (gitContext.exact) await changeOwnedRef(spec.cwd, planned.branch, created, gitContext);
      else await git(spec.cwd, ['branch', planned.branch, created], gitContext);
    }
    catch (e) {
      if (gitContext.closure!.proven) await rmdir(planned.path).catch(() => {});
      const left = (await branchExists(spec.cwd, planned.branch, cleanupContext())) !== false || !gitContext.closure!.proven || existsSync(planned.path) ? planned : null;
      yield setupFailed(setupKind(errorText(e)), `could not create ${planned.branch}: ${errorText(e)}${left ? '; its state needs inspection' : '; nothing is made'}`, left, !left);
      return;
    }
    try {
      workspace = await addWorktree(spec, planned, gitContext, created, options.worktreeAddTimeoutMs ?? options.gitTimeoutMs ?? WORKTREE_ADD_TIMEOUT_MS);
      if (gitContext.exact) {
        if (await gitRead(spec.cwd, ['branch', '--list', '--format=%(objectname) %(symref)', planned.branch], gitContext) !== created ||
          await gitRead(workspace.path, ['rev-parse', '--verify', 'HEAD'], gitContext) !== created) throw new Error('selector branch or worktree HEAD differs from selected object');
        await git(workspace.path, ['symbolic-ref', 'HEAD', `refs/heads/${planned.branch}`], gitContext);
        const tree = await gitRead(spec.cwd, ['rev-parse', '--verify', `${created}^{tree}`], gitContext);
        if (tree === null || await gitRead(workspace.path, ['write-tree'], gitContext) !== tree ||
          await gitRead(workspace.path, ['status', '--porcelain', '--untracked-files=all'], gitContext) !== '' ||
          await gitRead(workspace.path, ['rev-parse', '--verify', 'HEAD'], gitContext) !== created ||
          await gitRead(spec.cwd, ['branch', '--list', '--format=%(objectname) %(symref)', planned.branch], gitContext) !== created) throw new Error('selector checkout contents or ref differs from selected object');
      }
    }
    catch (e) {
      const left = await discard(spec, planned, cleanupContext(), created);
      yield setupFailed(setupKind(errorText(e)), `could not create the worktree: ${errorText(e)}${left ? '; what it made could not be removed' : ''}`, left, !left);
      return;
    }
    try { options.onWorkspace?.(workspace!, created); }
    catch (e) {
      const left = await discard(spec, workspace!, cleanupContext(), created!);
      yield setupFailed(setupKind(errorText(e)), `could not record the worktree before the CLI: ${errorText(e)}`, left, !left);
      return;
    }
  }
  const unstarted = async (kind: RunErrorKind, message: string): Promise<RunEvent> => {
    const kept = workspace && await discard(spec, workspace, cleanupContext(), created!);
    return failed(kind === 'other' ? setupKind(message) : kind,
      kept ? `${message}; its unused worktree or branch could not be removed` : message, kept ?? null, !kept);
  };
  if (options.signal?.aborted) { proveClosed(); yield await unstarted('cancelled', 'cancelled before the CLI started'); return; }

  const claude = spec.provider === 'claude';
  const dir = workspace?.path ?? spec.cwd;
  const spawnMessage = (e: NodeJS.ErrnoException): string => e.code === 'ENOENT' && !existsSync(dir)
    ? `could not start: cwd ${dir} does not exist` : `could not start ${cli}: ${errorText(e)}`;
  const tag = randomUUID();
  const env = { ...base, [LOGIN_VAR[spec.provider]]: spec.loginDir, PIPE_ORIGIN: 'runner', PIPE_ATTEMPT_ID: tag,
    ...(spec.tmpDir ? { TMPDIR: spec.tmpDir } : {}) };
  if (!claude) {
    try { options.onBeforeSpawn?.(); }
    catch (e) { yield await unstarted('other', `could not record the pre-spawn state: ${errorText(e)}`); return; }
  }
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn(cli, claude ? claudeArgs(spec) : codexArgs(spec, dir), { cwd: dir, env, detached: true, stdio: 'pipe' }); }
  catch (e) { proveClosed(); yield await unstarted('other', spawnMessage(e as NodeJS.ErrnoException)); return; }
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const closed = new Promise<void>((r) => child.once('close', () => r()));
  const spawnError = await new Promise<Error | null>((r) => { child.once('spawn', () => r(null)); child.once('error', r); });
  if (spawnError || child.pid === undefined) {
    if (child.pid === undefined) proveClosed();   // no process was made; one with a pid and an error proves nothing
    yield await unstarted('other', spawnError ? spawnMessage(spawnError as NodeJS.ErrnoException) : `could not start ${cli}: no pid`); return;
  }
  child.on('error', () => {});   // a failed kill of a process that already left
  const pid = child.pid;
  const birth = processStart(pid, tag);
  track(pid, child, birth);
  try { options.onSpawn?.({ pid, startedAt: birth ?? `unverified:${tag}` }); }
  catch (e) {
    await stopGroup(pid, grace, birth ?? undefined, child);
    untrack(pid);
    // The prompt was never sent. A worktree still exactly as made is removed, so a full disk can wait and run again.
    const message = `could not record the CLI process group: ${errorText(e)}`;
    if (workspace && created && await groupGone(pid) && await untouchedWorktree(workspace, created, cleanupContext())) {
      const left = await discard(spec, workspace, cleanupContext(), created);
      yield failed(setupKind(message), left ? `${message}; its unused worktree or branch could not be removed` : message, left, !left);
    } else yield failed(setupKind(message), message, workspace, !workspace);
    return;
  }
  child.stdin.on('error', () => {});   // a CLI that exits without reading its prompt
  child.stdin.end(spec.prompt);

  const queue: RunEvent[] = [];
  const early: RunEvent[] = [];
  let wake = () => {};
  let started = false;
  let realStart = false;
  let exitedYet = false;
  const push = (e: RunEvent): void => {
    queue.push(fit(e));
    // Backpressure while the CLI lives; once it has exited, what is left is one pipe buffer.
    if (queue.length >= QUEUE_HIGH && !exitedYet) child.stdout.pause();
    wake();
  };
  const open = (first: RunEvent): void => {
    started = true;
    push(first);
    for (const e of early.splice(0)) push(e);
  };
  const synthetic: RunEvent = { type: 'started', reportedModel: null, sessionId: null };
  const emit = (e: RunEvent): void => {
    if (e.type === 'started') {
      if (realStart) return;
      realStart = true;
      if (!started) open(e); else push(e);
      return;
    }
    if (started) { push(e); return; }
    // Held for the CLI's init, which names the model and session, but never for long.
    early.push(e);
    if (early.length >= EARLY_MAX) open(synthetic);
  };
  const s: Stream = { emit, accountId: spec.accountId, model: spec.model, stamp, outcome: null, quota: false, limits: new Set(), lastMessage: null, errors: [], toolSeen: false };
  const diagnostics: string[] = [];
  let diagnosticChars = 0;
  const note = (line: string): void => {
    const l = clip(line.trim(), 1_000);
    if (!l) return;
    diagnostics.push(l);
    diagnosticChars += l.length;
    while (diagnosticChars > DIAGNOSTIC_CHARS) diagnosticChars -= diagnostics.shift()!.length;
  };

  // A CLI that has reported its outcome but does not exit is stopped after the grace. Stopped by
  // the runner after its outcome, its exit status is the runner's doing, not a failure.
  let stoppedAfterOutcome = false;
  let reap: NodeJS.Timeout | undefined;
  lines(child.stdout, (line) => {
    try { options.onEvent?.(); } catch { /* the clock never breaks a run */ }
    const o = jsonObject(line);
    if (o) (claude ? claudeLine : codexLine)(o, s);
    else { note(line); s.toolSeen = true; }   // both CLIs write only JSON events here: anything else is unproven
    if (s.outcome && !reap && !exitedYet) {
      reap = setTimeout(() => { if (exitedYet) return; stoppedAfterOutcome = true; void stopGroup(pid, grace, birth ?? undefined, child); }, grace);
    }
  }, () => { note('a stdout line over 1 MiB was dropped'); s.toolSeen = true; });   // unread, so it might have been a tool call
  lines(child.stderr, note, () => note('a stderr line over 1 MiB was dropped'));

  let cancelled = false;
  const onAbort = (): void => {
    if (exitedYet) return;
    if (s.outcome) stoppedAfterOutcome = true; else cancelled = true;
    void stopGroup(pid, grace, birth ?? undefined, child);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  let finished = false;
  const done = (async () => {
    const exit = await exited;
    exitedYet = true;
    clearTimeout(reap);
    child.stdout.resume();
    await stopGroup(pid, grace, birth ?? undefined, child);   // whatever the CLI left behind in its group
    const gone = await groupGone(pid);
    untrack(pid);
    // A descendant that left the group can hold the pipes open; it cannot hold the run.
    // Stdout cut off before its end was not fully read: no proof that no tool call was reported.
    const drained = await settles(closed, grace);
    if (!drained) { child.stdout.destroy(); child.stderr.destroy(); s.toolSeen = true; }
    // The group is gone and nothing else holds its pipes: nothing of this run remains that the pipe can see.
    if (gone && drained) proveClosed();
    finished = true;
    wake();
    return exit;
  })();

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (finished) break;
      if (child.stdout.isPaused()) child.stdout.resume();
      await new Promise<void>((r) => { wake = r; if (queue.length > 0 || finished) r(); });
    }
    const exit = await done;
    if (!started) open(synthetic);
    const how = `${spec.provider} ${exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`}`;
    const clean = exit.code === 0 && exit.signal === null;
    if (cancelled) emit(failed('cancelled', `cancelled by the requester; ${how}`, workspace));
    else if (s.outcome?.ok && (clean || stoppedAfterOutcome)) emit({ type: 'completed', result: s.outcome.result, workspace });
    else {
      const said = s.outcome?.ok ? `${spec.provider} reported success, then ${how}`
        : s.outcome?.message ?? s.errors.at(-1) ?? diagnostics.slice(-3).join('\n');
      let kind: Kind = s.quota ? 'quota_exhausted' : classify([s.outcome?.ok ? '' : said, ...s.errors, ...diagnostics].join('\n'));
      // "Not logged in" alone is a hint, settled by reachability: a broken probe proves nothing,
      // so it counts as offline (L11). U4's own identity probe decides a sign-out.
      if (kind === 'auth?') {
        const up = await within(Promise.resolve().then(() => (options.reachable ?? serviceReachable)(spec.provider)), options.reachable ? 5_000 : PROBE_MS);
        kind = up === true ? 'auth' : 'offline';
      }
      const message = s.outcome?.ok ? said : said ? `${said} (${how})` : `${how} without a result`;
      if (spec.mutating && workspace && created && !s.toolSeen && !options.signal?.aborted
        && (kind === 'auth' || kind === 'rate_limited' || kind === 'quota_exhausted' || kind === 'disk_full')
        && await groupGone(pid) && await untouchedWorktree(workspace, created, gitContext)) {
        // discard removes it only while it is still exactly as made, without --force, and the branch only after it.
        const left = await discard(spec, workspace, gitContext, created);
        emit(left ? failed(kind, `${message}; its untouched worktree or branch could not be removed`, left)
          : failed(kind, message, null, true));
      } else emit(failed(kind, message, workspace, !spec.mutating && !workspace && closedProof && !s.toolSeen && !options.signal?.aborted));
    }
    while (queue.length > 0) yield queue.shift()!;
  } finally {
    clearTimeout(reap);
    options.signal?.removeEventListener('abort', onAbort);
    // The consumer left early: nobody will read the result, so stop spending on it.
    if (!finished) { await stopGroup(pid, grace, birth ?? undefined, child); await done; }
  }
}

function claudeArgs(spec: RunSpec): string[] {
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', spec.model, '--effort', spec.effort,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands',
    ...(spec.mutating
      ? ['--tools', WRITE_TOOLS.join(','), '--permission-mode', 'acceptEdits', '--settings', SANDBOX]
      : ['--tools', READ_TOOLS.join(','), '--permission-mode', 'dontAsk', '--no-session-persistence']),
  ];
}

function codexArgs(spec: RunSpec, dir: string): string[] {
  return [
    // Only read-only work may run outside a repository; changing work always has its worktree.
    'exec', '--ignore-user-config', '--json', ...(spec.mutating ? [] : ['--skip-git-repo-check']), '-m', spec.model,
    '-c', `model_reasoning_effort=${spec.effort}`, '--sandbox', spec.mutating ? 'workspace-write' : 'read-only',
    '-C', dir, '--', '-',
  ];
}

function claudeLine(o: Obj, s: Stream): void {
  if (o.type === 'system' && o.subtype === 'init') {
    s.emit({ type: 'started', reportedModel: ident(o.model), sessionId: ident(o.session_id) });
  } else if (o.type === 'assistant') {
    const message = obj(o.message), content = message?.content;
    // Only a list of well-formed plain blocks proves there was no tool call.
    if (!message || !Array.isArray(content)) s.toolSeen = true;
    for (const block of Array.isArray(content) ? content : []) {
      const b = obj(block);
      // Fails closed, as for Codex: only a well-formed text or thinking block is proved to be plain output.
      if (!plainClaudeBlock(b)) s.toolSeen = true;
      if (b?.type === 'text' && typeof b.text === 'string' && b.text !== '') s.emit({ type: 'text', text: b.text });
    }
  } else if (o.type === 'user') {
    s.toolSeen = true;   // mid-run user events carry tool results
  } else if (o.type === 'rate_limit_event') {
    const info = obj(o.rate_limit_info);
    const type = ident(info?.rateLimitType);
    if (info?.status === 'rejected') hitLimit(s, type === null ? null : claudeLimitBucket(type, s.model), fromSeconds(info.resetsAt));
  } else if (o.type === 'result' && !s.outcome) {
    if (o.subtype === 'success' && o.is_error !== true) { s.outcome = { ok: true, result: str(o.result) ?? '' }; return; }
    const errors = (Array.isArray(o.errors) ? o.errors : []).map((e) => str(e) ?? str(obj(e)?.message));
    const message = [...errors, str(o.result)].filter((m): m is string => !!m).join('; ');
    s.outcome = { ok: false, message: message || `result ${String(o.subtype)}` };
  }
}

/** Plain output, well formed: text with string text, thinking with string thinking, redacted thinking with string data. */
function plainClaudeBlock(b: Obj | null): boolean {
  return b?.type === 'text' ? typeof b.text === 'string'
    : b?.type === 'thinking' ? typeof b.thinking === 'string'
    : b?.type === 'redacted_thinking' ? typeof b.data === 'string' : false;
}

function codexLine(o: Obj, s: Stream): void {
  // Every item event counts (started, updated, completed): fails closed for any item that is not plain output.
  if (typeof o.type === 'string' && o.type.startsWith('item.')) {
    const item = obj(o.item), type = item?.type;
    // Plain output, well formed, as for Claude: messages and reasoning with string text, errors with a string
    // message, todo lists with a list of items.
    const plain = type === 'agent_message' || type === 'reasoning' ? typeof item!.text === 'string'
      : type === 'error' ? typeof item!.message === 'string' : type === 'todo_list' ? Array.isArray(item!.items) : false;
    if (!plain) s.toolSeen = true;
  }
  if (o.type === 'thread.started') {
    s.emit({ type: 'started', reportedModel: ident(o.model), sessionId: ident(o.thread_id) });
  } else if (o.type === 'item.completed') {
    const item = obj(o.item);
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      s.lastMessage = item.text;
      if (item.text !== '') s.emit({ type: 'text', text: item.text });
    }
  } else if (o.type === 'error' || o.type === 'turn.failed') {
    // Codex also reports recoverable trouble (reconnects) as `error`; only turn.failed ends the turn.
    const message = str(o.type === 'error' ? o.message : obj(o.error)?.message) ?? '';
    if (message) s.errors = [...s.errors.slice(-4), clip(message, 1_000)];
    // Codex names neither the bucket nor a machine-readable reset, so neither is guessed. A rate
    // limit is not an exhausted bucket, so only quota wording is reported as a limit.
    if (classify(message) === 'quota_exhausted') hitLimit(s, null, null);
    if (o.type === 'turn.failed' && !s.outcome) s.outcome = { ok: false, message: message || 'the turn failed' };
  } else if (o.type === 'turn.completed' && !s.outcome) {
    s.outcome = { ok: true, result: s.lastMessage ?? '' };
  }
}

function hitLimit(s: Stream, name: BucketName | null, resetsAt: string | null, exhausted = true): void {
  if (exhausted) s.quota = true;
  const key = JSON.stringify([name?.bucket ?? null, name?.model ?? null, resetsAt]);
  if (s.limits.has(key)) return;
  s.limits.add(key);
  // Named as the probe names readings (buckets.ts), so a later reading can clear the hold. A
  // limit with no name, or with no model in its name, holds the whole account (model null).
  s.emit({ type: 'limit', accountId: s.accountId, bucket: name?.bucket ?? null, model: name?.model ?? null, resetsAt, observedAt: s.stamp() });
}

function classify(text: string): Kind {
  for (const [kind, pattern] of KINDS) if (pattern.test(text)) return kind;
  return 'other';
}

export const setupKind = (text: string): 'disk_full' | 'setup_timeout' | 'other' =>
  DISK_FULL.test(text) ? 'disk_full' : text.includes('git command timed out after') ? 'setup_timeout' : 'other';

/** Unix seconds from the service, or null. An implausible value is not evidence. */
function fromSeconds(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e11 ? new Date(v * 1000).toISOString() : null;
}

async function plannedWorkspace(spec: RunSpec, root: string): Promise<Workspace> {
  const key = spec.workspaceKey ?? spec.requestId;
  return { path: join(await makeWorktreeRoot(root), key), branch: `pipe/${key}` };
}

async function addWorktree(spec: RunSpec, w: Workspace, context: GitContext, created: string, timeoutMs: number): Promise<Workspace> {
  await git(spec.cwd, context.exact ? ['worktree', 'add', '--detach', w.path, created] : ['worktree', 'add', w.path, w.branch], { ...context, timeoutMs });
  return w;
}

async function discard(spec: RunSpec, w: Workspace, context: GitContext, created: string): Promise<Workspace | null> {
  const closed = (): boolean => context.closure?.proven !== false;
  if (!closed()) return w;
  const ok = (args: string[]) => gitOk(spec.cwd, args, context);
  if (existsSync(join(w.path, '.git'))) {
    if (!await untouchedWorktree(w, created, context) || !await ok(['worktree', 'remove', w.path])) return w;
  } else {
    await rmdir(w.path).catch(() => {});   // the claimed folder, if git never filled it; never recursive
    if (!existsSync(w.path) && !await ok(['worktree', 'remove', '--force', w.path]) && closed()) await ok(['worktree', 'prune']);
  }
  // The branch goes only once its worktree is gone, and only while it is still the commit this run made (L9).
  if (!closed() || existsSync(w.path)) return w;
  if (context.exact && await gitRead(spec.cwd, ['branch', '--list', '--format=%(objectname) %(symref)', w.branch], context) !== created) return w;
  if (context.exact) {
    try { await changeOwnedRef(spec.cwd, w.branch, created, context, true); } catch { return w; }
  } else await ok(['update-ref', '-d', `refs/heads/${w.branch}`, created]);
  return (await branchExists(spec.cwd, w.branch, context)) !== false || context.exact &&
    await gitRead(spec.cwd, ['symbolic-ref', '--quiet', `refs/heads/${w.branch}`], context) !== null || !closed() ? w : null;
}

async function changeOwnedRef(cwd: string, branch: string, created: string, context: GitContext, remove = false): Promise<void> {
  const dir = mkdtempSync(join(context.env.TMPDIR ?? tmpdir(), 'pipe-ref-'));
  const ref = `refs/heads/${branch}`, zero = '0'.repeat(created.length), marker = join(dir, 'prepared');
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const guard = `
if (process.argv[1] !== 'prepared') process.exit(0);
const { spawnSync } = require('node:child_process');
const g = args => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '--no-replace-objects', ...args],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 });
const sym = g(['symbolic-ref', '--quiet', ${JSON.stringify(ref)}]);
const direct = g(['for-each-ref', '--format=%(objectname) %(symref)', ${JSON.stringify(ref)}]);
if (sym.status !== 1 || direct.status !== 0 || direct.stdout.trim() !== ${JSON.stringify(remove ? created : '')}) process.exit(1);
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'prepared');
`;
  try {
    writeFileSync(join(dir, 'reference-transaction'), `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(guard)} "$@"\n`, { mode: 0o700 });
    const args = ['--no-replace-objects', '-c', `core.hooksPath=${dir}`, 'update-ref', '--no-deref'];
    const limits = { timeoutMs: context.timeoutMs ?? 30_000, maxOutputBytes: 1024 };
    await runGit(cwd, [...args, '--stdin'], context.env, context.signal,
      Buffer.from(`start\nverify ${ref} ${remove ? created : zero}\nprepare\nabort\n`), limits);
    if (!existsSync(marker)) throw new Error('git cannot prove ref type under its transaction lock');
    await runGit(cwd, [...args, ...(remove ? ['-d', ref, created] : [ref, created, zero])], context.env, context.signal, undefined, limits);
  } catch (e) { gitError(context, e); throw e; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** HEAD is still the commit the run branched from, and nothing is changed or added, ignored files included. */
async function untouchedWorktree(w: Workspace, created: string, context: GitContext): Promise<boolean> {
  if (await gitRead(w.path, ['rev-parse', '--verify', 'HEAD^{commit}'], context) !== created) return false;
  return await gitRead(w.path, ['status', '--porcelain', '--untracked-files=all', '--ignored'], context) === '';
}

/** Proof that nothing in the group can still write: a signal-0 probe finds no member, within a short wait. */
async function groupGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) { if (!signalGroup(pid, 0)) return true; await sleep(50); }
  return false;
}

/** Two bounded attempts allow a slow TCP handshake. */
export async function serviceReachable(provider: RunSpec['provider']): Promise<boolean> {
  return tcpReachable(SERVICE_HOST[provider]);
}

type GitContext = { env: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; exact?: boolean; closure?: { proven: boolean } };
function gitError(context: GitContext, error: unknown): void {
  if ((error as { groupClosed?: boolean } | null)?.groupClosed === false && context.closure) context.closure.proven = false;
}

function gitOk(cwd: string, args: string[], context: GitContext): Promise<boolean> {
  return git(cwd, args, context).then(() => true, () => false);
}

/** A git command's trimmed output, or null if it fails. */
function gitRead(cwd: string, args: string[], context: GitContext): Promise<string | null> {
  return runGit(cwd, context.exact ? ['--no-replace-objects', ...args] : args, context.env, context.signal, undefined,
    { timeoutMs: context.timeoutMs ?? 30_000, maxOutputBytes: 1024, truncateOutput: true })
    .then(({ output, truncated }) => (truncated ? null : output.toString('utf8').trim()), e => { gitError(context, e); return null; });
}

/** Whether a branch exists, or null when git cannot say (not a repository, git missing, …). */
function branchExists(cwd: string, branch: string, context: GitContext): Promise<boolean | null> {
  return runGit(cwd, [...(context.exact ? ['--no-replace-objects'] : []), 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], context.env,
    context.signal, undefined, { timeoutMs: context.timeoutMs ?? 30_000 })
    .then(() => true, (e: Error & { exitCode?: number }) => { gitError(context, e); return e.exitCode === 1 ? false : null; });
}

/** The probe's answer, or null if it does not settle within `ms`: an unanswered probe proves nothing. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  try { return await Promise.race([p.catch(() => null), timeout]); }
  finally { clearTimeout(timer); }
}

/** Runs git with a deadline; failure messages keep only the bounded stderr tail. */
async function git(cwd: string, args: string[], context: GitContext, defaultTimeoutMs = 30_000): Promise<void> {
  try { await runGit(cwd, context.exact ? ['--no-replace-objects', ...args] : args, context.env, context.signal, undefined,
    { timeoutMs: context.timeoutMs ?? defaultTimeoutMs, truncateOutput: true }); }
  catch (e) { gitError(context, e); throw Object.assign(new Error(((e as { stderr?: string }).stderr || errorText(e)).slice(-MAX_MESSAGE).trim()), e); }
}

export function allowList(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (ENV_KEYS.has(k) || k.startsWith('LC_'))) out[k] = v;
  return out;
}

function lines(stream: Readable, onLine: (line: string) => void, onDrop: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;
  const add = (piece: Buffer): void => {
    if (dropping || piece.length === 0) return;
    if (size + piece.length > MAX_LINE) { dropping = true; parts = []; size = 0; return; }
    parts.push(piece);
    size += piece.length;
  };
  const flush = (): void => {
    if (dropping) onDrop();
    // A line with any bytes reaches the reader, whitespace-only included; only an empty line carries nothing.
    else if (size > 0) onLine(Buffer.concat(parts, size).toString('utf8').trim());
    parts = []; size = 0; dropping = false;
  };
  stream.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
      add(chunk.subarray(start, nl));
      flush();
      start = nl + 1;
    }
    add(chunk.subarray(start));
  });
  stream.on('end', flush);
}

// ── process groups ──────────────────────────────────────────────────────────

const live = new Map<number, { child: ChildProcessWithoutNullStreams; birth: string | null }>();
let hooked = false;

/** On process exit, signal only CLI groups still ours: a leader with its saved birth, or a group whose leader we saw exit. */
function track(pid: number, child: ChildProcessWithoutNullStreams, birth: string | null): void {
  live.set(pid, { child, birth });
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const [p, { child: owned, birth: mark }] of live) {
      if (leaderExited(owned) || (mark && processStart(p, birthTag(mark), true) === mark)) signalGroup(p, 'SIGKILL');
    }
  });
}

const leaderExited = (child: ChildProcessWithoutNullStreams): boolean => child.exitCode !== null || child.signalCode !== null;

function untrack(pid: number): void { live.delete(pid); }

/** A process birth mark from the OS. If unavailable, restart cannot prove ownership. */
const SELF_START = `self:${new Date(performance.timeOrigin).toISOString()}`;
export const birthTag = (mark: string): string | undefined => mark.startsWith('tag:') ? mark.slice(4) : /^proc:\d+:([a-f0-9-]+)$/.exec(mark)?.[1];
export function processStart(pid: number, tag?: string, requireGroup = tag !== undefined): string | null {
  let stat: string | null = null;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch { /* macOS has no procfs. */ }
  if (stat !== null) {
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if ((!requireGroup || Number(fields[2]) === pid) && /^\d+$/.test(fields[19] ?? '')) {
      if (tag === undefined) return `proc:${fields[19]}`;
      try {
        const environment = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        if (environment.includes(`PIPE_ATTEMPT_ID=${tag}`)) return `proc:${fields[19]}:${tag}`;
        const title = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0', 1)[0];
        if (title === `pipe supervisor PIPE_ATTEMPT_ID=${tag}` || title === `pipe attempt PIPE_ATTEMPT_ID=${tag}`)
          return `proc:${fields[19]}:${tag}`;
      } catch { /* Procfs was present but identity proof failed. */ }
    }
    return null;
  }
  try {
    const group = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim();
    if (requireGroup && Number(group) !== pid) return null;
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim();
    if (!started) return null;
    if (tag !== undefined) {
      const command = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 });
      if (!command.includes(`PIPE_ATTEMPT_ID=${tag}`)) return null;
      return `tag:${tag}`;
    }
    return started;
  } catch { return pid === process.pid && tag === undefined ? SELF_START : null; }
}

/**
 * For a job card (READ-CONTRACT-01): true only when the group's leader carries this runner's birth mark, false only when
 * no group has its id (ESRCH), null otherwise (another user's group, a reused id, no tag): unknown is not guessed.
 */
export function runnerGroupAlive(runner: RunnerIdentity | null): boolean | null {
  if (!runner || !Number.isSafeInteger(runner.pid) || runner.pid <= 1) return null;
  try { process.kill(-runner.pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
  const tag = birthTag(runner.startedAt);
  return tag !== undefined && processStart(runner.pid, tag, true) === runner.startedAt ? true : null;
}

/** Reap a previous service's group only when its leader still has the saved birth mark. */
export async function retireRunner(runner: RunnerIdentity): Promise<void> {
  const { pid, startedAt } = runner;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !startedAt) throw new Error(`runner ${pid} has no process identity`);
  if (startedAt.startsWith('unverified:')) {
    if (signalGroup(pid, 0)) throw new Error(`runner group ${pid} exists without a verifiable identity`);
    return;
  }
  const tag = birthTag(startedAt);
  if (tag === undefined) throw new Error(`runner ${pid} has only a second-resolution birth mark or no unique tag`);
  const current = processStart(pid, tag, true);
  if (current === null) {
    if (signalGroup(pid, 0)) throw new Error(`runner group ${pid} exists without a verifiable leader`);
    return;
  }
  if (current !== startedAt) return; // the old group is gone; this PID now belongs to someone else
  await stopGroup(pid, 5_000, startedAt);
  if (signalGroup(pid, 0) && (processStart(pid, tag, true) === startedAt || processStart(pid, tag, true) === null)) throw new Error(`runner group ${pid} did not stop`);
}

/** True when the signal reached a live group. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * SIGTERM a runner's group, then SIGKILL it at the deadline. A group this process made stays ours
 * after its leader exits: its id cannot be given to another process while any member lives.
 */
async function stopGroup(pid: number, graceMs: number, startedAt?: string, owned?: ChildProcessWithoutNullStreams): Promise<void> {
  const tag = startedAt ? birthTag(startedAt) : undefined;
  const ours = () => (startedAt !== undefined && processStart(pid, tag, true) === startedAt) || owned?.pid === pid;
  if (!ours()) return;
  if (!signalGroup(pid, 'SIGTERM')) return;
  // A monotonic clock: a wall clock stepped back must not postpone the SIGKILL.
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline) {
    await sleep(25);
    if (!signalGroup(pid, 0)) return;
  }
  if (ours()) signalGroup(pid, 'SIGKILL');
}

export async function settles(p: Promise<void>, ms: number): Promise<boolean> {
  return (await within(p.then(() => true), ms)) === true;
}

function failed(errorKind: RunErrorKind, message: string, workspace: Workspace | null = null, untouched = false): Extract<RunEvent, { type: 'failed' }> {
  return { type: 'failed', errorKind, message: clip(message, MAX_MESSAGE) || errorKind, workspace, ...(untouched ? { untouched: true } : {}) };
}

/** Cuts the one large field of an event until it serialises within MAX_EVENT. */
function fit(e: RunEvent): RunEvent {
  for (let over = JSON.stringify(e).length - MAX_EVENT; over > 0; over = JSON.stringify(e).length - MAX_EVENT) {
    const cut = (t: string) => t.slice(0, Math.max(0, t.length - over - 64)) + '\n[truncated by pipe]';
    if (e.type === 'text' && e.text.length > 0) e = { ...e, text: cut(e.text) };
    else if (e.type === 'completed' && e.result.length > 0) e = { ...e, result: cut(e.result) };
    else return e;
  }
  return e;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jsonObject(line: string): Obj | null {
  if (!line.startsWith('{')) return null;
  try { return obj(JSON.parse(line)); } catch { return null; }
}

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A model, session or bucket name; anything missing, empty or absurdly long is unknown. */
function ident(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
}

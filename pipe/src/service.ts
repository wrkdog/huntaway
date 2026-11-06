/** The in-process coordinator: probe, plan, claim, run, and persist the outcome. */
import { basename, dirname, resolve, isAbsolute, join, sep } from 'node:path';
import { accessSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, realpathSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AllowanceLedger, instantOf } from './allowance.ts';
import { modelFamily } from './buckets.ts';
import { availability, IdentityLedger, type Health } from './availability.ts';
import { validateAccounts, type AccountConfig } from './identity.ts';
import { geminiReadOnly, parsePolicy } from './policy.ts';
import { probeAccount, applyProbe, explainUnknownModel, type ProbeOptions, type ProbeReport, codexCreditsConfig } from './probe.ts';
import { plan, inTurns, type AccountStatus } from './queue.ts';
import { processStart, retireRunner, run, serviceReachable, setupKind, type RunOptions, type RunEvent, runnerGroupAlive } from './runner.ts';
import { LAST_INSTANT, Store, type AttemptOutcome, type DispatchEvidence, type RunnerIdentity, type Workspace, type Route, type NewRequest, type RequestRecord } from './store.ts';
import { hostAlias } from './host.ts';
import { startHttp } from './http.ts';
import { capLog, validateRetention } from './retention.ts';
import { attemptTemp, cleanEndedTemps, diskWait, listWorktrees, pruneWorktrees, removeAttemptTemp, runnerGroupGone, saveWorktree, statfsFree, TempRetryQueue, type PruneReport, type HousekeepingConfig, type DiskStatfs, housekeepingStatus, HousekeepingTrigger, validateHousekeeping, validateWorktreeRoots, noteSaveFailure } from './disk.ts';
import { addExternalVote, getReview, refreshReviews, submitReview } from './review.ts';
import { configureGemini, recoverGemini, stopGemini, runningGemini, drainGemini, type GeminiConfig, geminiConfig, geminiChatPrompt, geminiChatRefusal, runGemini, validateGeminiConfig, hasGemini } from './agy.ts';
import { rootLost } from './worktree-roots.ts';
import { eventClock } from './event-clock.ts';
import { validateArgonModels } from './agy-chat.ts';
import { validateSavedStart } from './saved-base.ts';
import { validateProjects, type Projects } from './projects.ts';
import { AdmissionError, validateCapacity, type CapacityOptions } from './admission.ts';

export type PipeConfig = CapacityOptions & {
  accounts: AccountConfig[]; policy: unknown; storePath: string; worktreeRoot: string;
  previousWorktreeRoots?: string[]; worktreeVolumeMarker?: string;
  cli: { claude?: string; codex?: string }; env?: Record<string, string | undefined>;
  gemini?: GeminiConfig;
  token: string; port?: number; reachable?: ProbeOptions['reachable']; tickMs?: number;
  probeIntervalMs?: number; probeRetryMs?: number; minVersion?: ProbeOptions['minVersion'];
  workDir?: string; pinWaitMs?: number; maxAttempts?: number; retryBackoffMs?: number;
  authHoldMs?: number; authHoldMaxMs?: number; maxLimits?: number;
  tmpRoot?: string; worktreeKeepHours?: number; pruneIntervalMs?: number; minFreeGb?: number;
  housekeeping?: HousekeepingConfig; reviewGitTimeoutMs?: number; diskStatfs?: DiskStatfs;
  diskFree?: (path: string) => number; journalWrite?: JournalWrite;
  /** Default true: a completed changing job saves its own work (L64); false leaves the save to prune. */
  saveOnCompletion?: boolean;
  /** Tests only: the event clock's write interval in milliseconds (default 15000). */
  eventWriteMs?: number;
  /** Off when absent: Codex credits the owner did not buy count as room above this floor (rule 49). */
  codexCredits?: { floor: number };
  /** The pipe's release, shown on /v1/health (READ-CONTRACT-01); `serve` sets it from the pipe's own git checkout */
  version?: string | null;
  /** Optional executor label, validated once at startup; never inferred from the machine. */
  hostAlias?: string | null;
  /** Off when absent: a project's context packet and review output contract, read at use (u42). */
  projects?: Projects;
};

/** Resolve once against the environment the child will receive, never the service's PATH. */
export function resolveCli(cli: PipeConfig['cli'], env: Record<string, string | undefined> = process.env): PipeConfig['cli'] {
  const executable = (path: string): boolean => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  };
  const result: PipeConfig['cli'] = {};
  for (const provider of ['claude', 'codex'] as const) {
    const configured = cli[provider];
    const candidates = configured && (isAbsolute(configured) || configured.includes(sep))
      ? [resolve(configured)] : (env.PATH?.split(':').map((part) => resolve(part || '.', configured || provider)) ?? []);
    const found = candidates.find(executable);
    if (found) result[provider] = found;
  }
  return result;
}

const READ = ['Read', 'Grep', 'Glob'];
const WRITE = [...READ, 'Edit', 'Write', 'Bash'];
const RESTARTED = 'the pipe restarted before this attempt reported an outcome';
type HeldRunner = RunnerIdentity & { supervisor?: RunnerIdentity };
type Log = (where: string, e: unknown) => void;
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);

function readIfThere(path: string): string | null {
  try { return readFileSync(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

/** Throws unless the lock's owner is provably gone: a birth mismatch or no such process. */
function assertStale(raw: string): void {
  let held: { pid?: number; startedAt?: string } = {};
  try { held = JSON.parse(raw); }
  catch { held = { pid: Number(/^([1-9]\d*):[a-f0-9-]+$/.exec(raw)?.[1]) }; }
  const pid = held?.pid;
  if (Number.isSafeInteger(pid) && pid! > 0 && !held.startedAt) {
    try { process.kill(pid!, 0); throw new Error('the old pipe lock has a live PID but no process start time'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  if (Number.isSafeInteger(pid) && pid! > 0 && held.startedAt) {
    const current = processStart(pid!);
    if (current === held.startedAt || current === null) {
      try { process.kill(pid!, 0); throw new Error(current === null ? 'the pipe lock owner cannot be verified' : 'the pipe record is already in use'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
}

/** Claim the record atomically before reconciliation. */
export function claimRecord(path: string, resolvingFailure = false): () => void {
  const startedAt = processStart(process.pid);
  if (!startedAt) throw new Error('the pipe process start time cannot be verified');
  const nonce = randomUUID();
  const lock = `${path}.pipe-lock`, gate = `${path}.pipe-takeover`, mine = `${lock}.${nonce}`, owner = JSON.stringify({ pid: process.pid, startedAt, nonce });
  writeFileSync(mine, owner, { flag: 'wx', mode: 0o600 });
  let gateClaimed = false;
  const noLinks = (e: unknown): never => {
    if (['ENOTSUP', 'EOPNOTSUPP'].includes((e as NodeJS.ErrnoException).code ?? '')) throw new Error('the pipe record needs a file system with hard links, for its single-owner lock; put storePath on such a volume');
    throw e;
  };
  const place = (from: string): void => { try { linkSync(from, lock); } catch (e) { noLinks(e); } };
  const writeOwner = (fd: number): void => {
    const bytes = Buffer.from(owner);
    for (let at = 0; at < bytes.length;) {
      const n = writeSync(fd, bytes, at, bytes.length - at);
      if (n <= 0) throw new Error('pipe gate made no write progress');
      at += n;
    }
    fsyncSync(fd);
  };
  const claimGate = (name: string): void => {
    const temp = `${name}.${nonce}`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try { writeOwner(fd); } finally { closeSync(fd); }
      try { linkSync(temp, name); } catch (e) { noLinks(e); }
    } finally { rmSync(temp, { force: true }); }
  };
  try {
    for (let tries = 0; !gateClaimed && tries < 3; tries++) {
      try {
        claimGate(gate);
        gateClaimed = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const raw = readIfThere(gate);
        if (raw === null) continue;
        let former: { pid?: number; startedAt?: string };
        try { former = JSON.parse(raw); }
        catch { throw new Error('pipe lock takeover is busy: gate owner is unknown'); }
        if (!Number.isSafeInteger(former.pid) || !former.startedAt) throw new Error('pipe lock takeover is busy: gate owner is unknown');
        try { assertStale(raw); } catch { throw new Error('pipe lock takeover is busy: its owner may still be alive'); }
        const reaper = `${gate}.reap`;
        let reapClaimed = false;
        for (let reclaimTries = 0; !reapClaimed && reclaimTries < 3; reclaimTries++) {
          try { claimGate(reaper); reapClaimed = true; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const prior = readIfThere(reaper);
            if (prior === null) continue;
            try {
              const p = JSON.parse(prior) as { pid?: number; startedAt?: string };
              if (!Number.isSafeInteger(p.pid) || !p.startedAt) throw new Error('unknown owner');
            } catch { throw new Error('pipe lock takeover reclaim is busy: owner is unknown'); }
            try { assertStale(prior); }
            catch { throw new Error('pipe lock takeover is busy: another process is reclaiming it'); }
            if (readIfThere(reaper) === prior) unlinkSync(reaper);
          }
        }
        if (!reapClaimed) throw new Error('pipe lock takeover reclaim is busy');
        try { if (readIfThere(gate) === raw) unlinkSync(gate); }
        finally { unlinkSync(reaper); }
      }
    }
    if (!gateClaimed) throw new Error('pipe lock takeover is busy');
    if (!resolvingFailure) {
      const failed = failedStopAttempts(path);
      if (failed.length) throw new Error(`failed stop left outcome for attempt ${failed.join(', ')} unresolved; use cli.ts recover --config to supply it or give it up`);
    }
    for (let tries = 0; tries < 3; tries++) {
      try { place(mine); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const raw = readIfThere(lock);
        if (raw === null) continue;
        assertStale(raw);
        if (readIfThere(lock) !== raw) throw new Error('pipe lock changed during takeover');
        const aside = `${lock}.stale-${nonce}`;
        try { renameSync(lock, aside); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (readFileSync(aside, 'utf8') !== raw) {
          try { place(aside); } finally { rmSync(aside, { force: true }); }
          throw new Error('another pipe took over the stale lock first');
        }
        unlinkSync(aside);
        continue;
      }
      if (readIfThere(lock) !== owner) throw new Error('the pipe record lock could not be confirmed as ours');
      return () => { if (readIfThere(lock) === owner) unlinkSync(lock); };
    }
    throw new Error('could not claim the pipe record');
  } finally {
    if (gateClaimed) unlinkSync(gate);
    rmSync(mine, { force: true });
  }
}

export const journalOf = (storePath: string): string => `${storePath}.pipe-journal`;
const failureOf = (storePath: string): string => `${storePath}.pipe-failed-stop`;
const outcomeFile = (path: string, id: string): string => `${resolve(path)}.pipe-outcome-${createHash('sha256').update(id).digest('hex')}`;

function writeOutcomeFile(path: string, id: string, outcome: AttemptOutcome): void {
  const target = outcomeFile(path, id), temp = `${target}.${randomUUID()}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify({ attemptId: id, outcome }));
    for (let at = 0; at < bytes.length;) {
      const n = writeSync(fd, bytes, at, bytes.length - at);
      if (n <= 0) throw new Error('outcome file made no write progress');
      at += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, target);
  const dir = openSync(dirname(resolve(target)), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function replayOutcomeFiles(store: Store, path: string): void {
  const parent = dirname(resolve(path)), prefix = `${basename(path)}.pipe-outcome-`;
  for (const name of readdirSync(parent).filter((name) => name.startsWith(prefix) && /^[a-f0-9]{64}$/.test(name.slice(prefix.length)))) {
    const file = join(parent, name);
    const entry = JSON.parse(readFileSync(file, 'utf8')) as { attemptId?: unknown; outcome?: unknown };
    if (typeof entry.attemptId !== 'string' || !entry.outcome || typeof entry.outcome !== 'object' || outcomeFile(path, entry.attemptId) !== file)
      throw new Error(`invalid durable outcome ${name}`);
    store.finishAttempt(entry.attemptId, entry.outcome as AttemptOutcome);
    rmSync(file);
  }
}

function failedStopAttempts(path: string): string[] {
  const raw = readIfThere(failureOf(path));
  if (raw === null) return [];
  try {
    const ids: unknown = JSON.parse(raw);
    if (Array.isArray(ids) && ids.length && ids.every((id) => typeof id === 'string' && id.length > 0)) return ids;
  } catch { /* A broken marker is never permission to start. */ }
  throw new Error('failed stop marker is unreadable; operator recovery is required');
}

export function markFailedStop(path: string, attemptIds: string[], journaled: ReadonlySet<string> = new Set()): void {
  attemptIds = attemptIds.filter((id) => !journaled.has(id));
  if (!attemptIds.length) { rmSync(failureOf(path), { force: true }); return; }
  const marker = failureOf(path), temp = `${marker}.${randomUUID()}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(attemptIds));
    for (let at = 0; at < bytes.length;) {
      const n = writeSync(fd, bytes, at, bytes.length - at);
      if (n <= 0) throw new Error('failed stop marker made no write progress');
      at += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, marker);
  const dir = openSync(dirname(resolve(marker)), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function recoverFailedStop(path: string, attemptId?: string, outcome?: AttemptOutcome): string[] {
  const release = claimRecord(path, true);
  try {
    const ids = failedStopAttempts(path);
    const store = new Store(path);
    try {
      replayOutcomeFiles(store, path);
      if (statSync(journalOf(path), { throwIfNoEntry: false })?.isFile()) {
        replayJournal(store, journalOf(path), () => {});
        rmSync(journalOf(path), { force: true });
      }
      const unresolved = ids.filter((id) => !store.isAttemptRecorded(id));
      if (unresolved.length) markFailedStop(path, unresolved);
      else rmSync(failureOf(path), { force: true });
      if (attemptId !== undefined) {
        if (!ids.includes(attemptId)) throw new Error(`attempt ${attemptId} is not in the failed stop marker`);
        if (unresolved.includes(attemptId)) store.finishAttempt(attemptId, outcome ?? { kind: 'no_outcome', message: 'operator explicitly gave up the missing outcome' });
      }
      const remaining = unresolved.filter((id) => id !== attemptId);
      if (attemptId !== undefined) markFailedStop(path, remaining);
      return remaining;
    } finally { store.close(); }
  } finally { release(); }
}

type JournalWrite = (fd: number, bytes: Uint8Array, offset: number, length: number) => number;
function appendJournal(path: string, entry: unknown, write: JournalWrite = writeSync): void {
  const fd = openSync(path, 'a', 0o600);
  let start: number | undefined;
  try {
    start = fstatSync(fd).size;
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
    for (let at = 0; at < bytes.length;) {
      const n = write(fd, bytes, at, bytes.length - at);
      if (n <= 0) throw new Error('journal made no write progress');
      at += n;
    }
    fsyncSync(fd);
  } catch (e) {
    if (start !== undefined) try { ftruncateSync(fd, start); fsyncSync(fd); } catch { /* Keep the original write error and pending entry. */ }
    throw e;
  }
  finally { closeSync(fd); }
}

function writeOutcomes(store: Pick<Store, 'finishAttempt'>, pending: Map<string, AttemptOutcome>, log: Log): void {
  for (const [id, outcome] of pending) {
    try { store.finishAttempt(id, outcome); pending.delete(id); }
    catch (e) { log(`finishAttempt ${id}`, e); }
  }
}

export async function saveOutcomes(store: Pick<Store, 'finishAttempt'>, pending: Map<string, AttemptOutcome>, journal: string, log: Log, write: JournalWrite = writeSync): Promise<void> {
  for (let tries = 0; tries < 3 && pending.size > 0; tries++) {
    if (tries > 0) await sleep(100 * tries);
    writeOutcomes(store, pending, log);
  }
  for (const [id, outcome] of pending) {
    try { appendJournal(journal, { attemptId: id, outcome }, write); pending.delete(id); }
    catch (e) { log(`journal ${id}`, e); }
  }
  if (pending.size) throw new Error(`${pending.size} outcome(s) could not be persisted to the store or journal`);
}

export async function persistCompletedOutcome(store: Pick<Store, 'finishAttempt'>, pending: Map<string, AttemptOutcome>, journal: string, log: Log,
  options?: { journaled?: Set<string>; recoveryPath?: string; journalWrite?: JournalWrite; pendingHolds?: ReadonlySet<string>; accountId?: string; heldAttemptId?: string }): Promise<void> {
  if (!options) { await saveOutcomes(store, pending, journal, log); return; }
  const errors: unknown[] = [];
  for (const [id, outcome] of pending) {
    if (id !== options.heldAttemptId || !options.accountId || !options.pendingHolds?.has(options.accountId)) {
      try {
        store.finishAttempt(id, outcome);
        pending.delete(id);
        options.journaled?.delete(id);
        if (options.recoveryPath) rmSync(outcomeFile(options.recoveryPath, id), { force: true });
        continue;
      } catch (e) { log(`finishAttempt ${id}`, e); }
    }
    if (options.journaled?.has(id)) continue;
    try { appendJournal(journal, { attemptId: id, outcome }, options.journalWrite); }
    catch (e) {
      log(`journal ${id}`, e);
      if (!options.recoveryPath) { errors.push(e); continue; }
      try { writeOutcomeFile(options.recoveryPath, id, outcome); }
      catch (fileError) { log(`outcome file ${id}`, fileError); errors.push(new AggregateError([e, fileError], `outcome ${id} has no durable write`)); continue; }
    }
    if (options.journaled) options.journaled.add(id);
    else pending.delete(id);
  }
  if (errors.length) throw new AggregateError(errors, `${errors.length} outcome(s) have no durable write`);
}

/** A probe that began before an offline failure cannot clear that failure. */
export function advanceOfflineMark(marks: Map<string, string>, accountId: string, offline: boolean, beganAt: number): void {
  if (offline) {
    const prior = instantOf(marks.get(accountId)) ?? Number.NEGATIVE_INFINITY;
    if (beganAt >= prior) {
      const mark = new Date(Math.max(beganAt, prior + 1)).toISOString();
      marks.set(accountId, mark);
      implicitConfirmedOffline.get(marks)?.set(accountId, mark);
    }
  } else if (beganAt > (instantOf(marks.get(accountId)) ?? Number.NEGATIVE_INFINITY)) {
    marks.delete(accountId);
    implicitConfirmedOffline.get(marks)?.delete(accountId);
  }
}

const implicitConfirmedOffline = new WeakMap<Map<string, string>, Map<string, string>>();

/** A reachable service makes network-sounding CLI output an ordinary failed try. */
export async function classifyOfflineOutcome(provider: AccountConfig['provider'], reachable: ProbeOptions['reachable'] = serviceReachable): Promise<'offline' | 'transient'> {
  if (provider !== 'claude' && provider !== 'codex') return 'offline';
  let timer: NodeJS.Timeout | undefined;
  try {
    const up = await Promise.race([Promise.resolve().then(() => reachable(provider)).catch(() => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); })]);
    return up === true ? 'transient' : 'offline';
  } finally { if (timer) clearTimeout(timer); }
}

/** Mark at failure time, before the reachability check can start another probe. */
export async function classifyAndMarkOfflineOutcome(marks: Map<string, string>, accountId: string, provider: AccountConfig['provider'], reachable: ProbeOptions['reachable'] = serviceReachable, confirmed?: Map<string, string>): Promise<'offline' | 'transient'> {
  if (!confirmed) {
    confirmed = implicitConfirmedOffline.get(marks);
    if (!confirmed) { confirmed = new Map(); implicitConfirmedOffline.set(marks, confirmed); }
  }
  const prior = marks.get(accountId);
  const at = Math.max(Date.now(), (instantOf(prior) ?? Number.NEGATIVE_INFINITY) + 1);
  const mark = new Date(at).toISOString();
  marks.set(accountId, mark);
  const kind = await classifyOfflineOutcome(provider, reachable);
  if (kind === 'transient') {
    const durable = confirmed.get(accountId);
    if (durable) marks.set(accountId, durable);
    else if (marks.get(accountId) === mark) marks.delete(accountId);
  } else {
    const durable = confirmed.get(accountId);
    if (!durable || at >= (instantOf(durable) ?? Number.NEGATIVE_INFINITY)) confirmed.set(accountId, mark);
    marks.set(accountId, confirmed.get(accountId)!);
  }
  return kind;
}

export function flushLimitHolds(store: Pick<Store, 'saveLimits'>, ledger: AllowanceLedger, pending: Set<string>, log: Log): void {
  for (const id of pending) {
    try { store.saveLimits(id, ledger.limitHolds(id)); pending.delete(id); }
    catch (e) { log(`saveLimits ${id}`, e); }
  }
}

export async function saveLimitHolds(store: Pick<Store, 'saveLimits'>, ledger: AllowanceLedger, pending: Set<string>, journal: string, log: Log, write: JournalWrite = writeSync): Promise<void> {
  for (let tries = 0; tries < 3 && pending.size > 0; tries++) {
    if (tries > 0) await sleep(100 * tries);
    flushLimitHolds(store, ledger, pending, log);
  }
  for (const id of pending) {
    try { appendJournal(journal, { kind: 'limits', accountId: id, holds: ledger.limitHolds(id) }, write); pending.delete(id); }
    catch (e) { log(`journal limits ${id}`, e); }
  }
  if (pending.size) throw new Error(`${pending.size} limit hold(s) could not be persisted to the store or journal`);
}

function replayJournal(store: Store, journal: string, log: Log): void {
  for (const line of (readIfThere(journal) ?? '').split('\n').filter((l) => l.trim())) {
    try {
      const entry = JSON.parse(line) as { kind?: unknown; accountId?: unknown; holds?: unknown; attemptId?: unknown; outcome?: unknown };
      if (entry?.kind === 'limits' && typeof entry.accountId === 'string' && Array.isArray(entry.holds))
        store.saveLimits(entry.accountId, entry.holds as Parameters<Store['saveLimits']>[1]);
      else if (typeof entry?.attemptId === 'string' && entry.outcome && typeof entry.outcome === 'object')
        store.finishAttempt(entry.attemptId, entry.outcome as AttemptOutcome);
      else throw new Error('invalid journal entry');
    } catch (e) {
      log('journal', `an entry cannot be recorded, so startup stops with its journal intact: ${errorText(e)}`);
      throw e;
    }
  }
}

export async function recover(store: Store, journal: string, log: Log): Promise<Map<string, HeldRunner | null>> {
  replayOutcomeFiles(store, journal.slice(0, -'.pipe-journal'.length));
  replayJournal(store, journal, log);
  const held = new Map<string, HeldRunner | null>();
  for (const attempt of store.recoveryAttempts()) {
    if (attempt.geminiUnresolved && !attempt.closedAt) { held.set(attempt.id, null); log('recovery', `attempt ${attempt.id}: AGY supervisor creation remains unresolved; operator recovery required`); continue; }
    if (!attempt.runner && attempt.geminiSupervisor) attempt.runner = attempt.geminiSupervisor;
    if (!attempt.runner) { log('recovery', `attempt ${attempt.id} has no runner identity; reconciling its dispatch proof`); continue; }
    try {
      await retireRunner(attempt.runner);
      if (attempt.geminiSupervisor) await retireRunner(attempt.geminiSupervisor);
      try { store.noteClosed(attempt.id); } catch (error) { log('recovery', error); }
    }
    catch (e) {
      held.set(attempt.id, { ...attempt.runner, supervisor: attempt.geminiSupervisor });
      const reason = `an earlier pipe's runner (process group ${attempt.runner.pid}) may still be alive, so this request is not run again until that group is gone: ${errorText(e)}`;
      log('recovery', `attempt ${attempt.id}: ${reason}`);
      try { store.noteHeld(attempt.id, reason); } catch (error) { log('recovery', error); }
    }
  }
  store.reconcile(RESTARTED, 'interrupted', (id) => !held.has(id));
  rmSync(journal, { force: true });
  return held;
}

export async function recheckHeld(store: Store, held: Map<string, HeldRunner | null>, log: Log, stopped: () => boolean = () => false): Promise<void> {
  for (const [id, runner] of held) {
    if (stopped()) return;
    if (!runner) continue;
    try { await retireRunner(runner);
      if (runner.supervisor) await retireRunner(runner.supervisor);
    } catch { continue; }
    if (stopped()) return;
    try { store.noteClosed(id); } catch (error) { log('recovery', error); }
    store.reconcile(RESTARTED, 'interrupted', (attemptId) => attemptId === id);
    held.delete(id);
    log('recovery', `attempt ${id}: runner group ${runner.pid} is gone, so the attempt is ended`);
  }
}

export function stoppedOutcome(outcome: AttemptOutcome, began: boolean, workspace?: Workspace): AttemptOutcome {
  if (outcome.kind !== 'cancelled' && outcome.kind !== 'no_outcome') return outcome;
  return began ? { kind: 'interrupted', message: 'the pipe stopped this attempt', workspace }
    : { kind: 'unstarted', message: 'the pipe stopped this attempt before its CLI started', workspace };
}

/** A probe can stop a route even while an earlier ledger reading still has room. */
export function probeHealth(report: ProbeReport | undefined, model: string, offlineSince: string | undefined, fingerprint?: string): Health | undefined {
  if (offlineSince) return { ok: false, reason: `offline since ${offlineSince}`, until: null };
  if (report?.identity.state === 'offline') return { ok: false, reason: `offline: ${report.identity.reason}`, until: null };
  if (report?.identity.state === 'unknown') return { ok: false, reason: `login unknown: ${report.identity.reason}`, until: null };
  if (report?.identity.state === 'signed-out') return { ok: false, reason: `signed out: ${report.identity.reason ?? 'not signed in'}`, until: null };
  if (report?.identity.state === 'signed-in' && fingerprint !== undefined && report.identity.identity.fingerprint !== fingerprint)
    return { ok: false, reason: 'signed in as a different login than the one pinned in config', until: null };
  if (report?.allowance.state === 'offline') return { ok: false, reason: `offline: ${report.allowance.reason}`, until: null };
  if (report?.allowance.state === 'unknown' || report?.allowance.state === 'signed-out')
    return { ok: false, reason: `allowance ${report.allowance.state}: ${report.allowance.reason}`, until: null };
  if (report?.version.state === 'ok' && report.version.outdated)
    return { ok: false, reason: `CLI version ${report.version.version} is below ${report.version.minimum}`, until: null };
  if (report?.provider === 'codex' && report.models.state === 'ok' && !report.models.models.includes(model))
    return { ok: false, reason: explainUnknownModel(report.models, model), until: null };
  return undefined;
}

export async function startPipe(input: PipeConfig): Promise<{ url: string; drained: Promise<void>; restartReason(): string | undefined; stop(): Promise<void> }> {
  let config: PipeConfig & { validatedRoots?: ReturnType<typeof validateWorktreeRoots> } = input;
  validateArgonModels(config);
  validateProjects(config.projects);
  validateCapacity(config);
  const startedAt = new Date().toISOString();
  const host = hostAlias(config.hostAlias);
  validateAccounts(config.accounts);
  const policy = parsePolicy(config.policy);
  if (config.gemini) {
    validateGeminiConfig(config.gemini);
    for (const a of config.accounts.filter(a => a.provider === 'gemini'))
      if (realpathSync(a.loginDir) !== realpathSync(join(config.gemini.home, '.gemini')))
        throw new Error('Gemini account loginDir must match gemini.home/.gemini');
  }
  if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(config.token)) throw new Error('a local access token needs at least 32 URL-safe characters');
  const codexCredits = codexCreditsConfig(config.codexCredits);
  const tickMs = config.tickMs ?? 1_000, probeMs = config.probeIntervalMs ?? 300_000, probeRetryMs = config.probeRetryMs ?? 30_000;
  if (!(Number.isInteger(tickMs) && tickMs > 0 && Number.isInteger(probeMs) && probeMs > 0 && Number.isInteger(probeRetryMs) && probeRetryMs > 0)) throw new RangeError('tick and probe intervals must be positive whole milliseconds');
  const pinWaitMs = config.pinWaitMs ?? 300_000;
  if (!Number.isInteger(pinWaitMs) || pinWaitMs < 0) throw new RangeError('pinWaitMs must be nonnegative whole milliseconds');
  const storePath = resolve(config.storePath), storeFolder = dirname(storePath);
  const tmpRoot = resolve(config.tmpRoot ?? join(storeFolder, 'tmp')), workDir = resolve(config.workDir ?? storeFolder);
  const validatedRoots = validateWorktreeRoots(config.worktreeRoot, config.previousWorktreeRoots, { storePath, tmpRoot, workDir: config.workDir, worktreeVolumeMarker: config.worktreeVolumeMarker }, config.env ?? process.env);
  const rootParent = dirname(resolve(config.worktreeRoot));
  try { statSync(rootParent); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`worktreeRoot parent missing: ${rootParent} (volume not mounted?); the Pipe will not start until it exists`);
    throw e;
  }
  const locations = { storePath, tmpRoot, workDir, validatedRoots }; config = { ...config, ...locations };
  const keepHours = config.worktreeKeepHours ?? 72, pruneIntervalMs = config.pruneIntervalMs ?? 3_600_000;
  const minFreeGb = config.minFreeGb ?? 5;
  validateHousekeeping(config.housekeeping);
  const retention = validateRetention(config.housekeeping), retentionHeld = new Set<string>();
  if (!Number.isSafeInteger(config.reviewGitTimeoutMs ?? 120_000) || (config.reviewGitTimeoutMs ?? 120_000) < 1) throw new RangeError('reviewGitTimeoutMs must be positive whole milliseconds');
  if (!Number.isFinite(keepHours) || keepHours < 0) throw new RangeError('worktreeKeepHours must be a finite nonnegative number');
  if (!Number.isInteger(pruneIntervalMs) || pruneIntervalMs <= 0) throw new RangeError('pruneIntervalMs must be positive whole milliseconds');
  if (!Number.isFinite(minFreeGb) || minFreeGb < 0) throw new RangeError('minFreeGb must be a finite nonnegative number');
  const authHoldMs = config.authHoldMs ?? 300_000, authHoldMaxMs = config.authHoldMaxMs ?? 1_800_000;
  if (!Number.isInteger(authHoldMs) || authHoldMs < 1 || !Number.isInteger(authHoldMaxMs) || authHoldMaxMs < authHoldMs || authHoldMaxMs > 366 * 86_400_000)
    throw new RangeError('auth hold durations must be positive whole milliseconds with a cap at least as long as the first hold');
  const log: Log = (where, e) => { process.stderr.write(`pipe ${where}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); };
  if (validatedRoots.ancestor !== validatedRoots.roots[0]) log('WARNING worktreeRoot missing', `${config.worktreeRoot}; only this final folder will be created on demand`);
  const pendingTemps = new TempRetryQueue();
  const cleanTemp = (id: string, groupGone: () => boolean): void => {
    try {
      if (removeAttemptTemp(tmpRoot, id, undefined, groupGone)) pendingTemps.removed(id); else pendingTemps.notYet(id);
    } catch (e) {
      const { firstFailure, parked } = pendingTemps.failed(id);
      try {
        if (firstFailure) log('remove attempt temp folder', e);
        if (parked) log('temp folder removal parked', e);
      } catch { /* Cleanup cannot fail the request. */ }
    }
  };
  const release = claimRecord(storePath);
  const journal = journalOf(storePath);
  let store!: Store;
  let held!: Map<string, HeldRunner | null>;
  try {
    store = new Store(storePath, { leaseTickMs: tickMs, evidenceMaxAgeMs: Math.max(probeMs * 2, 60_000),
      maxAttempts: config.maxAttempts, retryBackoffMs: config.retryBackoffMs, maxLimits: config.maxLimits, authHoldMs, authHoldMaxMs });
    if (3 * tickMs > 60_000) log('lease TTL warning', 3 * tickMs > 3_600_000 ? 'leases are unusable: 3 ticks exceed the maximum TTL of 3600000 ms' :
      `TTLs below ${3 * tickMs} ms (3 ticks) will be refused`);
    held = await recover(store, journal, log);
    await recoverGemini(store, log);
    if (config.gemini) {
      const resolved = resolveCli({ claude: config.gemini.cli }, config.env ?? process.env).claude;
      if (!resolved) log('Gemini', new Error('Gemini AGY CLI is not executable'));
      else configureGemini(store, { ...config.gemini, cli: resolved }, storePath, config.env ?? process.env);
    }
    cleanEndedTemps(tmpRoot, store, log, keepHours, pendingTemps);
  }
  catch (e) { store?.close(); release(); throw e; }
  const identities = new IdentityLedger();
  const allowances = new AllowanceLedger({ freshnessMs: Math.max(probeMs * 2, 60_000) });
  const reports = new Map<string, ProbeReport>();
  const probeStats = new Map<string, { lastAt: string; failures: number }>();
  const probeFailures = new Map<string, string>();
  const offlineSince = new Map<string, string>();
  const confirmedOffline = new Map<string, string>();
  const jobs = new Map<string, { abort: AbortController; saveAbort: AbortController; done: Promise<void>; guard?: () => void }>();
  const pending = new Map<string, AttemptOutcome>();
  const journaledOutcomes = new Set<string>();
  const pendingHolds = new Set<string>();
  let completionMarker = false;
  const accounts = new Map(config.accounts.map((a) => [a.id, a]));
  const cli = resolveCli(config.cli, config.env ?? process.env);
  const opts: ProbeOptions = { cli, env: config.env, reachable: config.reachable, minVersion: config.minVersion, codexCredits };
  let stopped = false, draining = false, drainComplete = false, ticking = false, rechecking = false, clockBehind = false;
  let diskLow = false, diskReadFailed = false, restart: string | undefined;
  let prunePass: Promise<PruneReport> | null = null;
  let pruning: Promise<PruneReport> | null = null, pruneAbort: AbortController | null = null;
  let lastPrune: PruneReport | undefined;
  const pressureTrigger = new HousekeepingTrigger();
  const housekeeping = () => housekeepingStatus(store, config.worktreeRoot, keepHours, config.housekeeping, config.diskStatfs, lastPrune);
  const emptyPrune = (): PruneReport => ({ removed: [], kept: [], failed: [] });
  const prune = (): Promise<PruneReport> => {
    if (prunePass) return prunePass;
    const previous = pruning;
    const task = (async () => {
      if (previous) await previous;
      if (stopped || draining) return emptyPrune();
      const abort = new AbortController();
      pruneAbort = abort; pressureTrigger.observe(housekeeping().tier, Date.now(), config.housekeeping?.tiers); pressureTrigger.started(Date.now());
      try { if (store.clockIsCurrent()) store.pruneLeases(); } catch (e) { log('lease prune', e); }
      // The outcome journal, a failed-stop marker or an outcome file (exactly as recovery replays them) names attempts a restart needs.
      try {
        const replay = [journal, failureOf(storePath)].some(f => existsSync(f)) || readdirSync(storeFolder).some(n => n.startsWith(`${basename(storePath)}.pipe-outcome-`) && /^[a-f0-9]{64}$/.test(n.slice(basename(storePath).length + 14)));
        const held = replay ? 'outcomes wait for a restart to replay them' : store.pruneEndedRecords(retention.keepRecordsDays, tmpRoot).unreadable ? 'a review, its seats, a saved start or an open request is unreadable' : '';
        if (!held) retentionHeld.clear(); else if (!retentionHeld.has(held)) { retentionHeld.add(held); log('record prune', `ended records are kept while ${held}`); }
      } catch (e) { log('record prune', e); }
      try { capLog(retention.logMaxBytes); } catch (e) { log('log trim', e); }
      try { return lastPrune = pressureTrigger.finished(await pruneWorktrees(store, config.worktreeRoot, keepHours, log, () => !stopped && !draining,
        workDir, config.env ?? process.env, abort.signal, { ...config.housekeeping, ...locations, previousWorktreeRoots: config.previousWorktreeRoots, statfs: config.diskStatfs, minFreeGb: config.minFreeGb,
          waiting: () => store.waitingRequests().some(r => {
            const now = new Date();
            return plan([r], config.accounts.map((account): AccountStatus => ({ account, running: store.runningCount(account.id), leased: store.activeLeaseCount(account.id, now),
              evidence: model => ({ accountId: account.id, model, observedAt: now.toISOString(), allowanceObservedAt: allowances.observedAt(account.id, model), ordinaryExhaustion: allowances.ordinaryExhaustion(account.id, model), verdict: verdict(account, model, now) }),
              limitHold: model => { const v = allowances.view(account.id, model); return v.state === 'exhausted' ? { accountId: v.accountId, until: v.until } : null; } })),
              { now, pinWaitMs, evidenceMaxAgeMs: Math.max(probeMs * 2, 60_000), load: store.requesterLoad() }).dispatch.length > 0;
          }) })); }
      finally { if (pruneAbort === abort) pruneAbort = null; }
    })();
    pruning = task; prunePass = task;
    void task.finally(() => { if (pruning === task) pruning = null; if (prunePass === task) prunePass = null; }).catch(() => {});
    return task;
  };
  /** A completed job's save waits its turn on prune's chain: a prune and a save never share a worktree (L64). */
  const afterPrunes = (fn: () => Promise<void>): Promise<void> => {
    const previous = pruning, task = (async () => { if (previous) await previous.catch(() => {}); await fn(); return emptyPrune(); })();
    pruning = task; void task.finally(() => { if (pruning === task) pruning = null; }).catch(() => {});
    return task.then(() => {}, () => {});
  };
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
  const checkDrained = (): void => {
    if (stopped || !draining) return;
    try { if (jobs.size === 0 && runningGemini(store) === 0 && store.openAttempts().length === 0) { drainComplete = true; resolveDrained(); } }
    catch (e) { if (!stopped) log('drain', e); }
  };
  const probeTimers = new Map<string, NodeJS.Timeout>();
  const drain = (): Promise<void> => { draining = true; drainGemini(store); pruneAbort?.abort(); for (const timer of probeTimers.values()) clearTimeout(timer); probeTimers.clear(); for (const timer of resetProbes) clearTimeout(timer); resetProbes.clear(); checkDrained(); return pruning ? Promise.all([drained, pruning]).then(() => {}) : drained; };
  /** Earliest probe still in flight, for pinned requests awaiting a reading. */
  let probingSince: number | null = null;
  const probing = new Map<string, { done: Promise<void>; since: number }>();
  const probeAgain = new Set<string>();
  const retryDelay = new Map<string, number>();
  const resetProbes = new Set<NodeJS.Timeout>();
  const flushHolds = (): void => flushLimitHolds(store, allowances, pendingHolds, log);
  const flushPending = (): void => {
    if (pendingHolds.size === 0) {
      for (const [id, outcome] of pending) {
        try {
          store.finishAttempt(id, outcome);
          pending.delete(id);
          journaledOutcomes.delete(id);
          rmSync(outcomeFile(storePath, id), { force: true });
        } catch (e) { log(`finishAttempt ${id}`, e); }
      }
    }
    if (completionMarker && [...pending.keys()].every((id) => journaledOutcomes.has(id))) { rmSync(failureOf(storePath), { force: true }); completionMarker = false; }
  };
  /** The store mirrors the ledger's job limits, so a restart restores exactly the holds that stand. */
  const saveHolds = (accountId: string): void => {
    pendingHolds.add(accountId);
    flushHolds();
  };

  const scheduleProbe = (account: AccountConfig, retry: boolean): void => {
    const delay = retry ? retryDelay.get(account.id) ?? Math.min(probeRetryMs, probeMs) : probeMs;
    retryDelay.set(account.id, retry ? Math.min(delay * 2, probeMs) : Math.min(probeRetryMs, probeMs));
    const old = probeTimers.get(account.id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => { probeTimers.delete(account.id); void probeOne(account).catch((e) => log('probe', e)); }, delay);
    timer.unref();
    probeTimers.set(account.id, timer);
  };
  /** READ-CONTRACT-01's probe counters move only while the service runs, undrained, at a clock its record accepts. */
  const noteProbe = (accountId: string, proved: boolean): void => {
    const now = new Date();
    try { if (stopped || draining || !store.clockIsCurrent(now)) return; } catch { return; }
    probeStats.set(accountId, { lastAt: now.toISOString(), failures: proved ? 0 : (probeStats.get(accountId)?.failures ?? 0) + 1 });
  };
  /** Each account schedules its next probe only after this one ends, so probes cannot overlap. */
  const probeOne = async (account: AccountConfig, again = false): Promise<void> => {
    if (stopped || draining || account.provider === 'gemini') return;
    if ((account.provider === 'claude' || account.provider === 'codex') && !cli[account.provider]) return;
    if (!store.clockIsCurrent()) { scheduleProbe(account, true); return; }
    const active = probing.get(account.id);
    if (active) { if (again) probeAgain.add(account.id); return active.done; }
    const oldTimer = probeTimers.get(account.id);
    if (oldTimer) clearTimeout(oldTimer);
    probeTimers.delete(account.id);
    const since = Math.max(Date.now(), (instantOf(offlineSince.get(account.id)) ?? Number.NEGATIVE_INFINITY) + 1);
    probingSince = probingSince === null ? since : Math.min(probingSince, since);
    const done = (async () => {
      let retry = true;
      try {
        const report = await probeAccount(account, opts);
        if (stopped || draining) return;
        if (!store.clockIsCurrent()) return;
        applyProbe(report, { identities, allowances });
        reports.set(account.id, report);
        probeFailures.delete(account.id);
        const observedOffline = report.identity.state === 'offline' || report.allowance.state === 'offline';
        advanceOfflineMark(offlineSince, account.id, observedOffline,
          observedOffline ? Math.max(Date.now(), (instantOf(offlineSince.get(account.id)) ?? Number.NEGATIVE_INFINITY) + 1) : since);
        if (observedOffline) confirmedOffline.set(account.id, offlineSince.get(account.id)!);
        else if (!offlineSince.has(account.id)) confirmedOffline.delete(account.id);
        saveHolds(account.id);
        retry = report.identity.state === 'unknown' || report.identity.state === 'offline'
          || report.allowance.state === 'unknown' || report.allowance.state === 'offline';
        noteProbe(account.id, report.identity.state !== 'unknown' && report.identity.state !== 'offline');   // last: counted once
      } catch (e) {
        if (!stopped && !draining) probeFailures.set(account.id, errorText(e));
        noteProbe(account.id, false);
        log(`probe ${account.id}`, e);
      }
      finally {
        probing.delete(account.id);
        probingSince = probing.size ? Math.min(...[...probing.values()].map((p) => p.since)) : null;
        if (stopped || draining) return;
        if (probeAgain.delete(account.id)) { void probeOne(account).catch((e) => log('probe', e)); return; }
        scheduleProbe(account, retry);
      }
    })();
    probing.set(account.id, { done, since });
    return done;
  };
  const probeAll = (again = false): Promise<void> => Promise.all(config.accounts.map((account) => probeOne(account, again))).then(() => {});
  /** Reprobe after a stated limit reset; missing readings remain unknown. */
  const probeAfterReset = (accountId: string, resetsAt: string | null): void => {
    const delay = (instantOf(resetsAt) ?? Number.NaN) - Date.now() + 50;
    if (!(delay > 0 && delay <= 2 ** 31 - 1) || stopped || draining) return;   // none stated, lapsed, or beyond a timer: the regular probe reads it
    const timer = setTimeout(() => {
      resetProbes.delete(timer);
      const account = accounts.get(accountId);
      if (account) void probeOne(account, true).catch((e) => log('probe', e));
    }, delay);
    timer.unref();
    resetProbes.add(timer);
  };

  const verdict = (account: AccountConfig, model: string, now: Date, ignoreRunning = false) => {
    if (!store.clockIsCurrent()) return { state: 'unavailable' as const, reason: 'pipe clock is behind its recorded high-water mark', until: null };
    let heldUntil: number;
    try { heldUntil = store.authHoldUntil(account.id); }
    catch { return { state: 'unknown' as const, reason: 'account hold is unreadable' }; }
    if (heldUntil > now.getTime()) return { state: 'unavailable' as const, reason: 'auth sign-in hold after repeated failures', until: new Date(heldUntil).toISOString() };
    if (account.enabled && (account.provider === 'claude' || account.provider === 'codex') && !cli[account.provider])
      return { state: 'unavailable' as const, reason: `${account.provider} CLI could not be resolved from the configured path or PATH`, until: null };
    const failure = probeFailures.get(account.id);
    if (failure) return { state: 'unavailable' as const, reason: `probe unknown: ${failure}`, until: null };
    const report = reports.get(account.id);
    const health = probeHealth(report, model, offlineSince.get(account.id), account.fingerprint);
    if (account.enabled && health && !health.ok)
      return { state: 'unavailable' as const, reason: health.reason, until: health.until };
    return availability({ account, identities, allowances, model, running: ignoreRunning ? 0 : store.runningCount(account.id), leased: ignoreRunning ? 0 : store.activeLeaseCount(account.id, now), health, now, identityMaxAgeMs: Math.max(probeMs * 2, 60_000) });
  };

  const cancelledByRequester = (requestId: string): boolean => { try { return store.get(requestId)?.state === 'cancelled'; } catch { return false; } };

  const execute = (requestId: string, account: AccountConfig, attemptId: string, route?: Route, automatic?: NewRequest['automatic'], heldAttempts: Map<string, HeldRunner | null> = new Map()): void => {
    // Keep these copies local: u25 R2 evaluates execute with a fixed outer scope.
    const abort = new AbortController(), saveAbort = new AbortController(), storePath = config.storePath, locations = { storePath, tmpRoot, workDir, validatedRoots: config.validatedRoots };
    /** Whether the CLI may have begun: a stop before then requeues the request without blame. */
    let reserveStop = false, guardDone = false;
    const guard = automatic && account.provider === 'claude' ? () => {
      if (guardDone || reserveStop) return;
      const v = verdict(account, route!.model, new Date(), true);
      if (!allowances.observedAt(account.id, route!.model) || v.state !== 'available' || v.via !== undefined || v.headroom <= automatic.reviewReserve) { store.noteReserveStop(attemptId); reserveStop = true; abort.abort(); }
    } : undefined;
    let began = false, mayHaveSpawned = false, runner: RunnerIdentity | null = null, startCommit: string | undefined;
    let eventsLogged = false;
    const clock = eventClock((count) => { try { store.noteEvents(attemptId, count); } catch (e) { if (!eventsLogged) log(`events ${attemptId}`, e); eventsLogged = true; throw e; } },
      undefined, config.eventWriteMs ?? 15_000);
    const closed = (): void => { try { store.noteClosed(attemptId); } catch (e) { log(`closed ${attemptId}`, e); } };
    const options: RunOptions = { cli, env: config.env, worktreeRoot: config.worktreeRoot, signal: abort.signal,
      onSpawn: (identity) => { runner = identity; began = true; store.noteRunner(attemptId, identity); },
      onBeforeSpawn: () => { mayHaveSpawned = true; began = true; store.noteMayStart(attemptId); },
      savedStartSource: (id) => store.savedStartSource(id),
      onWorkspace: (w, origin) => { startCommit = origin; store.noteWorkspace(attemptId, { ...w, commit: 'uncommitted', startCommit }); },
      onEvent: () => clock.event(),
      onClosed: closed,
      reachable: config.reachable as RunOptions['reachable'] };
    const done = (async () => {
      await Promise.resolve();
      let outcome: AttemptOutcome | null = null;
      let limitRecorded = false, mismatch: string | null = null;
      const workspace = (w: { path: string; branch: string } | null) => w ? { ...w, commit: 'uncommitted', ...(startCommit ? { startCommit } : {}) } : undefined;
      let work: ReturnType<typeof workspace>;
      try {
        const stored = store.get(requestId);
        const request = stored && { ...stored, ...route };
        if (!request) throw new Error('the claimed request could not be read');
        if (account.provider === 'gemini' && !geminiReadOnly(request)) throw new Error('Gemini code jobs are not enabled');
        guard?.();
        let tmpDir: string | null = null;
        try { tmpDir = attemptTemp(tmpRoot, attemptId); }
        catch (e) {
          outcome = { kind: 'failed', errorKind: setupKind(errorText(e)),
            message: `could not make temp folder ${join(tmpRoot, attemptId)}: ${errorText(e)}`, untouched: true };
        }
        if (tmpDir === null) closed();   // the runner was never called: no process was made
        const chat = async function* (): AsyncGenerator<RunEvent> {
          const c = geminiConfig(store);
          if (!c) { yield { type: 'failed', errorKind: 'other', message: 'Gemini is not configured', workspace: null }; return; }
          const prompt = geminiChatPrompt(request.prompt);
          let result;
          try { result = await runGemini({ ...c, protectedPaths: [...(c.protectedPaths ?? []), workDir, statSync(config.worktreeRoot, { throwIfNoEntry: false }) ? config.worktreeRoot : dirname(resolve(config.worktreeRoot)), dirname(resolve(config.storePath))] },
            join(tmpDir!, 'gemini'), request.model, prompt.text, prompt.token, config.env ?? process.env, abort.signal,
            (pid, birth) => { if (!pid || !birth) throw new Error('AGY runner proof is missing');
              began = true; runner = { pid, startedAt: birth }; store.noteRunner(attemptId, runner); },
            owner => { if (!owner.birth) throw new Error('AGY supervisor proof is missing');
              mayHaveSpawned = true; store.noteGeminiSupervisor(attemptId, { pid: owner.pid, startedAt: owner.birth }); },
            () => store.clockIsCurrent(), 'chat', () => { store.noteMayStart(attemptId, true); mayHaveSpawned = true; }); }
          catch { if (mayHaveSpawned) { heldAttempts.set(attemptId, null); throw new Error('AGY closure is unknown'); }
            closed(); yield { type: 'failed', errorKind: 'other', message: 'AGY setup failed', workspace: null }; return; }
          if (result.held) {
            heldAttempts.set(attemptId, null);
            const a = store.attempts(requestId).find(a => a.id === attemptId)!;
            heldAttempts.set(attemptId, a.geminiUnresolved ? null : a.runner ? { ...a.runner, supervisor: a.geminiSupervisor } : a.geminiSupervisor ?? null);
            store.noteHeld(attemptId, 'AGY group remains unproved; operator recovery required');
            throw new Error('AGY group remains unproved');
          }
          mayHaveSpawned = false; closed(); clock.event();
          yield { type: 'started', reportedModel: result.reportedModel, sessionId: null };
          if (result.status === 'voted') yield { type: 'completed', result: result.response ?? '', workspace: null };
          else yield { type: 'failed', errorKind: result.errorKind === 'interrupted' ? 'cancelled' : result.errorKind === 'quota' ? 'quota_exhausted' : result.errorKind === 'auth' ? 'auth' : 'other',
            message: result.reason ?? 'AGY failed', workspace: null };
        };
        if (tmpDir !== null) for await (const event of (account.provider === 'gemini' ? chat() : run({ requestId, accountId: account.id, provider: account.provider as 'claude' | 'codex', model: request.model, effort: request.effort,
          prompt: request.prompt, mutating: request.mutating, cwd: request.cwd ?? workDir, loginDir: account.loginDir,
          expectedStartCommit: request.expectedStartCommit, startSource: request.startSource,
          pinnedStartCommit: request.pinnedStartCommit, requireCleanStart: request.requireCleanStart,
          tmpDir, ...(request.workspace ? { workspaceKey: attemptId } : {}) }, options))) {
          if (event.type === 'started') {
            store.noteModel(attemptId, event.reportedModel);
            if (event.reportedModel !== null && !(account.provider === 'gemini' && event.reportedModel === 'unknown') && (account.provider === 'claude' && !request.model.startsWith('claude-')
              ? modelFamily(event.reportedModel) !== request.model : event.reportedModel !== request.model)) {
              mismatch = account.provider === 'gemini' ? 'model_mismatch' : `model_mismatch: chose ${request.model}, but ${account.provider} reported ${event.reportedModel}`;
              abort.abort();
            }
          }
          if (event.type === 'limit' && event.accountId === account.id) {
            allowances.recordLimit(account.id, { bucket: event.bucket, model: event.model, resetsAt: event.resetsAt, observedAt: event.observedAt });
            saveHolds(account.id);
            limitRecorded = true;
            probeAfterReset(account.id, event.resetsAt);
          }
          if (event.type === 'completed' || event.type === 'failed') work = workspace(event.workspace);
          if (event.type === 'failed' && (event.errorKind === 'quota_exhausted' || event.errorKind === 'rate_limited') && !limitRecorded) {
            allowances.recordLimit(account.id, { bucket: null, model: null, resetsAt: null, observedAt: new Date().toISOString() });
            saveHolds(account.id);
            limitRecorded = true;
          }
          const failureKind = event.type === 'failed' && event.errorKind === 'offline'
            ? await classifyAndMarkOfflineOutcome(offlineSince, account.id, account.provider, config.reachable, confirmedOffline) : event.type === 'failed' ? event.errorKind : null;
          if ((failureKind === 'offline' || (failureKind === 'transient' && offlineSince.has(account.id))) && !stopped) {
            void probeOne(account, true).catch((e) => log('probe', e));
          }
          if (event.type === 'completed') outcome = { kind: 'completed', result: event.result, workspace: work };
          if (event.type === 'failed') outcome = failureKind === 'cancelled' ? { kind: 'cancelled', message: event.message, ...(work ? { workspace: work } : {}) }
            : { kind: 'failed', errorKind: failureKind!, message: event.message, limitRecorded: limitRecorded && (failureKind === 'quota_exhausted' || failureKind === 'rate_limited'), workspace: workspace(event.workspace), ...(event.untouched ? { untouched: true } : {}) };
        }
        clock.end();
        outcome ??= { kind: 'no_outcome', message: 'the runner ended without an outcome' };
      } catch (e) { clock.end(); outcome = { kind: began ? 'no_outcome' : 'unstarted', message: `the runner threw: ${e instanceof Error ? e.message : String(e)}` }; }
      if (heldAttempts.has(attemptId)) { jobs.delete(requestId); return; }
      guardDone = true;
      if (account.provider === 'gemini' && outcome?.kind === 'failed' && outcome.message === 'model_mismatch') outcome.errorKind = 'model_mismatch';
      if (mismatch && !(account.provider === 'gemini' && outcome?.kind === 'failed' && outcome.errorKind === 'quota_exhausted')) outcome = { kind: 'failed', errorKind: account.provider === 'gemini' ? 'model_mismatch' : 'other', message: mismatch, workspace: work };
      else if (reserveStop && !(outcome?.kind === 'failed' && outcome.errorKind === 'start_mismatch') && !cancelledByRequester(requestId) && outcome?.kind !== 'completed') outcome = { kind: 'failed', errorKind: 'other', message: 'automatic Claude stopped: review reserve reached or evidence unknown; work retained, no automatic retry', workspace: work ?? store.get(requestId)?.workspace ?? undefined };
      else if (stopped && abort.signal.aborted && !cancelledByRequester(requestId)) outcome = stoppedOutcome(outcome!, began, work);
      pending.set(attemptId, outcome!);   // set on every path above; the type loses that across the try
      try { await persistCompletedOutcome(store, pending, journal, log, { journaled: journaledOutcomes, recoveryPath: storePath, journalWrite: config.journalWrite,
        pendingHolds, accountId: account.id, heldAttemptId: attemptId }); }
      catch (e) {
        log(`persist completion ${attemptId}`, e);
        try { markFailedStop(storePath, [...pending.keys()], journaledOutcomes); completionMarker = true; }
        catch (markError) { log(`mark completion ${attemptId}`, markError); }
      }
      const groupGone = () => runner ? runnerGroupGone(runner.pid) : !mayHaveSpawned;
      if (outcome!.kind === 'completed' && outcome!.workspace && config.saveOnCompletion !== false && !stopped) await afterPrunes(async () => {
        let saving = false;
        try {
          const r = store.get(requestId), s = r?.state === 'completed' && r.workspace && !stopped && groupGone() ? await (saving = true, saveWorktree(r, config.worktreeRoot, workDir, config.env ?? process.env, saveAbort.signal, () => !stopped, config.housekeeping?.saveTimeoutMs, { ...locations, log, previousWorktreeRoots: config.previousWorktreeRoots, statfs: config.diskStatfs, minFreeGb: config.minFreeGb, regenerable: config.housekeeping?.regenerable })) : null;
          saving = false;
          if (s && 'commit' in s) { try {
            if (!store.recordWorkspaceCommit(requestId, s.commit, s.saved, s.diff) || !store.noteWorkspaceHousekeeping(requestId, { excludedPaths: s.excludedPaths, saveRetryAt: '', saveFailures: 0, saveDelays: 0 })) log(`save ${requestId}`, 'the saved commit could not be recorded');
          } finally { await s.release(); } }
          else { log(`save ${requestId}`, s ? s.keep : 'deferred to prune: the runner group may still be running'); if (s) store.noteWorkspaceNotSaved(requestId); }
        } catch (e) {
          log(`save ${requestId}`, e);
          try { store.noteWorkspaceNotSaved(requestId); if (saving && !saveAbort.signal.aborted && !stopped) noteSaveFailure(store, requestId, e); } catch { /* the card then shows the save as pending */ }
        }
      });
      pendingTemps.add(attemptId, groupGone); cleanTemp(attemptId, groupGone);
      jobs.delete(requestId);
      checkDrained();
    })();
    jobs.set(requestId, { abort, saveAbort, done, guard });
    void done.catch((e) => { log(`run ${requestId}`, e); jobs.delete(requestId); checkDrained(); });
  };

  const validating = new Map<string, Promise<void>>(), validationAbort = new AbortController();
  /** No attempt or scratch for an already-invalid selector. A later race is closed by the runner. */
  const withSavedStart = (id: string, claim: () => void): void | Promise<void> => {
    const request = store.get(id);
    if (!request || request.state !== 'queued') return;
    if (request.expectedStartCommit === undefined) { claim(); return; }
    if (stopped || draining || pendingHolds.size || diskLow || clockBehind || !store.clockIsCurrent() || validating.has(id)) return validating.get(id);
    const done = (async () => {
      try { await validateSavedStart(request, source => store.savedStartSource(source), config.env ?? process.env, validationAbort.signal); }
      catch { if (!stopped) store.fail(id, 'expectedStartCommit saved source is unavailable or changed'); return; }
      if (!stopped && !draining && !pendingHolds.size && !diskLow && !clockBehind && store.clockIsCurrent() && store.get(id)?.state === 'queued') claim();
    })().catch(e => log('saved source validation', e)).finally(() => validating.delete(id));
    validating.set(id, done);
    return done;
  };

  const admitAutomatic = (id: string): void | Promise<void> => withSavedStart(id, () => {
    const now = new Date();
    const unavailable = stopped || draining || pendingHolds.size > 0 || clockBehind || diskLow;
    const statuses: AccountStatus[] = config.accounts.map(account => ({ account, running: store.runningCount(account.id), evidence: model => ({ accountId: account.id, host, model, observedAt: now.toISOString(), allowanceObservedAt: allowances.observedAt(account.id, model), allowanceSource: allowances.readingSource(account.id), ordinaryExhaustion: allowances.ordinaryExhaustion(account.id, model),
      verdict: unavailable ? { state: 'unknown', reason: 'service admission paused' } : verdict(account, model, new Date(), true) }) }));
    const r = store.get(id)!;
    const started = store.startAutomatic(id, statuses, policy, r.mutating ? WRITE : READ);
    if (started.ok) execute(id, accounts.get(started.attempt.accountId)!, started.attempt.id, started.attempt.dispatch.route, r.automatic);
  });

  /** Reuse the same planner and wait/refusal handling before and after asynchronous source proof. */
  const planOrdinary = (waiting: RequestRecord[]) => {
    const now = new Date();
    const statuses: AccountStatus[] = config.accounts.map((account) => ({ account, running: store.runningCount(account.id), leased: store.activeLeaseCount(account.id, now),
      evidence: (model) => ({ accountId: account.id, model, observedAt: now.toISOString(), verdict: verdict(account, model, now) }),
      limitHold: (model) => { const v = allowances.view(account.id, model); return v.state === 'exhausted' ? { accountId: v.accountId, until: v.until } : null; } }));
    const decision = plan(waiting, statuses, { now, pinWaitMs, evidenceMaxAgeMs: Math.max(probeMs * 2, 60_000), load: store.requesterLoad() });
    for (const wait of decision.waits) store.setWaiting(wait.requestId, wait);
    for (const failure of decision.fail) {
      const r = store.get(failure.requestId);
      const since = instantOf(r?.waiting?.stoppedSince);
      if (r?.pin !== undefined && since !== null && probingSince !== null && probingSince <= since + pinWaitMs) continue;
      store.fail(failure.requestId, failure.reason);
    }
    return decision.dispatch;
  };

  const tick = (): void => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const lost = rootLost(config.worktreeRoot);
      if (lost && !restart) {
        restart = lost; log(`WARNING worktreeRoot volume lost (${lost}); draining, then exiting for a restart`, '');
        void drain().catch(e => log('volume drain', e));
      }
      try { if (store.clockIsCurrent()) store.sweepExpiredLeases(); } catch (e) { log('lease sweep', e); }
      for (const [id, job] of jobs) { try { job.guard?.(); } catch (e) { log(`reserve guard ${id}`, e); } }
      for (const r of store.waitingRequests()) if (r.provider !== 'gemini' && r.automatic && r.expectedStartCommit === undefined) admitAutomatic(r.id);
      for (const { id, groupGone } of pendingTemps.due().slice(0, 16)) cleanTemp(id, groupGone);
      flushHolds();
      flushPending();
      refreshReviews(store, log, config.env ?? process.env, { reviewGitTimeoutMs: config.reviewGitTimeoutMs, E6_CAPACITY_HOOK: config.E6_CAPACITY_HOOK || draining || stopped });
      if (!draining) {
        for (const account of config.accounts) {
          if (!probeTimers.has(account.id) && !probing.has(account.id) && (account.provider === 'claude' || account.provider === 'codex') && cli[account.provider]) void probeOne(account).catch((e) => log('probe', e));
        }
      }
      if (pendingHolds.size > 0) return;
      if (!stopped && held.size > 0 && !rechecking) {
        rechecking = true;
        void recheckHeld(store, held, log, () => stopped).catch((e) => { if (!stopped) log('recovery', e); }).finally(() => { rechecking = false; if (!stopped) checkDrained(); });
      }
      if (draining) { checkDrained(); return; }
      if (!store.clockIsCurrent()) { clockBehind = true; return; }
      if (clockBehind) { clockBehind = false; void probeAll(true).catch((e) => log('probe', e)); return; }
      let diskReason: string | null = null;
      try {
        diskReason = diskWait([config.worktreeRoot, tmpRoot, storeFolder], minFreeGb, config.diskFree ?? statfsFree);
        diskReadFailed = false;
      } catch (e) { if (!diskReadFailed) log('disk reading', e); diskReadFailed = true; }
      if (diskReason) {
        if (!diskLow) log('disk guard engaged', diskReason);
        diskLow = true;
        for (const request of store.waitingRequests()) store.setWaiting(request.id, { reason: diskReason, until: null, kind: 'paused' });
        return;
      }
      if (diskLow) log('disk guard cleared', 'free space is above the floor or its reading is unavailable');
      diskLow = false;
      for (const r of store.waitingRequests()) if (r.provider !== 'gemini' && r.automatic && r.expectedStartCommit !== undefined) admitAutomatic(r.id);
      inTurns(store.waitingRequests().filter(r => r.provider === 'gemini'), store.requesterLoad(), Date.now(), r => {
        const refusal = geminiChatRefusal(r, config.accounts);
        if (refusal || !hasGemini(store)) { store.fail(r.id, refusal ?? 'Gemini is not configured'); return false; }
        if (runningGemini(store) || store.openAttempts().some(a => store.get(a.requestId)?.provider === 'gemini')) {
          store.setWaiting(r.id, { reason: 'AGY turn is busy or unavailable', until: null, kind: 'no_free_account' }); return false;
        }
        let reason = 'no configured Gemini account';
        for (const a of config.accounts.filter(a => a.provider === 'gemini')) {
          const claim = store.startGeminiChatAttempt(r.id, a, host);
          if (claim.ok) { execute(r.id, a, claim.attempt.id, undefined, undefined, held); return true; }
          reason = claim.reason;
        }
        store.setWaiting(r.id, { reason, until: null, kind: 'no_free_account' }); return false;
      });
      for (const dispatch of planOrdinary(store.waitingRequests().filter(r => !r.automatic && r.provider !== 'gemini'))) void withSavedStart(dispatch.requestId, () => {
        const request = store.get(dispatch.requestId)!;
        const current = request.expectedStartCommit === undefined ? dispatch : planOrdinary([request])[0];
        if (!current) return;
        const account = accounts.get(current.accountId)!;
        const evaluatedAt = new Date();
        const evidence: DispatchEvidence = { accountId: account.id, host, model: request.model, observedAt: evaluatedAt.toISOString(), verdict: verdict(account, request.model, evaluatedAt), grant: request.mutating ? WRITE : READ };
        const started = store.startAttempt(request.id, account, evidence);
        if (started.ok) execute(request.id, account, started.attempt.id);
        else store.setWaiting(request.id, { reason: started.reason, until: null, kind: 'no_free_account' });
      });
    } catch (e) { log('tick', e); }
    finally { ticking = false; }
  };

  try {
    for (const { accountId, hit } of store.limits()) {
      try { allowances.recordLimit(accountId, hit); probeAfterReset(accountId, hit.resetsAt); }
      catch (e) { log(`saved limit on ${accountId}`, e); }
    }
    await probeAll();
    const { server, url } = await startHttp({ token: config.token, policy, store, env: config.env, admitAutomatic, log, projects: config.projects,
      geminiChatConfigured: () => config.accounts.some(a => a.provider === 'gemini' && a.enabled),
      currentAllowance: (id, model) => { const account = accounts.get(id); if (!account) return null; const now = new Date(), v = verdict(account, model, now, true), observedAt = allowances.observedAt(id, model);
        return observedAt && v.state === 'available' && v.via === undefined ? { accountId: id, model, provenance: 'current_observation', source: allowances.readingSource(id), headroom: v.headroom, basis: 'ordinary', observedAt, evaluatedAt: now.toISOString() } : null; },
      accountIds: () => config.accounts.map((account) => account.id), draining: () => draining, drain, drainComplete: () => drainComplete, extraRunning: () => runningGemini(store),
      leaseAccount: (id) => { const account = accounts.get(id); if (!account) return undefined;
        const v = store.clockIsCurrent() ? allowances.view(id) : null;
        return { account, headroom: v?.state === 'ok' ? v.headroom : null }; },
      accounts: () => config.accounts.map((account) => ({ id: account.id, provider: account.provider, enabled: account.enabled,
        leases: store.clockIsCurrent() ? store.activeLeases(account.id).map(l => ({ id: l.id, holder: l.holder, purpose: l.purpose, since: l.createdAt, expiresAt: l.expiresAt, headroomAtStart: l.headroomAtStart })) : null,
        running: store.runningCount(account.id), identity: store.clockIsCurrent() ? identities.view(account.id) ?? null : null,
        allowance: store.clockIsCurrent() ? allowances.view(account.id) : { state: 'unknown', accountId: account.id, reason: 'pipe clock is behind its recorded high-water mark' },
        version: store.clockIsCurrent() ? reports.get(account.id)?.version ?? null : null,
        availability: Object.fromEntries(Object.keys(policy[account.provider]?.models ?? {}).map((model) => [model, verdict(account, model, new Date())])) })),
      models: () => ({ policy, official: Object.fromEntries(config.accounts.map((account) => [account.id, store.clockIsCurrent()
        ? reports.get(account.id)?.models ?? { state: 'unknown', reason: 'not probed' }
        : { state: 'unknown', reason: 'pipe clock is behind its recorded high-water mark' }])) }),
      worktrees: async () => ({ ...await listWorktrees(store, housekeeping().keepHours, workDir), housekeeping: housekeeping() }), prune,
      resetWorktree: async id => { let reset = false; let error: unknown; await afterPrunes(async () => { try { reset = store.resetWorkspaceHousekeeping(id); } catch (e) { error = e; } }); if (error) throw error; return reset; },
      reviews: {
        submit: (input) => submitReview(store, policy, config.worktreeRoot, input, config.env ?? process.env,
          { reviewGitTimeoutMs: config.reviewGitTimeoutMs, projects: config.projects, E6_CAPACITY_HOOK: config.E6_CAPACITY_HOOK, landing_rank_bound: config.landing_rank_bound, canAdmit: () => {
            if (draining || stopped) throw Object.assign(new AdmissionError('service is draining or stopped'), { status: 503, code: 'admission_paused' });
            return true;
          } }),
        get: (id) => { refreshReviews(store, log, config.env ?? process.env, { reviewGitTimeoutMs: config.reviewGitTimeoutMs, E6_CAPACITY_HOOK: config.E6_CAPACITY_HOOK || draining || stopped }); return getReview(store, id); },
        vote: (id, input) => { refreshReviews(store, log, config.env ?? process.env, { reviewGitTimeoutMs: config.reviewGitTimeoutMs, E6_CAPACITY_HOOK: config.E6_CAPACITY_HOOK || draining || stopped }); return addExternalVote(store, id, input); },
      },
      cards: {
        alias: (id) => { const a = config.accounts.find((x) => x.id === id); return a ? a.displayName ?? a.id : null; },
        runnerAlive: (a) => runnerGroupAlive(a.runner),
        health: () => { const current = store.clockIsCurrent(); return { housekeeping: housekeeping(), host, version: config.version ?? null, startedAt, clockCurrent: current, accounts: config.accounts.map((account) => {
          const stats = probeStats.get(account.id);
          return { alias: account.displayName ?? account.id, provider: account.provider, enabled: account.enabled, running: store.runningCount(account.id),
            identity: current ? identities.view(account.id) ?? null : null,
            allowance: current ? allowances.view(account.id) : { state: 'unknown' as const, accountId: account.id, reason: 'pipe clock is behind its recorded high-water mark' },
            lastProbeAt: stats?.lastAt ?? null, consecutiveProbeFailures: stats?.failures ?? null };
        }) }; },
      },
      cancel: (id) => jobs.get(id)?.abort.abort() }, config.port);
    tick();
    const ticker = setInterval(tick, tickMs);
    const firstPrune = setTimeout(() => { if (!stopped && !draining) void prune().catch((e) => log('prune', e)); }, 50);
    firstPrune.unref();
    let nextPruneAt = Date.now() + pruneIntervalMs;
    let pruner: NodeJS.Timeout;
    const schedulePrune = (): void => {
      pruner = setTimeout(() => {
        if (stopped) return;
        const status = housekeeping(), pressure = pressureTrigger.observe(status.tier, Date.now(), config.housekeeping?.tiers, status.keepHours);
        if (pressure && !pruning && !draining) void prune().catch((e) => log('prune', e));
        if (Date.now() >= nextPruneAt) {
          nextPruneAt = Date.now() + pruneIntervalMs;
          if (!pruning && !draining) void prune().catch((e) => log('prune', e));
        }
        schedulePrune();
      }, Math.max(1, Math.min(30_000, nextPruneAt - Date.now())));
      pruner.unref();
    };
    schedulePrune();
    let stopPromise: Promise<void> | null = null;
    return { url, drained, restartReason: () => restart, stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true; validationAbort.abort(); pruneAbort?.abort(); clearInterval(ticker); clearTimeout(firstPrune); clearTimeout(pruner);
      for (const timer of probeTimers.values()) clearTimeout(timer);
      probeTimers.clear();
      for (const timer of resetProbes) clearTimeout(timer);
      stopPromise = (async () => {
        let saved = false;
        try {
          for (const job of jobs.values()) { job.abort.abort(); job.saveAbort.abort(); }
          await stopGemini(store);
          await Promise.allSettled(validating.values());
          await Promise.allSettled([...jobs.values()].map((job) => job.done));
          if (pruning) await pruning;
          let holdError: unknown, outcomeError: unknown;
          try { await saveLimitHolds(store, allowances, pendingHolds, journal, log); } catch (e) { holdError = e; }
          flushPending();
          for (const id of journaledOutcomes) pending.delete(id); // already synced to the journal or outcome file
          try { await saveOutcomes(store, pending, journal, log); } catch (e) { outcomeError = e; }
          if (outcomeError) markFailedStop(storePath, [...pending.keys()], journaledOutcomes);
          else { rmSync(failureOf(storePath), { force: true }); completionMarker = false; }
          if (holdError || outcomeError) throw new AggregateError([holdError, outcomeError].filter(Boolean),
            [holdError, outcomeError].filter(Boolean).map(errorText).join('; '));
          saved = true;
          checkDrained();
        } catch (e) { log('stop', e); throw e; }
        finally {
          resolveDrained();
          server.closeAllConnections();
          await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
          store.close();
          if (saved) release();
        }
      })();
      return stopPromise;
    } };
  } catch (e) { stopped = true; store.close(); release(); throw e; }
}

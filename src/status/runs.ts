import { createHash } from 'node:crypto';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { RequestLog, type RequestState } from '../core/request-log.ts';
import { toInstant, validAlias } from './snapshot.ts';

export type RunCode =
  | 'waiting_owner_ok'
  | 'waiting_local_host'
  | 'running'
  | 'done'
  | 'cancelled'
  | 'declined'
  | 'expired_not_run'
  | 'failed'
  | 'uncertain';

export type RunStatus = 'waiting' | 'active' | 'ended';

export type LocalRun = {
  runId: string;
  code: RunCode;
  status: RunStatus;
  statusSince: string;
  asOf: string;
  lastActivityAt: string | null;
  placement: 'local';
  placedBy: 'default';
  worker: string | null;
};

/** Huntaway's own folder: HUNTAWAY_HOME (absolute, or ~/...) or ~/.local/share/huntaway; null if not absolute. */
export function getHuntawayHome(): string | null {
  const env = process.env.HUNTAWAY_HOME;
  const dir = env && env.length > 0
    ? (env.startsWith('~/') ? join(homedir(), env.slice(2)) : env)
    : join(homedir(), '.local', 'share', 'huntaway');
  return isAbsolute(dir) ? dir : null;
}

export function mapState(state: RequestState): { code: RunCode; status: RunStatus } {
  switch (state) {
    case 'received':
    case 'queued':
      return { code: 'waiting_local_host', status: 'waiting' };
    case 'submitting':
    case 'dispatched':
    case 'posting':
      return { code: 'running', status: 'active' };
    case 'answered':
      return { code: 'done', status: 'ended' };
    case 'cancelled':
      return { code: 'cancelled', status: 'ended' };
    case 'refused':
      return { code: 'declined', status: 'ended' };
    case 'expired':
      return { code: 'expired_not_run', status: 'ended' };
    case 'failed':
      return { code: 'failed', status: 'ended' };
    case 'uncertain':
      return { code: 'uncertain', status: 'ended' };
  }
}

/** This machine's alias as its owner set it (HUNTAWAY_ALIAS), or null: a label is never invented. */
export function getWorkerAlias(): string | null {
  const alias = process.env.HUNTAWAY_ALIAS;
  return validAlias(alias) ? alias : null;
}

/** True while the process that owns a run is still alive (pid 0 or unknown counts as gone). */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Every Huntaway run belongs to this user, so a pid owned by someone else (EPERM) is a reused pid: the run is gone.
    return false;
  }
}

/**
 * The run list: keys, codes, times and the owning pid only, never text. A small SQLite table in its own file (the
 * reviewed request log's schema is untouched); SQLite's own locking serializes parallel `huntaway ask` runs.
 * The pid is only meaningful on this machine: HUNTAWAY_HOME must be local to one machine, never a shared volume.
 */
function openRuns(homeDir: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(join(homeDir, 'runs.db'), { readOnly });
  // Longer than the open lock can be held (the request log's own 5 s wait, plus the open itself), so a run's required
  // first listing waits out another run's open instead of failing.
  db.exec('PRAGMA busy_timeout = 15000');
  if (readOnly) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS runs (
    key TEXT PRIMARY KEY, code TEXT NOT NULL, since TEXT NOT NULL, last TEXT NOT NULL, pid INTEGER NOT NULL
  ) STRICT`);
  return db;
}

/** Record that `key` entered `state`. `since` is kept while the contract code is unchanged. */
export function recordRunTransition(homeDir: string, key: string, state: RequestState, isoTime: string = new Date().toISOString()): void {
  const code = mapState(state).code;
  const db = openRuns(homeDir);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT code, since FROM runs WHERE key = ?').get(key) as { code: string; since: string } | undefined;
      const since = row && row.code === code ? row.since : isoTime;
      db.prepare('INSERT INTO runs (key, code, since, last, pid) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET code = excluded.code, since = excluded.since, last = excluded.last, pid = excluded.pid')
        .run(key, code, since, isoTime, process.pid);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

/** How a run whose process died is settled: never sent -> refused or cancelled; sent or sending -> uncertain. */
export function orphanOutcome(state: RequestState): RequestState {
  return state === 'received' ? 'refused' : state === 'queued' ? 'cancelled' : 'uncertain';
}

/** The words an open-lock timeout carries (another run held the lock for over 5 s). */
export const OPEN_BUSY = 'huntaway: the open lock is busy';

/**
 * Run `fn` while holding the open lock: SQLite's own write lock on the run list, which every `huntaway ask` and
 * `huntaway status` takes while it opens the request log. The log refuses to open while another process is half-way
 * through creating it (by design), so opens take turns. The lock is released when its process exits, even on a
 * crash (no marker is ever left behind), and taking and releasing it adds no records (the connection is read-write,
 * so like any SQLite connection it may roll back a crashed writer's leftover journal). Throws OPEN_BUSY after 5 s.
 */
export function withOpenLock<T>(homeDir: string, fn: () => T): T {
  const lock = new DatabaseSync(join(homeDir, 'runs.db'), { timeout: 5000 });
  try {
    try {
      lock.exec('BEGIN IMMEDIATE');
    } catch (error) {
      const e = error as { errcode?: number; message?: string };
      if (e.errcode === 5 || /locked|busy/i.test(e.message ?? '')) throw new Error(OPEN_BUSY);
      throw error;
    }
    try {
      return fn();
    } finally {
      try {
        lock.exec('ROLLBACK');
      } catch {
        // close() below rolls back anyway; never hide fn's own error
      }
    }
  } finally {
    lock.close();
  }
}

/** Whether the run list holds a runs table (the open lock may have created an empty file first). Read-only. */
function hasRunsTable(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get() !== undefined;
}

/** Keys of runs still in progress whose owning process is gone (a crash, kill -9, power loss). */
export function orphanedRuns(homeDir: string): string[] {
  if (!existsSync(join(homeDir, 'runs.db'))) return [];
  const db = openRuns(homeDir);
  try {
    const rows = db.prepare("SELECT key, pid FROM runs WHERE code IN ('waiting_local_host', 'running')").all() as { key: string; pid: number }[];
    return rows.filter((r) => r.pid !== process.pid && !processAlive(r.pid)).map((r) => r.key);
  } finally {
    db.close();
  }
}

const DAY_MS = 86_400_000;

/** How long ended runs are kept: HUNTAWAY_KEEP_DAYS whole days from 1 to 3660, 90 when unset; null when it is not. */
export function keepDays(): number | null {
  const env = process.env.HUNTAWAY_KEEP_DAYS;
  if (env === undefined || env === '') return 90;
  return /^[1-9][0-9]{0,3}$/.test(env) && Number(env) <= 3660 ? Number(env) : null;
}

// Only a stamp Huntaway wrote (an instant's toISOString: it reads back unchanged, and SQLite alone also takes hour 24)
// proves a run's age; anything else keeps it.
const STAMP = "(strftime('%Y-%m-%dT%H:%M:%fZ', last) IS last AND substr(last, 12, 2) < '24')";

/** A file Huntaway made in its own folder: a plain file of this user's with one name (never a link to someone else's log). */
function ownFile(path: string): boolean {
  try {
    const s = lstatSync(path);
    return s.isFile() && s.nlink === 1 && (typeof process.getuid !== 'function' || s.uid === process.getuid());
  } catch {
    return false;
  }
}

/**
 * Let old history age out, at most `batch` requests and `batch` leftover runs per call so no other ask waits long:
 * ended `huntaway ask` requests started more than `days` ago leave the request log, then their runs leave the run list.
 * A request whose run is listed in progress, or was active since the cutoff (an orphan another ask has just settled),
 * or has no readable time, stays. The log goes first; a run a crash left behind after its request went is removed
 * later, once it too is old. A run whose request is still in the log goes only with it.
 */
export function pruneHistory(homeDir: string, log: RequestLog, days: number, now: number = Date.now(), batch = 100): number {
  if (!ownFile(join(homeDir, 'requests.db')) || !ownFile(join(homeDir, 'runs.db'))) return 0;
  const cutoff = now - days * DAY_MS, since = new Date(cutoff).toISOString();
  const db = openRuns(homeDir);
  try {
    const live = db.prepare(`SELECT key FROM runs WHERE code IN ('waiting_local_host', 'running') OR last >= ? OR NOT (${STAMP})`).all(since) as { key: string }[];
    const keys = log.forgetEnded({ before: Math.floor(cutoff / 1000), team: 'local', channel: 'cli', keep: new Set(live.map((r) => r.key)), max: batch });
    // A key the log just forgot can be recorded again (a clock stepped back): only an old ended run under it goes. Leftovers
    // are found before the write lock, stopping at a batch; the delete checks again under it.
    const old = `code NOT IN ('waiting_local_host', 'running') AND ${STAMP} AND last < ?`, leftover: string[] = [];
    for (const { key } of db.prepare(`SELECT key FROM runs WHERE ${old} ORDER BY last`).iterate(since) as Iterable<{ key: string }>) {
      if (leftover.length >= batch) break;
      if (!keys.includes(key) && log.get(key) === null) leftover.push(key);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const key of [...keys, ...leftover]) db.prepare(`DELETE FROM runs WHERE key = ? AND ${old}`).run(key, since);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return keys.length;
  } finally {
    db.close();
  }
}

/** The local runs, [] when there are none yet, or null when they exist but can't be read right now. */
export function loadLocalRuns(asOf: string, homeDir: string | null = getHuntawayHome()): LocalRun[] | null {
  if (homeDir === null) return null;
  const dbPath = join(homeDir, 'requests.db');
  if (!existsSync(join(homeDir, 'runs.db'))) return [];  // every run is listed there first: none yet
  let rows: { key: string; since: string; last: string; pid: number }[];
  let log: RequestLog;
  try {
    const db = openRuns(homeDir, true);                  // status never adds to the run list
    try {
      rows = hasRunsTable(db)
        ? db.prepare('SELECT key, since, last, pid FROM runs ORDER BY since').all() as typeof rows
        : [];                                            // the lock made the file; no run was recorded yet
    } finally {
      db.close();
    }
    if (rows.length === 0) return [];
    // The request log's constructor never recovers anything (it refuses instead); on an existing log it only
    // inspects the file and re-asserts its journal settings. Status never creates or initialises a log: runs listed
    // with the log gone or empty are unavailable. Checked under the lock, where no ask can be creating it.
    log = withOpenLock(homeDir, () => {
      if (!existsSync(dbPath) || statSync(dbPath).size === 0) throw new Error('no request log');
      return new RequestLog(dbPath);
    });
  } catch {
    return null;
  }
  const worker = getWorkerAlias();
  const runs: LocalRun[] = [];
  try {
    for (const row of rows) {
      const since = toInstant(row.since);
      if (since === null) continue;
      let req;
      try {
        req = log.get(row.key);
      } catch {
        continue;
      }
      if (!req) continue;
      let { code, status } = mapState(req.state);
      // A run still in progress whose process is gone can't finish. Show it the way the next `huntaway ask` will
      // record it (status itself writes nothing): never sent -> declined or cancelled; sent or sending -> uncertain.
      if (status !== 'ended' && row.pid !== process.pid && !processAlive(row.pid)) {
        code = mapState(orphanOutcome(req.state)).code;
        status = 'ended';
      }
      runs.push({
        runId: 'run_' + createHash('sha256').update(row.key).digest('base64url').slice(0, 24),
        code,
        status,
        statusSince: since,
        asOf: toInstant(asOf) ?? asOf,
        lastActivityAt: toInstant(row.last),
        placement: 'local',
        placedBy: 'default',
        worker,
      });
    }
  } finally {
    log.close();
  }
  return runs;
}

export function formatRunsHuman(runs: LocalRun[] | null): string {
  if (runs === null) return 'Local runs: unavailable right now.';
  if (runs.length === 0) return 'No local runs yet.';
  const counts = new Map<RunCode, number>();
  for (const r of runs) counts.set(r.code, (counts.get(r.code) || 0) + 1);
  const order: RunCode[] = ['done', 'failed', 'uncertain', 'running', 'waiting_local_host', 'waiting_owner_ok',
    'cancelled', 'declined', 'expired_not_run'];
  const parts = order.filter((c) => counts.has(c)).map((c) => `${counts.get(c)} ${c}`);
  return `${runs.length} ${runs.length === 1 ? 'local run' : 'local runs'}: ${parts.join(', ')}`;
}

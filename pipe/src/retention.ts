/** What the Pipe made and no longer needs: ended records past their age, and its own log past its size (2026-11-01). */
import { fstatSync, ftruncateSync, lstatSync, readSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type RetentionConfig = { keepRecordsDays?: number; logMaxMb?: number };
const ENDED = "('completed', 'failed', 'cancelled', 'start_mismatch')";
const BODY = (t: string, c = 'body') => `CASE WHEN json_valid(${t}.${c}) THEN ${t}.${c} ELSE '{}' END`;
// Only a store stamp (an instant's toISOString: text SQLite reads back unchanged, below hour 24, which SQLite alone takes)
// proves age; any other time keeps its row.
const STAMP = (e: string) => `coalesce(typeof(${e}) = 'text' AND strftime('%Y-%m-%dT%H:%M:%fZ', ${e}) IS ${e} AND substr(${e}, 12, 2) < '24', 0)`;
const SEATS = `SELECT v.id review, s.type type, json_type(CASE WHEN s.type = 'object' THEN s.value ELSE '{}' END, '$.requestId') idType,
  json_extract(CASE WHEN s.type = 'object' THEN s.value ELSE '{}' END, '$.requestId') id FROM reviews v, json_each(${BODY('v')}, '$.seats') s`;

/** At least 32 days, so /v1/stats (31 days back from today) never loses a day it can be asked for; a 0 MiB log cap is off. */
export function validateRetention(config: RetentionConfig = {}): { keepRecordsDays: number; logMaxBytes: number } {
  const { keepRecordsDays = 90, logMaxMb = 10 } = config;
  if (!Number.isSafeInteger(keepRecordsDays) || keepRecordsDays < 32 || keepRecordsDays > 3660) throw new RangeError('housekeeping.keepRecordsDays must be whole days from 32 to 3660');
  if (!Number.isSafeInteger(logMaxMb) || logMaxMb < 0 || logMaxMb > 1024) throw new RangeError('housekeeping.logMaxMb must be whole MiB from 0 (off) to 1024');
  return { keepRecordsDays, logMaxBytes: logMaxMb * 1024 * 1024 };
}

/**
 * Inside the caller's write transaction, delete up to `limit` ended records last changed before `before`: finished
 * reviews first, then ended requests from a window of `scan` rows after `after` (the returned `next` resumes there, 0
 * wraps), with their attempts and admission keys (a lane's rounds continue from the store's lane_rounds). Anything that
 * may still be needed stays: a running or failed-cleanup review, a seat of a kept review, a request with an open
 * attempt, a worktree the prune has not recorded as removed, a saved start of an open request, and an attempt whose
 * scratch folder exists or cannot be ruled out. Unreadable seats or saved starts keep every request.
 */
export function pruneEnded(db: DatabaseSync, before: string, tmpRoot: string, after = 0, limit = 1000, scan = 5000) {
  const run = (sql: string, ids: string[]) => db.prepare(sql.replace('?', '(SELECT value FROM json_each(?))')).run(JSON.stringify(ids));
  const reviews = (db.prepare(`WITH open AS MATERIALIZED (SELECT id FROM requests WHERE state NOT IN ${ENDED}
      UNION SELECT request_id FROM attempts WHERE ended_at IS NULL), seats AS MATERIALIZED (${SEATS})
    SELECT v.id FROM reviews v WHERE v.state = 'finished' AND ${STAMP('v.updated_at')} AND v.updated_at < ? AND json_valid(v.body)
      AND coalesce(json_type(${BODY('v')}, '$.seats'), 'array') = 'array' AND json_type(${BODY('v')}, '$.cleanup') IS NULL
      AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.review = v.id AND (s.type IS NOT 'object' OR s.idType IS NOT 'text' OR s.id IN (SELECT id FROM open)))
    ORDER BY v.created_at LIMIT ?`).all(before, limit) as { id: string }[]).map(r => r.id);
  run("DELETE FROM admissions WHERE namespace = 'review' AND request_id IN ?", reviews);
  run('DELETE FROM reviews WHERE id IN ?', reviews);
  const unreadable = db.prepare(`SELECT EXISTS (SELECT 1 FROM reviews v WHERE NOT json_valid(v.body) OR coalesce(json_type(${BODY('v')}, '$.seats'), 'array') <> 'array')
    OR EXISTS (SELECT 1 FROM (${SEATS}) WHERE type IS NOT 'object' OR idType IS NOT 'text') OR EXISTS (SELECT 1 FROM requests o WHERE o.state NOT IN ${ENDED}
      AND (NOT json_valid(o.body) OR json_type(${BODY('o')}, '$.startSource') IS NOT NULL AND json_type(${BODY('o')}, '$.startSource.requestId') IS NOT 'text')) bad`).get()!.bad;
  if (unreadable) return { requests: 0, reviews: reviews.length, next: after, unreadable: true };
  // A missing tmpRoot, or one that is not a directory (an unmounted volume, a dangling link), rules out no scratch folder.
  const root = (() => { try { return statSync(tmpRoot).isDirectory(); } catch { return false; } })();
  const scratch = (id: string) => { try { return !root || !!lstatSync(join(tmpRoot, id)); } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; } };
  const span = db.prepare('SELECT max(seq) last, count(*) n FROM (SELECT seq FROM requests WHERE seq > ? ORDER BY seq LIMIT ?)').get(after, scan) as { last: number | null; n: number };
  const rows = db.prepare(`WITH seat AS MATERIALIZED (SELECT id FROM (${SEATS}) WHERE id IS NOT NULL),
      source AS MATERIALIZED (SELECT json_extract(${BODY('o')}, '$.startSource.requestId') id FROM requests o WHERE o.state NOT IN ${ENDED})
    SELECT r.id, r.seq, (SELECT json_group_array(a.id) FROM attempts a WHERE a.request_id = r.id) attempts FROM requests r
    WHERE r.seq > ? AND r.seq <= ? AND r.state IN ${ENDED} AND ${STAMP('r.finished_at')} AND r.finished_at < ?
      AND (r.workspace IS NULL OR ${STAMP(`json_extract(${BODY('r', 'workspace')}, '$.removedAt')`)})
      AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.request_id = r.id AND a.ended_at IS NULL)
      AND r.id NOT IN (SELECT id FROM seat) AND r.id NOT IN (SELECT id FROM source WHERE id IS NOT NULL) ORDER BY r.seq`)
    .all(after, span.last ?? after, before) as { id: string; seq: number; attempts: string }[];
  const requests: string[] = [];
  let next = span.n < scan ? 0 : span.last ?? 0;
  for (const row of rows) {
    if (requests.length >= limit - reviews.length) { next = row.seq - 1; break; }
    if (!(JSON.parse(row.attempts) as string[]).some(scratch)) requests.push(row.id);
  }
  for (const sql of ['DELETE FROM attempts WHERE request_id IN ?', "DELETE FROM admissions WHERE namespace = 'request' AND request_id IN ?", 'DELETE FROM requests WHERE id IN ?']) run(sql, requests);
  return { requests: requests.length, reviews: reviews.length, next };
}

const unappended = new Set<string>();
/**
 * Keep a log the service alone writes to through stdout or stderr (launchd's StandardOutPath/StandardErrorPath) at
 * most `maxBytes` (0 is off): past that, the file keeps only its newest lines from a line start, up to half the cap,
 * after one line saying so. The Pipe never knows the file's name, only its open descriptor, so it trims in place; launchd opens it
 * for append, so the next line lands at the new end. A descriptor that is not (the file did not shrink) is trimmed
 * once, reported, then left. Returns the bytes removed.
 */
export function capLog(maxBytes: number, fds: readonly number[] = [1, 2]): number {
  const seen = new Set<string>();
  let removed = 0;
  for (const fd of fds) {
    let stat;
    try { stat = fstatSync(fd); } catch { continue; }
    const file = `${stat.dev}:${stat.ino}`;
    if (maxBytes === 0 || !stat.isFile() || seen.has(file) || unappended.has(file)) continue;
    seen.add(file);
    if (stat.size <= maxBytes) continue;
    const tail = Buffer.alloc(Math.min(stat.size, Math.floor(maxBytes / 2)));
    let read = 0;
    try {
      for (let n = 1; read < tail.length && n > 0; read += n) n = readSync(fd, tail, read, tail.length - read, stat.size - tail.length + read);
    } catch { read = 0; /* write-only: keep no old lines */ }
    const start = read === tail.length ? tail.indexOf(10) + 1 : 0, kept = start > 0 ? tail.subarray(start) : Buffer.alloc(0);
    const out = Buffer.concat([Buffer.from(`pipe log: trimmed at ${stat.size} bytes, keeping the newest ${kept.length} (housekeeping.logMaxMb)\n`), kept]);
    ftruncateSync(fd, 0);
    for (let at = 0, n = 1; at < out.length; at += n) if ((n = writeSync(fd, out, at, out.length - at)) <= 0) throw new Error('log trim made no write progress');
    removed += stat.size - kept.length;
    if (fstatSync(fd).size >= stat.size) {   // not opened for append: the lines landed past a hole, so stop trimming it
      unappended.add(file);
      throw new Error(`descriptor ${fd} is not opened for append; its log is no longer trimmed`);
    }
  }
  return removed;
}

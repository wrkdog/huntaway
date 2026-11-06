/** Content-free daily aggregates; record selection and percentile work stays in SQLite. */
import type { DatabaseSync } from 'node:sqlite';

export type WorkspaceDiff = { files: number; insertions: number; deletions: number };
export const validDiff = (v: unknown): v is WorkspaceDiff => typeof v === 'object' && v !== null &&
  ['files', 'insertions', 'deletions'].every(k => Number.isSafeInteger((v as Record<string, unknown>)[k]) && ((v as Record<string, number>)[k] ?? -1) >= 0);
export const validLane = (v: unknown): v is string | undefined => v === undefined || typeof v === 'string' && v.trim().length > 0 && v.length <= 80;
export const validSince = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export function reviewSetupFailed(review: { setupFailed?: unknown; seats?: unknown }): boolean {
  return review.setupFailed === true || Array.isArray(review.seats) && review.seats.some(s => s && typeof s === 'object' &&
    (s.requestId === '' && typeof s.reason === 'string' && s.reason.startsWith('never submitted') ||
      s.status === 'failed' && (s.setupCancelled === true || s.setupCancelled === undefined && s.reason === 'review submission failed')));
}

/** NUL framing preserves tabs/newlines; a rename carries two additional path fields. */
export function numstat(bytes: Buffer): WorkspaceDiff {
  const diff = { files: 0, insertions: 0, deletions: 0 }, records = bytes.toString('utf8').split('\0');
  if (records.pop() !== '') throw new Error('unterminated numstat');
  for (let i = 0; i < records.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]!);
    if (!match || (match[1] === '-') !== (match[2] === '-')) throw new Error('invalid numstat');
    if (match[3] === '') {
      if (!records[++i] || !records[++i]) throw new Error('invalid numstat rename');
    }
    diff.files++; diff.insertions += match[1] === '-' ? 0 : Number(match[1]); diff.deletions += match[2] === '-' ? 0 : Number(match[2]);
    if (!validDiff(diff)) throw new Error('numstat overflow');
  }
  return diff;
}

export const TELEMETRY_INDEXES = `CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at);
  CREATE INDEX IF NOT EXISTS requests_build_created ON requests(created_at)
    WHERE json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.mutating') = 1;
  CREATE INDEX IF NOT EXISTS reviews_created ON reviews(created_at);
  CREATE INDEX IF NOT EXISTS reviews_lane ON reviews(
    json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.repository'),
    json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.lane'));`;

export function dailyStats(db: DatabaseSync, since: string, now: Date) {
  if (Date.parse(since) < Date.parse(now.toISOString().slice(0, 10)) - 31 * 86_400_000)
    throw Object.assign(new RangeError('since must be within 31 days of today (UTC)'), { status: 400 });
  const rows = db.prepare(`WITH
    review_rows AS MATERIALIZED (SELECT created_at, body b, review_setup_failed(body) setup FROM reviews
      WHERE created_at >= ? AND json_valid(body) AND json_type(CASE WHEN json_valid(body) THEN body ELSE '{}' END) = 'object'),
    builds AS (SELECT substr(r.created_at, 1, 10) day,
      (julianday((SELECT min(a.started_at) FROM attempts a WHERE a.request_id = r.id)) - julianday(r.created_at)) * 86400 wait,
      CASE WHEN r.state = 'completed' AND json_extract(w, '$.saved') IN ('saved', 'no_changes')
        AND json_type(w, '$.diff.insertions') = 'integer' AND json_type(w, '$.diff.deletions') = 'integer'
        AND json_type(w, '$.diff.files') = 'integer' AND json_extract(w, '$.diff.files') BETWEEN 0 AND 9007199254740991
        AND json_extract(w, '$.diff.insertions') BETWEEN 0 AND 9007199254740991 AND json_extract(w, '$.diff.deletions') BETWEEN 0 AND 9007199254740991 - json_extract(w, '$.diff.insertions')
        THEN json_extract(w, '$.diff.insertions') + json_extract(w, '$.diff.deletions') END lines
      FROM (SELECT id, state, created_at, CASE WHEN json_valid(workspace) THEN workspace ELSE '{}' END w FROM requests
        WHERE created_at >= ? AND json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.mutating') = 1) r),
    samples AS (SELECT day, 'wait' metric, round(wait, 3) value FROM builds WHERE wait >= 0
      UNION ALL SELECT day, 'lines', lines FROM builds WHERE lines IS NOT NULL),
    ranked AS (SELECT *, row_number() OVER (PARTITION BY day, metric ORDER BY value) i,
      count(*) OVER (PARTITION BY day, metric) n FROM samples),
    percentiles AS (SELECT day, metric, avg(CASE WHEN i IN ((n+1)/2, (n+2)/2) THEN value END) median,
      max(CASE WHEN i = (9*n+9)/10 THEN value END) p90 FROM ranked GROUP BY day, metric),
    bc AS (SELECT day, count(*) count FROM builds GROUP BY day),
    rc AS (SELECT substr(created_at, 1, 10) day, count(*) count,
      sum(json_extract(b, '$.receipt.quorum.approved') = 1) approved,
      sum(EXISTS(SELECT 1 FROM json_each(b, '$.receipt.votes')
        WHERE json_extract(CASE WHEN type = 'object' THEN value ELSE '{}' END, '$.verdict') = 'REVISE')) revise,
      sum(setup) setupFailed,
      sum(NOT setup AND EXISTS(SELECT 1 FROM
        (SELECT CASE WHEN type = 'object' THEN value ELSE '{}' END s FROM json_each(b, '$.seats'))
        WHERE json_extract(s, '$.status') = 'failed' AND json_type(s, '$.requestId') = 'text' AND length(json_extract(s, '$.requestId')) > 0)) seatFailed,
      max(CASE WHEN json_type(b, '$.round') = 'integer' AND json_extract(b, '$.round') BETWEEN 0 AND 9007199254740991 THEN json_extract(b, '$.round') END) roundMax
      FROM review_rows GROUP BY day),
    days AS (SELECT day FROM bc UNION SELECT day FROM rc)
    SELECT days.day, bc.count builds, w.median waitMedianSec, w.p90 waitP90Sec, l.median linesMedian, CAST(l.p90 AS REAL) linesP90,
      rc.count reviews, rc.approved, rc.revise, rc.setupFailed, rc.seatFailed, CAST(rc.roundMax AS REAL) roundMax
    FROM days LEFT JOIN bc USING(day) LEFT JOIN rc USING(day)
      LEFT JOIN percentiles w ON w.day = days.day AND w.metric = 'wait'
      LEFT JOIN percentiles l ON l.day = days.day AND l.metric = 'lines' ORDER BY days.day`).all(`${since}T00:00:00.000Z`, `${since}T00:00:00.000Z`);
  return { days: rows.map(r => ({ day: String(r.day), builds: { count: Number(r.builds ?? 0),
    waitMedianSec: r.waitMedianSec as number | null, waitP90Sec: r.waitP90Sec as number | null,
    linesMedian: r.linesMedian as number | null, linesP90: r.linesP90 as number | null },
    reviews: { count: Number(r.reviews ?? 0), approved: Number(r.approved ?? 0), revise: Number(r.revise ?? 0),
      setupFailed: Number(r.setupFailed ?? 0), seatFailed: Number(r.seatFailed ?? 0), roundMax: r.roundMax as number | null } })) };
}

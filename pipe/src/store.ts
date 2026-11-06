import { randomUUID } from 'node:crypto';
import { admission, type Admission, admissionFields, storedAdmission, type AdmissionFields, type StoredAdmission } from './admission.ts';
import { StoreAdmissions, FIELD_LIMIT, directory } from './admission-store.ts';
import { commitHash, inspectSavedStart, sourceReceipt, validSavedStart, type SavedStart } from './saved-base.ts';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Availability } from './availability.ts';
import type { AccountConfig } from './identity.ts';
import { instantOf, type SavedLimitHold } from './allowance.ts';
import { ARGON_MODEL, geminiReadOnly, checkChoice, PROVIDERS, type Policy, type Provider } from './policy.ts';

import { plan, type AccountStatus } from './queue.ts';
import { hostAlias } from './host.ts';
import { pruneEnded } from './retention.ts';
import { dailyStats, reviewSetupFailed, TELEMETRY_INDEXES, validSince, validDiff, type WorkspaceDiff } from './telemetry.ts';

const KINDS = ['code', 'computer', 'chat', 'question', 'review'] as const;
export const PRIORITIES = ['interactive', 'background'] as const;
const ERROR_KINDS = ['quota_exhausted', 'rate_limited', 'disk_full', 'setup_timeout', 'auth', 'offline', 'transient', 'other', 'model_mismatch', 'start_mismatch'] as const;
const REQUEST_ERRORS = [...ERROR_KINDS, 'no_outcome', 'interrupted', 'cancelled', 'unroutable', 'malformed', 'admission_backoff', 'admission_busy', 'admission_unknown', 'admission_exhausted', 'review_reserve'] as const;
const AVOID = new Set<string>(['no_outcome']);
const DAY_MS = 86_400_000, LEASE_GRACE_MS = 60_000, LEASE_TICK_MS = 1_000, LEASE_HEARTBEAT_MAX_AGE_MS = 30_000;
export const FIRST_INSTANT = Date.parse('0000-01-01T00:00:00.000Z');
export const LAST_INSTANT = Date.parse('9999-12-31T23:59:59.999Z');

export type Kind = (typeof KINDS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type ErrorKind = (typeof ERROR_KINDS)[number];
export type RequestState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'start_mismatch';
export type RequestError = { kind: (typeof REQUEST_ERRORS)[number]; message: string; resetAt?: string | null };
export type Workspace = { path: string; branch: string; commit: string; startCommit?: string; saved?: 'saved' | 'no_changes' | 'not_saved' | 'unknown'; diff?: WorkspaceDiff; saveFailures?: number; saveDelays?: number; lastAttemptAt?: string; unsaveable?: boolean; excludedPaths?: number; saveRetryAt?: string; removing?: boolean; removingAt?: string; removedAt?: string; housekeepingKind?: 'needs-archive' | 'locked' | ''; housekeepingFingerprint?: string };
export type WaitKind = 'paused' | 'backoff' | 'pinned_account' | 'no_route' | 'no_free_account';
export type Wait = { reason: string; until: string | null; stoppedSince?: string; kind?: WaitKind };
export type RequesterLoad = { running: number; lastDispatchedAt: string | null };
export type Lease = { id: string; holder: string; accountId: string; purpose: string | null; createdAt: string; renewedAt: string;
  expiresAt: string; releasedAt: string | null; headroomAtStart: number | null };
export const validLeaseTtl = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 60 && v <= 3600;
const leaseError = (status: number, code: string, message: string) => Object.assign(new StoreError(message), { status, code });
const toLease = (r: Row): Lease => ({ id: String(r.id), holder: String(r.holder), accountId: String(r.account_id),
  purpose: r.purpose as string | null, createdAt: String(r.created_at), renewedAt: String(r.renewed_at),
  expiresAt: new Date(Number(r.expires_at)).toISOString(), releasedAt: r.released_at as string | null, headroomAtStart: r.headroom_at_start as number | null });

export type NewRequest = AdmissionFields & {
  requester: string;
  project: string;
  kind: Kind;
  provider: Provider;
  model: string;
  effort: string;
  reason: string;
  prompt: string;
  mutating: boolean;
  priority: Priority;
  pin?: string;
  placement?: 'ordinary_headroom';
  automatic?: { fallback: { provider: 'claude'; model: 'opus'; effort: 'high'; reason: string }; reviewReserve: 0.1 };
  exclude?: string[];
  cwd?: string;
  expectedStartCommit?: string;
  pinnedStartCommit?: string;
  requireCleanStart?: boolean;
  contextPacketSha256?: string;
};

export type RequestRecord = NewRequest & StoredAdmission & {
  startSource?: SavedStart;
  finishedAt?: string | null;
  id: string;
  seq: number;
  state: RequestState;
  createdAt: string;
  updatedAt: string;
  waiting: Wait | null;
  notBefore: string | null;
  avoid: string[];
  result: string | null;
  workspace: Workspace | null;
  error: RequestError | null;
  by?: string;
};

export type Evidence = { accountId: string; model: string; observedAt: string; verdict: Availability; allowanceObservedAt?: string | null; allowanceSource?: 'verified' | 'cache' | null; ordinaryExhaustion?: { observedAt: string; until: string | null } | null };
type ClaimAllowance = { provenance: 'claim_verdict'; headroom: number; basis: 'ordinary' | 'credits'; evaluatedAt: string; observedAt: string | null; source?: 'verified' | 'cache' | null };
export type Route = Pick<NewRequest, 'provider' | 'model' | 'effort' | 'reason'>;
export function ordinaryExhausted(e: Evidence, id: string, model: string, now: number, maxAge: number): boolean {
  const fresh = (at: unknown) => { const t = instantOf(at); return t !== null && t <= now && now - t <= maxAge; };
  if (e?.accountId !== id || e.model !== model || !fresh(e.observedAt) || !fresh(e.allowanceObservedAt)) return false;
  const v = e.verdict, proof = e.ordinaryExhaustion;
  if (!proof || !fresh(proof.observedAt) || proof.observedAt !== e.allowanceObservedAt ||
    (proof.until !== null && !((instantOf(proof.until) ?? -Infinity) > now))) return false;
  if (v?.state === 'available') return Number.isFinite(v.headroom) && v.headroom >= 0 && v.headroom <= 1 && (v.headroom === 0 || v.via === 'credits');
  return v?.state === 'unavailable' && v.cause === 'allowance' && (v.until === null || (instantOf(v.until) ?? -Infinity) > now);
}
export type DispatchEvidence = Evidence & { host?: string | null; grant: string[]; allowance?: ClaimAllowance; route?: Route };
export const validPlacement = (v: unknown): v is NewRequest['placement'] => v === undefined || v === 'ordinary_headroom';
export const ordinaryRoom = (v: Availability): boolean => v?.state === 'available' && v.via === undefined && typeof v.headroom === 'number' && v.headroom > 0 && v.headroom <= 1;
export type RunnerIdentity = { pid: number; startedAt: string };

export type AttemptOutcome =
  | { kind: 'completed'; result: string; workspace?: Workspace }
  | { kind: 'failed'; errorKind: ErrorKind; message: string; limitRecorded?: boolean; workspace?: Workspace; untouched?: boolean }
  | { kind: 'cancelled'; message?: string; workspace?: Workspace }
  | { kind: 'no_outcome'; message: string }
  | { kind: 'unstarted'; message: string; workspace?: Workspace }
  | { kind: 'interrupted'; message: string; workspace?: Workspace };

export type Attempt = {
  id: string;
  requestId: string;
  accountId: string;
  dispatch: DispatchEvidence;
  startedAt: string;
  endedAt: string | null;
  outcome: AttemptOutcome | null;
  runner: RunnerIdentity | null;
  geminiSupervisor?: RunnerIdentity;
  geminiUnresolved?: boolean;
  reportedModel: string | null;
  events?: { count: number; lastAt: string } | null;
  closedAt?: string | null;
};

export type StoreOptions = { now?: () => Date; leaseTickMs?: number; maxAttempts?: number; retryBackoffMs?: number; maxLimits?: number; evidenceMaxAgeMs?: number; authHoldMs?: number; authHoldMaxMs?: number };
export type Start = { ok: true; attempt: Attempt } | { ok: false; reason: string };

export class StoreError extends Error {
  override name = 'StoreError';
}

type Row = Record<string, unknown>;
type Check = (v: unknown) => boolean;
const isText: Check = (v) => typeof v === 'string';
const filled: Check = (v) => typeof v === 'string' && v.trim() !== '';
const oneOf = (options: readonly string[]): Check => (v) => typeof v === 'string' && options.includes(v);
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const orNull = (check: Check): Check => (v) => v === null || check(v);
const isObject = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const fits = (v: unknown, shape: Record<string, Check>): v is Row =>
  isObject(v) && Object.entries(shape).every(([k, check]) => check(v[k]));
const pick = (v: Row, shape: object): Row =>
  Object.fromEntries(Object.keys(shape).filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
const retrySafe = (o: unknown): boolean => isObject(o) && (o.kind === 'unstarted' || o.kind === 'failed' && o.untouched === true && !o.workspace);
const jsonOrNull = (v: unknown) => (v === null ? null : JSON.stringify(v));
const changed = (r: { changes: number | bigint }) => Number(r.changes) > 0;

const REQUEST: Record<keyof NewRequest, [Check, string]> = {
  requester: [(v) => filled(v) && !(v as string).trim().startsWith('--') && Buffer.byteLength(v as string) <= 128, 'a non-empty name of at most 128 UTF-8 bytes not starting with --'],
  project: [filled, 'a non-empty name'],
  kind: [oneOf(KINDS), `one of ${KINDS.join(', ')}`],
  provider: [oneOf(PROVIDERS), `one of ${PROVIDERS.join(', ')}`],
  model: [filled, 'a model id'],
  effort: [filled, 'an effort level'],
  reason: [filled, 'stated: say why this model and effort fit the task'],
  prompt: [filled, 'non-empty text'],
  mutating: [(v) => typeof v === 'boolean', 'true or false'],
  priority: [oneOf(PRIORITIES), `one of ${PRIORITIES.join(', ')}`],
  pin: [optional(filled), 'an account id when given'],
  placement: [validPlacement, 'ordinary_headroom when given'],
  automatic: [optional(isObject), 'an explicit automatic route'],
  exclude: [optional((v) => Array.isArray(v) && v.every(filled)), 'a list of account ids when given'],
  expectedStartCommit: [optional(commitHash), 'a full lowercase commit hash when given'],
  pinnedStartCommit: [optional(commitHash), 'a full lowercase commit hash when given'],
  requireCleanStart: [optional(v => typeof v === 'boolean'), 'a boolean when given'],
  cwd: [optional((v) => typeof v === 'string' && isAbsolute(v)), 'an absolute path when given'],
  contextPacketSha256: [optional((v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)), 'a SHA-256 hex digest when given'],
  ...admissionFields(optional, filled),
};
const WAIT = { reason: isText, until: orNull(isText), stoppedSince: optional(isText), kind: optional(oneOf(['paused', 'backoff', 'pinned_account', 'no_route', 'no_free_account'])) };
const WORKSPACE = { lastAttemptAt: optional(isText), saveDelays: optional(v => Number.isSafeInteger(v) && Number(v) >= 0), removing: optional(v => typeof v === 'boolean'), removingAt: optional(isText), removedAt: optional(isText), housekeepingKind: optional(oneOf(['needs-archive', 'locked', ''])), housekeepingFingerprint: optional(isText), saveRetryAt: optional(isText), path: isText, branch: isText, commit: isText, startCommit: optional(commitHash), saved: optional(oneOf(['saved', 'no_changes', 'not_saved', 'unknown'])), diff: optional(validDiff), saveFailures: optional(v => Number.isSafeInteger(v) && Number(v) >= 0), unsaveable: optional(v => typeof v === 'boolean'), excludedPaths: optional(v => Number.isSafeInteger(v) && Number(v) >= 0) };
const ERROR = { kind: oneOf(REQUEST_ERRORS), message: isText, resetAt: optional(orNull(v => instantOf(v) !== null)) };
const OUTCOMES: Record<string, Record<string, Check>> = {
  completed: { result: isText, workspace: optional((v) => fits(v, WORKSPACE)) },
  failed: { errorKind: oneOf(ERROR_KINDS), message: isText, limitRecorded: optional((v) => typeof v === 'boolean'), workspace: optional((v) => fits(v, WORKSPACE)), untouched: optional((v) => typeof v === 'boolean') },
  cancelled: { message: optional(isText), workspace: optional((v) => fits(v, WORKSPACE)) },
  no_outcome: { message: isText },
  unstarted: { message: isText, workspace: optional((v) => fits(v, WORKSPACE)) },
  interrupted: { message: isText, workspace: optional((v) => fits(v, WORKSPACE)) },
};

export function validAutomatic(r: Record<string, unknown>): boolean {
  if (r.automatic === undefined) return true;
  const a = r.automatic, f = isObject(a) ? a.fallback : null;
  return isObject(a) && Object.keys(a).every(k => ['fallback', 'reviewReserve'].includes(k)) && a.reviewReserve === 0.1 && isObject(f) && Object.keys(f).every(k => ['provider', 'model', 'effort', 'reason'].includes(k)) && f.provider === 'claude' && f.model === 'opus' && f.effort === 'high' && filled(f.reason)
    && r.provider === 'codex' && r.model === 'gpt-6.1-sol' && r.effort === 'high' && r.placement === 'ordinary_headroom' && r.pin === undefined;
}

function checkRequest(raw: unknown, stored = false): NewRequest {
  if (!isObject(raw)) throw new StoreError('a request must be an object');
  if ((raw.kind === 'question' || raw.kind === 'review' || raw.provider === 'gemini' && raw.model === ARGON_MODEL) &&
    !(raw.provider === 'gemini' && raw.model === ARGON_MODEL && geminiReadOnly(raw))) throw new StoreError('unsupported request kind for this provider/model; question/review require exact read-only Gemini Argon');
  if (!validAutomatic(raw)) throw new StoreError('invalid automatic route: exact Codex primary, Claude fallback, 10% review reserve, ordinary placement and no pin required');
  if (raw.mutating === true && raw.cwd === undefined) throw new StoreError('changing work needs an absolute cwd');
  for (const [field, [check, want]] of Object.entries(REQUEST)) {
    if (!(stored && field === 'requester' ? filled(raw[field]) : check(raw[field]))) throw new StoreError(`the request's ${field} must be ${want}`);
  }
  if (raw.expectedStartCommit !== undefined && (raw.mutating !== true || raw.cwd === undefined)) throw new StoreError('expectedStartCommit requires changing work with cwd');
  if (raw.pinnedStartCommit !== undefined && (raw.mutating !== true || raw.cwd === undefined || raw.expectedStartCommit !== undefined)) throw new StoreError('pinnedStartCommit requires changing work with cwd and excludes expectedStartCommit');
  if (raw.requireCleanStart === true && raw.pinnedStartCommit === undefined) throw new StoreError('requireCleanStart: true requires pinnedStartCommit');
  const body = pick(raw, REQUEST) as NewRequest;
  if (body.head) body.head = body.head.toLowerCase();
  if (body.base) body.base = body.base.toLowerCase();
  if (Buffer.byteLength(JSON.stringify(body)) > FIELD_LIMIT) throw new StoreError('request exceeds the 1 MiB stored body limit');
  return body;
}

function checkOutcome(o: unknown): AttemptOutcome {
  const shape = isObject(o) && Object.hasOwn(OUTCOMES, String(o.kind)) ? OUTCOMES[String(o.kind)] : undefined;
  if (!shape || !fits(o, shape)) throw new StoreError(`an attempt outcome must be one of ${Object.keys(OUTCOMES).join(', ')}, with its fields`);
  const clean: Record<string, unknown> = { kind: o.kind, ...pick(o, shape) };
  if (isObject(clean.workspace)) clean.workspace = pick(clean.workspace, WORKSPACE);
  return clean as AttemptOutcome;
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new StoreError(`${what} must be text`);
  return v;
}

const CHANGES = `CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
  INSERT OR IGNORE INTO changes (id, last) SELECT 1, COALESCE(MAX(change_seq), 0) FROM requests;
  CREATE INDEX IF NOT EXISTS requests_change ON requests (change_seq);
  CREATE TRIGGER IF NOT EXISTS requests_changed_on_insert AFTER INSERT ON requests BEGIN
    UPDATE changes SET last = last + 1 WHERE id = 1;
    UPDATE requests SET change_seq = (SELECT last FROM changes WHERE id = 1) WHERE seq = NEW.seq; END;
  CREATE TRIGGER IF NOT EXISTS requests_changed AFTER UPDATE ON requests WHEN NEW.change_seq IS OLD.change_seq BEGIN
    UPDATE changes SET last = last + 1 WHERE id = 1;
    UPDATE requests SET change_seq = (SELECT last FROM changes WHERE id = 1) WHERE seq = NEW.seq; END;
  CREATE TRIGGER IF NOT EXISTS attempts_changed_on_insert AFTER INSERT ON attempts BEGIN
    UPDATE changes SET last = last + 1 WHERE id = 1;
    UPDATE requests SET change_seq = (SELECT last FROM changes WHERE id = 1) WHERE id = NEW.request_id; END;
  CREATE TRIGGER IF NOT EXISTS attempts_changed AFTER UPDATE ON attempts BEGIN
    UPDATE changes SET last = last + 1 WHERE id = 1;
    UPDATE requests SET change_seq = (SELECT last FROM changes WHERE id = 1) WHERE id = NEW.request_id; END`;

const CLOSED_ONCE = `CREATE TRIGGER IF NOT EXISTS attempts_closed_once BEFORE UPDATE OF closed_at ON attempts
  WHEN OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at BEGIN SELECT RAISE(ABORT, 'closed_at is write-once'); END`;

const FINISHED = `CREATE TRIGGER IF NOT EXISTS requests_finished AFTER UPDATE OF state ON requests
  WHEN NEW.state IN ('completed', 'failed', 'cancelled', 'start_mismatch') AND NEW.finished_at IS NULL
  BEGIN UPDATE requests SET finished_at = NEW.updated_at WHERE seq = NEW.seq; END`;

const SCHEMA = `
  CREATE TABLE requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,     -- submission order, never the clock
    id TEXT NOT NULL UNIQUE,
    requester TEXT NOT NULL,                   -- also in the body; a column so load is counted in SQL
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'start_mismatch')),
    body TEXT NOT NULL,                        -- the validated NewRequest, as JSON
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    waiting TEXT,                              -- JSON Wait, while queued
    not_before TEXT,
    avoid TEXT NOT NULL DEFAULT '[]',          -- JSON list of account ids
    result TEXT,
    workspace TEXT,                            -- JSON Workspace
    error TEXT,                                -- JSON RequestError
    cancelled_by TEXT,                        -- cancellation actor
    finished_at TEXT,                         -- when it reached a final state, set once (FINISHED)
    change_seq INTEGER                        -- CHANGES: the write order a reader pages on, never the clock
  );
  CREATE TABLE attempts (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL REFERENCES requests (id),
    account_id TEXT NOT NULL,
    dispatch TEXT NOT NULL,                    -- JSON DispatchEvidence: the verdict and grant it ran on
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT,                              -- JSON AttemptOutcome
    event_count INTEGER,
    last_event_at TEXT,
    closed_at TEXT,
    CHECK ((ended_at IS NULL) = (outcome IS NULL))
  );
  CREATE INDEX attempts_open ON attempts (account_id) WHERE ended_at IS NULL;
  CREATE INDEX attempts_request ON attempts (request_id);
  CREATE TABLE clock (last INTEGER NOT NULL);  -- the latest stamp in ms; no stamp is ever below it
  INSERT INTO clock VALUES (-8640000000000000);
  PRAGMA user_version = 1;
`;
const LIMITS = `
  CREATE TABLE IF NOT EXISTS limits (          -- the allowance ledger's job-limit holds, so a restart keeps them
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    bucket TEXT,
    model TEXT,
    observed_at TEXT NOT NULL,
    resets_at TEXT,
    origin TEXT NOT NULL CHECK (origin = 'limit')
  );
`;
const ACCOUNT_HOLDS = `CREATE TABLE IF NOT EXISTS account_holds (
  account_id TEXT PRIMARY KEY, streak INTEGER NOT NULL, hold_ms INTEGER NOT NULL, held_until INTEGER NOT NULL
)`;
const LEASES = `CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, holder TEXT NOT NULL, account_id TEXT NOT NULL, purpose TEXT,
  created_at TEXT NOT NULL, renewed_at TEXT NOT NULL, expires_at INTEGER NOT NULL, released_at TEXT, headroom_at_start REAL, ended TEXT
);
CREATE INDEX IF NOT EXISTS leases_active ON leases (account_id, expires_at) WHERE released_at IS NULL`;
const REVIEWS = `CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`;
export class Store {
  readonly path: string;
  #db: DatabaseSync;
  #admissions: StoreAdmissions;
  #now: () => Date;
  #lastLeaseSweep?: number;
  #retentionAfter = 0;
  #policy: { leaseTickMs: number; maxAttempts: number; backoffMs: number; maxLimits: number; evidenceMaxAgeMs: number; authHoldMs: number; authHoldMaxMs: number };

  constructor(path: string, options: StoreOptions = {}) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    const { leaseTickMs = LEASE_TICK_MS, maxAttempts = 3, retryBackoffMs: backoffMs = 60_000, maxLimits = 20, evidenceMaxAgeMs = 60_000,
      authHoldMs = 300_000, authHoldMaxMs = 1_800_000 } = options;
    if (!Number.isInteger(leaseTickMs) || leaseTickMs < 1) throw new StoreError('leaseTickMs must be positive whole milliseconds');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new StoreError('maxAttempts must be a whole number of at least 1');
    if (!Number.isInteger(maxLimits) || maxLimits < 1) throw new StoreError('maxLimits must be a whole number of at least 1');
    if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > DAY_MS) throw new StoreError('retryBackoffMs must be whole milliseconds, from 0 to one day');
    if (!Number.isInteger(evidenceMaxAgeMs) || evidenceMaxAgeMs <= 0 || evidenceMaxAgeMs > 366 * DAY_MS) throw new StoreError('evidenceMaxAgeMs must be a real duration');
    if (!Number.isInteger(authHoldMs) || authHoldMs < 1 || !Number.isInteger(authHoldMaxMs) || authHoldMaxMs < authHoldMs || authHoldMaxMs > 366 * DAY_MS)
      throw new StoreError('auth hold durations must be positive whole milliseconds with a cap at least as long as the first hold');
    this.#policy = { leaseTickMs, maxAttempts, backoffMs, maxLimits, evidenceMaxAgeMs, authHoldMs, authHoldMaxMs };
    try {
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);   // an existing record, made looser by hand, is owner-only again
    } catch (e) {
      throw new StoreError(`${path} cannot be made an owner-only record: ${String(e)}`, { cause: e });
    }
    this.#db = new DatabaseSync(path);
    this.#admissions = new StoreAdmissions(this.#db, this, () => this.#stamp(), StoreError);
    try {
      this.#db.function('review_setup_failed', { deterministic: true }, b => Number(reviewSetupFailed(JSON.parse(String(b)))));
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF');
      this.#tx(() => {
        const { user_version: version } = this.#db.prepare('PRAGMA user_version').get() as { user_version: number };
        const { n } = this.#db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number };
        if (version === 0 && n === 0) this.#db.exec(SCHEMA);
        else if (version !== 1 && version !== 2 && version !== 3 && version !== 4) throw new StoreError(`${path} is not a version 1, 2, 3 or 4 pipe record (user_version ${version}); it is refused, not guessed at`);
        this.#db.exec(LIMITS);
        if (version < 2) {
          this.#db.exec('ALTER TABLE limits ADD COLUMN resetless INTEGER NOT NULL DEFAULT 0 CHECK (resetless IN (0, 1))');
          this.#db.exec('UPDATE limits SET resetless = 1 WHERE resets_at IS NULL');
        }
        if (!(this.#db.prepare('PRAGMA table_info(limits)').all() as Row[]).some((column) => column.name === 'resetless'))
          throw new StoreError(`${path} has a version-2 limit record without its resetless marker`);
        const badMarker = this.#db.prepare("SELECT 1 FROM limits WHERE typeof(resetless) != 'integer' OR resetless NOT IN (0, 1) OR (resets_at IS NULL AND resetless != 1) LIMIT 1").get();
        if (badMarker) throw new StoreError(`${path} has an invalid resetless marker; it is refused, not guessed at`);
        this.#db.exec(REVIEWS);
        // Each lane's highest round, so retention can prune a lane's reviews without renumbering it (u51); text lanes only, as #insertReview counts.
        const roundsExist = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lane_rounds'").get() !== undefined;
        this.#db.exec('CREATE TABLE IF NOT EXISTS lane_rounds (repository TEXT NOT NULL, lane TEXT NOT NULL, round INTEGER NOT NULL, PRIMARY KEY (repository, lane))');
        if (!roundsExist) this.#db.exec(`INSERT INTO lane_rounds SELECT r, l, max(count(*), coalesce(max(CASE WHEN json_type(b, '$.round') = 'integer' THEN json_extract(b, '$.round') END), 0))
          FROM (SELECT json_extract(b, '$.repository') r, json_extract(b, '$.lane') l, b FROM (SELECT CASE WHEN json_valid(body) THEN body ELSE '{}' END b FROM reviews))
          WHERE json_type(b, '$.repository') = 'text' AND json_type(b, '$.lane') = 'text' GROUP BY r, l`);
        this.#admissions.initialize();
        this.#db.exec(TELEMETRY_INDEXES);
        const holdsExist = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_holds'").get() !== undefined;
        this.#db.exec(ACCOUNT_HOLDS);
        this.#db.exec(LEASES);
        if (!(this.#db.prepare('PRAGMA table_info(leases)').all() as Row[]).some(c => c.name === 'ended')) this.#db.exec("ALTER TABLE leases ADD COLUMN ended TEXT; UPDATE leases SET ended = 'released' WHERE released_at IS NOT NULL");
        if (!holdsExist) this.#restoreAuthHolds();
        if (!(this.#db.prepare('PRAGMA table_info(requests)').all() as Row[]).some((column) => column.name === 'cancelled_by')) this.#db.exec('ALTER TABLE requests ADD COLUMN cancelled_by TEXT');
        if (!(this.#db.prepare('PRAGMA table_info(requests)').all() as Row[]).some((column) => column.name === 'finished_at')) {
          this.#db.exec(`ALTER TABLE requests ADD COLUMN finished_at TEXT;
            UPDATE requests SET finished_at = updated_at WHERE state IN ('completed', 'failed', 'cancelled', 'start_mismatch');
            UPDATE requests SET workspace = json_set(workspace, '$.saved', 'unknown') WHERE state = 'completed' AND workspace IS NOT NULL
              AND json_valid(workspace) AND json_extract(workspace, '$.saved') IS NULL`);
        }
        if (!(this.#db.prepare('PRAGMA table_info(requests)').all() as Row[]).some((column) => column.name === 'change_seq')) {
          this.#db.exec(`ALTER TABLE requests ADD COLUMN change_seq INTEGER;
            UPDATE requests SET change_seq = o.n FROM (SELECT seq, ROW_NUMBER() OVER (ORDER BY updated_at, seq) AS n FROM requests) o
              WHERE o.seq = requests.seq`);
        }
        const attemptColumns = (this.#db.prepare('PRAGMA table_info(attempts)').all() as Row[]).map((column) => column.name);
        if (!attemptColumns.includes('event_count')) this.#db.exec('ALTER TABLE attempts ADD COLUMN event_count INTEGER');
        if (!attemptColumns.includes('last_event_at')) this.#db.exec('ALTER TABLE attempts ADD COLUMN last_event_at TEXT');
        if (!attemptColumns.includes('closed_at')) this.#db.exec('ALTER TABLE attempts ADD COLUMN closed_at TEXT');
        const schema = String(this.#db.prepare("SELECT sql FROM sqlite_master WHERE name = 'requests'").get()!.sql);
        if (!schema.includes("'start_mismatch'")) {
          const sequence = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'requests'").get()?.seq;
          const objects = this.#db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (type = 'trigger' OR type = 'index' AND tbl_name = 'requests')").all();
          for (const o of objects) if (o.type === 'trigger') this.#db.exec(`DROP TRIGGER "${String(o.name).replaceAll('"', '""')}"`);
          this.#db.exec(schema.replace(/^CREATE TABLE (?:requests|"requests")/i, 'CREATE TABLE requests_new').replace("'cancelled')", "'cancelled', 'start_mismatch')"));
          this.#db.exec('INSERT INTO requests_new SELECT * FROM requests; DROP TABLE requests; ALTER TABLE requests_new RENAME TO requests');
          if (sequence !== undefined) this.#db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'requests'").run(sequence);
          for (const o of objects) if (o.name !== 'requests_finished') this.#db.exec(String(o.sql));
        }
        this.#db.exec('DROP TRIGGER IF EXISTS requests_finished');
        if (this.#db.prepare('PRAGMA foreign_key_check').all().length) throw new StoreError('record has broken foreign keys');
        this.#db.exec(FINISHED + ';' + CHANGES + ';' + CLOSED_ONCE);
        const { last } = this.#db.prepare('SELECT last FROM clock').get() as { last: number };
        if (last !== -8640000000000000 && !(last >= FIRST_INSTANT && last <= LAST_INSTANT)) {
          throw new StoreError(`${path} has a clock mark that is not a real time; it is refused, not guessed at`);
        }
        if (version < 2) this.#db.exec('PRAGMA user_version = 2');
      });
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
    } catch (e) {
      this.#db.close();
      throw e instanceof StoreError ? e : new StoreError(`${path} cannot be opened as a pipe record: ${String(e)}`, { cause: e });
    }
  }

  submit(request: NewRequest): RequestRecord {
    const body = checkRequest(request);
    if (body.expectedStartCommit !== undefined) throw new StoreError('expectedStartCommit requires asynchronous Store.submitChecked validation');
    return this.#tx(() => this.#admissions.submit(body));
  }

  async submitChecked(request: NewRequest, env = process.env, brief = request.prompt): Promise<RequestRecord> {
    const body = checkRequest(JSON.parse(JSON.stringify(request)));
    const identity = admission(body, [body.provider], brief);
    if (Object.hasOwn(request, 'startSource')) throw new StoreError('saved source proof is internal');
    const row = identity.key === undefined ? undefined : this.#db.prepare("SELECT * FROM admissions WHERE namespace = 'request' AND admission_key = ?").get(identity.key);
    if (body.expectedStartCommit === undefined || row && this.#admissions.reusable('request', row)) return this.#tx(() => this.#admissions.submit(body, undefined, identity));
    for (const r of this.finishedWorkspaces()) {
      if (r.workspace?.commit !== body.expectedStartCommit) continue;
      let proof: SavedStart;
      try {
        const source = this.savedStartSource(r.id);
        proof = await inspectSavedStart(body.cwd!, body.expectedStartCommit, source, env);
        if (JSON.stringify(sourceReceipt(this.savedStartSource(r.id))) !== JSON.stringify(sourceReceipt(source))) continue;
      } catch { continue; /* An uncertain or foreign receipt cannot authorize a base. */ }
      return this.#tx(() => this.#admissions.submit(body, proof, identity));
    }
    throw new StoreError('expectedStartCommit has no current owned saved source in the cwd repository');
  }

  savedStartSource(id: string): RequestRecord | undefined {
    const r = this.get(id), attempts = this.attempts(id), last = attempts.at(-1), w = r?.workspace;
    if (!w || !last?.closedAt || !last.endedAt || attempts.some(a => !a.endedAt) || last.outcome?.kind !== 'completed') return undefined;
    const made = last.outcome.workspace;
    return made && made.path === w.path && made.branch === w.branch && made.startCommit === w.startCommit ? r : undefined;
  }

  submitReviewSeat(reviewId: string, request: NewRequest, seat: Record<string, unknown>): RequestRecord {
    const body = checkRequest(request);
    return this.#tx(() => this.#admissions.submitReviewSeat(reviewId, body, seat));
  }

  insertReview(id: string, state: string, body: object): void {
    if (this.#db.isTransaction) return this.#insertReview(id, state, body);
    this.#tx(() => this.#insertReview(id, state, body));
  }
  #insertReview(id: string, state: string, body: object): void {
    const at = this.#stamp();
    const r = body as { repository?: string; lane?: string | null };
    const round = r.lane == null ? null : 1 + Number(this.#db.prepare(`SELECT max(count(*), coalesce((SELECT round FROM lane_rounds
        WHERE repository = ? AND lane = ?), 0)) n FROM reviews WHERE json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.repository') = ?
        AND json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.lane') = ?`).get(r.repository ?? null, r.lane, r.repository ?? null, r.lane)?.n);
    if (round !== null && r.repository != null) this.#db.prepare('INSERT INTO lane_rounds VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET round = max(round, excluded.round)').run(r.repository, String(r.lane), round);
    this.#db.prepare('INSERT INTO reviews (id, state, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, state, JSON.stringify({ ...body, round }), at, at);
  }

  hasReviewAdmission(identity: Admission): boolean { return this.#admissions.hasReviewAdmission(identity); }
  releaseReview(id: string): boolean { return this.#tx(() => this.#admissions.releaseReview(id)); }
  admitReview(id: string, body: object, identity: Admission, held: boolean, canAdmit = () => true): { id: string; prepare: boolean; repeated: boolean } {
    return this.#tx(() => this.#admissions.admitReview(id, body, identity, held, canAdmit));
  }

  updateReview(id: string, state: string, body: object): void { this.#tx(() => {
    const at = this.#stamp(), original = this.review(id);
    this.#db.prepare('UPDATE reviews SET state = ?, body = ?, updated_at = ? WHERE id = ?').run(state,
      JSON.stringify({ ...body, ...(original?.admissionKey ? { admissionKey: original.admissionKey, dispatchClass: original.dispatchClass,
        ...(original.predecessorId ? { predecessorId: original.predecessorId } : {}) } : {}),
        ...(state === 'finished' ? { finishedAt: original?.finishedAt ?? at } : {}) }), at, id);
  }); }
  updateReviewIfClockCurrent(id: string, state: string, body: object): void {
    this.#tx(() => {
      const ms = this.#now().getTime(), last = (this.#db.prepare('SELECT last FROM clock').get() as { last: number }).last;
      if (!Number.isFinite(ms) || ms < FIRST_INSTANT || ms > LAST_INSTANT || ms < last) throw new StoreError('pipe clock is not current; review vote was not saved');
      this.#db.prepare('UPDATE reviews SET state = ?, body = ?, updated_at = ? WHERE id = ?').run(state, JSON.stringify(body), this.#stampAndNow(ms).at, id);
    });
  }

  review(id: string): Record<string, unknown> | undefined {
    const row = this.#db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Row | undefined;
    return row ? { ...JSON.parse(String(row.body)) as Record<string, unknown>, id: row.id, state: row.state,
      createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }
  runningReviewIds(): string[] {
    return (this.#db.prepare("SELECT id FROM reviews WHERE state = 'running'").all() as Row[]).map((row) => String(row.id));
  }

  runningReviews(): Record<string, unknown>[] {
    return this.runningReviewIds().map((id) => this.review(id)!).filter(Boolean);
  }

  heldReviews(requester?: string): Record<string, unknown>[] { return this.#admissions.heldReviews(requester); }

  stats(since: string) {
    if (!validSince(since)) throw new StoreError('since must be a valid YYYY-MM-DD date');
    return dailyStats(this.#db, since, this.#now());
  }

  get(id: string): RequestRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return row && this.#read(row);
  }
  list(state?: string, requester?: string): RequestRecord[] {
    if (state !== undefined && !['queued', 'running', 'completed', 'failed', 'cancelled', 'start_mismatch'].includes(state)) return [];
    const rows = this.#db.prepare('SELECT * FROM requests WHERE (? IS NULL OR state = ?) AND (? IS NULL OR requester = ?) ORDER BY seq DESC LIMIT 500')
      .all(state ?? null, state ?? null, requester ?? null, requester ?? null) as Row[];
    return rows.flatMap((row) => this.#read(row) ?? []);
  }

  openRequests(): RequestRecord[] {
    const rows = this.#db.prepare(`SELECT * FROM requests r WHERE state IN ('queued', 'running')
      OR EXISTS (SELECT 1 FROM attempts a WHERE a.request_id = r.id AND a.ended_at IS NULL) ORDER BY seq`).all() as Row[];
    return rows.flatMap((row) => this.#read(row) ?? []);
  }
  changedAfter(after: number, limit: number): { requests: RequestRecord[]; next: { after: number } | null } {
    const rows = this.#db.prepare('SELECT * FROM requests WHERE change_seq > ? ORDER BY change_seq LIMIT ?').all(after, limit) as Row[];
    const last = rows.at(-1);
    return { requests: rows.flatMap((row) => this.#read(row) ?? []), next: last ? { after: Number(last.change_seq) } : null };
  }

  waitingRequests(): RequestRecord[] {
    const rows = this.#db.prepare("SELECT * FROM requests WHERE state = 'queued' ORDER BY seq").all() as Row[];
    return rows.flatMap((row) => this.#read(row) ?? []);
  }

  finishedWorkspaces(): RequestRecord[] {
    const rows = this.#db.prepare(`SELECT * FROM requests r WHERE state IN ('completed', 'failed', 'cancelled', 'start_mismatch')
      AND workspace IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.request_id = r.id AND a.ended_at IS NULL)
      ORDER BY seq`).all() as Row[];
    return rows.flatMap((row) => this.#read(row) ?? []);
  }
  recordWorkspaceCommit(id: string, commit: string, saved?: boolean, diff?: WorkspaceDiff): boolean {
    if (!commitHash(commit)) throw new StoreError('workspace commit must be a 40- or 64-character hash');
    return this.#tx(() => {
      const request = this.get(id);
      if (!request || !['completed', 'failed', 'cancelled', 'start_mismatch'].includes(request.state) || !request.workspace) return false;
      const before = request.workspace.saved;
      const origin = request.workspace.startCommit ?? (commitHash(request.workspace.commit) ? request.workspace.commit : undefined);
      const state = saved === undefined ? before : saved || before === 'saved' ? 'saved'
        : !origin || (!request.workspace.startCommit && (before === 'unknown' || before === 'not_saved')) ? 'unknown'
        : commit === origin ? 'no_changes' : 'saved';
      const workspace: Workspace = { ...request.workspace, commit, ...(state === undefined ? {} : { saved: state }) };
      if (commit !== request.workspace.commit) delete workspace.diff;
      if (state === 'no_changes') workspace.diff = { files: 0, insertions: 0, deletions: 0 };
      else if (state === 'saved' && validDiff(diff)) workspace.diff = { files: diff.files, insertions: diff.insertions, deletions: diff.deletions };
      return changed(this.#db.prepare(`UPDATE requests SET workspace = ? WHERE id = ? AND state IN ('completed', 'failed', 'cancelled', 'start_mismatch')
        AND NOT EXISTS (SELECT 1 FROM attempts WHERE request_id = ? AND ended_at IS NULL)`)
        .run(JSON.stringify(workspace), id, id));
    });
  }
  noteWorkspaceHousekeeping(id: string, fields: Pick<Workspace, 'saveDelays' | 'lastAttemptAt' | 'saveFailures' | 'unsaveable' | 'excludedPaths' | 'saveRetryAt' | 'removing' | 'removingAt' | 'removedAt' | 'housekeepingKind' | 'housekeepingFingerprint'>): boolean {
    return this.#tx(() => {
      const r = this.get(id);
      if (!r?.workspace || !['completed', 'failed', 'cancelled', 'start_mismatch'].includes(r.state)) return false;
      const workspace = { ...r.workspace, ...fields };
      if (!fits(workspace, WORKSPACE)) throw new StoreError('invalid housekeeping receipt');
      return changed(this.#db.prepare(`UPDATE requests SET workspace = ? WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM attempts WHERE request_id = ? AND ended_at IS NULL)`).run(JSON.stringify(workspace), id, id));
    });
  }
  resetWorkspaceHousekeeping(id: string): boolean {
    return this.noteWorkspaceHousekeeping(id, { unsaveable: false, saveFailures: 0, saveDelays: 0, saveRetryAt: '', housekeepingKind: '', housekeepingFingerprint: '' });
  }
  noteWorkspaceNotSaved(id: string): boolean {
    return this.#tx(() => {
      const request = this.get(id);
      if (!request || !['completed', 'failed', 'cancelled', 'start_mismatch'].includes(request.state) || !request.workspace || request.workspace.saved !== undefined) return false;
      return changed(this.#db.prepare(`UPDATE requests SET workspace = ? WHERE id = ? AND state IN ('completed', 'failed', 'cancelled', 'start_mismatch')
        AND NOT EXISTS (SELECT 1 FROM attempts WHERE request_id = ? AND ended_at IS NULL)`)
        .run(JSON.stringify({ ...request.workspace, saved: 'not_saved' }), id, id));
    });
  }
  runningCount(accountId: string): number {
    const { n } = this.#db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE account_id = ? AND ended_at IS NULL').get(accountId) as { n: number };
    return n;
  }
  takeLease(account: AccountConfig, input: { holder: unknown; ttlSeconds: unknown; purpose?: unknown; headroomAtStart?: number | null }): Lease {
    if (!account.enabled) throw leaseError(400, 'invalid_request', 'account must be configured and enabled');
    if (typeof input.holder !== 'string' || !/^[A-Za-z0-9 ._:@()/-]{1,80}$/.test(input.holder)) throw leaseError(400, 'invalid_request', 'holder must be 1 to 80 permitted ASCII characters');
    if (!validLeaseTtl(input.ttlSeconds)) throw leaseError(400, 'invalid_request', 'ttlSeconds must be an integer from 60 to 3600');
    if (input.ttlSeconds * 1000 < 3 * this.#policy.leaseTickMs) throw leaseError(400, 'invalid_request', 'ttlSeconds must be at least 3 ticks');
    if (input.purpose !== undefined && (typeof input.purpose !== 'string' || [...input.purpose].length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.purpose)))
      throw leaseError(400, 'invalid_request', 'purpose must be at most 200 code points without controls, format characters or lone surrogates');
    const { holder, ttlSeconds, purpose } = input;
    return this.#tx(() => {
      const now = this.#leaseNow(true), at = new Date(now).toISOString();
      const leased = this.activeLeaseCount(account.id, new Date(now));
      if (leased >= account.maxConcurrency - 1) throw leaseError(409, 'lease_limit', 'at least one account slot must remain for pipe jobs');
      if (this.runningCount(account.id) + leased + 1 > account.maxConcurrency) throw leaseError(409, 'account_full', 'account has no free concurrency slot');
      if (now + ttlSeconds * 1000 > LAST_INSTANT) throw leaseError(400, 'invalid_request', 'lease expiry is outside valid instants');
      const room = input.headroomAtStart, headroom = typeof room === 'number' && Number.isFinite(room) && room >= 0 && room <= 1 ? room : null;
      return toLease(this.#db.prepare('INSERT INTO leases (id, holder, account_id, purpose, created_at, renewed_at, expires_at, headroom_at_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .get(randomUUID(), holder, account.id, typeof purpose === 'string' ? purpose : null, at, at, now + ttlSeconds * 1000, headroom) as Row);
    });
  }
  renewLease(id: string, ttlSeconds: unknown, accountFor?: (id: string) => AccountConfig | undefined): Lease | undefined {
    if (!validLeaseTtl(ttlSeconds)) throw leaseError(400, 'invalid_request', 'ttlSeconds must be an integer from 60 to 3600');
    if (ttlSeconds * 1000 < 3 * this.#policy.leaseTickMs) throw leaseError(400, 'invalid_request', 'ttlSeconds must be at least 3 ticks');
    const lease = this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as Row | undefined;
      if (!row) return undefined;
      const now = this.#leaseNow(true);
      if (now < Date.parse(String(row.renewed_at))) throw leaseError(503, 'clock_unavailable', 'pipe clock is behind the lease renewal');
      if (row.released_at !== null || now > Number(row.expires_at) - this.#policy.leaseTickMs) return null;   // commit the expiry observation's clock before refusing
      const account = accountFor?.(String(row.account_id));
      if (accountFor && (!account?.enabled || account.id !== row.account_id || this.activeLeaseCount(account.id, new Date(now)) > account.maxConcurrency - 1)) throw leaseError(409, 'account_unavailable', 'account is disabled or exceeds its lease cap');
      if (now + ttlSeconds * 1000 > LAST_INSTANT) throw leaseError(400, 'invalid_request', 'lease expiry is outside valid instants');
      return toLease(this.#db.prepare('UPDATE leases SET renewed_at = ?, expires_at = ? WHERE id = ? RETURNING *').get(new Date(now).toISOString(), now + ttlSeconds * 1000, id) as Row);
    });
    if (lease === null) throw leaseError(410, 'lease_inactive', 'lease renewal window is closed; take a new lease');
    return lease;
  }
  releaseLease(id: string): Lease | undefined {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as Row | undefined;
      if (!row) return undefined;
      if (row.released_at !== null && row.ended !== 'expired') return toLease(row);
      return toLease(this.#db.prepare("UPDATE leases SET released_at = ?, ended = 'released' WHERE id = ? RETURNING *").get(new Date(this.#leaseNow()).toISOString(), id) as Row);
    });
  }
  activeLeases(accountId?: string, at = this.#now()): Lease[] {
    const now = this.clockIsCurrent(at) ? at.getTime() : Number.NEGATIVE_INFINITY;
    return (this.#db.prepare('SELECT * FROM leases WHERE released_at IS NULL AND expires_at > ?' + (accountId === undefined ? '' : ' AND account_id = ?') + ' ORDER BY created_at, id')
      .all(...(accountId === undefined ? [now] : [now, accountId])) as Row[]).map(toLease);
  }
  activeLeaseCount(accountId: string, at = this.#now()): number {
    const now = this.clockIsCurrent(at) ? at.getTime() : Number(this.#db.prepare('SELECT last FROM clock').get()!.last);
    return Number(this.#db.prepare("SELECT COUNT(*) AS n FROM leases WHERE account_id = ? AND (released_at IS NULL OR ended = 'expired' AND expires_at + ? > ?)").get(accountId, LEASE_GRACE_MS, now)!.n);
  }
  sweepExpiredLeases(): void { this.#lastLeaseSweep = this.#tx(() => {
      // Publish the heartbeat only after the sweep transaction commits, including empty sweeps.
      const now = this.#leaseNow();
      this.#db.prepare("UPDATE leases SET released_at = ?, ended = 'expired' WHERE released_at IS NULL AND expires_at <= ?").run(new Date(now).toISOString(), now);
      return now;
    });
  }
  pruneLeases(): void {
    const before = this.#leaseNow() - 7 * DAY_MS;
    this.#db.prepare('DELETE FROM leases WHERE expires_at <= ? OR released_at IS NOT NULL AND released_at <= ?').run(before, new Date(before).toISOString());
  }
  /** Ended records older than `days` (src/retention.ts), from one clock sample; one behind the high-water mark deletes nothing. */
  pruneEndedRecords(days: number, tmpRoot: string): { requests: number; reviews: number; unreadable?: boolean } {
    const { next = this.#retentionAfter, ...pruned } = this.#tx((): ReturnType<typeof pruneEnded> | { requests: number; reviews: number; next?: number } => {
      const at = this.#now();
      return this.clockIsCurrent(at) ? pruneEnded(this.#db, new Date(at.getTime() - days * DAY_MS).toISOString(), tmpRoot, this.#retentionAfter) : { requests: 0, reviews: 0 };
    });
    this.#retentionAfter = next;   // only once the deletes are committed
    return pruned;
  }
  #leaseNow(heartbeat = false, at = this.#now()): number {
    if (!this.clockIsCurrent(at)) throw leaseError(503, 'clock_unavailable', 'pipe clock is not current');
    if (heartbeat && (this.#lastLeaseSweep === undefined || at.getTime() - this.#lastLeaseSweep > Math.max(LEASE_HEARTBEAT_MAX_AGE_MS, 2 * this.#policy.leaseTickMs)))
      throw leaseError(503, 'clock_unavailable', 'pipe lease heartbeat is unavailable');
    return Date.parse(this.#stampAndNow(at.getTime()).at);
  }
  requesterLoad(): Map<string, RequesterLoad> {
    const rows = this.#db.prepare(`
      SELECT r.requester AS who, SUM(a.ended_at IS NULL) AS running, MAX(a.started_at) AS last
      FROM attempts a JOIN requests r ON r.id = a.request_id GROUP BY r.requester`).all() as Row[];
    return new Map(rows.map((row) => [String(row.who), { running: Number(row.running), lastDispatchedAt: String(row.last) }]));
  }

  attempts(requestId: string): Attempt[] { return (this.#db.prepare('SELECT * FROM attempts WHERE request_id = ? ORDER BY seq').all(requestId) as Row[]).map(toAttempt); }
  requestStatus(id: string, includeRequest = false) {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
      if (!row) return undefined;
      const r = toRecord(row);
      const attempts = (this.#db.prepare('SELECT * FROM attempts WHERE request_id = ? ORDER BY seq').all(id) as Row[]).map((row) => {
        let d: DispatchEvidence; try { const raw = JSON.parse(String(row.dispatch)); d = isObject(raw) ? raw as DispatchEvidence : {} as DispatchEvidence; } catch { d = {} as DispatchEvidence; }
        const a = { id: String(row.id), accountId: String(row.account_id), startedAt: String(row.started_at), reportedModel: (d as DispatchEvidence & { reportedModel?: unknown }).reportedModel };
        const route = r.automatic ? d.route : r;
        const routeOK = route && (r.automatic ? [r, r.automatic.fallback].some(b => b.provider === route.provider && b.model === route.model && b.effort === route.effort && b.reason === route.reason) : true);
        const s = d.allowance;
        const bound = routeOK && d.accountId === a.accountId && d.model === route?.model;
        const valid = bound && s?.provenance === 'claim_verdict' && (s.observedAt === null || r.automatic && s.observedAt === d.allowanceObservedAt && instantOf(s.observedAt) !== null && Date.parse(s.observedAt) <= Date.parse(s.evaluatedAt)) &&
          (s.basis === 'ordinary' || s.basis === 'credits') && typeof s.headroom === 'number' && s.headroom >= 0 && s.headroom <= 1 &&
          d.verdict?.state === 'available' && s.headroom === d.verdict.headroom && s.basis === (d.verdict.via ?? 'ordinary') &&
          instantOf(s.evaluatedAt) !== null && s.evaluatedAt === d.observedAt && Date.parse(s.evaluatedAt) <= Date.parse(a.startedAt);
        return { attemptId: a.id, accountId: a.accountId, provider: bound ? route!.provider : null, requestedModel: bound ? route!.model : null, ...(r.automatic ? { effort: bound ? route!.effort : null, endedAt: row.ended_at ?? null, retrySafe: (() => { try { const o = JSON.parse(String(row.outcome)); return retrySafe(o); } catch { return false; } })() } : {}),
          reportedModel: typeof a.reportedModel === 'string' && a.reportedModel.trim() ? a.reportedModel : null, selectedAt: a.startedAt,
          allowance: valid ? { provenance: s.provenance, headroom: s.headroom, basis: s.basis, evaluatedAt: s.evaluatedAt, observedAt: s.observedAt, ...(r.automatic ? { source: s.source === d.allowanceSource && (s.source === 'verified' || s.source === 'cache') ? s.source : null } : {}) } : null };
      });
      return { id: r.id, state: r.state, selection: r.state === 'queued' || r.error?.kind.startsWith('admission_') || r.error?.kind === 'review_reserve' ? null : attempts.at(-1) ?? null, attempts, ...(r.automatic ? { ...(includeRequest ? { request: r } : {}), contract: 'pipe-auto-v1', automatic: { fallback: { provider: 'claude', model: 'opus', effort: 'high' }, reviewReserve: r.automatic.reviewReserve }, refusal: r.error && (r.error.kind.startsWith('admission_') || r.error.kind === 'review_reserve') ? { kind: r.error.kind, resetAt: r.error.resetAt ?? null } : null } : {}) };
    }, false);
  }

  authHoldUntil(accountId: string): number { return (this.#db.prepare('SELECT held_until FROM account_holds WHERE account_id = ?').get(accountId) as { held_until: number } | undefined)?.held_until ?? 0; }

  openAttempts(): Attempt[] { return (this.#db.prepare('SELECT * FROM attempts WHERE ended_at IS NULL ORDER BY seq').all() as Row[]).map(toAttempt); }

  isAttemptRecorded(id: string): boolean { return (this.#db.prepare('SELECT ended_at FROM attempts WHERE id = ?').get(id) as { ended_at: string | null } | undefined)?.ended_at != null; }
  tempCleanupStates(): Map<string, { protected: boolean; runner: RunnerIdentity | null }> {
    const rows = this.#db.prepare("SELECT a.id, a.ended_at, r.state, json_extract(a.dispatch, '$.runner') AS runner, json_type(a.dispatch, '$.runner') AS runner_type FROM attempts a LEFT JOIN requests r ON r.id = a.request_id").all() as Row[];
    return new Map(rows.map((row) => { const runner = row.runner === null ? null : JSON.parse(String(row.runner)) as RunnerIdentity;
      if (typeof row.id !== 'string' || !row.id || (row.ended_at !== null && typeof row.ended_at !== 'string') || (row.runner_type !== null && row.runner_type !== 'object') || (runner !== null && (!Number.isSafeInteger(runner?.pid) || runner.pid <= 0 || typeof runner.startedAt !== 'string' || !runner.startedAt)))
        throw new StoreError('attempt cleanup state is unreadable');
      return [row.id, { protected: row.ended_at === null || !['completed', 'failed', 'cancelled', 'start_mismatch'].includes(String(row.state)) || runner === null, runner }];
    }));
  }
  clockIsCurrent(at = this.#now()): boolean { const now = at.getTime(); return Number.isFinite(now) && now >= FIRST_INSTANT && now <= LAST_INSTANT && now >= (this.#db.prepare('SELECT last FROM clock').get() as { last: number }).last; }
  recoveryAttempts(): Attempt[] {
    return (this.#db.prepare('SELECT * FROM attempts WHERE ended_at IS NULL ORDER BY seq').all() as Row[]).map((row) => {
      try { return toAttempt(row); }
      catch { return { id: String(row.id), requestId: String(row.request_id), accountId: String(row.account_id),
        dispatch: null as unknown as DispatchEvidence, startedAt: String(row.started_at), endedAt: null,
        outcome: null, runner: null, reportedModel: null, events: null,
        closedAt: row.closed_at === null || row.closed_at === undefined ? null : String(row.closed_at) }; }
    });
  }

  setWaiting(id: string, wait: Wait): boolean {
    if (!fits(wait, WAIT)) throw new StoreError('a wait must be { reason, until, stoppedSince? }');
    return this.#swap("UPDATE requests SET waiting = ?, updated_at = ? WHERE id = ? AND state = 'queued'", JSON.stringify(pick(wait, WAIT)), id);
  }

  cancel(id: string, reason = 'cancelled by the requester', by?: string): boolean {
    if (by !== undefined && !filled(by)) throw new StoreError('a cancellation actor must be a non-empty name');
    const error = JSON.stringify({ kind: 'cancelled', message: text(reason, 'a cancel reason') });
    return this.#tx(() => changed(this.#db.prepare("UPDATE requests SET state = 'cancelled', waiting = NULL, error = ?, cancelled_by = COALESCE(?, requester), updated_at = ? WHERE id = ? AND state IN ('queued', 'running')")
      .run(error, by ?? null, this.#stamp(), id)));
  }

  fail(id: string, message: string): boolean {
    const error = JSON.stringify({ kind: 'unroutable', message: text(message, 'a failure message') });
    return this.#swap("UPDATE requests SET state = 'failed', waiting = NULL, error = ?, updated_at = ? WHERE id = ? AND state = 'queued'", error, id);
  }

  startAttempt(requestId: string, account: AccountConfig, dispatch: DispatchEvidence): Start {
    return this.#tx(() => this.get(requestId)?.automatic ? { ok: false, reason: 'automatic route requires atomic admission' } : this.#startAttempt(requestId, account, dispatch));
  }

  startGeminiChatAttempt(requestId: string, account: AccountConfig, host?: string | null): Start {
    return this.#tx(() => {
      const r = this.get(requestId);
      if (!r || r.provider !== 'gemini' || !geminiReadOnly(r) || r.automatic || r.placement)
        return { ok: false, reason: 'Gemini chat requires tool-free admission without headroom placement' };
      if (!this.clockIsCurrent()) return { ok: false, reason: 'pipe clock is not current' };
      if (this.openAttempts().some(a => this.get(a.requestId)?.provider === 'gemini')) return { ok: false, reason: 'AGY turn is busy' };
      if (this.limits().some(l => l.accountId === account.id)) return { ok: false, reason: 'AGY quota hold requires operator allowance recovery' };
      return this.#startAttempt(requestId, account, { accountId: account.id, host, model: r.model,
        observedAt: this.#now().toISOString(), verdict: { state: 'unknown', reason: 'AGY allowance is unmeasured' }, grant: [] }, [], true);
    });
  }

  #startAttempt(requestId: string, account: AccountConfig, dispatch: DispatchEvidence, prerequisites: Array<{ id: string; evidence: Evidence }> = [], geminiChat = false): Start {
      const { at, now } = this.#stampAndNow();
      const r = this.get(requestId);
      if (r?.state === 'queued' && r.cwd !== undefined && !directory(r.cwd)) {
        const reason = `cwd ${r.cwd} is no longer an existing directory`;
        this.#db.prepare("UPDATE requests SET state = 'failed', waiting = NULL, error = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
          .run(JSON.stringify({ kind: 'unroutable', message: reason }), at, requestId);
        return { ok: false, reason };
      }
      const route = r?.automatic ? dispatch.route : r;
      const id = account.id;
      const leased = this.activeLeaseCount(id, new Date(now)), open = this.runningCount(id) + leased;
      const seen = instantOf(dispatch?.observedAt) ?? Number.NaN;
      const measured = instantOf(dispatch?.allowanceObservedAt);
      const refusal =
        !r ? `no readable request ${requestId}`
        : r.state !== 'queued' ? `request ${requestId} is ${r.state}, not queued`
        : r.automatic && !this.clockIsCurrent(new Date(now)) ? 'automatic claim clock stepped back'
        : r.automatic && route?.provider !== r.provider && (!prerequisites.length || prerequisites.some(p => !ordinaryExhausted(p.evidence, p.id, r.model, now, this.#policy.evidenceMaxAgeMs))) ? 'primary exhaustion proof expired or changed at claim'
        : r.automatic && (measured === null || measured > now || now - measured > this.#policy.evidenceMaxAgeMs) ? 'automatic allowance observation is unknown or stale'
        : account.provider !== route?.provider ? `${id} is a ${account.provider} account; the request is for ${r.provider}`
        : account.enabled !== true ? `${id} is disabled in config`
        : r.avoid.includes(id) ? `${id} already failed this request`
        : now < this.authHoldUntil(id) ? `${id} has an active sign-in hold`
        : r.exclude?.includes(id) ? `${id} is excluded by this request`
        : r.pin !== undefined && r.pin !== id ? `the request is pinned to ${r.pin}, not ${id}`
        : r.notBefore !== null && now < (instantOf(r.notBefore) ?? Number.POSITIVE_INFINITY) ? `the request backs off until ${r.notBefore}`
        : !(open < account.maxConcurrency) ? `${id} is full: ${open} of ${account.maxConcurrency} attempts are open${leased ? ` (${leased} leased)` : ''}`
        : dispatch?.accountId !== id ? `the dispatch evidence names ${String(dispatch?.accountId)}, not ${id}`
        : dispatch.model !== route?.model ? `the dispatch evidence is for model ${String(dispatch.model)}, not ${r.model}`
        : !geminiChat && dispatch.verdict?.state !== 'available' ? `the verdict for ${id} is ${String(dispatch.verdict?.state)}, not available`
        : !geminiChat && !(typeof (dispatch.verdict as { headroom?: number }).headroom === 'number' && (dispatch.verdict as { headroom: number }).headroom >= 0 && (dispatch.verdict as { headroom: number }).headroom <= 1) ? `the verdict for ${id} has no valid headroom`
        : r.automatic && account.provider === 'claude' && (dispatch.verdict as { headroom: number }).headroom <= r.automatic.reviewReserve ? 'Claude review reserve floor reached at claim'
        : r.placement === 'ordinary_headroom' && !ordinaryRoom(dispatch.verdict) ? `${id} has no ordinary subscription room`
        : !(seen <= now) ? `the evidence for ${id} has no valid time, or is later than the clock`
        : now - seen > this.#policy.evidenceMaxAgeMs ? `the evidence for ${id} is stale`
        : !Array.isArray(dispatch.grant) || !dispatch.grant.every(isText) ? 'the dispatch evidence has no tool grant'
        : null;
      if (refusal !== null) return { ok: false, reason: refusal };
      const v = dispatch.verdict as Extract<Availability, { state: 'available' }>;
      const evidence: DispatchEvidence = { accountId: id, ...(dispatch.host === undefined ? {} : { host: hostAlias(dispatch.host) }), model: dispatch.model, observedAt: dispatch.observedAt, verdict: geminiChat ? { state: 'unknown', reason: 'AGY allowance is unmeasured' } : { state: 'available', headroom: v.headroom, ...(v.via === 'credits' ? { via: v.via } : {}) }, grant: [...dispatch.grant], ...(r!.automatic ? { route: dispatch.route, allowanceObservedAt: dispatch.allowanceObservedAt, allowanceSource: dispatch.allowanceSource } : {}) };
      if (!geminiChat && (v.via === undefined || v.via === 'credits')) evidence.allowance = { provenance: 'claim_verdict', headroom: v.headroom, basis: v.via ?? 'ordinary', evaluatedAt: dispatch.observedAt, observedAt: r!.automatic ? dispatch.allowanceObservedAt ?? null : null, ...(r!.automatic ? { source: dispatch.allowanceSource ?? null } : {}) };
      const attempt: Attempt = { id: randomUUID(), requestId, accountId: id, dispatch: evidence, startedAt: at, endedAt: null, outcome: null, runner: null, reportedModel: null, events: null, closedAt: null };
      this.#db.prepare('INSERT INTO attempts (id, request_id, account_id, dispatch, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(attempt.id, requestId, id, JSON.stringify({ ...evidence, preSpawn: true }), at);
      this.#db.prepare("UPDATE requests SET state = 'running', waiting = NULL, not_before = NULL, updated_at = ? WHERE id = ? AND state = 'queued'")
        .run(at, requestId);
      return { ok: true, attempt };
  }

  startAutomatic(id: string, accounts: readonly AccountStatus[], policy: Policy, grant: string[]): Start {
    return this.#tx(() => {
      const r = this.get(id); if (!r?.automatic || r.state !== 'queued') return { ok: false, reason: 'no queued automatic request' };
      const now = this.#now();
      const refuse = (kind: RequestError['kind'], message: string, resetAt: string | null = null): Start => {
        this.#db.prepare("UPDATE requests SET state = 'failed', waiting = NULL, error = ?, updated_at = ? WHERE id = ? AND state = 'queued'")
          .run(JSON.stringify({ kind, message, resetAt }), this.#stamp(), id);
        return { ok: false, reason: message };
      };
      if (!this.clockIsCurrent(now) || ![r, r.automatic.fallback].every(b => checkChoice(policy, b).ok)) return refuse('admission_unknown', 'automatic admission requires a current clock and both policy-authorized routes');
      const history = this.attempts(id);
      if (history.some((a, i) => !retrySafe(a.outcome) || instantOf(a.endedAt) === null || instantOf(a.startedAt) === null ||
        Date.parse(a.endedAt!) < Date.parse(a.startedAt) || Date.parse(a.endedAt!) > (i + 1 < history.length ? Date.parse(history[i + 1]!.startedAt) : now.getTime())))
        return refuse('admission_unknown', 'automatic retry lacks ordered safe completion proof');
      const current = accounts.map(a => ({ ...a, running: this.runningCount(a.account.id), leased: this.activeLeaseCount(a.account.id, now), evidence: (model: string) => this.#now().getTime() < this.authHoldUntil(a.account.id)
        ? { accountId: a.account.id, model, observedAt: now.toISOString(), verdict: { state: 'unknown' as const, reason: 'sign-in hold' } } : a.evidence(model) }));
      const decision = plan([r], current, { now, pinWaitMs: 0, evidenceMaxAgeMs: this.#policy.evidenceMaxAgeMs, load: new Map() });
      const d = decision.dispatch[0];
      if (!d) { const f = decision.fail[0]; return refuse(f?.code ?? 'admission_unknown', f?.reason ?? 'automatic admission unknown', f?.until ?? null); }
      const a = current.find(a => a.account.id === d.accountId)!;
      const evidence = a.evidence(d.route!.model);
      const prerequisites = d.route!.provider === r.provider ? [] : current.filter(a => a.account.provider === r.provider && a.account.enabled === true && !r.exclude?.includes(a.account.id)).map(a => ({ id: a.account.id, evidence: a.evidence(r.model) }));
      const started = this.#startAttempt(id, a.account, { ...evidence, route: d.route, grant }, prerequisites);
      return started.ok ? started : refuse(started.reason === 'Claude review reserve floor reached at claim' ? 'review_reserve' : 'admission_unknown', started.reason);
    });
  }
  noteReserveStop(attemptId: string): void {
    this.#tx(() => { this.#db.prepare("UPDATE attempts SET dispatch = json_set(dispatch, '$.reserveStopped', json('true')) WHERE id = ? AND ended_at IS NULL").run(attemptId); });
  }

  noteMayStart(attemptId: string, gemini = false): void {
    this.#tx(() => {
      const row = this.#db.prepare('SELECT dispatch FROM attempts WHERE id = ? AND ended_at IS NULL').get(attemptId) as Row | undefined;
      if (!row) throw new StoreError(`no open attempt ${attemptId}`);
      const dispatch = JSON.parse(String(row.dispatch)) as DispatchEvidence;
      this.#db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify({ ...dispatch, preSpawn: false, ...(gemini ? { geminiUnresolved: true } : {}) }), attemptId);
    });
  }

  noteRunner(attemptId: string, runner: RunnerIdentity): void {
    if (!Number.isSafeInteger(runner.pid) || runner.pid <= 0 || !runner.startedAt) throw new StoreError('runner needs a PID and start time');
    this.#tx(() => {
      const row = this.#db.prepare('SELECT dispatch FROM attempts WHERE id = ? AND ended_at IS NULL').get(attemptId) as Row | undefined;
      if (!row) throw new StoreError(`no open attempt ${attemptId}`);
      const dispatch = JSON.parse(String(row.dispatch)) as DispatchEvidence & { runner?: RunnerIdentity };
      if (dispatch.runner) throw new StoreError(`attempt ${attemptId} already has a runner`);
      this.#db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify({ ...dispatch, preSpawn: false, runner }), attemptId);
    });
  }

  noteGeminiSupervisor(attemptId: string, owner: RunnerIdentity): void {
    this.#tx(() => {
      const row = this.#db.prepare('SELECT dispatch FROM attempts WHERE id = ? AND ended_at IS NULL').get(attemptId) as Row | undefined;
      if (!row || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.startedAt) throw new StoreError('AGY supervisor proof is missing');
      const dispatch = JSON.parse(String(row.dispatch));
      this.#db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify({ ...dispatch, preSpawn: false, geminiSupervisor: owner, geminiUnresolved: false }), attemptId);
    });
  }

  noteModel(attemptId: string, reportedModel: string | null): void {
    this.#tx(() => {
      const row = this.#db.prepare('SELECT dispatch FROM attempts WHERE id = ? AND ended_at IS NULL').get(attemptId) as Row | undefined;
      if (!row) throw new StoreError(`no open attempt ${attemptId}`);
      const dispatch = JSON.parse(String(row.dispatch)) as DispatchEvidence;
      this.#db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify({ ...dispatch, reportedModel }), attemptId);
    });
  }

  noteEvents(attemptId: string, count: number): boolean {
    if (!Number.isSafeInteger(count) || count < 1) throw new StoreError('an event count is a whole number from 1');
    return this.#tx(() => changed(this.#db.prepare(`UPDATE attempts SET event_count = ?, last_event_at = ?
      WHERE id = ? AND ended_at IS NULL AND COALESCE(event_count, 0) < ?`).run(count, this.#stamp(), attemptId, count)));
  }

  noteClosed(attemptId: string): boolean {
    return this.#tx(() => changed(this.#db.prepare("UPDATE attempts SET closed_at = ?, dispatch = json_remove(dispatch, '$.geminiUnresolved') WHERE id = ? AND closed_at IS NULL")
      .run(this.#stamp(), attemptId)));
  }

  noteWorkspace(attemptId: string, workspace: Workspace): void {
    this.#tx(() => {
      const row = this.#db.prepare('SELECT request_id FROM attempts WHERE id = ? AND ended_at IS NULL').get(attemptId) as Row | undefined;
      if (!row) throw new StoreError(`no open attempt ${attemptId}`);
      this.#db.prepare('UPDATE requests SET workspace = ?, updated_at = ? WHERE id = ? AND state = \'running\'')
        .run(JSON.stringify(workspace), this.#stamp(), row.request_id as string);
    });
  }

  finishAttempt(attemptId: string, outcome: AttemptOutcome): { recorded: boolean; request: RequestRecord } {
    const clean = checkOutcome(outcome);
    if (clean.kind === 'completed' && Buffer.byteLength(JSON.stringify(clean.result)) > FIELD_LIMIT) {
      let low = 0, high = clean.result.length;
      const suffix = '\n[truncated by pipe]';
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(clean.result.slice(0, mid) + suffix)) <= FIELD_LIMIT) low = mid;
        else high = mid - 1;
      }
      clean.result = clean.result.slice(0, low) + suffix;
    }
    const { recorded, request } = this.#tx(() => { const { at, now } = this.#stampAndNow(); return this.#finish(attemptId, clean, at, now); });
    if (!request) throw new StoreError(`attempt ${attemptId} ended, but its request cannot be read; it was failed as malformed`);
    return { recorded, request };
  }

  noteHeld(attemptId: string, reason: string): boolean {
    const wait = JSON.stringify({ reason: text(reason, 'a hold reason'), until: null });
    return this.#tx(() => changed(this.#db.prepare("UPDATE requests SET waiting = ?, updated_at = ? WHERE id = (SELECT request_id FROM attempts WHERE id = ? AND ended_at IS NULL) AND state = 'running'")
      .run(wait, this.#stamp(), attemptId)));
  }
  saveLimits(accountId: string, holds: ReadonlyArray<SavedLimitHold>): void {
    this.#tx(() => {
      this.#db.prepare('DELETE FROM limits WHERE account_id = ?').run(text(accountId, 'an account id'));
      const insert = this.#db.prepare("INSERT INTO limits (account_id, bucket, model, observed_at, resets_at, resetless, origin) VALUES (?, ?, ?, ?, ?, ?, 'limit')");
      for (const h of holds) {
        if (h.resetless !== undefined && typeof h.resetless !== 'boolean') throw new StoreError('a saved resetless marker must be boolean');
        insert.run(accountId, h.bucket, h.model, text(h.observedAt, 'a limit time'), h.resetsAt, h.resetless === true || h.resetsAt === null ? 1 : 0);
      }
    });
  }
  limits(): Array<{ accountId: string; hit: SavedLimitHold }> {
    return (this.#db.prepare('SELECT * FROM limits ORDER BY seq').all() as Row[]).map((row) => {
      if ((row.resetless !== 0 && row.resetless !== 1) || (row.resets_at === null && row.resetless !== 1))
        throw new StoreError('a saved limit has an invalid resetless marker; it is refused, not guessed at');
      return { accountId: String(row.account_id), hit: { bucket: row.bucket as string | null, model: row.model as string | null,
        resetsAt: row.resets_at as string | null, observedAt: String(row.observed_at),
        ...(row.resetless === 1 && row.resets_at !== null ? { resetless: true } : {}) } };
    });
  }

  reconcile(message: string, kind: 'no_outcome' | 'interrupted' = 'no_outcome', include: (attemptId: string) => boolean = () => true): Attempt[] {
    return this.#tx(() => {
      const { at, now } = this.#stampAndNow();
      const ended: Attempt[] = [];
      for (const row of this.#db.prepare('SELECT * FROM attempts WHERE ended_at IS NULL ORDER BY seq').all() as Row[]) {
        if (!include(String(row.id))) continue;
        let outcome: AttemptOutcome = { kind, message };
        try {
          const dispatch = JSON.parse(String(row.dispatch)) as { preSpawn?: boolean; runner?: RunnerIdentity };
          if (dispatch && dispatch.preSpawn === true && !dispatch.runner) outcome = { kind: 'unstarted', message };
        } catch { /* Unreadable dispatch cannot prove the prompt was withheld. */ }
        if (!this.#finish(String(row.id), outcome, at, now).recorded) continue;
        try { ended.push({ ...toAttempt(row), endedAt: at, outcome }); } catch { /* ended, but its stored dispatch is unreadable */ }
      }
      return ended;
    });
  }

  close(): void {
    this.#db.close();
  }

  #finish(attemptId: string, outcome: AttemptOutcome, at: string, now: number): { recorded: boolean; request: RequestRecord | undefined } {
    const attempt = this.#db.prepare('SELECT request_id, account_id, dispatch FROM attempts WHERE id = ?').get(attemptId) as Row | undefined;
    if (!attempt) throw new StoreError(`no attempt ${attemptId}`);
    const requestId = String(attempt.request_id);
    let reserveStopped = false; try { reserveStopped = JSON.parse(String(attempt.dispatch))?.reserveStopped === true; } catch { /* legacy uncertainty retains ordinary recovery */ }
    if (reserveStopped && !(outcome.kind === 'failed' && outcome.errorKind === 'start_mismatch') && outcome.kind !== 'completed' && this.get(requestId)?.state !== 'cancelled') outcome = { kind: 'failed', errorKind: 'other', message: 'automatic Claude stopped: review reserve reached or evidence unknown; work retained, no automatic retry', workspace: ('workspace' in outcome ? outcome.workspace : undefined) ?? this.get(requestId)?.workspace ?? undefined };
    const recorded = changed(this.#db.prepare('UPDATE attempts SET ended_at = ?, outcome = ? WHERE id = ? AND ended_at IS NULL')
      .run(at, JSON.stringify(outcome), attemptId));
    if (recorded) this.#recordAuthHold(String(attempt.account_id), outcome, now);
    const request = this.get(requestId);
    const left = recorded && 'workspace' in outcome ? outcome.workspace : undefined;
    if (left && request?.state === 'cancelled' && !request.workspace) {
      this.#db.prepare("UPDATE requests SET workspace = ?, updated_at = ? WHERE id = ? AND state = 'cancelled' AND workspace IS NULL")
        .run(JSON.stringify(left), at, requestId);
      return { recorded, request: this.get(requestId) };
    }
    if (!recorded || request?.state !== 'running') return { recorded, request };
    const { n } = this.#db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE request_id = ? AND (outcome IS NULL OR (json_extract(outcome, '$.kind') NOT IN ('interrupted', 'unstarted') AND COALESCE(json_extract(outcome, '$.errorKind'), '') NOT IN ('quota_exhausted', 'rate_limited', 'disk_full', 'setup_timeout', 'offline', 'auth')))").get(requestId) as { n: number };
    const { limits } = this.#db.prepare("SELECT COUNT(*) AS limits FROM attempts WHERE request_id = ? AND json_extract(outcome, '$.errorKind') IN ('quota_exhausted', 'rate_limited', 'auth')").get(requestId) as { limits: number };
    const { offline } = this.#db.prepare("SELECT COUNT(*) AS offline FROM attempts WHERE request_id = ? AND json_extract(outcome, '$.errorKind') = 'offline'").get(requestId) as { offline: number };
    const { diskFull } = this.#db.prepare("SELECT COUNT(*) AS diskFull FROM attempts WHERE request_id = ? AND json_extract(outcome, '$.errorKind') = 'disk_full'").get(requestId) as { diskFull: number };
    const { setupTimeouts } = this.#db.prepare("SELECT COUNT(*) AS setupTimeouts FROM attempts WHERE request_id = ? AND json_extract(outcome, '$.errorKind') = 'setup_timeout'").get(requestId) as { setupTimeouts: number };
    const next = settle(request, String(attempt.account_id), outcome, n, limits, offline, diskFull, setupTimeouts, now, this.#policy);
    this.#db.prepare("UPDATE requests SET state = ?, avoid = ?, not_before = ?, result = ?, workspace = ?, error = ?, waiting = NULL, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(next.state, JSON.stringify(next.avoid), next.notBefore, next.result, jsonOrNull(next.workspace), jsonOrNull(next.error), at, requestId);
    return { recorded, request: this.get(requestId) };
  }

  #recordAuthHold(accountId: string, outcome: AttemptOutcome, now: number): void {
    if (outcome.kind === 'completed') {
      this.#db.prepare('DELETE FROM account_holds WHERE account_id = ?').run(accountId);
      return;
    }
    if (outcome.kind !== 'failed' || outcome.errorKind !== 'auth') return;
    const old = this.#db.prepare('SELECT streak, hold_ms, held_until FROM account_holds WHERE account_id = ?').get(accountId) as
      { streak: number; hold_ms: number; held_until: number } | undefined;
    const streak = (old?.streak ?? 0) + 1;
    let holdMs = old?.hold_ms ?? 0, heldUntil = old?.held_until ?? 0;
    if (streak >= 2) {
      if (now >= heldUntil) {
        holdMs = holdMs === 0 ? this.#policy.authHoldMs : Math.min(this.#policy.authHoldMaxMs, holdMs * 2);
      }
      heldUntil = Math.max(heldUntil, Math.min(LAST_INSTANT, now + holdMs));
    }
    this.#db.prepare(`INSERT INTO account_holds (account_id, streak, hold_ms, held_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET streak = excluded.streak, hold_ms = excluded.hold_ms, held_until = excluded.held_until`)
      .run(accountId, streak, holdMs, heldUntil);
  }
  #restoreAuthHolds(): void {
    const rows = this.#db.prepare(`
      WITH last_success AS (SELECT account_id, MAX(ended_at) AS ended_at FROM attempts
        WHERE ended_at IS NOT NULL AND (CASE WHEN json_valid(outcome) THEN json_extract(outcome, '$.kind') END) = 'completed'
        GROUP BY account_id)
      SELECT a.account_id, a.ended_at, a.outcome FROM attempts a LEFT JOIN last_success s ON s.account_id = a.account_id
      WHERE a.ended_at IS NOT NULL AND (s.ended_at IS NULL OR a.ended_at >= s.ended_at)
      ORDER BY a.account_id, a.ended_at,
        CASE WHEN (CASE WHEN json_valid(a.outcome) THEN json_extract(a.outcome, '$.kind') END) = 'completed' THEN 0 ELSE 1 END, a.seq
    `).all() as { account_id: string; ended_at: string; outcome: string }[];
    for (const row of rows) {
      try {
        const outcome = checkOutcome(JSON.parse(row.outcome)), endedAt = instantOf(row.ended_at);
        if (endedAt !== null) this.#recordAuthHold(row.account_id, outcome, endedAt);
      } catch { /* A damaged historical attempt must not block startup. */ }
    }
  }
  #read(row: Row): RequestRecord | undefined {
    try {
      return toRecord(row);
    } catch (e) {
      if (row.state === 'queued' || row.state === 'running') {
        const error: RequestError = { kind: 'malformed', message: `the stored request cannot be read: ${e instanceof Error ? e.message : String(e)}` };
        let at: string;
        try { at = this.#stamp(); } catch { return undefined; }   // no clock: skip the row now, fail it later
        this.#db.prepare("UPDATE requests SET state = 'failed', waiting = NULL, error = ?, updated_at = ? WHERE seq = ? AND state = ?")
          .run(JSON.stringify(error), at, row.seq as number, row.state);
      }
      return undefined;
    }
  }
  #swap(sql: string, value: string, id: string): boolean {
    return this.#tx(() => changed(this.#db.prepare(sql).run(value, this.#stamp(), id)));
  }
  #stamp(): string {
    return this.#stampAndNow().at;
  }
  #stampAndNow(ms = this.#now().getTime()): { at: string; now: number } {
    if (!Number.isFinite(ms) || ms < FIRST_INSTANT || ms > LAST_INSTANT) throw new StoreError('the clock returned a time that is not an instant (years 0000-9999); nothing is stamped');
    const { last } = this.#db.prepare('UPDATE clock SET last = MAX(last, ?) RETURNING last').get(ms) as { last: number };
    return { at: new Date(last).toISOString(), now: ms };
  }

  #tx<T>(fn: () => T, write = true): T {
    this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.#db.exec('ROLLBACK'); } catch { /* SQLite already rolled back */ }
      throw e;
    }
  }
}

type Settled = Pick<RequestRecord, 'state' | 'avoid' | 'notBefore' | 'result' | 'workspace' | 'error'>;
function settle(r: RequestRecord, accountId: string, o: AttemptOutcome, tries: number, limits: number, offline: number, diskFull: number, setupTimeouts: number, now: number, policy: { maxAttempts: number; backoffMs: number; maxLimits: number }): Settled {
  const end = { avoid: r.avoid, notBefore: null, result: null, workspace: null };
  if (o.kind === 'completed') return { ...end, state: 'completed', result: o.result, workspace: o.workspace ?? null, error: null };
  if (o.kind === 'cancelled') return { ...end, state: 'cancelled', workspace: o.workspace ?? r.workspace, error: { kind: 'cancelled', message: o.message ?? 'the attempt was cancelled' } };
  if (o.kind === 'unstarted') return { ...end, state: 'queued', workspace: o.workspace ?? r.workspace, error: { kind: 'interrupted', message: o.message } };
  const kind = o.kind === 'failed' ? o.errorKind : o.kind;
  if (kind === 'start_mismatch') return { ...end, state: 'start_mismatch', workspace: r.workspace, error: { kind, message: o.message } };
  const untouched = o.kind === 'failed' && o.untouched === true && o.workspace === undefined;
  const work = untouched ? null : o.kind === 'failed' || o.kind === 'interrupted' ? o.workspace ?? r.workspace : o.kind === 'no_outcome' ? r.workspace : null;
  const failed = (note?: string): Settled => ({ ...end, workspace: work, state: 'failed', error: { kind, message: note ? `${o.message}; ${note}` : o.message } });
  const temporary = kind === 'auth' || kind === 'rate_limited' || kind === 'quota_exhausted' || kind === 'disk_full' || kind === 'setup_timeout';
  if (r.automatic && !retrySafe(o)) return failed('automatic retry lacks safe completion proof; original work retained');
  if (r.mutating !== false && !(untouched && temporary))
    return untouched ? failed() : failed('the work may be partly done and is never re-run: inspect the work before resubmitting');
  if (kind === 'setup_timeout') {
    if (!untouched) return failed();
    if (setupTimeouts >= 2) return failed('gave up after 2 setup timeouts');
    return { ...end, state: 'queued', error: { kind, message: o.message }, notBefore: new Date(Math.min(LAST_INSTANT, now + policy.backoffMs)).toISOString() };
  }
  if (kind === 'disk_full') {
    if (diskFull >= 10) return failed(`gave up after ${diskFull} disk-full failures`);
    return { ...end, state: 'queued', error: { kind, message: o.message }, notBefore: new Date(Math.min(LAST_INSTANT, now + policy.backoffMs)).toISOString() };
  }
  if (r.provider === 'gemini' && kind === 'auth') return failed();
  if (kind === 'quota_exhausted' || kind === 'rate_limited' || kind === 'auth') {
    if (limits >= policy.maxLimits) return failed(kind === 'auth' ? `gave up after ${limits} repeated sign-in failures` : `gave up after ${limits} limits`);
    return { ...end, state: 'queued', workspace: untouched ? null : r.workspace, error: { kind, message: o.message } };
  }
  if (kind === 'interrupted') {
    return { ...end, state: 'queued', error: { kind, message: o.message } };
  }
  if (kind === 'offline' && offline > 10) return failed(`gave up after ${offline} offline failures`);
  if (kind === 'offline') return { ...end, state: 'queued', error: { kind, message: o.message }, notBefore: new Date(Math.min(LAST_INSTANT, now + policy.backoffMs)).toISOString() };
  if (kind === 'other' || kind === 'model_mismatch') return failed();
  const avoids = AVOID.has(kind);
  if (avoids && r.pin !== undefined) return failed(`pinned to ${r.pin}, so it is not retried on another account`);
  if (tries >= policy.maxAttempts) return failed(`gave up after ${tries} attempts`);
  return {
    ...end, state: 'queued', error: { kind, message: o.message },
    avoid: avoids ? [...new Set([...r.avoid, accountId])] : r.avoid,
    notBefore: kind === 'transient' ? new Date(Math.min(LAST_INSTANT, now + policy.backoffMs)).toISOString() : null,
  };
}

function toRecord(row: Row): RequestRecord {
  const raw = JSON.parse(String(row.body)), body = checkRequest(raw, true);
  if ((body.expectedStartCommit !== undefined || raw.startSource !== undefined) && (!validSavedStart(raw.startSource) || raw.startSource.commit !== body.expectedStartCommit))
    throw new StoreError('saved source binding is missing or malformed');
  const [avoid, waiting, workspace, error] = [row.avoid, row.waiting, row.workspace, row.error].map((v) => (v === null ? null : JSON.parse(String(v))));
  const need = (ok: boolean, what: string) => { if (!ok) throw new StoreError(what); };
  need(Array.isArray(avoid) && avoid.every(isText), 'avoid must be a list of account ids');
  need(waiting === null || fits(waiting, WAIT), 'waiting must be { reason, until, stoppedSince? }');
  need(workspace === null || fits(workspace, WORKSPACE), 'workspace must be { path, branch, commit }');
  need(error === null || fits(error, ERROR), 'error must be { kind, message }');
  need(row.not_before === null || instantOf(row.not_before) !== null, 'notBefore must be an instant');
  need(row.result === null || isText(row.result), 'result must be text');
  return {
    ...body, ...(body.expectedStartCommit === undefined ? {} : { startSource: raw.startSource }), id: String(row.id), seq: Number(row.seq), state: row.state as RequestState,
    ...storedAdmission(raw),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), waiting,
    notBefore: row.not_before === null ? null : String(row.not_before), avoid,
    result: row.result as string | null, workspace, error,
    ...(row.cancelled_by === null ? {} : { by: String(row.cancelled_by) }),
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  };
}

function toAttempt(row: Row): Attempt {
  const json = (v: unknown, what: string): unknown => {
    try { return JSON.parse(String(v)); } catch (e) { throw new StoreError(`attempt ${String(row.id)}'s stored ${what} cannot be read: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const dispatch = json(row.dispatch, 'dispatch') as DispatchEvidence & { runner?: RunnerIdentity; geminiSupervisor?: RunnerIdentity; geminiUnresolved?: boolean; reportedModel?: string | null };
  return {
    id: String(row.id), requestId: String(row.request_id), accountId: String(row.account_id),
    dispatch: { ...pick(dispatch, { accountId: true, model: true, observedAt: true, verdict: true, grant: true, allowance: true, route: true, allowanceObservedAt: true, allowanceSource: true }), ...(dispatch.host === undefined ? {} : { host: hostAlias(dispatch.host) }) } as DispatchEvidence,
    runner: dispatch.runner ?? null, ...(dispatch.geminiSupervisor ? { geminiSupervisor: dispatch.geminiSupervisor } : {}), reportedModel: dispatch.reportedModel ?? null, startedAt: String(row.started_at),
    ...(dispatch.geminiUnresolved === true ? { geminiUnresolved: true } : {}),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    outcome: row.outcome === null ? null : json(row.outcome, 'outcome') as AttemptOutcome,
    events: row.event_count === null || row.event_count === undefined ? null : { count: Number(row.event_count), lastAt: String(row.last_event_at) },
    closedAt: row.closed_at === null || row.closed_at === undefined ? null : String(row.closed_at),
  };
}

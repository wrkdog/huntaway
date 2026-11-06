import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type RequestState =
  | 'received'
  | 'queued'
  | 'submitting'
  | 'dispatched'
  | 'posting'
  | 'answered'
  | 'refused'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'uncertain';

export type RequestInput = {
  team: string;
  channel: string;
  ts: string;
  agent: string;
  thread: string;
  contentHash: string;
};

export type Request = RequestInput & {
  key: string;
  state: RequestState;
  version: number;
  epoch: number;
};

export type JournalEntry = {
  sequence: number;
  key: string;
  from: RequestState | null;
  to: RequestState;
  version: number;
};

type RequestRow = {
  key: string;
  team: string;
  channel: string;
  ts: string;
  agent: string;
  thread: string;
  content_hash: string;
  state: RequestState;
  version: number;
  epoch: number;
};

type RecoveryRow = { closed: number; epoch: number };

const SCHEMA_VERSION = 1;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const TIMESTAMP = /^(?:0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const HASH = /^[0-9a-f]{64}$/;

const SCHEMA_SQL = `
  CREATE TABLE requests (
    key TEXT PRIMARY KEY,
    team TEXT NOT NULL,
    channel TEXT NOT NULL,
    ts TEXT NOT NULL,
    agent TEXT NOT NULL,
    thread TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    version INTEGER NOT NULL,
    epoch INTEGER NOT NULL
  );
  CREATE TABLE journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL REFERENCES requests(key),
    from_state TEXT,
    to_state TEXT NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE TABLE recovery (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    closed INTEGER NOT NULL CHECK (closed IN (0, 1)),
    epoch INTEGER NOT NULL CHECK (epoch >= 0)
  );
`;

const SCHEMA_QUERY =
  'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name';
const EDGES: Readonly<Record<RequestState, readonly RequestState[]>> = {
  received: ['queued', 'refused'],
  queued: ['submitting', 'refused', 'cancelled', 'expired'],
  submitting: ['dispatched', 'failed', 'uncertain'],
  dispatched: ['posting', 'failed', 'uncertain'],
  posting: ['answered', 'failed', 'uncertain'],
  answered: [],
  refused: [],
  failed: [],
  cancelled: [],
  expired: [],
  uncertain: [],
};

const GUARDED_STATES: readonly RequestState[] = [
  'submitting',
  'posting',
  'answered',
];

function copyInput(value: unknown): RequestInput {
  if (value === null || typeof value !== 'object') {
    throw new Error('Invalid request');
  }
  const source = value as Record<string, unknown>;
  // Read each caller-controlled property exactly once.
  const input = {
    team: source.team,
    channel: source.channel,
    ts: source.ts,
    agent: source.agent,
    thread: source.thread,
    contentHash: source.contentHash,
  };
  if (
    typeof input.team !== 'string' ||
    typeof input.channel !== 'string' ||
    typeof input.ts !== 'string' ||
    typeof input.agent !== 'string' ||
    typeof input.thread !== 'string' ||
    typeof input.contentHash !== 'string' ||
    !NAME.test(input.team) ||
    !NAME.test(input.channel) ||
    !NAME.test(input.agent) ||
    !TIMESTAMP.test(input.ts) ||
    !TIMESTAMP.test(input.thread) ||
    !HASH.test(input.contentHash)
  ) {
    throw new Error('Invalid request');
  }
  return input as RequestInput;
}

function isState(value: unknown): value is RequestState {
  return typeof value === 'string' && Object.hasOwn(EDGES, value);
}

function identityKey(input: RequestInput): string {
  // Length prefixes make the tuple reversible, including when names contain '-'.
  return [input.team, input.channel, input.ts]
    .map(part => `${part.length}:${part}`)
    .join('');
}

function fromRow(row: RequestRow): Request {
  return {
    key: row.key,
    team: row.team,
    channel: row.channel,
    ts: row.ts,
    agent: row.agent,
    thread: row.thread,
    contentHash: row.content_hash,
    state: row.state,
    version: row.version,
    epoch: row.epoch,
  };
}

export class RequestLog {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    if (typeof databasePath !== 'string' || databasePath.length === 0) {
      throw new Error('Invalid database path');
    }
    if (!['darwin', 'linux'].includes(process.platform)) {
      throw new Error('Unsupported database platform');
    }

    if (databasePath !== ':memory:') {
      if (existsSync(databasePath)) {
        // SQLite's WAL sidecars belong to the target, not a symlink alias.
        databasePath = realpathSync(databasePath);
      } else {
        try {
          lstatSync(databasePath);
          throw new Error('Database target unavailable');
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
      }
      const hasMain = existsSync(databasePath);
      const hasWal = existsSync(`${databasePath}-wal`);
      const hasShm = existsSync(`${databasePath}-shm`);
      // Let neither a lost main file nor a rollback journal be silently
      // reconstructed into a new epoch-zero log.
      if (existsSync(`${databasePath}-journal`) ||
          ((!hasMain || statSync(databasePath).size === 0) && (hasWal || hasShm))) {
        throw new Error('Database requires recovery');
      }
    }

    // Hold one consistent read snapshot while the original is inspected for
    // writing. If inspection fails, close the writable handle first so it
    // cannot checkpoint a crash-left WAL as the final connection.
    let probe: DatabaseSync | undefined;
    if (databasePath !== ':memory:' && existsSync(databasePath)) {
      try {
        probe = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
        probe.exec('BEGIN');
        this.inspectExisting(probe);
      } catch (error) {
        try { probe?.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
        probe?.close();
        throw error;
      }
    }

    let writable: DatabaseSync | undefined;
    try {
      writable = new DatabaseSync(databasePath, { timeout: 5000 });
      this.db = writable;
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('BEGIN');
      let version: number;
      try {
        version = this.inspectExisting(this.db);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
        throw error;
      }
      if (version === 0) {
        // An empty or missing file does not establish that an older log was
        // not restored or removed. Live callers still need S1 cutoff and
        // restore checks before accepting work.
        this.initialize(() => {
          // BEGIN IMMEDIATE already excludes a competing initializer. A
          // rollback-journal reader must leave before CREATE TABLE can commit.
          if (probe) {
            probe.exec('ROLLBACK');
            probe.close();
            probe = undefined;
          }
        });
      }
      // A held read snapshot prevents changing journal mode on a rollback-
      // journal file. The schema is validated or initialized before release.
      if (probe) {
        probe.exec('ROLLBACK');
        probe.close();
        probe = undefined;
      }
      this.configureDurability(databasePath);
    } catch (error) {
      writable?.close();
      throw error;
    } finally {
      if (probe) {
        try { probe.exec('ROLLBACK'); } catch { /* A read-only snapshot only. */ }
        probe.close();
      }
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  record(input: RequestInput): { created: boolean; request: Request } {
    const value = copyInput(input);
    const key = identityKey(value);
    return this.transaction(() => {
      const existing = this.readRequest(key);
      if (existing) {
        if (
          existing.team !== value.team ||
          existing.channel !== value.channel ||
          existing.ts !== value.ts ||
          existing.agent !== value.agent ||
          existing.thread !== value.thread ||
          existing.contentHash !== value.contentHash
        ) {
          throw new Error('Request identity conflict');
        }
        return { created: false, request: existing };
      }

      const recovery = this.readRecovery();
      if (recovery.closed) {
        throw new Error('Recovery barrier is closed');
      }

      this.db.prepare(`
        INSERT INTO requests
          (key, team, channel, ts, agent, thread, content_hash, state, version, epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 0, ?)
      `).run(
        key, value.team, value.channel, value.ts, value.agent, value.thread,
        value.contentHash, recovery.epoch,
      );
      this.db.prepare(`
        INSERT INTO journal (key, from_state, to_state, version)
        VALUES (?, NULL, 'received', 0)
      `).run(key);

      const request = this.readRequest(key);
      if (!request) throw new Error('Request insert failed');
      return { created: true, request };
    });
  }

  get(key: string): Request | null {
    if (typeof key !== 'string') throw new Error('Invalid request key');
    return this.readRequest(key);
  }

  transition(
    key: string,
    expectedVersion: number,
    to: RequestState,
  ): Request {
    if (
      typeof key !== 'string' ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      !isState(to)
    ) {
      throw new Error('Invalid transition');
    }

    return this.transaction(() => {
      const current = this.readRequest(key);
      if (!current || current.version !== expectedVersion) {
        throw new Error('Stale or missing request');
      }
      if (!EDGES[current.state].includes(to)) {
        throw new Error('Invalid state transition');
      }
      if (GUARDED_STATES.includes(to)) {
        const recovery = this.readRecovery();
        if (recovery.closed || current.epoch !== recovery.epoch) {
          throw new Error('Recovery barrier prevents transition');
        }
      }

      const nextVersion = current.version + 1;
      if (!Number.isSafeInteger(nextVersion)) {
        throw new Error('Request version exhausted');
      }
      const result = this.db.prepare(`
        UPDATE requests SET state = ?, version = ?
        WHERE key = ? AND version = ?
      `).run(to, nextVersion, key, expectedVersion);
      if (result.changes !== 1) {
        throw new Error('Stale request');
      }
      this.db.prepare(`
        INSERT INTO journal (key, from_state, to_state, version)
        VALUES (?, ?, ?, ?)
      `).run(key, current.state, to, nextVersion);

      const updated = this.readRequest(key);
      if (!updated) throw new Error('Request update failed');
      return updated;
    });
  }

  journal(key: string): JournalEntry[] {
    if (typeof key !== 'string') throw new Error('Invalid request key');
    return this.db.prepare(`
      SELECT sequence, key, from_state AS "from", to_state AS "to", version
      FROM journal WHERE key = ? ORDER BY sequence
    `).all(key) as JournalEntry[];
  }

  /**
   * Forget up to `max` ended requests of one team and channel whose `ts` (seconds since 1970) is before `before`,
   * each with its journal, except the keys in `keep`. Only for a team and channel whose `ts` never repeats, such as
   * `huntaway ask`'s own (its start time): a forgotten Slack message could otherwise be recorded and run again. What
   * stays is still a valid history: each request leaves with all of its entries, and new entries keep numbering after the
   * highest ever used. Returns the forgotten keys.
   */
  forgetEnded(options: { before: number; team: string; channel: string; keep?: ReadonlySet<string>; max: number }): string[] {
    const { before, team, channel, keep = new Set<string>(), max } = options;
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(max) || max < 1 ||
        typeof team !== 'string' || typeof channel !== 'string') {
      throw new Error('Invalid cutoff');
    }
    const ended = (Object.keys(EDGES) as RequestState[]).filter(state => EDGES[state].length === 0);
    return this.transaction(() => {
      const keys = (this.db.prepare(`
        SELECT key FROM requests
        WHERE team = ? AND channel = ? AND state IN (${ended.map(() => '?').join(', ')})
          AND CAST(substr(ts, 1, instr(ts, '.') - 1) AS INTEGER) < ?
        ORDER BY CAST(substr(ts, 1, instr(ts, '.') - 1) AS INTEGER), ts
      `).all(team, channel, ...ended, before) as Array<{ key: string }>)
        .map(row => row.key).filter(key => !keep.has(key)).slice(0, max);
      const list = JSON.stringify(keys);
      this.db.prepare('DELETE FROM journal WHERE key IN (SELECT value FROM json_each(?))').run(list);
      this.db.prepare('DELETE FROM requests WHERE key IN (SELECT value FROM json_each(?))').run(list);
      return keys;
    });
  }

  beginRecovery(): number {
    return this.transaction(() => {
      const current = this.readRecovery();
      if (current.epoch >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Recovery epoch exhausted');
      }
      const epoch = current.epoch + 1;
      this.db.prepare(
        'UPDATE recovery SET closed = 1, epoch = ? WHERE id = 1',
      ).run(epoch);
      return epoch;
    });
  }

  recovery(): { closed: boolean; epoch: number } {
    const row = this.readRecovery();
    return { closed: row.closed === 1, epoch: row.epoch };
  }

  finishRecovery(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error('Invalid recovery epoch');
    }
    this.transaction(() => {
      const current = this.readRecovery();
      if (current.closed !== 1 || current.epoch !== epoch) {
        throw new Error('Stale recovery epoch');
      }
      this.db.prepare(
        'UPDATE recovery SET closed = 0 WHERE id = 1 AND epoch = ?',
      ).run(epoch);
    });
  }

  private readRequest(key: string): Request | null {
    const row = this.db.prepare(
      'SELECT * FROM requests WHERE key = ?',
    ).get(key) as RequestRow | undefined;
    return row ? fromRow(row) : null;
  }

  private readRecovery(db: DatabaseSync = this.db): RecoveryRow {
    const row = db.prepare(
      'SELECT closed, epoch FROM recovery WHERE id = 1',
    ).get() as RecoveryRow | undefined;
    if (!row) throw new Error('Invalid recovery state');
    return row;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  private initialize(releaseReader: () => void): void {
    this.transaction(() => {
      releaseReader();
      // Recheck under the writer lock: a foreign initializer may have raced
      // the read-only preflight of an empty file.
      const observed = this.inspectExisting(this.db);
      if (observed === SCHEMA_VERSION) {
        return; // Another trusted initializer finished while we waited.
      }
      if (observed !== 0) {
        throw new Error('Unsupported database schema');
      }
      this.db.exec(SCHEMA_SQL);
      this.db.exec('INSERT INTO recovery (id, closed, epoch) VALUES (1, 0, 0)');
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private configureDurability(databasePath: string): void {
    if (databasePath !== ':memory:') {
      const mode = this.db.prepare('PRAGMA journal_mode = WAL').get() as
        { journal_mode: string };
      if (mode.journal_mode.toLowerCase() !== 'wal') {
        throw new Error('WAL mode unavailable');
      }
    }
    this.db.exec('PRAGMA synchronous = FULL');
    if (databasePath !== ':memory:') {
      const sync = this.db.prepare('PRAGMA synchronous').get() as
        { synchronous: number };
      if (sync.synchronous !== 2) {
        throw new Error('FULL synchronization unavailable');
      }
      if (process.platform === 'darwin') {
        this.db.exec('PRAGMA fullfsync = ON');
        this.db.exec('PRAGMA checkpoint_fullfsync = ON');
        const full = this.db.prepare('PRAGMA fullfsync').get() as
          { fullfsync: number };
        const checkpoint = this.db.prepare('PRAGMA checkpoint_fullfsync').get() as
          { checkpoint_fullfsync: number };
        if (full.fullfsync !== 1 || checkpoint.checkpoint_fullfsync !== 1) {
          throw new Error('Full filesystem synchronization unavailable');
        }
      }
    }
    // WAL with FULL synchronization covers process crashes. Power-loss
    // behavior also depends on the platform and storage flush guarantees.
  }

  private inspectExisting(db: DatabaseSync): number {
    const version = db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    if (version?.user_version === SCHEMA_VERSION) {
      this.validateSchema(db);
    } else if (version?.user_version !== 0 ||
               db.prepare(SCHEMA_QUERY).all().length !== 0) {
      throw new Error('Unsupported database schema');
    }
    return version.user_version;
  }

  private validateSchema(db: DatabaseSync): void {
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(SCHEMA_SQL);
      if (JSON.stringify(db.prepare(SCHEMA_QUERY).all()) !==
          JSON.stringify(reference.prepare(SCHEMA_QUERY).all())) {
        throw new Error('Invalid database schema');
      }
    } finally {
      reference.close();
    }
    const integrity = db.prepare('PRAGMA integrity_check').all() as
      Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('Corrupt database');
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('Invalid database references');
    }
    const count = db.prepare(
      'SELECT COUNT(*) AS count FROM recovery',
    ).get() as { count: number };
    const recovery = this.readRecovery(db);
    if (
      count.count !== 1 ||
      (recovery.closed !== 0 && recovery.closed !== 1) ||
      !Number.isSafeInteger(recovery.epoch) ||
      recovery.epoch < 0
    ) {
      throw new Error('Invalid recovery state');
    }
    this.validateHistory(recovery.epoch, db);
  }

  private validateHistory(recoveryEpoch: number, db: DatabaseSync): void {
    const requests = db.prepare('SELECT * FROM requests').all() as
      RequestRow[];
    const byKey = new Map<string, RequestRow>();
    for (const row of requests) {
      const input = copyInput({
        team: row.team,
        channel: row.channel,
        ts: row.ts,
        agent: row.agent,
        thread: row.thread,
        contentHash: row.content_hash,
      });
      if (
        row.key !== identityKey(input) ||
        !isState(row.state) ||
        !Number.isSafeInteger(row.version) || row.version < 0 ||
        !Number.isSafeInteger(row.epoch) ||
        row.epoch < 0 || row.epoch > recoveryEpoch
      ) {
        throw new Error('Invalid request history');
      }
      byKey.set(row.key, row);
    }

    const entries = db.prepare(`
      SELECT sequence, key, from_state, to_state, version
      FROM journal ORDER BY sequence
    `).all() as Array<{
      sequence: number;
      key: string;
      from_state: unknown;
      to_state: unknown;
      version: number;
    }>;
    const latest = new Map<string, { state: RequestState; version: number }>();
    let previousSequence = 0;
    for (const entry of entries) {
      const previous = latest.get(entry.key);
      if (
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence <= previousSequence ||
        !byKey.has(entry.key) ||
        !Number.isSafeInteger(entry.version) ||
        !isState(entry.to_state)
      ) {
        throw new Error('Invalid request history');
      }
      if (previous) {
        if (
          entry.version !== previous.version + 1 ||
          entry.from_state !== previous.state ||
          !EDGES[previous.state].includes(entry.to_state)
        ) {
          throw new Error('Invalid request history');
        }
      } else if (
        entry.version !== 0 ||
        entry.from_state !== null ||
        entry.to_state !== 'received'
      ) {
        throw new Error('Invalid request history');
      }
      latest.set(entry.key, { state: entry.to_state, version: entry.version });
      previousSequence = entry.sequence;
    }
    for (const row of requests) {
      const final = latest.get(row.key);
      if (!final || final.state !== row.state || final.version !== row.version) {
        throw new Error('Invalid request history');
      }
    }
  }
}

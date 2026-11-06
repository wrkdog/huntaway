import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { testMode } from './models.ts';

const DAY = 86_400_000;
const VERSION = 1;
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n;
const SCHEMA = `
  CREATE TABLE spend (
    id INTEGER PRIMARY KEY,
    started INTEGER NOT NULL CHECK (started >= 0),
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    safety_revision INTEGER NOT NULL CHECK (safety_revision >= 1),
    estimated INTEGER NOT NULL CHECK (estimated >= 0),
    reserved INTEGER NOT NULL CHECK (reserved >= 0),
    settled INTEGER CHECK (settled >= 0),
    input_tokens INTEGER CHECK (input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens >= 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('reserved', 'not_run', 'completed', 'refused', 'uncertain')),
    overrun INTEGER NOT NULL CHECK (overrun IN (0, 1))
  );
`;
const SCHEMA_QUERY = 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name';

export function ledgerNow(): number {
  const stand = process.env.HUNTAWAY_TEST_NOW;
  if (testMode() && stand !== undefined) {
    if (!/^[0-9]+$/.test(stand) || !Number.isSafeInteger(Number(stand))) throw new Error('Invalid ledger clock');
    return Number(stand);
  }
  return Date.now();
}

export type Reservation = {
  engine: string; model: string; revision: number; estimated: bigint; reserved: bigint;
};
export type Settlement = {
  amount: bigint; input: bigint | null; output: bigint | null;
  outcome: 'not_run' | 'completed' | 'refused'; overrun: boolean;
};
export type Spend = { used: bigint; overruns: { engine: string; model: string; revision: number }[] };

/** Independent of requests.db: a crash or an uncertain response keeps its complete reservation. */
export class SpendLedger {
  private db: DatabaseSync;

  constructor(path: string, readOnly = false) {
    if (path !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          if (!lstatSync(path + suffix).isFile()) throw new Error('Invalid ledger file');
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
      }
      if (!existsSync(path) && ['-wal', '-shm', '-journal'].some(s => existsSync(path + s))) {
        throw new Error('Ledger requires recovery');
      }
    }
    const previousMask = process.umask(0o077);
    try {
      this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    } finally {
      process.umask(previousMask);
    }
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (!readOnly) {
        this.transaction(() => {
          const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
          if (version === 0 && this.db.prepare(SCHEMA_QUERY).all().length === 0) {
            this.db.exec(SCHEMA);
            this.db.exec(`PRAGMA user_version = ${VERSION}`);
          }
          this.validate();
        });
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = FULL');
        if (process.platform === 'darwin') {
          this.db.exec('PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON');
        }
        if (path !== ':memory:') {
          for (const s of ['', '-wal', '-shm']) if (existsSync(path + s)) chmodSync(path + s, 0o600);
        }
      } else {
        this.db.exec('BEGIN');
        this.validate();
      }
    } catch {
      this.db.close();
      throw new Error('The spend ledger could not be opened');
    }
  }

  close(): void { this.db.close(); }

  snapshot(now = ledgerNow()): Spend {
    // Sum in BigInt in JS: SQLite SUM can overflow even when each stored integer is valid.
    const rows = this.db.prepare('SELECT COALESCE(settled, reserved) AS amount FROM spend WHERE started >= ?');
    rows.setReadBigInts(true);
    const used = (rows.all(now - DAY) as { amount: bigint }[]).reduce((sum, r) => sum + r.amount, 0n);
    const overruns = this.db.prepare('SELECT DISTINCT engine, model, safety_revision AS revision FROM spend WHERE overrun = 1')
      .all() as Spend['overruns'];
    return { used, overruns };
  }

  check(r: Reservation, cap: bigint, now = ledgerNow()): bigint {
    const { used, overruns } = this.snapshot(now);
    if (overruns.some(o => o.engine === r.engine && o.model === r.model && o.revision >= r.revision)) {
      throw new Error('This model is blocked after a spend overrun; a reviewed safety revision is required');
    }
    if (used + r.reserved > cap) throw new Error('The per-day cap has no room in the last 24 hours');
    return used;
  }

  reserve(r: Reservation, cap: bigint): { id: bigint; used: bigint } {
    return this.transaction(() => {
      const now = ledgerNow();
      const used = this.check(r, cap, now);
      // The estimate is informational: saturate only its stored value, so a huge
      // count/price override cannot prevent a reservation that fits both caps.
      const estimated = r.estimated > MAX_SQLITE_INTEGER ? MAX_SQLITE_INTEGER : r.estimated;
      const row = this.db.prepare(`INSERT INTO spend
        (started, engine, model, safety_revision, estimated, reserved, outcome, overrun)
        VALUES (?, ?, ?, ?, ?, ?, 'reserved', 0)`)
        .run(now, r.engine, r.model, r.revision, estimated, r.reserved);
      return { id: BigInt(row.lastInsertRowid), used };
    });
  }

  settle(id: bigint, s: Settlement): void {
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE spend SET settled = ?, input_tokens = ?, output_tokens = ?,
        outcome = ?, overrun = ? WHERE id = ? AND settled IS NULL`)
        .run(s.amount, s.input, s.output, s.outcome, s.overrun ? 1 : 0, id);
      if (result.changes !== 1) throw new Error('The spend could not be settled');
    });
  }

  keepReservation(id: bigint, outcome: 'completed' | 'refused' | 'uncertain', overrun: boolean): void {
    this.transaction(() => {
      this.db.prepare('UPDATE spend SET outcome = ?, overrun = MAX(overrun, ?) WHERE id = ? AND settled IS NULL')
        .run(outcome, overrun ? 1 : 0, id);
    });
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Keep the reservation. */ }
      throw error;
    }
  }

  private validate(): void {
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version !== VERSION) throw new Error('Unsupported spend schema');
    const reference = new DatabaseSync(':memory:');
    try {
      reference.exec(SCHEMA);
      if (JSON.stringify(this.db.prepare(SCHEMA_QUERY).all()) !== JSON.stringify(reference.prepare(SCHEMA_QUERY).all())) {
        throw new Error('Invalid spend schema');
      }
    } finally { reference.close(); }
    const integrity = this.db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('Corrupt spend ledger');
  }
}

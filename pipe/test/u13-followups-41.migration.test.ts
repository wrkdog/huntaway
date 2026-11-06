import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AllowanceLedger } from '../src/allowance.ts';
import { recover, saveLimitHolds } from '../src/service.ts';
import { Store } from '../src/store.ts';

const start = Date.parse('2026-09-26T12:00:00Z');
const at = (minute: number) => new Date(start + minute * 60_000).toISOString();
const temporary = () => mkdtempSync(join(tmpdir(), 'pipe-u13-migrate-'));
const hit = (resetsAt: string | null) => ({ bucket: 'week', model: null, resetsAt, observedAt: at(45) });

test('version-1 limit rows upgrade in place to version 2 without losing their reset', () => {
  const root = temporary(), path = join(root, 'pipe.sqlite');
  try {
    const original = new Store(path);
    original.saveLimits('acct', [hit(at(120)), hit(null)]);
    original.close();
    const db = new DatabaseSync(path);
    try {
      if ((db.prepare('PRAGMA table_info(limits)').all() as Array<{ name: string }>).some((c) => c.name === 'resetless'))
        db.exec('ALTER TABLE limits DROP COLUMN resetless');
      db.exec('PRAGMA user_version = 1');
    } finally { db.close(); }
    const migrated = new Store(path);
    try {
      assert.deepEqual(migrated.limits(), [{ accountId: 'acct', hit: hit(at(120)) }, { accountId: 'acct', hit: hit(null) }]);
      const check = new DatabaseSync(path);
      try {
        assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
        assert.deepEqual((check.prepare('SELECT resetless FROM limits ORDER BY seq').all() as Array<{ resetless: number }>).map((r) => r.resetless), [0, 1]);
      } finally { check.close(); }
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('version-2 combined hold survives SQLite and journal replay', async () => {
  const root = temporary(), path = join(root, 'pipe.sqlite'), journal = join(root, 'pipe.pipe-journal');
  try {
    const ledger = new AllowanceLedger({ freshnessMs: 600_000, now: () => new Date(at(46)) });
    ledger.recordLimit('acct', hit(at(120)));
    ledger.recordLimit('acct', { ...hit(null), observedAt: at(46) });
    const holds = ledger.limitHolds('acct');
    assert.equal(holds.length, 1);
    assert.equal(holds[0]?.resetsAt, at(120));
    assert.equal(holds[0]?.resetless, true);
    const store = new Store(path);
    try {
      store.saveLimits('acct', holds);
      assert.deepEqual(store.limits()[0]?.hit, holds[0]);
      await saveLimitHolds({ saveLimits: () => { throw new Error('disk busy'); } }, ledger, new Set(['acct']), journal, () => {});
      assert.match(readFileSync(journal, 'utf8'), /"resetless":true/);
      store.saveLimits('acct', []);
      await recover(store, journal, () => {});
      assert.deepEqual(store.limits()[0]?.hit, holds[0]);
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('version-2 malformed resetless markers fail closed', () => {
  for (const marker of [2, 'bad', 'missing-reset', 'missing-column']) {
    const root = temporary(), path = join(root, 'pipe.sqlite');
    try {
      const store = new Store(path);
      store.saveLimits('acct', [hit(at(120))]);
      store.close();
      const db = new DatabaseSync(path);
      try {
        db.exec('PRAGMA ignore_check_constraints = ON');
        if (marker === 'missing-column') db.exec('ALTER TABLE limits DROP COLUMN resetless');
        else if (marker === 'missing-reset') db.exec('UPDATE limits SET resets_at = NULL, resetless = 0');
        else db.prepare('UPDATE limits SET resetless = ?').run(marker);
      } finally { db.close(); }
      assert.throws(() => new Store(path), /resetless|marker/i, String(marker));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('version-1 record with no limits table upgrades by creating it', () => {
  const root = temporary(), path = join(root, 'pipe.sqlite');
  try {
    const original = new Store(path);
    original.close();
    const db = new DatabaseSync(path);
    try {
      db.exec('DROP TABLE limits');
      db.exec('PRAGMA user_version = 1');
    } finally { db.close(); }
    const migrated = new Store(path);
    try {
      assert.deepEqual(migrated.limits(), []);
      const check = new DatabaseSync(path);
      try {
        assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
        assert.ok((check.prepare('PRAGMA table_info(limits)').all() as Array<{ name: string }>).some((c) => c.name === 'resetless'));
      } finally { check.close(); }
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Huntaway's own history folder ages out (it cleans up only what it makes): ended requests started more
// than HUNTAWAY_KEEP_DAYS ago (default 90) leave the request log and the run list; nothing in progress ever does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { RequestLog } from "../src/core/request-log.ts";
import { keepDays, pruneHistory, recordRunTransition } from "../src/status/runs.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const CLI = fileURLToPath(new URL("../bin/huntaway.ts", import.meta.url));

function home(t) {
  const h = mkdtempSync(join(tmpdir(), "huntaway-retention-"));
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}
const ts = (ms) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;
// One request the way `huntaway ask` records it, walked to `to`, with its run listed at the same moment.
function seed(h, log, ms, to) {
  const { request } = log.record({ team: "local", channel: "cli", ts: ts(ms), agent: "huntaway", thread: ts(ms), contentHash: "a".repeat(64) });
  const iso = new Date(ms).toISOString();
  recordRunTransition(h, request.key, "received", iso);
  const path = { answered: ["queued", "submitting", "dispatched", "posting", "answered"], refused: ["refused"], queued: ["queued"],
    uncertain: ["queued", "submitting", "uncertain"], received: [] }[to];
  let r = request;
  for (const state of path) { r = log.transition(r.key, r.version, state); recordRunTransition(h, r.key, state, iso); }
  return r.key;
}
const runKeys = (h) => { const db = new DatabaseSync(join(h, "runs.db")); try { return db.prepare("SELECT key FROM runs").all().map((r) => r.key); } finally { db.close(); } };

test("an ended request started over the kept days leaves the request log with its whole journal; the rest is a valid history", (t) => {
  const h = home(t), path = join(h, "requests.db"), log = new RequestLog(path);
  const old = seed(h, log, NOW - 91 * DAY, "answered"), oldRefused = seed(h, log, NOW - 200 * DAY, "refused");
  const oldUncertain = seed(h, log, NOW - 95 * DAY, "uncertain");
  const settledLate = seed(h, log, NOW - 96 * DAY, "uncertain");
  recordRunTransition(h, settledLate, "uncertain", new Date(NOW - DAY).toISOString());   // an orphan settled since the cutoff
  const settling = seed(h, log, NOW - 97 * DAY, "uncertain");
  new DatabaseSync(join(h, "runs.db")).prepare("UPDATE runs SET code = 'running' WHERE key = ?").run(settling);   // log first, list next
  const unlisted = seed(h, log, NOW - 98 * DAY, "answered");
  new DatabaseSync(join(h, "runs.db")).prepare("DELETE FROM runs WHERE key = ?").run(unlisted);
  const stuck = seed(h, log, NOW - 120 * DAY, "queued"), fresh = seed(h, log, NOW - 89 * DAY, "answered");
  const edge = seed(h, log, NOW - 90 * DAY, "answered");
  const before = Math.max(...[old, oldRefused, oldUncertain, settledLate, settling, unlisted, stuck, fresh, edge].flatMap((k) => log.journal(k).map((e) => e.sequence)));
  assert.equal(pruneHistory(h, log, 90, NOW), 4);
  for (const k of [old, oldRefused, oldUncertain, unlisted]) { assert.equal(log.get(k), null); assert.deepEqual(log.journal(k), []); }
  for (const k of [settledLate, settling, stuck, fresh, edge]) assert.ok(log.get(k), "settled late, still listed running, in progress, recent or at the edge: kept");
  assert.deepEqual(runKeys(h).sort(), [settledLate, settling, stuck, fresh, edge].sort());
  log.close();
  const reopened = new RequestLog(path);   // the reviewed history check runs on every open
  t.after(() => reopened.close());
  const next = seed(h, reopened, NOW, "answered");
  assert.ok(reopened.journal(next)[0].sequence > before, "new entries number after the highest ever used");
});

test("an ended run left behind by a crash between the two files ages out by its own last activity; a running one or one with no readable time never does", (t) => {
  const h = home(t), log = new RequestLog(join(h, "requests.db"));
  t.after(() => log.close());
  recordRunTransition(h, "orphan-ended", "answered", new Date(NOW - 100 * DAY).toISOString());
  recordRunTransition(h, "orphan-running", "dispatched", new Date(NOW - 100 * DAY).toISOString());
  recordRunTransition(h, "recent-ended", "failed", new Date(NOW - DAY).toISOString());
  const odd = [["blank", ""], ["far", "+012026-01-01T00:00:00.000Z"], ["feb30", "2026-02-30T00:00:00.000Z"], ["hour29", "2026-01-01T29:00:00.000Z"],
    ["hour24", "2026-01-01T24:59:59.999Z"], ["leap", "2025-12-31T23:59:60.000Z"]];
  for (const [key, last] of odd) recordRunTransition(h, key, "answered", last);
  const old = seed(h, log, NOW - 100 * DAY, "answered"), impossible = seed(h, log, NOW - 101 * DAY, "answered");
  const runs = new DatabaseSync(join(h, "runs.db"));
  runs.prepare("UPDATE runs SET last = '' WHERE key = ?").run(old);
  runs.prepare("UPDATE runs SET last = '2026-02-30T00:00:00.000Z' WHERE key = ?").run(impossible);
  runs.close();
  assert.equal(pruneHistory(h, log, 90, NOW), 0, "a request whose run has no readable time stays");
  assert.deepEqual(runKeys(h).sort(), [...odd.map(([k]) => k), old, impossible, "orphan-running", "recent-ended"].sort());
});

test("leftover runs go in batches too, and a run whose request is still logged goes only with it", (t) => {
  const h = home(t), log = new RequestLog(join(h, "requests.db"));
  t.after(() => log.close());
  for (let i = 0; i < 5; i++) recordRunTransition(h, `leftover-${i}`, "answered", new Date(NOW - (100 + i) * DAY).toISOString());
  const stepped = seed(h, log, NOW - DAY, "answered");   // started yesterday; a clock stepped back stamped its run long ago
  new DatabaseSync(join(h, "runs.db")).prepare("UPDATE runs SET last = ? WHERE key = ?").run(new Date(NOW - 200 * DAY).toISOString(), stepped);
  assert.equal(pruneHistory(h, log, 90, NOW, 2), 0);
  assert.deepEqual(runKeys(h).sort(), [stepped, "leftover-0", "leftover-1", "leftover-2"].sort(), "the two oldest leftovers");
  pruneHistory(h, log, 90, NOW, 2); pruneHistory(h, log, 90, NOW, 2);
  assert.deepEqual(runKeys(h), [stepped]);
  assert.ok(log.get(stepped));
});

test("a crash after the log forgot a request leaves its run, which the next call removes as a leftover", (t) => {
  const h = home(t), log = new RequestLog(join(h, "requests.db"));
  t.after(() => log.close());
  const key = seed(h, log, NOW - 100 * DAY, "answered");
  assert.deepEqual(log.forgetEnded({ before: Math.floor((NOW - 90 * DAY) / 1000), team: "local", channel: "cli", max: 100 }), [key]);
  assert.deepEqual(runKeys(h), [key], "the crash came before the run list was cleaned");
  assert.equal(pruneHistory(h, log, 90, NOW), 0);
  assert.deepEqual(runKeys(h), []);
});

test("at most one batch goes per call, oldest first, and only the asks' own requests", (t) => {
  const h = home(t), log = new RequestLog(join(h, "requests.db"));
  t.after(() => log.close());
  const keys = [3, 2, 1].map((n) => seed(h, log, NOW - (100 + n) * DAY, "answered"));
  const slack = log.record({ team: "T1", channel: "C1", ts: ts(NOW - 200 * DAY), agent: "a", thread: ts(NOW - 200 * DAY), contentHash: "b".repeat(64) }).request;
  log.transition(slack.key, slack.version, "refused");
  assert.equal(pruneHistory(h, log, 90, NOW, 2), 2);
  assert.deepEqual(keys.map((k) => log.get(k) === null), [true, true, false], "the two oldest");
  assert.equal(pruneHistory(h, log, 90, NOW, 2), 1);
  assert.equal(pruneHistory(h, log, 90, NOW, 2), 0);
  assert.ok(log.get(slack.key), "a request another team recorded is never Huntaway's to forget");
});

test("a key the log forgot and a later ask recorded again keeps its new run", (t) => {
  const h = home(t), log = new RequestLog(join(h, "requests.db"));
  t.after(() => log.close());
  const key = seed(h, log, NOW - 100 * DAY, "answered");
  const runs = new DatabaseSync(join(h, "runs.db"));
  t.after(() => runs.close());
  // Between the log's forgetting and the run list's cleanup, a clock stepped back lets another ask take the same key.
  const forget = log.forgetEnded.bind(log);
  log.forgetEnded = (options) => { const out = forget(options); runs.prepare("UPDATE runs SET code = 'waiting_local_host', last = ? WHERE key = ?").run(new Date(NOW).toISOString(), key); return out; };
  assert.equal(pruneHistory(h, log, 90, NOW), 1);
  assert.deepEqual(runKeys(h), [key], "the new run stays listed");
});

test("a history file that is a link, or has another name too, is never cleaned", (t) => {
  for (const shape of ["symlink", "hardlink"]) {
    const h = home(t), other = home(t), log = new RequestLog(join(other, "requests.db"));
    const key = seed(other, log, NOW - 100 * DAY, "answered");
    log.close();
    if (shape === "symlink") symlinkSync(join(other, "requests.db"), join(h, "requests.db")); else linkSync(join(other, "requests.db"), join(h, "requests.db"));
    if (shape === "symlink") recordRunTransition(h, "mine", "answered", new Date(NOW).toISOString()); else linkSync(join(other, "runs.db"), join(h, "runs.db"));
    const mine = new RequestLog(join(h, "requests.db"));
    t.after(() => mine.close());
    assert.equal(pruneHistory(h, mine, 90, NOW), 0, shape);
    assert.ok(mine.get(key), shape);
  }
});

test("HUNTAWAY_KEEP_DAYS is whole days from 1 to 3660, 90 when unset; anything else keeps everything", (t) => {
  const saved = process.env.HUNTAWAY_KEEP_DAYS;
  t.after(() => { if (saved === undefined) delete process.env.HUNTAWAY_KEEP_DAYS; else process.env.HUNTAWAY_KEEP_DAYS = saved; });
  for (const [value, want] of [[undefined, 90], ["", 90], ["1", 1], ["30", 30], ["3660", 3660], ["0", null], ["3661", null],
    ["07", null], ["1.5", null], ["-3", null], ["ninety", null], [" 30", null]]) {
    if (value === undefined) delete process.env.HUNTAWAY_KEEP_DAYS; else process.env.HUNTAWAY_KEEP_DAYS = value;
    assert.equal(keepDays(), want, JSON.stringify(value));
  }
  for (const bad of [{ before: -1, max: 1 }, { before: 1, max: 0 }, { before: 1.5, max: 1 }])
    assert.throws(() => new RequestLog(":memory:").forgetEnded({ team: "local", channel: "cli", ...bad }), /Invalid cutoff/);
});

test("`huntaway ask` ages out old history itself; an unusable HUNTAWAY_KEEP_DAYS warns and keeps it", (t) => {
  const h = home(t), log = new RequestLog(join(h, "requests.db"));
  const old = seed(h, log, Date.now() - 100 * DAY, "answered");
  log.close();
  const ask = (env) => spawnSync(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "fake", "hello"],
    { encoding: "utf8", env: { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_FAKE_ANSWER: "ok", ...env } });
  const kept = ask({ HUNTAWAY_KEEP_DAYS: "ninety" });
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stderr, /HUNTAWAY_KEEP_DAYS must be whole days from 1 to 3660; old history was kept/);
  assert.ok(runKeys(h).includes(old));
  const pruned = ask({ HUNTAWAY_KEEP_DAYS: "" });
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.doesNotMatch(pruned.stderr, /HUNTAWAY_KEEP_DAYS|Warning: (?!SQLite)/, "no warning of its own (Node 22.18 warns that SQLite is experimental)");
  assert.equal(runKeys(h).includes(old), false);
  assert.equal(runKeys(h).length, 2, "both new runs stay");
});

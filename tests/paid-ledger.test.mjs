// The day ledger, spend.sqlite: the reservation before the billed
// call, settling from validated usage only, the tier rule, the Anthropic reader (refusals, cache tokens), overruns,
// the rolling 24-hour window, failing closed, two asks racing for the same headroom, and the uninstaller's purge. The
// ledger's column names are the code's own: these tests read every row and look for values, and move through time
// with HUNTAWAY_TEST_NOW, never by editing rows.
// Amounts with hwtest-model and h.BIG_QUESTION (Q below: a billed body over 49,968 bytes, so the 100000-token limit
// binds), --max-tokens 5000: the hard worst case (the reservation, at the standard price) is 100000 + 5000 × 2 =
// 110000 micro-dollars = $0.11; 10000 input + 5000 output tokens cost 20000 micro-dollars = $0.02 at standard prices,
// 40000 micro-dollars = $0.04 at priority. At --max-tokens 1000 the reservation is 102000 micro-dollars. A small
// question's reservation is (2 × B + 64) + --max-tokens × 2 for its body of B bytes, worked out from what the stand-in
// received; usage on a small question stays inside its hard input of about 350 tokens, so it is no overrun.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as h from "./lib/paid-harness.mjs";

let stand;
before(async () => {
  stand = await h.startStandIn();
});
after(async () => {
  await stand.close();
});

const KEY = h.newKey("ledger");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const Q = h.BIG_QUESTION;
const ask = (args, dirs, env = {}) => h.ask(args, { dirs, stand, env: { ANTHROPIC_API_KEY: KEY, ...env } });
const ask5000 = (dirs, env) => ask(["--max-tokens", "5000", Q], dirs, env);
const usedNow = async (dirs, env = {}) => h.usedOf((await h.status({ dirs, env })).stdout);
const billedCalls = (r) => stand.of("billed", r.seen).length;
/** An ask that would be billed and answered, to see whether this model is still allowed to run. */
const nextAsk = (dirs, env) => {
  stand.scenario = { count: h.countOk(1000), billed: h.answer({ use: h.usage(1000, 5) }) };
  return ask(["--max-tokens", "1000", Q], dirs, env);
};
/** A model that is blocked is refused after notice line 1 and before the count: nothing reaches the stand-in. */
function assertBlocked(r, what) {
  assert.equal(r.code, 1, `${what}: ${r.stderr}`);
  assert.equal(r.seen.length, 0, `${what}: refused before the count`);
  assert.match(r.stderr, h.ANY_LINE1, `${what}: after notice line 1`);
}

test("the reservation, the hard worst case, is in spend.sqlite before the billed call; the file is owner-only and holds no key, question, answer or request id", async () => {
  const dirs = h.makeDirs();
  const ANSWER = "the zebra-quokka-9921 answer";
  let atArrival = null;
  let reserved = null;
  stand.scenario = {
    count: h.countOk(100),
    billed: (res, record) => {
      atArrival = h.ledgerRows(dirs);
      reserved = h.hardWorst(h.bodyBytes(record), 1000);
      h.answer({ text: ANSWER, use: h.usage(100, 5), headers: { "request-id": "req_ledgermarker77" } })(res, record);
    },
  };
  const r = await ask(["--max-tokens", "1000", h.QUESTION], dirs);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(atArrival !== null, "the billed call arrived");
  assert.ok(atArrival.some((row) => Object.values(row).some((v) => v === reserved || v === BigInt(reserved))),
    `when the billed call arrives, the ledger already holds a reservation of (2 × B + 64) + 1000 × 2 = ${reserved} micro-dollars ` +
    "for the body of B bytes it received");
  assert.equal(statSync(dirs.ledger).mode & 0o777, 0o600, "the same file mode as the request log");
  assert.ok(h.ledgerHas(dirs, h.MODEL), "the row names the model");
  assert.ok(h.ledgerHas(dirs, "anthropic"), "and the engine");
  assert.ok(h.ledgerHas(dirs, 110), "settled from usage: 100 + 5 × 2 micro-dollars");
  const bytes = h.ledgerBytes(dirs);
  for (const secret of [KEY, KEY.slice(-32), h.QUESTION, ANSWER, "req_ledgermarker77"]) {
    assert.ok(!bytes.includes(secret), `the ledger never holds ${secret === KEY ? "the key" : secret}`);
  }
});

test("settling: not run settles at 0, validated usage at its cost; missing or bad usage and every uncertain outcome keep the reservation; a printed answer exits 0", async () => {
  const ok = (use) => h.answer({ use });
  // [what, the billed call's behaviour, extra args, used afterwards, exit code]
  const cases = [
    ["not run (401)", h.apiError(401), [], "0.00", 1],
    ["not run (529)", h.apiError(529), [], "0.00", 1],
    ["validated usage", ok(h.usage(10000, 5000)), [], "0.02", 0],
    ["no usage", ok(undefined), [], "0.11", 0],
    ["usage null", ok(null), [], "0.11", 0],
    ["usage not an object", ok("lots"), [], "0.11", 0],
    ["negative input", ok(h.usage(-1, 5000)), [], "0.11", 0],
    ["negative output", ok(h.usage(10000, -5)), [], "0.11", 0],
    ["fractional input", ok(h.usage(1.5, 5000)), [], "0.11", 0],
    ["input as a string", ok(h.usage("10000", 5000)), [], "0.11", 0],
    ["no output_tokens", ok({ input_tokens: 10000, service_tier: "standard" }), [], "0.11", 0],
    ["no input_tokens", ok({ output_tokens: 5000, service_tier: "standard" }), [], "0.11", 0],
    ["negative cache tokens", ok(h.usage(10000, 5000, "standard", { cache_read_input_tokens: -1 })), [], "0.11", 0],
    ["cache tokens as a string", ok(h.usage(10000, 5000, "standard", { cache_creation_input_tokens: "0" })), [], "0.11", 0],
    ["a 5xx", h.apiError(500), [], "0.11", 1],
    ["an unreadable body", h.garbage(), [], "0.11", 1],
    ["a redirect", h.redirectTo("http://127.0.0.1:1/v1/messages"), [], "0.11", 1],
    ["no answer in time", h.hang(), ["--timeout", "1"], "0.11", 1],
  ];
  for (const [what, billed, extra, want, code] of cases) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10000), billed };
    const r = await ask([...extra, "--max-tokens", "5000", Q], dirs);
    assert.equal(billedCalls(r), 1, `${what}: the billed call was sent`);
    assert.equal(r.code, code, `${what}: ${r.stderr}`);
    if (code === 0) assert.equal(r.stdout, `${h.ANSWER}\n`, `${what}: the answer was printed`);
    assert.deepEqual(await usedNow(dirs), { used: want, cap: "5.00" }, what);
  }
});

test("a missing or non-standard reported tier settles at the priority price, is an overrun, and stops the next call before its count", async () => {
  for (const tier of ["priority", "batch", undefined, null, "STANDARD", 1]) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10000), billed: h.answer({ use: h.usage(10000, 5000, tier) }) };
    const r = await ask5000(dirs);
    assert.equal(billedCalls(r), 1);
    assert.equal(r.code, 0, `${JSON.stringify(tier)}: the answer was printed, so it exits 0`);
    assert.equal(r.stdout, `${h.ANSWER}\n`);
    assert.match(r.stderr, /warning/i, `${JSON.stringify(tier)}: a warning is printed`);
    assert.deepEqual(await usedNow(dirs), { used: "0.04", cap: "5.00" }, `${JSON.stringify(tier)}: 20000 + 20000 micro-dollars at priority prices`);
    assertBlocked(await nextAsk(dirs), `${JSON.stringify(tier)}: the model is stopped`);
  }
});

test("every overrun stops further calls to that model at any age, before the count; the other test model still runs; doctor shows a FAIL", async () => {
  // count 1000: an estimated input of 1164 tokens; --max-tokens 1000; on the big question Q, the reservation is
  // 100000 + 1000 × 2 = 102000 micro-dollars. The ledger's clock is HUNTAWAY_TEST_NOW, starting at T0.
  const cases = [
    ["input above the estimate, by one token", h.usage(1165, 5)],
    ["output above --max-tokens", h.usage(1000, 1001)],
    ["a cost above the reservation", h.usage(205000, 5)],
    ["non-zero cache_creation_input_tokens", h.usage(1000, 5, "standard", { cache_creation_input_tokens: 100 })],
    ["non-zero cache_read_input_tokens", h.usage(1000, 5, "standard", { cache_read_input_tokens: 100 })],
  ];
  for (const [what, use] of cases) {
    const dirs = h.makeDirs();
    const now = h.at(h.T0);
    const doctorEnv = { ANTHROPIC_API_KEY: KEY, ...h.ROOMY, ...now };
    const failsBefore = h.failLines((await h.doctor({ dirs, env: doctorEnv })).stdout);
    stand.scenario = { count: h.countOk(1000), billed: h.answer({ use }) };
    const r = await ask(["--max-tokens", "1000", Q], dirs, now);
    assert.equal(billedCalls(r), 1, what);
    assert.equal(r.code, 0, `${what}: the answer was printed, so it exits 0`);
    assert.equal(r.stdout, `${h.ANSWER}\n`, what);
    assert.match(r.stderr, /warning/i, `${what}: a warning is printed`);
    const failsAfter = h.failLines((await h.doctor({ dirs, env: doctorEnv })).stdout);
    assert.ok(failsAfter.length > failsBefore.length, `${what}: doctor shows the overrun as a FAIL`);
    assertBlocked(await nextAsk(dirs, now), `${what}: the next call to hwtest-model`);
    // Thirty days later, past any pruning, it still stops the model: overrun rows are never pruned. In between,
    // hwtest.model (another model, the same safety revision) runs, and a price change to an unrelated model (the
    // default one, raised by an override) lifts nothing.
    const later = h.at(h.T0 + 30 * h.DAY);
    assertBlocked(await nextAsk(dirs, later), `${what}: 30 days on`);
    stand.scenario = { count: h.countOk(10), billed: h.answer({ use: h.usage(10, 5) }) };
    const other = await h.askDot([h.QUESTION], { dirs, stand, env: { ANTHROPIC_API_KEY: KEY, ...later } });
    assert.equal(other.code, 0, `${what}: another model is not stopped: ${other.stderr}`);
    assert.equal(billedCalls(other), 1, what);
    assertBlocked(await nextAsk(dirs, { ...later, [h.DEFAULT_OVERRIDE]: "100,100" }), `${what}: after an unrelated price change`);
    assertBlocked(await nextAsk(dirs, later), `${what}: still, after other rows could be pruned`);
  }
  // At the bounds exactly (1164 input, 1000 output) there's no overrun, and the model keeps running.
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(1000), billed: h.answer({ use: h.usage(1164, 1000) }) };
  const atBound = await ask(["--max-tokens", "1000", Q], dirs);
  assert.equal(atBound.code, 0, atBound.stderr);
  assert.doesNotMatch(atBound.stderr, /warning/i);
  assert.equal(billedCalls(await nextAsk(dirs)), 1, "no overrun, so the next call runs");
});

test("an input overrun inside the reservation's dollars still blocks the model", async () => {
  // count 1000: an estimated input of 1164 tokens. 1165 input + 5 output tokens cost 1175 micro-dollars: far inside the
  // big question's 102000 micro-dollars reservation (and its 100000-token hard input), and inside the 3164
  // micro-dollars estimate too. It's an overrun all the same: the count was wrong.
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(1000), billed: h.answer({ use: h.usage(1165, 5) }) };
  const r = await ask(["--max-tokens", "1000", Q], dirs);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /warning/i);
  assert.ok(h.ledgerHas(dirs, 1175), "settled from validated usage, inside the reservation");
  assertBlocked(await nextAsk(dirs), "the next call to hwtest-model");
});

test("Anthropic: non-zero cache tokens are an overrun, settled at the cache-write premium of twice the input price", async () => {
  // Huntaway sends no cache_control. 1000 input, 100 cache and 5 output tokens: 1000 + 100 × 2 + 5 × 2 = 1210 micro-dollars.
  for (const field of ["cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(1000), billed: h.answer({ use: h.usage(1000, 5, "standard", { [field]: 100 }) }) };
    const r = await ask(["--max-tokens", "1000", Q], dirs);
    assert.equal(r.code, 0, `${field}: ${r.stderr}`);
    assert.match(r.stderr, /warning/i, field);
    assert.ok(h.ledgerHas(dirs, 1210), `${field}: settled at 2× the input price for the cache tokens`);
    assertBlocked(await nextAsk(dirs), field);
  }
});

test("Anthropic: stop_reason refusal ran and was refused: a fixed message, settled from validated usage, and no block", async () => {
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10000), billed: h.answer({ text: null, stop: "refusal", use: h.usage(10000, 5000) }) };
  const r = await ask5000(dirs);
  assert.equal(billedCalls(r), 1);
  assert.equal(r.code, 1, "no answer was printed");
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /refus/i, "says the model refused");
  assert.doesNotMatch(r.stderr, /warning/i, "not an overrun");
  assert.deepEqual(await usedNow(dirs), { used: "0.02", cap: "5.00" }, "settled from usage: 10000 + 5000 × 2 micro-dollars");
  assert.equal(billedCalls(await nextAsk(dirs)), 1, "the model isn't stopped");
});

test("the window is the last 24 hours of UTC start times: a row 23 hours old counts, 25 hours old doesn't, a future-dated one does", async () => {
  // A day cap of $0.15 holds one reservation of $0.11, never two. A 5xx keeps its reservation.
  const caps = { HUNTAWAY_MAX_USD_PER_QUESTION: "0.15", HUNTAWAY_MAX_USD_PER_DAY: "0.15" };
  const env = (ms) => ({ ...caps, ...h.at(ms) });
  const held = () => ({ count: h.countOk(10000), billed: h.apiError(500) });
  const dirs = h.makeDirs();
  stand.scenario = held();
  assert.equal(billedCalls(await ask5000(dirs, env(h.T0))), 1);
  stand.scenario = held();
  assertBlocked(await ask5000(dirs, env(h.T0)), "$0.11 held + $0.11 more is over $0.15");
  stand.scenario = held();
  assertBlocked(await ask5000(dirs, env(h.T0 + 23 * h.HOUR)), "23 hours old: still in the window");
  assert.deepEqual(await usedNow(dirs, env(h.T0 + 23 * h.HOUR)), { used: "0.11", cap: "0.15" });
  assert.deepEqual(await usedNow(dirs, env(h.T0 + 25 * h.HOUR)), { used: "0.00", cap: "0.15" });
  stand.scenario = held();
  assert.equal(billedCalls(await ask5000(dirs, env(h.T0 + 25 * h.HOUR))), 1, "25 hours old: out of the window");

  const future = h.makeDirs();
  stand.scenario = held();
  assert.equal(billedCalls(await ask5000(future, env(h.T0 + 48 * h.HOUR))), 1);
  stand.scenario = held();
  assertBlocked(await ask5000(future, env(h.T0)), "a row dated two days ahead still counts");
  assert.deepEqual(await usedNow(future, env(h.T0)), { used: "0.11", cap: "0.15" });
});

test("the day total takes each row's settled amount when it has one, else its reservation", async () => {
  const env = { HUNTAWAY_MAX_USD_PER_QUESTION: "0.15", HUNTAWAY_MAX_USD_PER_DAY: "0.15" };
  const settled = h.makeDirs();
  stand.scenario = { count: h.countOk(10000), billed: h.answer({ use: h.usage(10000, 5000) }) };
  assert.equal((await ask5000(settled, env)).code, 0);
  stand.scenario = { count: h.countOk(10000), billed: h.answer({ use: h.usage(10000, 5000) }) };
  const second = await ask5000(settled, env);
  assert.equal(billedCalls(second), 1, "$0.02 settled + a $0.11 reservation fits in $0.15 ($0.11 + $0.11 wouldn't)");
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(await usedNow(settled, env), { used: "0.04", cap: "0.15" });
});

test("the ledger fails closed: one that can't be opened or read, or has another schema version, means nothing is sent, not even the count", async () => {
  const prepared = [
    ["a folder in its place", (dirs) => mkdirSync(dirs.ledger)],
    ["not a database", (dirs) => writeFileSync(dirs.ledger, "this is not a database\n".repeat(200), { mode: 0o600 })],
    ["another schema version", (dirs) => {
      const db = new DatabaseSync(dirs.ledger);
      db.exec("CREATE TABLE ledger_from_the_future (id INTEGER PRIMARY KEY, anything TEXT); PRAGMA user_version = 999;");
      db.close();
      chmodSync(dirs.ledger, 0o600);
    }],
  ];
  for (const [what, prepare] of prepared) {
    const dirs = h.makeDirs();
    mkdirSync(dirs.hw, { mode: 0o700 });
    prepare(dirs);
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await ask([h.QUESTION], dirs);
    assert.equal(r.code, 1, what);
    assert.equal(r.seen.length, 0, `${what}: nothing sent`);
  }
  if (!isRoot) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    assert.equal((await ask([h.QUESTION], dirs)).code, 0, "a first ask makes the ledger");
    chmodSync(dirs.ledger, 0o000);
    try {
      stand.scenario = { count: h.countOk(10), billed: h.answer() };
      const r = await ask([h.QUESTION], dirs);
      assert.equal(r.code, 1);
      assert.equal(r.seen.length, 0, "an unreadable ledger: nothing sent");
    } finally {
      chmodSync(dirs.ledger, 0o600);
    }
  }
});

test("a ledger that can't be locked in time (busy_timeout 5 seconds) means nothing billed", async () => {
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  assert.equal((await ask([h.QUESTION], dirs)).code, 0, "a first ask makes the ledger");
  const holder = new DatabaseSync(dirs.ledger);
  holder.exec("PRAGMA busy_timeout = 1000");
  holder.exec("BEGIN EXCLUSIVE");
  try {
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await ask([h.QUESTION], dirs);
    assert.equal(r.code, 1);
    assert.equal(billedCalls(r), 0, "the reservation could not be made, so nothing was billed");
    assert.ok(r.ms >= 4000, "it waited for the lock before refusing");
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("two asks at the same time can't both pass on the same headroom", async () => {
  // A day cap of $0.15 holds one $0.11 reservation, never two. Both pass the read-only look at the ledger (nothing is
  // used yet); both counts are held until both have arrived, so the two runs reach the reservation together; billed
  // calls are held until the race is decided, so a first run can't settle (and free headroom) before the second checks.
  const dirs = h.makeDirs();
  const env = { HUNTAWAY_MAX_USD_PER_QUESTION: "0.15", HUNTAWAY_MAX_USD_PER_DAY: "0.15" };
  stand.scenario = { count: h.countOk(10), billed: h.apiError(401) };          // settles at 0: makes the files first
  assert.equal(billedCalls(await ask5000(dirs, env)), 1);
  const counts = [];
  const held = [];
  let released = false;
  const answer = h.answer({ use: h.usage(10000, 5000) });
  stand.scenario = {
    count: (res) => new Promise((resolve) => {
      counts.push(() => {
        h.send(res, 200, { input_tokens: 10000 });
        resolve();
      });
      if (counts.length >= 2) counts.forEach((go) => go());
      else setTimeout(() => counts.forEach((go) => go()), 8000).unref();
    }),
    billed: (res, record) => new Promise((resolve) => {
      const go = () => {
        answer(res, record);
        resolve();
      };
      if (released) go();
      else held.push(go);
    }),
  };
  stand.seen = [];
  let exited = 0;
  const runs = [0, 1].map(() => ask5000Raw(dirs, env).then((r) => {
    exited += 1;
    return r;
  }));
  const deadline = Date.now() + 40_000;
  while (held.length + exited < 2 && Date.now() < deadline) await h.delay(50);
  released = true;
  held.splice(0).forEach((go) => go());
  const results = await Promise.all(runs);
  assert.equal(stand.of("count").length, 2, "both runs got as far as the count");
  assert.equal(stand.of("billed").length, 1, "exactly one billed call between them");
  const refused = results.filter((r) => r.code !== 0);
  assert.equal(refused.length, 1, results.map((r) => r.stderr).join("\n---\n"));
  assert.equal(refused[0].code, 1);
  assert.match(refused[0].stderr, /\bday\b|24 hours/i, "the other was refused by the day cap");
});

/** ask5000 without resetting the stand-in's list, for runs that overlap. */
function ask5000Raw(dirs, env) {
  return h.ask(["--max-tokens", "5000", Q], { dirs, stand, reset: false, env: { ANTHROPIC_API_KEY: KEY, ...env } });
}

test("no ledger yet: status shows nothing used, and reading the spend reserves nothing", async () => {
  const dirs = h.makeDirs();
  const st = await h.status({ dirs, env: { ANTHROPIC_API_KEY: KEY } });
  assert.deepEqual(h.usedOf(st.stdout), { used: "0.00", cap: "5.00" });
  assert.ok(!existsSync(dirs.ledger) || h.ledgerRows(dirs).every((row) => !Object.values(row).includes(h.MODEL)),
    "reading the spend never reserves anything");
});

test("scripts/uninstall-local.sh keeps spend.sqlite, and --purge-history removes it with the rest of the history", async () => {
  // Run as tests/install.test.mjs runs it: `sh` with HOME set and no inherited Huntaway or git settings. The
  // uninstaller touches only HOME, so it runs from this checkout. The ask leaves its files in the default data folder.
  const UNINSTALL = fileURLToPath(new URL("../scripts/uninstall-local.sh", import.meta.url));
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUNTAWAY_") && !k.startsWith("GIT_")));
  const uninstall = (args, home) => spawnSync("sh", [UNINSTALL, ...args], { encoding: "utf8", env: { ...baseEnv, HOME: home } });
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(100), billed: h.answer({ use: h.usage(100, 5) }) };
  const r = await ask([h.QUESTION], dirs, { HUNTAWAY_HOME: undefined });
  assert.equal(r.code, 0, r.stderr);
  const root = join(dirs.home, ".local", "share", "huntaway");
  const spend = ["spend.sqlite", "spend.sqlite-wal", "spend.sqlite-shm", "spend.sqlite-journal"].map((f) => join(root, f));
  assert.ok(existsSync(spend[0]), "the ledger is in Huntaway's data folder, next to the request log");
  for (const side of spend.slice(1)) if (!existsSync(side)) writeFileSync(side, "x", { mode: 0o600 });
  const keep = uninstall([], dirs.home);
  assert.equal(keep.status, 0, keep.stderr);
  for (const f of spend) assert.ok(existsSync(f), `${f.slice(root.length)} kept without --purge-history`);
  const purge = uninstall(["--purge-history"], dirs.home);
  assert.equal(purge.status, 0, purge.stderr);
  assert.match(purge.stdout, /history deleted$/m, "every file the paid ask left is one the purge knows");
  for (const f of spend) assert.ok(!existsSync(f), `${f.slice(root.length)} removed`);
  assert.ok(!existsSync(root), "history and its folder deleted");
});

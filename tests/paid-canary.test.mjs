// The canary tests, the proof of the rule that the key never appears in a
// log, the ledger, a job record or an error. Every outcome runs twice, each time with its own
// unique hwtest- canary key: once from ANTHROPIC_API_KEY, once from the fake keychain (stored with `huntaway key set`).
// Each run then checks that the canary appears nowhere but the x-api-key header of the stand-in's requests: not in
// stdout or stderr (both notice lines included, and key set's own output), not in any file under the test HOME and
// TMP (the request log and the ledger included; only HUNTAWAY_TEST_KEYCHAIN_FILE is excluded), and not in any other
// part of any request. The stand-in tries to bounce the canary back in error messages, bodies and usage fields.
// Each run also checks it got as far as its outcome needs, so a run that quietly sent nothing can't pass. The fake
// keychain works on every platform, so both runs happen everywhere, Linux included.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import * as h from "./lib/paid-harness.mjs";

let stand;
let closed;
before(async () => {
  stand = await h.startStandIn();
  closed = await h.closedUrl();
});
after(async () => {
  await stand.close();
});

// count 1000: an estimated input of 1164 tokens. --max-tokens 1000 throughout (a reservation of (2 × B + 64) + 2000
// micro-dollars for the question's body of B bytes, about 2364), unless a case says otherwise. Usage stays inside that
// reservation and the hard input, so only the cases that mean one are overruns.
const fine = () => h.countOk(1000);
const answered = (extra = {}) => () => h.answer({ use: h.usage(100, 5), ...extra });

/**
 * A big question asked earlier with another key, at --max-tokens 4000, whose 5xx keeps its reservation of
 * 100000 + 4000 × 2 = 108000 micro-dollars: a $0.11 day cap then has 2000 micro-dollars of room, less than this
 * question's reservation, whose 1000 output tokens alone cost 2000 on top of its input. (On an empty ledger the day
 * cap, at least the per-question cap, always holds one hard worst case.)
 */
async function spendTheDay(dirs) {
  stand.scenario = { count: fine(), billed: h.apiError(500) };
  const prior = await h.ask(["--max-tokens", "4000", h.BIG_QUESTION], { dirs, stand,
    env: { ANTHROPIC_API_KEY: h.newKey("prior"), HUNTAWAY_MAX_USD_PER_QUESTION: "0.11", HUNTAWAY_MAX_USD_PER_DAY: "0.11" } });
  assert.equal(stand.of("billed", prior.seen).length, 1, `the earlier question was sent: ${prior.stderr}`);
}

/** reach: what the stand-in must have seen. "both": one count then one billed call; "count": the count only; "none": nothing at all. */
const OUTCOMES = [
  { name: "success", count: fine, billed: answered(), reach: "both", then: (r) => assert.equal(r.code, 0, r.stderr) },
  { name: "success cut short", count: fine, billed: () => h.answer({ text: "cut sho", stop: "max_tokens", use: h.usage(100, 1000) }), reach: "both",
    then: (r) => assert.equal(r.stdout, "cut sho\n") },
  { name: "cut short with no text", count: fine, billed: () => h.answer({ text: null, stop: "max_tokens", use: h.usage(100, 1000) }), reach: "both",
    then: (r) => assert.match(r.stderr, /before any text/) },
  ...[400, 401, 403, 404, 413, 429, 529].map((status) => (
    { name: `refused status ${status}`, count: fine, billed: (canary) => h.apiError(status, `bad key ${canary}`), reach: "both" })),
  { name: "a 5xx", count: fine, billed: (canary) => h.apiError(500, `internal ${canary}`), reach: "both" },
  { name: "an unreadable body", count: fine, billed: (canary) => h.garbage(`not json ${canary}`), reach: "both" },
  { name: "missing usage", count: fine, billed: answered({ use: undefined }), reach: "both" },
  { name: "unreadable usage", count: fine, billed: (canary) => h.answer({ use: { input_tokens: canary, output_tokens: canary, service_tier: canary } }), reach: "both" },
  { name: "a non-standard tier", count: fine, billed: answered({ use: h.usage(100, 5, "priority") }), reach: "both" },
  { name: "a refused count", count: (canary) => h.apiError(401, `bad key ${canary}`), billed: answered(), reach: "count" },
  { name: "an unreadable count", count: (canary) => h.garbage(`{"input_tokens": "${canary}"`), billed: answered(), reach: "count" },
  { name: "a timeout", count: fine, billed: () => h.hang(), args: ["--timeout", "1"], reach: "both" },
  { name: "a connection that can't be made", count: fine, billed: answered(), env: () => ({ HUNTAWAY_TEST_ANTHROPIC_URL: closed }), reach: "none" },
  { name: "a redirect", count: fine, billed: (canary) => h.redirectTo(`${stand.origin}/elsewhere?key=${canary}`), reach: "both" },
  // A big question's hard worst case at --max-tokens 1000 is 100000 + 2000 = 102000 micro-dollars, over a $0.10 cap:
  // refused at the caps, before line 1 and the key.
  { name: "over the per-question cap", count: fine, billed: answered(), question: h.BIG_QUESTION,
    env: () => ({ HUNTAWAY_MAX_USD_PER_QUESTION: "0.10" }), reach: "none", then: (r) => assert.doesNotMatch(r.stderr, h.ANY_LINE1) },
  // No day headroom: refused by the read-only look at the ledger, after line 1 and before the count.
  { name: "over the per-day cap", count: fine, billed: answered(), prepare: spendTheDay,
    env: () => ({ HUNTAWAY_MAX_USD_PER_QUESTION: "0.11", HUNTAWAY_MAX_USD_PER_DAY: "0.11" }), reach: "none",
    then: (r) => assert.match(r.stderr, h.ANY_LINE1) },
  { name: "a ledger that can't be opened", count: fine, billed: answered(), reach: "none",
    prepare: (dirs) => { mkdirSync(dirs.hw, { mode: 0o700 }); mkdirSync(dirs.ledger); } },
  { name: "an overrun", count: fine, billed: answered({ use: h.usage(1165, 5) }), reach: "both",
    then: (r) => {
      assert.equal(r.code, 0, "the answer was printed");
      assert.match(r.stderr, /warning/i);
    } },
];

function checkReach(reach, seen, what) {
  const kinds = seen.map((c) => c.kind);
  if (reach === "both") assert.deepEqual(kinds, ["count", "billed"], what);
  else if (reach === "count") assert.deepEqual(kinds, ["count"], what);
  else assert.deepEqual(kinds, [], what);
}

for (const outcome of OUTCOMES) {
  test(`canary: ${outcome.name}`, async () => {
    for (const source of ["env", "keychain"]) {
      const what = `${outcome.name}, key from ${source}`;
      const dirs = h.makeDirs();
      const canary = h.newKey(`canary-${source === "env" ? "e" : "k"}`);
      const runs = [];
      if (source === "keychain") {
        const set = await h.keySet(canary, { dirs });
        runs.push(set);
        assert.equal(set.code, 0, `${what}: key set: ${set.stderr}`);
      }
      await outcome.prepare?.(dirs);
      stand.scenario = { count: outcome.count(canary), billed: outcome.billed(canary) };
      const env = { ...(outcome.env?.() ?? {}), ANTHROPIC_API_KEY: source === "env" ? canary : undefined };
      const r = await h.ask([...(outcome.args ?? []), "--max-tokens", "1000", outcome.question ?? h.QUESTION], { dirs, stand, env });
      runs.push(r);
      checkReach(outcome.reach, r.seen, what);
      for (const call of r.seen) assert.equal(call.headers["x-api-key"], canary, `${what}: the key goes in its one header`);
      if (outcome.reach !== "none") {
        assert.match(r.stderr, h.ANY_LINE1, `${what}: line 1 was printed (and checked)`);
      }
      if (outcome.reach === "both") assert.match(r.stderr, h.ANY_LINE2, `${what}: line 2 was printed (and checked)`);
      outcome.then?.(r);
      assert.deepEqual(h.leaksOf(canary, { runs, dirs, seen: r.seen }), [], `${what}: the canary appears nowhere else`);
    }
  });
}

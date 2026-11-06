// The paid layer with the Anthropic engine on it: the count and
// the billed call, the options, the caps (both against the hard worst case), price overrides, micro-dollar rounding,
// the two notice lines, the order of refusals, doctor's and status's spend lines, and the no-text message. With
// hwtest-model one input token costs one micro-dollar and one output token two at standard prices (two and four at
// priority, used only to settle a call reported at a non-standard tier), so every amount below can be worked out by
// hand, with B the UTF-8 bytes of the billed request body the stand-in received (the NFKC rule makes B the larger of that and
// the body's bytes with the question NFKC-normalized; the questions here are ones NFKC doesn't grow, and
// tests/paid-nfkc.test.mjs covers the ones it does):
//   estimated input      = count × 1.10 + 64 tokens
//   estimated worst case = estimated input × 1 + --max-tokens × 2 micro-dollars (information only: it never admits a call)
//   hard input           = min(100000, 2 × B + 64) tokens (never checked against the count before the call)
//   hard worst case      = hard input × 1 + --max-tokens × 2 micro-dollars (the standard price; both caps use it)
//                          h.QUESTION's body is about 150 bytes: about 2412 micro-dollars, $0.01, at the default --max-tokens;
//                          h.BIG_QUESTION's is over 49,968: 102048 micro-dollars, which needs a $0.11 cap
// Both test models share one override name, so overrides are tested on the default model, raised to $100 per million
// tokens (far above any real price) and with roomy caps.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import * as h from "./lib/paid-harness.mjs";

let stand;
before(async () => {
  stand = await h.startStandIn();
});
after(async () => {
  await stand.close();
});

const KEY = h.newKey("layer");
const withKey = (env = {}) => ({ ANTHROPIC_API_KEY: KEY, ...env });
const ask = (args, dirs, env) => h.ask(args, { dirs, stand, env: withKey(env) });
const askDot = (args, dirs, env) => h.askDot(args, { dirs, stand, env: withKey(env) });
const askDefault = (args, dirs, env) => h.askDefaultModel(args, { dirs, stand, env: withKey({ ...h.ROOMY, ...env }) });
const kinds = (r) => r.seen.map((c) => c.kind);
const QCAP = "HUNTAWAY_MAX_USD_PER_QUESTION";
const DCAP = "HUNTAWAY_MAX_USD_PER_DAY";

test("one count, then one billed call: the same key and API version, the counted messages, service_tier standard_only", async () => {
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(100), billed: h.answer({ use: h.usage(100, 5) }) };
  const r = await ask(["--max-tokens", "300", h.QUESTION], dirs);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${h.ANSWER}\n`);
  assert.deepEqual(kinds(r), ["count", "billed"], "exactly one count, then exactly one billed call");
  const [count, billed] = r.seen;
  for (const call of [count, billed]) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers["x-api-key"], KEY);
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
  }
  assert.deepEqual(JSON.parse(billed.body), {
    model: h.MODEL, max_tokens: 300, messages: [{ role: "user", content: h.QUESTION }], service_tier: "standard_only",
  }, "thinking stays off, and the price stays at the standard tier");
  const counted = JSON.parse(count.body);
  assert.equal(counted.model, h.MODEL);
  assert.deepEqual(counted.messages, [{ role: "user", content: h.QUESTION }], "the count counts what the billed call sends");
});

test("options: --effort, --family codex, --max-tokens out of 1-8192 and --timeout above 300 are usage errors; --max-tokens works", async () => {
  // (These usage errors hold today too; the end of this test, through the count and the billed call, is new.)
  for (const args of [["--effort", "low", "hi"], ["--family", "codex", "hi"], ["--max-tokens", "0", "hi"],
    ["--max-tokens", "8193", "hi"], ["--timeout", "301", "hi"]]) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await ask(args, dirs);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.seen.length, 0, `${args.join(" ")}: nothing sent`);
    assert.doesNotMatch(r.stderr, h.ANY_LINE1, "a usage error comes before the notice");
  }
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const r = await ask(["--family", "claude", "--max-tokens", "777", "--timeout", "300", "hi"], dirs);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kinds(r), ["count", "billed"]);
  assert.equal(JSON.parse(r.seen[1].body).max_tokens, 777);
});

test("a model that isn't in the capability table is refused before anything is sent", async () => {
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const r = await h.runCli(["ask", "--engine", "anthropic", "--model", "claude-not-in-the-table-1", "hi"], { dirs, stand, env: withKey() });
  assert.notEqual(r.code, 0);
  assert.equal(r.seen.length, 0);
});

test("the notice: line 1 before the count; line 2 (At most, about, used) before the billed call; used leaves out this question's own reservation", async () => {
  const dirs = h.makeDirs();
  // A first, big question (a reservation of 110000 micro-dollars, so its usage is no overrun) settles at
  // 10000 + 5000 × 2 = 20000 micro-dollars = $0.02.
  stand.scenario = { count: h.countOk(10000), billed: h.answer({ use: h.usage(10000, 5000) }) };
  const first = await ask(["--max-tokens", "5000", h.BIG_QUESTION], dirs);
  assert.equal(first.code, 0, first.stderr);
  // The second, small, at the default --max-tokens: at most (2 × B + 64) + 1024 × 2 micro-dollars for its body of B
  // bytes, shown rounded up to the cent (about 2412 micro-dollars, $0.01; under the old rule it was $0.21). Counted at
  // 1070: an estimated input of 1177 + 64 = 1241 tokens (more than the hard input: the count is never checked against
  // the byte bound before the call), so the estimate is 1241 + 1024 × 2 = 3289 micro-dollars, about $0.00329 to three
  // significant figures (rounded down it would be $0.00328). Used: the first question's $0.02, without this question's
  // own reservation.
  stand.scenario = { count: h.countOk(1070), billed: h.answer({ use: h.usage(100, 5) }) };
  const r = await ask([h.QUESTION], dirs);
  assert.equal(r.code, 0, r.stderr);
  const [count, billed] = r.seen;
  assert.equal(count?.kind, "count");
  assert.equal(billed?.kind, "billed");
  const LINE2 = h.line2(h.centsUp(h.hardWorst(h.bodyBytes(billed))), ["0.00329"], "0.02", "5.00");
  assert.match(count.stderrAtArrival, h.line1("0.50", "5.00"), "line 1 is out before the count is sent");
  assert.doesNotMatch(count.stderrAtArrival, h.ANY_LINE2, "line 2 waits for the count and the reservation");
  assert.match(billed.stderrAtArrival, LINE2, "line 2 is out before the billed call is sent");
  assert.equal(r.stderr.split("\n").filter((l) => h.ANY_LINE1.test(l)).length, 1, "line 1 once");
  assert.equal(r.stderr.split("\n").filter((l) => h.ANY_LINE2.test(l)).length, 1, "line 2 once");
  assert.doesNotMatch(r.stderr, /price override/i, "no override, so no override words");
});

test("line 1 shows the caps as set, and says when a price override is in use", async () => {
  // "hi" has a body of about 120 bytes: a hard worst case of about 2350 micro-dollars, which even $0.01 holds (there is
  // no longer a $0.21 minimum for hwtest-model).
  for (const [q, d, shownQ, shownD] of [["1.25", "40", "1.25", "40.00"], ["0.20", "1000", "0.20", "1000.00"],
    ["5", "5.00", "5.00", "5.00"], ["0.5", "12.3", "0.50", "12.30"], ["0.01", "0.01", "0.01", "0.01"]]) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await ask(["hi"], dirs, { [QCAP]: q, [DCAP]: d });
    assert.match(r.stderr, h.line1(shownQ, shownD), `${q} / ${d}`);
    assert.equal(stand.of("count", r.seen).length, 1, `${q} / ${d} are valid caps that hold this small question's hard worst case: the count was sent`);
  }
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const r = await askDefault(["hi"], dirs, { [h.DEFAULT_OVERRIDE]: "100,100" });
  assert.match(r.stderr, /^This question uses your paid Anthropic API key;[^\n]*A price override is in use\./m);
  assert.match(r.seen[0]?.stderrAtArrival ?? "", /A price override is in use\./, "on line 1 itself, before the count");
});

test("caps are required: missing or invalid caps refuse before anything is sent, even the count, naming both settings", async () => {
  const cases = [[undefined, "5.00"], ["0.50", undefined], [undefined, undefined], ["", "5.00"], ["0.50", ""],
    ["2.00", "1.99"]];                                                  // the per-day cap below the per-question cap
  for (const bad of ["0", "0.00", "0.001", "0.009", "1000.01", "1001", "-1", "abc", "1e2", "0x10", "1.234", "$1", "1,00",
    " 1", "1 ", "Infinity", "NaN"]) {
    cases.push([bad, "1000"], ["0.50", bad]);
  }
  for (const [q, d] of cases) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await ask(["hi"], dirs, { [QCAP]: q, [DCAP]: d });
    const what = `question ${JSON.stringify(q)}, day ${JSON.stringify(d)}`;
    assert.equal(r.code, 1, what);
    assert.equal(r.seen.length, 0, `${what}: nothing sent, not even the count`);
    assert.match(r.stderr, /HUNTAWAY_MAX_USD_PER_QUESTION/, what);
    assert.match(r.stderr, /HUNTAWAY_MAX_USD_PER_DAY/, what);
    assert.match(r.stderr, /HUNTAWAY_MAX_USD_PER_(?:QUESTION|DAY)=[0-9]/, `${what}: with an example`);
    // The example is $1.00 a question and $10.00 a day, no longer $20 and $50.
    assert.match(r.stderr, /HUNTAWAY_MAX_USD_PER_QUESTION=1(?:\.00?)?(?![\d.])/, `${what}: the example's $1.00 a question`);
    assert.match(r.stderr, /HUNTAWAY_MAX_USD_PER_DAY=10(?:\.00?)?(?![\d.])/, `${what}: the example's $10.00 a day`);
    assert.doesNotMatch(r.stderr, /HUNTAWAY_MAX_USD_PER_(?:QUESTION=20|DAY=50)\b/, `${what}: not the old example`);
    assert.doesNotMatch(r.stderr, h.ANY_LINE1, what);
  }
});

test("the per-question cap applies to this question's hard worst case, whatever the count says: a big question is refused at $0.10 before anything is sent and runs at $0.11; a small one runs at $0.20", async () => {
  // h.BIG_QUESTION's body is over 49,968 bytes, so the 100000-token limit binds: 102048 micro-dollars at the default
  // --max-tokens, which needs $0.11.
  const refusedDirs = h.makeDirs();
  stand.scenario = { count: h.countOk(1), billed: h.answer() };
  const refused = await ask([h.BIG_QUESTION], refusedDirs, { [QCAP]: "0.10" });
  assert.equal(refused.code, 1);
  assert.equal(refused.seen.length, 0, "over the per-question cap: not even the count is sent");
  assert.doesNotMatch(refused.stderr, h.ANY_LINE1, "refused at the caps, before notice line 1");
  assert.match(refused.stderr, /\$0\.11\b/, "names the cap this question needs (102048 micro-dollars, rounded up)");
  assert.match(refused.stderr, /HUNTAWAY_MAX_USD_PER_QUESTION/, "names the setting to raise");
  // The cap named is this question's at its own settings: at --max-tokens 8192, 100000 + 16384 = 116384 micro-dollars, $0.12.
  const higherDirs = h.makeDirs();
  stand.scenario = { count: h.countOk(1), billed: h.answer() };
  const higher = await ask(["--max-tokens", "8192", h.BIG_QUESTION], higherDirs, { [QCAP]: "0.10" });
  assert.equal(higher.code, 1);
  assert.equal(higher.seen.length, 0);
  assert.match(higher.stderr, /\$0\.12\b/, "names the cap this question needs at --max-tokens 8192");
  // Counted at 90000, the estimate is 99064 + 2048 = 101112 micro-dollars ($0.10); $0.11 holds the hard worst case, so it runs.
  const allowedDirs = h.makeDirs();
  stand.scenario = { count: h.countOk(90000), billed: h.answer({ use: h.usage(1000, 5) }) };
  const allowed = await ask([h.BIG_QUESTION], allowedDirs, { [QCAP]: "0.11" });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.deepEqual(kinds(allowed), ["count", "billed"]);
  assert.match(allowed.stderr, h.atMost("0.11"), "at most $0.11 (102048 micro-dollars, rounded up)");
  // A small question's hard worst case is far less: the earlier $0.21 minimum is gone, and $0.20 runs it.
  const smallDirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const small = await ask([h.QUESTION], smallDirs, { [QCAP]: "0.20", [DCAP]: "5.00" });
  assert.equal(small.code, 0, small.stderr);
  assert.deepEqual(kinds(small), ["count", "billed"]);
  assert.match(small.stderr, h.atMost(h.centsUp(h.hardWorst(h.bodyBytes(small.seen[1])))),
    "at most the byte bound's figure: (2 × B + 64) + 1024 × 2 micro-dollars, rounded up");
  // --max-tokens 5000 on the big question: 100000 + 10000 = 110000 micro-dollars, exactly $0.11, isn't over it; 5001
  // (110002 micro-dollars) is.
  const exact = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const equal = await ask(["--max-tokens", "5000", h.BIG_QUESTION], exact, { [QCAP]: "0.11" });
  assert.equal(equal.code, 0, `a hard worst case equal to the cap isn't over it: ${equal.stderr}`);
  assert.deepEqual(kinds(equal), ["count", "billed"]);
  const over = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const above = await ask(["--max-tokens", "5001", h.BIG_QUESTION], over, { [QCAP]: "0.11" });
  assert.equal(above.code, 1);
  assert.equal(above.seen.length, 0, "2 micro-dollars over: refused before anything is sent");
});

test("the hard input is min(100000, 2 × the billed body's UTF-8 bytes + 64), whatever the count says: a count above it is never refused before the call", async () => {
  // A question of multi-byte characters, so its UTF-8 bytes are far more than its length in characters. Counted at
  // 5000, far above its hard input: there is no check of the count against the byte bound before the call, so the
  // billed call is sent, and the reservation is the byte bound's figure for the body the stand-in received.
  const dirs = h.makeDirs();
  const wide = `${"🦘é→".repeat(60)} ${h.QUESTION}`;
  stand.scenario = { count: h.countOk(5000), billed: h.answer({ use: h.usage(100, 5) }) };
  const r = await ask(["--max-tokens", "1000", wide], dirs);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kinds(r), ["count", "billed"], "a count above the hard input is not a refusal");
  const billed = r.seen[1];
  assert.ok(2 * h.bodyBytes(billed) + 64 < 5000 * 1.1 + 64, "the count is above the hard input");
  assert.ok(h.ledgerHas(dirs, h.hardWorst(h.bodyBytes(billed), 1000)),
    `the reservation is (2 × ${h.bodyBytes(billed)} + 64) + 1000 × 2 micro-dollars: UTF-8 bytes of the whole body, at the standard price`);
  if (h.bodyBytes(billed) !== billed.body.length) {
    // (Unless the body escapes every non-ASCII character, when the two are the same.)
    assert.ok(!h.ledgerHas(dirs, h.hardWorst(billed.body.length, 1000)), "bytes, not characters");
  }
  // A big question: the 100000-token limit binds, at the standard price: 100000 + 1024 × 2 = 102048 micro-dollars, $0.11.
  const big = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const limited = await ask([h.BIG_QUESTION], big);
  assert.equal(limited.code, 0, limited.stderr);
  assert.ok(h.bodyBytes(limited.seen[1]) >= 49968, "the body reaches the limit");
  assert.ok(h.ledgerHas(big, h.limitWorst()), "the reservation is 102048 micro-dollars");
  assert.match(limited.stderr, h.atMost("0.11"), "at most $0.11 (to the nearest cent it would be $0.10)");
});

test("micro-dollar rounding is up: the estimate, the shown cap, and a 100300.001001 micro-dollars cost settled as 100301", async () => {
  // count 7213, --max-tokens 1000: an estimated input of 7934.3 + 64 = 7998.3 tokens. At the standard prices the
  // estimate is 9998.3 micro-dollars, stored as 9999 (the priority price only settles a non-standard tier). Never rounded down.
  const stored = h.makeDirs();
  stand.scenario = { count: h.countOk(7213), billed: h.answer({ use: h.usage(100, 5) }) };
  const ran = await ask(["--max-tokens", "1000", h.QUESTION], stored);
  assert.equal(ran.code, 0, ran.stderr);
  assert.ok(h.ledgerHas(stored, 9999), "the estimated worst case is stored rounded up");
  assert.ok(!h.ledgerHas(stored, 9998), "never rounded down");
  const reserved = h.hardWorst(h.bodyBytes(ran.seen[1]), 1000);
  assert.ok(h.ledgerHas(stored, reserved), `the reservation is the hard worst case: (2 × B + 64) + 1000 × 2 = ${reserved}`);
  // The default model, raised to $100.000001 / $100 per million tokens: 1001 input and 2 output tokens cost
  // 100100.001001 + 200 = 100300.001001 micro-dollars. (A big question, so 1001 input tokens are inside its hard input.)
  const priced = h.makeDirs();
  stand.scenario = { count: h.countOk(1000), billed: h.answer({ use: h.usage(1001, 2) }) };
  const settled = await askDefault([h.BIG_QUESTION], priced, { [h.DEFAULT_OVERRIDE]: "100.000001,100" });
  assert.equal(settled.code, 0, settled.stderr);
  assert.ok(h.ledgerHas(priced, 100301), "the settled cost is rounded up");
  assert.ok(!h.ledgerHas(priced, 100300));
});

test("the per-day cap applies to the hard worst case of this request, whatever the count says, and is checked before the count", async () => {
  // A big question at --max-tokens 5000: the hard worst case is exactly 100000 + 5000 × 2 = 110000 micro-dollars, $0.11.
  // A first one's 5xx keeps its $0.11 reservation; a second needs $0.22 of day cap in all. Counted at 10, its estimate
  // would be only 75 + 10000 micro-dollars.
  for (const [day, fits] of [["0.21", false], ["0.22", true]]) {
    const dirs = h.makeDirs();
    const caps = { [QCAP]: "0.11", [DCAP]: day };
    stand.scenario = { count: h.countOk(10), billed: h.apiError(500) };
    const first = await ask(["--max-tokens", "5000", h.BIG_QUESTION], dirs, caps);
    assert.deepEqual(kinds(first), ["count", "billed"], `${day}: the first question was sent`);
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const second = await ask(["--max-tokens", "5000", h.BIG_QUESTION], dirs, caps);
    if (fits) {
      assert.equal(second.code, 0, `$0.11 held + $0.11 is exactly $0.22, not over it: ${second.stderr}`);
      assert.deepEqual(kinds(second), ["count", "billed"]);
    } else {
      assert.equal(second.code, 1);
      assert.equal(second.seen.length, 0, "no day headroom: refused by the read-only look at the ledger, before the count");
      assert.match(second.stderr, /\bday\b|24 hours/i);
      assert.match(second.stderr, h.line1("0.11", "0.21"), "after notice line 1");
      assert.doesNotMatch(second.stderr, h.ANY_LINE2);
      // The headroom left, $0.10, is too little for that request but holds a small one: about (2 × 150 + 64) + 10000
      // micro-dollars at the same --max-tokens. It reserves its own hard worst case.
      stand.scenario = { count: h.countOk(10), billed: h.answer() };
      const small = await ask(["--max-tokens", "5000", h.QUESTION], dirs, caps);
      assert.equal(small.code, 0, `a small question fits the headroom a big one doesn't: ${small.stderr}`);
      assert.deepEqual(kinds(small), ["count", "billed"]);
      assert.ok(h.ledgerHas(dirs, h.hardWorst(h.bodyBytes(small.seen[1]), 5000)), "reserved: this request's own hard worst case");
    }
  }
});

test("a price override can only raise prices: a raise is used for the caps, the cost and the priority price; a lower or malformed one is refused before anything is sent", async () => {
  // The caps: at a $0.01 cap the default model is refused on a big question with or without an override, naming the
  // cap this question needs; at $100 per million tokens that is at least 1024 output tokens' 102400 micro-dollars, $0.11,
  // and more than without the override.
  const needed = async (env) => {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await askDefault([h.BIG_QUESTION], dirs, { [QCAP]: "0.01", ...env });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.seen.length, 0);
    const named = h.centsIn(r.stderr).filter((c) => c !== 1 && c !== 100000);   // not the caps themselves
    assert.ok(named.length > 0, `the refusal names the cap the model needs: ${r.stderr}`);
    return Math.max(...named);
  };
  const plain = await needed({});
  const raised = await needed({ [h.DEFAULT_OVERRIDE]: "100,100" });
  assert.ok(raised > plain, `the raised prices are in the hard worst case: $${raised / 100} > $${plain / 100}`);
  assert.ok(raised >= 11, "at least $0.11");
  // The cost: 10000 input and 100 output tokens at $100 per million are 1000000 + 10000 micro-dollars = $1.01. At the table's
  // own prices it would be far less. (Big questions, so 10000 input tokens are inside the hard input.)
  const used = (dirs) => h.status({ dirs, env: h.ROOMY }).then((s) => h.usedOf(s.stdout));
  const costed = h.makeDirs();
  stand.scenario = { count: h.countOk(10000), billed: h.answer({ use: h.usage(10000, 100) }) };
  const ran = await askDefault([h.BIG_QUESTION], costed, { [h.DEFAULT_OVERRIDE]: "100,100" });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(await used(costed), { used: "1.01", cap: "1000.00" }, "settled at the raised price");
  // The priority price becomes at least the override: a priority-tier answer settles at $100 per million too.
  const priority = h.makeDirs();
  stand.scenario = { count: h.countOk(10000), billed: h.answer({ use: h.usage(10000, 100, "priority") }) };
  const tiered = await askDefault([h.BIG_QUESTION], priority, { [h.DEFAULT_OVERRIDE]: "100,100" });
  assert.equal(tiered.code, 0, tiered.stderr);
  assert.match(tiered.stderr, /warning/i, "a non-standard tier is an overrun");
  assert.deepEqual(await used(priority), { used: "1.01", cap: "1000.00" }, "settled at the override, not the table's lower priority price");
  // Lower (no real price is $0, or $0.000001), or malformed: refused at the caps step, naming the setting.
  for (const value of ["0,0", "0.000001,100", "100,0", "100", "100,100,100", "abc,def", "-2,4", "2;4", "100;100",
    "100.0000001,100", "1000.000001,100", "1e2,100", " 100,100", "100, 100", ","]) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await askDefault(["hi"], dirs, { [h.DEFAULT_OVERRIDE]: value });
    assert.equal(r.code, 1, value);
    assert.equal(r.seen.length, 0, `${value}: refused before anything is sent`);
    assert.match(r.stderr, new RegExp(h.DEFAULT_OVERRIDE), `${value}: the refusal names the setting`);
    assert.doesNotMatch(r.stderr, h.ANY_LINE1, `${value}: refused with the caps, before notice line 1`);
  }
});

test("a price override equal to the table's price is allowed", { skip: "needs a table model whose prices the tests know " +
  "and whose override name is its own: hwtest-model and hwtest.model share theirs, so any override of them is " +
  "refused as ambiguous, and the default model's table prices aren't the tests' to know" }, () => {});

test("a price override name that two table models map to is refused: hwtest-model and hwtest.model share one", async () => {
  // The control: hwtest.model is a model of its own, sent as itself.
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const plain = await askDot([h.QUESTION], dirs);
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(plain.seen.map((c) => JSON.parse(c.body).model), [h.MODEL_DOT, h.MODEL_DOT]);
  for (const [name, run] of [[h.MODEL, ask], [h.MODEL_DOT, askDot]]) {
    for (const value of ["2.00,4.00", "1.00,2.00", "1000,1000"]) {
      const fresh = h.makeDirs();
      stand.scenario = { count: h.countOk(10), billed: h.answer() };
      const r = await run([h.QUESTION], fresh, { [h.AMBIGUOUS_OVERRIDE]: value });
      assert.equal(r.code, 1, `${name} ${value}`);
      assert.equal(r.seen.length, 0, `${name} ${value}: nothing sent`);
      assert.match(r.stderr, new RegExp(h.AMBIGUOUS_OVERRIDE), `${name} ${value}: the refusal names the setting`);
      assert.doesNotMatch(r.stderr, h.ANY_LINE1, `${name} ${value}: refused with the caps, before notice line 1`);
    }
  }
});

test("a refused, failed or unreadable count means no billed call is sent, and the count is never retried", async () => {
  const cases = [
    ["400", h.apiError(400)], ["401", h.apiError(401)], ["403", h.apiError(403)], ["429", h.apiError(429)],
    ["500", h.apiError(500)], ["529", h.apiError(529)], ["not json", h.garbage()], ["no input_tokens", h.reply(200, {})],
    ["negative", h.countOk(-1)], ["fractional", h.countOk(1.5)], ["a string", h.countOk("1000")], ["null", h.countOk(null)],
    ["a redirect", h.redirectTo("http://127.0.0.1:1/v1/messages/count_tokens")],
  ];
  for (const [what, behaviour] of cases) {
    const dirs = h.makeDirs();
    stand.scenario = { count: behaviour, billed: h.answer() };
    const r = await ask([h.QUESTION], dirs);
    assert.equal(r.code, 1, what);
    assert.deepEqual(kinds(r), ["count"], `${what}: one count, nothing billed`);
    assert.doesNotMatch(r.stderr, h.ANY_LINE2, `${what}: no line 2 without a count`);
  }
  const dirs = h.makeDirs();
  stand.scenario = { count: h.hang(), billed: h.answer() };
  const slow = await ask(["--timeout", "1", h.QUESTION], dirs);
  assert.equal(slow.code, 1);
  assert.deepEqual(kinds(slow), ["count"], "no answer to the count in time: nothing billed");
});

test("--timeout covers both calls, and the count has its own 30-second limit inside it", { timeout: 180_000 }, async () => {
  // A count that answers after 4 s and a billed call that never answers, with --timeout 5: the run ends about 5 s
  // after it began, never 5 s after the billed call went (9 s or more).
  const both = h.makeDirs();
  stand.scenario = { count: h.later(4000, h.countOk(10)), billed: h.hang() };
  const r = await ask(["--timeout", "5", h.QUESTION], both);
  assert.equal(r.code, 1);
  assert.deepEqual(kinds(r), ["count", "billed"]);
  assert.ok(r.ms < 8000, `one --timeout for both calls: ended after ${r.ms} ms`);
  // A count that never answers, under the default --timeout of 300 s: given up on at 30 s, and nothing billed.
  const slow = h.makeDirs();
  stand.scenario = { count: h.hang(), billed: h.answer() };
  const counted = await ask([h.QUESTION], slow);
  assert.equal(counted.code, 1);
  assert.deepEqual(kinds(counted), ["count"], "a count that timed out: the billed call is never sent");
  assert.ok(counted.ms >= 29_000 && counted.ms < 90_000, `the count's own limit: ended after ${counted.ms} ms`);
});

test("cut short: with text it's printed and says so; with no text it names --max-tokens, exits 1 and settles from usage", async () => {
  const cut = h.makeDirs();
  stand.scenario = { count: h.countOk(100), billed: h.answer({ text: "cut sho", stop: "max_tokens", use: h.usage(100, 1000) }) };
  const withText = await ask(["--max-tokens", "1000", h.QUESTION], cut);
  assert.equal(withText.code, 0, withText.stderr);
  assert.equal(withText.stdout, "cut sho\n");
  assert.match(withText.stderr, /stopped at --max-tokens \(1000\)/);
  // A big question (a reservation of 100000 + 1000 × 2 = 102000 micro-dollars), count 8000: an estimate of 8864 input
  // tokens. Usage 8000 + 1000 × 2 = 10000 micro-dollars = $0.01.
  const empty = h.makeDirs();
  stand.scenario = { count: h.countOk(8000), billed: h.answer({ text: null, stop: "max_tokens", use: h.usage(8000, 1000) }) };
  const noText = await ask(["--max-tokens", "1000", h.BIG_QUESTION], empty);
  assert.equal(noText.code, 1, "an answer with no text exits 1");
  assert.equal(noText.stdout, "");
  assert.match(noText.stderr, /The answer used all of --max-tokens \(1000\) before any text; ask again with a higher --max-tokens\./);
  const used = await h.status({ dirs: empty });
  assert.deepEqual(h.usedOf(used.stdout), { used: "0.01", cap: "5.00" }, "settled from usage, not held at the reservation");
});

test("doctor's paid line and status's spend line; doctor marks missing caps as a FAIL and says when an override is in use", async () => {
  // Roomy caps: doctor checks the model a plain ask would use, the default one, whose hard worst case needs more than
  // the $0.50 these tests otherwise use.
  const dirs = h.makeDirs();
  const env = withKey(h.ROOMY);
  const fresh = await h.doctor({ dirs, env });
  assert.equal(fresh.code, 0, fresh.stdout);
  assert.match(fresh.stdout, h.exactLine("ok   engine: anthropic (paid API; key set in the environment; caps $1000.00 a question, $1000.00 a day; $0.00 used in the last 24 hours)"));
  // 10000 input + 5000 output tokens = 20000 micro-dollars = $0.02, inside a big question's 110000 micro-dollar reservation.
  stand.scenario = { count: h.countOk(10000), billed: h.answer({ use: h.usage(10000, 5000) }) };
  const r = await h.ask(["--max-tokens", "5000", h.BIG_QUESTION], { dirs, stand, env });
  assert.equal(r.code, 0, r.stderr);
  const later = await h.doctor({ dirs, env });
  assert.match(later.stdout, h.exactLine("ok   engine: anthropic (paid API; key set in the environment; caps $1000.00 a question, $1000.00 a day; $0.02 used in the last 24 hours)"));
  const st = await h.status({ dirs, env });
  assert.deepEqual(h.usedOf(st.stdout), { used: "0.02", cap: "1000.00" });
  for (const missing of [QCAP, DCAP]) {
    const d = await h.doctor({ dirs, env: { ...env, [missing]: undefined } });
    assert.equal(d.code, 1, missing);
    assert.doesNotMatch(d.stdout, /^ok   engine: anthropic/m, missing);
    assert.match(d.stdout, /^FAIL\b.*\b(?:caps?|HUNTAWAY_MAX_USD_PER_(?:QUESTION|DAY))\b/im, missing);
  }
  const overridden = await h.doctor({ dirs, env: { ...env, [h.DEFAULT_OVERRIDE]: "100,100" } });
  assert.match(overridden.stdout, /override/i);
  assert.doesNotMatch(later.stdout, /override/i);
});

test("doctor names the per-question cap a 10,240-byte request body needs at the default --max-tokens on an information line, never a FAIL: $0.03 for hwtest-model", async () => {
  // doctor names the cap a request body of 10,240 bytes needs at the default --max-tokens of 1024:
  // (2 × 10240 + 64) × 1 + 1024 × 2 = 22592 micro-dollars for hwtest-model. The test models are in the
  // table only with the switch on; under a $0.02 cap, doctor names hwtest-model's $0.03 on a line of its own. That line
  // is information: a per-question cap below the figure doesn't fail doctor, since smaller
  // questions still fit it, and an ask is refused on its own question's hard worst case.
  const dirs = h.makeDirs();
  const notFail = (l) => !l.startsWith("FAIL");
  const low = await h.doctor({ dirs, env: withKey({ [QCAP]: "0.02", [DCAP]: "5.00" }) });
  // (22592 micro-dollars is $0.02 to the nearest cent: $0.03 shows it was rounded up.)
  assert.ok(low.stdout.split("\n").some((l) => notFail(l) && l.includes(h.MODEL) && /\$0\.03\b/.test(l)),
    `an information line names hwtest-model's $0.03: ${low.stdout}`);
  assert.ok(!h.failLines(low.stdout).some((l) => l.includes(h.MODEL) || /10,?240/.test(l)), `no FAIL for the 10,240-byte figure: ${low.stdout}`);
  assert.equal(low.code, 0, `a $0.02 cap, below the 10,240-byte figure, doesn't fail doctor: ${low.stdout}`);
  // The default model under a $0.01 cap, below its own 10,240-byte figure: still an information line naming the cap
  // it needs, not a FAIL, and doctor doesn't fail.
  const tiny = await h.doctor({ dirs, env: withKey({ [QCAP]: "0.01", [DCAP]: "1000" }) });
  assert.ok(tiny.stdout.split("\n").some((l) => notFail(l) && l.includes(h.DEFAULT_MODEL) &&
    h.centsIn(l).some((c) => c > 1 && c !== 100000)), `an information line names the cap the default model needs: ${tiny.stdout}`);
  assert.ok(!h.failLines(tiny.stdout).some((l) => l.includes(h.DEFAULT_MODEL) || l.includes(h.MODEL) || /10,?240/.test(l)),
    `no FAIL for the 10,240-byte figure: ${tiny.stdout}`);
  assert.equal(tiny.code, 0, `a $0.01 cap, below the 10,240-byte figure, doesn't fail doctor: ${tiny.stdout}`);
  // Roomy caps: nothing about the caps fails.
  const roomy = await h.doctor({ dirs, env: withKey(h.ROOMY) });
  assert.equal(roomy.code, 0, roomy.stdout);
  assert.ok(!h.failLines(roomy.stdout).some((l) => l.includes(h.MODEL)), roomy.stdout);
});

test("the order of refusals: the caps (with the hard worst case), then notice line 1, then the key, then the ledger", async () => {
  // Everything after the caps is broken: no key in the environment, a fake keychain that can't be read, and a ledger
  // that can't be opened. Each refusal must be the first one in the documented order.
  const broken = () => {
    const dirs = h.makeDirs();
    writeFileSync(dirs.keychain, "{ not json", { mode: 0o600 });
    mkdirSync(dirs.ledger, { recursive: true });
    return dirs;
  };
  const noKey = { ANTHROPIC_API_KEY: undefined };
  // A key the switch refuses (not hwtest-) is never looked at before the caps either. The question is a big one, whose
  // hard worst case of $0.11 is over a $0.10 cap.
  const refusedKey = { ANTHROPIC_API_KEY: "sk-" + "ant-api03-" + "q".repeat(40) };
  for (const [what, env] of [["no per-question cap", { [QCAP]: undefined }], ["a $0.10 cap", { [QCAP]: "0.10" }]]) {
    for (const key of [noKey, refusedKey]) {
      stand.scenario = { count: h.countOk(10), billed: h.answer() };
      const r = await h.ask([h.BIG_QUESTION], { dirs: broken(), stand, env: { ...env, ...key } });
      assert.equal(r.code, 1, what);
      assert.equal(r.seen.length, 0, `${what}: nothing sent`);
      assert.match(r.stderr, /HUNTAWAY_MAX_USD_PER_QUESTION/, `${what}: refused at the caps`);
      assert.doesNotMatch(r.stderr, /keychain/i, `${what}: the key was never read`);
      assert.doesNotMatch(r.stderr, h.ANY_LINE1, `${what}: before notice line 1`);
    }
  }
  // Caps that hold: line 1, then the key's refusal (the keychain can't be read), before the ledger is looked at.
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const keyless = await h.ask([h.QUESTION], { dirs: broken(), stand, env: noKey });
  assert.equal(keyless.code, 1);
  assert.equal(keyless.seen.length, 0);
  const lineAt = keyless.stderr.search(h.line1("0.50", "5.00"));
  const keyAt = keyless.stderr.search(/keychain/i);
  assert.ok(lineAt >= 0 && keyAt > lineAt, `line 1, then the key's refusal: ${keyless.stderr}`);
  // A usable key: line 1, then the ledger's refusal, before the count.
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const ledgerless = await h.ask([h.QUESTION], { dirs: broken(), stand, env: { ANTHROPIC_API_KEY: KEY } });
  assert.equal(ledgerless.code, 1);
  assert.equal(ledgerless.seen.length, 0, "a ledger that can't be opened: not even the count");
  assert.match(ledgerless.stderr, h.line1("0.50", "5.00"));
});

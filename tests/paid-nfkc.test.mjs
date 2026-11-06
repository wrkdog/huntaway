// The paid layer, the byte bound's normalized count.
// Anthropic's published tokenizer applies NFKC before encoding, and NFKC can expand text (U+FDFA is 3 bytes and
// becomes 33), so the byte bound counts the larger of two figures:
//   B          = max(the billed request body's UTF-8 bytes, the same body's bytes with the question NFKC-normalized)
//   hard input = min(100000, 2 × B + 64) tokens for hwtest-model
//   hard worst = hard input × 1 + --max-tokens × 2 micro-dollars (the standard price; both caps and "At most" use it)
// Huntaway sends the question as written (it normalizes only to count), so the stand-in's body is the raw one, and
// each test works B out from it: the body's bytes, plus the question's growth under NFKC when that is positive.
//
// With the body Huntaway sends today, {model, max_tokens, messages: [{role, content}], service_tier}, 115 bytes around
// the question, 600 × U+FDFA (1800 bytes raw, 19800 normalized) gives a raw body of 1915 bytes and a normalized one of
// 19915: a hard worst case of 3894 + 2048 = 5942 micro-dollars ($0.01) on the raw count, and 39894 + 2048 = 41942
// ($0.05) on the normalized one. Under a $0.04 cap the raw count would admit it; the normalized count refuses it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as h from "./lib/paid-harness.mjs";

let stand;
before(async () => {
  stand = await h.startStandIn();
});
after(async () => {
  await stand.close();
});

const KEY = h.newKey("nfkc");
const withKey = (env = {}) => ({ ANTHROPIC_API_KEY: KEY, ...env });
const ask = (args, dirs, env) => h.ask(args, { dirs, stand, env: withKey(env) });
const kinds = (r) => r.seen.map((c) => c.kind);
const QCAP = "HUNTAWAY_MAX_USD_PER_QUESTION";
const DCAP = "HUNTAWAY_MAX_USD_PER_DAY";

/** Characters by code point, so this file holds no character NFKC or an editor could change. */
const ch = (...cps) => String.fromCodePoint(...cps);
const FDFA = ch(0xfdfa);
const utf8 = (text) => Buffer.byteLength(text, "utf8");
const NON_ASCII = new RegExp("[" + ch(0x7f) + "-" + ch(0xffff) + "]", "g");
/** A string as JSON writes it, without the quotes; `ascii` escapes every non-ASCII code unit as \uXXXX. */
const serialized = (text, ascii = false, upper = false) => {
  const plain = JSON.stringify(text).slice(1, -1);
  if (!ascii) return plain;
  return plain.replace(NON_ASCII, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
};

/**
 * The byte bound's two counts for a billed request, from the body the stand-in received: `raw`, its UTF-8 bytes,
 * and `normalized`, the same body's bytes with the question NFKC-normalized (the question written into the body the
 * same way, plain UTF-8 or \u escapes, as the original). `bound` is B, the larger.
 */
function counts(record, question) {
  assert.equal(JSON.parse(record.body).messages?.[0]?.content, question,
    "the billed call sends the question as written: NFKC is only for the byte bound's count");
  const normal = question.normalize("NFKC");
  const style = [[false, false], [true, false], [true, true]].find(([a, u]) => record.body.includes(serialized(question, a, u)));
  assert.ok(style !== undefined, "the question is in the body, in a form the test can rewrite");
  const raw = h.bodyBytes(record);
  const normalized = raw - utf8(serialized(question, ...style)) + utf8(serialized(normal, ...style));
  return { raw, normalized, bound: Math.max(raw, normalized) };
}

/** Ask with roomy enough caps, and return the run with the billed call's counts and hard worst cases. */
async function admitted(question, { maxTokens = 1024, env } = {}) {
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer({ use: h.usage(10, 5) }) };
  const r = await ask(["--max-tokens", String(maxTokens), question], dirs, env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kinds(r), ["count", "billed"]);
  assert.equal(JSON.parse(r.seen[0].body).messages?.[0]?.content, question, "the count counts the question as written");
  const c = counts(r.seen[1], question);
  return {
    r, dirs, ...c,
    rawWorst: h.hardWorst(c.raw, maxTokens), normalizedWorst: h.hardWorst(c.normalized, maxTokens),
    worst: h.hardWorst(c.bound, maxTokens),
  };
}

test("600 × U+FDFA: the reservation and line 2's At most follow the NFKC-normalized count, and a $0.04 cap the raw count would meet refuses it before anything is sent, naming $0.05", async () => {
  const question = FDFA.repeat(600);
  assert.equal(utf8(question), 1800);
  assert.equal(utf8(question.normalize("NFKC")), 19800, "U+FDFA: 3 bytes, 33 after NFKC");
  // Under the default $0.50 cap it runs; its figures come from the body the stand-in received.
  const a = await admitted(question);
  assert.equal(a.normalized - a.raw, 18000, "the normalized body is 30 bytes longer for each U+FDFA");
  assert.equal(a.bound, a.normalized);
  assert.ok(a.normalized < 49968, "below the 100000-token limit, so the byte bound is what binds");
  assert.ok(h.ledgerHas(a.dirs, a.normalizedWorst),
    `the reservation is (2 × ${a.normalized} + 64) + 1024 × 2 = ${a.normalizedWorst} micro-dollars, on the normalized count`);
  assert.ok(!h.ledgerHas(a.dirs, a.rawWorst), `not ${a.rawWorst}, the raw count's figure`);
  assert.match(a.r.stderr, h.atMost(h.centsUp(a.normalizedWorst)), `At most $${h.centsUp(a.normalizedWorst)}, not $${h.centsUp(a.rawWorst)}`);
  assert.match(a.r.seen[1].stderrAtArrival, h.atMost(h.centsUp(a.normalizedWorst)), "line 2, before the billed call");
  // With today's body framing these are 5942 ($0.01) and 41942 ($0.05) micro-dollars.
  assert.equal(h.centsUp(a.rawWorst), "0.01");
  assert.equal(h.centsUp(a.normalizedWorst), "0.05");
  // A $0.04 cap: the raw count's $0.01 would be inside it; the normalized count's $0.05 is over it. Refused at the caps
  // step, before notice line 1 and before anything is sent, naming the cap this question needs.
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const refused = await ask([question], dirs, { [QCAP]: "0.04", [DCAP]: "5.00" });
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(refused.seen.length, 0, "over the per-question cap on the normalized count: not even the count is sent");
  assert.doesNotMatch(refused.stderr, h.ANY_LINE1, "refused at the caps, before notice line 1");
  assert.match(refused.stderr, /HUNTAWAY_MAX_USD_PER_QUESTION/, "names the setting to raise");
  assert.match(refused.stderr, new RegExp(`\\$${h.escaped(h.centsUp(a.normalizedWorst))}\\b`),
    `names the cap this question needs: $${h.centsUp(a.normalizedWorst)} (${a.normalizedWorst} micro-dollars, rounded up)`);
  // And $0.05 holds it.
  const fits = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const ran = await ask([question], fits, { [QCAP]: "0.05", [DCAP]: "5.00" });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(kinds(ran), ["count", "billed"]);
});

test("the day cap uses the normalized count too: headroom the raw count would fit in refuses 600 × U+FDFA before the count", async () => {
  const question = FDFA.repeat(600);
  const a = await admitted(question);
  // Caps of $0.05 a question (which holds the normalized figure, 41942 micro-dollars today) and $0.06 a day. A first,
  // ASCII question of about 10 KB fails with a 5xx and keeps its reservation of about 22500 micro-dollars, leaving
  // about $0.0375 of headroom: the raw count's $0.0059 would fit in it, the normalized count's $0.042 doesn't.
  const dirs = h.makeDirs();
  const caps = { [QCAP]: "0.05", [DCAP]: "0.06" };
  const first = `${h.QUESTION} `.repeat(280);
  stand.scenario = { count: h.countOk(10), billed: h.apiError(500) };
  const hold = await ask([first], dirs, caps);
  assert.deepEqual(kinds(hold), ["count", "billed"], "the first question was sent and keeps its reservation");
  const held = h.hardWorst(h.bodyBytes(hold.seen[1]));
  assert.ok(h.ledgerHas(dirs, held), `the first question holds its ${held} micro-dollars`);
  assert.ok(held + a.normalizedWorst > 60000 && held + a.rawWorst <= 60000,
    `the hold (${held}) plus the normalized figure (${a.normalizedWorst}) is over $0.06, plus the raw one (${a.rawWorst}) isn't`);
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const refused = await ask([question], dirs, caps);
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(refused.seen.length, 0, "no day headroom on the normalized count: refused before the count");
  assert.match(refused.stderr, /\bday\b|24 hours/i);
});

test("mixed text (ASCII, U+FDFA, ½ and the ligature ﬁ): the figure is max(raw, normalized), here the normalized count", async () => {
  // Per group: U+FDFA 3 → 33 bytes, ½ (U+00BD) 2 → 5, ﬁ (U+FB01) 3 → 2, a space 1 → 1: 9 → 41 bytes.
  const question = `${h.QUESTION} ${`${ch(0xfdfa, 0xbd, 0xfb01)} `.repeat(200)}`;
  assert.equal(utf8(question.normalize("NFKC")) - utf8(question), 200 * 32);
  const a = await admitted(question);
  assert.equal(a.normalized - a.raw, 6400);
  assert.equal(a.bound, Math.max(a.raw, a.normalized));
  assert.ok(h.ledgerHas(a.dirs, a.worst), `the reservation is (2 × ${a.bound} + 64) + 2048 = ${a.worst} micro-dollars`);
  assert.ok(!h.ledgerHas(a.dirs, a.rawWorst), `not ${a.rawWorst}, the raw count's figure`);
  assert.match(a.r.stderr, h.atMost(h.centsUp(a.worst)));
  assert.notEqual(h.centsUp(a.worst), h.centsUp(a.rawWorst), "the two counts' figures differ even to the cent");
});

test("plain ASCII: NFKC changes nothing, and the figure is the raw count's, unchanged", async () => {
  const question = `${h.QUESTION} `.repeat(20);
  assert.equal(question.normalize("NFKC"), question);
  const a = await admitted(question, { maxTokens: 1000 });
  assert.equal(a.normalized, a.raw);
  assert.ok(h.ledgerHas(a.dirs, h.hardWorst(a.raw, 1000)),
    `the reservation is (2 × ${a.raw} + 64) + 1000 × 2 = ${h.hardWorst(a.raw, 1000)} micro-dollars`);
  assert.match(a.r.stderr, h.atMost(h.centsUp(h.hardWorst(a.raw, 1000))));
  // The big ASCII question still reaches the 100000-token limit: 102048 micro-dollars, $0.11.
  const big = await admitted(h.BIG_QUESTION);
  assert.ok(h.ledgerHas(big.dirs, h.limitWorst()));
  assert.match(big.r.stderr, h.atMost("0.11"));
});

test("text NFKC leaves the same length (precomposed é, ö) uses the raw count", async () => {
  const question = `caf${ch(0xe9)} cr${ch(0xe8)}me, K${ch(0xf6)}ln, na${ch(0xef)}ve r${ch(0xe9)}sum${ch(0xe9)} `.repeat(40);
  assert.equal(utf8(question.normalize("NFKC")), utf8(question), "precomposed letters stay 2 bytes");
  const a = await admitted(question);
  assert.equal(a.normalized, a.raw);
  assert.ok(h.ledgerHas(a.dirs, a.rawWorst), `the reservation is the raw count's ${a.rawWorst} micro-dollars`);
  assert.match(a.r.stderr, h.atMost(h.centsUp(a.rawWorst)));
});

test("text NFKC shrinks (ideographic spaces, ﬁ, Å, a decomposed é) uses the raw count, never less: a $0.01 cap the normalized count would meet refuses it", async () => {
  // Per group: "a" 1 → 1, U+3000 3 → 1 (a space), ﬁ 3 → 2, Å (U+212B) 3 → 2, e + U+0301 3 → 2 (é): 13 → 8 bytes.
  const question = `a${ch(0x3000, 0xfb01, 0x212b)}e${ch(0x301)}`.repeat(300);
  assert.equal(utf8(question), 3900);
  assert.equal(utf8(question.normalize("NFKC")), 2400);
  const a = await admitted(question);
  assert.equal(a.raw - a.normalized, 1500);
  assert.equal(a.bound, a.raw);
  assert.ok(h.ledgerHas(a.dirs, a.rawWorst), `the reservation is the raw count's ${a.rawWorst} micro-dollars`);
  assert.ok(!h.ledgerHas(a.dirs, a.normalizedWorst), `never the smaller normalized ${a.normalizedWorst}`);
  assert.match(a.r.stderr, h.atMost(h.centsUp(a.rawWorst)));
  // With today's framing: a raw body of 4015 bytes, (2 × 4015 + 64) + 2048 = 10142 micro-dollars ($0.02); the
  // normalized 2515 bytes would be 7142 ($0.01). A $0.01 cap refuses it, naming $0.02.
  assert.equal(h.centsUp(a.rawWorst), "0.02");
  assert.equal(h.centsUp(a.normalizedWorst), "0.01");
  const dirs = h.makeDirs();
  stand.scenario = { count: h.countOk(10), billed: h.answer() };
  const refused = await ask([question], dirs, { [QCAP]: "0.01", [DCAP]: "5.00" });
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(refused.seen.length, 0, "refused before anything is sent");
  assert.match(refused.stderr, /\$0\.02\b/, "names the cap the raw count needs");
});

test("an empty or whitespace-only question is a usage error (exit 2) before anything is sent", async () => {
  for (const question of ["", " ", "   ", "\t\n ", ch(0x3000, 0x3000), ch(0xa0), ch(0x2003)]) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await ask([question], dirs);
    const what = JSON.stringify(question);
    assert.equal(r.code, 2, `${what}: ${r.stderr}`);
    assert.equal(r.seen.length, 0, `${what}: nothing sent`);
    assert.doesNotMatch(r.stderr, h.ANY_LINE1, `${what}: a usage error comes before the notice`);
    assert.equal(h.ledgerRows(dirs).length, 0, `${what}: nothing reserved`);
  }
  for (const input of ["", "\n", "  \n", "\t \r\n"]) {
    const dirs = h.makeDirs();
    stand.scenario = { count: h.countOk(10), billed: h.answer() };
    const r = await h.runCli(["ask", "--engine", "anthropic", "--model", h.MODEL, "-"], { dirs, stand, env: withKey(), input });
    const what = `stdin ${JSON.stringify(input)}`;
    assert.equal(r.code, 2, `${what}: ${r.stderr}`);
    assert.equal(r.seen.length, 0, `${what}: nothing sent`);
    assert.doesNotMatch(r.stderr, h.ANY_LINE1, what);
  }
});

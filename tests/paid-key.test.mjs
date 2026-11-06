// The paid layer: where the key comes from (the environment first, then
// the keychain, here its test fake), `huntaway key set|remove anthropic`, what doctor says about the key, and the
// test switch. Every run is a child process against a local stand-in; no test uses a real key or the real keychain.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import * as h from "./lib/paid-harness.mjs";

let stand;
let sentinel;
before(async () => {
  stand = await h.startStandIn();
  sentinel = await h.startSentinel();
});
after(async () => {
  await stand.close();
  await sentinel.close();
});

// count 1000 means an estimated input of 1164 tokens, and h.QUESTION's hard input is about 2 × 150 + 64 = 364 tokens,
// so usage of 100 input tokens is no overrun (and the same HOME can ask again).
const answering = () => ({ count: h.countOk(1000), billed: h.answer({ use: h.usage(100, 5) }) });
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Run ask; return the x-api-key of every request the stand-in saw. */
async function keysSent(dirs, env) {
  stand.scenario = answering();
  const r = await h.ask([h.QUESTION], { dirs, stand, env });
  return { r, keys: r.seen.map((call) => call.headers["x-api-key"]) };
}

test("ANTHROPIC_API_KEY comes first: with a key in the keychain too, the environment's is the one sent", async () => {
  const dirs = h.makeDirs();
  const stored = h.newKey("stored");
  const fromEnv = h.newKey("env");
  const set = await h.keySet(stored, { dirs });
  assert.equal(set.code, 0, set.stderr);
  const { r, keys } = await keysSent(dirs, { ANTHROPIC_API_KEY: fromEnv });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${h.ANSWER}\n`);
  assert.deepEqual(r.seen.map((c) => c.kind), ["count", "billed"]);
  assert.deepEqual(keys, [fromEnv, fromEnv], "the count and the billed call both carry the environment's key");
});

test("an unset or empty ANTHROPIC_API_KEY means the key comes from the keychain (here its test fake)", async () => {
  for (const value of [undefined, ""]) {
    const dirs = h.makeDirs();
    const stored = h.newKey("stored");
    const set = await h.keySet(stored, { dirs });
    assert.equal(set.code, 0, set.stderr);
    const { r, keys } = await keysSent(dirs, { ANTHROPIC_API_KEY: value });
    assert.equal(r.code, 0, `${JSON.stringify(value)}: ${r.stderr}`);
    assert.deepEqual(keys, [stored, stored], JSON.stringify(value));
  }
});

test("a set but unusable ANTHROPIC_API_KEY refuses, and never falls back to the keychain", async () => {
  const dirs = h.makeDirs();
  const stored = h.newKey("stored");
  assert.equal((await h.keySet(stored, { dirs })).code, 0);
  // The control: with the variable unset, the stored key works, so a refusal below can only mean "no fallback".
  const control = await keysSent(dirs, { ANTHROPIC_API_KEY: undefined });
  assert.deepEqual(control.keys, [stored, stored], control.r.stderr);
  for (const bad of [`hwtest-two words-${h.newKey().slice(-12)}`, `hwtest-${"x".repeat(520)}`,
    `hwtest-line\nbreak-${h.newKey().slice(-12)}`]) {
    const { r } = await keysSent(dirs, { ANTHROPIC_API_KEY: bad });
    assert.equal(r.code, 1, JSON.stringify(bad.slice(0, 20)));
    assert.equal(r.seen.length, 0, "nothing sent: not the bad key, and not the keychain's");
    assert.ok(!h.echoesPartOf(stored, r.stdout + r.stderr), "the stored key never shows");
  }
});

test("no key anywhere, or a keychain that can't be read: a refusal in fixed words, and nothing sent", async () => {
  const none = h.makeDirs();
  stand.scenario = answering();
  const missing = await h.ask([h.QUESTION], { dirs: none, stand, env: { ANTHROPIC_API_KEY: undefined } });
  assert.equal(missing.code, 1);
  assert.equal(missing.seen.length, 0);
  assert.match(missing.stderr, /keychain/i, "the refusal names where the key could have come from");
  const damaged = h.makeDirs();
  writeFileSync(damaged.keychain, "{ this is not json", { mode: 0o600 });
  const unreadable = await h.ask([h.QUESTION], { dirs: damaged, stand, env: { ANTHROPIC_API_KEY: undefined } });
  assert.equal(unreadable.code, 1);
  assert.equal(unreadable.seen.length, 0);
  assert.match(unreadable.stderr, /keychain/i);
  assert.ok(!unreadable.stderr.includes("this is not json"), "fixed words, never the file's contents");
});

test("key set reads one line from stdin when it isn't a terminal, and keeps the key byte for byte", async () => {
  const every = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
  const accepted = [
    `hwtest-AQ.Ab8RN6Lx_f-Q2e.zT9${h.newKey().slice(-8)}`,          // an AQ.-style key: dots, underscores, dashes
    `hwtest-${"a".repeat(13)}`,                                     // 20 characters, the shortest allowed
    `hwtest-${every}`.padEnd(512, "z"),                             // 512 characters, every allowed one among them
  ];
  for (const key of accepted) {
    const dirs = h.makeDirs();
    const set = await h.keySet(key, { dirs });
    assert.equal(set.code, 0, `${key.length} characters: ${set.stderr}`);
    assert.ok(!h.echoesPartOf(key, set.stdout + set.stderr), "key set never prints the key");
    const { r, keys } = await keysSent(dirs, { ANTHROPIC_API_KEY: undefined });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(keys, [key, key], `${key.length} characters round-trip exactly`);
  }
});

test("key set refuses anything outside [A-Za-z0-9._-]{20,512}, and a refused key leaves the stored one in place", async () => {
  const dirs = h.makeDirs();
  const older = h.newKey("older");
  assert.equal((await h.keySet(older, { dirs })).code, 0);
  const tail = () => h.newKey().slice(-16);
  for (const bad of [`hwtest-has space-${tail()}`, `hwtest-has"quote-${tail()}`, `hwtest-has'quote-${tail()}`,
    `hwtest-back\\slash-${tail()}`, `hwtest-dollar$sign-${tail()}`, `hwtest-back\`tick-${tail()}`,
    `hwtest-tab\tkey-${tail()}`, `hwtest-ünicode-${tail()}`, `hwtest-${"a".repeat(12)}`, `hwtest-${"a".repeat(506)}`, ""]) {
    const set = await h.keySet(bad, { dirs });
    assert.notEqual(set.code, 0, `${bad.length} characters: ${JSON.stringify(bad.slice(0, 24))}`);
    if (bad.length >= 8) assert.ok(!h.echoesPartOf(bad, set.stdout + set.stderr), "a refused key is never echoed");
  }
  const empty = await h.runCli(["key", "set", "anthropic"], { dirs, input: "" });
  assert.notEqual(empty.code, 0, "no line at all is refused too");
  const { r, keys } = await keysSent(dirs, { ANTHROPIC_API_KEY: undefined });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(keys, [older, older], "the older key is still the one in the keychain");
});

test("a key that can't be stored says so and leaves a working older key in place", { skip: isRoot && "root ignores file modes" }, async () => {
  const dirs = h.makeDirs();
  const older = h.newKey("older");
  assert.equal((await h.keySet(older, { dirs })).code, 0);
  const newer = h.newKey("newer");
  chmodSync(dirs.keychain, 0o400);
  chmodSync(dirs.kcDir, 0o500);
  try {
    const set = await h.keySet(newer, { dirs });
    assert.notEqual(set.code, 0);
    assert.match(set.stderr, /the key couldn.t be stored|the key could not be stored/i);
    assert.ok(!h.echoesPartOf(newer, set.stdout + set.stderr), "a failed write prints nothing of the key");
    const { r, keys } = await keysSent(dirs, { ANTHROPIC_API_KEY: undefined });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(keys, [older, older]);
  } finally {
    chmodSync(dirs.kcDir, 0o700);
    chmodSync(dirs.keychain, 0o600);
  }
  // With no item before the attempt, a failed store leaves none behind.
  const fresh = h.makeDirs();
  chmodSync(fresh.kcDir, 0o500);
  try {
    const set = await h.keySet(h.newKey("first"), { dirs: fresh });
    assert.notEqual(set.code, 0);
    assert.match(set.stderr, /the key couldn.t be stored|the key could not be stored/i);
  } finally {
    chmodSync(fresh.kcDir, 0o700);
  }
  stand.scenario = answering();
  const later = await h.ask([h.QUESTION], { dirs: fresh, stand, env: { ANTHROPIC_API_KEY: undefined } });
  assert.equal(later.code, 1);
  assert.equal(later.seen.length, 0, "no key, so nothing sent");
});

test("key remove takes the stored key away", async () => {
  const dirs = h.makeDirs();
  const key = h.newKey("removed");
  assert.equal((await h.keySet(key, { dirs })).code, 0);
  const removed = await h.keyRemove({ dirs });
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(!h.echoesPartOf(key, removed.stdout + removed.stderr));
  stand.scenario = answering();
  const r = await h.ask([h.QUESTION], { dirs, stand, env: { ANTHROPIC_API_KEY: undefined } });
  assert.equal(r.code, 1);
  assert.equal(r.seen.length, 0);
  assert.match(r.stderr, /keychain/i);
});

test("doctor says where the key comes from, never any part of it", async () => {
  // Roomy caps: doctor checks the default model, whose hard worst case needs more than $0.50 a question.
  const dirs = h.makeDirs();
  const fromEnv = h.newKey("doctor-env");
  const envDoctor = await h.doctor({ dirs, env: { ANTHROPIC_API_KEY: fromEnv, ...h.ROOMY } });
  assert.match(envDoctor.stdout, h.exactLine("ok   engine: anthropic (paid API; key set in the environment; caps $1000.00 a question, $1000.00 a day; $0.00 used in the last 24 hours)"));
  assert.ok(!h.echoesPartOf(fromEnv, envDoctor.stdout + envDoctor.stderr));
  const stored = h.newKey("doctor-kc");
  assert.equal((await h.keySet(stored, { dirs })).code, 0);
  const kcDoctor = await h.doctor({ dirs, env: { ANTHROPIC_API_KEY: undefined, ...h.ROOMY } });
  assert.match(kcDoctor.stdout, h.exactLine("ok   engine: anthropic (paid API; key in the keychain; caps $1000.00 a question, $1000.00 a day; $0.00 used in the last 24 hours)"));
  assert.ok(!h.echoesPartOf(stored, kcDoctor.stdout + kcDoctor.stderr));
});

// ----- the test switch ------------------------------------------------------------------------------------------
//
// Below, "nothing sent" is checked on every supported Node: each run is under the shared fetch fixture (catchFetch),
// so every fetch is written down and refused, and the recorded calls must be exactly the expected ones (here none).
// The sentinel proxy stays as a second layer; it sees nothing on Node older than 22.21 or 24.5.

test("switch on with no stand-in URL, or one that isn't a local stand-in: refused, nothing sent anywhere, not even with a real-format key", async () => {
  // Assembled here so no real-looking key sits in this file.
  const realFormat = "sk-" + "ant-api03-" + "q".repeat(40);
  const cases = [[undefined, realFormat], [undefined, h.newKey("nourl")], ["", h.newKey("emptyurl")]];
  for (const far of ["http://example.com:80/v1/messages", `https://127.0.0.1:${stand.port}/v1/messages`,
    `http://127.0.0.1.example.com:${stand.port}/v1/messages`, "not a url"]) {
    cases.push([far, h.newKey("farurl")], [far, realFormat]);
  }
  for (const [url, key] of cases) {
    const dirs = h.makeDirs();
    sentinel.hits.length = 0;
    stand.scenario = answering();
    const r = await h.ask([h.QUESTION], { dirs, stand, catchFetch: true,
      env: { HUNTAWAY_TEST_ANTHROPIC_URL: url, ANTHROPIC_API_KEY: key, ...sentinel.env() } });
    const what = `${JSON.stringify(url)} with ${key.slice(0, 7)}...`;
    assert.equal(r.code, 1, what);
    assert.deepEqual(r.fetches, [], `${what}: no fetch at all, so nothing went to any real address`);
    assert.deepEqual(sentinel.hits, [], `${what}: nothing went to any real address`);
    assert.equal(r.seen.length, 0, `${what}: nothing reached the stand-in`);
    assert.ok(!h.echoesPartOf(key, r.stdout + r.stderr), "no part of the key is printed");
  }
});

test("switch on: a key that doesn't start with hwtest- is refused before anything reaches the stand-in", async () => {
  for (const key of ["huntaway-test-key-0000-not-real", "sk-" + "proj-" + "y".repeat(30), "sk-" + "ant-" + "z".repeat(30),
    "HWTEST-upper-0000000000000", "xhwtest-000000000000000000"]) {
    const dirs = h.makeDirs();
    sentinel.hits.length = 0;
    stand.scenario = answering();
    const r = await h.ask([h.QUESTION], { dirs, stand, catchFetch: true, env: { ANTHROPIC_API_KEY: key, ...sentinel.env() } });
    assert.equal(r.code, 1, key.slice(0, 8));
    assert.equal(r.seen.length, 0, `${key.slice(0, 8)}: nothing sent, not even the count`);
    assert.deepEqual(r.fetches, [], `${key.slice(0, 8)}: no fetch at all`);
    assert.deepEqual(sentinel.hits, []);
    assert.ok(!h.echoesPartOf(key, r.stdout + r.stderr));
  }
});

test("switch on: key set refuses a key that doesn't start with hwtest-, and leaves the stored one in place", async () => {
  const dirs = h.makeDirs();
  const older = h.newKey("older");
  assert.equal((await h.keySet(older, { dirs })).code, 0);
  // Each passes key set's own format check, [A-Za-z0-9._-]{20,512}; only the switch refuses it.
  for (const key of ["huntaway-test-key-0000-not-real", "sk-" + "ant-api03-" + "k".repeat(40), "sk-" + "proj-" + "m".repeat(30),
    "HWTEST-upper-0000000000000", "xhwtest-000000000000000000", "AIza" + "n".repeat(35)]) {
    const set = await h.keySet(key, { dirs });
    assert.notEqual(set.code, 0, key.slice(0, 8));
    assert.ok(!h.echoesPartOf(key, set.stdout + set.stderr), "a refused key is never echoed");
    const { r, keys } = await keysSent(dirs, { ANTHROPIC_API_KEY: undefined });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(keys, [older, older], `${key.slice(0, 8)}: the older key is still the one in the keychain`);
  }
});

test("switch off: an hwtest- key is refused before any network use, and the stand-in URL is never used", async () => {
  const dirs = h.makeDirs();
  const key = h.newKey("switchoff");
  sentinel.hits.length = 0;
  stand.scenario = answering();
  // The stand-in URL is set and the caps hold the default model's hard worst case, so the key is the only thing
  // that can refuse this.
  const r = await h.askDefaultModel([h.QUESTION], { dirs, stand, catchFetch: true,
    env: { HUNTAWAY_ENABLE_FAKE_ENGINE: undefined, ANTHROPIC_API_KEY: key, ...h.ROOMY, ...sentinel.env() } });
  assert.equal(r.code, 1);
  assert.equal(r.seen.length, 0, "the stand-in received nothing");
  assert.deepEqual(r.fetches, [], "no fetch at all, so no real address either");
  assert.deepEqual(sentinel.hits, [], "nor did any real address");
  assert.ok(!h.echoesPartOf(key, r.stdout + r.stderr));
});

test("switch off: hwtest-model doesn't exist", async () => {
  const dirs = h.makeDirs();
  sentinel.hits.length = 0;
  stand.scenario = answering();
  // A key unlike any real format, and not hwtest-, so only the model can refuse this.
  const r = await h.ask([h.QUESTION], { dirs, stand, catchFetch: true, env: { HUNTAWAY_ENABLE_FAKE_ENGINE: undefined,
    ANTHROPIC_API_KEY: "huntaway-test-key-0000-not-real", ...sentinel.env() } });
  assert.notEqual(r.code, 0);
  assert.equal(r.seen.length, 0);
  assert.deepEqual(r.fetches, [], "no fetch at all: nothing sent to the real API, not even the count");
  assert.deepEqual(sentinel.hits, [], "nothing sent to the real API");
});

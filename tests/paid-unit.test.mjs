// Socket-free checks of the money, reservation and response boundaries. The CLI acceptance tests exercise
// real HTTP on the next machine; here an in-memory request function is injected into the shared layer.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ANTHROPIC, networkOutcome } from "../src/ask/anthropic.ts";
import { about, cents, cost, hardInput, hardWorst, modelPrices, paidCaps, preparePaid, readSpend } from "../src/ask/paid.ts";
import { modelsFor, ANTHROPIC_MODELS } from "../src/ask/models.ts";
import { SpendLedger } from "../src/ask/ledger.ts";

const dirs = [];
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function setup(extra = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith("HUNTAWAY_") || k === "ANTHROPIC_API_KEY") delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "huntaway-paid-unit-"));
  dirs.push(dir);
  Object.assign(process.env, { HUNTAWAY_HOME: dir, HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_TEST_NOW: "1793870400000",
    HUNTAWAY_TEST_ANTHROPIC_URL: "http://127.0.0.1:9/v1/messages", ANTHROPIC_API_KEY: "hwtest-memory-only-unit-check",
    HUNTAWAY_MAX_USD_PER_QUESTION: "0.50", HUNTAWAY_MAX_USD_PER_DAY: "5" });
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  return dir;
}
const options = { engine: "anthropic", family: "claude", model: "hwtest-model", effort: "medium", timeout: 1, maxTokens: 1000, question: "unit question" };
const usage = (input = 100, output = 5, service_tier = "standard", extra = {}) => ({ input_tokens: input, output_tokens: output, service_tier, ...extra });
const body = (u, extra = {}) => ({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: u, ...extra });
const prepareAnthropic = (opts) => preparePaid(ANTHROPIC, opts, (url, init) => globalThis.fetch(url, init));
const bodyBytes = Buffer.byteLength(JSON.stringify(ANTHROPIC.requestBody(options, { id: "hwtest-model", thinking: "none" })), "utf8");
const inputBound = BigInt(2 * bodyBytes + 64);
const reserved = inputBound + 2000n;
const r = { engine: "anthropic", model: "hwtest-model", revision: 1, estimated: 3164n, reserved: 102000n };

test("money stays exact beyond Number range and rounds up after the combined token cost", () => {
  setup();
  assert.equal(cost(1001n, 2n, { input: 100000001n, output: 100000000n }), 100301n);
  assert.equal(cost(10n ** 30n, 1n, { input: 1000000000n, output: 1n }), 10n ** 33n + 1n);
  assert.equal(cents(204096n), "0.21");
  assert.equal(about(3289n), "0.00329");
  assert.equal(hardWorst(modelsFor(ANTHROPIC_MODELS)[1], 1024, 49_968), 102048n);
  assert.equal(ANTHROPIC_MODELS.filter(m => m.default).length, 1);
});

test("hard input uses full UTF-8 JSON bytes at standard prices, with the table limit as fallback", () => {
  setup();
  const model = modelsFor(ANTHROPIC_MODELS)[1];
  const wide = JSON.stringify(ANTHROPIC.requestBody({ ...options, question: '🦘é→\n"' }, model));
  const bytes = Buffer.byteLength(wide, 'utf8');
  assert.ok(bytes > wide.length);
  assert.equal(hardInput(model, 1000, bytes), BigInt(2 * bytes + 64));
  assert.equal(hardWorst(model, 1000, bytes), BigInt(2 * bytes + 64 + 2000));
  assert.equal(hardWorst(model, 5000, 49_968), 110000n);
  assert.equal(hardWorst(model, 5001, 49_968), 110002n);
  assert.equal(hardInput({ ...model, byteBound: false }, 1000, 1), 100000n);
  assert.equal(hardInput({ ...model, byteBound: false, sharedContext: true }, 1000, 1), 99000n);
  assert.equal(hardWorst(model, 1024, 10_240), 22592n);
});

test("request-specific caps refuse before keys; the test switch and URL guards precede network use", () => {
  setup({ HUNTAWAY_MAX_USD_PER_QUESTION: "0.10", ANTHROPIC_API_KEY: undefined });
  assert.throws(() => prepareAnthropic({ ...options, maxTokens: 8192, question: "x".repeat(50_000) }), /\$0\.12\b/);
  setup();
  delete process.env.HUNTAWAY_ENABLE_FAKE_ENGINE;
  assert.throws(() => prepareAnthropic({ ...options, model: "claude-sonnet-5-5" }), /test switch/);
  for (const url of [undefined, "", "https://127.0.0.1:9/v1/messages", "http://127.0.0.1.example.com:9/v1/messages"]) {
    setup();
    if (url === undefined) delete process.env.HUNTAWAY_TEST_ANTHROPIC_URL;
    else process.env.HUNTAWAY_TEST_ANTHROPIC_URL = url;
    assert.throws(() => prepareAnthropic(options), /local stand-in/);
  }
});

test("billed input above the hard bound blocks even inside both the estimate and reserved dollars", async () => {
  setup();
  let calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1 ? { input_tokens: 1000 } : body(usage(Number(inputBound) + 1)));
  const result = await prepareAnthropic(options).submit({ onSent() {} });
  assert.equal(result.outcome, "accepted", "the count above the hard bound must not refuse the call");
  assert.equal((await result.wait()).status, "completed");
  assert.ok(readSpend().used < reserved);
  assert.equal(readSpend().overruns.length, 1);
  assert.equal((await prepareAnthropic(options).submit({ onSent() {} })).outcome, "refused");
  assert.equal(calls, 2, "the overrun block precedes another count");
});

// The NFKC rule adds one more build: the body with the question NFKC-normalized. Send the first build and reserve exactly
// for the larger byte count, even when the second build changes for another reason.
test("the reservation covers the billed JSON even if the request builder would change on a second call", async () => {
  setup();
  let builds = 0, calls = 0;
  const engine = { ...ANTHROPIC, requestBody: (opts, model) => {
    builds++;
    return ANTHROPIC.requestBody({ ...opts, question: "x".repeat(builds * 100) }, model);
  } };
  const model = modelsFor(ANTHROPIC_MODELS)[1];
  const firstBody = JSON.stringify(ANTHROPIC.requestBody({ ...options, question: "x".repeat(100) }, model));
  const secondBody = JSON.stringify(ANTHROPIC.requestBody({ ...options, question: "x".repeat(200) }, model));
  const expected = BigInt(2 * Math.max(Buffer.byteLength(firstBody, 'utf8'), Buffer.byteLength(secondBody, 'utf8'))
    + 64 + options.maxTokens * 2);
  let billedBody, reservation;
  const prepared = preparePaid(engine, options, async (url, init) => {
    if (++calls === 1) return Response.json({ input_tokens: 1000 });
    billedBody = init.body;
    reservation = readSpend().used;
    return Response.json(body(usage()));
  });
  const result = await prepared.submit({ onSent() {} });
  assert.equal(result.outcome, "accepted");
  assert.equal(billedBody, firstBody, "the outgoing body is the first build");
  assert.equal(reservation, expected, "the reservation uses the larger build's bytes and the output bound's cost");
  assert.equal(builds, 2, "the billed body and the NFKC-normalized one");
  assert.equal(calls, 2, "one count and one billed request");
});

test("the count's own limit cancels at 30 seconds and never reserves or sends a billed request", async (t) => {
  setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const prepared = preparePaid(ANTHROPIC, { ...options, timeout: 300 }, (url, init) => {
    calls++;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  });
  const pending = prepared.submit({ onSent() { assert.fail('nothing billed'); } });
  t.mock.timers.tick(29_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.outcome, 'refused');
  assert.match(result.why, /30 seconds/);
  assert.equal(readSpend().used, 0n);
});

test("CLI workers end uncooperative fetches and bodies within --timeout, keeping honest outcomes", { timeout: 15_000 }, () => {
  const dir = setup();
  const fixture = join(dir, 'uncooperative-fetch.mjs');
  // No socket or product test hook: --import replaces fetch in this child and its workers.
  writeFileSync(fixture, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url) => {
      const count = new URL(url).pathname.endsWith('/count_tokens');
      appendFileSync(process.env.PAID_FETCH_CALLS, count ? 'count\\n' : 'billed\\n');
      const mode = process.env.PAID_FETCH_SCENARIO;
      if (mode === 'error') throw new Error(process.env.ANTHROPIC_API_KEY);
      if ((count && mode !== 'count') || mode === 'success') {
        return Response.json(count ? { input_tokens: 100 } : {
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 5, service_tier: 'standard' }
        });
      }
      if (mode === 'refused') throw { cause: { code: 'ECONNREFUSED' } };
      if (mode === 'redirect') throw { cause: { message: 'unexpected redirect ' + process.env.ANTHROPIC_API_KEY } };
      setInterval(() => {}, 1000); // A connection that would keep this worker alive forever.
      if (mode === 'body') return {
        status: 200, headers: new Headers({ 'request-id': 'req_slow' }), json: () => new Promise(() => {})
      };
      return new Promise(() => {});
    };
  `);
  const cli = new URL('../bin/huntaway.ts', import.meta.url);
  for (const mode of ['success', 'count', 'billed', 'body', 'error', 'refused', 'redirect']) {
    const home = setup();
    const calls = join(home, 'calls');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', fixture, fileURLToPath(cli),
      'ask', '--model', 'hwtest-model', '--timeout', '1', '--max-tokens', '1000', options.question], {
      env: { ...process.env, PAID_FETCH_SCENARIO: mode, PAID_FETCH_CALLS: calls },
      encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL',
    });
    assert.equal(result.error, undefined, `${mode}: worker must not keep the CLI alive`);
    assert.equal(result.status, mode === 'success' ? 0 : 1, `${mode}: ${result.stderr}`);
    assert.ok(!result.stderr.includes(process.env.ANTHROPIC_API_KEY));
    assert.equal(readFileSync(calls, 'utf8'), ['count', 'error'].includes(mode) ? 'count\n' : 'count\nbilled\n');
    assert.equal(readSpend().used, mode === 'success' ? 110n : ['count', 'error', 'refused'].includes(mode) ? 0n : reserved);
    if (mode === 'body') assert.match(result.stderr, /not sure it finished.*--timeout.*req_slow/);
    else if (mode === 'billed') assert.match(result.stderr, /may have run/i);
    else if (mode === 'count') assert.match(result.stderr, /Nothing ran/);
    else if (mode === 'refused') assert.match(result.stderr, /Nothing ran/);
    else if (mode === 'redirect') assert.match(result.stderr, /never follows/);
  }
});

test("caps, overrides and the test switch fail before a keychain or network call", () => {
  setup({ HUNTAWAY_MAX_USD_PER_QUESTION: "0.001" });
  assert.throws(paidCaps, /HUNTAWAY_MAX_USD_PER_QUESTION/);
  setup({ HUNTAWAY_PRICE_ANTHROPIC_HWTEST_MODEL: "2,4" });
  assert.throws(() => modelPrices(ANTHROPIC, "hwtest-model"), /unambiguously/);
  setup({ HUNTAWAY_PRICE_ANTHROPIC_CLAUDE_SONNET_5_5: "1,1" });
  assert.throws(() => modelPrices(ANTHROPIC, "claude-sonnet-5-5"), /HUNTAWAY_PRICE_/);
  setup({ HUNTAWAY_TEST_ANTHROPIC_URL: "http://127.0.0.1.example.com:9/v1/messages" });
  assert.throws(() => prepareAnthropic(options), /local stand-in/);
  delete process.env.HUNTAWAY_ENABLE_FAKE_ENGINE;
  assert.throws(() => modelPrices(ANTHROPIC, "hwtest-model"), /capability table/);
});

test("reserve is committed before fetch; valid settlement frees headroom and stores no content", async () => {
  const dir = setup();
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(new URL(url).pathname);
    assert.equal(init.redirect, "error");
    if (seen.length === 1) return Response.json({ input_tokens: 1000 });
    const ledger = new SpendLedger(join(dir, "spend.sqlite"), true);
    try { assert.equal(ledger.snapshot().used, reserved); } finally { ledger.close(); }
    assert.equal(JSON.parse(init.body).service_tier, "standard_only");
    return Response.json(body(usage()));
  };
  const result = await prepareAnthropic(options).submit({ onSent() {} });
  assert.equal(result.outcome, "accepted");
  assert.equal((await result.wait()).status, "completed");
  assert.deepEqual(seen, ["/v1/messages/count_tokens", "/v1/messages"]);
  assert.equal(readSpend().used, 110n);
  assert.equal(statSync(join(dir, "spend.sqlite")).mode & 0o777, 0o600);
});

test("missing and inconsistent usage retain the reservation; bad tiers and cache usage overrun", async () => {
  for (const [u, amount, blocked] of [
    [undefined, reserved, false], [usage(-1), reserved, false],
    [usage(1000, 5, "standard", { total_tokens: 999 }), reserved, false],
    [usage(1000, 5, "standard", { output_tokens_details: { thinking_tokens: 6 } }), reserved, false],
    [usage(1000, 5, "standard", { cache_read_input_tokens: null }), reserved, false],
    [usage(100, 5, "priority"), 220n, true],
    [usage(1165), 1175n, true],
    [usage(100, 5, "standard", { cache_creation_input_tokens: 100 }), 310n, true],
  ]) {
    const dir = setup();
    let calls = 0;
    globalThis.fetch = async () => Response.json(++calls === 1 ? { input_tokens: 1000 } : body(u));
    const result = await prepareAnthropic(options).submit({ onSent() {} });
    assert.equal(result.outcome, "accepted");
    assert.equal((await result.wait()).status, "completed");
    assert.equal(readSpend().used, amount);
    const ledger = new SpendLedger(join(dir, "spend.sqlite"));
    try {
      if (blocked) assert.throws(() => ledger.check(r, 5000000n), /overrun/);
      else assert.doesNotThrow(() => ledger.check(r, 5000000n));
    } finally { ledger.close(); }
  }
});

test("refused statuses settle zero, 5xx retains; count failures never reserve or send billed", async () => {
  for (const status of [400, 401, 403, 404, 413, 429, 529, 500]) {
    setup();
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? Response.json({ input_tokens: 1000 }) : Response.json({}, { status });
    const result = await prepareAnthropic(options).submit({ onSent() {} });
    assert.equal(result.outcome, status === 500 ? "accepted" : "refused");
    assert.equal(readSpend().used, status === 500 ? reserved : 0n);
  }
  for (const counted of [{ input_tokens: -1 }, { input_tokens: 0.5 }, {}, { input_tokens: "1000" }]) {
    setup();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json(counted); };
    assert.equal((await prepareAnthropic(options).submit({ onSent() {} })).outcome, "refused");
    assert.equal(calls, 1);
    assert.equal(readSpend().used, 0n);
  }
});

test("provider refusal and no-text truncation settle validated usage without printing a provider message", async () => {
  for (const stop of ["refusal", "max_tokens"]) {
    setup();
    let calls = 0;
    globalThis.fetch = async () => Response.json(++calls === 1 ? { input_tokens: 1000 } : body(usage(), { content: [], stop_reason: stop }));
    const result = await prepareAnthropic(options).submit({ onSent() {} });
    assert.equal(result.outcome, "accepted");
    const waited = await result.wait();
    assert.equal(waited.status, "failed");
    assert.match(waited.why, stop === "refusal" ? /refused/ : /before any text/);
    assert.equal(readSpend().used, 110n);
  }
});

test("24-hour and future rows, headroom, and permanent per-model revision blocks", () => {
  const dir = setup();
  const ledger = new SpendLedger(join(dir, "spend.sqlite"));
  try {
    const now = Number(process.env.HUNTAWAY_TEST_NOW);
    const booked = ledger.reserve(r, 150000n);
    assert.throws(() => ledger.reserve(r, 150000n), /per-day/);
    assert.equal(ledger.snapshot(now - 2 * 86400000).used, 102000n);
    assert.equal(ledger.snapshot(now + 23 * 3600000).used, 102000n);
    assert.equal(ledger.snapshot(now + 25 * 3600000).used, 0n);
    ledger.settle(booked.id, { amount: 1175n, input: 1165n, output: 5n, outcome: "completed", overrun: true });
    assert.throws(() => ledger.check(r, 300000n, now + 100 * 86400000), /overrun/);
    assert.doesNotThrow(() => ledger.check({ ...r, model: "hwtest.model" }, 300000n));
    assert.doesNotThrow(() => ledger.check({ ...r, revision: 2 }, 300000n));
    assert.throws(() => ledger.check({ ...r, revision: 0 }, 300000n), /overrun/);
  } finally { ledger.close(); }
});

test("a foreign ledger schema refuses before even the count", async () => {
  const dir = setup();
  const db = new DatabaseSync(join(dir, "spend.sqlite"));
  db.exec("PRAGMA user_version = 999"); db.close();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  assert.equal((await prepareAnthropic(options).submit({ onSent() {} })).outcome, "refused");
  assert.equal(calls, 0);
});

test("network classification preserves not-delivered, timeout, redirect and mixed-address distinctions", () => {
  assert.equal(networkOutcome({ cause: { code: "ECONNREFUSED" } }, false).outcome, "refused");
  assert.equal(networkOutcome({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNRESET" }] } }, false).outcome, "uncertain");
  assert.match(networkOutcome({}, true).why, /--timeout/);
  assert.match(networkOutcome({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }, false).why, /5 minutes/);
  assert.match(networkOutcome({ cause: { message: "unexpected redirect" } }, false).why, /never follows/);
});

test("usage too large for SQLite keeps the reservation and still records a permanent overrun block", async () => {
  setup({ HUNTAWAY_MAX_USD_PER_QUESTION: "1000", HUNTAWAY_MAX_USD_PER_DAY: "1000",
    HUNTAWAY_PRICE_ANTHROPIC_CLAUDE_SONNET_5_5: "900,900" });
  let calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1 ? { input_tokens: 1000 } : body(usage(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)));
  const result = await prepareAnthropic({ ...options, model: "claude-sonnet-5-5" }).submit({ onSent() {} });
  assert.equal(result.outcome, "accepted");
  assert.equal((await result.wait()).status, "completed");
  const requestBytes = Buffer.byteLength(JSON.stringify(ANTHROPIC.requestBody({ ...options, model: "claude-sonnet-5-5" }, ANTHROPIC_MODELS[0])), "utf8");
  assert.equal(readSpend().used, BigInt(2 * requestBytes + 64 + 1000) * 900n);
  assert.equal(readSpend().overruns.length, 1);
});

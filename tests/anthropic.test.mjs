// The API-key engine (`huntaway ask --engine anthropic`), against a local stand-in for the Messages API and its count
// endpoint: one count and one billed call, never retried, honest outcomes, and the key never anywhere but the request
// header. No test calls the real API. Every run needs caps, an
// hwtest- key while the test switch is on, and the count before the billed call; everything is checked through the
// CLI, so src/ask can be laid out in any way.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  centsUp, fetchFixtureArgs, hardWorst, line1, line2, newFetchLog, recordedFetches, startSentinel,
} from "./lib/paid-harness.mjs";

const CLI = fileURLToPath(new URL("../bin/huntaway.ts", import.meta.url));
const KEY = "hwtest-anthropic-key-0000-not-real";      // a test key (hwtest-), deliberately unlike any real key format
const QUESTION = "what is the aardvark-kiwi-4417 plan";
const COUNT_PATH = "/v1/messages/count_tokens";
// The count's answer: 13 tokens, an estimated input of 14.3 + 64 tokens.
const COUNTED = 13;
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "standard" };
// Caps no table model's hard worst case is over: the default model's prices aren't these tests' to know.
const CAPS = { HUNTAWAY_MAX_USD_PER_QUESTION: "1000", HUNTAWAY_MAX_USD_PER_DAY: "1000" };
// Nothing from the machine running the tests (its caps, price overrides or test clock) reaches the child.
const BASE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUNTAWAY_")));

let server;
let url;
let port;
let behaviour = "ok";
let seen = [];
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const kind = req.url === COUNT_PATH ? "count" : req.url === "/v1/messages" ? "billed" : "other";
      seen.push({ kind, method: req.method, path: req.url, headers: req.headers, body });
      const send = (status, doc, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_test123", ...headers });
        res.end(JSON.stringify(doc));
      };
      if (kind === "count") return send(200, { input_tokens: COUNTED });
      if (kind !== "billed") return send(404, { type: "error", error: { type: "not_found_error", message: "no such path" } });
      if (behaviour.startsWith("status:")) {
        const status = Number(behaviour.slice(7));
        return send(status, { type: "error", error: { type: status >= 500 ? "api_error" : "invalid_request_error", message: KEY } });
      }
      switch (behaviour) {
        case "ok": return send(200, { id: "msg_1", content: [{ type: "text", text: "the answer" }], stop_reason: "end_turn", usage: USAGE });
        case "two-blocks": return send(200, { content: [{ type: "text", text: "part one, " }, { type: "text", text: "part two" }], stop_reason: "end_turn", usage: USAGE });
        case "truncated": return send(200, { content: [{ type: "text", text: "cut sho" }], stop_reason: "max_tokens", usage: USAGE });
        case "no-text": return send(200, { content: [], stop_reason: "end_turn" });
        case "401": return send(401, { type: "error", error: { type: "authentication_error", message: `bad key ${KEY}` } });
        case "model-404": return send(404, { type: "error", error: { type: "not_found_error", message: "model: claude-other-9 \u001b[31mAPI-TEXT-MARKER" } });
        case "429": return send(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
        case "529": return send(529, { type: "error", error: { type: "overloaded_error", message: "busy" } });
        case "500": return send(500, { type: "error", error: { type: "api_error", message: "/srv/secret/path" } });
        case "odd-type": return send(400, { type: "error", error: { type: "Bad Type! /etc/passwd" } });
        case "redirect": res.writeHead(307, { location: url }); return res.end();          // back to itself
        case "slow-body": res.writeHead(200, { "content-type": "application/json", "request-id": "req_slow" }); return res.write('{"content": [');
        case "reset": return req.socket.destroy();          // the question arrived; the connection is then lost
        case "hang": return;                               // never answer
        case "garbage": res.writeHead(200, { "content-type": "application/json" }); return res.end("not json");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  url = `http://127.0.0.1:${port}/v1/messages`;
});
after(() => server.close());

const home = () => mkdtempSync(join(tmpdir(), "huntaway-api-"));
// The test keychain, outside HUNTAWAY_HOME (so the on-disk checks below never see it), empty unless a test fills it.
const keychainFile = () => join(mkdtempSync(join(tmpdir(), "huntaway-api-kc-")), "keychain.json");
const testEnv = (h, env) => ({ ...BASE, HUNTAWAY_HOME: h, ANTHROPIC_API_KEY: KEY, HUNTAWAY_ENABLE_FAKE_ENGINE: "1",
  HUNTAWAY_TEST_ANTHROPIC_URL: url, HUNTAWAY_TEST_KEYCHAIN_FILE: keychainFile(), ...CAPS, ...env });
function ask(args, { h = home(), env = {}, behave = "ok" } = {}) {
  behaviour = behave;
  seen = [];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "anthropic", ...args], {
      env: testEnv(h, env), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ code, stdout, stderr, h, seen }));
  });
}
const billed = (calls) => calls.filter((c) => c.kind === "billed");
const counted = (calls) => calls.filter((c) => c.kind === "count");
/** The request log's states; [] when nothing was recorded. */
function states(h) {
  if (!existsSync(join(h, "requests.db"))) return [];
  const db = new DatabaseSync(join(h, "requests.db"), { readOnly: true });
  try { return db.prepare("SELECT state FROM requests").all().map((r) => r.state); } finally { db.close(); }
}
function everythingOnDisk(h) {
  return readdirSync(h).filter((f) => statSync(join(h, f)).isFile()).map((f) => readFileSync(join(h, f), "latin1")).join("\n");
}

test("one count and one Messages API call with the owner's key: answered, printed, recorded, both notice lines; no text or key on disk", async () => {
  const r = await ask(["--model", "hwtest-model", "--max-tokens", "300", QUESTION]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "the answer\n");
  assert.deepEqual(r.seen.map((c) => c.kind), ["count", "billed"], "one count, then exactly one call, never retried");
  const call = billed(r.seen)[0];
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/v1/messages");
  for (const c of r.seen) {
    assert.equal(c.headers["x-api-key"], KEY);
    assert.equal(c.headers["anthropic-version"], "2023-06-01");
  }
  assert.deepEqual(JSON.parse(call.body), { model: "hwtest-model", max_tokens: 300, messages: [{ role: "user", content: QUESTION }],
    service_tier: "standard_only" });
  // At most min(100000, 2 × B + 64) × $1.00/M + 300 × $2.00/M for the billed body of B bytes, at the standard price:
  // about 362 + 600 = 962 micro-dollars, $0.01 rounded up (under the old rule, 201200 micro-dollars, $0.21). About
  // (14.3 + 64) + 300 × 2 = 678.3 micro-dollars, $0.000679.
  const most = centsUp(hardWorst(Buffer.byteLength(call.body, "utf8"), 300));
  assert.match(r.stderr, line1("1000.00", "1000.00"));
  assert.match(r.stderr, line2(most, ["0.000679"], "0.00", "1000.00"));
  assert.deepEqual(states(r.h), ["answered"]);
  const disk = everythingOnDisk(r.h);
  for (const secret of [QUESTION, "the answer", KEY]) assert.ok(!disk.includes(secret), `not on disk: ${secret}`);
});

test("defaults: the Sonnet model and a 1024-token cap; several text blocks are joined", async () => {
  const r = await ask(["hi"], { behave: "two-blocks" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "part one, part two\n");
  const body = JSON.parse(billed(r.seen)[0].body);
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(body.max_tokens, 1024);
  assert.equal(JSON.parse(counted(r.seen)[0].body).model, "claude-sonnet-5-5", "the count is for the same model");
});

test("an answer cut at --max-tokens is printed and says so", async () => {
  const r = await ask(["hi"], { behave: "truncated" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "cut sho\n");
  assert.match(r.stderr, /stopped at --max-tokens \(1024\)/);
});

test("an unknown or retired model says which setting to change, and nothing ran", async () => {
  // A model in Huntaway's table that the API doesn't know (any more, or for this key).
  const r = await ask(["--model", "hwtest-model", "hi"], { behave: "model-404" });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /\(404 not_found_error\): the model hwtest-model is unknown, retired or not available to this key; choose another with --model/);
  assert.match(r.stderr, /Nothing ran; you can send it again/);
  assert.doesNotMatch(r.stderr, /API-TEXT-MARKER|claude-other-9|\x1b/, "only our own words and the model asked for: never the API's");
  assert.equal(billed(r.seen).length, 1, "no retry, and no other model tried");
  assert.deepEqual(states(r.h), ["failed"]);
  // A model that isn't in the table at all never reaches the API.
  const unknown = await ask(["--model", "claude-old-1", "hi"], { behave: "model-404" });
  assert.notEqual(unknown.code, 0);
  assert.equal(unknown.seen.length, 0, "not in the capability table: nothing sent, not even the count");
});

test("every status the API never ran is failed (it can be sent again); every other failure may have run", async () => {
  for (const status of [400, 401, 403, 404, 413, 429, 529]) {
    const r = await ask(["hi"], { behave: `status:${status}` });
    assert.equal(r.code, 1, String(status));
    assert.match(r.stderr, new RegExp(`\\(${status} (invalid_request_error|api_error)\\)`), String(status));
    assert.match(r.stderr, /Nothing ran; you can send it again/, String(status));
    assert.equal(billed(r.seen).length, 1, "no retry");
    assert.deepEqual(states(r.h), ["failed"], String(status));
    assert.ok(!r.stderr.includes(KEY) && !everythingOnDisk(r.h).includes(KEY), "the key never echoes or lands on disk");
  }
  for (const status of [500, 502, 504]) {
    const r = await ask(["hi"], { behave: `status:${status}` });
    assert.equal(r.code, 1, String(status));
    assert.match(r.stderr, new RegExp(`not sure it finished \\(the API failed while handling it \\(${status} api_error\\)\\) \\(API request req_test123\\)`));
    assert.match(r.stderr, /may have run/);
    assert.equal(billed(r.seen).length, 1, "never retried, on the may-have-run path too");
    assert.deepEqual(states(r.h), ["uncertain"], String(status));
    assert.ok(!r.stderr.includes(KEY) && !everythingOnDisk(r.h).includes(KEY));
  }
  const odd = await ask(["hi"], { behave: "odd-type" });
  assert.match(odd.stderr, /\(400 error\)/, "an error type that isn't one of the API's is shown as plain error");
  assert.ok(!odd.stderr.includes("passwd"));
  assert.deepEqual(states(odd.h), ["failed"]);
});

test("a lost connection, a redirect, a reply without text or no answer in time is uncertain: it may have run", async () => {
  for (const [behave, extra, words] of [
    ["garbage", [], /not sure it finished \(the API's answer could not be read\)/],
    ["no-text", [], /not sure it finished \(the API answered without any text\)/],
    ["redirect", [], /answered with a redirect, which Huntaway never follows/],
    ["hang", ["--timeout", "1"], /no answer within --timeout/],
    ["slow-body", ["--timeout", "1"], /not sure it finished \(no answer within --timeout\) \(API request req_slow\)/],
    ["reset", [], /the connection to the API was lost/],
  ]) {
    const r = await ask([...extra, "hi"], { behave });
    assert.equal(r.code, 1, behave);
    assert.match(r.stderr, words, behave);
    assert.match(r.stderr, /may have run/, behave);
    assert.equal(billed(r.seen).length, 1, `${behave}: one call only (a redirect is never followed)`);
    assert.deepEqual(states(r.h), ["uncertain"], behave);
  }
});

test("the pipe runs only when chosen, is never handed an API key, and a pipe ask never touches the API", async () => {
  const fakePipe = fileURLToPath(new URL("./fixtures/fake-pipe-mcp.mjs", import.meta.url));
  const h = home();
  const log = join(h, "pipe.log");
  behaviour = "ok";
  seen = [];
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "hi"], {
      env: { ...process.env, HUNTAWAY_HOME: h, ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: KEY, HUNTAWAY_ENABLE_FAKE_ENGINE: "1",
        HUNTAWAY_ENGINE: "pipe", HUNTAWAY_TEST_ANTHROPIC_URL: url, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, fakePipe]), FAKE_PIPE_LOG: log },
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, "pong from the pipe\n");
  assert.equal(seen.length, 0, "the API was never called");
  assert.ok(!readFileSync(log, "utf8").includes("saw-api-key"), "the pipe's environment had no API key");
  assert.doesNotMatch(out.stderr, /This question uses your paid/, "the pipe isn't a paid engine: no notice");
});

test("nothing listening is failed (never delivered), with plain words", async () => {
  const probe = createServer();                            // find a port, then free it: nothing listens there
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closed = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const r = await ask(["hi"], { env: { HUNTAWAY_TEST_ANTHROPIC_URL: `http://127.0.0.1:${closed}/v1/messages` } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not be reached/);
  assert.match(r.stderr, /Nothing ran/);
  // The count is the first call, so nothing billed was ever attempted: failed, if it was recorded at all.
  assert.ok(["[]", '["failed"]'].includes(JSON.stringify(states(r.h))), JSON.stringify(states(r.h)));
});

test("no key, or a key no header could carry: a setup error after notice line 1, before anything is recorded or sent", async () => {
  // An empty ANTHROPIC_API_KEY counts as unset, so the (empty) test keychain is looked at, and has no key.
  for (const [key, words] of [["", /ANTHROPIC_API_KEY[\s\S]*keychain|keychain[\s\S]*ANTHROPIC_API_KEY/i],
    [`${KEY}\n`, /not a usable key/], ["two words", /not a usable key/]]) {
    const h = home();
    const r = await ask(["hi"], { h, env: { ANTHROPIC_API_KEY: key } });
    assert.equal(r.code, 1, JSON.stringify(key));
    assert.match(r.stderr, words, JSON.stringify(key));
    assert.match(r.stderr, line1("1000.00", "1000.00"), "the caps held, so notice line 1 came first");
    assert.ok(!r.stderr.includes(KEY), "the key is never repeated");
    assert.equal(r.seen.length, 0);
    assert.deepEqual(readdirSync(h), [], "nothing recorded");
  }
});

test("options: codex, --effort, --max-tokens beyond 8192 and --timeout beyond 300 are usage errors here", async () => {
  for (const args of [["--family", "codex", "hi"], ["--effort", "high", "hi"], ["--max-tokens", "0", "hi"],
    ["--max-tokens", "8193", "hi"], ["--timeout", "301", "hi"]]) {
    const r = await ask(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.seen.length, 0);
  }
  const max = await ask(["--model", "hwtest-model", "--max-tokens", "8192", "--timeout", "300", "hi"]);
  assert.equal(max.code, 0, max.stderr);
  assert.equal(JSON.parse(billed(max.seen)[0].body).max_tokens, 8192);
  // With the pipe, --max-tokens is a usage error, not silently ignored. Isolated like every other test here, so a
  // regression could never send a real question through a real pipe.
  const fakePipe = fileURLToPath(new URL("./fixtures/fake-pipe-mcp.mjs", import.meta.url));
  const h = home();
  const pipeWithCap = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "pipe", "--max-tokens", "10", "hi"], {
      env: { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, fakePipe]) }, stdio: "ignore" });
    p.on("close", resolve);
  });
  assert.equal(pipeWithCap, 2);
  assert.deepEqual(readdirSync(h), [], "nothing recorded");
});

test("what a failed call means, seen from outside: never delivered is failed; lost after arriving, or our own --timeout, may have run", async () => {
  // (The finer cases, an attempt per address and fetch's own 5-minute wait, can't be produced from outside.)
  const lost = await ask(["--model", "hwtest-model", "hi"], { behave: "reset" });
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /the connection to the API was lost/);
  assert.match(lost.stderr, /may have run/);
  assert.deepEqual(states(lost.h), ["uncertain"]);
  const ours = await ask(["--model", "hwtest-model", "--timeout", "1", "hi"], { behave: "hang" });
  assert.equal(ours.code, 1);
  assert.match(ours.stderr, /no answer within --timeout/, "our own time limit is named as such");
  assert.deepEqual(states(ours.h), ["uncertain"]);
});

test("only the API key variables are kept from the pipe; subscription sign-ins and everything else pass", async () => {
  const fakePipe = fileURLToPath(new URL("./fixtures/fake-pipe-mcp.mjs", import.meta.url));
  const h = home();
  const envLog = join(h, "pipe-env.json");
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "pipe", "hi"], {
      env: { ...BASE, HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, fakePipe]), FAKE_PIPE_ENV_LOG: envLog,
        ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b", OPENAI_API_KEY: "c", CODEX_API_KEY: "d", GEMINI_API_KEY: "e",
        GOOGLE_API_KEY: "f", OPENROUTER_API_KEY: "g", CLAUDE_CODE_OAUTH_TOKEN: "keep", PATH: process.env.PATH, HOME: h },
      stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(JSON.parse(readFileSync(envLog, "utf8")), ["CLAUDE_CODE_OAUTH_TOKEN", "PATH", "HOME"]);
});

test("the stand-in address is honoured only on this machine and only with Huntaway's test switch on", async () => {
  // The control: the switch on and a local stand-in, and it's used.
  const local = await ask(["--model", "hwtest-model", "hi"]);
  assert.equal(local.code, 0, local.stderr);
  assert.deepEqual(local.seen.map((c) => c.kind), ["count", "billed"]);
  // Below, nothing may leave this machine on any supported Node. The shared fetch fixture (tests/lib/paid-harness.mjs,
  // loaded with --import) replaces fetch in the child and in the workers it starts: each call's URL and method (never
  // its headers or body) is written down, and the answer is a refused connection, so nothing is sent anywhere. A
  // sentinel proxy (with no NO_PROXY) is a second layer where NODE_USE_ENV_PROXY works (Node 22.21+ and 24.5+; older
  // Node ignores it).
  const askCaught = (args, env) => {
    behaviour = "ok";
    seen = [];
    const h = home();
    const log = newFetchLog();
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--experimental-strip-types", ...fetchFixtureArgs(), CLI,
        "ask", "--engine", "anthropic", ...args], { env: testEnv(h, { ...env, HUNTAWAY_TEST_FETCH_LOG: log }), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d) => { stdout += d; });
      p.stderr.on("data", (d) => { stderr += d; });
      p.on("close", (code) => {
        try {
          resolve({ code, stdout, stderr, h, seen, fetches: recordedFetches(log) });
        } catch (error) {
          reject(error);
        }
      });
    });
  };
  const sentinel = await startSentinel();
  try {
    // Switch on, an address that isn't a local stand-in: refused, and never the real API instead.
    for (const far of ["http://example.com:80/v1/messages", `https://127.0.0.1:${port}/v1/messages`,
      `http://127.0.0.1.example.com:${port}/v1/messages`]) {
      sentinel.hits.length = 0;
      const r = await askCaught(["--model", "hwtest-model", "hi"], { HUNTAWAY_TEST_ANTHROPIC_URL: far, ...sentinel.env() });
      assert.equal(r.code, 1, far);
      assert.equal(r.seen.length, 0, `${far}: nothing reached the stand-in`);
      assert.deepEqual(r.fetches, [], `${far}: never a key sent anywhere but a local stand-in: no fetch at all`);
      assert.deepEqual(sentinel.hits, [], `${far}: no connection anywhere`);
    }
    // Switch off: the stand-in address is ignored, and the real API is the only place a key goes (here a key in no
    // real format, and not hwtest-; the replaced fetch refuses the connection, so nothing is sent). The refused count
    // fails the question, so it is the one call: no retry, and no billed call after a failed count.
    sentinel.hits.length = 0;
    const off = await askCaught(["hi"], { HUNTAWAY_ENABLE_FAKE_ENGINE: undefined, ANTHROPIC_API_KEY: "huntaway-test-key-0000-not-real",
      ...sentinel.env() });
    assert.equal(off.code, 1);
    assert.equal(off.seen.length, 0, "the stand-in is never used with the switch off");
    assert.deepEqual(off.fetches, [{ url: "https://api.anthropic.com/v1/messages/count_tokens", method: "POST" }],
      "exactly one count to the real API, and no billed call");
    assert.deepEqual(sentinel.hits, [], "the replaced fetch made no connection");
  } finally {
    await sentinel.close();
  }
});

test("HUNTAWAY_ENGINE chooses the default engine; --engine still wins; an unknown value is a usage error", async () => {
  const run = (args, extraEnv) => new Promise((resolve) => {
    behaviour = "ok";
    seen = [];
    const h = home();
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", ...args], {
      env: { ...testEnv(h, {}), HUNTAWAY_FAKE_ANSWER: "from fake", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.on("close", (code) => resolve({ code, stdout, calls: billed(seen).length, sent: seen.length, h }));
  });
  const chosen = await run(["hi"], { HUNTAWAY_ENGINE: "anthropic" });
  assert.equal(chosen.code, 0);
  assert.equal(chosen.stdout, "the answer\n");
  assert.equal(chosen.calls, 1);
  const overridden = await run(["--engine", "fake", "hi"], { HUNTAWAY_ENGINE: "anthropic" });
  assert.equal(overridden.stdout, "from fake\n");
  assert.equal(overridden.sent, 0);
  const bogus = await run(["hi"], { HUNTAWAY_ENGINE: "openrouter" });
  assert.equal(bogus.code, 2);
  assert.equal(bogus.sent, 0);
  assert.deepEqual(readdirSync(bogus.h), [], "nothing recorded");
  const bogusWithFlag = await run(["--engine", "fake", "hi"], { HUNTAWAY_ENGINE: "openrouter" });
  assert.equal(bogusWithFlag.code, 2, "a bad HUNTAWAY_ENGINE is reported even when --engine is given");
  const fakePipe = fileURLToPath(new URL("./fixtures/fake-pipe-mcp.mjs", import.meta.url));
  const pipeEnv = { HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, fakePipe]) };
  const pipeWins = await run(["--engine", "pipe", "hi"], { HUNTAWAY_ENGINE: "anthropic", ...pipeEnv });
  assert.equal(pipeWins.stdout, "pong from the pipe\n");
  assert.equal(pipeWins.sent, 0);
  const pipeChosen = await run(["hi"], { HUNTAWAY_ENGINE: "pipe", ...pipeEnv });
  assert.equal(pipeChosen.stdout, "pong from the pipe\n");
  assert.equal(pipeChosen.sent, 0);
  // Unset or empty: the owner's own API key. The pipe never runs unless chosen, even when one is configured.
  for (const value of ["", undefined]) {
    const env = { ...pipeEnv, HUNTAWAY_ENGINE: value };
    const r = await run(["hi"], env);
    assert.equal(r.stdout, "the answer\n", JSON.stringify(value));
    assert.equal(r.calls, 1);
  }
});

test("a key in a real key's format is never sent to a local stand-in", async () => {
  // Assembled here: no real-looking key sits in this file. With the test switch on, every key that isn't hwtest- is
  // refused before sending; one with spaces or a line break is not a usable key at all, and says so.
  const unusable = /^Error: ANTHROPIC_API_KEY is not a usable key/m;
  for (const [realLooking, want] of [["sk-" + "ant-" + "x".repeat(24), /^Error: /m], ["sk-" + "ant-api03-" + "y".repeat(40), /^Error: /m],
    [" sk-" + "ant-" + "z".repeat(24), unusable], ["sk-" + "ant-" + "w".repeat(24) + "\n", unusable],
    ["sk-" + "ant-" + "v".repeat(24) + " ", unusable]]) {
    const r = await ask(["hi"], { env: { ANTHROPIC_API_KEY: realLooking } });
    assert.equal(r.code, 1, JSON.stringify(realLooking.slice(0, 12)));
    assert.equal(r.seen.length, 0, "nothing reached the stand-in");
    assert.match(r.stderr, want, JSON.stringify(realLooking.slice(0, 12)));
    // Not even part of the key is echoed: no eight of its characters in a row appear in what was printed.
    const key = realLooking.trim();
    for (let i = 0; i + 8 <= key.length; i += 1) assert.ok(!r.stderr.includes(key.slice(i, i + 8)), "no part of the key is printed");
  }
});

test("a bad HUNTAWAY_ENGINE says what is wrong", async () => {
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "hi"], {
      env: { ...process.env, HUNTAWAY_ENGINE: "openrouter" }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(out.code, 2);
  // It lists every engine, in whatever wording.
  const line = out.stderr.split("\n").find((l) => l.includes("HUNTAWAY_ENGINE must be "));
  assert.ok(line !== undefined, out.stderr);
  for (const engine of ["pipe", "anthropic", "openai"]) assert.match(line, new RegExp(`\\b${engine}\\b`), `names ${engine}: ${line}`);
});

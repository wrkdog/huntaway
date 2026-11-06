// The OpenAI API-key engine (`huntaway ask --engine openai`) on the shared paid layer,
// against a local stand-in for the Responses API. Only what the CLI, the stand-in and the files under the test HOME
// show. No test calls the real API or the real keychain: a preload (TRIPWIRE, below) blocks and reports any connection
// off this machine and any use of `security`, in every run.
//
// The money, for hwtest-model. Both caps apply to the hard worst case, at the STANDARD
// price ($1/M in, $2/M out; every call pins service_tier "default"). Its hard input is min(100000, 2 x the UTF-8 bytes
// of the billed request's JSON body + 64), so the hard worst case grows with the question:
// - a small question (QUESTION, a body of about a hundred bytes) is a few thousand micro-dollars: "At most $0.01";
// - BIG, a body of 49,968 bytes or more, reaches the 100000 limit: 100000 + 1024 x 2 = 102,048 micro-dollars, "At most
//   $0.11", at the default --max-tokens. So a kept BIG reservation reads $0.10-$0.11, a $0.10 per-question cap refuses
//   BIG before the key is read, and with both caps at $0.20 one BIG reservation fits and two do not.
// Where a test needs an exact figure for a smaller question, it works it out from the body the stand-in received.
// Validated usage at the default tier settles at the standard price; a missing or non-standard tier at the priority
// price ($2/M, $4/M), as an overrun, even above the (standard-priced) reservation.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CLI = fileURLToPath(new URL("../bin/huntaway.ts", import.meta.url));
const FAKE_PIPE = fileURLToPath(new URL("./fixtures/fake-pipe-mcp.mjs", import.meta.url));
const MODEL = "hwtest-model";
const KEY = "hwtest-openai-plain-key-0000";
const QUESTION = "what is the aardvark-kiwi-4417 plan";
// 56,035 ASCII bytes with nothing JSON escapes, so any billed body holding it is past 49,968 bytes: the limit binds.
const BIG = `${"aardvark kiwi ".repeat(4000)}${QUESTION}`;
const ANSWER = "the otter-quince-9921 answer";
const REQUEST_ID = "req_test123";
const COUNT_PATH = "/v1/responses/input_tokens";
const BILLED_PATH = "/v1/responses";

const CAPS = (question, day) => ({ HUNTAWAY_MAX_USD_PER_QUESTION: question, HUNTAWAY_MAX_USD_PER_DAY: day });
const TIGHT = CAPS("0.20", "0.20");                       // room for one BIG reservation (102,048), not two (204,096)
const ROOMY = CAPS("100.00", "100.00");                   // doctor: above the cap any table model needs for 10,240 bytes

const LINE_1 = /^This question uses your paid OpenAI API key; any charge goes to that account\. Huntaway first asks OpenAI to count the question \([^)]*\), which sends it to OpenAI\. Caps: \$0\.50 a question, \$5\.00 a day \(Huntaway's own use on this machine\)\.$/m;
const LINE_1_ANY_CAPS = /^This question uses your paid OpenAI API key; .*, which sends it to OpenAI\. Caps: \$\d+\.\d\d a question, \$\d+\.\d\d a day \(Huntaway's own use on this machine\)\.$/m;
// The first (small) question on an empty ledger, counted at 10. "At most" is the hard worst case, (2 x its body's
// bytes + 64) + 1024 x 2 micro-dollars, a few thousand, rounded up to the cent: $0.01. "About" is the estimate to three
// significant figures: (10 x 1.10 + 64) x $1/M + 1024 x $2/M = 2,123 micro-dollars at the standard price ($0.00212, or
// $0.00213 rounded up). The priority price is only for settling a non-standard tier, so never 4,246 here; either
// rounding is accepted. "Used" leaves out this question's own reservation.
const LINE_2 = /^At most \$0\.01 for this question \(about \$0\.00(?:212|213) by OpenAI's count\); \$0\.00 of your \$5\.00 used in the last 24 hours\.$/m;
const LINE_2_ANY = /^At most \$\d+\.\d\d for this question \(about \$\d+(?:\.\d+)? by OpenAI's count\); \$\d+\.\d\d of your \$\d+\.\d\d used in the last 24 hours\.$/m;
const AT_MOST = (dollars) => new RegExp(String.raw`^At most \$${dollars.replace(".", String.raw`\.`)} for this question \(`, "m");
/** hwtest-model's hard worst case in micro-dollars, for a billed body of `body`: standard prices only. */
const hardWorstCase = (body, maxTokens) => Math.min(100000, 2 * Buffer.byteLength(body, "utf8") + 64) + maxTokens * 2;
/** Micro-dollars rounded up to the cent, as "0.03" (every worst case is rounded up). */
const centsUp = (micro) => (Math.ceil(micro / 10_000) / 100).toFixed(2);
const OVERRUN_WARNING = /^Warning:|overrun/im;            // anchored: Node's own ExperimentalWarning must not count
const NO_MORE_ROOM = /HUNTAWAY_MAX_USD_PER_DAY|per-day|day cap|last 24 hours/i;

// With the test switch on, the fake keychain works on every platform, Linux included, so the keychain tests run
// everywhere, CI too.

// Blocks and reports what no test may ever do, so a wrong build can't reach the real API or the real keychain.
const TRIPWIRE = String.raw`
import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const note = (what) => appendFileSync(process.env.HUNTAWAY_TEST_TRIPWIRE_LOG, what + "\n");
const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let host = "an unreadable address";
  try { host = new URL(String(input?.url ?? input)).hostname; } catch {}
  if (LOCAL.has(host)) return realFetch(input, init);
  note("fetch to " + host);
  return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
};
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = options !== null && typeof options === "object"
    ? options.host ?? options.path ?? "localhost"
    : typeof args[1] === "string" ? args[1] : "localhost";
  if (LOCAL.has(host)) return realConnect.apply(this, args);
  note("connection to " + host);
  process.nextTick(() => this.destroy(new Error("blocked by the test tripwire")));
  return this;
};
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const real = childProcess[name];
  childProcess[name] = (command, ...rest) => {
    if (/(^|[\s/])security(\s|$)/.test(String(command))) {
      note("the real security command");
      throw new Error("blocked by the test tripwire");
    }
    return real(command, ...rest);
  };
}
syncBuiltinESMExports();
`;

// ---- What the stand-in can answer ----------------------------------------------------------------------------------

const OMIT = Symbol("left out of the reply");
const json = (status, doc) => ({ status, doc });
const raw = (status, text) => ({ status, text });
const hang = { hang: true };                              // never answers
const drop = { drop: true };                              // closes the connection without answering
const redirect = { redirect: true };                      // to itself, with the key in the address if it could be
const counted = (n) => json(200, { object: "response.input_tokens", input_tokens: n });
const usageOf = (input, output) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output,
});
const message = (texts) => ({
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: texts.map((text) => ({ type: "output_text", text, annotations: [] })),
});
function responseDoc({ text = [ANSWER], output, usage = usageOf(10, 20), tier = "default", incomplete } = {}) {
  const doc = {
    id: "resp_test",
    object: "response",
    status: incomplete ? "incomplete" : "completed",
    incomplete_details: incomplete ? { reason: incomplete } : null,
    model: MODEL,
    output: output ?? [message(text)],
  };
  if (tier !== OMIT) doc.service_tier = tier;
  if (usage !== OMIT) doc.usage = usage;
  return doc;
}
const answered = (options) => json(200, responseDoc(options));
const cutBeforeText = (usage) => answered({
  output: [{ type: "reasoning", id: "rs_1", summary: [] }],
  incomplete: "max_output_tokens",
  usage,
});
// A provider's error can repeat the key it was given; its words must never reach the owner.
const apiError = (status) => (presented) => json(status, {
  error: {
    message: `Incorrect API key provided: ${presented}. API-TEXT-MARKER \u001b[31m /srv/secret/path`,
    type: status >= 500 ? "server_error" : "invalid_request_error",
    param: null,
    code: "test_code",
  },
});
const garbage = (presented) => raw(200, `not json ${presented}`);

// ---- The stand-in and the CLI ---------------------------------------------------------------------------------------

let server;
let standInUrl;
let closedUrl;
let tripwire;
let scene = {};
let seen = [];
let liveStderr = "";
const madeFolders = [];

before(async () => {
  const wire = mkdtempSync(join(tmpdir(), "huntaway-openai-wire-"));
  madeFolders.push(wire);
  tripwire = join(wire, "tripwire.mjs");
  writeFileSync(tripwire, TRIPWIRE);
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const current = scene;
      const path = req.url.split("?")[0];
      const kind = path === COUNT_PATH ? "count" : path === BILLED_PATH ? "billed" : "other";
      const call = {
        kind,
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
        arrivedAt: Date.now(),
      };
      seen.push(call);
      if (current.holdMs) {
        await new Promise((resolve) => setTimeout(resolve, current.holdMs));
        call.stderrAfterHold = liveStderr;
      }
      call.answeredAt = Date.now();
      const presented = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const planned = kind === "other" ? json(404, { error: { message: "no such path" } }) : current[kind];
      const reply = typeof planned === "function" ? planned(presented) : planned;
      if (reply.hang) return undefined;
      if (reply.drop) return req.socket.destroy();
      if (reply.redirect) {
        res.writeHead(307, { location: `${standInUrl}?leak=${presented}` });
        return res.end();
      }
      res.writeHead(reply.status, { "content-type": "application/json", "x-request-id": REQUEST_ID });
      return res.end(reply.text ?? JSON.stringify(reply.doc));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  standInUrl = `http://127.0.0.1:${server.address().port}${BILLED_PATH}`;
  const probe = createServer();                           // find a port, then free it: nothing listens there
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  closedUrl = `http://127.0.0.1:${probe.address().port}${BILLED_PATH}`;
  await new Promise((resolve) => probe.close(resolve));
});

after(() => {
  server.closeAllConnections();
  server.close();
  for (const folder of madeFolders) rmSync(folder, { recursive: true, force: true });
});

function newDirs() {
  const root = mkdtempSync(join(tmpdir(), "huntaway-openai-"));
  madeFolders.push(root);
  const dirs = {
    root,
    home: join(root, "home"),
    data: join(root, "home", "huntaway"),
    tmp: join(root, "tmp"),
    keychain: join(root, "home", "fake-keychain.json"),
    tripped: join(root, "tripwire.log"),
  };
  mkdirSync(dirs.data, { recursive: true, mode: 0o700 });
  mkdirSync(dirs.tmp, { mode: 0o700 });
  return dirs;
}

/** A minimal environment, so a real key in the developer's shell can never reach a test run. undefined removes a name. */
function childEnv(dirs, extra) {
  const env = {
    PATH: process.env.PATH,
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    HUNTAWAY_HOME: dirs.data,
    HUNTAWAY_ALIAS: "test-mac",
    HUNTAWAY_ENABLE_FAKE_ENGINE: "1",
    HUNTAWAY_TEST_OPENAI_URL: standInUrl,
    HUNTAWAY_TEST_KEYCHAIN_FILE: dirs.keychain,
    HUNTAWAY_TEST_TRIPWIRE_LOG: dirs.tripped,
    ...CAPS("0.50", "5.00"),
    ...extra,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

async function cli(args, { dirs = newDirs(), env = {}, input, scene: planned = {}, watchdogMs = 45_000 } = {}) {
  scene = { count: counted(10), billed: answered(), ...planned };
  seen = [];
  liveStderr = "";
  const started = Date.now();
  const run = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", tripwire, CLI, ...args], {
      env: childEnv(dirs, env),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const watchdog = setTimeout(() => p.kill("SIGKILL"), watchdogMs);
    if (input !== undefined) {
      p.stdin.on("error", () => {});                      // it may exit without reading
      p.stdin.end(input);
    }
    let stdout = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { liveStderr += d; });
    p.on("close", (code) => {
      clearTimeout(watchdog);
      const calls = seen;
      resolve({
        code,
        elapsedMs: Date.now() - started,
        stdout,
        stderr: liveStderr,
        dirs,
        seen: calls,
        count: calls.filter((c) => c.kind === "count"),
        billed: calls.filter((c) => c.kind === "billed"),
      });
    });
  });
  const tripped = existsSync(dirs.tripped) ? readFileSync(dirs.tripped, "utf8") : "";
  assert.equal(tripped, "", "a test run must never leave this machine or use the real keychain");
  assert.deepEqual(run.seen.filter((c) => c.kind === "other").map((c) => `${c.method} ${c.url}`), [],
    `only ${BILLED_PATH} and ${COUNT_PATH} exist`);
  return run;
}

const ask = (args, options = {}) => cli(["ask", "--engine", "openai", "--model", MODEL, ...args], {
  ...options,
  env: { OPENAI_API_KEY: KEY, ...options.env },
});
const doctor = (dirs, env = {}) => cli(["doctor"], { dirs, env: { HUNTAWAY_ENGINE: "openai", OPENAI_API_KEY: KEY, ...ROOMY, ...env } });
const storeKey = (dirs, key, env = {}) => cli(["key", "set", "openai"], { dirs, input: `${key}\n`, env });

const newCanary = () => `hwtest-canary-${randomBytes(16).toString("hex")}`;
/** A key in a real key's format. Assembled here: no real-looking key sits in this file. */
const realFormatKey = () => `sk-${"proj-"}${randomBytes(24).toString("hex")}`;
/** Everything printed except Node's own warnings, which hold digits and the word "Warning". */
const ownWords = (text) => text.split("\n").filter((line) => !/^\((?:node:|Use `node)/.test(line)).join("\n");

function states(dirs) {
  const db = new DatabaseSync(join(dirs.data, "requests.db"), { readOnly: true });
  try { return db.prepare("SELECT state FROM requests").all().map((r) => r.state); } finally { db.close(); }
}

/** What `doctor` says has been used in the last 24 hours, in dollars ("$X used in the last 24 hours"). */
async function usedDollars(dirs) {
  const r = await doctor(dirs);
  const shown = r.stdout.match(/\$(\d+\.\d\d) used in the last 24 hours/);
  assert.ok(shown, `doctor shows what was used:\n${r.stdout}`);
  return Number(shown[1]);
}
async function assertUsedBetween(dirs, low, high, what) {
  const used = await usedDollars(dirs);
  assert.ok(used >= low && used <= high, `${what}: doctor shows $${used}, expected $${low} to $${high}`);
}

/**
 * Settled at 0, after a BIG question: doctor shows nothing used, and the whole day cap is still free for the next BIG
 * question (a kept 102,048 would leave too little of TIGHT's $0.20 for it).
 */
async function assertSettledAtZero(dirs) {
  assert.equal(await usedDollars(dirs), 0, "settled at 0");
  const next = await ask([BIG], { dirs, env: TIGHT });
  assert.equal(next.code, 0, `the headroom came back: ${next.stderr}`);
  assert.equal(next.billed.length, 1);
}

/**
 * The full reservation of a BIG question (102,048) stayed: doctor shows it, and with room for one the next BIG question
 * is refused by the read-only ledger look, after notice line 1 and the key, and before the count: the question
 * isn't sent for nothing.
 */
async function assertReservationKept(dirs) {
  await assertUsedBetween(dirs, 0.10, 0.11, "the reservation stayed");
  const next = await ask([BIG], { dirs, env: TIGHT });
  assert.equal(next.code, 1, `no headroom left: ${next.stderr}`);
  assert.equal(next.count.length, 0, "no day headroom is refused before the count");
  assert.equal(next.billed.length, 0, "nothing billed");
  assert.match(next.stderr, LINE_1_ANY_CAPS, "line 1 comes before the ledger look");
  assert.doesNotMatch(next.stderr, LINE_2_ANY);
  assert.match(ownWords(next.stderr), NO_MORE_ROOM);
}

/** An overrun: a warning was printed, further calls to this model are refused before the count, and doctor fails. */
async function assertOverrun(dirs, r) {
  assert.match(ownWords(r.stderr), OVERRUN_WARNING, "a warning is printed");
  const next = await ask([QUESTION], { dirs });
  assert.equal(next.code, 1, `the model is stopped: ${next.stderr}`);
  assert.equal(next.count.length, 0, "a blocked model is refused before the count");
  assert.equal(next.billed.length, 0, "nothing billed");
  assert.match(next.stderr, LINE_1_ANY_CAPS, "line 1 comes before the ledger look");
  assert.doesNotMatch(next.stderr, LINE_2_ANY);
  const d = await doctor(dirs);
  assert.match(d.stdout, /^FAIL\b.*(?:overrun|hwtest-model)/im, "doctor shows it as a FAIL");
  assert.notEqual(d.code, 0);
}

/** The next question runs normally: no overrun, and no warning on this one. */
async function assertNoOverrun(dirs, r) {
  assert.doesNotMatch(ownWords(r.stderr), OVERRUN_WARNING);
  const next = await ask([QUESTION], { dirs });
  assert.equal(next.code, 0, `not stopped: ${next.stderr}`);
  assert.equal(next.billed.length, 1);
}

function walk(folder, skip, found = []) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (path === skip) continue;
    found.push({ path, name: entry.name, isFile: entry.isFile() });
    if (entry.isDirectory()) walk(path, skip, found);
  }
  return found;
}

/** The key is in the one Authorization header of a call, exactly, and nowhere else the stand-in can see. */
function assertKeyOnlyInAuthHeader(calls, needles, key) {
  for (const call of calls) {
    assert.equal(call.headers.authorization, `Bearer ${key}`, `${call.kind}: the auth header carries the key`);
    const others = [call.method, call.url, call.body];
    let authHeaders = 0;
    for (let i = 0; i < call.rawHeaders.length; i += 2) {
      if (call.rawHeaders[i].toLowerCase() === "authorization") authHeaders += 1;
      else others.push(call.rawHeaders[i], call.rawHeaders[i + 1]);
    }
    assert.equal(authHeaders, 1, `${call.kind}: one auth header`);
    for (const text of others) {
      for (const needle of needles) assert.ok(!text.includes(needle), `${call.kind}: the key is only in the auth header`);
    }
  }
}

/** The canary check: the canary is in no output, no file under HOME and TMP (but the fake keychain), and no other request part. */
function assertNoCanary(canary, dirs, runs) {
  const needles = [canary, canary.slice("hwtest-canary-".length), Buffer.from(canary).toString("base64")];
  for (const run of runs) {
    for (const needle of needles) {
      assert.ok(!run.stdout.includes(needle), "the canary is not in stdout");
      assert.ok(!run.stderr.includes(needle), "the canary is not in stderr");
    }
    assertKeyOnlyInAuthHeader(run.seen, needles, canary);
  }
  for (const entry of [...walk(dirs.home, dirs.keychain), ...walk(dirs.tmp, dirs.keychain)]) {
    for (const needle of needles) {
      assert.ok(!entry.name.includes(needle), `the canary is not in a file name under ${entry.path}`);
      if (entry.isFile) assert.ok(!readFileSync(entry.path).includes(needle), `the canary is not in ${entry.path}`);
    }
  }
}

/** Not even part of a key is printed: no eight of its characters in a row. `body` leaves out a fixed prefix. */
function assertNoPartPrinted(body, text) {
  for (let i = 0; i + 8 <= body.length; i += 1) assert.ok(!text.includes(body.slice(i, i + 8)), "no part of the key is printed");
}

// ---- The request ----------------------------------------------------------------------------------------------------

test("one count, then one billed call: the Bearer key, the exact body, and nothing kept on disk", async () => {
  const r = await ask(["--max-tokens", "300", QUESTION]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${ANSWER}\n`);
  assert.deepEqual(r.seen.map((c) => `${c.method} ${c.url}`), [`POST ${COUNT_PATH}`, `POST ${BILLED_PATH}`],
    "the count comes first, and neither is retried");
  assertKeyOnlyInAuthHeader(r.seen, [KEY], KEY);
  assert.deepEqual(JSON.parse(r.billed[0].body),
    { model: MODEL, input: QUESTION, max_output_tokens: 300, service_tier: "default", store: false });
  const count = JSON.parse(r.count[0].body);
  assert.equal(count.model, MODEL);
  assert.equal(count.input, QUESTION);
  assert.deepEqual(states(r.dirs), ["answered"]);
  const ledger = join(r.dirs.data, "spend.sqlite");
  assert.ok(existsSync(ledger), "the ledger sits in Huntaway's folder");
  assert.ok(!readFileSync(ledger).includes(REQUEST_ID), "the ledger holds no request id");
  for (const entry of [...walk(r.dirs.home), ...walk(r.dirs.tmp)].filter((e) => e.isFile)) {
    const bytes = readFileSync(entry.path);
    for (const secret of [QUESTION, ANSWER, KEY]) assert.ok(!bytes.includes(secret), `${secret} is not in ${entry.path}`);
  }
});

test("HUNTAWAY_ENGINE=openai chooses the engine, and --max-tokens defaults to 1024", async () => {
  const r = await cli(["ask", "--model", MODEL, QUESTION], { env: { HUNTAWAY_ENGINE: "openai", OPENAI_API_KEY: KEY } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${ANSWER}\n`);
  assert.equal(r.count.length, 1);
  assert.equal(r.billed.length, 1);
  assert.equal(JSON.parse(r.billed[0].body).max_output_tokens, 1024);
});

test("the notice: line 1 before the count, line 2 after it and before the billed call, each once, on stderr", async () => {
  const r = await ask([QUESTION], { scene: { holdMs: 250 } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${ANSWER}\n`, "the notice is not in the answer");
  assert.match(r.stderr, LINE_1);
  assert.match(r.stderr, LINE_2);
  assert.equal(r.stderr.match(/^This question uses/gm).length, 1);
  assert.equal(r.stderr.match(/^At most \$/gm).length, 1);
  assert.ok(r.stderr.search(LINE_1) < r.stderr.search(LINE_2), "line 1 comes first");
  const [count, billed] = r.seen;
  assert.match(count.stderrAfterHold, LINE_1, "line 1 was printed before the count was answered");
  assert.doesNotMatch(count.stderrAfterHold, LINE_2_ANY, "line 2 waits for the count");
  assert.match(billed.stderrAfterHold, LINE_2_ANY, "line 2 was printed before the billed call was answered");
  assert.ok(billed.arrivedAt >= count.answeredAt, "the billed call waits for the count's answer");
});

test("line 2: 'At most' follows --max-tokens, rounded up to the cent; 'used' leaves out this question's own reservation", async () => {
  const dirs = newDirs();
  const first = await ask([BIG], { dirs, scene: { billed: apiError(500) } });   // uncertain: keeps 102,048
  assert.equal(first.code, 1, first.stderr);
  assert.match(first.stderr, AT_MOST("0.11"));
  assert.match(first.stderr, /; \$0\.00 of your \$5\.00 used in the last 24 hours\.$/m, "an empty window, before its own");
  const second = await ask(["--max-tokens", "8192", BIG], { dirs });
  assert.equal(second.code, 0, second.stderr);
  // 100000 x $1/M + 8192 x $2/M = 116,384 micro-dollars: $0.12. The window holds the first one's 102,048 and no more.
  assert.match(second.stderr, AT_MOST("0.12"));
  assert.match(second.stderr, /^At most \$0\.12 for this question \([^)]*\); \$0\.1[01] of your \$5\.00 used in the last 24 hours\.$/m);
});

test("below the limit, the hard input is 2 x the billed body's UTF-8 bytes + 64: line 2 and the cap follow that body", async () => {
  // Two-byte characters, so the body's UTF-8 bytes, not its characters or the question's alone, are what count.
  const question = `${"ü".repeat(4000)} ${QUESTION}`;
  const dirs = newDirs();
  const first = await ask([question], { dirs });
  assert.equal(first.code, 0, first.stderr);
  const body = first.billed[0].body;
  const bytes = Buffer.byteLength(body, "utf8");
  assert.ok(bytes > Buffer.byteLength(question, "utf8"), "the whole JSON body, not only the question");
  assert.ok(2 * bytes + 64 < 100000, "the byte bound binds, not the limit");
  assert.match(first.stderr, AT_MOST(centsUp(hardWorstCase(body, 1024))), `a ${bytes}-byte body at the default --max-tokens`);
  // A --max-tokens with as many digits as 1024 (so the body keeps its length) that brings the hard worst case to a whole
  // cent: that cent fits as the per-question cap to the micro-dollar, and one token more does not.
  const cap = Math.ceil(hardWorstCase(body, 1024) / 10_000) * 10_000;
  const fits = (cap - (2 * bytes + 64)) / 2;
  assert.ok(Number.isInteger(fits) && fits >= 1024 && fits + 1 <= 8192, `--max-tokens ${fits}`);
  const caps = CAPS(centsUp(cap), "5.00");
  const atCap = await ask(["--max-tokens", String(fits), question], { dirs, env: caps });
  assert.equal(atCap.code, 0, atCap.stderr);
  assert.equal(atCap.billed.length, 1);
  assert.equal(Buffer.byteLength(atCap.billed[0].body, "utf8"), bytes, "the same length of body");
  assert.equal(hardWorstCase(atCap.billed[0].body, fits), cap);
  assert.match(atCap.stderr, AT_MOST(centsUp(cap)));
  const over = await ask(["--max-tokens", String(fits + 1), question], { dirs, env: caps });   // 2 micro-dollars more
  assert.equal(over.code, 1, over.stderr);
  assert.equal(over.seen.length, 0, "refused before the count");
  assert.doesNotMatch(over.stderr, LINE_1_ANY_CAPS, "the caps come before line 1");
  assert.doesNotMatch(over.stderr, LINE_2_ANY);
  const needed = new RegExp(String.raw`\$${centsUp(cap + 2).replace(".", String.raw`\.`)}\b`);
  assert.match(ownWords(over.stderr), needed, "it names the cap this question needs");
});

test("--timeout covers both calls: a slow count leaves less time for the billed call", async () => {
  // Each call is held 2s. With 3s for both, the count is answered and the billed call is then cut off.
  const dirs = newDirs();
  const r = await ask(["--timeout", "3", BIG], { dirs, scene: { holdMs: 2_000 } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.count.length, 1);
  assert.equal(r.billed.length, 1, "the count fitted, so the billed call was sent");
  assert.match(r.stderr, /no answer within --timeout/);
  assert.match(r.stderr, /may have run/);
  assert.deepEqual(states(dirs), ["uncertain"]);
  await assertReservationKept(dirs);
});

test("the count has its own 30-second limit: a count answered later than that means the billed call is never sent", async () => {
  // The stand-in answers the count with a good number, 32s after it arrives: past the count's limit, well inside
  // the default --timeout of 300. The watchdog is raised to cover the wait.
  const dirs = newDirs();
  const r = await ask([QUESTION], { dirs, scene: { holdMs: 32_000 }, watchdogMs: 90_000 });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.count.length, 1, "the count is never retried");
  assert.equal(r.billed.length, 0, "the billed call is never sent");
  assert.ok(r.elapsedMs >= 29_000, `it waited for the count's limit, not less: ${r.elapsedMs}ms`);
  assert.match(r.stderr, LINE_1_ANY_CAPS);
  assert.doesNotMatch(r.stderr, LINE_2_ANY, "line 2 comes only after a good count");
  assert.doesNotMatch(r.stderr, /may have run/, "nothing billed was sent");
  assert.equal(await usedDollars(dirs), 0, "nothing reserved");
});

for (const [name, planned, env, args] of [
  ["a 401", { count: apiError(401) }],
  ["a 400", { count: apiError(400) }],
  ["a 429", { count: apiError(429) }],
  ["a 500", { count: apiError(500) }],
  ["an unreadable body", { count: garbage }],
  ["no input_tokens", { count: json(200, { object: "response.input_tokens" }) }],
  ["a negative count", { count: counted(-1) }],
  ["a fractional count", { count: counted(10.5) }],
  ["a count given as a string", { count: json(200, { input_tokens: "10" }) }],
  ["a redirect", { count: redirect }],
  ["a lost connection", { count: drop }],
  ["no answer in time", { count: hang }, {}, ["--timeout", "1"]],
]) {
  test(`a count that ends in ${name} means no billed call and no reservation`, async () => {
    const dirs = newDirs();
    const r = await ask([...(args ?? []), QUESTION], { dirs, scene: planned, env });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.count.length, 1, "the count is never retried");
    assert.equal(r.billed.length, 0, "nothing billed");
    assert.equal(r.stdout, "");
    assert.match(r.stderr, LINE_1_ANY_CAPS, "line 1 came before the count");
    assert.doesNotMatch(r.stderr, LINE_2_ANY, "line 2 comes only after a good count");
    assert.doesNotMatch(r.stderr, /may have run/, "nothing billed was sent");
    assert.doesNotMatch(r.stderr, /API-TEXT-MARKER|\/srv\/secret|\x1b/, "only Huntaway's own words");
    assert.equal(await usedDollars(dirs), 0, "nothing reserved");
  });
}

test("a count that can't connect means no billed call", async () => {
  const dirs = newDirs();
  const r = await ask([QUESTION], { dirs, env: { HUNTAWAY_TEST_OPENAI_URL: closedUrl } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.seen.length, 0);
  assert.match(r.stderr, LINE_1_ANY_CAPS);
  assert.doesNotMatch(r.stderr, LINE_2_ANY);
  assert.doesNotMatch(r.stderr, /may have run/);
  assert.equal(await usedDollars(dirs), 0, "nothing reserved");
});

// ---- The answer -----------------------------------------------------------------------------------------------------

// A `refusal` content part means the answer was refused, so it has its own tests below, not this one.
test("the answer is every output_text part, joined; other items are left out", async () => {
  const r = await ask([QUESTION], { scene: { billed: answered({ output: [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "REASONING-MARKER" }] },
    { ...message(["part one, ", "part two, "]) },
    { type: "message", id: "msg_2", role: "assistant", status: "completed", content: [
      { type: "output_text", text: "part three", annotations: [] },
    ] },
  ] }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "part one, part two, part three\n");
  assert.doesNotMatch(r.stderr, /REASONING-MARKER/);
  assert.doesNotMatch(r.stderr, /--max-tokens/, "a complete answer isn't marked as cut short");
});

test("incomplete_details.reason max_output_tokens: printed and marked as cut short", async () => {
  const r = await ask(["--max-tokens", "300", QUESTION], {
    scene: { billed: answered({ text: ["cut sho"], incomplete: "max_output_tokens" }) },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "cut sho\n");
  assert.match(r.stderr, /--max-tokens \(300\)/);
  assert.deepEqual(states(r.dirs), ["answered"]);
});

// incomplete_details.reason content_filter, or a refusal content part, means it ran and was filtered or refused.
// It settles from validated usage, with a fixed message. Whether filtered text is still shown isn't settled here; the
// exit code follows what was printed.
// The tests here and below that bill 30000 input tokens ask BIG, whose hard input is the 100000 limit, so 30000 sits
// well inside the reservation. A small question's hard input is a few hundred tokens: 30000 would be an overrun.
const FILTERED_WORDS = /filter|refus/i;

test("an answer incomplete for content_filter isn't blamed on --max-tokens: a fixed message, settled from usage", async () => {
  const dirs = newDirs();
  const r = await ask([BIG], {
    dirs,
    scene: { count: counted(30000), billed: answered({ text: ["some of it"], incomplete: "content_filter", usage: usageOf(30000, 40) }) },
  });
  assert.ok(r.stdout === "some of it\n" || r.stdout === "", `the text or nothing: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.code, r.stdout === "" ? 1 : 0, "printed exits 0; nothing printed exits 1");
  assert.doesNotMatch(r.stderr, /--max-tokens \(/);
  assert.match(r.stderr, LINE_2_ANY, "the engine really ran");
  assert.match(ownWords(r.stderr), FILTERED_WORDS, "a fixed message says it was filtered");
  assert.doesNotMatch(r.stderr, /Nothing ran|may have run/, "it certainly ran");
  await assertUsedBetween(dirs, 0.03, 0.04, "$0.03 of input and $0.00008 of output, at the standard price");
  await assertNoOverrun(dirs, r);
});

test("content_filter with no text: exit 1, a fixed message, settled from validated usage", async () => {
  const dirs = newDirs();
  const r = await ask([BIG], {
    dirs,
    scene: { count: counted(30000), billed: answered({ output: [], incomplete: "content_filter", usage: usageOf(30000, 0) }) },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.billed.length, 1, "never retried");
  assert.doesNotMatch(r.stderr, /--max-tokens \(/, "not blamed on --max-tokens");
  assert.match(ownWords(r.stderr), FILTERED_WORDS);
  assert.doesNotMatch(r.stderr, /Nothing ran|may have run/, "it certainly ran");
  await assertUsedBetween(dirs, 0.03, 0.04, "$0.03 of input, at the standard price");
  await assertNoOverrun(dirs, r);
});

test("a refusal content part: exit 1, a fixed message and never the model's words, settled from validated usage", async () => {
  const dirs = newDirs();
  const r = await ask([BIG], {
    dirs,
    scene: {
      count: counted(30000),
      billed: answered({
        output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [
          { type: "refusal", refusal: "REFUSAL-MARKER" },
        ] }],
        usage: usageOf(30000, 50),
      }),
    },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.billed.length, 1, "never retried");
  assert.ok(!(r.stdout + r.stderr).includes("REFUSAL-MARKER"), "the message is Huntaway's own, fixed");
  assert.match(ownWords(r.stderr), FILTERED_WORDS);
  assert.doesNotMatch(r.stderr, /--max-tokens \(/);
  assert.doesNotMatch(r.stderr, /Nothing ran|may have run/, "it certainly ran");
  await assertUsedBetween(dirs, 0.03, 0.04, "$0.03 of input and $0.0001 of output, at the standard price");
  await assertNoOverrun(dirs, r);
});

test("completed with no text, validated usage: it ran, a fixed no-text message, exit 1, settled from usage", async () => {
  const dirs = newDirs();
  const r = await ask([BIG], {
    dirs,
    scene: { count: counted(30000), billed: answered({ text: [], usage: usageOf(30000, 40) }) },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.billed.length, 1, "never retried");
  assert.match(r.stderr, LINE_2_ANY, "the engine really ran");
  const said = ownWords(r.stderr).split("\n")
    .filter((line) => line.trim() !== "" && !LINE_1_ANY_CAPS.test(line) && !LINE_2_ANY.test(line));
  assert.ok(said.length > 0, "a message says there was no text");
  assert.doesNotMatch(r.stderr, /Nothing ran|may have run/, "it certainly ran");
  await assertUsedBetween(dirs, 0.03, 0.04, "$0.03 of input and $0.00008 of output, at the standard price");
  await assertNoOverrun(dirs, r);
});

test("no text, cut short, validated usage: the --max-tokens message, settled from usage, no overrun", async () => {
  const dirs = newDirs();
  const r = await ask(["--max-tokens", "300", BIG], {
    dirs,
    scene: { count: counted(30000), billed: cutBeforeText(usageOf(30000, 300)) },
  });
  assert.equal(r.code, 1, "nothing was answered");
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /The answer used all of --max-tokens \(300\) before any text; ask again with a higher --max-tokens\./);
  assert.doesNotMatch(r.stderr, /Nothing ran/, "it ran, and it was billed");
  assert.equal(r.billed.length, 1, "never retried");
  await assertUsedBetween(dirs, 0.03, 0.04, "$0.03 of input and $0.0006 of output");
  await assertNoOverrun(dirs, r);
});

test("no text, cut short, no usage: the reservation stays", async () => {
  const dirs = newDirs();
  const r = await ask([BIG], { dirs, scene: { billed: cutBeforeText(OMIT) } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.billed.length, 1);
  await assertReservationKept(dirs);
});

// ---- Usage and the tier ---------------------------------------------------------------------------------------------

test("validated usage settles at its cost: the two token counts and the default tier are all it needs", async () => {
  const dirs = newDirs();
  const r = await ask([BIG], {
    dirs,
    scene: { count: counted(30000), billed: answered({ usage: { input_tokens: 30000, output_tokens: 1000 } }) },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${ANSWER}\n`);
  await assertUsedBetween(dirs, 0.03, 0.04, "$0.03 of input and $0.002 of output, at the standard price");
  await assertNoOverrun(dirs, r);
});

for (const [name, usage] of [
  ["no usage", OMIT],
  ["null usage", null],
  ["no input_tokens", { output_tokens: 20, total_tokens: 20 }],
  ["no output_tokens", { input_tokens: 10, total_tokens: 10 }],
  ["negative input_tokens", { input_tokens: -1, output_tokens: 20, total_tokens: 19 }],
  ["negative output_tokens", { input_tokens: 10, output_tokens: -1, total_tokens: 9 }],
  ["fractional tokens", { input_tokens: 10.5, output_tokens: 20, total_tokens: 30.5 }],
  ["tokens given as strings", { input_tokens: "10", output_tokens: "20", total_tokens: "30" }],
  ["inconsistent usage (total_tokens isn't the sum)", { input_tokens: 10, output_tokens: 20, total_tokens: 999 }],
  ["inconsistent usage (cached_tokens above input_tokens)",
    { ...usageOf(10, 20), input_tokens_details: { cached_tokens: 11 } }],
  ["inconsistent usage (reasoning_tokens above output_tokens)",
    { ...usageOf(10, 20), output_tokens_details: { reasoning_tokens: 21 } }],
]) {
  test(`${name}: the answer is printed, the full reservation stays, and it is no overrun`, async () => {
    const dirs = newDirs();
    const r = await ask([BIG], { dirs, scene: { billed: answered({ usage }) } });
    assert.equal(r.stdout, `${ANSWER}\n`, "a complete answer is never thrown away");
    assert.equal(r.code, 0, `a printed answer exits 0, whatever its settling found: ${r.stderr}`);
    assert.equal(r.billed.length, 1);
    await assertReservationKept(dirs);
    const roomy = await ask([QUESTION], { dirs });
    assert.equal(roomy.code, 0, `bad usage alone doesn't stop the model: ${roomy.stderr}`);
    assert.equal(roomy.billed.length, 1);
  });
}

for (const [name, tier] of [
  ["a missing tier", OMIT],
  ["a null tier", null],
  ["the priority tier", "priority"],
  ["the flex tier", "flex"],
  ["the scale tier", "scale"],
  ["the auto tier", "auto"],
]) {
  test(`${name} is settled at the priority price and is an overrun`, async () => {
    const dirs = newDirs();
    const r = await ask([QUESTION], {
      dirs,
      scene: { count: counted(30000), billed: answered({ tier, usage: usageOf(30000, 1000) }) },
    });
    assert.equal(r.stdout, `${ANSWER}\n`, "a complete answer is never thrown away");
    assert.equal(r.code, 0, `a printed answer exits 0; the warning goes to stderr: ${r.stderr}`);
    await assertUsedBetween(dirs, 0.06, 0.07, "$0.06 of input and $0.004 of output, at the priority price");
    await assertOverrun(dirs, r);
  });
}

test("a non-standard tier is settled at the priority price even above the standard-priced reservation", async () => {
  // Reserved at the standard price: 100000 + 1024 x 2 = 102,048 ("At most $0.11"). Billed at priority: 100000 x $2/M +
  // 1024 x $4/M = 204,096, above it. The provider didn't honour the pinned tier: that one call can pass a cap.
  const dirs = newDirs();
  const r = await ask([BIG], {
    dirs,
    scene: { count: counted(100000), billed: answered({ tier: "priority", usage: usageOf(100000, 1024) }) },
  });
  assert.equal(r.stdout, `${ANSWER}\n`, "a complete answer is never thrown away");
  assert.equal(r.code, 0, `a printed answer exits 0; the warning goes to stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.billed[0].body).service_tier, "default", "the standard tier was pinned");
  assert.match(r.stderr, AT_MOST("0.11"), "the hard worst case is at the standard price");
  await assertUsedBetween(dirs, 0.20, 0.21, "the priority cost, not the reservation");
  await assertOverrun(dirs, r);
});

test("input tokens at the estimate are fine; one above it is an overrun, inside the reservation's dollars", async () => {
  // Counted 10, so the estimate is 10 x 1.10 + 64 = 75. 76 tokens cost far less than the reservation, whose hard input
  // (2 x the body's bytes + 64) is a few hundred tokens.
  const fine = newDirs();
  const atEstimate = await ask([QUESTION], { dirs: fine, scene: { billed: answered({ usage: usageOf(75, 20) }) } });
  assert.equal(atEstimate.code, 0, atEstimate.stderr);
  await assertNoOverrun(fine, atEstimate);
  const over = newDirs();
  const above = await ask([QUESTION], { dirs: over, scene: { billed: answered({ usage: usageOf(76, 20) }) } });
  assert.equal(above.stdout, `${ANSWER}\n`);
  assert.equal(above.code, 0, `a printed answer exits 0: ${above.stderr}`);
  await assertOverrun(over, above);
});

/** The ledger's one column for each row's safety revision (each row holds the model's safety revision). */
function revisionColumn(db) {
  const found = [];
  for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const { name: column } of db.prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`).all()) {
      if (/revision/i.test(column)) found.push({ table, column });
    }
  }
  assert.equal(found.length, 1, `one column holds each row's safety revision: ${JSON.stringify(found)}`);
  return found[0];
}

test("an overrun block follows the model's safety revision: a row at a later revision than the model's still blocks", async () => {
  // Refused while the model's current safety revision is at or below the row's, so installing an older release
  // never lifts it. A row written at a later revision stands in for exactly that.
  const dirs = newDirs();
  const r = await ask([QUESTION], { dirs, scene: { billed: answered({ usage: usageOf(76, 20) }) } });
  assert.equal(r.code, 0, r.stderr);
  const db = new DatabaseSync(join(dirs.data, "spend.sqlite"));
  try {
    const { table, column } = revisionColumn(db);
    const quoted = `"${column.replaceAll('"', '""')}"`;
    const rows = db.prepare(`SELECT ${quoted} AS revision FROM "${table.replaceAll('"', '""')}"`).all();
    assert.equal(rows.length, 1, "one question, one row");
    assert.ok(Number.isInteger(Number(rows[0].revision)) && Number(rows[0].revision) >= 0, "a whole-number revision");
    db.prepare(`UPDATE "${table.replaceAll('"', '""')}" SET ${quoted} = ${quoted} + 1`).run();
  } finally { db.close(); }
  await assertOverrun(dirs, r);
});

test("output tokens at the bound are fine; one above it is an overrun", async () => {
  const fine = newDirs();
  const atBound = await ask(["--max-tokens", "100", QUESTION], { dirs: fine, scene: { billed: answered({ usage: usageOf(10, 100) }) } });
  assert.equal(atBound.code, 0, atBound.stderr);
  await assertNoOverrun(fine, atBound);
  const over = newDirs();
  const above = await ask(["--max-tokens", "100", QUESTION], { dirs: over, scene: { billed: answered({ usage: usageOf(10, 101) }) } });
  assert.equal(above.stdout, `${ANSWER}\n`);
  assert.equal(above.code, 0, `a printed answer exits 0: ${above.stderr}`);
  await assertOverrun(over, above);
});

test("a cost above the reservation is settled at that cost and is an overrun", async () => {
  // 300000 x $1/M + 20 x $2/M = 300,040 micro-dollars, above the 102,048 reserved for BIG.
  const dirs = newDirs();
  const r = await ask([BIG], { dirs, scene: { billed: answered({ usage: usageOf(300000, 20) }) } });
  assert.equal(r.stdout, `${ANSWER}\n`);
  assert.equal(r.code, 0, `a printed answer exits 0: ${r.stderr}`);
  await assertUsedBetween(dirs, 0.30, 0.31, "the real cost, not the reservation");
  await assertOverrun(dirs, r);
});

test("a count above the byte bound isn't checked before the call; billed input above the hard input is an overrun", async () => {
  // A small question counted at 50000: the estimate (55,064 tokens) covers the 50000 billed, but the hard input is
  // 2 x the body's bytes + 64, a few hundred tokens. There is no check of the count against the byte bound before the
  // call: it is sent, reserved at its own small hard worst case, and caught at settling, where 50000 + 20 x 2 =
  // 50,040 micro-dollars is above the reservation.
  const dirs = newDirs();
  const r = await ask([QUESTION], { dirs, scene: { count: counted(50000), billed: answered({ usage: usageOf(50000, 20) }) } });
  assert.equal(r.billed.length, 1, "the billed call was sent");
  assert.equal(r.stdout, `${ANSWER}\n`);
  assert.equal(r.code, 0, `a printed answer exits 0: ${r.stderr}`);
  const reserved = hardWorstCase(r.billed[0].body, 1024);
  assert.ok(reserved < 50040, `the reservation, ${reserved}, is below the cost`);
  assert.match(r.stderr, AT_MOST(centsUp(reserved)), "the count doesn't raise the hard worst case");
  await assertUsedBetween(dirs, 0.05, 0.06, "the real cost, not the reservation");
  await assertOverrun(dirs, r);
});

// ---- Statuses and network outcomes ----------------------------------------------------------------------------------

for (const status of [400, 401, 403, 404, 429]) {
  test(`a ${status} is refused, can be sent again, and settles at 0`, async () => {
    const dirs = newDirs();
    const r = await ask([BIG], { dirs, scene: { billed: apiError(status) } });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.billed.length, 1, "never retried");
    assert.match(r.stderr, /Nothing ran; you can send it again/);
    assert.doesNotMatch(r.stderr, /may have run/);
    assert.doesNotMatch(r.stderr, /API-TEXT-MARKER|\/srv\/secret|\x1b/, "only Huntaway's own words");
    assert.deepEqual(states(dirs), ["failed"]);
    await assertSettledAtZero(dirs);
  });
}

test("a 429 is refused whatever became of its body", async () => {
  const dirs = newDirs();
  const r = await ask([BIG], { dirs, scene: { billed: raw(429, "not json") } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Nothing ran; you can send it again/);
  assert.deepEqual(states(dirs), ["failed"]);
  await assertSettledAtZero(dirs);
});

for (const [name, planned, args, words] of [
  ["a 500", { billed: apiError(500) }, [], /may have run/],
  ["an unreadable answer", { billed: garbage }, [], /could not be read/],
  ["a lost connection", { billed: drop }, [], /connection to the API was lost/],
  ["no answer in time", { billed: hang }, ["--timeout", "1"], /no answer within --timeout/],
  ["a redirect", { billed: redirect }, [], /redirect/],
]) {
  test(`${name} is uncertain, never retried, and keeps the reservation`, async () => {
    const dirs = newDirs();
    const r = await ask([...args, BIG], { dirs, scene: planned });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.billed.length, 1, "one billed call: a redirect is never followed");
    assert.match(r.stderr, words);
    assert.match(r.stderr, /may have run/);
    assert.doesNotMatch(r.stderr, /Nothing ran/);
    assert.doesNotMatch(r.stderr, /API-TEXT-MARKER|\/srv\/secret|\x1b/, "only Huntaway's own words");
    assert.deepEqual(states(dirs), ["uncertain"]);
    await assertReservationKept(dirs);
  });
}

// ---- Options and caps -----------------------------------------------------------------------------------------------

test("--effort, --family and a --timeout above 300 are usage errors for openai; the limits themselves are fine", async () => {
  const limits = await ask(["--max-tokens", "8192", "--timeout", "300", QUESTION]);
  assert.equal(limits.code, 0, limits.stderr);
  assert.equal(JSON.parse(limits.billed[0].body).max_output_tokens, 8192);
  for (const args of [["--effort", "low"], ["--effort", "high"], ["--family", "claude"], ["--family", "codex"],
    ["--timeout", "301"], ["--max-tokens", "0"], ["--max-tokens", "8193"]]) {
    const byFlag = await ask([...args, QUESTION]);
    assert.equal(byFlag.code, 2, args.join(" "));
    assert.equal(byFlag.seen.length, 0, args.join(" "));
    assert.deepEqual(readdirSync(byFlag.dirs.data), [], "nothing recorded");
    const byEnv = await cli(["ask", "--model", MODEL, ...args, QUESTION], { env: { HUNTAWAY_ENGINE: "openai", OPENAI_API_KEY: KEY } });
    assert.equal(byEnv.code, 2, `HUNTAWAY_ENGINE=openai ${args.join(" ")}`);
    assert.equal(byEnv.seen.length, 0, args.join(" "));
  }
});

test("the usage line and the HUNTAWAY_ENGINE errors list openai", async () => {
  const usage = await cli(["ask"]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--engine [^\]\s]*\bopenai\b/);
  const bad = await cli(["ask", "hi"], { env: { HUNTAWAY_ENGINE: "nonsense" } });
  assert.equal(bad.code, 2);
  assert.equal(bad.seen.length, 0, "nothing sent");
  assert.match(bad.stderr, /HUNTAWAY_ENGINE must be [^\n]*\bopenai\b/);
  const d = await doctor(newDirs(), { HUNTAWAY_ENGINE: "nonsense" });
  assert.notEqual(d.code, 0);
  assert.match(d.stdout, /^FAIL\s+engine: HUNTAWAY_ENGINE must be [^\n]*\bopenai\b/m);
  // The error lists every engine, in both places.
  const askLine = bad.stderr.split("\n").find((l) => /HUNTAWAY_ENGINE must be /.test(l));
  const doctorLine = d.stdout.split("\n").find((l) => /^FAIL\s+engine: HUNTAWAY_ENGINE must be /.test(l));
  for (const engine of ["pipe", "anthropic", "openai"]) {
    assert.match(askLine, new RegExp(`\\b${engine}\\b`), `ask's error names ${engine}`);
    assert.match(doctorLine, new RegExp(`\\b${engine}\\b`), `doctor's FAIL line names ${engine}`);
  }
  assert.ok(!bad.stderr.includes("nonsense") && !d.stdout.includes("nonsense"), "the value is never echoed");
});

for (const [name, caps] of [
  ["neither cap", CAPS(undefined, undefined)],
  ["no per-question cap", CAPS(undefined, "5.00")],
  ["no per-day cap", CAPS("0.50", undefined)],
  ["empty caps", CAPS("", "")],
  ["a cap that isn't a number", CAPS("lots", "5.00")],
  ["three decimal places", CAPS("0.505", "5.00")],
  ["a cap below $0.01", CAPS("0.00", "5.00")],
  ["a cap above $1000", CAPS("0.50", "1000.01")],
  ["a per-day cap below the per-question cap", CAPS("0.50", "0.25")],
]) {
  test(`${name}: refused before anything is sent, naming both settings with an example`, async () => {
    const r = await ask([QUESTION], { env: caps });
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.seen.length, 0, "not even the count");
    const words = ownWords(r.stderr);
    assert.match(words, /HUNTAWAY_MAX_USD_PER_QUESTION/);
    assert.match(words, /HUNTAWAY_MAX_USD_PER_DAY/);
    assert.match(words, /\d/, "an example");
    assert.doesNotMatch(words, LINE_1_ANY_CAPS, "the caps are checked before line 1");
    assert.doesNotMatch(words, LINE_2_ANY);
  });
}

test("the widest valid caps: $1000 runs; $0.01 admits a small question, not BIG, and names the cap BIG needs", async () => {
  const widest = await ask([QUESTION], { env: CAPS("1000", "1000") });
  assert.equal(widest.code, 0, widest.stderr);
  assert.equal(widest.billed.length, 1);
  const small = await ask([QUESTION], { env: CAPS("0.01", "1000") });     // a few thousand micro-dollars
  assert.equal(small.code, 0, small.stderr);
  assert.equal(small.billed.length, 1);
  assert.match(small.stderr, AT_MOST("0.01"));
  const big = await ask([BIG], { env: CAPS("0.01", "1000") });            // 102,048
  assert.equal(big.code, 1, big.stderr);
  assert.equal(big.seen.length, 0, "not even the count");
  assert.match(ownWords(big.stderr), /\$0\.11\b/, "it names the cap this question needs");
});

// Both caps apply to this question's hard worst case, at the standard price, checked first.
test("a per-question cap below this question's hard worst case ($0.10 for BIG) is refused first: before the key, line 1 and the count", async () => {
  // BIG reaches the limit: 100000 + 1024 x 2 = 102,048, so the cap it needs is $0.11 (at the priority price, $0.21).
  for (const [what, key] of [["no key in the environment, and a keychain that can't be read", undefined],
    ["a key in the environment that can't be used", "two words"]]) {
    const dirs = newDirs();
    writeFileSync(dirs.keychain, "{not json");
    const r = await ask([BIG], { dirs, env: { ...CAPS("0.10", "5.00"), OPENAI_API_KEY: key } });
    assert.equal(r.code, 1, `${what}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.equal(r.seen.length, 0, `${what}: no count reached the stand-in`);
    const words = ownWords(r.stderr);
    assert.match(words, /\$0\.11\b/, `${what}: it names the cap this question needs`);
    assert.doesNotMatch(words, /keychain|OPENAI_API_KEY/i, `${what}: the key was never read`);
    assert.doesNotMatch(words, LINE_1_ANY_CAPS, `${what}: the caps come before line 1`);
    assert.doesNotMatch(words, LINE_2_ANY);
  }
});

test("$0.20 a question admits a small question and BIG: there is no fixed minimum cap", async () => {
  const caps = CAPS("0.20", "5.00");
  for (const [what, question, dollars] of [["a small question", QUESTION, "0.01"], ["BIG", BIG, "0.11"]]) {
    const r = await ask([question], { env: caps });
    assert.equal(r.code, 0, `${what}: ${r.stderr}`);
    assert.equal(r.billed.length, 1, what);
    assert.match(r.stderr, AT_MOST(dollars), what);
  }
});

test("$0.11 a question fits BIG's hard worst case to the micro-dollar; one token more of --max-tokens doesn't", async () => {
  const caps = CAPS("0.11", "5.00");
  const atDefault = await ask([BIG], { env: caps });           // 100,000 + 2,048 = 102,048
  assert.equal(atDefault.code, 0, atDefault.stderr);
  assert.equal(atDefault.billed.length, 1);
  assert.match(atDefault.stderr, AT_MOST("0.11"));
  const atCap = await ask(["--max-tokens", "5000", BIG], { env: caps });   // 100,000 + 10,000 = 110,000
  assert.equal(atCap.code, 0, atCap.stderr);
  assert.equal(atCap.billed.length, 1);
  assert.match(atCap.stderr, AT_MOST("0.11"));
  const over = await ask(["--max-tokens", "5001", BIG], { env: caps });    // 110,002
  assert.equal(over.code, 1, over.stderr);
  assert.equal(over.seen.length, 0, "refused before the count");
  assert.doesNotMatch(over.stderr, LINE_1_ANY_CAPS, "the caps come before line 1");
  assert.doesNotMatch(over.stderr, LINE_2_ANY);
  assert.match(ownWords(over.stderr), /\$0\.12\b/, "it names the cap this question needs");
});

test("no day headroom for this question's hard worst case is refused before the count, whatever the count would say", async () => {
  const dirs = newDirs();
  const first = await ask([BIG], { dirs, env: TIGHT, scene: { billed: apiError(500) } });   // keeps 102,048 of $0.20
  assert.equal(first.code, 1, first.stderr);
  const next = await ask([BIG], { dirs, env: TIGHT, scene: { count: counted(1) } });       // needs 102,048 more
  assert.equal(next.code, 1, next.stderr);
  assert.equal(next.seen.length, 0, "no count request reached the stand-in");
  assert.match(next.stderr, LINE_1_ANY_CAPS, "line 1 and the key come before the ledger look");
  assert.doesNotMatch(next.stderr, LINE_2_ANY);
  assert.match(ownWords(next.stderr), NO_MORE_ROOM);
  // The headroom left, 97,952, is checked against each request's own hard worst case: a small question fits it.
  const small = await ask([QUESTION], { dirs, env: TIGHT });
  assert.equal(small.code, 0, small.stderr);
  assert.equal(small.billed.length, 1);
  assert.match(small.stderr, /^At most \$0\.01 for this question \([^)]*\); \$0\.1[01] of your \$0\.20 used in the last 24 hours\.$/m);
});

// ---- Doctor ---------------------------------------------------------------------------------------------------------

const DOCTOR_CAPS = String.raw`caps \$100\.00 a question, \$100\.00 a day; \$0\.00 used in the last 24 hours\)$`;

test("doctor, with no key: a FAIL for openai", async () => {
  const r = await doctor(newDirs(), { OPENAI_API_KEY: undefined });
  assert.match(r.stdout, /^FAIL\s+engine: openai\b.*key/im);
  assert.equal(r.code, 1);
  assert.equal(r.seen.length, 0, "doctor sends nothing");
});

test("doctor, with a key in the environment: says where it is, never any of it", async () => {
  const canary = newCanary();
  const dirs = newDirs();
  const r = await doctor(dirs, { OPENAI_API_KEY: canary });
  assert.match(r.stdout, new RegExp(String.raw`^ok\s+engine: openai \(paid API; [^;]*set in the environment; ${DOCTOR_CAPS}`, "m"));
  assert.equal(r.seen.length, 0, "doctor sends nothing");
  assertNoPartPrinted(canary.slice("hwtest-canary-".length), r.stdout + r.stderr);
  assertNoCanary(canary, dirs, [r]);
});

test("doctor, with a key in the fake keychain: says where it is, never any of it", async () => {
  const canary = newCanary();
  const dirs = newDirs();
  const stored = await storeKey(dirs, canary);
  assert.equal(stored.code, 0, stored.stderr);
  const r = await doctor(dirs, { OPENAI_API_KEY: undefined });
  assert.match(r.stdout, new RegExp(String.raw`^ok\s+engine: openai \(paid API; key in the keychain; ${DOCTOR_CAPS}`, "m"));
  assert.equal(r.seen.length, 0, "doctor sends nothing");
  assertNoPartPrinted(canary.slice("hwtest-canary-".length), r.stdout + r.stderr);
  assertNoCanary(canary, dirs, [stored, r]);
});

test("doctor: an empty variable counts as unset, so the keychain's key is the one", async () => {
  const dirs = newDirs();
  const stored = await storeKey(dirs, newCanary());
  assert.equal(stored.code, 0, stored.stderr);
  const r = await doctor(dirs, { OPENAI_API_KEY: "" });
  assert.match(r.stdout, /^ok\s+engine: openai \(paid API; key in the keychain;/m);
});

test("doctor: an unusable variable is a FAIL, with no fallback to the keychain", async () => {
  const dirs = newDirs();
  const stored = await storeKey(dirs, newCanary());
  assert.equal(stored.code, 0, stored.stderr);
  const r = await doctor(dirs, { OPENAI_API_KEY: "two words" });
  assert.match(r.stdout, /^FAIL\s+engine: openai\b/m);
  assert.doesNotMatch(r.stdout, /two words/);
  assert.equal(r.code, 1);
});

test("doctor: a key that isn't an hwtest- key is a FAIL while the test switch is on", async () => {
  const key = realFormatKey();
  const r = await doctor(newDirs(), { OPENAI_API_KEY: key });
  assert.match(r.stdout, /^FAIL\s+engine: openai\b/m);
  assert.equal(r.code, 1);
  assert.equal(r.seen.length, 0);
  assertNoPartPrinted(key.slice("sk-proj-".length), r.stdout + r.stderr);
});

test("doctor: a missing cap is a FAIL for openai", async () => {
  for (const caps of [CAPS(undefined, undefined), CAPS("0.50", undefined), CAPS(undefined, "5.00")]) {
    const r = await doctor(newDirs(), caps);
    assert.match(r.stdout, /^FAIL\b.*(?:openai|HUNTAWAY_MAX_USD)/im);
    assert.equal(r.code, 1);
    assert.equal(r.seen.length, 0);
  }
});

// ---- The key --------------------------------------------------------------------------------------------------------

test("no key anywhere: fixed words, and nothing is sent", async () => {
  const r = await ask([QUESTION], { env: { OPENAI_API_KEY: undefined } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.seen.length, 0);
  assert.match(ownWords(r.stderr), /OPENAI_API_KEY|huntaway key set/);
  assert.match(r.stderr, LINE_1_ANY_CAPS, "the caps passed, so line 1 comes before the key");
  assert.doesNotMatch(r.stderr, LINE_2_ANY);
});

test("a variable no header could carry is refused, in fixed words, and nothing is sent", async () => {
  const canary = newCanary();
  for (const bad of [`${canary}\n`, `${canary} `, "two words"]) {
    const r = await ask([QUESTION], { env: { OPENAI_API_KEY: bad } });
    assert.equal(r.code, 1, JSON.stringify(bad.slice(0, 7)));
    assert.equal(r.seen.length, 0);
    assert.match(ownWords(r.stderr), /OPENAI_API_KEY/);
    assert.ok(!r.stderr.includes(canary) && !r.stderr.includes("two words"), "the value is never repeated");
  }
});

test("an empty variable counts as unset; a set but unusable one never falls back to the keychain", async () => {
  const canary = newCanary();
  const dirs = newDirs();
  const stored = await storeKey(dirs, canary);
  assert.equal(stored.code, 0, stored.stderr);
  const empty = await ask([QUESTION], { dirs, env: { OPENAI_API_KEY: "" } });
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(empty.billed[0].headers.authorization, `Bearer ${canary}`);
  const unusable = await ask([QUESTION], { dirs, env: { OPENAI_API_KEY: "two words" } });
  assert.equal(unusable.code, 1, unusable.stderr);
  assert.equal(unusable.seen.length, 0, "no fallback");
});

test("key set, then use, replace and remove: only the fake keychain ever holds it", async () => {
  const first = newCanary();
  const second = newCanary();
  const dirs = newDirs();
  const env = { OPENAI_API_KEY: undefined };
  const stored = await storeKey(dirs, first);
  assert.equal(stored.code, 0, stored.stderr);
  JSON.parse(readFileSync(dirs.keychain, "utf8"));        // a JSON file; what is inside it is the layer's own
  assert.ok(readFileSync(dirs.keychain, "utf8").includes(first), "the fake keychain holds it");
  const used = await ask([QUESTION], { dirs, env });
  assert.equal(used.code, 0, used.stderr);
  assert.deepEqual(used.seen.map((c) => c.headers.authorization), [`Bearer ${first}`, `Bearer ${first}`]);
  assertNoCanary(first, dirs, [stored, used]);

  const replaced = await storeKey(dirs, second);
  assert.equal(replaced.code, 0, replaced.stderr);
  const usedAgain = await ask([QUESTION], { dirs, env });
  assert.equal(usedAgain.billed[0].headers.authorization, `Bearer ${second}`);
  assert.ok(!readFileSync(dirs.keychain, "utf8").includes(first), "the older key is gone");

  const removed = await cli(["key", "remove", "openai"], { dirs });
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok(!existsSync(dirs.keychain) || !readFileSync(dirs.keychain, "utf8").includes(second), "the key is gone");
  assertNoCanary(second, dirs, [replaced, usedAgain, removed]);
  const d = await doctor(dirs, env);
  assert.match(d.stdout, /^FAIL\s+engine: openai\b/m);
  const gone = await ask([QUESTION], { dirs, env });
  assert.equal(gone.code, 1, gone.stderr);
  assert.equal(gone.seen.length, 0);
});

test("key set accepts the shortest, the longest and every allowed character, exactly", async () => {
  for (const key of [`hwtest-${"a".repeat(13)}`, `hwtest-${"b".repeat(505)}`, "hwtest-ABCXYZabcxyz0189._-"]) {
    const dirs = newDirs();
    const stored = await storeKey(dirs, key);
    assert.equal(stored.code, 0, `${key.length} characters: ${stored.stderr}`);
    const used = await ask([QUESTION], { dirs, env: { OPENAI_API_KEY: undefined } });
    assert.equal(used.code, 0, used.stderr);
    assert.equal(used.billed[0].headers.authorization, `Bearer ${key}`);
  }
});

test("key set refuses a bad key or a bad engine; a working older key stays and nothing is echoed", async () => {
  const good = newCanary();
  const dirs = newDirs();
  const stored = await storeKey(dirs, good);
  assert.equal(stored.code, 0, stored.stderr);
  for (const bad of [`hwtest-${"a".repeat(12)}`, `hwtest-${"a".repeat(506)}`, "hwtest-has spaces-in-it-0000", 'hwtest-has"quote-in-it-00000',
    "hwtest-has$dollar-in-it-0000", realFormatKey(), ""]) {
    const r = await storeKey(dirs, bad);
    assert.notEqual(r.code, 0, bad.slice(0, 7));
    if (bad !== "") assert.ok(!(r.stdout + r.stderr).includes(bad), "the refused value is never repeated");
    assert.ok(readFileSync(dirs.keychain, "utf8").includes(good), "the older key stays");
    if (bad !== "") assert.ok(!readFileSync(dirs.keychain, "utf8").includes(bad), "the refused value was not stored");
  }
  for (const args of [["key", "set", "nonsense"], ["key", "set", "pipe"], ["key", "remove", "nonsense"], ["key", "set"], ["key"]]) {
    const r = await cli(args, { dirs, input: `${newCanary()}\n` });
    assert.notEqual(r.code, 0, args.join(" "));
  }
  const still = await ask([QUESTION], { dirs, env: { OPENAI_API_KEY: undefined } });
  assert.equal(still.billed[0].headers.authorization, `Bearer ${good}`);
});

test("a fake keychain that can't be read is a refusal in fixed words", async () => {
  const canary = newCanary();
  const dirs = newDirs();
  writeFileSync(dirs.keychain, `{not json ${canary}`);
  const r = await ask([QUESTION], { dirs, env: { OPENAI_API_KEY: undefined } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.seen.length, 0);
  assert.match(ownWords(r.stderr), /keychain/i);
  assert.ok(!r.stderr.includes(canary), "its contents are never repeated");
});

// ---- The test switch ------------------------------------------------------------------------------------------------

test("switch on with no stand-in address: a real-format key is refused, and nothing is sent", async () => {
  const key = realFormatKey();
  const r = await ask([QUESTION], { env: { OPENAI_API_KEY: key, HUNTAWAY_TEST_OPENAI_URL: undefined } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.seen.length, 0);
  assert.doesNotMatch(r.stderr, LINE_2_ANY);
  assertNoPartPrinted(key.slice("sk-proj-".length), r.stdout + r.stderr);
});

test("switch on with a stand-in address: a real-format key is still refused, and the stand-in sees nothing", async () => {
  const key = realFormatKey();
  const r = await ask([QUESTION], { env: { OPENAI_API_KEY: key } });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.seen.length, 0);
  assertNoPartPrinted(key.slice("sk-proj-".length), r.stdout + r.stderr);
});

test("switch on: a missing or invalid stand-in address is a refusal, even with an hwtest- key", async () => {
  for (const address of [undefined, "", "not a url", "http://example.com:80/v1/responses", "http://127.0.0.1.example.com:1/v1/responses"]) {
    const r = await ask([QUESTION], { env: { HUNTAWAY_TEST_OPENAI_URL: address } });
    assert.equal(r.code, 1, `${address}: ${r.stderr}`);
    assert.equal(r.seen.length, 0, String(address));
    assert.doesNotMatch(r.stderr, LINE_2_ANY, String(address));
  }
});

test("switch off: an hwtest- key is refused, hwtest-model doesn't exist, and the stand-in address means nothing", async () => {
  const off = { HUNTAWAY_ENABLE_FAKE_ENGINE: undefined };
  const testKey = await cli(["ask", "--engine", "openai", QUESTION], { env: { ...off, OPENAI_API_KEY: KEY } });
  assert.equal(testKey.code, 1, testKey.stderr);
  assert.equal(testKey.seen.length, 0);
  const testModel = await cli(["ask", "--engine", "openai", "--model", MODEL, QUESTION], { env: { ...off, OPENAI_API_KEY: realFormatKey() } });
  assert.notEqual(testModel.code, 0, testModel.stderr);
  assert.equal(testModel.seen.length, 0);
});

// ---- The Pipe -------------------------------------------------------------------------------------------------------

test("OPENAI_API_KEY never reaches the Pipe, even with openai as the chosen engine and --engine pipe for one question", async () => {
  const canary = newCanary();
  const dirs = newDirs();
  const log = join(dirs.root, "pipe.log");
  const r = await cli(["ask", "--engine", "pipe", QUESTION], {
    dirs,
    env: {
      HUNTAWAY_ENGINE: "openai",
      OPENAI_API_KEY: canary,
      HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]),
      FAKE_PIPE_LOG: log,
    },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "pong from the pipe\n");
  const piped = readFileSync(log, "utf8");
  assert.ok(piped.includes("pipe_submit"), "the pipe really ran");
  assert.ok(!piped.includes("saw-api-key"), "the pipe's environment had no API key");
  assert.equal(r.seen.length, 0, "OpenAI was never called");
  assert.doesNotMatch(r.stderr, /paid OpenAI API key/, "no paid notice for the pipe");
  assertNoCanary(canary, dirs, [r]);
});

// ---- The canary tests: every outcome, once with the key from the environment and once from the fake keychain ----

const LEDGER_WORDS = /ledger|spend/i;
const outcomes = [
  { name: "success", code: 0, count: 1, billed: 1, stdout: `${ANSWER}\n` },
  { name: "success cut short", scene: { billed: answered({ text: ["cut sho"], incomplete: "max_output_tokens" }) },
    code: 0, count: 1, billed: 1, stdout: "cut sho\n", words: /--max-tokens \(1024\)/ },
  { name: "cut short with no text", scene: { billed: cutBeforeText(usageOf(10, 1024)) },
    code: 1, count: 1, billed: 1, words: /used all of --max-tokens \(1024\)/ },
  ...[400, 401, 403, 404, 429].map((status) => ({ name: `a refused ${status}`, scene: { billed: apiError(status) },
    code: 1, count: 1, billed: 1, words: /Nothing ran/ })),
  { name: "a 500", scene: { billed: apiError(500) }, code: 1, count: 1, billed: 1, words: /may have run/ },
  { name: "an unreadable body", scene: { billed: garbage }, code: 1, count: 1, billed: 1, words: /may have run/ },
  // A printed answer exits 0, whatever its settling found.
  { name: "missing usage", scene: { billed: answered({ usage: OMIT }) }, code: 0, count: 1, billed: 1, stdout: `${ANSWER}\n` },
  { name: "unreadable usage", scene: { billed: answered({ usage: { input_tokens: -1, output_tokens: "x" } }) },
    code: 0, count: 1, billed: 1, stdout: `${ANSWER}\n` },
  { name: "inconsistent usage", scene: { billed: answered({ usage: { input_tokens: 10, output_tokens: 20, total_tokens: 999 } }) },
    code: 0, count: 1, billed: 1, stdout: `${ANSWER}\n` },
  { name: "a non-standard tier", scene: { billed: answered({ tier: "priority" }) },
    code: 0, count: 1, billed: 1, stdout: `${ANSWER}\n`, words: OVERRUN_WARNING },
  { name: "a missing tier", scene: { billed: answered({ tier: OMIT }) },
    code: 0, count: 1, billed: 1, stdout: `${ANSWER}\n`, words: OVERRUN_WARNING },
  { name: "filtered (content_filter, no text)", scene: { billed: answered({ output: [], incomplete: "content_filter" }) },
    code: 1, count: 1, billed: 1, stdout: "", words: FILTERED_WORDS },
  { name: "a refusal part", scene: { billed: answered({ output: [{ type: "message", id: "msg_1", role: "assistant",
    status: "completed", content: [{ type: "refusal", refusal: "REFUSAL-MARKER" }] }] }) },
    code: 1, count: 1, billed: 1, stdout: "", words: FILTERED_WORDS },
  { name: "a refused count (401)", scene: { count: apiError(401) }, code: 1, count: 1, billed: 0 },
  { name: "a failed count (500)", scene: { count: apiError(500) }, code: 1, count: 1, billed: 0 },
  { name: "an unreadable count", scene: { count: garbage }, code: 1, count: 1, billed: 0 },
  { name: "a count with no number", scene: { count: json(200, {}) }, code: 1, count: 1, billed: 0 },
  { name: "a timeout", args: ["--timeout", "1", QUESTION], scene: { billed: hang }, code: 1, count: 1, billed: 1, words: /may have run/ },
  { name: "a timeout on the count", args: ["--timeout", "1", QUESTION], scene: { count: hang }, code: 1, count: 1, billed: 0 },
  { name: "a connection that can't be made", env: () => ({ HUNTAWAY_TEST_OPENAI_URL: closedUrl }), code: 1, count: 0, billed: 0 },
  { name: "a lost connection", scene: { billed: drop }, code: 1, count: 1, billed: 1, words: /may have run/ },
  { name: "a redirect", scene: { billed: redirect }, code: 1, count: 1, billed: 1, words: /redirect/ },
  { name: "a redirect on the count", scene: { count: redirect }, code: 1, count: 1, billed: 0 },
  // The caps come first, before line 1 and the key: BIG's hard worst case, $0.102048, doesn't fit $0.10.
  { name: "over the per-question cap", args: [BIG], env: () => CAPS("0.10", "5.00"),
    code: 1, count: 0, billed: 0, words: /\$0\.11\b/, line1: false },
  // One kept BIG reservation (an uncertain 500) leaves no room for a second: refused at the ledger look, before the count.
  { name: "over the per-day cap", args: [BIG], env: () => TIGHT,
    prep: (dirs, env) => ask([BIG], { dirs, env: { ...env, ...TIGHT }, scene: { billed: apiError(500) } }),
    code: 1, count: 0, billed: 0, words: NO_MORE_ROOM },
  // The ledger is first looked at after line 1 and the key, and before the count.
  { name: "a ledger that can't be opened (a folder in its place)", prep: (dirs) => { mkdirSync(join(dirs.data, "spend.sqlite")); },
    code: 1, count: 0, billed: 0, words: LEDGER_WORDS },
  { name: "a ledger that can't be read (not a database)", prep: (dirs) => { writeFileSync(join(dirs.data, "spend.sqlite"), "not a database, not even close"); },
    code: 1, count: 0, billed: 0, words: LEDGER_WORDS },
  { name: "an overrun", scene: { billed: answered({ usage: usageOf(76, 20) }) },
    code: 0, count: 1, billed: 1, stdout: `${ANSWER}\n`, words: OVERRUN_WARNING },
  { name: "the refusal after an overrun",
    prep: (dirs, env) => ask([QUESTION], { dirs, env, scene: { billed: answered({ usage: usageOf(76, 20) }) } }),
    code: 1, count: 0, billed: 0 },
];

for (const outcome of outcomes) {
  for (const source of ["the environment", "the fake keychain"]) {
    test(`canary, key from ${source}: ${outcome.name}`, async () => {
      const canary = newCanary();
      const dirs = newDirs();
      const runs = [];
      const env = { OPENAI_API_KEY: source === "the environment" ? canary : undefined };
      if (source === "the fake keychain") {
        const stored = await storeKey(dirs, canary);
        assert.equal(stored.code, 0, stored.stderr);
        assert.ok(readFileSync(dirs.keychain, "latin1").includes(canary), "the fake keychain holds it");
        runs.push(stored);
      }
      const prepared = await outcome.prep?.(dirs, env);
      if (prepared) runs.push(prepared);
      const r = await ask(outcome.args ?? [QUESTION], { dirs, scene: outcome.scene, env: { ...env, ...outcome.env?.() } });
      runs.push(r);

      // First, that this really was the outcome it is named for; otherwise a clean scan proves nothing.
      if (outcome.code !== undefined) assert.equal(r.code, outcome.code, r.stderr);
      else assert.notEqual(r.code, 2, r.stderr);
      if (outcome.count !== undefined) assert.equal(r.count.length, outcome.count, "count calls");
      assert.equal(r.billed.length, outcome.billed, "billed calls");
      if (outcome.stdout !== undefined) assert.equal(r.stdout, outcome.stdout);
      if (outcome.words) assert.match(ownWords(r.stderr), outcome.words);
      if (outcome.line1 === false) assert.doesNotMatch(r.stderr, LINE_1_ANY_CAPS, "refused before line 1");
      else assert.match(r.stderr, LINE_1_ANY_CAPS);
      if (outcome.billed > 0) {
        assert.match(r.stderr, LINE_2_ANY);
        assert.ok(existsSync(join(dirs.data, "spend.sqlite")), "the ledger was there to scan");
        assert.ok(existsSync(join(dirs.data, "requests.db")), "the request log was there to scan");
      } else {
        assert.doesNotMatch(r.stderr, LINE_2_ANY);
      }
      assertNoCanary(canary, dirs, runs);
    });
  }
}

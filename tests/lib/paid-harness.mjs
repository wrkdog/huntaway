// Shared pieces for the paid-API tests: a local stand-in for the
// Anthropic API, a fetch fixture that records and refuses every fetch a child makes (with a sentinel proxy as a second
// layer where Node honours it; see "catching network use" below), and helpers that run the CLI as a child
// process and look at what it left behind. Everything here observes behaviour from the outside: the CLI's output, the
// requests the stand-in received, and the files under the test HOME and TMP. Nothing imports Huntaway's own modules,
// so src/ask/paid.ts and src/ask/models.ts can be structured in any way.
//
// The test interfaces:
// - HUNTAWAY_ENABLE_FAKE_ENGINE=1 (the test switch);
// - HUNTAWAY_TEST_ANTHROPIC_URL, set as today to the stand-in's messages URL (http://127.0.0.1:PORT/v1/messages);
//   the stand-in serves POST /v1/messages/count_tokens and POST /v1/messages;
// - HUNTAWAY_TEST_KEYCHAIN_FILE, the fake keychain, {"anthropic": "<key>"}; it works on every platform, Linux too;
// - HUNTAWAY_TEST_NOW, milliseconds since 1970, the ledger's clock (tests move time with it, never by editing rows);
// - keys starting with hwtest-, and the test models hwtest-model and hwtest.model: input $1.00/M, output $2.00/M,
//   priority $2.00/$4.00 (used only to settle a call reported at a non-standard tier), a hard input limit of 100000
//   tokens, the byte bound, a fixed overhead of 64 tokens, safety revision 1. Both map to one override name. So at
//   standard prices one input token costs 1 micro-dollar and one output token 2, and the hard worst case (at the
//   standard price) is min(100000, 2 × the billed request body's UTF-8 bytes + 64) + --max-tokens × 2
//   micro-dollars. A body of 49,968 bytes or more reaches the limit: 102048 micro-dollars ($0.11, rounded up) at the
//   default --max-tokens of 1024. A small question costs far less, and its exact figure is worked out from the body
//   the stand-in received (record.bytes);
// - HUNTAWAY_MAX_USD_PER_QUESTION and HUNTAWAY_MAX_USD_PER_DAY.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const CLI = fileURLToPath(new URL("../../bin/huntaway.ts", import.meta.url));
export const MODEL = "hwtest-model";
/** The other test model: the same prices and limits, and the same override name, as hwtest-model. */
export const MODEL_DOT = "hwtest.model";
/** The override name both test models map to, so it is always refused as ambiguous. */
export const AMBIGUOUS_OVERRIDE = "HUNTAWAY_PRICE_ANTHROPIC_HWTEST_MODEL";
/**
 * The engine's default model (tests/anthropic.test.mjs asserts it). Its prices aren't known to these tests, so it is
 * used only with roomy caps, or with an override raised to $100 per million tokens, far above any real price.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_OVERRIDE = "HUNTAWAY_PRICE_ANTHROPIC_CLAUDE_SONNET_5_5";
/** Caps that no table model's hard worst case is over, for runs where the caps aren't the point. */
export const ROOMY = { HUNTAWAY_MAX_USD_PER_QUESTION: "1000", HUNTAWAY_MAX_USD_PER_DAY: "1000" };
/** hwtest-model's hard input in tokens for a billed request body of `bodyBytes` UTF-8 bytes: min(limit, 2 × bytes + 64). */
export const hardInput = (bodyBytes) => Math.min(100000, 2 * bodyBytes + 64);
/** hwtest-model's hard worst case in micro-dollars, at the standard price: the hard input × 1 + --max-tokens × 2. */
export const hardWorst = (bodyBytes, maxTokens = 1024) => hardInput(bodyBytes) + maxTokens * 2;
/** hwtest-model's hard worst case for a question big enough that the 100000 limit binds (BIG_QUESTION). */
export const limitWorst = (maxTokens = 1024) => 100000 + maxTokens * 2;
/** The exact UTF-8 byte length of a request's body, as the stand-in received it. */
export const bodyBytes = (record) => record.bytes ?? Buffer.byteLength(record.body, "utf8");
/** Micro-dollars as dollars rounded up to the cent, the way "At most" and the caps' figures are shown: 102048 is "0.11". */
export const centsUp = (micro) => (Math.ceil(micro / 10000) / 100).toFixed(2);
export const QUESTION = "what is the aardvark-kiwi-4417 plan";
/**
 * A question of 50,400 bytes, so its billed request body is over 49,968 bytes and the 100000-token limit binds:
 * its hard worst case is limitWorst(maxTokens) whatever the body's exact framing (102048 micro-dollars, $0.11, at the
 * default --max-tokens).
 */
export const BIG_QUESTION = "aardvark-kiwi-4417 plan ".repeat(2100);
export const ANSWER = "the answer";
export const COUNT_PATH = "/v1/messages/count_tokens";
export const BILLED_PATH = "/v1/messages";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh, unique test key: hwtest-, a label, then 32 random hex digits. */
export const newKey = (label = "key") => `hwtest-${label}-${randomBytes(16).toString("hex")}`;

/** A string, regex-escaped. */
export const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An exact whole line, as a multi-line regex. */
export const exactLine = (line) => new RegExp(`^${escaped(line)}$`, "m");

// ----- the clock --------------------------------------------------------------------------------------------------

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** A fixed start for the tests that move the ledger's clock. */
export const T0 = Date.parse("2026-11-05T12:00:00.000Z");
/** The environment that sets the ledger's clock to `ms`. */
export const at = (ms) => ({ HUNTAWAY_TEST_NOW: String(ms) });

// ----- the notice -------------------------------------------------------------------------------------------------

export const LINE1_START = "This question uses your paid Anthropic API key; any charge goes to that account. Huntaway " +
  "first asks Anthropic to count the question (free), which sends it to Anthropic.";
/** Notice line 1, exactly, with the caps as shown (and the override sentence when one is in use). */
export const line1 = (q, d, { override = false } = {}) => exactLine(`${LINE1_START} Caps: $${q} a question, $${d} a day ` +
  `(Huntaway's own use on this machine).${override ? " A price override is in use." : ""}`);
/** Any notice line 1. */
export const ANY_LINE1 = /^This question uses your paid Anthropic API key;/m;
/**
 * Notice line 2, exactly. `abouts` lists the accepted "about" figures. The estimate is priced at "the input price" and
 * "the output price", the standard ones: the priority price is used only to settle a call reported at a
 * non-standard tier, so the tests pass the one standard figure.
 */
export const line2 = (most, abouts, used, cap) => new RegExp(`^At most \\$${escaped(most)} for this question \\(about ` +
  `\\$(?:${abouts.map(escaped).join("|")}) by Anthropic's count\\); \\$${escaped(used)} of your \\$${escaped(cap)} used ` +
  "in the last 24 hours\\.$", "m");
/** Any notice line 2. */
export const ANY_LINE2 = /^At most \$/m;
/** Notice line 2 with this "At most" figure, whatever its "about" and "used" (for tests about the hard worst case). */
export const atMost = (most) => new RegExp(`^At most \\$${escaped(most)} for this question \\(about \\$`, "m");

/** Every dollar amount in the text, in cents. */
export const centsIn = (text) => [...text.matchAll(/\$(\d+)\.(\d\d)\b/g)].map((m) => Number(m[1]) * 100 + Number(m[2]));

// ----- the stand-in ---------------------------------------------------------------------------------------------

export function send(res, status, doc, headers = {}) {
  try {
    res.writeHead(status, { "content-type": "application/json", "request-id": "req_test123", ...headers });
    res.end(typeof doc === "string" ? doc : JSON.stringify(doc));
  } catch {
    // the client went away
  }
}

/** A fixed reply. */
export const reply = (status, doc, headers) => (res) => send(res, status, doc, headers);
/** The count endpoint's success: `{input_tokens: n}`. */
export const countOk = (n) => reply(200, { input_tokens: n });
/** Anthropic usage, as the Messages API reports it; tier undefined leaves service_tier out; `cache` sets cache fields. */
export function usage(input, output, ...rest) {
  // An explicit undefined tier must leave service_tier out, so no default parameter (it would replace undefined).
  const tier = rest.length > 0 ? rest[0] : "standard";
  const cache = rest[1] ?? {};
  const u = { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...cache };
  if (tier !== undefined) u.service_tier = tier;
  return u;
}
/** A Messages API answer. text null means no content blocks; use undefined leaves usage out. */
export function answer(opts = {}) {
  // An explicit use: undefined must leave usage out, so it is read with "in", not a default parameter.
  const { text = ANSWER, stop = "end_turn", headers } = opts;
  const use = "use" in opts ? opts.use : usage(10, 5);
  const doc = { id: "msg_1", type: "message", role: "assistant", model: MODEL,
    content: text === null ? [] : [{ type: "text", text }], stop_reason: stop, stop_sequence: null };
  if (use !== undefined) doc.usage = use;
  return reply(200, doc, headers);
}
/** An API error, in the API's own shape; the message is where a stand-in can try to smuggle text back. */
export const apiError = (status, message = "refused") =>
  reply(status, { type: "error", error: { type: status >= 500 ? "api_error" : "invalid_request_error", message } });
/** Never answer. */
export const hang = () => () => {};
/** Answer with `behaviour` after `ms`. */
export const later = (ms, behaviour) => (res, record, stand) => delay(ms).then(() => behaviour(res, record, stand));
/** A 200 whose body isn't JSON. */
export const garbage = (text = "not json") => (res) => {
  try {
    res.writeHead(200, { "content-type": "application/json", "request-id": "req_test123" });
    res.end(text);
  } catch {
    // gone
  }
};
/** A redirect, which Huntaway never follows. */
export const redirectTo = (location) => (res) => {
  try {
    res.writeHead(307, { location });
    res.end();
  } catch {
    // gone
  }
};

/**
 * A local stand-in for the Anthropic API. `scenario` maps "count" and "billed" to a behaviour `(res, record, stand)`;
 * `seen` lists every request with its kind, method, path, headers, raw headers, body, the body's exact length in
 * bytes, and the child's stderr as it was when the request arrived (the child's stderr is a file, so its writes are
 * synchronous and that view is exact).
 */
export async function startStandIn() {
  const stand = { seen: [], scenario: {}, errFile: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const path = req.url;
      const kind = path === COUNT_PATH ? "count" : path === BILLED_PATH ? "billed" : "other";
      const raw = Buffer.concat(chunks);
      const record = {
        kind, method: req.method, path, headers: req.headers, rawHeaders: req.rawHeaders,
        body: raw.toString("utf8"), bytes: raw.length,
        stderrAtArrival: stand.errFile !== null && existsSync(stand.errFile) ? readFileSync(stand.errFile, "utf8") : "",
      };
      stand.seen.push(record);
      const behaviour = stand.scenario[kind] ?? apiError(404, "no such path on the stand-in");
      try {
        await behaviour(res, record, stand);
      } catch {
        send(res, 500, { type: "error", error: { type: "api_error", message: "stand-in error" } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stand.port = server.address().port;
  stand.origin = `http://127.0.0.1:${stand.port}`;
  stand.url = `${stand.origin}${BILLED_PATH}`;
  stand.of = (kind, seen = stand.seen) => seen.filter((r) => r.kind === kind);
  stand.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return stand;
}

// ----- catching network use -------------------------------------------------------------------------------------
//
// Two layers, for runs that must send nothing (or nothing but what a test names):
// - The fetch fixture, the primary check. The child is started with `--import <fixture>`, which replaces
//   globalThis.fetch before the CLI loads, in the main thread and in every worker thread it starts (workers inherit
//   the --import; src/ask/paid-fetch.ts makes each paid call from one). Each call's URL and method, never its headers
//   or body, is appended to the file named by HUNTAWAY_TEST_FETCH_LOG, and the call fails as a refused connection
//   (ECONNREFUSED), so nothing is sent anywhere. It works on every supported Node (22.18 and later). It sees fetch
//   only: not node:http, node:net or a child process the CLI starts.
// - The sentinel proxy (startSentinel), a second layer. It sees only clients that honour NODE_USE_ENV_PROXY, which
//   arrived in Node 22.21 and 24.5; older Node ignores it, so on Node 22.18 to 22.20 and 24.0 to 24.4 the sentinel
//   sees nothing at all. With the fetch fixture in place fetch never reaches it either, so what it can still catch
//   is a proxy-honouring node:http or node:https request on a newer Node.

const FETCH_FIXTURE_SOURCE = `
import { appendFileSync } from "node:fs";
const log = process.env.HUNTAWAY_TEST_FETCH_LOG;
if (!log) throw new Error("the fetch fixture needs HUNTAWAY_TEST_FETCH_LOG");
// Created on load, so a run whose log is missing is a fixture that never loaded, never "no calls".
appendFileSync(log, "");
globalThis.fetch = async (input, init) => {
  const url = typeof input === "object" && input !== null && "url" in input ? input.url : String(input);
  const method = init?.method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET");
  appendFileSync(log, JSON.stringify({ url, method }) + "\\n");
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  throw new TypeError("fetch failed", { cause: refused });
};
`;
let fetchFixtureDir = null;

/** The fetch fixture's path (written once per test process), for `--import`. */
export function fetchFixture() {
  if (fetchFixtureDir === null) {
    fetchFixtureDir = mkdtempSync(join(tmpdir(), "huntaway-fetch-fixture-"));
    writeFileSync(join(fetchFixtureDir, "refusing-fetch.mjs"), FETCH_FIXTURE_SOURCE);
    // The fixture and its fetch logs are this test process's own: remove them when it exits.
    const dir = fetchFixtureDir;
    process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } });
  }
  return join(fetchFixtureDir, "refusing-fetch.mjs");
}
/** The node arguments that load the fetch fixture. */
export const fetchFixtureArgs = () => ["--import", pathToFileURL(fetchFixture()).href];
/** A fresh path for one run's HUNTAWAY_TEST_FETCH_LOG (not yet created; the fixture creates it on load). */
export function newFetchLog(dir) {
  if (dir === undefined) {
    fetchFixture();
    dir = fetchFixtureDir;
  }
  return join(dir, `fetch-${randomBytes(8).toString("hex")}.log`);
}
/**
 * The fetch calls a run made, `[{url, method}]` in order. Throws if the log doesn't exist: the fixture never loaded,
 * so the run proves nothing.
 */
export function recordedFetches(log) {
  if (!existsSync(log)) throw new Error(`the fetch fixture never loaded (no ${log})`);
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * A sentinel HTTP proxy. Children that should send nothing get NODE_USE_ENV_PROXY=1 and HTTP(S)_PROXY pointing here
 * with no NO_PROXY. Only a client that honours NODE_USE_ENV_PROXY comes here: Node 22.21+ and 24.5+ do, and older Node
 * (22.18 to 22.20, 24.0 to 24.4) ignores it, so there an empty `hits` proves nothing. A run under the fetch fixture
 * (above, the primary check) never reaches it by fetch either. Treat it as a second layer, never the only one.
 */
export async function startSentinel() {
  const sentinel = { hits: [] };
  const server = createServer((req, res) => {
    sentinel.hits.push(`${req.method} ${req.url}`);
    res.writeHead(502);
    res.end();
  });
  server.on("connect", (req, socket) => {
    sentinel.hits.push(`CONNECT ${req.url}`);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  sentinel.url = `http://127.0.0.1:${server.address().port}`;
  sentinel.env = () => ({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: sentinel.url, HTTP_PROXY: sentinel.url,
    https_proxy: sentinel.url, http_proxy: sentinel.url, NO_PROXY: undefined, no_proxy: undefined });
  sentinel.close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  return sentinel;
}

/** A local URL where nothing listens. */
export async function closedUrl() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}${BILLED_PATH}`;
}

// ----- running the CLI ------------------------------------------------------------------------------------------

/**
 * Fresh folders for one test: HOME (holding Huntaway's data folder and the fake keychain's folder), TMP, and a
 * separate folder for the captured stdout and stderr (outside HOME and TMP, so scans of those never see them).
 */
export function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), "huntaway-paid-"));
  const dirs = { root, home: join(root, "home"), tmp: join(root, "tmp"), out: join(root, "out") };
  dirs.hw = join(dirs.home, "huntaway");
  dirs.kcDir = join(dirs.home, "kc");
  dirs.keychain = join(dirs.kcDir, "keychain.json");
  dirs.ledger = join(dirs.hw, "spend.sqlite");
  for (const d of [dirs.home, dirs.tmp, dirs.out, dirs.kcDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return dirs;
}

/**
 * A minimal environment, built from nothing: no key, Huntaway setting or proxy from the machine running the tests
 * reaches the child. Caps default to $0.50 a question and $5.00 a day, room for hwtest-model's hard worst case on any
 * question these tests ask (at most $0.12, BIG_QUESTION at --max-tokens 8192); `extra` overrides, and undefined removes. The ledger's clock is the real one unless `extra` sets HUNTAWAY_TEST_NOW.
 */
export function envFor(dirs, stand, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: dirs.home, USER: process.env.USER ?? "tester", LOGNAME: process.env.USER ?? "tester",
    TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
    HUNTAWAY_HOME: dirs.hw, HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_TEST_KEYCHAIN_FILE: dirs.keychain,
    HUNTAWAY_MAX_USD_PER_QUESTION: "0.50", HUNTAWAY_MAX_USD_PER_DAY: "5.00",
    HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "Test Mac",
  };
  if (stand) env.HUNTAWAY_TEST_ANTHROPIC_URL = stand.url;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Run the CLI once. stdout and stderr go to files (so the stand-in can read stderr as each request arrives). With a
 * stand-in, its `seen` list starts afresh unless `reset` is false. `input` is written to stdin, which is then closed.
 * With `catchFetch`, the child runs under the fetch fixture and the result's `fetches` lists its fetch calls
 * (recordedFetches; the log sits in dirs.out, outside HOME and TMP).
 */
export function runCli(args, { dirs, stand, env = {}, input, reset = true, catchFetch = false } = {}) {
  const tag = randomBytes(6).toString("hex");
  const outFile = join(dirs.out, `${tag}.out`);
  const errFile = join(dirs.out, `${tag}.err`);
  const fetchLog = catchFetch ? newFetchLog(dirs.out) : null;
  const childEnv = envFor(dirs, stand, env);
  if (fetchLog !== null) childEnv.HUNTAWAY_TEST_FETCH_LOG = fetchLog;
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  if (stand) {
    if (reset) stand.seen = [];
    stand.errFile = errFile;
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // Start the CLI as the installed launcher does (scripts/install-local.sh), so Node 22's SQLite notice stays out of
    // the output the tests read; Huntaway's own warnings still show.
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning",
      ...(fetchLog !== null ? fetchFixtureArgs() : []), CLI, ...args], {
      env: childEnv, cwd: dirs.home,
      stdio: [input === undefined ? "ignore" : "pipe", outFd, errFd],
    });
    closeSync(outFd);
    closeSync(errFd);
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.on("close", (code, signal) => {
      try {
        const result = {
          code, signal, ms: Date.now() - started, dirs,
          stdout: readFileSync(outFile, "utf8"), stderr: readFileSync(errFile, "utf8"),
          seen: stand ? stand.seen : [],
        };
        if (fetchLog !== null) result.fetches = recordedFetches(fetchLog);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Fill the fake keychain directly, in the layer's format (most tests fill it through `huntaway key set`). */
export function writeKeychain(dirs, key) {
  writeFileSync(dirs.keychain, JSON.stringify({ anthropic: key }), { mode: 0o600 });
}

/** `huntaway ask --engine anthropic --model hwtest-model ...args` (args end with the question). */
export const ask = (args, opts) => runCli(["ask", "--engine", "anthropic", "--model", MODEL, ...args], opts);
/** `huntaway ask --engine anthropic --model hwtest.model ...args`. */
export const askDot = (args, opts) => runCli(["ask", "--engine", "anthropic", "--model", MODEL_DOT, ...args], opts);
/** `huntaway ask --engine anthropic ...args`, with the engine's default model. */
export const askDefaultModel = (args, opts) => runCli(["ask", "--engine", "anthropic", ...args], opts);
/** `huntaway key set anthropic`, with the key as one line on stdin (not a terminal). */
export const keySet = (key, opts) => runCli(["key", "set", "anthropic"], { ...opts, input: `${key}\n` });
export const keyRemove = (opts) => runCli(["key", "remove", "anthropic"], opts);
export const doctor = (opts) => runCli(["doctor"], opts);
export const status = (opts) => runCli(["status"], opts);

/** The "$X of $Y used in the last 24 hours" amounts from status's output, or null. */
export function usedOf(text) {
  const m = /\$(\d+\.\d\d) of \$(\d+\.\d\d) used in the last 24 hours/.exec(text);
  return m === null ? null : { used: m[1], cap: m[2] };
}

/** The doctor lines that start with FAIL. */
export const failLines = (text) => text.split("\n").filter((l) => l.startsWith("FAIL"));

// ----- what was left behind -------------------------------------------------------------------------------------

/** Every regular file under the given folders (links are not followed). */
export function filesUnder(roots) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push(path);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** The forms a leaked key could take: itself, its random tail, and its base64 and hex encodings. */
export function secretForms(secret) {
  return [secret, secret.slice(-32), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")];
}

/**
 * Every place a secret shows up, apart from the one place it belongs (the x-api-key header of a stand-in request):
 * the runs' stdout and stderr; any file under HOME and TMP except the fake keychain file; and every other part of
 * every request the stand-in saw (method, path, body, every other header's name and value).
 */
export function leaksOf(secret, { runs, dirs, seen }) {
  const forms = secretForms(secret);
  const has = (text) => forms.some((f) => text.includes(f));
  const found = [];
  runs.forEach((r, i) => {
    if (has(r.stdout)) found.push(`stdout of run ${i}`);
    if (has(r.stderr)) found.push(`stderr of run ${i}`);
  });
  for (const file of filesUnder([dirs.home, dirs.tmp])) {
    if (file === dirs.keychain) continue;
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    if (forms.some((f) => bytes.includes(f))) found.push(`file ${file.slice(dirs.root.length)}`);
  }
  for (const call of seen) {
    const others = [];
    for (let i = 0; i < call.rawHeaders.length; i += 2) {
      if (call.rawHeaders[i].toLowerCase() !== "x-api-key") others.push(call.rawHeaders[i], call.rawHeaders[i + 1]);
    }
    if ([call.method, call.path, call.body, ...others].some(has)) found.push(`${call.kind} request (outside x-api-key)`);
  }
  return found;
}

/** Whether any 8 characters in a row of the key appear in the text (for keys that must never be echoed at all). */
export function echoesPartOf(key, text) {
  for (let i = 0; i + 8 <= key.length; i += 1) if (text.includes(key.slice(i, i + 8))) return true;
  return false;
}

// ----- the ledger (spend.sqlite), read without knowing its column names -----------------------------------------

const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all().map((r) => r.name);
const quoted = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** Every row of every table in spend.sqlite, read-only ([] when there is no ledger). */
export function ledgerRows(dirs) {
  if (!existsSync(dirs.ledger)) return [];
  const db = new DatabaseSync(dirs.ledger, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return tableNames(db).flatMap((t) => db.prepare(`SELECT * FROM ${quoted(t)}`).all());
  } finally {
    db.close();
  }
}

/** Whether some ledger row holds exactly this value (micro-dollars are integers, so 10001 never matches 10001.5). */
export const ledgerHas = (dirs, value) => ledgerRows(dirs).some((row) => Object.values(row).some((v) =>
  v === value || (typeof v === "bigint" && typeof value === "number" && v === BigInt(value))));

/** The ledger's bytes, with its side files, as one latin1 string (to search for things it must never hold). */
export function ledgerBytes(dirs) {
  return ["", "-wal", "-shm", "-journal"].map((s) => `${dirs.ledger}${s}`).filter((p) => existsSync(p))
    .map((p) => readFileSync(p, "latin1")).join("\n");
}

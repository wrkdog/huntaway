// The byte bound's normalized count for the OpenAI engine,
// the same rule tests/paid-nfkc.test.mjs holds Anthropic to. NFKC can expand text (U+FDFA is 3 bytes and becomes 33),
// so for hwtest-model:
//   B          = max(the billed request body's UTF-8 bytes, the same body's bytes with the question NFKC-normalized)
//   hard input = min(100000, 2 × B + 64) tokens
//   hard worst = hard input × 1 + --max-tokens × 2 micro-dollars (the standard price; both caps and "At most" use it)
// Huntaway sends the question as written (it normalizes only to count the bound), so the stand-in sees the raw body,
// and each test works B out from that body: its bytes, plus the question's growth under NFKC.
//
// With the body Huntaway sends OpenAI today, {model, input, max_output_tokens, service_tier, store}, 99 bytes around
// the question, 600 × U+FDFA (1800 bytes raw, 19800 normalized) gives a raw body of 1899 bytes and a normalized one of
// 19899: a hard worst case of 3862 + 2048 = 5910 micro-dollars ($0.01) on the raw count, and 39862 + 2048 = 41910
// ($0.05) on the normalized one. A $0.04 cap sits between them: the raw count would admit the question, the
// normalized count refuses it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CLI = fileURLToPath(new URL("../bin/huntaway.ts", import.meta.url));
const MODEL = "hwtest-model";
const KEY = `hwtest-openai-nfkc-${randomBytes(16).toString("hex")}`;
const COUNT_PATH = "/v1/responses/input_tokens";
const BILLED_PATH = "/v1/responses";
const ANSWER = "the otter-quince-9921 answer";
const QCAP = "HUNTAWAY_MAX_USD_PER_QUESTION";
const DCAP = "HUNTAWAY_MAX_USD_PER_DAY";

/** Characters by code point, so this file holds no character NFKC or an editor could change. */
const FDFA = String.fromCodePoint(0xfdfa);
const QUESTION = FDFA.repeat(600);
const utf8 = (text) => Buffer.byteLength(text, "utf8");
const NON_ASCII = /[\u007f-\uffff]/g;
/** A string as JSON writes it, without the quotes; `ascii` escapes every non-ASCII code unit as \uXXXX. */
const serialized = (text, ascii = false, upper = false) => {
  const plain = JSON.stringify(text).slice(1, -1);
  if (!ascii) return plain;
  return plain.replace(NON_ASCII, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
};
/** hwtest-model's hard worst case in micro-dollars for a billed body of `bytes` UTF-8 bytes, at the standard price. */
const hardWorst = (bytes, maxTokens = 1024) => Math.min(100000, 2 * bytes + 64) + maxTokens * 2;
/** Micro-dollars rounded up to the cent, as "0.05". */
const centsUp = (micro) => (Math.ceil(micro / 10_000) / 100).toFixed(2);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const atMost = (dollars) => new RegExp(`^At most \\$${escaped(dollars)} for this question \\(about \\$`, "m");
const ANY_LINE1 = /^This question uses your paid OpenAI API key;/m;
const ANY_LINE2 = /^At most \$/m;

// ---- The stand-in for the Responses API -----------------------------------------------------------------------------

const counted = (n) => ({ status: 200, doc: { object: "response.input_tokens", input_tokens: n } });
const answered = () => ({
  status: 200,
  doc: {
    id: "resp_test", object: "response", status: "completed", incomplete_details: null, model: MODEL,
    output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: ANSWER, annotations: [] }] }],
    service_tier: "default",
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30 },
  },
});

let server;
let standInUrl;
let seen = [];
let errFile = null;
const madeFolders = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      const kind = path === COUNT_PATH ? "count" : path === BILLED_PATH ? "billed" : "other";
      const raw = Buffer.concat(chunks);
      seen.push({
        kind, method: req.method, url: req.url, body: raw.toString("utf8"), bytes: raw.length,
        // The child's stderr is a file, so its writes are synchronous and this view is exact.
        stderrAtArrival: errFile !== null && existsSync(errFile) ? readFileSync(errFile, "utf8") : "",
      });
      const reply = kind === "count" ? counted(10) : kind === "billed" ? answered() : { status: 404, doc: { error: { message: "no such path" } } };
      res.writeHead(reply.status, { "content-type": "application/json", "x-request-id": "req_test123" });
      res.end(JSON.stringify(reply.doc));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  standInUrl = `http://127.0.0.1:${server.address().port}${BILLED_PATH}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  for (const folder of madeFolders) rmSync(folder, { recursive: true, force: true });
});

function newDirs() {
  const root = mkdtempSync(join(tmpdir(), "huntaway-openai-nfkc-"));
  madeFolders.push(root);
  const dirs = { root, home: join(root, "home"), data: join(root, "home", "huntaway"), tmp: join(root, "tmp"), out: join(root, "out") };
  dirs.ledger = join(dirs.data, "spend.sqlite");
  for (const d of [dirs.data, dirs.tmp, dirs.out]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return dirs;
}

/** `huntaway ask --engine openai --model hwtest-model ...args`, in a minimal environment built from nothing. */
function ask(args, { dirs = newDirs(), env = {} } = {}) {
  const tag = randomBytes(6).toString("hex");
  const outFile = join(dirs.out, `${tag}.out`);
  errFile = join(dirs.out, `${tag}.err`);
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  seen = [];
  const full = {
    PATH: process.env.PATH, HOME: dirs.home, TMPDIR: dirs.tmp,
    HUNTAWAY_HOME: dirs.data, HUNTAWAY_ALIAS: "test-mac", HUNTAWAY_FLEET_CMD: "none",
    HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_TEST_OPENAI_URL: standInUrl,
    HUNTAWAY_TEST_KEYCHAIN_FILE: join(dirs.home, "fake-keychain.json"),
    OPENAI_API_KEY: KEY, [QCAP]: "0.50", [DCAP]: "5.00", ...env,
  };
  for (const [k, v] of Object.entries(full)) if (v === undefined) delete full[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, "ask", "--engine", "openai", "--model", MODEL, ...args],
      { env: full, cwd: dirs.home, stdio: ["ignore", outFd, errFd] });
    closeSync(outFd);
    closeSync(errFd);
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.on("close", (code) => {
      clearTimeout(watchdog);
      const calls = seen;
      assert.deepEqual(calls.filter((c) => c.kind === "other").map((c) => `${c.method} ${c.url}`), [],
        `only ${BILLED_PATH} and ${COUNT_PATH} exist`);
      resolve({ code, dirs, stdout: readFileSync(outFile, "utf8"), stderr: readFileSync(errFile, "utf8"), seen: calls });
    });
  });
}

/** Every value in every row of spend.sqlite, read-only, without knowing its column names ([] with no ledger). */
function ledgerValues(dirs) {
  if (!existsSync(dirs.ledger)) return [];
  const db = new DatabaseSync(dirs.ledger, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    return tables.flatMap(({ name }) => db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all())
      .flatMap((row) => Object.values(row));
  } finally {
    db.close();
  }
}
const ledgerHas = (dirs, value) => ledgerValues(dirs).some((v) => v === value || (typeof v === "bigint" && v === BigInt(value)));

/**
 * The byte bound's two counts for a request, from the body the stand-in received: `raw`, its UTF-8 bytes, and
 * `normalized`, the same body's bytes with the question NFKC-normalized (written into the body the same way, plain
 * UTF-8 or \u escapes, as the original).
 */
function counts(record, question) {
  const style = [[false, false], [true, false], [true, true]].find(([a, u]) => record.body.includes(serialized(question, a, u)));
  assert.ok(style !== undefined, "the question is in the body, in a form the test can rewrite");
  const raw = record.bytes;
  const normalized = raw - utf8(serialized(question, ...style)) + utf8(serialized(question.normalize("NFKC"), ...style));
  return { raw, normalized, bound: Math.max(raw, normalized) };
}

/** The request carries the question exactly as written: NFKC is only for counting the byte bound. */
function assertSentUnchanged(record, question, what) {
  const body = JSON.parse(record.body);
  assert.equal(body.input, question, `${what}: the question is sent as written`);
  assert.notEqual(body.input, question.normalize("NFKC"), `${what}: never the NFKC-normalized question`);
  assert.ok(!record.body.includes(serialized(question.normalize("NFKC"))), `${what}: the normalized text is nowhere in the body`);
}

// ---- The tests ------------------------------------------------------------------------------------------------------

test("U+FDFA: 3 bytes raw, 33 after NFKC", () => {
  assert.equal(utf8(FDFA), 3);
  assert.equal(utf8(FDFA.normalize("NFKC")), 33);
  assert.equal(utf8(QUESTION), 1800);
  assert.equal(utf8(QUESTION.normalize("NFKC")), 19800);
});

test("600 × U+FDFA on OpenAI: the reservation and line 2's At most follow max(raw, normalized) body bytes, and both calls send the question unchanged", async () => {
  const r = await ask([QUESTION]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${ANSWER}\n`);
  assert.deepEqual(r.seen.map((c) => c.kind), ["count", "billed"]);
  const [count, billed] = r.seen;
  assertSentUnchanged(count, QUESTION, "the count");
  assertSentUnchanged(billed, QUESTION, "the billed call");
  const c = counts(billed, QUESTION);
  assert.equal(c.normalized - c.raw, 18000, "the normalized body is 30 bytes longer for each U+FDFA");
  assert.equal(c.bound, c.normalized, "B is the normalized count here");
  assert.ok(2 * c.normalized + 64 < 100000, "below the 100000-token limit, so the byte bound is what binds");
  const rawWorst = hardWorst(c.raw);
  const normalizedWorst = hardWorst(c.normalized);
  // With today's framing (a 1899-byte body, 19899 normalized) these are 5910 ($0.01) and 41910 ($0.05) micro-dollars.
  assert.equal(centsUp(rawWorst), "0.01");
  assert.equal(centsUp(normalizedWorst), "0.05");
  assert.ok(ledgerHas(r.dirs, normalizedWorst),
    `the reservation is (2 × ${c.normalized} + 64) + 1024 × 2 = ${normalizedWorst} micro-dollars, on the normalized count`);
  assert.ok(!ledgerHas(r.dirs, rawWorst), `not ${rawWorst}, the raw count's figure`);
  assert.match(r.stderr, atMost(centsUp(normalizedWorst)), `At most $${centsUp(normalizedWorst)}, not $${centsUp(rawWorst)}`);
  assert.doesNotMatch(r.stderr, atMost(centsUp(rawWorst)));
  assert.match(billed.stderrAtArrival, atMost(centsUp(normalizedWorst)), "line 2, with that figure, before the billed call");
});

test("a $0.04 cap, between the raw count's $0.01 and the normalized count's $0.05, refuses 600 × U+FDFA before anything is sent, naming $0.05; $0.05 holds it", async () => {
  const dirs = newDirs();
  const refused = await ask([QUESTION], { dirs, env: { [QCAP]: "0.04", [DCAP]: "5.00" } });
  assert.equal(refused.code, 1, refused.stderr);
  assert.equal(refused.stdout, "");
  assert.equal(refused.seen.length, 0, "over the per-question cap on the normalized count: not even the count is sent");
  assert.doesNotMatch(refused.stderr, ANY_LINE1, "refused at the caps, before notice line 1");
  assert.doesNotMatch(refused.stderr, ANY_LINE2);
  assert.match(refused.stderr, /HUNTAWAY_MAX_USD_PER_QUESTION/, "names the setting to raise");
  assert.match(refused.stderr, /\$0\.05\b/, "names the cap this question needs: $0.05 (41910 micro-dollars, rounded up)");
  assert.equal(ledgerValues(dirs).length, 0, "nothing reserved");
  // The figures the refusal rests on, from what a $0.05 cap lets through.
  const ran = await ask([QUESTION], { env: { [QCAP]: "0.05", [DCAP]: "5.00" } });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(ran.seen.map((c) => c.kind), ["count", "billed"]);
  const c = counts(ran.seen[1], QUESTION);
  assert.ok(hardWorst(c.raw) <= 40_000 && hardWorst(c.normalized) > 40_000,
    `$0.04 is between the raw figure (${hardWorst(c.raw)}) and the normalized one (${hardWorst(c.normalized)})`);
  assert.match(ran.stderr, atMost("0.05"));
});

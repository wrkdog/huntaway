// Acceptance for `huntaway ask` v0 (frozen before the build): one owner question, run once on an engine, recorded in
// the durable request log (no prompt text stored), shown by `huntaway status` as a local run. Never retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeValidator } from "./lib/schema.mjs";
import { RequestLog } from "../src/core/request-log.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { forTerminal } from "../src/ask/ask.ts";

const CLI = fileURLToPath(new URL("../bin/huntaway.ts", import.meta.url));
const FLEET = fileURLToPath(new URL("./fixtures/fleet-sample.json", import.meta.url));
const FAKE_PIPE = fileURLToPath(new URL("./fixtures/fake-pipe-mcp.mjs", import.meta.url));
const schema = JSON.parse(readFileSync(new URL("../contract/huntaway-status.schema.json", import.meta.url), "utf8"));
const check = makeValidator(schema);
const SECRET_QUESTION = "what is the zebra-quokka-7731 plan";
process.env.HUNTAWAY_ENABLE_FAKE_ENGINE = "1";            // every child below may use the test-only fake engine
process.env.HUNTAWAY_FLEET_ALIASES = "studio=Studio,mini=Mini,laptop=Laptop";   // the fleet names these tests use

function home() { return mkdtempSync(join(tmpdir(), "huntaway-ask-")); }
function run(args, env = {}, input) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args],
    { encoding: "utf8", input, env: { ...process.env, HUNTAWAY_ALIAS: "Mini", ...env } });
}
function runKeys(h) {
  const db = new DatabaseSync(join(h, "runs.db"));
  try { return db.prepare("SELECT key FROM runs").all().map((r) => r.key); } finally { db.close(); }
}
function onlyRequest(h) {
  const log = new RequestLog(join(h, "requests.db"));
  try {
    const keys = runKeys(h);
    assert.equal(keys.length, 1);
    return { request: log.get(keys[0]), journal: log.journal(keys[0]).map((e) => e.to) };
  } finally { log.close(); }
}

test("a fake-engine question is answered once, recorded, and never stored as text", () => {
  const h = home();
  const out = run(["ask", "--engine", "fake", SECRET_QUESTION], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "forty-two" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "forty-two\n");
  const { request, journal } = onlyRequest(h);
  assert.equal(request.state, "answered");
  assert.deepEqual(journal, ["received", "queued", "submitting", "dispatched", "posting", "answered"]);
  for (const f of readdirSync(h)) {
    const bytes = readFileSync(join(h, f));
    assert.ok(!bytes.includes(Buffer.from("zebra-quokka-7731")), `${f} must not contain the question`);
    assert.ok(!bytes.includes(Buffer.from("forty-two")), `${f} must not contain the answer`);
  }
});

test("the question can come from standard input with '-'", () => {
  const h = home();
  const out = run(["ask", "--engine", "fake", "-"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "from stdin ok" }, "hello there\n");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "from stdin ok\n");
});

test("usage errors exit 2 and record nothing", () => {
  const h = home();
  for (const args of [["ask"], ["ask", "--engine", "fake", ""], ["ask", "--engine", "warp", "hi"], ["ask", "--family", "cobol", "hi"]]) {
    const out = run(args, { HUNTAWAY_HOME: h });
    assert.equal(out.status, 2, `${args.join(" ")} -> ${out.stderr}`);
  }
  assert.ok(!existsSync(join(h, "requests.db")) && !existsSync(join(h, "runs.db")), "nothing recorded");
});

test("an engine that fails before dispatch leaves the request failed; exit 1; one attempt only", () => {
  const h = home();
  const out = run(["ask", "--engine", "fake", "hi"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_FAIL: "submit" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /failed/i);
  const { request, journal } = onlyRequest(h);
  assert.equal(request.state, "failed");
  assert.deepEqual(journal, ["received", "queued", "submitting", "failed"]);
});

test("an engine that loses the answer after dispatch leaves the request uncertain, never retried", () => {
  const h = home();
  const out = run(["ask", "--engine", "fake", "hi"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_FAIL: "wait" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /uncertain|not sure|may have run/i);
  const { request, journal } = onlyRequest(h);
  assert.equal(request.state, "uncertain");
  assert.deepEqual(journal, ["received", "queued", "submitting", "dispatched", "uncertain"]);
});

test("the pipe engine speaks MCP to the pipe: submit once, wait until done, print the answer", () => {
  const h = home();
  const log = join(h, "calls.log");
  const out = run(["ask", "--engine", "pipe", "--family", "claude", "hi"], {
    HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_LOG: log });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "pong from the pipe\n");
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").filter((c) => c !== "pong"), ["pipe_submit", "pipe_wait", "pipe_wait"]);
});

test("a pipe job the pipe reports failed is failed (exit 1)", () => {
  const h = home();
  const out = run(["ask", "--engine", "pipe", "hi"], {
    HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: "fail" });
  assert.equal(out.status, 1);
  const { request } = onlyRequest(h);
  assert.equal(request.state, "failed");
});

test("a pipe job that never finishes within --timeout is uncertain", () => {
  const h = home();
  const out = run(["ask", "--engine", "pipe", "--timeout", "2", "hi"], {
    HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: "hang" });
  assert.equal(out.status, 1);
  const { request } = onlyRequest(h);
  assert.equal(request.state, "uncertain");
});

test("status shows the local runs as contract codes with no text", () => {
  const h = home();
  run(["ask", "--engine", "fake", SECRET_QUESTION], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" });
  run(["ask", "--engine", "fake", "second"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_FAIL: "submit" });
  const out = run(["status", "--json", "--fleet-file", FLEET], { HUNTAWAY_HOME: h });
  assert.equal(out.status, 0, out.stderr);
  const snap = JSON.parse(out.stdout);
  assert.deepEqual(check(snap), []);
  assert.equal(snap.runs.length, 2);
  const codes = snap.runs.map((r) => [r.code, r.status]).sort();
  assert.deepEqual(codes, [["done", "ended"], ["failed", "ended"]]);
  for (const r of snap.runs) {
    assert.equal(r.placement, "local");
    assert.equal(r.placedBy, "default");
    assert.equal(r.worker, "Mini");
    assert.match(r.runId, /^[A-Za-z0-9_-]{8,64}$/);
    assert.ok(r.statusSince <= r.asOf, "a run's state began before its own as-of time");
  }
  assert.ok(!out.stdout.includes("zebra-quokka-7731"));
  const human = run(["status", "--fleet-file", FLEET], { HUNTAWAY_HOME: h });
  assert.match(human.stdout, /2 local runs|runs: 2|2 runs/i);
});

test("a submit the pipe never confirms is uncertain (it may exist), not failed", () => {
  const h = home();
  const out = run(["ask", "--engine", "pipe", "hi"], {
    HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: "submit-hang",
    HUNTAWAY_SUBMIT_TIMEOUT_MS: "500" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not sure/i);
  const { request, journal } = onlyRequest(h);
  assert.equal(request.state, "uncertain");
  assert.deepEqual(journal, ["received", "queued", "submitting", "uncertain"]);
});

test("four asks at once on a brand-new install: all answered, all distinct, one shared key, all in the run list", async () => {
  const { spawn } = await import("node:child_process");
  for (let round = 0; round < 5; round++) {                // the first-creation race needs a fresh home each round
    const h = home();
    const one = () => new Promise((resolve) => {
      let err = "";
      const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "fake", "q"],
        { env: { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }, stdio: ["ignore", "ignore", "pipe"] });
      p.stderr.on("data", (d) => { err += d; });
      p.on("close", (code) => resolve({ code, err }));
    });
    const results = await Promise.all([one(), one(), one(), one()]);
    assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0], `round ${round}: ${results.map((r) => r.err).join(" | ")}`);
    const keys = runKeys(h);
    assert.equal(new Set(keys).size, 4);
    const log = new RequestLog(join(h, "requests.db"));
    try {
      for (const k of keys) assert.equal(log.get(k).state, "answered");
      assert.equal(new Set(keys.map((k) => log.get(k).contentHash)).size, 1, "every run used the same install key");
    } finally { log.close(); }
    assert.deepEqual(readdirSync(h).filter((f) => f.includes(".tmp") || f.includes("creating")), [], "no leftovers");
  }
});

test("the open lock dies with its process: a run killed while opening blocks nobody; a live holder means busy", async () => {
  const h = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  const { spawn } = await import("node:child_process");
  const holder = spawn(process.execPath, ["-e",
    `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(join(h, "runs.db"))});` +
    `d.exec("BEGIN IMMEDIATE");console.log("holding");setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  const busy = run(["ask", "--engine", "fake", "second"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "b" });
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /another huntaway run is opening the request log; try again/);
  assert.equal(busy.stdout, "", "nothing ran");
  const status = run(["status", "--fleet-file", FLEET], { HUNTAWAY_HOME: h });
  assert.match(status.stdout, /Local runs: unavailable right now/);
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.on("close", resolve));
  const after = run(["ask", "--engine", "fake", "third"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "c" });
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(readdirSync(h).filter((f) => f.includes("creating") || f.includes(".tmp")), [], "no marker, ever");
});

test("a log needing recovery is refused with plain words: keep every file, ask for help; nothing is sent", () => {
  const cases = [];
  const fresh = home();                                    // a first run that crashed while creating the log
  writeFileSync(join(fresh, "runs.db"), "");
  writeFileSync(join(fresh, "requests.db"), "");
  writeFileSync(join(fresh, "requests.db-journal"), "x");
  cases.push(fresh);
  const used = home();                                     // a log with history
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: used, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  writeFileSync(join(used, "requests.db-journal"), "x");
  cases.push(used);
  const noList = home();                                   // no run list at all
  writeFileSync(join(noList, "requests.db"), "");
  writeFileSync(join(noList, "requests.db-journal"), "x");
  cases.push(noList, noList);                              // asked twice: the answer never changes
  for (const h of cases) {
    const out = run(["ask", "--engine", "fake", "q"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" });
    assert.equal(out.status, 1);
    assert.equal(out.stdout, "", "nothing ran");
    assert.match(out.stderr, /the request log needs recovery/);
    assert.match(out.stderr, /Keep every file in the Huntaway folder as it is and ask for help/);
    assert.match(out.stderr, /If the request log needs recovery/);
    assert.ok(!/move|delete|nothing is lost|loses nothing/i.test(out.stderr), out.stderr);
    assert.ok(!out.stderr.includes(h), "no path");
  }
  // A run list that isn't a database stops the open lock itself: the plain "could not be opened".
  writeFileSync(join(used, "runs.db"), "this is not a database");
  const unreadable = run(["ask", "--engine", "fake", "third"], { HUNTAWAY_HOME: used, HUNTAWAY_FAKE_ANSWER: "c" });
  assert.equal(unreadable.status, 1);
  // (Node 22 adds its own "SQLite is experimental" warning line after ours.)
  assert.equal(unreadable.stderr.split("\n")[0], "Error: the request log could not be opened");
});

test("a run is listed before it can be sent: if the first listing fails, nothing is sent", () => {
  const h = home();
  const db = new DatabaseSync(join(h, "runs.db"));
  db.exec(`CREATE TABLE runs (key TEXT PRIMARY KEY, code TEXT NOT NULL, since TEXT NOT NULL, last TEXT NOT NULL,
    pid INTEGER NOT NULL) STRICT; CREATE TRIGGER refuse BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'no'); END;`);
  db.close();
  const calls = join(h, "calls.log");
  const out = run(["ask", "--engine", "pipe", "hi"], { HUNTAWAY_HOME: h,
    HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_LOG: calls });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /the run list could not be updated, so nothing was sent/);
  assert.ok(!existsSync(calls), "the pipe was never called");
  const raw = new DatabaseSync(join(h, "requests.db"), { readOnly: true });
  try {
    assert.deepEqual(raw.prepare("SELECT state FROM requests").all().map((r) => r.state), ["refused"], "recorded as never sent");
  } finally { raw.close(); }
});

test("the open lock: taking and releasing it writes nothing, even when the work inside fails", async () => {
  const { withOpenLock } = await import("../src/status/runs.ts");
  const h = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  const bytes = () => readFileSync(join(h, "runs.db"));
  const before = { files: readdirSync(h).sort(), runs: bytes() };
  assert.equal(withOpenLock(h, () => 42), 42);
  assert.throws(() => withOpenLock(h, () => { throw new Error("inside"); }), /inside/);
  assert.deepEqual(readdirSync(h).sort(), before.files);
  assert.ok(bytes().equals(before.runs), "the run list is byte-for-byte unchanged");
  assert.equal(withOpenLock(h, () => "free again"), "free again", "released after the failure");
});

test("an empty run list (left when a first ask failed to open) never blocks the next ask; the files end owner-only", () => {
  const h = home();
  writeFileSync(join(h, "runs.db"), "", { mode: 0o644 });
  const out = run(["ask", "--engine", "fake", "q"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "a\n");
  for (const f of ["runs.db", "requests.db", "key"]) assert.equal(statSync(join(h, f)).mode & 0o777, 0o600, f);
  assert.equal(runKeys(h).length, 1);
});

test("the open lock itself waits for a holder instead of failing", async () => {
  const { withOpenLock } = await import("../src/status/runs.ts");
  const h = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  const { spawn } = await import("node:child_process");
  const holder = spawn(process.execPath, ["-e",
    `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(join(h, "runs.db"))});` +
    `d.exec("BEGIN IMMEDIATE");console.log("holding");setTimeout(()=>{d.exec("ROLLBACK");d.close();},1500);`], { stdio: ["ignore", "pipe", "ignore"] });
  const holderGone = new Promise((resolve) => holder.on("close", resolve));
  let holderOut = "";
  holder.stdout.on("data", (d) => { holderOut += d; });
  for (let i = 0; i < 500 && !holderOut.includes("holding"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(holderOut.includes("holding"), "the lock holder started");
  const t0 = Date.now();
  assert.equal(withOpenLock(h, () => "got it"), "got it");
  assert.ok(Date.now() - t0 >= 1000, `it waited (${Date.now() - t0} ms)`);
  await holderGone;
});

test("the open lock is waited for: a run that holds it briefly delays an ask, never fails it", async () => {
  const h = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  const { spawn } = await import("node:child_process");
  const holder = spawn(process.execPath, ["-e",
    `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(join(h, "runs.db"))});` +
    `d.exec("BEGIN IMMEDIATE");console.log("holding");` +
    `setTimeout(()=>{d.exec("ROLLBACK");d.close();console.log("released "+Date.now());},2500);`], { stdio: ["ignore", "pipe", "ignore"] });
  let holderOut = "";
  holder.stdout.on("data", (d) => { holderOut += d; });
  const holderGone = new Promise((resolve) => holder.on("close", resolve));
  for (let i = 0; i < 500 && !holderOut.includes("holding"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(holderOut.includes("holding"), "the lock holder started");
  const t0 = Date.now();
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "fake", "second"],
      { env: { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "b" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const finished = Date.now();
  await holderGone;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, "b\n");
  const released = Number(/released (\d+)/.exec(holderOut)[1]);
  assert.ok(t0 < released - 1500, "the ask started well before the lock was released");
  assert.ok(finished >= released, "and could only finish after it: it waited");
});

test("status: a run list the lock created before any run is 'no runs yet'; an empty log file is never initialised", () => {
  const h = home();
  writeFileSync(join(h, "runs.db"), "");                   // what the lock leaves when the first ask fails to open
  const none = run(["status", "--fleet-file", FLEET], { HUNTAWAY_HOME: h });
  assert.match(none.stdout, /No local runs yet/);
  const used = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: used, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  for (const f of readdirSync(used)) if (f.startsWith("requests.db")) rmSync(join(used, f));
  writeFileSync(join(used, "requests.db"), "");
  const out = run(["status", "--json", "--fleet-file", FLEET], { HUNTAWAY_HOME: used });
  assert.equal(out.status, 1);
  assert.equal(statSync(join(used, "requests.db")).size, 0, "status did not initialise a log");
});

test("a damaged install key is refused with how to recover", () => {
  const h = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  writeFileSync(join(h, "key"), "not a key");
  const out = run(["ask", "--engine", "fake", "second"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "b" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /install key is damaged\. Delete the file named "key"/);
});

test("the fake engine needs its test switch; without it --engine fake is a usage error and nothing is recorded", () => {
  const h = home();
  const env = { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" };
  delete env.HUNTAWAY_ENABLE_FAKE_ENGINE;
  const out = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "fake", "q"], { encoding: "utf8", env });
  assert.equal(out.status, 2);
  assert.deepEqual(readdirSync(h), []);
});

test("a relative HUNTAWAY_HOME is refused before anything is recorded", () => {
  const out = run(["ask", "--engine", "fake", "hi"], { HUNTAWAY_HOME: "relative/home" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /absolute/);
});

test("a pipe refusal (tool error) is failed with the pipe's plain reason; a path-like reason is dropped", () => {
  for (const [mode, want, forbid] of [["submit-error", /no model "sonnet"; choose one of opus, fable/, null],
    ["submit-error-path", /refused the request/, "/home/"], ["submit-error-mac-path", /refused the request/, "/" + "Users/"]]) {
    const h = home();
    const out = run(["ask", "--engine", "pipe", "--model", "sonnet", "hi"], {
      HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: mode });
    assert.equal(out.status, 1);
    assert.match(out.stderr, want);
    if (forbid) assert.ok(!out.stderr.includes(forbid));
    const { request, journal } = onlyRequest(h);
    assert.equal(request.state, "failed");
    assert.deepEqual(journal, ["received", "queued", "submitting", "failed"]);
  }
});

function pipeRun(mode, extraArgs = [], extraEnv = {}) {
  const h = home();
  const calls = join(h, "calls.log");
  const out = run(["ask", "--engine", "pipe", ...extraArgs, "hi"], {
    HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: mode,
    FAKE_PIPE_LOG: calls, ...extraEnv });
  const lines = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [];
  return { out, h, called: lines.filter((c) => c !== "pong"), ponged: lines.includes("pong"), ...onlyRequest(h) };
}

test("a readable confirmation with no request id is uncertain (the pipe may have queued it)", () => {
  const r = pipeRun("submit-noid");
  assert.equal(r.out.status, 1);
  assert.equal(r.request.state, "uncertain");
  assert.deepEqual(r.called, ["pipe_submit"]);
});

test("the pipe failing to start is a plain failure: nothing was sent", () => {
  const r = pipeRun("init-error");
  assert.equal(r.request.state, "failed");
  assert.deepEqual(r.called, []);
  const h = home();
  const out = run(["ask", "--engine", "pipe", "hi"], { HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: "[]" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no pipe command/);
  assert.equal(onlyRequest(h).request.state, "failed");
});

test("the pipe dying mid-wait leaves the run uncertain; submit was sent exactly once in every failure mode", () => {
  const r = pipeRun("die-on-wait");
  assert.equal(r.request.state, "uncertain");
  assert.deepEqual(r.called, ["pipe_submit", "pipe_wait"]);
  assert.match(r.out.stderr, /the connection to the pipe was lost/, "a dead pipe is not reported as slow");
  for (const mode of ["fail", "submit-noid", "submit-error"]) {
    assert.equal(pipeRun(mode).called.filter((c) => c === "pipe_submit").length, 1, mode);
  }
});

async function signalMidWait(signal, expectCode) {
  const h = home();
  const calls = join(h, "calls.log");
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "pipe", "--timeout", "60", "hi"], {
    env: { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: "hang", FAKE_PIPE_LOG: calls },
    stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  for (let i = 0; i < 200 && !(existsSync(calls) && readFileSync(calls, "utf8").includes("pipe_wait")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  p.kill(signal);
  const code = await new Promise((resolve) => p.on("close", resolve));
  assert.equal(code, expectCode, signal);
  assert.match(err, /may have run/);
  assert.equal(onlyRequest(h).request.state, "uncertain", signal);
}

test("Ctrl-C, SIGTERM and a closed terminal (SIGHUP) mid-wait all settle the run as uncertain", async () => {
  await signalMidWait("SIGINT", 130);
  await signalMidWait("SIGTERM", 143);
  await signalMidWait("SIGHUP", 129);
});

test("a run left in progress by a crashed ask shows as uncertain, and the next ask records it", async () => {
  const h = home();
  const out = run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" });
  assert.equal(out.status, 0);
  // Fake a crash: put a run into "dispatched" owned by a process that has exited.
  const { spawnSync: sp } = await import("node:child_process");
  const dead = sp(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  const deadPid = Number(dead.stdout.trim());
  const log = new RequestLog(join(h, "requests.db"));
  let key;
  try {
    let r = log.record({ team: "local", channel: "cli", ts: "1.000001", agent: "huntaway", thread: "1.000001", contentHash: "a".repeat(64) }).request;
    for (const to of ["queued", "submitting", "dispatched"]) r = log.transition(r.key, r.version, to);
    key = r.key;
  } finally { log.close(); }
  const db = new DatabaseSync(join(h, "runs.db"));
  try { db.prepare("INSERT INTO runs (key, code, since, last, pid) VALUES (?, 'running', ?, ?, ?)").run(key, "2026-09-30T03:00:00.000Z", "2026-09-30T03:00:00.000Z", deadPid); }
  finally { db.close(); }
  const snap = JSON.parse(run(["status", "--json", "--fleet-file", FLEET], { HUNTAWAY_HOME: h }).stdout);
  assert.deepEqual(snap.runs.map((r) => r.code).sort(), ["done", "uncertain"], "status never shows a dead run as running");
  assert.equal(run(["ask", "--engine", "fake", "second"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "b" }).status, 0);
  const again = new RequestLog(join(h, "requests.db"));
  try { assert.equal(again.get(key).state, "uncertain", "the next ask recorded it"); } finally { again.close(); }
});

test("everything after -- is the question, even when it starts with a dash", () => {
  const h = home();
  const out = run(["ask", "--engine", "fake", "--", "-5", "C?", "really"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "ok" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(run(["ask", "--engine", "fake", "--"], { HUNTAWAY_HOME: home() }).status, 2);
});

test("answers on a terminal lose escape, control and direction-override characters", () => {
  const nasty = "ok\x1b[31mred\x1b[0m\x1b]0;title\x07 \u202eevil\u202c\x07\tend\n";
  assert.equal(forTerminal(nasty, true), "okred evil\tend\n");
  assert.equal(forTerminal(nasty, false), nasty, "untouched when piped");
});

test("pipe outcomes: internal error on submit, interrupted, unknown state and a wait error are uncertain; cancelled and failed are failed", () => {
  const cases = [["submit-internal", "uncertain", ["received", "queued", "submitting", "uncertain"]],
    ["wait-interrupted", "uncertain", ["received", "queued", "submitting", "dispatched", "uncertain"]],
    ["wait-weird", "uncertain", ["received", "queued", "submitting", "dispatched", "uncertain"]],
    ["wait-iserror", "uncertain", ["received", "queued", "submitting", "dispatched", "uncertain"]],
    ["wait-cancelled", "failed", ["received", "queued", "submitting", "dispatched", "failed"]],
    ["fail", "failed", ["received", "queued", "submitting", "dispatched", "failed"]]];
  for (const [mode, state, journal] of cases) {
    const r = pipeRun(mode);
    assert.equal(r.request.state, state, mode);
    assert.deepEqual(r.journal, journal, mode);
    assert.equal(r.out.status, 1, mode);
  }
});

test("no question or answer text on disk with the pipe engine either; the fingerprint is keyed; files are owner-only", () => {
  const h = home();
  const out = run(["ask", "--engine", "pipe", SECRET_QUESTION], {
    HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]) });
  assert.equal(out.status, 0, out.stderr);
  for (const f of readdirSync(h)) {
    const bytes = readFileSync(join(h, f));
    assert.ok(!bytes.includes(Buffer.from("zebra-quokka-7731")), f);
    assert.ok(!bytes.includes(Buffer.from("pong from the pipe")), f);
  }
  const plain = createHash("sha256").update(SECRET_QUESTION).digest("hex");
  assert.notEqual(onlyRequest(h).request.contentHash, plain, "not a plain, guessable SHA-256");
  for (const f of readdirSync(h)) assert.equal(statSync(join(h, f)).mode & 0o077, 0, `${f} is owner-only`);
});


test("the pipe dying while the submit is pending is uncertain; gone before it was written is failed", () => {
  const died = pipeRun("die-on-submit");
  assert.equal(died.request.state, "uncertain");
  assert.deepEqual(died.journal, ["received", "queued", "submitting", "uncertain"]);
  assert.deepEqual(died.called, ["pipe_submit"]);
  assert.match(died.out.stderr, /may have run/);
  const gone = pipeRun("init-exit");
  assert.equal(gone.request.state, "failed");
  assert.deepEqual(gone.journal, ["received", "queued", "submitting", "failed"]);
  assert.deepEqual(gone.called, []);
});

test("Ctrl-C before anything was sent settles the run as failed (exit 130)", async () => {
  const h = home();
  const ready = join(h, "ready");
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "pipe", "hi"], {
    env: { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: "init-hang", FAKE_PIPE_READY: ready },
    stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (d) => { err += d; });
  // The fake pipe writes this file when initialize arrives: by then the ask's signal handler is certainly installed.
  for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(ready), "the pipe was reached");
  p.kill("SIGINT");
  const code = await new Promise((resolve) => p.on("close", resolve));
  assert.equal(code, 130);
  assert.match(err, /before anything was sent/);
  assert.equal(onlyRequest(h).request.state, "failed");
});

test("the client answers the pipe's ping, the pipe request id is printed on failure, and bad --timeout values are usage errors", () => {
  const ok = pipeRun("ok");
  assert.ok(ok.ponged, "answered the ping");
  const failed = pipeRun("fail");
  assert.match(failed.out.stderr, /pipe request req-0001/);
  for (const v of ["0", "-1", "abc", "99999999"]) {
    assert.equal(run(["ask", "--engine", "fake", "--timeout", v, "hi"], { HUNTAWAY_HOME: home() }).status, 2, v);
  }
  assert.equal(run(["ask", "--engine", "fake", "--timeout"], { HUNTAWAY_HOME: home() }).status, 2);
});

test("status is read-only: a dead sent run shows as uncertain, stays dispatched in the log, and status leaves no files", async () => {
  const h = home();
  run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" });
  const log = new RequestLog(join(h, "requests.db"));
  let key;
  try {
    let r = log.record({ team: "local", channel: "cli", ts: "2.000001", agent: "huntaway", thread: "2.000001", contentHash: "b".repeat(64) }).request;
    for (const to of ["queued", "submitting", "dispatched"]) r = log.transition(r.key, r.version, to);
    key = r.key;
  } finally { log.close(); }
  const db = new DatabaseSync(join(h, "runs.db"));
  try { db.prepare("INSERT INTO runs (key, code, since, last, pid) VALUES (?, 'running', ?, ?, ?)").run(key, "2026-09-30T03:00:00.000Z", "2026-09-30T03:00:00.000Z", 2147483646); }
  finally { db.close(); }
  const before = readdirSync(h).sort();
  const out = run(["status", "--json", "--fleet-file", FLEET], { HUNTAWAY_HOME: h });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).runs.map((r) => r.code).sort(), ["done", "uncertain"]);
  assert.deepEqual(readdirSync(h).sort(), before, "status left no new files");
  const check2 = new RequestLog(join(h, "requests.db"));
  try { assert.equal(check2.get(key).state, "dispatched", "status did not write"); } finally { check2.close(); }
});

test("status never creates a request log: runs listed with the log gone are unavailable", () => {
  const h = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  for (const f of readdirSync(h)) if (f.startsWith("requests.db")) rmSync(join(h, f));
  const out = run(["status", "--json", "--fleet-file", FLEET], { HUNTAWAY_HOME: h });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /can't be read right now/);
  assert.ok(!existsSync(join(h, "requests.db")), "no new log");
});

test("a wait reply about a different request, or naming none, is uncertain, never printed", () => {
  for (const mode of ["wait-other-id", "wait-noid"]) {
    const h = home();
    const out = run(["ask", "--engine", "pipe", "hi"], { HUNTAWAY_HOME: h,
      HUNTAWAY_PIPE_CMD: JSON.stringify([process.execPath, FAKE_PIPE]), FAKE_PIPE_MODE: mode });
    assert.equal(out.status, 1, mode);
    assert.equal(out.stdout, "", mode);
    assert.match(out.stderr, mode === "wait-noid" ? /did not name this request/ : /a different request/);
    assert.equal(onlyRequest(h).request.state, "uncertain");
  }
});

test("dead runs that were never sent read declined or cancelled, the same in status and in the log; stale rows catch up", () => {
  const h = home();
  run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" });
  const log = new RequestLog(join(h, "requests.db"));
  const keys = {};
  try {
    const rec = (ts, states) => {
      let r = log.record({ team: "local", channel: "cli", ts, agent: "huntaway", thread: ts, contentHash: "c".repeat(64) }).request;
      for (const to of states) r = log.transition(r.key, r.version, to);
      return r.key;
    };
    keys.received = rec("3.000001", []);
    keys.queued = rec("3.000002", ["queued"]);
    keys.ended = rec("3.000003", ["queued", "submitting", "failed"]);   // the log ended it; the run list never heard
  } finally { log.close(); }
  const db = new DatabaseSync(join(h, "runs.db"));
  try {
    const ins = db.prepare("INSERT INTO runs (key, code, since, last, pid) VALUES (?, ?, ?, ?, ?)");
    ins.run(keys.received, "waiting_local_host", "2026-09-30T03:00:01.000Z", "2026-09-30T03:00:01.000Z", 2147483646);
    ins.run(keys.queued, "waiting_local_host", "2026-09-30T03:00:02.000Z", "2026-09-30T03:00:02.000Z", 2147483646);
    ins.run(keys.ended, "running", "2026-09-30T03:00:03.000Z", "2026-09-30T03:00:03.000Z", 2147483646);
  } finally { db.close(); }
  const before = readFileSync(join(h, "runs.db"));
  const snap = JSON.parse(run(["status", "--json", "--fleet-file", FLEET], { HUNTAWAY_HOME: h }).stdout);
  assert.deepEqual(snap.runs.map((r) => r.code).sort(), ["cancelled", "declined", "done", "failed"]);
  assert.ok(readFileSync(join(h, "runs.db")).equals(before), "status never writes the run list");
  assert.equal(run(["ask", "--engine", "fake", "second"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "b" }).status, 0);
  const after = new RequestLog(join(h, "requests.db"));
  try {
    assert.equal(after.get(keys.received).state, "refused");
    assert.equal(after.get(keys.queued).state, "cancelled");
  } finally { after.close(); }
  const rows = new DatabaseSync(join(h, "runs.db"));
  try {
    const code = rows.prepare("SELECT code FROM runs WHERE key = ?").get(keys.ended).code;
    assert.equal(code, "failed", "the run list caught up with the log");
  } finally { rows.close(); }
});

test("status --json fails plainly when the local runs can't be read, instead of reporting none", () => {
  const h = home();
  run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" });
  writeFileSync(join(h, "requests.db-journal"), "x");      // the log refuses to open: it needs recovery
  const out = run(["status", "--json", "--fleet-file", FLEET], { HUNTAWAY_HOME: h });
  assert.equal(out.status, 1);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /can't be read right now/);
});

test("the fingerprint is stable within an install and differs between installs", () => {
  const fp = (h) => { run(["ask", "--engine", "fake", SECRET_QUESTION], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }); return onlyRequest(h).request.contentHash; };
  const h1 = home(), h2 = home();
  const a = fp(h1), b = fp(h2);
  assert.notEqual(a, b);
  const log = new RequestLog(join(h1, "requests.db"));
  try {
    run(["ask", "--engine", "fake", SECRET_QUESTION], { HUNTAWAY_HOME: h1, HUNTAWAY_FAKE_ANSWER: "a" });
    const keys = runKeys(h1);
    assert.equal(new Set(keys.map((k) => log.get(k).contentHash)).size, 1, "same install, same question, same fingerprint");
  } finally { log.close(); }
});

test("a HUNTAWAY_HOME that doesn't exist yet is created owner-only; a relative one creates nothing", () => {
  const parent = home();
  const h = join(parent, "new", "home");
  assert.equal(run(["ask", "--engine", "fake", "hi"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  assert.equal(statSync(h).mode & 0o077, 0);
  const cwd = home();
  spawnSync(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "fake", "hi"], { cwd, env: { ...process.env, HUNTAWAY_HOME: "relative/home" } });
  assert.ok(!existsSync(join(cwd, "relative")));
});

test("terminal sanitising also removes carriage returns, 8-bit CSI and bidi isolates", () => {
  assert.equal(forTerminal("a\rb\x9b31mc\u2066d\u2069e", true), "ab31mcde");
});

test("the Huntaway folder must be the owner's and private: a link or a group-writable folder is refused, loose files are tightened", () => {
  const base = home();
  const real = join(base, "real");
  mkdirSync(real);
  const link = join(base, "link");
  symlinkSync(real, link);
  const viaLink = run(["ask", "--engine", "fake", "q"], { HUNTAWAY_HOME: link, HUNTAWAY_FAKE_ANSWER: "a" });
  assert.equal(viaLink.status, 1);
  assert.match(viaLink.stderr, /must be a real folder of yours \(not a link\)/);
  assert.deepEqual(readdirSync(real), [], "nothing written through the link");
  // Writable by anyone, or only by the group (on macOS every user's group is "staff"): refused, nothing written.
  for (const mode of [0o777, 0o775, 0o770]) {
    const open = join(base, `open-${mode.toString(8)}`);
    mkdirSync(open);
    chmodSync(open, mode);
    const loose = run(["ask", "--engine", "fake", "q"], { HUNTAWAY_HOME: open, HUNTAWAY_FAKE_ANSWER: "a" });
    assert.equal(loose.status, 1, mode.toString(8));
    assert.match(loose.stderr, /no one else, not even your group, can write to/);
    assert.deepEqual(readdirSync(open), [], mode.toString(8));
  }
  // An older install's loose files are made owner-only before they are opened.
  const old = home();
  assert.equal(run(["ask", "--engine", "fake", "first"], { HUNTAWAY_HOME: old, HUNTAWAY_FAKE_ANSWER: "a" }).status, 0);
  for (const f of ["requests.db", "runs.db", "key"]) chmodSync(join(old, f), 0o644);
  chmodSync(old, 0o755);
  assert.equal(run(["ask", "--engine", "fake", "second"], { HUNTAWAY_HOME: old, HUNTAWAY_FAKE_ANSWER: "b" }).status, 0);
  for (const f of ["requests.db", "runs.db", "key"]) assert.equal(statSync(join(old, f)).mode & 0o777, 0o600, f);
  assert.equal(statSync(old).mode & 0o777, 0o700);
});

test("-h after -- is part of a question, not a request for help", () => {
  const h = home();
  const out = run(["ask", "--engine", "fake", "--", "what does -h do"], { HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "an answer" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "an answer\n");
});

test("the folder check: a real folder of the owner's that nobody else can write to (stand-in user ids)", async () => {
  const { safeFolder } = await import("../src/ask/ask.ts");
  const dir = (uid, mode, isDir = true) => ({ isDirectory: () => isDir, uid, mode: (isDir ? 0o040000 : 0o120000) | mode });
  assert.equal(safeFolder(dir(501, 0o700), 501), true);
  assert.equal(safeFolder(dir(501, 0o755), 501), true, "readable by others is fine: it is made 0700 next");
  assert.equal(safeFolder(dir(502, 0o700), 501), false, "another user's folder");
  assert.equal(safeFolder(dir(0, 0o700), 501), false, "root's folder");
  assert.equal(safeFolder(dir(501, 0o770), 501), false, "writable by its group");
  assert.equal(safeFolder(dir(501, 0o702), 501), false, "writable by anyone");
  assert.equal(safeFolder(dir(501, 0o777, false), 501), false, "a link, not a folder");
  assert.equal(safeFolder(dir(502, 0o700), null), true, "a platform without user ids: ownership can't be checked");
});

test("a reused pid owned by someone else counts as gone, not alive", async () => {
  const { processAlive } = await import("../src/status/runs.ts");
  assert.equal(processAlive(process.pid), true);
  // All of these count as gone. Node refuses a pid that isn't a signed 32-bit integer rather than cutting it down
  // (which could land on a live pid); 0 and negatives it would accept (signalling a whole process group), so
  // processAlive refuses those itself: keep that guard.
  for (const bad of [0, -1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 31, 2 ** 32 + process.pid, 2 ** 53, Number.MAX_SAFE_INTEGER]) {
    assert.equal(processAlive(bad), false, String(bad));
  }
  // pid 1 is the system's own (launchd) on macOS: another owner, so gone for Huntaway's purposes.
  if (process.platform === "darwin" && process.getuid && process.getuid() !== 0) assert.equal(processAlive(1), false);
});

test("a reader that goes away never cuts an ask short: the run still settles", async () => {
  const h = home();
  const { spawn } = await import("node:child_process");
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", CLI, "ask", "--engine", "fake", "q"],
      { env: { ...process.env, HUNTAWAY_HOME: h, HUNTAWAY_FAKE_ANSWER: "a".repeat(1000) }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.destroy();                                    // nobody reads the answer
    p.stderr.destroy();                                    // nor any message
    p.on("close", resolve);
  });
  assert.equal(onlyRequest(h).request.state, "answered", `settled (exit ${code})`);
});

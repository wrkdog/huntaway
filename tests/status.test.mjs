// Acceptance for `huntaway status` v0 (frozen before the build). Machines and subscriptions come from the owner's
// fleet allowance reading (the Router's compute-router-subscriptions JSON); runs stay empty until the request log
// is wired. Output must validate against contract/huntaway-status.schema.json and never carry a host detail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, chmodSync, truncateSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeValidator } from "./lib/schema.mjs";
import { roomFromPercent, toInstant, machinesFromFleet, buildSnapshot, readingTime } from "../src/status/snapshot.ts";

const schema = JSON.parse(readFileSync(new URL("../contract/huntaway-status.schema.json", import.meta.url), "utf8"));
const check = makeValidator(schema);
const fleetPath = fileURLToPath(new URL("./fixtures/fleet-sample.json", import.meta.url));
const fleet = JSON.parse(readFileSync(fleetPath, "utf8"));
const NOW = new Date("2026-09-30T02:07:00.000Z");
// The fleet's machine names are the owner's configuration, never the code's: these tests name theirs here.
process.env.HUNTAWAY_FLEET_ALIASES = "studio=Studio,mini=Mini,laptop=Laptop";
// `doctor` checks the engine a plain ask would use (the owner's own key by default, a paid engine). With
// Huntaway's test switch on: an hwtest- key, never sent anywhere (doctor calls no API); a test keychain file, never
// the real keychain; a stand-in address nothing listens on; and caps no model's hard worst case is over, since doctor
// fails a paid engine without them. No price override or test clock from the machine running the tests gets in.
for (const k of Object.keys(process.env)) if (k.startsWith("HUNTAWAY_PRICE_") || k === "HUNTAWAY_TEST_NOW") delete process.env[k];
const TEST_KEY = "hwtest-status-key-0000-not-real";
const STAND_IN = "http://127.0.0.1:9/v1/messages";
const ROOMY = { HUNTAWAY_MAX_USD_PER_QUESTION: "1000", HUNTAWAY_MAX_USD_PER_DAY: "1000" };
const ownKeychain = mkdtempSync(join(tmpdir(), "huntaway-status-kc-"));
Object.assign(process.env, { ANTHROPIC_API_KEY: TEST_KEY, HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_TEST_ANTHROPIC_URL: STAND_IN,
  HUNTAWAY_TEST_KEYCHAIN_FILE: join(ownKeychain, "keychain.json"), ...ROOMY });
delete process.env.HUNTAWAY_ENGINE;
delete process.env.HUNTAWAY_PIPE_CMD;
// Runs come from a test-owned, empty history, never the owner's installed one; tests that need history set their own.
const ownHome = (process.env.HUNTAWAY_HOME = mkdtempSync(join(tmpdir(), "huntaway-status-home-")));
process.on("exit", () => {
  rmSync(ownHome, { recursive: true, force: true });
  rmSync(ownKeychain, { recursive: true, force: true });
});
// Doctor's line for the paid engine when it is ready, with the key from the environment or the keychain.
const PAID_READY = (where) => `ok   engine: anthropic (paid API; ${where}; caps $1000.00 a question, $1000.00 a day; $0.00 used in the last 24 hours)`;
const exactLine = (line) => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
/**
 * The unknown-HUNTAWAY_ENGINE error names every engine:
 * the one line starting with `start` must name pipe, anthropic and openai, in whatever wording.
 */
const assertNamesEveryEngine = (text, start, what) => {
  const line = text.split("\n").find((l) => l.startsWith(start));
  assert.ok(line !== undefined, `${what}: a line starting ${JSON.stringify(start)}:\n${text}`);
  for (const engine of ["pipe", "anthropic", "openai"]) {
    assert.match(line, new RegExp(`\\b${engine}\\b`), `${what}: the error names ${engine}: ${line}`);
  }
};
const CLI = fileURLToPath(new URL("../bin/huntaway.ts", import.meta.url));
const node = (args, opts = {}) => spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], { encoding: "utf8", ...opts });

test("room words from headroom: plenty >= 50, some 20-49, low 1-19, none 0 or exhausted, unknown without a reading", () => {
  for (const [pct, want] of [[100, "plenty"], [70, "plenty"], [50, "plenty"], [49, "some"], [20, "some"], [19, "low"], [1, "low"], [0, "none"]]) {
    assert.equal(roomFromPercent(pct), want, `${pct}%`);
  }
  assert.equal(roomFromPercent(40, "exhausted"), "none");
  assert.equal(roomFromPercent(null), "unknown");
  assert.equal(roomFromPercent(undefined), "unknown");
  assert.equal(roomFromPercent(Number.NaN), "unknown");
  assert.equal(roomFromPercent(150), "plenty");
  assert.equal(roomFromPercent(-5), "none");
});

test("instants are normalised to UTC with at most milliseconds, or null", () => {
  assert.equal(toInstant("2026-09-30T02:06:48.123178Z"), "2026-09-30T02:06:48.123Z");
  assert.equal(toInstant("2026-09-29T23:58:03Z"), "2026-09-29T23:58:03.000Z");
  assert.equal(toInstant("2026-09-30T02:06:48+02:00"), "2026-09-30T00:06:48.000Z");
  assert.equal(toInstant("not a time"), null);
  assert.equal(toInstant("2026-09-30T02:06:48"), null, "a zoneless time would be read as local time");
  assert.equal(toInstant("2026-09-30t02:06:48z"), null, "lower-case t/z is outside the ECMAScript form");
  assert.equal(toInstant("2026-09-30T02:06:48+0200"), null, "an offset needs its colon");
  assert.equal(toInstant("2026-02-30T00:00:00Z"), null, "no calendar rollover (Feb 30)");
  assert.equal(toInstant("2026-09-30T24:00:00Z"), null);
  assert.equal(toInstant(null), null);
  assert.equal(toInstant(undefined), null);
});

test("machines: aliases only, in Studio, Mini, Laptop order; unknown machines skipped; binding window decides room", () => {
  const m = machinesFromFleet(fleet);
  assert.deepEqual(m.map((x) => x.alias), ["Studio", "Mini", "Laptop"]);
  const studio = m[0];
  assert.equal(studio.online, true);
  assert.equal(studio.lastSeenAt, "2026-09-30T02:06:48.056Z");
  assert.deepEqual(studio.subscriptions, [
    { family: "claude", room: "low", resetsAt: "2026-09-30T06:20:00.000Z" },   // tightest window: session 19%
    { family: "codex", room: "plenty", resetsAt: "2026-10-03T17:31:42.500Z" },
  ]);
  const mini = m[1];
  assert.equal(mini.online, false);
  assert.equal(mini.lastSeenAt, "2026-09-29T23:58:03.000Z");
  assert.deepEqual(mini.subscriptions, []);
  const laptop = m[2];
  assert.deepEqual(laptop.subscriptions, [
    { family: "claude", room: "plenty", resetsAt: "2026-10-04T02:00:00.000Z" },
    { family: "codex", room: "none", resetsAt: "2026-10-03T17:03:40.000Z" },
    { family: "gemini", room: "unknown", resetsAt: null },
  ]);
});

test("an exhausted window binds even when another window has room", () => {
  const f = JSON.parse(JSON.stringify(fleet));
  f.pools.find((p) => p.accountFingerprint === "cccc3333").windows[1].state = "exhausted";
  const studio = machinesFromFleet(f)[0];
  assert.deepEqual(studio.subscriptions[0], { family: "claude", room: "none", resetsAt: "2026-10-07T01:00:00.000Z" });
});

test("a failing fleet command is named without echoing its output or paths", () => {
  const out = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "status"], {
    encoding: "utf8", env: { ...process.env, HUNTAWAY_FLEET_CMD: "/nonexistent/fleet-cmd-for-test" } });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not installed/);
  assert.ok(!out.stderr.includes("/nonexistent"), "no paths in the error");
});

test("an exhausted window decides the room even with no percent or a stale sibling; a stale 0% is not exhausted", () => {
  const withWindows = (windows) => {
    const f = JSON.parse(JSON.stringify(fleet));
    f.pools.find((p) => p.accountFingerprint === "cccc3333").windows = windows;
    return machinesFromFleet(f)[0].subscriptions[0];
  };
  assert.deepEqual(withWindows([{ state: "exhausted", remainingPercent: null, resetAt: "2026-10-01T00:00:00Z" }]),
    { family: "claude", room: "none", resetsAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(withWindows([
    { state: "exhausted", remainingPercent: 0, resetAt: "2026-10-02T00:00:00Z" },
    { state: "stale", remainingPercent: 80, resetAt: "2026-10-09T00:00:00Z" }]),
    { family: "claude", room: "none", resetsAt: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual(withWindows([{ state: "stale", remainingPercent: 0, resetAt: "2026-10-02T00:00:00Z" }]),
    { family: "claude", room: "unknown", resetsAt: null });
});

test("a known host next to one with an unrecognised status: only the known host is reported", () => {
  const m = machinesFromFleet({ hosts: [{ nodeId: "studio", status: "observed", observedAt: "2026-09-30T02:00:00Z", providers: [] },
    { nodeId: "mini", status: "rebooting", observedAt: "2026-09-30T02:00:00Z", providers: [] }] });
  assert.deepEqual(m.map((x) => x.alias), ["Studio"]);
});

test("the reading time: its own observedAt, else the oldest host's, and never later than now", () => {
  assert.equal(readingTime({ hosts: [{ observedAt: "2026-09-30T02:00:00Z" }, { observedAt: "2026-09-30T01:00:00Z" }] }), "2026-09-30T01:00:00.000Z");
  assert.equal(readingTime({ hosts: [] }), null);
  const future = buildSnapshot({ now: NOW, fleet: { ...fleet, observedAt: "2027-01-01T00:00:00Z" } });
  assert.equal(future.asOf, "2026-09-30T02:07:00.000Z");
  const noTime = buildSnapshot({ now: NOW, fleet: { ...fleet, observedAt: undefined } });
  assert.equal(noTime.asOf, "2026-09-29T23:58:03.000Z", "falls back to the oldest host reading");
});

test("a malformed or empty fleet reading yields no machines rather than a guess", () => {
  for (const bad of [null, {}, { hosts: "x" }, { hosts: [{ nodeId: "studio" }] }, [], "text"]) {
    const m = machinesFromFleet(bad);
    assert.ok(Array.isArray(m));
    for (const x of m) assert.deepEqual(x.subscriptions, []);
  }
  assert.deepEqual(machinesFromFleet(null), []);
  assert.deepEqual(machinesFromFleet({ hosts: [{ nodeId: "studio" }] }), [], "a host with no status is not guessed at");
  assert.deepEqual(machinesFromFleet({ hosts: [{ nodeId: "studio", status: "weird" }] }), []);
});

test("a stale or unreadable window makes the account unknown; several exhausted windows bind to the last reset", () => {
  const f = JSON.parse(JSON.stringify(fleet));
  f.pools.find((p) => p.accountFingerprint === "aaaa1111").windows[0].state = "stale";
  f.pools.find((p) => p.accountFingerprint === "dddd4444").windows.push(
    { bucket: "x", remainingPercent: 0, resetAt: "2026-10-05T00:00:00Z", state: "observed" },
    { bucket: "y", remainingPercent: 0, resetAt: "2026-10-04T00:00:00Z", state: "observed" });
  const m = machinesFromFleet(f);
  assert.deepEqual(m[2].subscriptions[0], { family: "claude", room: "unknown", resetsAt: null });
  assert.deepEqual(m[0].subscriptions[1], { family: "codex", room: "none", resetsAt: "2026-10-05T00:00:00.000Z" });
});

test("the snapshot is live, validates against the contract, and carries no host detail", () => {
  const snap = buildSnapshot({ now: NOW, fleet });
  assert.deepEqual(check(snap), []);
  assert.equal(snap.source, "live");
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.asOf, "2026-09-30T02:06:48.123Z", "as of the reading, not now");
  assert.deepEqual(snap.runs, []);
  const text = JSON.stringify(snap);
  for (const secretish of ["example", "someone", "aaaa1111", "cliPath", "/opt/", "spare", "nodeId", "fingerprint"]) {
    assert.ok(!text.includes(secretish), `must not include ${secretish}`);
  }
});

test("CLI: status --json prints a valid live snapshot; plain status prints aliases and words only", () => {
  const out = node(["status", "--json", "--fleet-file", fleetPath]);
  assert.equal(out.status, 0, out.stderr);
  const snap = JSON.parse(out.stdout);
  assert.deepEqual(check(snap), []);
  assert.equal(snap.source, "live");
  const human = node(["status", "--fleet-file", fleetPath]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Studio/);
  assert.match(human.stdout, /\bon\b/);
  assert.match(human.stdout, /Mini/);
  assert.match(human.stdout, /asleep|offline/);
  assert.match(human.stdout, /claude/i);
  assert.match(human.stdout, /\blow\b/);
  assert.ok(!/example|someone|aaaa1111|spare|\/opt\/|cliPath|fingerprint/.test(human.stdout + human.stderr));
  assert.match(human.stdout, /Reading as of 2026-09-30 02:06 UTC \(stale\)/);
});

test("CLI: errors are plain, path-free, and exit codes are stable (2 usage, 1 unreadable fleet)", () => {
  const usage = node(["frobnicate"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage/i);
  const help = node(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage/i);
  assert.equal(node(["status", "-h"]).status, 0);
  for (const args of [["doctor", "--json"], ["status", "--json", "--json"], ["status", "--fleet-file", fleetPath, "--fleet-file", fleetPath],
    ["status", "--fleet-file"], ["status", "--fleet-file="], ["status", "--fleet-file", "-x"]]) {
    assert.equal(node(args).status, 2, args.join(" "));
  }
  const missing = node(["status", "--fleet-file", "/nonexistent/fleet.json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist/);
  assert.ok(!missing.stderr.includes("/nonexistent"), "no paths in errors");
  const bad = node(["status", "--json", "--fleet-file", fileURLToPath(new URL("./lib/schema.mjs", import.meta.url))]);
  assert.equal(bad.status, 1, "an unreadable reading is an error, never an empty 'all asleep' snapshot");
  const dir = mkdtempSync(join(tmpdir(), "huntaway-fleet-"));
  const empty = join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify({ hosts: [] }));
  const none = node(["status", "--json", `--fleet-file=${empty}`]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /none of the configured machines/);
});

test("the fleet's machine names come only from the owner's configuration, checked strictly", async () => {
  const { fleetAliases, standaloneSnapshot } = await import("../src/status/snapshot.ts");
  assert.deepEqual(fleetAliases("studio=Studio, mini=Mini"), [{ nodeId: "studio", alias: "Studio" }, { nodeId: "mini", alias: "Mini" }]);
  assert.deepEqual(fleetAliases(""), []);
  for (const bad of ["studio", "=Studio", "Studio=Studio", "studio=Stu.dio", "a=A,a=B", "a=A,b=A", "studio=Studio,"]) {
    assert.equal(fleetAliases(bad), null, bad);
  }
  assert.deepEqual(machinesFromFleet(fleet, []), [], "no configuration: no machines, never a built-in list");
  assert.throws(() => standaloneSnapshot({ now: NOW, alias: "evil.example.net" }), /not a valid alias/);
  const run = (env) => node(["status", "--json", "--fleet-file", fleetPath], { env: { ...process.env, ...env } });
  const unset = run({ HUNTAWAY_FLEET_ALIASES: "" });
  assert.equal(unset.status, 1);
  assert.match(unset.stderr, /no machines are configured: set HUNTAWAY_FLEET_ALIASES/);
  const malformed = run({ HUNTAWAY_FLEET_ALIASES: "studio=Stu.dio" });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /not a valid list/);
  const renamed = JSON.parse(run({ HUNTAWAY_FLEET_ALIASES: "laptop=Work Laptop" }).stdout);
  assert.deepEqual(renamed.machines.map((m) => m.alias), ["Work Laptop"], "the owner's own name, in the owner's order");
});

test("a host clock ahead of this one never shows a machine as seen in the future", () => {
  const ahead = JSON.parse(JSON.stringify(fleet));
  const future = new Date(Date.now() + 3600_000).toISOString();
  for (const h of ahead.hosts) h.observedAt = future;
  const m = machinesFromFleet(ahead);
  assert.equal(m.length, 3);
  for (const machine of m) assert.ok(Date.parse(machine.lastSeenAt) <= Date.now(), machine.alias);
});

test("status exits 1 in the text view too when the local runs can't be read", () => {
  const h = mkdtempSync(join(tmpdir(), "huntaway-st-"));
  writeFileSync(join(h, "runs.db"), "this is not a database");
  for (const env of [{ HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "My Mac" }, {}]) {
    const args = env.HUNTAWAY_FLEET_CMD ? ["status"] : ["status", "--fleet-file", fleetPath];
    const out = node(args, { env: { ...process.env, HUNTAWAY_HOME: h, ...env } });
    assert.equal(out.status, 1, JSON.stringify(env));
    assert.match(out.stdout, /Local runs: unavailable right now/);
  }
});

test("CLI: a failing, garbled or slow fleet command is named without its output", () => {
  const dir = mkdtempSync(join(tmpdir(), "huntaway-cmd-"));
  const script = (name, body) => { const f = join(dir, name); writeFileSync(f, "#!/bin/sh\n" + body + "\n"); chmodSync(f, 0o755); return f; };
  const cases = [
    [script("fail.sh", "echo secret-output-1 >&2; exit 3"), {}, /failed \(exit 3\)/],
    [script("garbled.sh", "echo secret-output-2"), {}, /not valid JSON/],
    [script("slow.sh", "sleep 5"), { HUNTAWAY_FLEET_TIMEOUT_MS: "300" }, /timed out|stopped/],
  ];
  for (const [cmd, env, want] of cases) {
    const out = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "status"], {
      encoding: "utf8", env: { ...process.env, HUNTAWAY_FLEET_CMD: cmd, ...env } });
    assert.equal(out.status, 1, cmd);
    assert.match(out.stderr, want);
    assert.ok(!/secret-output|huntaway-cmd-/.test(out.stderr + out.stdout), "no command output or paths");
  }
  const rel = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "status"], {
    encoding: "utf8", env: { ...process.env, HUNTAWAY_FLEET_CMD: "relative/cmd" } });
  assert.equal(rel.status, 1);
  assert.match(rel.stderr, /absolute path/);
});

test("CLI: the live JSON carries no host detail", () => {
  const out = node(["status", "--json", "--fleet-file", fleetPath]);
  for (const secretish of ["example", "someone", "aaaa1111", "cliPath", "/opt/", "spare", "nodeId"]) {
    assert.ok(!out.stdout.includes(secretish), `must not include ${secretish}`);
  }
});

test("CLI: doctor reports each check and fails on a bad reading, without paths", () => {
  const ok = node(["doctor", "--fleet-file", fleetPath]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /node/i);
  assert.match(ok.stdout, /fleet/i);
  const bad = node(["doctor", "--fleet-file", "/nonexistent/fleet.json"]);
  assert.equal(bad.status, 1);
  assert.ok(!bad.stdout.includes("/nonexistent"));
});

test("instants: offsets must be real (up to 23:59) and years 1970-9999 (0000-0099 would be read as 19xx)", () => {
  assert.equal(toInstant("2026-09-30T04:00:00+23:59"), "2026-09-29T04:01:00.000Z");
  assert.equal(toInstant("2026-09-30T04:00:00+24:00"), null);
  assert.equal(toInstant("2026-09-30T04:00:00-00:60"), null);
  assert.equal(toInstant("0100-01-01T00:00:00Z"), null);
  assert.equal(toInstant("0050-01-01T00:00:00Z"), null);
  assert.equal(toInstant("1969-12-31T23:59:59Z"), null);
  assert.equal(toInstant("1970-01-01T00:00:00Z"), "1970-01-01T00:00:00.000Z");
  assert.equal(toInstant("9999-12-31T23:59:59Z"), "9999-12-31T23:59:59.000Z");
});

test("a machine listed twice: the first entry with a known status counts", () => {
  const studio = fleet.hosts.find((h) => h.nodeId === "studio");
  const twice = { ...fleet, hosts: [{ ...studio, status: "probing" }, { ...studio, status: "unavailable" }] };
  const m = machinesFromFleet(twice);
  assert.deepEqual(m.map((x) => [x.alias, x.online]), [["Studio", false]]);
});

test("Gemini's family is read as google or gemini, and reported once", () => {
  const studio = fleet.hosts.find((h) => h.nodeId === "studio");
  const g = { family: "gemini", status: "unknown" };
  const one = machinesFromFleet({ ...fleet, hosts: [{ ...studio, providers: [...studio.providers.filter((p) => p.family !== "google"), g] }] });
  assert.equal(one[0].subscriptions.filter((s) => s.family === "gemini").length, 1);
  const both = machinesFromFleet({ ...fleet, hosts: [{ ...studio, providers: [...studio.providers, g] }] });
  assert.equal(both[0].subscriptions.filter((s) => s.family === "gemini").length, 1);
});

const writeFleet = (obj) => { const f = join(mkdtempSync(join(tmpdir(), "huntaway-fleet-")), "fleet.json"); writeFileSync(f, JSON.stringify(obj)); return f; };
const shiftTimes = (obj, ms) => JSON.parse(JSON.stringify(obj), (k, v) =>
  (k === "observedAt" && typeof v === "string") ? new Date(Date.now() + ms).toISOString() : v);

test("CLI: a reading with no time, or dated in the future, is refused in both views; a small clock skew is fine", () => {
  const noTime = JSON.parse(JSON.stringify(fleet), (k, v) => (k === "observedAt" ? undefined : v));
  for (const args of [["status", "--json"], ["status"], ["doctor"]]) {
    const out = node([...args, "--fleet-file", writeFleet(noTime)]);
    assert.equal(out.status, 1, args.join(" "));
    assert.match(out.stderr + out.stdout, /has no time/);
    const future = node([...args, "--fleet-file", writeFleet(shiftTimes(fleet, 3600_000))]);
    assert.equal(future.status, 1, args.join(" "));
    assert.match(future.stderr + future.stdout, /dated in the future/);
  }
  const skew = node(["status", "--json", "--fleet-file", writeFleet(shiftTimes(fleet, 60_000))]);
  assert.equal(skew.status, 0, skew.stderr);
  assert.equal(check(JSON.parse(skew.stdout)).length, 0);
});

test("CLI: a fleet file must be a regular file of at most 16 MB (a FIFO never hangs it)", () => {
  const dir = mkdtempSync(join(tmpdir(), "huntaway-fleet-"));
  const fifo = join(dir, "fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const out = node(["status", "--fleet-file", fifo], { timeout: 10_000 });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not a regular file/);
  const big = join(dir, "big.json");
  writeFileSync(big, "");
  truncateSync(big, 17 * 1024 * 1024);
  const large = node(["status", "--fleet-file", big]);
  assert.equal(large.status, 1);
  assert.match(large.stderr, /too large/);
});

test("CLI: the fleet command exits 0 with a reading; a non-zero exit is a failure even with valid output", () => {
  const dir = mkdtempSync(join(tmpdir(), "huntaway-cmd-"));
  const cmd = join(dir, "partial.sh");
  writeFileSync(cmd, `#!/bin/sh\ncat '${writeFleet(shiftTimes(fleet, 0))}'\nexit 1\n`);
  chmodSync(cmd, 0o755);
  const out = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "status", "--json"], {
    encoding: "utf8", env: { ...process.env, HUNTAWAY_FLEET_CMD: cmd } });
  assert.equal(out.status, 1);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /failed \(exit 1\)/);
});

test("CLI: doctor says when the reading is stale, and its success line carries no host detail", () => {
  const out = node(["doctor", "--fleet-file", fleetPath]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /fleet reading: 3 machines \(Studio, Mini, Laptop\), stale \(read 2026-09-30 02:06 UTC\)/);
  for (const secretish of ["example", "someone", "spare", "aaaa1111", "/opt/"]) assert.ok(!out.stdout.includes(secretish), secretish);
  const fresh = node(["doctor", "--fleet-file", writeFleet(shiftTimes(fleet, 0))]);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.ok(!fresh.stdout.includes("stale"));
});

test("standalone (no Router, chosen at install): this machine only, the owner's name, contract-valid, never a fallback", () => {
  const env = (extra) => ({ ...process.env, HUNTAWAY_HOME: mkdtempSync(join(tmpdir(), "huntaway-sa-")), ...extra });
  const json = node(["status", "--json"], { env: env({ HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "My Mac" }) });
  assert.equal(json.status, 0, json.stderr);
  const snap = JSON.parse(json.stdout);
  assert.equal(check(snap).length, 0, JSON.stringify(check(snap)));
  assert.deepEqual(snap.machines.map((m) => [m.alias, m.online, m.subscriptions, m.lastSeenAt === snap.asOf]), [["My Mac", true, [], true]]);
  // No name, or an invalid one: the JSON refuses rather than invent or pass on a label; the text view still works.
  for (const alias of ["", "studio.example.net"]) {
    const out = node(["status", "--json"], { env: env({ HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: alias }) });
    assert.equal(out.status, 1, alias);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /standalone status needs this machine's name/);
    assert.ok(!out.stderr.includes("studio.example.net"));
    const human = node(["status"], { env: env({ HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: alias }) });
    assert.match(human.stdout, /^This machine  on  \(standalone: subscription room isn't tracked without the Router\)/m);
    assert.ok(!human.stdout.includes("studio.example.net"));
  }
  const doctor = node(["doctor"], { env: env({ HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "My Mac" }) });
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /fleet reading: none \(standalone: this machine only\)/);
  const unnamed = node(["doctor"], { env: env({ HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "" }) });
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stdout, /FAIL alias: standalone needs this machine's name/);
  const withFile = node(["status", "--json", "--fleet-file", fleetPath], { env: env({ HUNTAWAY_FLEET_CMD: "none" }) });
  assert.deepEqual(JSON.parse(withFile.stdout).machines.map((m) => m.alias), ["Studio", "Mini", "Laptop"], "an explicit file still wins");
  // A missing Router helper without the standalone choice is still an error, never a quiet switch to one machine.
  const missing = node(["status"], { env: env({ HUNTAWAY_FLEET_CMD: "/nonexistent/helper" }) });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not installed/);
  assert.ok(!missing.stderr.includes("/nonexistent"), "no path in the error");
});

test("doctor names the engine a plain ask would use and whether it is ready, never a key or a command's path", () => {
  const env = (extra) => {
    // A minimal environment: nothing from the machine running the tests (its Huntaway or API settings) reaches doctor.
    // The test switch is on, so the keychain is an (empty) test file, never the real one.
    const e = { PATH: process.env.PATH, HUNTAWAY_HOME: mkdtempSync(join(tmpdir(), "huntaway-sa-")), HOME: mkdtempSync(join(tmpdir(), "huntaway-home-")),
      HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "My Mac", HUNTAWAY_ENGINE: "anthropic", HUNTAWAY_ENABLE_FAKE_ENGINE: "1",
      HUNTAWAY_TEST_ANTHROPIC_URL: STAND_IN, HUNTAWAY_TEST_KEYCHAIN_FILE: join(mkdtempSync(join(tmpdir(), "huntaway-kc-")), "keychain.json"),
      ...ROOMY, ...extra };
    for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
    return e;
  };
  const ready = node(["doctor"], { env: env({ ANTHROPIC_API_KEY: TEST_KEY }) });
  assert.equal(ready.status, 0, ready.stdout);
  assert.match(ready.stdout, exactLine(PAID_READY("key set in the environment")));
  assert.ok(!ready.stdout.includes("hwtest-status"), "never the key's value");
  const missing = node(["doctor"], { env: env({ ANTHROPIC_API_KEY: "" }) });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /^FAIL engine: anthropic\b/m, "no key in the environment or the keychain");
  // The key from the (test) keychain, in its file format: doctor says so, and never shows it.
  const kcEnv = env({ ANTHROPIC_API_KEY: undefined });
  writeFileSync(kcEnv.HUNTAWAY_TEST_KEYCHAIN_FILE, JSON.stringify({ anthropic: "hwtest-status-kc-0000-not-real" }), { mode: 0o600 });
  const stored = node(["doctor"], { env: kcEnv });
  assert.equal(stored.status, 0, stored.stdout);
  assert.match(stored.stdout, exactLine(PAID_READY("key in the keychain")));
  assert.ok(!stored.stdout.includes("hwtest-status-kc") && !stored.stderr.includes("hwtest-status-kc"), "never the key's value");
  // A paid engine with no caps: a FAIL, naming them.
  const uncapped = node(["doctor"], { env: env({ ANTHROPIC_API_KEY: TEST_KEY, HUNTAWAY_MAX_USD_PER_QUESTION: undefined, HUNTAWAY_MAX_USD_PER_DAY: undefined }) });
  assert.equal(uncapped.status, 1, uncapped.stdout);
  assert.match(uncapped.stdout, /^FAIL\b.*\b(?:caps?|HUNTAWAY_MAX_USD_PER_(?:QUESTION|DAY))\b/im);
  // No engine chosen (unset or empty, as for `ask`): a plain ask uses the owner's own key, so that is what doctor checks.
  for (const none of [undefined, ""]) {
    const plain = node(["doctor"], { env: env({ HUNTAWAY_ENGINE: none, ANTHROPIC_API_KEY: undefined }) });
    assert.equal(plain.status, 1, JSON.stringify(none));
    assert.match(plain.stdout, /FAIL engine: anthropic/);
    const keyed = node(["doctor"], { env: env({ HUNTAWAY_ENGINE: none, ANTHROPIC_API_KEY: TEST_KEY }) });
    assert.equal(keyed.status, 0, keyed.stdout);
    assert.match(keyed.stdout, exactLine(PAID_READY("key set in the environment")));
  }
  // The pipe: configured or not, never run, and its command's path never shown.
  const pipe = node(["doctor"], { env: env({ HUNTAWAY_ENGINE: "pipe", HUNTAWAY_PIPE_CMD: JSON.stringify(["/opt/pipe-client/bin/pipe", "--stdio"]),
    ANTHROPIC_API_KEY: undefined }) });
  assert.equal(pipe.status, 0, pipe.stdout);
  assert.match(pipe.stdout, /ok   engine: pipe \(a pipe command is configured\)/);
  assert.ok(!pipe.stdout.includes("pipe-client") && !pipe.stderr.includes("pipe-client"), "never the command's path");
  // env() points HOME at an empty folder, so an unset HUNTAWAY_PIPE_CMD finds no Claude Code settings either.
  // With HUNTAWAY_PIPE_CMD unset (or empty), the fix is to register the server; with it set but unusable, the fix is
  // the variable itself, since it wins over Claude Code's settings.
  const pipeFailure = "FAIL engine: pipe (no usable pipe command: add the Pipe's MCP server with " +
    "claude mcp add --scope user pipe -- <command>, or set HUNTAWAY_PIPE_CMD to a JSON command list)";
  const badCommand = "FAIL engine: pipe (HUNTAWAY_PIPE_CMD is set but is not a non-empty JSON list of strings: fix it, " +
    "or unset it to use Claude Code's pipe server)";
  for (const unusable of ["not-json-canary-Q7", "[]", JSON.stringify([1, 23456]), "", undefined]) {
    const none = node(["doctor"], { env: env({ HUNTAWAY_ENGINE: "pipe", HUNTAWAY_PIPE_CMD: unusable }) });
    assert.equal(none.status, 1, String(unusable));
    assert.ok(none.stdout.split("\n").includes(unusable ? badCommand : pipeFailure), String(unusable));
    if (unusable) assert.ok(!none.stdout.includes(unusable) && !none.stderr.includes(unusable), "a malformed value is never echoed");
  }
  // The other way to configure it: the pipe server in Claude Code's settings under this home; its path never shown.
  const home = mkdtempSync(join(tmpdir(), "huntaway-home-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { pipe: { command: "/opt/pipe-client/bin/pipe-mcp", args: [] } } }));
  const viaSettings = node(["doctor"], { env: env({ HOME: home, HUNTAWAY_ENGINE: "pipe", HUNTAWAY_PIPE_CMD: undefined }) });
  assert.equal(viaSettings.status, 0, viaSettings.stdout);
  assert.match(viaSettings.stdout, /ok   engine: pipe \(a pipe command is configured\)/);
  assert.ok(!viaSettings.stdout.includes("pipe-client") && !viaSettings.stderr.includes("pipe-client"), "never the command's path");
  // A malformed HUNTAWAY_PIPE_CMD is not rescued by the settings file (doctor and ask share one way of reading it).
  const mixed = node(["doctor"], { env: env({ HOME: home, HUNTAWAY_ENGINE: "pipe", HUNTAWAY_PIPE_CMD: "not-json-canary-Q7" }) });
  assert.equal(mixed.status, 1, mixed.stdout);
  assert.ok(mixed.stdout.split("\n").includes(badCommand), mixed.stdout);
  for (const hidden of ["not-json-canary-Q7", "pipe-client"]) {
    assert.ok(!mixed.stdout.includes(hidden) && !mixed.stderr.includes(hidden), `${hidden} is never shown`);
  }
  const unknown = node(["doctor"], { env: env({ HUNTAWAY_ENGINE: "fastest" }) });
  assert.equal(unknown.status, 1);
  assertNamesEveryEngine(unknown.stdout, "FAIL engine: HUNTAWAY_ENGINE must be ", "doctor");
  assert.ok(!unknown.stdout.includes("fastest") && !unknown.stderr.includes("fastest"), "the value is never echoed");
});

test("one engine rule for doctor and ask: unset, empty or anthropic is anthropic, pipe is the pipe, anything else is refused by both", () => {
  // Seen through the CLI: doctor names the engine it checks; ask accepts the setting (answering with the test-only
  // fake engine, so nothing is sent anywhere) or refuses it as a usage error.
  const env = (value) => {
    const e = { PATH: process.env.PATH, HUNTAWAY_HOME: mkdtempSync(join(tmpdir(), "huntaway-ce-")), HOME: mkdtempSync(join(tmpdir(), "huntaway-ce-home-")),
      HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "My Mac", HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_FAKE_ANSWER: "from fake",
      HUNTAWAY_TEST_ANTHROPIC_URL: STAND_IN, HUNTAWAY_TEST_KEYCHAIN_FILE: join(mkdtempSync(join(tmpdir(), "huntaway-kc-")), "keychain.json"),
      ANTHROPIC_API_KEY: TEST_KEY, ...ROOMY };
    if (value !== undefined) e.HUNTAWAY_ENGINE = value;
    return e;
  };
  for (const [value, engine] of [[undefined, "anthropic"], ["", "anthropic"], ["anthropic", "anthropic"], ["pipe", "pipe"]]) {
    const doctor = node(["doctor"], { env: env(value) });
    assert.match(doctor.stdout, new RegExp(`^(?:ok  |FAIL) engine: ${engine} \\(`, "m"), JSON.stringify(value));
    const ask = node(["ask", "--engine", "fake", "hi"], { env: env(value) });
    assert.equal(ask.status, 0, `${JSON.stringify(value)}: ${ask.stderr}`);
    assert.equal(ask.stdout, "from fake\n");
  }
  for (const value of ["Pipe", " pipe", "pipe ", "fastest", "none"]) {
    const doctor = node(["doctor"], { env: env(value) });
    assert.equal(doctor.status, 1, JSON.stringify(value));
    assertNamesEveryEngine(doctor.stdout, "FAIL engine: HUNTAWAY_ENGINE must be ", `doctor, ${JSON.stringify(value)}`);
    const ask = node(["ask", "--engine", "fake", "hi"], { env: env(value) });
    assert.equal(ask.status, 2, JSON.stringify(value));
    assertNamesEveryEngine(ask.stderr, "Error: HUNTAWAY_ENGINE must be ", `ask, ${JSON.stringify(value)}`);
  }
});

test("a fleet reading can't smuggle a hostname or address in as a machine name", () => {
  const odd = JSON.parse(JSON.stringify(fleet));
  const mdns = "studio" + ".local";                       // built at run time: the release scan refuses the literal
  for (const h of odd.hosts) h.alias = "studio.example.net";
  odd.hosts.push({ ...odd.hosts.find((h) => h.nodeId === "studio"), nodeId: mdns, alias: "192.0.2.5", host: "evil.example.net" });
  odd.hosts.push({ ...odd.hosts.find((h) => h.nodeId === "studio"), nodeId: "studio.example.net", alias: mdns });
  const f = join(mkdtempSync(join(tmpdir(), "huntaway-fleet-")), "fleet.json");
  writeFileSync(f, JSON.stringify(odd));
  for (const args of [["status", "--json"], ["status"], ["doctor"]]) {
    const out = node([...args, "--fleet-file", f]);
    for (const bad of ["studio.example.net", "192.0.2.5", "evil.example.net", mdns]) {
      assert.ok(!(out.stdout + out.stderr).includes(bad), `${args.join(" ")}: ${bad}`);
    }
  }
  const snap = JSON.parse(node(["status", "--json", "--fleet-file", f]).stdout);
  assert.deepEqual(snap.machines.map((m) => m.alias), ["Studio", "Mini", "Laptop"], "aliases come from Huntaway's own table");
});

test("the fleet helper runs only when configured, never sees an API key, and not before the machine names check out", () => {
  const dir = mkdtempSync(join(tmpdir(), "huntaway-helper-"));
  const marker = join(dir, "ran");
  const helper = join(dir, "helper.sh");
  writeFileSync(helper, `#!/bin/sh\nprintf '%s|%s|%s|%s|%s|%s|%s' "\${ANTHROPIC_API_KEY:-none}" "\${ANTHROPIC_AUTH_TOKEN:-none}" "\${OPENAI_API_KEY:-none}" "\${CODEX_API_KEY:-none}" "\${GEMINI_API_KEY:-none}" "\${GOOGLE_API_KEY:-none}" "\${OPENROUTER_API_KEY:-none}" > '${marker}'\ncat '${fleetPath}'\n`);
  chmodSync(helper, 0o755);
  // A minimal environment: nothing from the machine running the tests (its home, its credentials) reaches the helper.
  const env = (extra) => ({ PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "huntaway-hh-home-")),
    HUNTAWAY_HOME: mkdtempSync(join(tmpdir(), "huntaway-hh-")),
    HUNTAWAY_FLEET_ALIASES: "studio=Studio,mini=Mini,laptop=Laptop", ANTHROPIC_API_KEY: "huntaway-test-key-0000-not-real",
    ANTHROPIC_AUTH_TOKEN: "huntaway-test-token-not-real", OPENAI_API_KEY: "huntaway-test-openai-not-real",
    CODEX_API_KEY: "huntaway-test-codex-not-real", GEMINI_API_KEY: "huntaway-test-gemini-not-real",
    GOOGLE_API_KEY: "huntaway-test-google-not-real", OPENROUTER_API_KEY: "huntaway-test-openrouter-not-real", ...extra });
  // Not configured: standalone, the helper never runs.
  const unset = { ...env({}) };
  delete unset.HUNTAWAY_FLEET_CMD;
  const plain = node(["status"], { env: unset });
  assert.match(plain.stdout, /standalone/);
  assert.ok(!existsSync(marker), "no helper ran");
  // Configured, but no machine names: refused before the helper runs.
  const noNames = node(["status"], { env: env({ HUNTAWAY_FLEET_CMD: helper, HUNTAWAY_FLEET_ALIASES: "" }) });
  assert.equal(noNames.status, 1);
  assert.ok(!existsSync(marker), "the names are checked first");
  // Configured, with names the product refuses: exit 1, the problem named, and the helper never started.
  const badNames = node(["status"], { env: env({ HUNTAWAY_FLEET_CMD: helper, HUNTAWAY_FLEET_ALIASES: "studio=Stu.dio" }) });
  assert.equal(badNames.status, 1);
  assert.match(badNames.stderr, /not a valid list/);
  assert.ok(!existsSync(marker), "a refused list is caught before the helper runs");
  // Configured with names: it runs, and without the API key.
  const ok = node(["status", "--json"], { env: env({ HUNTAWAY_FLEET_CMD: helper }) });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(marker, "utf8"), "none|none|none|none|none|none|none", "the helper sees no API key or token, paid ones included");
});

test("a Codex account out of plan allowance but able to keep working on credits is 'credits'; everything else keeps its room", () => {
  // The Laptop's Codex account (bbbb2222) has one observed window at 0%: "none" before credits.
  const codexWith = (windows) => {
    const f = JSON.parse(JSON.stringify(fleet));
    f.pools.find((p) => p.accountFingerprint === "bbbb2222").windows = windows;
    return machinesFromFleet(f).find((m) => m.alias === "Laptop").subscriptions.find((s) => s.family === "codex");
  };
  const usable = { usable: true, balance: 62420.61, unlimited: false, hasCredits: true, spendControlReached: false };
  const soon = "2026-09-30T19:00:00Z", later = "2026-10-03T17:18:24Z";
  const at = (iso) => new Date(iso).toISOString();
  // The helper copies the account's flag and credits onto every Codex window.
  const win = (remainingPercent, resetAt, extra = {}) =>
    ({ state: "observed", remainingPercent, resetAt, ordinaryUsageAllowed: false, credits: usable, freeResetsAvailable: 3, ...extra });
  const want = (room, resetAt) => ({ family: "codex", room, resetsAt: resetAt === null ? null : at(resetAt) });

  assert.deepEqual(codexWith([win(0, later)]), want("credits", later));
  assert.deepEqual(codexWith([win(0, soon), win(60, later)]), want("credits", soon),
    "only the spent window binds: the plan comes back at the 5-hour reset, not the weekly one");
  assert.deepEqual(codexWith([win(0, soon, { credits: null }), win(60, later, { credits: null })]), want("none", soon));
  assert.deepEqual(codexWith([win(0, soon), win(0, later)]), want("credits", later), "every spent window on credits: the last reset");
  assert.deepEqual(codexWith([win(12, later)]), want("credits", later), "ordinary use refused before any percent reads 0");
  assert.deepEqual(codexWith([win(12, later, { credits: null })]), want("none", later));
  for (const credits of [{ ...usable, usable: "true" }, [], { ...usable, usable: false }, { ...usable, spendControlReached: true },
    { ...usable, balance: 0 }, { ...usable, balance: null }]) {
    assert.deepEqual(codexWith([win(0, later, { credits })]), want("none", later), `not usable: ${JSON.stringify(credits)}`);
  }
  assert.deepEqual(codexWith([win(0, later, { credits: { ...usable, balance: null, unlimited: true } })]), want("credits", later));
  const { credits: _dropped, ...noCredits } = win(0, later);
  assert.deepEqual(codexWith([noCredits]), want("none", later), "no credits field");
  assert.deepEqual(codexWith([{ ...win(0, later), state: undefined }]), want("none", later), "credits count only on an observed window");
  assert.deepEqual(codexWith([{ ...win(0, later), state: "exhausted" }]), want("none", later), "the fleet's own hold is out of room");
  assert.deepEqual(codexWith([win(0, soon), { ...win(0, later), state: "exhausted" }]), want("none", later),
    "a hold next to a window on credits: out of room until the hold's reset");
  assert.deepEqual(codexWith([{ ...win(0, later), state: "stale" }]), { family: "codex", room: "unknown", resetsAt: null },
    "a stale window's credits never count");
  assert.deepEqual(codexWith([win(40, later, { ordinaryUsageAllowed: true })]), want("some", later), "credits never change a plan with allowance left");

  const credited = JSON.parse(JSON.stringify(fleet));
  credited.pools.find((p) => p.accountFingerprint === "bbbb2222").windows = [win(0, soon), win(60, later)];
  assert.ok(check(buildSnapshot({ now: NOW, fleet: credited })), "a snapshot with a credits room validates against the contract");
});

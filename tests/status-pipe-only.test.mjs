// `huntaway status` for a Pipe-only user (the paid layer, what the user
// sees). The "Paid API: $X of $Y used in the last 24 hours" line is about the paid engines' own ledger, spend.sqlite.
// Someone who chose the Pipe (HUNTAWAY_ENGINE=pipe, which is how `install-local.sh --router` makes it the default
// engine) and has never used a paid engine has no ledger, so:
// - status prints no "Paid API" line, in the standalone view and the fleet view;
// - a missing ledger, or one that can't be read (a stray side file with no spend.sqlite), never changes its exit code.
// With a paid engine chosen (unset, empty, anthropic or openai), or once spend.sqlite exists, the line is shown exactly
// as today, and an unreadable ledger still exits 1.
//
// Everything is seen from outside: the CLI's output and exit code, and the files under the test's own folders. A
// minimal environment, so nothing from the machine running the tests reaches the child. No network is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/huntaway.ts", import.meta.url));
const FLEET = fileURLToPath(new URL("./fixtures/fleet-sample.json", import.meta.url));
const CAPS = { HUNTAWAY_MAX_USD_PER_QUESTION: "0.50", HUNTAWAY_MAX_USD_PER_DAY: "5.00" };
/** Today's line for an empty ledger, with a day cap of $5.00, and with no day cap set. */
const PAID_LINE = "Paid API: $0.00 of $5.00 used in the last 24 hours (Huntaway's own use on this machine)";
const PAID_LINE_NO_CAP = "Paid API: $0.00 of an unset day cap used in the last 24 hours (Huntaway's own use on this machine)";
const UNAVAILABLE = "Paid API: spend ledger unavailable";
const ANY_PAID = /^Paid API\b/m;
const SIDE_FILES = ["-wal", "-shm", "-journal"];

const made = [];
process.on("exit", () => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); });

function newDirs() {
  const root = mkdtempSync(join(tmpdir(), "huntaway-status-pipe-"));
  made.push(root);
  const dirs = { root, home: join(root, "home"), data: join(root, "home", "huntaway"), tmp: join(root, "tmp") };
  dirs.ledger = join(dirs.data, "spend.sqlite");
  for (const d of [dirs.data, dirs.tmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return dirs;
}

/** The environment of a Pipe-only user: the Pipe chosen, no paid key, no caps, no test switch. undefined removes. */
function pipeEnv(dirs, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: dirs.home, TMPDIR: dirs.tmp, HUNTAWAY_HOME: dirs.data,
    HUNTAWAY_FLEET_CMD: "none", HUNTAWAY_ALIAS: "My Mac", HUNTAWAY_FLEET_ALIASES: "studio=Studio,mini=Mini,laptop=Laptop",
    HUNTAWAY_ENGINE: "pipe", ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

const run = (args, env) => spawnSync(process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", CLI, ...args],
  { encoding: "utf8", env, timeout: 30_000 });

/** Both text views: standalone (no Router), and the fleet view from a reading file. */
const VIEWS = [["standalone", ["status"]], ["fleet", ["status", "--fleet-file", FLEET]]];

/** A ledger that can't be read though spend.sqlite itself is missing: a side file left on its own. */
function strand(dirs, suffix) {
  writeFileSync(dirs.ledger + suffix, "left behind");
  assert.ok(!existsSync(dirs.ledger));
}

/**
 * A real spend.sqlite, made the way a user makes one: a paid question whose count can't be sent (the stand-in address
 * is a port nothing listens on), so nothing billed is ever sent and nothing stays reserved. The ledger is opened
 * before the count (it fails closed), so it now exists.
 */
function makeLedger(dirs) {
  const r = run(["ask", "--engine", "anthropic", "--model", "hwtest-model", "hi"], pipeEnv(dirs, {
    HUNTAWAY_ENGINE: undefined, HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_TEST_ANTHROPIC_URL: "http://127.0.0.1:9/v1/messages",
    HUNTAWAY_TEST_KEYCHAIN_FILE: join(dirs.home, "keychain.json"), ANTHROPIC_API_KEY: "hwtest-status-pipe-key-0000-not-real", ...CAPS,
  }));
  assert.notEqual(r.status, 0, "the count couldn't be sent, so the question was refused");
  assert.ok(existsSync(dirs.ledger), `the paid question left a spend ledger behind:\n${r.stderr}`);
}

test("a Pipe-only user with no spend.sqlite: status shows no Paid API line, in both views, and exits 0", () => {
  for (const [view, args] of VIEWS) {
    const dirs = newDirs();
    const r = run(args, pipeEnv(dirs));
    assert.equal(r.status, 0, `${view}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, ANY_PAID, `${view}: no Paid API line for someone who never used a paid engine`);
    assert.doesNotMatch(r.stdout + r.stderr, /used in the last 24 hours|spend ledger/i, view);
    assert.match(r.stdout, /^No local runs yet\.$/m, `${view}: the rest of status is still there`);
    assert.ok(!existsSync(dirs.ledger), `${view}: status never creates the ledger`);
  }
});

test("a Pipe-only user whose missing ledger can't be read (a side file on its own): still no Paid API line, and the same exit code", () => {
  for (const [view, args] of VIEWS) {
    const clean = run(args, pipeEnv(newDirs()));
    for (const suffix of SIDE_FILES) {
      const dirs = newDirs();
      strand(dirs, suffix);
      const r = run(args, pipeEnv(dirs));
      const what = `${view}, spend.sqlite${suffix} alone`;
      assert.equal(r.status, clean.status, `${what}: the ledger never changes a Pipe-only user's exit code\n${r.stdout}${r.stderr}`);
      assert.equal(r.status, 0, what);
      assert.doesNotMatch(r.stdout, ANY_PAID, what);
      assert.doesNotMatch(r.stdout + r.stderr, /spend ledger/i, what);
    }
  }
});

test("a Pipe-only user whose local runs can't be read still exits 1, with or without a stray ledger side file", () => {
  // The ledger is left out of a Pipe-only user's exit code, never the request log: that still fails.
  for (const stray of [false, true]) {
    const dirs = newDirs();
    writeFileSync(join(dirs.data, "runs.db"), "this is not a database");
    if (stray) strand(dirs, "-wal");
    const r = run(["status"], pipeEnv(dirs));
    assert.equal(r.status, 1, `stray side file: ${stray}`);
    assert.match(r.stdout, /Local runs: unavailable right now/);
    assert.doesNotMatch(r.stdout, ANY_PAID);
  }
});

test("with a paid engine chosen (unset, empty, anthropic or openai), status shows the Paid API line as today, even with no ledger", () => {
  for (const engine of [undefined, "", "anthropic", "openai"]) {
    for (const [view, args] of VIEWS) {
      const what = `HUNTAWAY_ENGINE=${JSON.stringify(engine)}, ${view}`;
      const dirs = newDirs();
      const r = run(args, pipeEnv(dirs, { HUNTAWAY_ENGINE: engine, ...CAPS }));
      assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.split("\n").includes(PAID_LINE), `${what}:\n${r.stdout}`);
      // And an unreadable ledger is still a failure for a paid engine.
      const broken = newDirs();
      strand(broken, "-wal");
      const bad = run(args, pipeEnv(broken, { HUNTAWAY_ENGINE: engine, ...CAPS }));
      assert.equal(bad.status, 1, `${what}, a stray side file: ${bad.stdout}${bad.stderr}`);
      assert.ok(bad.stdout.split("\n").includes(UNAVAILABLE), `${what}, a stray side file:\n${bad.stdout}`);
    }
  }
});

test("a Pipe user once spend.sqlite exists: the Paid API line is shown as today, and an unreadable ledger still exits 1", () => {
  for (const [view, args] of VIEWS) {
    // A real ledger, from an earlier paid question: the line, exactly as today (no day cap set for this user).
    const dirs = newDirs();
    makeLedger(dirs);
    const r = run(args, pipeEnv(dirs));
    assert.equal(r.status, 0, `${view}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.split("\n").includes(PAID_LINE_NO_CAP), `${view}:\n${r.stdout}`);
    const capped = run(args, pipeEnv(dirs, CAPS));
    assert.ok(capped.stdout.split("\n").includes(PAID_LINE), `${view}, with caps set:\n${capped.stdout}`);
    // A spend.sqlite that isn't a ledger: shown as unavailable, and status fails, as today.
    const broken = newDirs();
    writeFileSync(broken.ledger, "this is not a database");
    const bad = run(args, pipeEnv(broken));
    assert.equal(bad.status, 1, `${view}, an unreadable spend.sqlite: ${bad.stdout}${bad.stderr}`);
    assert.ok(bad.stdout.split("\n").includes(UNAVAILABLE), `${view}, an unreadable spend.sqlite:\n${bad.stdout}`);
  }
});

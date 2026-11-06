// The shipping kit is optional: a copy of huntaway without src/ship/ (the public release) has no `ship` command, and
// says so plainly instead of crashing; every other command still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const huntaway = (root, args) => spawnSync(process.execPath, ["--experimental-strip-types", join(root, "bin", "huntaway.ts"), ...args], {
  encoding: "utf8",
  env: { ...process.env, HUNTAWAY_ALIAS: "Test Mac", HUNTAWAY_FLEET_CMD: "none" },
});

function copy(t) {
  const root = mkdtempSync(join(tmpdir(), "huntaway copy "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const part of ["bin", "src", "contract", "package.json"]) cpSync(join(ROOT, part), join(root, part), { recursive: true });
  return root;
}
function copyWithoutShip(t) {
  const root = copy(t);
  rmSync(join(root, "src", "ship"), { recursive: true, force: true });
  return root;
}

test("with the kit present, help lists ship", { skip: !existsSync(join(ROOT, "src", "ship")) && "this copy has no shipping kit" }, () => {
  const r = huntaway(ROOT, ["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /huntaway ship </);
});

test("without the kit, help leaves ship out and `ship` exits 2 with a plain message", (t) => {
  const root = copyWithoutShip(t);
  const help = huntaway(root, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /ship/);
  assert.match(help.stdout, /huntaway ask /);
  const ship = huntaway(root, ["ship", "doctor"]);
  assert.equal(ship.status, 2, ship.stderr);
  assert.match(ship.stderr, /^Error: this copy of huntaway has no ship command\n/);
  assert.doesNotMatch(ship.stderr, /ERR_MODULE_NOT_FOUND|at .*\(/);
});

test("without the kit, doctor still runs, also through a symlinked command", (t) => {
  const root = copyWithoutShip(t);
  const kit = huntaway(ROOT, ["doctor"]);
  const r = huntaway(root, ["doctor"]);
  assert.equal(r.status, kit.status, r.stdout + r.stderr);
  assert.match(r.stdout, /Node/i, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/);
  const link = join(root, "linked bin");
  symlinkSync(join(root, "bin", "huntaway.ts"), link);
  const viaLink = spawnSync(process.execPath, ["--experimental-strip-types", link, "--help"], { encoding: "utf8" });
  assert.equal(viaLink.status, 0, viaLink.stderr);
  assert.doesNotMatch(viaLink.stdout, /ship/);
});

test("a kit that is present but broken still fails every command, as a static import did", (t) => {
  const root = copy(t);
  mkdirSync(join(root, "src", "ship"), { recursive: true });   // the public copy has no kit folder at all
  writeFileSync(join(root, "src", "ship", "ship.ts"), "throw new Error('broken kit');\n");
  for (const args of [["--help"], ["doctor"], ["ship", "doctor"]]) {
    const r = huntaway(root, args);
    assert.notEqual(r.status, 0, `${args.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, /broken kit/, args.join(" "));
  }
});

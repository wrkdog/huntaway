// The local installer and uninstaller, run from a throwaway clone (never the real checkout): a read-only copy of
// exactly the committed code, a `huntaway` command that no path can inject into, never clobbering what isn't ours,
// atomic and idempotent, and an uninstaller that keeps run history unless told to purge it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
// Every file Huntaway writes in its home folder (the marker is a folder).
const HISTORY = ["runs.json", "requests.db", "requests.db-wal", "requests.db-shm", "requests.db-journal",
  "runs.db", "runs.db-wal", "runs.db-shm", "runs.db-journal", "key", "key.4242.tmp",
  "spend.sqlite", "spend.sqlite-wal", "spend.sqlite-shm", "spend.sqlite-journal"];          // the day ledger
// The helpers never inherit the caller's Huntaway or git settings.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUNTAWAY_") && !k.startsWith("GIT_")));
const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: baseEnv });
const temps = [];
const tempDir = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
after(() => {
  for (const d of temps) {
    spawnSync("chmod", ["-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

/** A clean clone whose HEAD carries this working tree's scripts (so the tests exercise the code under review). */
function cloneRepo() {
  const dir = tempDir("huntaway-clone-");
  assert.equal(git(repo, "clone", "-q", repo, join(dir, "r")).status, 0);
  const clone = join(dir, "r");
  for (const f of ["install-local.sh", "uninstall-local.sh"]) copyFileSync(join(repo, "scripts", f), join(clone, "scripts", f));
  const commit = git(clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
    "commit", "--no-verify", "--allow-empty", "-qam", "scripts under test");
  assert.equal(commit.status, 0, commit.stderr);
  return clone;
}
const CLONE = cloneRepo();
const sh = (script, args, home, env = {}, from = CLONE) => spawnSync("sh", [join(from, "scripts", script), ...args],
  { encoding: "utf8", env: { ...baseEnv, HOME: home, ...env } });
const freshHome = () => tempDir("huntaway-home-");
const appDir = (home) => join(home, ".local", "share", "huntaway", "app");
const copies = (home) => existsSync(appDir(home)) ? readdirSync(appDir(home)).filter((d) => !d.startsWith(".")) : [];
const leftovers = (home) => [
  ...(existsSync(appDir(home)) ? readdirSync(appDir(home)).filter((d) => d.startsWith(".")) : []),
  ...(existsSync(join(home, ".local", "bin")) ? readdirSync(join(home, ".local", "bin")).filter((d) => d.startsWith(".")) : []),
];

test("install puts a read-only copy and a working `huntaway` command in the home folder, idempotently", () => {
  const home = freshHome();
  const first = sh("install-local.sh", ["--alias", "Mini"], home);
  assert.equal(first.status, 0, first.stderr);
  const wrapper = join(home, ".local", "bin", "huntaway");
  assert.equal(copies(home).length, 1);
  const copy = join(appDir(home), copies(home)[0]);
  assert.equal(statSync(join(copy, "bin", "huntaway.ts")).mode & 0o222, 0, "installed files are read-only");
  const help = spawnSync(wrapper, ["--help"], { encoding: "utf8", env: { ...baseEnv, HOME: home } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage/i);
  assert.equal(help.stderr, "", "no experimental-feature warning noise");
  assert.equal(sh("install-local.sh", ["--alias", "Mini"], home).status, 0);
  assert.equal(copies(home).length, 1);
  assert.deepEqual(leftovers(home), []);
});

test("no HOME can inject into the command: spaces, quotes and $(...) work; backslashes are refused up front", () => {
  for (const name of ["we'ird \"home\" $(touch pwned)", "plain space"]) {
    const home = join(tempDir("huntaway-home-"), name);
    mkdirSync(home);
    const out = sh("install-local.sh", ["--alias", "Studio"], home);
    assert.equal(out.status, 0, `${name}: ${out.stderr}`);
    const help = spawnSync(join(home, ".local", "bin", "huntaway"), ["--help"], { encoding: "utf8", cwd: home, env: { ...baseEnv, HOME: home } });
    assert.equal(help.status, 0, `${name}: ${help.stderr}`);
    assert.ok(!existsSync(join(home, "pwned")) && !existsSync(join(process.cwd(), "pwned")), `${name}: nothing ran`);
    const bye = sh("uninstall-local.sh", [], home);
    assert.equal(bye.status, 0, bye.stderr);
    assert.ok(!existsSync(join(home, ".local", "bin", "huntaway")));
  }
  // echo would turn \0047 into a quote and \c into a cut line; Node cannot load code under a backslash path at all.
  for (const name of ["x\\0047;touch pwned;\\0047", "cut\\c here"]) {
    const home = join(tempDir("huntaway-home-"), name);
    mkdirSync(home);
    const out = sh("install-local.sh", [], home);
    assert.equal(out.status, 1, name);
    assert.match(out.stderr, /backslash/);
    assert.ok(!existsSync(join(home, ".local")), `${name}: nothing written`);
    assert.ok(!existsSync(join(home, "pwned")), `${name}: nothing ran`);
  }
});

test("install refuses bad input: alias, arguments, relative/empty/newline HOME", () => {
  const home = freshHome();
  assert.equal(sh("install-local.sh", ["--alias", "mars.example.com"], home).status, 2);
  assert.equal(sh("install-local.sh", ["--alias", "it's"], home).status, 2);
  assert.equal(sh("install-local.sh", ["--alias", "A".repeat(33)], home).status, 2);
  assert.equal(sh("install-local.sh", ["--oops"], home).status, 2);
  assert.equal(sh("install-local.sh", [], "relative/home").status, 1);
  assert.equal(sh("install-local.sh", [], "").status, 1);
  const nl = join(freshHome(), "new\nline");
  mkdirSync(nl);
  assert.equal(sh("install-local.sh", [], nl).status, 1);
  assert.equal(sh("uninstall-local.sh", [], nl).status, 1);
});

test("install refuses uncommitted changes unless explicitly allowed, and still installs exactly HEAD", () => {
  const clone = cloneRepo();
  writeFileSync(join(clone, "src", "status", "snapshot.ts"), readFileSync(join(clone, "src", "status", "snapshot.ts"), "utf8") + "\n// local edit\n");
  const home = freshHome();
  const refused = sh("install-local.sh", [], home, {}, clone);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /commit your changes/);
  const allowed = sh("install-local.sh", [], home, { HUNTAWAY_INSTALL_ALLOW_DIRTY: "1" }, clone);
  assert.equal(allowed.status, 0, allowed.stderr);
  const copy = join(appDir(home), copies(home)[0]);
  assert.ok(!readFileSync(join(copy, "src", "status", "snapshot.ts"), "utf8").includes("// local edit"), "the copy is HEAD");
});

test("an untracked file in the checkout never travels", () => {
  const clone = cloneRepo();
  writeFileSync(join(clone, "src", "zz-untracked.ts"), "export const x = 1;\n");
  const home = freshHome();
  assert.equal(sh("install-local.sh", [], home, {}, clone).status, 0);
  assert.ok(!existsSync(join(appDir(home), copies(home)[0], "src", "zz-untracked.ts")));
});

test("install and uninstall never touch a huntaway command they didn't create", () => {
  for (const kind of ["file", "symlink", "folder"]) {
    const home = freshHome();
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const wrapper = join(bin, "huntaway");
    if (kind === "file") writeFileSync(wrapper, "#!/bin/sh\necho mine\n");
    if (kind === "symlink") symlinkSync("/bin/echo", wrapper);
    if (kind === "folder") mkdirSync(wrapper);
    assert.equal(sh("install-local.sh", [], home).status, 1, `${kind}: install must refuse`);
    const uninstall = sh("uninstall-local.sh", [], home);
    assert.equal(uninstall.status, 0);
    assert.match(uninstall.stdout, /left alone/);
    assert.ok(existsSync(wrapper), `${kind}: uninstall must leave it`);
    if (kind === "file") assert.match(readFileSync(wrapper, "utf8"), /echo mine/);
  }
});

test("symbolic links where Huntaway installs are refused, by both scripts", () => {
  for (const where of ["root", "app"]) {
    const home = freshHome();
    const elsewhere = tempDir("huntaway-elsewhere-");
    const share = join(home, ".local", "share");
    mkdirSync(share, { recursive: true });
    if (where === "root") symlinkSync(elsewhere, join(share, "huntaway"));
    else { mkdirSync(join(share, "huntaway")); symlinkSync(elsewhere, join(share, "huntaway", "app")); }
    assert.equal(sh("install-local.sh", [], home).status, 1, `${where}: install`);
    assert.equal(sh("uninstall-local.sh", [], home).status, 1, `${where}: uninstall`);
    assert.deepEqual(readdirSync(elsewhere), [], `${where}: nothing written through the link`);
  }
});

test("two installs of one commit at once end with one complete copy and no leftovers", async () => {
  const home = freshHome();
  const one = () => new Promise((resolve) => {
    let err = "";
    const p = spawn("sh", [join(CLONE, "scripts", "install-local.sh")], { env: { ...baseEnv, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, err }));
  });
  const results = await Promise.all([one(), one(), one()]);
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0], results.map((r) => r.err).join(" | "));
  assert.equal(copies(home).length, 1);
  assert.ok(existsSync(join(appDir(home), copies(home)[0], "bin", "huntaway.ts")));
  assert.deepEqual(leftovers(home), []);
});

test("a failing export leaves no copy and no leftovers, and a re-run then succeeds", () => {
  const home = freshHome();
  const shim = tempDir("huntaway-shim-");
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(shim, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = archive ] && exit 7; done\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  const failed = sh("install-local.sh", [], home, { PATH: `${shim}:${baseEnv.PATH}` });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(copies(home), []);
  assert.deepEqual(leftovers(home), []);
  assert.equal(sh("install-local.sh", [], home).status, 0);
  assert.equal(copies(home).length, 1);
});

test("uninstall removes the command and code but keeps every history file unless purged", () => {
  const home = freshHome();
  assert.equal(sh("install-local.sh", [], home).status, 0);
  const root = join(home, ".local", "share", "huntaway");
  for (const f of HISTORY) writeFileSync(join(root, f), "x");
  mkdirSync(join(root, "requests.db.creating"));
  const keep = sh("uninstall-local.sh", [], home);
  assert.equal(keep.status, 0, keep.stderr);
  assert.ok(!existsSync(join(home, ".local", "bin", "huntaway")));
  assert.ok(!existsSync(join(root, "app")));
  for (const f of [...HISTORY, "requests.db.creating"]) assert.ok(existsSync(join(root, f)), `${f} kept`);
  const purge = sh("uninstall-local.sh", ["--purge-history"], home);
  assert.equal(purge.status, 0);
  assert.match(purge.stdout, /history deleted$/m);
  assert.ok(!existsSync(root), "history and its folder deleted");
});

test("a purge never claims more than it did: files Huntaway did not write stay, and it says so", () => {
  const home = freshHome();
  assert.equal(sh("install-local.sh", [], home).status, 0);
  const root = join(home, ".local", "share", "huntaway");
  writeFileSync(join(root, "runs.db"), "x");
  writeFileSync(join(root, "my-notes.txt"), "mine");
  const purge = sh("uninstall-local.sh", ["--purge-history"], home);
  assert.equal(purge.status, 0, purge.stderr);
  assert.match(purge.stdout, /other files were left in ~\/\.local\/share\/huntaway/);
  assert.ok(!existsSync(join(root, "runs.db")));
  assert.equal(readFileSync(join(root, "my-notes.txt"), "utf8"), "mine");
});

test("a HOME with trailing slashes installs and uninstalls cleanly; a HOME that isn't a folder is refused by both", () => {
  const home = freshHome();
  const out = sh("install-local.sh", [], `${home}//`);
  assert.equal(out.status, 0, out.stderr);
  const text = readFileSync(join(home, ".local", "bin", "huntaway"), "utf8");
  assert.ok(!text.includes("//"), "no doubled slash in the command");
  const bye = sh("uninstall-local.sh", [], `${home}/`);
  assert.equal(bye.status, 0, bye.stderr);
  assert.ok(!existsSync(join(home, ".local", "bin", "huntaway")));
  const missing = join(freshHome(), "not-here");
  assert.equal(sh("install-local.sh", [], missing).status, 1);
  assert.equal(sh("uninstall-local.sh", [], missing).status, 1);
  assert.ok(!existsSync(missing), "nothing created");
});

test("only a command whose second line is exactly the installer's counts as ours", () => {
  const home = freshHome();
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const wrapper = join(bin, "huntaway");
  writeFileSync(wrapper, "#!/bin/sh\necho mine\n# see: installed by scripts/install-local.sh\n");
  assert.equal(sh("install-local.sh", [], home).status, 1);
  const bye = sh("uninstall-local.sh", [], home);
  assert.equal(bye.status, 0);
  assert.match(readFileSync(wrapper, "utf8"), /echo mine/);
});

test("leftovers of an install killed over an hour ago are cleaned; a fresh one (maybe running) is not", () => {
  const home = freshHome();
  const app = join(home, ".local", "share", "huntaway", "app");
  const bin = join(home, ".local", "bin");
  mkdirSync(app, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const old = new Date(Date.now() - 2 * 3600_000);
  mkdirSync(join(app, ".install.old111", "src"), { recursive: true });
  writeFileSync(join(app, ".install.old111", "src", "x.ts"), "x");
  chmodSync(join(app, ".install.old111", "src"), 0o555);
  utimesSync(join(app, ".install.old111"), old, old);
  writeFileSync(join(app, ".install.old444.tar"), "x");
  utimesSync(join(app, ".install.old444.tar"), old, old);
  const aged = (name, body) => { writeFileSync(join(bin, name), body); utimesSync(join(bin, name), old, old); };
  aged(".huntaway.old222", "");                                            // ours, killed before writing: removed
  aged(".huntaway.old555", "#!/bin/sh\n# huntaway abc, installed by scripts/install-local.sh\n");   // ours: removed
  aged(".huntaway.old666", "the owner's own file\n");                     // same pattern, not ours: kept
  aged(".huntaway.notes", "");                                             // not our name pattern: kept
  mkdirSync(join(app, ".install.new333"));
  writeFileSync(join(bin, ".huntaway.new777"), "");
  assert.equal(sh("install-local.sh", [], home).status, 0);
  for (const gone of [join(app, ".install.old111"), join(app, ".install.old444.tar"), join(bin, ".huntaway.old222"), join(bin, ".huntaway.old555")]) {
    assert.ok(!existsSync(gone), gone);
  }
  for (const kept of [join(app, ".install.new333"), join(bin, ".huntaway.old666"), join(bin, ".huntaway.notes"), join(bin, ".huntaway.new777")]) {
    assert.ok(existsSync(kept), kept);
  }
  assert.deepEqual(readdirSync(app).filter((d) => d.startsWith(".stale.")), [], "nothing renamed away is left");
});

test("no inherited git setting can change what is installed; a dirty install says what it left out", () => {
  const other = cloneRepo();
  git(other, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
    "commit", "--no-verify", "--allow-empty", "-qm", "another commit");
  const want = git(CLONE, "rev-parse", "--short=12", "HEAD").stdout.trim();
  for (const env of [{ GIT_DIR: join(other, ".git") }, { GIT_COMMON_DIR: join(other, ".git") },
    { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: other }]) {
    const home = freshHome();
    const out = sh("install-local.sh", [], home, env);
    assert.equal(out.status, 0, `${Object.keys(env)[0]}: ${out.stderr}`);
    assert.deepEqual(copies(home), [want], Object.keys(env)[0]);
  }
  const dirty = cloneRepo();
  writeFileSync(join(dirty, "package.json"), readFileSync(join(dirty, "package.json"), "utf8") + "\n");
  const allowed = sh("install-local.sh", [], freshHome(), { HUNTAWAY_INSTALL_ALLOW_DIRTY: "1" }, dirty);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stderr, /uncommitted changes are not included/);
});

test("uninstall refuses unknown arguments instead of guessing", () => {
  assert.equal(sh("uninstall-local.sh", ["--purge-history", "extra"], freshHome()).status, 2);
});

test("the alias is written into the command and yields to one the owner already set", () => {
  const home = freshHome();
  assert.equal(sh("install-local.sh", ["--alias", "Studio"], home).status, 0);
  const text = readFileSync(join(home, ".local", "bin", "huntaway"), "utf8");
  assert.match(text, /: "\$\{HUNTAWAY_ALIAS:=Studio\}"; export HUNTAWAY_ALIAS/);
  const probe = spawnSync("sh", ["-c", text.split("\n").find((l) => l.startsWith(": ")) + '; printf %s "$HUNTAWAY_ALIAS"'],
    { encoding: "utf8", env: { ...baseEnv, HUNTAWAY_ALIAS: "Laptop" } });
  assert.equal(probe.stdout, "Laptop", "an alias the owner set wins");
});

test("a symbolic link at ~/.local or ~/.local/share is refused by both scripts", () => {
  for (const which of [[".local"], [".local", "share"]]) {
    const home = freshHome();
    const elsewhere = tempDir("huntaway-elsewhere-");
    if (which.length === 2) mkdirSync(join(home, ".local"));
    symlinkSync(elsewhere, join(home, ...which));
    assert.equal(sh("install-local.sh", [], home).status, 1, which.join("/"));
    assert.equal(sh("uninstall-local.sh", ["--purge-history"], home).status, 1, which.join("/"));
    assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");
  }
});

test("the Node path is shown under ~ when it lives in the home folder", () => {
  const home = freshHome();
  const nodeDir = join(home, "tools");
  mkdirSync(nodeDir);
  symlinkSync(process.execPath, join(nodeDir, "node"));
  const out = sh("install-local.sh", [], home, { PATH: `${nodeDir}:${baseEnv.PATH}` });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /the node at ~\/tools\/node;/);
  assert.ok(!out.stdout.includes(home), "the home path is not printed");
});

test("every file a real ask and status leave in the Huntaway folder is one the purge knows", () => {
  const home = freshHome();
  assert.equal(sh("install-local.sh", [], home).status, 0);
  const cmd = join(home, ".local", "bin", "huntaway");
  const env = { ...baseEnv, HOME: home, HUNTAWAY_ENABLE_FAKE_ENGINE: "1", HUNTAWAY_FAKE_ANSWER: "a" };
  const ask = spawnSync(cmd, ["ask", "--engine", "fake", "q"], { encoding: "utf8", env });
  assert.equal(ask.status, 0, ask.stderr);
  spawnSync(cmd, ["status", "--fleet-file", join(repo, "tests", "fixtures", "fleet-sample.json")], { encoding: "utf8", env });
  const root = join(home, ".local", "share", "huntaway");
  const unknown = readdirSync(root).filter((f) => f !== "app" && !HISTORY.includes(f));
  assert.deepEqual(unknown, [], "add new home-folder files to the uninstaller's purge (and to HISTORY)");
  assert.equal(sh("uninstall-local.sh", ["--purge-history"], home).status, 0);
  assert.ok(!existsSync(root));
});

test("--standalone and a free-form alias are written into the command, and yield to the owner's own settings", () => {
  const home = freshHome();
  assert.equal(sh("install-local.sh", ["--alias", "My Mac mini", "--standalone"], home).status, 0);
  const text = readFileSync(join(home, ".local", "bin", "huntaway"), "utf8");
  assert.match(text, /: "\$\{HUNTAWAY_ALIAS:=My Mac mini\}"; export HUNTAWAY_ALIAS/);
  assert.match(text, /: "\$\{HUNTAWAY_FLEET_CMD:=none\}"; export HUNTAWAY_FLEET_CMD/);
  assert.match(text, /: "\$\{HUNTAWAY_ENGINE:=anthropic\}"; export HUNTAWAY_ENGINE/);
  const env = { ...baseEnv, HOME: home };
  const status = spawnSync(join(home, ".local", "bin", "huntaway"), ["status", "--json"], { encoding: "utf8", env });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).machines.map((m) => m.alias), ["My Mac mini"]);
  const plain = freshHome();
  assert.equal(sh("install-local.sh", [], plain).status, 0);
  const plainText = readFileSync(join(plain, ".local", "bin", "huntaway"), "utf8");
  assert.ok(!plainText.includes("HUNTAWAY_FLEET_CMD") && !plainText.includes("HUNTAWAY_ENGINE"),
    "without --standalone nothing about the Router or the engine is written");
  assert.equal(sh("install-local.sh", ["--standalone"], freshHome()).status, 2, "--standalone needs --alias");
});

test("the installer and the contract agree on every alias, in the C locale and in UTF-8", async () => {
  const { validAlias, ALIAS_PATTERN } = await import("../src/status/snapshot.ts");
  const schema = JSON.parse(readFileSync(join(repo, "contract", "huntaway-status.schema.json"), "utf8"));
  assert.equal(schema.$defs.alias.pattern, ALIAS_PATTERN.source, "one pattern, not two copies that can drift");
  const candidates = ["Studio", "My Mac mini", "a_b-c", "x", "A-", "A".repeat(32), "A".repeat(33), "$(id)", "`id`",
    'a"b', "a}b", "a\\b", "a\nb", "-x", "_x", " Studio", "Studio ", "~x", "Café", "a.b", "a:b", "a/b"];
  for (const lang of ["C", "en_US.UTF-8"]) {
    for (const alias of candidates) {
      const out = sh("install-local.sh", ["--alias", alias], freshHome(), { LC_ALL: lang, LANG: lang });
      assert.equal(out.status === 0, validAlias(alias), `${lang} ${JSON.stringify(alias)}: installer ${out.status}`);
    }
  }
});

test("--router writes the pipe choice and the fleet's names into the command; it needs the names; the two modes can't be mixed", async () => {
  const home = freshHome();
  const out = sh("install-local.sh", ["--router", "--alias", "Mini", "--fleet-aliases", "studio=Studio,mini=Mini"], home);
  assert.equal(out.status, 0, out.stderr);
  const text = readFileSync(join(home, ".local", "bin", "huntaway"), "utf8");
  assert.match(text, /: "\$\{HUNTAWAY_ENGINE:=pipe\}"; export HUNTAWAY_ENGINE/);
  assert.match(text, /\[ -n "\$\{HUNTAWAY_FLEET_ALIASES-\}" \] \|\| HUNTAWAY_FLEET_ALIASES='studio=Studio,mini=Mini'; export HUNTAWAY_FLEET_ALIASES/);
  // The written line, run by a shell: the names arrive as one word, spaces and all, and a name already set wins.
  const spaced = freshHome();
  const spacedOut = sh("install-local.sh", ["--router", "--fleet-aliases", "a=A,b-2=B two"], spaced);
  assert.equal(spacedOut.status, 0, spacedOut.stderr);
  const line = readFileSync(join(spaced, ".local", "bin", "huntaway"), "utf8").split("\n").find((l) => l.includes("HUNTAWAY_FLEET_ALIASES="));
  assert.ok(line, "the command sets the fleet's names");
  const value = (env) => {
    const r = spawnSync("sh", ["-c", `${line}\nprintf '%s' "$HUNTAWAY_FLEET_ALIASES"`], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    return r.stdout;
  };
  assert.equal(value({ PATH: process.env.PATH }), "a=A,b-2=B two");
  assert.equal(value({ PATH: process.env.PATH, HUNTAWAY_FLEET_ALIASES: "" }), "a=A,b-2=B two", "set but empty counts as unset");
  assert.equal(value({ PATH: process.env.PATH, HUNTAWAY_FLEET_ALIASES: "c=C" }), "c=C");
  assert.ok(!text.includes("HUNTAWAY_FLEET_CMD:=none"), "a Router install is not standalone");
  assert.match(text, /\[ -n "\$\{HUNTAWAY_FLEET_CMD-\}" \] \|\| HUNTAWAY_FLEET_CMD='.*\/\.local\/bin\/compute-router-subscriptions'; export HUNTAWAY_FLEET_CMD/);
  // Every refusal writes nothing: no command, no code copy, no leftovers.
  for (const args of [["--router", "--standalone", "--alias", "X"], ["--fleet-aliases", "a=A"], ["--fleet-aliases", ""],
    ["--router", "--alias", "X"], ["--router", "--fleet-aliases", ""], ["--router", "--fleet-aliases", 'a=A";touch x"'],
    ["--router", "--fleet-aliases", "a=$(id)"], ["--router", "--fleet-aliases", "a=`id`"], ["--router", "--fleet-aliases", "a=A}"],
    ["--router", "--fleet-aliases", "a=A\\"], ["--router", "--fleet-aliases", "a=A\nb=B"], ["--router", "--fleet-aliases", "a=A'"]]) {
    const refused = freshHome();
    const r = sh("install-local.sh", args, refused);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.ok(!existsSync(join(refused, ".local", "bin", "huntaway")), `${JSON.stringify(args)}: no command`);
    assert.deepEqual([...copies(refused), ...leftovers(refused)], [], `${JSON.stringify(args)}: no copy`);
  }
  // Agreement: the installer takes exactly the lists the product reads as at least one machine (it asks the product's
  // own reader, from the code it installs; here the same code as the tree under test), and a refused list writes no
  // file: no command, no code copy, no leftovers.
  const { fleetAliases } = await import("../src/status/snapshot.ts");
  for (const list of ["studio=Studio", "a=A,b-2=B two", "x=Name_1", "a = A", "Studio=Studio", "a=A,a=B", "a=A,b=a", "a=",
    "=A", "a=A,", ",", " ", "x", "=", "a=A=B", `${"n".repeat(33)}=A`, "-v", "--version", "-e"]) {
    const target = freshHome();
    const r = sh("install-local.sh", ["--router", "--fleet-aliases", list], target);
    const accepted = (fleetAliases(list)?.length ?? 0) > 0;
    assert.equal(r.status, accepted ? 0 : 2, `${JSON.stringify(list)}: ${r.stderr}`);
    if (!accepted) {
      assert.match(r.stderr, /--fleet-aliases takes nodeid=Name pairs/);
      assert.ok(!existsSync(join(target, ".local", "bin", "huntaway")), `${JSON.stringify(list)}: no command`);
      assert.deepEqual([...copies(target), ...leftovers(target)], [], `${JSON.stringify(list)}: no copy`);
    }
  }
  // Reinstalling the same commit with a bad list keeps the command that was there.
  const kept = freshHome();
  assert.equal(sh("install-local.sh", ["--router", "--fleet-aliases", "a=A"], kept).status, 0);
  const before = readFileSync(join(kept, ".local", "bin", "huntaway"), "utf8");
  const bad = sh("install-local.sh", ["--router", "--fleet-aliases", "a=A,a=B"], kept);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--fleet-aliases takes nodeid=Name pairs/);
  assert.equal(readFileSync(join(kept, ".local", "bin", "huntaway"), "utf8"), before);
  assert.equal(copies(kept).length, 1, "the installed copy stays");
  const plain = freshHome();
  assert.equal(sh("install-local.sh", [], plain).status, 0);
  assert.ok(!readFileSync(join(plain, ".local", "bin", "huntaway"), "utf8").includes("HUNTAWAY_ENGINE"),
    "without --router or --standalone no engine is written: ask then uses the owner's own key");
});

test("if the fleet names can't be checked (the reader fails), the install is refused and writes no file", () => {
  const clone = cloneRepo();
  writeFileSync(join(clone, "src", "status", "snapshot.ts"), 'throw new Error("broken reader");\n');
  const commit = (...args) => git(clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args);
  assert.equal(commit("add", "-A").status, 0);
  assert.equal(commit("commit", "--no-verify", "-qm", "a broken reader").status, 0);
  const home = freshHome();
  const out = sh("install-local.sh", ["--router", "--fleet-aliases", "a=A"], home, {}, clone);
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /could not check the fleet names/);
  assert.ok(!existsSync(join(home, ".local", "bin", "huntaway")));
  assert.deepEqual([...copies(home), ...leftovers(home)], []);
});

test("a home whose path holds quotes, a space, $, a backtick and '&': the command runs, and the helper's path comes through", () => {
  // The characters special inside shell quotes: ' in single quotes; ", $ and ` in double quotes (the fourth, a
  // backslash, is refused up front: "no HOME can inject into the command"). The space and '&' matter only outside
  // quotes, so they catch a missing quote. A newline is refused too, since the command is read line by line ("install
  // refuses bad input").
  const home = join(tempDir("huntaway-odd-"), "it's \"a\" $HOME `x` & more");
  mkdirSync(home);
  const out = sh("install-local.sh", ["--router", "--alias", "Odd", "--fleet-aliases", "studio=Studio"], home);
  assert.equal(out.status, 0, out.stderr);
  const cmd = join(home, ".local", "bin", "huntaway");
  // The written helper path, run by a shell, is exactly the one under this home.
  const line = readFileSync(cmd, "utf8").split("\n").find((l) => l.includes("HUNTAWAY_FLEET_CMD="));
  assert.ok(line, "the command names the fleet helper");
  const fleetCmd = (value) => {
    const r = spawnSync("sh", ["-c", `${line}\nprintf '%s' "$HUNTAWAY_FLEET_CMD"`],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...(value === undefined ? {} : { HUNTAWAY_FLEET_CMD: value }) } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const helperPath = join(home, ".local", "bin", "compute-router-subscriptions");
  assert.equal(fleetCmd(undefined), helperPath);
  assert.equal(fleetCmd(""), helperPath, "an empty value is filled in: only none turns the reading off");
  assert.equal(fleetCmd("none"), "none");
  // And the command runs from there (fleet reading off for this run, so no helper is needed).
  const run = spawnSync(cmd, ["status", "--json"], { encoding: "utf8", env: { ...baseEnv, HOME: home, HUNTAWAY_FLEET_CMD: "none" } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).machines.map((m) => m.alias), ["Odd"]);
});

test("a committed symbolic link in the code is refused, never installed", () => {
  const clone = cloneRepo();
  symlinkSync("/etc", join(clone, "src", "linked"));
  const c = git(clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "add", "-A");
  assert.equal(c.status, 0);
  assert.equal(git(clone, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
    "commit", "--no-verify", "-qm", "a link").status, 0);
  const home = freshHome();
  const out = sh("install-local.sh", [], home, {}, clone);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /the code copy contains a symbolic link/);
  assert.deepEqual(copies(home), []);
});

test("an install with neither --router nor --standalone is standalone: status never runs a fleet helper", () => {
  const home = freshHome();
  assert.equal(sh("install-local.sh", ["--alias", "Plain Box"], home).status, 0);
  const helperDir = join(home, ".local", "bin");
  const marker = join(home, "helper-ran");
  writeFileSync(join(helperDir, "compute-router-subscriptions"), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(helperDir, "compute-router-subscriptions"), 0o755);
  const out = spawnSync(join(helperDir, "huntaway"), ["status", "--json"], { encoding: "utf8", env: { ...baseEnv, HOME: home } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).machines.map((m) => m.alias), ["Plain Box"]);
  assert.ok(!existsSync(marker), "the Router's helper never ran");
});

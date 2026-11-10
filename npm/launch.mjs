// The launcher behind the package's three commands (docs in the README and SECURITY). Node refuses type stripping for
// any file under node_modules, so this plain JavaScript copies the package's code into an owner-only folder in your
// home, checks that copy against the package's checksums on every run, and runs the TypeScript from there.
// It uses Node's built-ins only, and starts nothing but the Node it was started with. Every refusal is one fixed line
// on stderr that names no user-controlled path. Importing this module runs nothing.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.1';
const PACKAGE_NAME = '@wrkdog/huntaway';
const HUNTAWAY_ENTRY = 'bin/huntaway.ts';
const COPY_NAME = `npm-${VERSION}`;
const MARKER = '.huntaway-npm';
const STAGING_PREFIX = '.npm-';
const GRAVE_PREFIX = '.npm-stale.';
const SHOWN_ROOT = '~/.local/share/huntaway';
const SHOWN_COPY = `${SHOWN_ROOT}/app/${COPY_NAME}`;
const HOUR_MS = 3_600_000;
// Only a folder with a name like this is ever removed by uninstall, listed by doctor or named in a message.
const COPY_NAME_RULE = /^npm-[0-9A-Za-z.+-]{1,64}$/u;
const WELL_FORMED_MARKER = /^[0-9a-f]{64}\n$/u;
const SETTINGS_TEMP = /^\.npm-settings\.json\.[0-9]+\.tmp$/u;
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

const NODE_TOO_OLD = 'huntaway: needs Node.js 22.18 or later';
// How each folder of the chain (HOME, ~/.local, ~/.local/share, R, R/app) is named in a refusal: never an absolute path.
const CHAIN_SHOWN = ['~', '~/.local', '~/.local/share', SHOWN_ROOT, `${SHOWN_ROOT}/app`];
const COPY_FAILED = 'huntaway: could not make the code copy';
const NOT_OUR_COPY = `huntaway: ${SHOWN_COPY} is not a copy this package made; make it writable and delete it yourself `
  + `(chmod -R u+w ${SHOWN_COPY}, then rm -rf it), then run huntaway again`;
const COPY_MISMATCH = `huntaway: the code copy in ${SHOWN_COPY} doesn't match this package; run 'huntaway uninstall', then try again`;
const NEEDS_SETUP = 'huntaway: run \'huntaway setup --standalone --alias "My Mac"\' first (or see the README for --router)';
const SETTINGS_BAD = 'huntaway: the settings file can\'t be read; run \'huntaway setup\' again';
const SETUP_USAGE = 'usage: huntaway setup [--alias NAME] [--standalone | --router --fleet-aliases LIST]';
const ROUTER_NEEDS_FLEET = 'huntaway: --router needs --fleet-aliases nodeid=Name,... (the machines in the Router\'s fleet reading)';
const FLEET_SHAPE = 'huntaway: --fleet-aliases takes nodeid=Name pairs separated by commas';
const FLEET_REFUSED = `${FLEET_SHAPE}: node ids in lower-case letters, digits and '-'; each Name a valid alias; none repeated`;
const FLEET_UNCHECKED = 'huntaway: could not check the fleet names';
const ALIAS_RULE = 'huntaway: the alias may use letters, digits, spaces, \'_\' and \'-\', at most 32, starting with a letter or digit and not ending with a space';
const STANDALONE_NEEDS_ALIAS = 'huntaway: --standalone needs --alias NAME (the name this machine reports as)';
const SETTINGS_UNWRITTEN = 'huntaway: could not write the settings file';
const UNINSTALL_USAGE = 'usage: huntaway uninstall [--purge-history]';
const UNINSTALL_FAILED = 'huntaway: could not remove everything; run huntaway uninstall again';
const REMOVE_PACKAGE = `Now remove the package: npm uninstall -g ${PACKAGE_NAME} (or: brew uninstall huntaway)`;
const NOT_STARTED = 'huntaway: could not start the code copy';
const STOPPED = 'huntaway: stopped unexpectedly';

// The launcher's own part of the usage: printed after the app's --help text, so its indent continues the usage block.
const HELP_LINES = [
  '       huntaway setup [--alias NAME] [--standalone | --router --fleet-aliases LIST]',
  '       huntaway uninstall [--purge-history]',
  '       huntaway --version',
];

// The exact files `uninstall --purge-history` deletes, the same as uninstall-local.sh; requests.db.creating is a folder.
const HISTORY_FILES = [
  ...['requests.db', 'runs.db', 'spend.sqlite'].flatMap((f) => [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]),
  'runs.json',
  'key',
];
const HISTORY_FOLDER = 'requests.db.creating';
const KEY_TEMP = /^key\.[0-9].*\.tmp$/su;

class Refusal extends Error {
  constructor(line, exitCode = 1) {
    super(line);
    this.line = line;
    this.exitCode = exitCode;
  }
}
const refuse = (line, exitCode = 1) => { throw new Refusal(line, exitCode); };
const print = (line) => { process.stdout.write(`${line}\n`); };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const myUid = () => process.getuid();
const isGone = (error) => error?.code === 'ENOENT';

/** lstat, with null only for a path that isn't there; any other failure is the caller's to treat as a failure. */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

/** Sorted names, or an empty list when the folder isn't there. */
function namesIn(folder) {
  try {
    return readdirSync(folder).sort();
  } catch (error) {
    if (isGone(error)) return [];
    throw error;
  }
}

/** Read a file only if it is a regular file: never through a link, and never blocking on a pipe or a device. */
function readRegular(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The test seam (pure helpers).

/** Whether a Node version, in process.versions.node form (no `v`), is at least 22.18.0. */
export function nodeOk(version) {
  const parts = version.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)/u);
  if (parts === null) return false;
  const [major, minor] = [Number(parts[1]), Number(parts[2])];
  return major > 22 || (major === 22 && minor >= 18);
}

const cleanPath = (path) => path !== '' && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
  && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

/**
 * SHA256SUMS as {hash, path} entries, or null if any of it doesn't parse: it ends with exactly one newline, has no blank
 * line and no CR, and every line is 64 lower-case hex digits, two spaces, then a clean path. Whether the required
 * package.json line is there is the caller's check (loadPayload): a missing line is not a parse failure.
 */
export function parseSums(text) {
  if (typeof text !== 'string' || !text.endsWith('\n') || text.includes('\r')) return null;
  const entries = [];
  for (const line of text.slice(0, -1).split('\n')) {
    const hash = line.slice(0, 64);
    const path = line.slice(66);
    if (!/^[0-9a-f]{64}$/u.test(hash) || line.slice(64, 66) !== '  ' || !cleanPath(path)) return null;
    entries.push({ hash, path });
  }
  return entries;
}

/** The entries that are copied and checked, in order: bin/, src/, contract/ and pipe/ (not pipe/test/), plus package.json. */
export function payloadOf(entries) {
  return entries.filter(({ path }) => path === 'package.json'
    || (/^(?:bin|src|contract|pipe)\//u.test(path) && !path.startsWith('pipe/test/')));
}

/**
 * The arguments after `setup`, read by the same rules, in the same order and with the same messages as
 * install-local.sh. An empty alias counts as none, as it does there. The fleet reader's own check comes later.
 */
export function parseSetup(argv) {
  const usage = { ok: false, exitCode: 2, message: SETUP_USAGE };
  const refused = (message) => ({ ok: false, exitCode: 2, message });
  let alias = '';
  let standalone = false;
  let router = false;
  let fleet = '';
  let fleetGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--alias') {
      if (i + 1 >= argv.length) return usage;
      alias = argv[i += 1];
    } else if (arg === '--standalone') {
      standalone = true;
    } else if (arg === '--router') {
      router = true;
    } else if (arg === '--fleet-aliases') {
      if (i + 1 >= argv.length) return usage;
      fleet = argv[i += 1];
      fleetGiven = true;
    } else {
      return usage;
    }
  }
  if (standalone && router) return usage;
  if (fleetGiven && !router) return usage;
  if (router && fleet === '') return refused(ROUTER_NEEDS_FLEET);
  if (fleet !== '' && (!/^[A-Za-z0-9 _=,-]*$/u.test(fleet) || fleet.length > 512)) return refused(FLEET_SHAPE);
  if (alias !== '' && (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/u.test(alias) || alias.endsWith(' ') || alias.length > 32)) {
    return refused(ALIAS_RULE);
  }
  if (standalone && alias === '') return refused(STANDALONE_NEEDS_ALIAS);
  const mode = standalone ? 'standalone' : router ? 'router' : null;
  return { ok: true, settings: { alias: alias === '' ? null : alias, mode, fleetAliases: router ? fleet : null } };
}

// ---------------------------------------------------------------------------------------------------------------------
// HOME and the folders.

/** HOME by install-local.sh's rules, with its messages. */
function homeFolder() {
  let home = process.env.HOME ?? '';
  if (!home.startsWith('/')) refuse('huntaway: HOME must be an absolute path');
  if (home.includes('\n')) refuse('huntaway: HOME must not contain a newline');
  if (home.includes('\\')) refuse('huntaway: HOME must not contain a backslash (Node cannot load code from such a path)');
  home = home.replace(/\/+$/u, '');
  // Only whether it's there: whether it's a real folder of the user's is the folder check's, with its message.
  let exists = false;
  try {
    exists = home !== '' && statSync(home) !== null;
  } catch {
    exists = false;
  }
  if (!exists) refuse('huntaway: HOME must be an existing folder other than /');
  return home;
}

function foldersOf(home) {
  const local = join(home, '.local');
  const share = join(local, 'share');
  const root = join(share, 'huntaway');
  const app = join(root, 'app');
  const chain = [home, local, share, root, app];
  const entries = chain.map((folder, i) => ({ folder, shown: CHAIN_SHOWN[i] }));
  return { home, chain, entries, root, app, copy: join(app, COPY_NAME), settings: join(root, 'npm-settings.json') };
}

/** lstat for the folder checks: an unexpected failure is refused with the folder's ~ name and the error code. */
function lstatFolder(folder, shown) {
  try {
    return lstatOrNull(folder);
  } catch (error) {
    return refuse(folderError(shown, error));
  }
}
const folderError = (shown, error) => `huntaway: refusing: could not check or make ${shown} (${error?.code ?? 'error'})`;

/**
 * ask.ts's safeFolder rule, with a real folder and an owner always required, and a message that says what to do.
 * Look at the folders of the chain that exist, in order, changing nothing, and refuse the first link or non-folder,
 * else the first folder that isn't the user's, else every folder group or others can write to, with the one chmod
 * that clears them all. A refused folder is never repaired. A missing folder never ends the walk: every later folder is
 * still looked at, since another process may make one at any time. A link ends it. So does a failed lstat, refused
 * with its code, unless a folder that isn't the user's was already seen, which is then the one refused.
 */
function checkChain(entries, mustExist = false) {
  let link = null;
  let foreign = null;
  const writable = [];
  for (const { folder, shown } of entries) {
    let st;
    try {
      st = lstatOrNull(folder);
    } catch (error) {
      if (foreign !== null) break;
      refuse(folderError(shown, error));
    }
    if (st === null && mustExist) refuse(folderError(shown, { code: 'ENOENT' }));
    if (st === null) continue;
    if (!st.isDirectory()) {
      link = shown;
      break;
    }
    if (st.uid !== myUid()) foreign ??= shown;
    else if ((st.mode & 0o022) !== 0) writable.push(shown);
  }
  if (link !== null) refuse(`huntaway: refusing: ${link} is a link or isn't a folder; it must be a real folder of yours`);
  if (foreign !== null) refuse(`huntaway: refusing: ${foreign} isn't yours; it must be a real folder of yours`);
  if (writable.length > 0) {
    refuse(`huntaway: refusing: your group or others can write to ${writable.join(', ')}; `
      + `clear it with: chmod go-w ${writable.join(' ')} then run huntaway again`);
  }
}

/** Check every folder, making the missing ones at 0700 and checking each again. A folder that fails is refused, never repaired. */
function prepareFolders(folders) {
  checkChain(folders.entries);
  for (const entry of folders.entries) {
    if (lstatFolder(entry.folder, entry.shown) === null) {
      try {
        mkdirSync(entry.folder, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') refuse(folderError(entry.shown, error));
      }
    }
    // Whatever is there now, made by us or by a process that won a race, gets the same checks.
    checkChain([entry], true);
  }
  try {
    chmodSync(folders.root, 0o700);
  } catch (error) {
    refuse(folderError(SHOWN_ROOT, error));
  }
}

/** The same checks on the folders that already exist, creating nothing (uninstall). */
function checkExistingFolders(folders) {
  checkChain(folders.entries);
}

// ---------------------------------------------------------------------------------------------------------------------
// Removing things.

/**
 * What can be seen of a tree, only reading: nothing is followed or changed. `foreign` means it holds a link, a special
 * file or anything that isn't the user's, which a copy never does. `closed` lists the folders of the user's that their
 * mode keeps this scan out of, so what's inside those is still unknown.
 */
function scanTree(folder) {
  const found = { foreign: false, closed: [] };
  const visit = (path) => {
    const st = lstatSync(path);
    if (st.uid !== myUid() || !(st.isDirectory() || st.isFile())) found.foreign = true;
    else if (st.isDirectory()) {
      if ((st.mode & 0o500) !== 0o500) found.closed.push(path);
      else for (const name of readdirSync(path)) visit(join(path, name));
    }
  };
  visit(folder);
  return found;
}

/** Whether a folder is the user's and holds only regular files and folders, all of it readable. It changes nothing. */
function plainTree(folder) {
  const { foreign, closed } = scanTree(folder);
  return !foreign && closed.length === 0;
}

/**
 * Uninstall's version of plainTree, which can also get past mode damage: it makes each closed folder of the user's
 * writable and looks again, so it never follows a link. It is false, with nothing more changed, as soon as what it can
 * see rules the folder out (`wanted` adds the caller's own test), so callers leave such a folder whole. A folder opened
 * before something inside it ruled the tree out stays open: the next run can then see why, and refuse accordingly.
 */
function openTree(folder, wanted = () => true) {
  const opened = new Set();
  for (;;) {
    const { foreign, closed } = scanTree(folder);
    if (foreign || !wanted()) return false;
    if (closed.length === 0) return true;
    for (const path of closed) {
      if (opened.has(path)) throw new Error('a folder stayed closed');
      opened.add(path);
      chmodSync(path, 0o700);
    }
  }
}

/**
 * Make a folder writable and remove it, never following, removing or changing a link. A link, a special file or a file
 * that isn't the user's stops it; callers check the tree first, so that only happens if the folder changes meanwhile.
 */
function removeTree(folder) {
  const st = lstatSync(folder);
  if (!st.isDirectory() || st.uid !== myUid()) throw new Error('not a folder of the user\'s');
  chmodSync(folder, 0o700);
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    const child = lstatSync(path);
    if (child.isDirectory()) {
      removeTree(path);
    } else {
      if (!child.isFile()) throw new Error('not a regular file');
      if (child.uid !== myUid()) throw new Error('not a file of the user\'s');
      unlinkSync(path);
    }
  }
  rmdirSync(folder);
}

/** Leftover staging folders over an hour old, renamed away first (only one process can win that), then removed. */
function sweepStaging(app) {
  let names;
  try {
    names = namesIn(app);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    try {
      const path = join(app, name);
      const st = lstatSync(path);
      if (!st.isDirectory() || st.uid !== myUid() || Date.now() - st.mtimeMs <= HOUR_MS || !plainTree(path)) continue;
      if (name.startsWith(GRAVE_PREFIX)) {
        removeTree(path);                    // a deletion that was itself cut short: its name already claims it
      } else {
        const grave = join(app, `${GRAVE_PREFIX}${process.pid}.${name}`);
        renameSync(path, grave);
        removeTree(grave);
      }
    } catch {
      // Another run won the rename, or the removal failed: a later sweep or `huntaway uninstall` gets it.
    }
  }
}

/** The user's own setup temporary files in R: those over an hour old, or all of them for uninstall. */
function sweepSettingsTemps(root, all) {
  let failed = false;
  let names = [];
  try {
    names = namesIn(root);
  } catch {
    return !all;
  }
  for (const name of names) {
    if (!SETTINGS_TEMP.test(name)) continue;
    try {
      const path = join(root, name);
      const st = lstatSync(path);
      if (st.isFile() && st.uid === myUid() && (all || Date.now() - st.mtimeMs > HOUR_MS)) unlinkSync(path);
    } catch {
      failed = true;
    }
  }
  return !failed;
}

// ---------------------------------------------------------------------------------------------------------------------
// The code copy.

const packageRoot = () => fileURLToPath(new URL('..', import.meta.url));
const sumsLine = ({ hash, path }) => `${hash}  ${path}`;

/** The package's payload and its digest, or null for a missing or unparseable file or one with no package.json line. */
function loadPayload() {
  let entries;
  try {
    entries = parseSums(readRegular(join(packageRoot(), 'SHA256SUMS')).toString('utf8'));
  } catch {
    return null;
  }
  if (entries === null || !entries.some(({ path }) => path === 'package.json')) return null;
  const payload = payloadOf(entries);
  return { payload, digest: sha256(payload.map(sumsLine).join('\n')) };
}

/** Whether a package file's folders below the package root are real folders, so no link leads out of the package. */
function packageFoldersReal(path, seen) {
  const segments = path.split('/').slice(0, -1);
  let folder = packageRoot();
  for (const segment of segments) {
    folder = join(folder, segment);
    if (seen.has(folder)) continue;
    if (!lstatSync(folder).isDirectory()) return false;
    seen.add(folder);
  }
  return true;
}

/** The mode a payload file has in the copy, from the x bits of the packed file (which must be a regular file). */
function copyMode(path, seen) {
  if (!packageFoldersReal(path, seen)) throw new Error('a link in the package');
  const st = lstatSync(join(packageRoot(), path));
  if (!st.isFile()) throw new Error('not a regular file');
  return (st.mode & 0o111) !== 0 ? 0o500 : 0o400;
}

/** Make the copy. True when it's in place, false when another run got there first. Anything else is a refusal. */
function buildCopy(folders, { payload, digest }) {
  let staging = null;
  try {
    staging = mkdtempSync(join(folders.app, `${STAGING_PREFIX}${VERSION}.`));
    const seen = new Set();
    const made = new Set();
    for (const { hash, path } of payload) {
      const mode = copyMode(path, seen);
      const bytes = readRegular(join(packageRoot(), path));           // read once: these same bytes are checked and written
      if (sha256(bytes) !== hash) throw new Error('a package file doesn\'t match its checksum');
      const dest = join(staging, path);
      for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) made.add(parent);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, bytes, { flag: 'wx', mode });
    }
    writeFileSync(join(staging, MARKER), `${digest}\n`, { flag: 'wx', mode: 0o400 });
    for (const folder of made) chmodSync(join(staging, folder), 0o500);
    try {
      renameSync(staging, folders.copy);
    } catch (error) {
      if (lstatOrNull(folders.copy) === null) throw error;
      removeTree(staging);
      return false;
    }
    staging = null;
    chmodSync(folders.copy, 0o500);
    return true;
  } catch {
    if (staging !== null) {
      try {
        removeTree(staging);
      } catch {
        // The sweep gets it in an hour.
      }
    }
    return refuse(COPY_FAILED);
  }
}

/**
 * Check the existing copy, every run. Any mismatch is refused, never repaired: the one thing it may finish is the chmod
 * that seals a new copy. The refusal sends the user where recovery works: a link, a special file or anything not the
 * user's is what uninstall leaves alone, so that line says to delete it by hand, and uninstall can remove anything else.
 */
function checkCopy(folders, sums) {
  const { copy } = folders;
  const top = lstatSync(copy);
  if (!top.isDirectory() || top.uid !== myUid()) refuse(NOT_OUR_COPY);
  // A closed folder hides what's in it. Uninstall opens that folder, and if it finds such a thing there, the next run
  // sees it here.
  if (scanTree(copy).foreign) refuse(NOT_OUR_COPY);
  if (sums === null) refuse(COPY_MISMATCH);

  // Then the marker: a foreign one means the copy isn't ours, whatever else is wrong with it.
  let marker;
  try {
    marker = lstatSync(join(copy, MARKER));
  } catch (error) {
    if (isGone(error)) refuse(NOT_OUR_COPY);
    refuse(COPY_MISMATCH);                // the folder can't be entered: its mode was changed
  }
  if (!marker.isFile() || marker.uid !== myUid() || marker.size !== 65) refuse(NOT_OUR_COPY);
  let text;
  try {
    text = readRegular(join(copy, MARKER)).toString('utf8');
  } catch {
    refuse(COPY_MISMATCH);                // the marker can't be read: its mode was changed
  }
  if (!WELL_FORMED_MARKER.test(text) || text !== `${sums.digest}\n`) refuse(NOT_OUR_COPY);

  const expectedFiles = new Map(sums.payload.map((entry) => [entry.path, entry]));
  const expectedFolders = new Set();
  for (const { path } of sums.payload) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) expectedFolders.add(parent);
  }
  const seen = new Set();
  const found = new Set();
  let mismatch = (marker.mode & 0o7777) !== 0o400;
  const walk = (relative) => {
    for (const name of readdirSync(join(copy, relative))) {
      if (relative === '' && name === MARKER) continue;
      const path = relative === '' ? name : `${relative}/${name}`;
      const full = join(copy, path);
      const st = lstatSync(full);
      if (st.isDirectory()) {
        if (!expectedFolders.has(path) || (st.mode & 0o7777) !== 0o500) mismatch = true;
        walk(path);
      } else if (!expectedFiles.has(path) || !st.isFile() || st.uid !== myUid()) {
        mismatch = true;
      } else {
        found.add(path);
        if ((st.mode & 0o7777) !== copyMode(path, seen)) mismatch = true;
        if (sha256(readRegular(full)) !== expectedFiles.get(path).hash) mismatch = true;
      }
    }
  };
  try {
    walk('');
  } catch {
    mismatch = true;
  }
  if (mismatch || found.size !== expectedFiles.size) refuse(COPY_MISMATCH);

  const mode = top.mode & 0o7777;
  if (mode === 0o700) {
    try {
      chmodSync(copy, 0o500);               // the crash window between the rename and the chmod: this finishes that step
    } catch {
      refuse(COPY_MISMATCH);
    }
  } else if (mode !== 0o500) {
    refuse(COPY_MISMATCH);
  }
}

/** Make the copy if there isn't one, and check it if there is. */
function ensureCopy(folders) {
  sweepStaging(folders.app);
  const sums = loadPayload();
  try {
    if (lstatOrNull(folders.copy) === null) {
      if (sums === null) refuse(COPY_FAILED);
      if (buildCopy(folders, sums)) return sums;
    }
    checkCopy(folders, sums);
    return sums;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse(COPY_MISMATCH);
  }
}

/** Whether a folder holds a well-formed marker, from any package version; null when a mode keeps it from being read. */
function markerState(folder) {
  let marker;
  try {
    marker = lstatSync(join(folder, MARKER));
  } catch (error) {
    return isGone(error) ? false : null;
  }
  if (!marker.isFile() || marker.uid !== myUid() || marker.size !== 65) return false;
  try {
    return WELL_FORMED_MARKER.test(readRegular(join(folder, MARKER)).toString('utf8'));
  } catch {
    return null;
  }
}

/** A real folder of the user's holding a marker that can be read and is well-formed. It changes nothing. */
function isMarkedCopy(folder) {
  try {
    const st = lstatSync(folder);
    return st.isDirectory() && st.uid === myUid() && markerState(folder) === true;
  } catch {
    return false;
  }
}

/**
 * Whether uninstall removes this copy: a marked tree of the user's holding only regular files and folders. Mode damage
 * doesn't rule it out, so closed folders and an unreadable marker are opened on the way to that answer.
 */
function removableCopy(folder) {
  if (!openTree(folder, () => markerState(folder) !== false)) return false;
  if (markerState(folder) === null) chmodSync(join(folder, MARKER), 0o400);
  return markerState(folder) === true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings and the environment.

function validSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join() !== 'alias,fleetAliases,mode') return false;
  const { alias, mode, fleetAliases } = value;
  if (alias !== null && (typeof alias !== 'string' || alias === '')) return false;
  if (fleetAliases !== null && (typeof fleetAliases !== 'string' || fleetAliases === '')) return false;
  if (mode !== null && mode !== 'standalone' && mode !== 'router') return false;
  // A file setup could have written: the same rules setup itself applies.
  const argv = [];
  if (alias !== null) argv.push('--alias', alias);
  if (mode !== null) argv.push(`--${mode}`);
  if (fleetAliases !== null) argv.push('--fleet-aliases', fleetAliases);
  return parseSetup(argv).ok;
}

/** The settings, or null when there is no file. An unreadable or invalid file is a refusal. */
function readSettings(folders) {
  let settings;
  try {
    const st = lstatOrNull(folders.settings);
    if (st === null) return null;
    if (!st.isFile() || st.uid !== myUid()) refuse(SETTINGS_BAD);
    settings = JSON.parse(readRegular(folders.settings).toString('utf8'));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse(SETTINGS_BAD);
  }
  if (!validSettings(settings)) refuse(SETTINGS_BAD);
  return settings;
}

/** The temporary file, then an atomic rename: a reader sees the old settings or the new, never half of either. */
function writeSettings(folders, settings) {
  const temp = join(folders.root, `.npm-settings.json.${process.pid}.tmp`);
  try {
    if (lstatOrNull(temp) !== null) unlinkSync(temp);
    writeFileSync(temp, `${JSON.stringify(settings)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, folders.settings);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Swept after an hour.
    }
    refuse(SETTINGS_UNWRITTEN);
  }
}

/** The installer's wrapper, as an environment: each variable is set only when it's unset or empty. */
function environmentFor(settings, home) {
  const env = { ...process.env };
  const fill = (name, value) => {
    if (env[name] === undefined || env[name] === '') env[name] = value;
  };
  if (settings.alias !== null) fill('HUNTAWAY_ALIAS', settings.alias);
  if (settings.mode === 'standalone') {
    fill('HUNTAWAY_FLEET_CMD', 'none');
    fill('HUNTAWAY_ENGINE', 'anthropic');
  } else if (settings.mode === 'router') {
    fill('HUNTAWAY_ENGINE', 'pipe');
    fill('HUNTAWAY_FLEET_CMD', join(home, '.local', 'bin', 'compute-router-subscriptions'));
    fill('HUNTAWAY_FLEET_ALIASES', settings.fleetAliases);
  }
  return env;
}

// ---------------------------------------------------------------------------------------------------------------------
// Running the app.

/**
 * Run an entry of the copy, with the caller's own umask. The child shares the terminal's process group, so Ctrl-C and a
 * hangup already reach it: the launcher ignores those while it runs, so they're never delivered twice, and forwards
 * SIGTERM once. Resolves to the child's code and signal.
 */
function runEntry(folders, entry, args, env, userUmask) {
  return new Promise((resolve) => {
    let forwarded = false;
    let child = null;
    const ignore = () => {};
    const forward = () => {
      if (forwarded) return;
      forwarded = true;
      child?.kill('SIGTERM');
    };
    const settle = (result) => {
      process.removeListener('SIGINT', ignore);
      process.removeListener('SIGHUP', ignore);
      process.removeListener('SIGTERM', forward);
      resolve(result);
    };
    process.on('SIGINT', ignore);
    process.on('SIGHUP', ignore);
    process.on('SIGTERM', forward);
    process.umask(userUmask);
    child = spawn(process.execPath, [...NODE_FLAGS, join(folders.copy, entry), ...args], { stdio: 'inherit', env });
    child.once('error', () => settle({ code: null, signal: null, failed: true }));
    child.once('close', (code, signal) => settle({ code, signal, failed: false }));
  });
}

/** The launcher's exit: the child's code, or, if it died by a signal, the same signal raised on the launcher itself. */
function finish({ code, signal, failed }) {
  if (failed) refuse(NOT_STARTED);
  if (signal !== null) {
    process.exitCode = 128 + (osConstants.signals[signal] ?? 0);    // if that signal happens to be ignored here
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
}

function requireEntry(entry, sums) {
  if (!sums.payload.some(({ path }) => path === entry)) refuse(`huntaway: this package has no ${entry}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The commands the launcher answers.

async function runHelp(entry, userUmask) {
  const folders = foldersOf(homeFolder());
  prepareFolders(folders);
  const sums = ensureCopy(folders);
  requireEntry(entry, sums);
  const result = await runEntry(folders, entry, ['--help'], process.env, userUmask);
  if (!result.failed && result.signal === null && result.code === 0) HELP_LINES.forEach(print);
  finish(result);
}

/** The product's own reader decides whether the fleet's names are usable, run on the copy, as the installer does. */
function checkFleetNames(folders, list) {
  const script = `
import { pathToFileURL } from "node:url";
const { fleetAliases } = await import(pathToFileURL(process.argv[1]).href);
const machines = fleetAliases(process.argv[2]);
process.exit(machines !== null && machines.length > 0 ? 0 : 3);`;
  const reader = join(folders.copy, 'src', 'status', 'snapshot.ts');
  // The `--` keeps a list that starts with '-' from being read as an option of node's.
  const result = spawnSync(process.execPath, [...NODE_FLAGS, '--input-type=module', '-e', script, '--', reader, list], { stdio: 'ignore' });
  if (result.status === 3) refuse(FLEET_REFUSED, 2);
  if (result.status !== 0) refuse(FLEET_UNCHECKED);
}

function runSetup(argv) {
  const parsed = parseSetup(argv);
  if (!parsed.ok) refuse(parsed.message, parsed.exitCode);
  const folders = foldersOf(homeFolder());
  prepareFolders(folders);
  sweepSettingsTemps(folders.root, false);
  const { settings } = parsed;
  if (settings.fleetAliases !== null) {
    ensureCopy(folders);
    checkFleetNames(folders, settings.fleetAliases);
  }
  writeSettings(folders, settings);
  print(`huntaway ${VERSION} set up: ${SHOWN_ROOT}/npm-settings.json`);
  if (settings.mode === 'standalone') {
    print('this machine only: huntaway status reports this machine, and huntaway ask uses your own API key (--engine anthropic) unless you pass --engine pipe');
  } else if (settings.mode === 'router') {
    print('Router setup: huntaway ask runs through the Pipe on your subscriptions');
  } else {
    print('no mode set: huntaway uses its built-in defaults');
  }
  print('next: huntaway doctor');
}

/** Remove one file of the history: only a regular file of the user's, never a link. True unless the removal failed. */
function removeOwnFile(path) {
  try {
    const st = lstatOrNull(path);
    if (st !== null && st.isFile() && st.uid === myUid()) unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function purgeHistory(root) {
  let ok = true;
  for (const name of HISTORY_FILES) ok = removeOwnFile(join(root, name)) && ok;
  try {
    for (const name of namesIn(root)) {
      if (KEY_TEMP.test(name)) ok = removeOwnFile(join(root, name)) && ok;
    }
    const creating = join(root, HISTORY_FOLDER);
    const st = lstatOrNull(creating);
    if (st !== null && st.uid === myUid()) {
      if (st.isDirectory()) {
        if (openTree(creating)) removeTree(creating);    // one holding a link or special file stays whole
      }
      else if (st.isFile()) unlinkSync(creating);
    }
  } catch {
    ok = false;
  }
  return ok;
}

/**
 * Each marked copy and leftover staging folder. Anything else in the app folder stays, and only copy-named folders are
 * named. A copy holds only regular files and folders, all the user's, so a marked one holding anything else isn't one
 * this launcher made: it's left whole and named. A staging folder like that is left whole too, unnamed.
 *
 * A copy is renamed before it's emptied, so its own name never holds a copy without its marker. If this is cut short,
 * the next uninstall finishes the job: the claimed name starts with the staging prefix, which has no age limit here.
 */
function removeCopies(app) {
  let ok = true;
  let names;
  try {
    names = namesIn(app);
  } catch {
    return false;
  }
  for (const name of names) {
    const path = join(app, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory()) continue;
      if (name.startsWith(STAGING_PREFIX)) {
        if (st.uid === myUid() && openTree(path)) removeTree(path);
      } else if (COPY_NAME_RULE.test(name)) {
        if (removableCopy(path)) {
          const claimed = join(app, `${GRAVE_PREFIX}${process.pid}.${name}`);
          renameSync(path, claimed);
          removeTree(claimed);
        } else {
          print(`left ${SHOWN_ROOT}/app/${name}: not made by this launcher`);
        }
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** Remove a folder that may be empty. False only for a real failure: already gone or not empty is a normal outcome. */
const removeIfEmpty = (folder) => {
  try {
    rmdirSync(folder);
    return true;
  } catch (error) {
    return isGone(error) || error.code === 'ENOTEMPTY' || error.code === 'EEXIST';
  }
};

function runUninstall(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--purge-history')) refuse(UNINSTALL_USAGE, 2);
  const purge = argv.length === 1;
  const folders = foldersOf(homeFolder());
  checkExistingFolders(folders);
  if (lstatOrNull(folders.root) === null) {
    print('huntaway: nothing to remove');
    print(REMOVE_PACKAGE);
    return;
  }
  let ok = removeCopies(folders.app);
  ok = removeOwnFile(folders.settings) && ok;
  ok = sweepSettingsTemps(folders.root, true) && ok;
  if (purge) ok = purgeHistory(folders.root) && ok;
  ok = removeIfEmpty(folders.app) && ok;
  ok = removeIfEmpty(folders.root) && ok;
  if (!ok) refuse(UNINSTALL_FAILED);
  if (!purge) print('huntaway code removed; history kept');
  else if (lstatOrNull(folders.root) === null) print('huntaway code removed; history deleted');
  else print(`huntaway code removed; history deleted; other files were left in ${SHOWN_ROOT}`);
  print(REMOVE_PACKAGE);
}

/** Doctor's extra lines: other copies, by name only, and only names that fit the rule. */
function printCopies(folders) {
  print(`info copy: ${COPY_NAME} (in use)`);
  for (const name of namesIn(folders.app)) {
    if (name === COPY_NAME || !COPY_NAME_RULE.test(name)) continue;
    if (isMarkedCopy(join(folders.app, name))) print(`info old copy: ${name} (huntaway uninstall removes it)`);
  }
}

async function runCommand(entry, argv, userUmask) {
  const isHuntaway = entry === HUNTAWAY_ENTRY;
  const folders = foldersOf(homeFolder());
  prepareFolders(folders);
  const sums = ensureCopy(folders);
  let env = process.env;
  if (isHuntaway) {
    const settings = readSettings(folders);
    if (settings === null) refuse(NEEDS_SETUP);
    env = environmentFor(settings, folders.home);
  }
  requireEntry(entry, sums);
  const result = await runEntry(folders, entry, argv, env, userUmask);
  if (isHuntaway && argv[0] === 'doctor' && !result.failed && result.signal === null) printCopies(folders);
  finish(result);
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * One command of the package: `entry` is the file it runs from the copy. `--version` reads nothing. Setup makes the copy
 * only for a fleet list, which needs the copy's own reader. Uninstall creates nothing and skips the copy check, so a
 * tampered copy can still be removed. Help and every other command check the folders and the copy first.
 */
export async function main(entry) {
  // A reader that goes away must not turn into a stack trace, which would show paths.
  const quiet = () => {};
  process.stdout.on('error', quiet);
  process.stderr.on('error', quiet);
  try {
    if (!nodeOk(process.versions.node)) refuse(NODE_TOO_OLD);
    const argv = process.argv.slice(2);
    const isHuntaway = entry === HUNTAWAY_ENTRY;
    if (argv.length === 1 && argv[0] === '--version') {
      print(isHuntaway ? `huntaway ${VERSION}` : `pipe (huntaway ${VERSION})`);
      return;
    }
    // Everything the launcher itself creates is the owner's alone; the app gets the caller's umask back.
    const userUmask = process.umask(0o077);
    if (isHuntaway && argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) await runHelp(entry, userUmask);
    else if (isHuntaway && argv[0] === 'setup') runSetup(argv.slice(1));
    else if (isHuntaway && argv[0] === 'uninstall') runUninstall(argv.slice(1));
    else await runCommand(entry, argv, userUmask);
  } catch (error) {
    const refusal = error instanceof Refusal;
    process.stderr.write(`${refusal ? error.line : STOPPED}\n`);
    process.exitCode = refusal ? error.exitCode : 1;
  }
}

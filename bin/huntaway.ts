#!/usr/bin/env -S node --experimental-strip-types

import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { paidDoctor, runKey, spendLine } from '../src/ask/paid.ts';
import { chosenEngine, parseAskArgs, runAsk } from '../src/ask/ask.ts';
import { formatRunsHuman, getHuntawayHome, getWorkerAlias, loadLocalRuns } from '../src/status/runs.ts';
import { ENGINE_NAMES, paidEngine, pipeConfigured, withoutApiKeys, type PaidEngineName } from '../src/ask/engines.ts';
import {
  buildSnapshot,
  fleetAliases,
  isStandalone,
  machinesFromFleet,
  readingTime,
  standaloneSnapshot,
  type Subscription,
} from '../src/status/snapshot.ts';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

type ParsedArgs =
  | { command: 'status'; json: boolean; fleetFile?: string }
  | { command: 'doctor'; fleetFile?: string }
  | { command: 'ship'; argv: string[] }
  | { command: 'ask'; argv: string[] }
  | { command: 'key'; action: 'set' | 'remove'; engine: PaidEngineName };

type FleetResult =
  | { ok: true; fleet: unknown; count: number; aliases: string[] }
  | { ok: false; error: string; exitCode: number };

// The shipping kit is optional: a copy without src/ship/ (the public release) has no `ship` command. When it is
// present it loads up front, as a static import would, so a broken kit still fails every command before any runs.
// Only ship.ts is checked: a kit missing one of its other files fails to load, loudly.
const SHIP_MODULE = new URL('../src/ship/ship.ts', import.meta.url);
const SHIP = existsSync(SHIP_MODULE)
  ? ((await import(SHIP_MODULE.href)) as { runShip: (argv: string[]) => Promise<number> })
  : null;
const HAS_SHIP = SHIP !== null;

const RUNS_UNREADABLE = 'Error: the local runs can\'t be read right now; try again in a moment\n';
const NO_ALIAS = 'Error: standalone status needs this machine\'s name: set HUNTAWAY_ALIAS (install with --alias NAME)\n';

const USAGE =
  `Usage: huntaway ask [--engine ${ENGINE_NAMES.join('|')}] [--family claude|codex] [--model NAME] [--effort low|medium|high] [--timeout SECONDS] [--max-tokens N] QUESTION|-|-- QUESTION...\n` +
  '       huntaway status [--json] [--fleet-file PATH]\n' +
  '       huntaway doctor [--fleet-file PATH]\n' +
  '       huntaway key set|remove anthropic|openai\n' +
  (HAS_SHIP ? '       huntaway ship <doctor|preflight|land|status|brief> [options]\n' : '') +
  'Exit codes: 0 ok, 1 a check failed (the fleet or the local runs could not be read, or Node is too old), 2 usage.\n' +
  'A --fleet-file whose name starts with "-" must be written as ./-name.\n';

function printUsageAndExit(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === 'ship') return { command: 'ship', argv: argv.slice(1) };
  // Help is asked for only before a `--`: after it, "-h" is part of a question.
  const options = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  if (options.some((a) => a === '--help' || a === '-h') || (argv.length === 1 && argv[0] === 'help')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const command = argv[0];
  if (command === 'key') {
    if (argv.length !== 3 || !['set', 'remove'].includes(argv[1]) || !paidEngine(argv[2])) printUsageAndExit();
    return { command: 'key', action: argv[1] as 'set' | 'remove', engine: argv[2] as PaidEngineName };
  }
  if (command === 'ask') return { command: 'ask', argv: argv.slice(1) };
  if (command !== 'status' && command !== 'doctor') {
    printUsageAndExit();
  }
  let json = false;
  let fleetFile: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json' && command === 'status' && !json) {
      json = true;
    } else if ((arg === '--fleet-file' || arg.startsWith('--fleet-file=')) && fleetFile === undefined) {
      const value = arg === '--fleet-file' ? argv[++i] : arg.slice('--fleet-file='.length);
      if (value === undefined || value === '' || value.startsWith('-')) printUsageAndExit();
      fleetFile = value;
    } else {
      printUsageAndExit();
    }
  }
  return command === 'status' ? { command: 'status', json, fleetFile } : { command: 'doctor', fleetFile };
}

// Errors name what went wrong in fixed words: never a path, a command's output or a username.
function fileError(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === 'ENOENT') return 'the fleet file does not exist';
  if (code === 'EACCES' || code === 'EPERM') return 'the fleet file is not readable';
  if (code === 'EISDIR') return 'the fleet file is a folder';
  return 'the fleet file could not be read';
}

function commandError(error: unknown): string {
  const e = error as { code?: string; status?: number | null; signal?: string | null };
  if (e.code === 'ENOENT') return 'the fleet command is not installed';
  if (e.code === 'EACCES') return 'the fleet command is not executable';
  if (e.code === 'ETIMEDOUT') return 'the fleet command timed out';
  if (e.code === 'ENOBUFS') return 'the fleet command printed too much';
  if (e.signal) return `the fleet command was stopped (${e.signal})`;
  return `the fleet command failed (exit ${e.status ?? 'unknown'})`;
}

/** The configured fleet helper (only ever the owner's explicit HUNTAWAY_FLEET_CMD), or null when it isn't usable. */
function fleetCommand(): string | null {
  const configured = process.env.HUNTAWAY_FLEET_CMD ?? '';
  const cmd = configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  // Never run a relative path: it would resolve against whatever folder the owner is in.
  return cmd !== '' && isAbsolute(cmd) ? cmd : null;
}

function fleetTimeoutMs(): number {
  const n = Number(process.env.HUNTAWAY_FLEET_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 100 && n <= 300_000 ? n : 90_000;
}

const MAX_FLEET_BYTES = 16 * 1024 * 1024;
// A reading dated more than this far ahead of this Mac's clock means one of the clocks is wrong: its age is unknown.
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Read a fleet file: a regular file of at most 16 MB (a FIFO would block forever; a device could be endless). */
function readFleetFile(path: string): { raw: string } | { error: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return { error: fileError(error) };
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) return { error: 'the fleet file is a folder' };
    if (!st.isFile()) return { error: 'the fleet file is not a regular file' };
    if (st.size > MAX_FLEET_BYTES) return { error: 'the fleet file is too large' };
    return { raw: readFileSync(fd, 'utf8') };
  } catch (error) {
    return { error: fileError(error) };
  } finally {
    closeSync(fd);
  }
}

// The fleet command (the Router's `compute-router-subscriptions`) exits 0 whenever it prints a reading, including
// one where a Mac is unreachable (that Mac is "unavailable"). So a non-zero exit is always a failure here.
function readFleet(fleetFile?: string): FleetResult {
  let raw: string;
  if (fleetFile !== undefined) {
    const file = readFleetFile(fleetFile);
    if ('error' in file) return { ok: false, error: file.error, exitCode: 1 };
    raw = file.raw;
  } else {
    // The machine names are checked before any helper runs: without them there is nothing to read the fleet for.
    const configured = fleetAliases();
    if (configured === null) return { ok: false, error: 'HUNTAWAY_FLEET_ALIASES is not a valid list of nodeid=Name pairs', exitCode: 1 };
    if (configured.length === 0) {
      return { ok: false, error: 'no machines are configured: set HUNTAWAY_FLEET_ALIASES (install with --fleet-aliases)', exitCode: 1 };
    }
    const cmd = fleetCommand();
    if (cmd === null) {
      return { ok: false, error: 'the fleet command must be an absolute path', exitCode: 1 };
    }
    try {
      raw = execFileSync(cmd, ['--json'], {
        timeout: fleetTimeoutMs(),
        killSignal: 'SIGKILL',
        maxBuffer: MAX_FLEET_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        env: withoutApiKeys(process.env),          // the helper reads allowances; it never needs an API key
      });
    } catch (error) {
      return { ok: false, error: commandError(error), exitCode: 1 };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'the fleet reading is not valid JSON', exitCode: 1 };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).hosts)) {
    return { ok: false, error: 'the fleet reading has no machines list', exitCode: 1 };
  }
  const known = fleetAliases();
  if (known === null) return { ok: false, error: 'HUNTAWAY_FLEET_ALIASES is not a valid list of nodeid=Name pairs', exitCode: 1 };
  if (known.length === 0) {
    return { ok: false, error: 'no machines are configured: set HUNTAWAY_FLEET_ALIASES (install with --fleet-aliases)', exitCode: 1 };
  }
  const machines = machinesFromFleet(parsed, known);
  if (machines.length === 0) {
    // An empty or unrecognised reading is an error, never an "all asleep" snapshot.
    return { ok: false, error: 'the fleet reading names none of the configured machines', exitCode: 1 };
  }
  // A reading's time is what lets a front end tell fresh from stale: without one, or from the future, it can't.
  const readAt = readingTime(parsed);
  if (readAt === null) return { ok: false, error: 'the fleet reading has no time', exitCode: 1 };
  if (Date.parse(readAt) - Date.now() > FUTURE_TOLERANCE_MS) {
    return { ok: false, error: 'the fleet reading is dated in the future (check this Mac\'s clock)', exitCode: 1 };
  }
  return { ok: true, fleet: parsed, count: machines.length, aliases: machines.map((m) => m.alias) };
}

/** Whether a reading is older than its own maxAgeSeconds (or of unknown age). */
function isStale(fleet: unknown): { stale: boolean; readAt: string | null } {
  const readAt = readingTime(fleet);
  const maxAge = Number((fleet as Record<string, unknown>).maxAgeSeconds);
  const ageSeconds = readAt === null ? null : (Date.now() - Date.parse(readAt)) / 1000;
  return { stale: ageSeconds === null || (Number.isFinite(maxAge) && maxAge > 0 && ageSeconds > maxAge), readAt };
}

function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const month = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `(resets ${month} ${day} ${h}:${min} UTC)`;
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return '(last seen unknown)';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '(last seen unknown)';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `(last seen ${y}-${m}-${day} ${h}:${min} UTC)`;
}

function formatSubscriptions(subs: Subscription[]): string {
  return subs
    .map((sub) => {
      const resetStr = sub.resetsAt ? ` ${formatReset(sub.resetsAt)}` : '';
      return `${sub.family} ${sub.room}${resetStr}`;
    })
    .join(' · ');
}

// Below Node 22.6 this file cannot load at all (type stripping), so this check covers 22.6-22.17 and later.
function checkNode(): { ok: boolean; line: string } {
  const version = process.versions.node;
  const [major = 0, minor = 0] = version.split('.').map((p) => parseInt(p, 10));
  const ok = major > 22 || (major === 22 && minor >= 18);
  return ok ? { ok: true, line: `ok   node ${version}` } : { ok: false, line: `FAIL node ${version} (requires >= 22.18.0)` };
}

function checkFleet(fleetFile?: string): { ok: boolean; line: string } {
  const result = readFleet(fleetFile);
  if (result.ok) {
    const machineWord = result.count === 1 ? 'machine' : 'machines';
    const aliasList =
      result.aliases.length > 0 ? ` (${result.aliases.join(', ')})` : '';
    const { stale, readAt } = isStale(result.fleet);
    const staleNote = stale && readAt !== null ? `, stale (read ${readAt.slice(0, 16).replace('T', ' ')} UTC)` : '';
    return {
      ok: true,
      line: `ok   fleet reading: ${result.count} ${machineWord}${aliasList}${staleNote}`,
    };
  }
  return {
    ok: false,
    line: `FAIL fleet reading: ${result.error}`,
  };
}

function printPaidStatus(): void {
  const chosen = chosenEngine();
  const home = getHuntawayHome();
  if (!(chosen !== null && paidEngine(chosen)) && !(home !== null && existsSync(join(home, 'spend.sqlite')))) return;
  const spend = spendLine();
  console.log(spend.line);
  if (!spend.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'key') {
    process.exitCode = await runKey(args.action, paidEngine(args.engine)!);
    return;
  }
  if (args.command === 'ship') {
    if (SHIP === null) {
      process.stderr.write(`Error: this copy of huntaway has no ship command\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await SHIP.runShip(args.argv);
    return;
  }
  if (args.command === 'ask') {
    const options = parseAskArgs(args.argv, USAGE);
    process.exitCode = await runAsk(options);
    return;
  }

  if (args.command === 'doctor') {
    const nodeRes = checkNode();
    console.log(nodeRes.line);

    const fleetRes = isStandalone() && args.fleetFile === undefined
      ? { ok: true, line: 'ok   fleet reading: none (standalone: this machine only)' }
      : checkFleet(args.fleetFile);
    console.log(fleetRes.line);

    // The engine a plain `huntaway ask` would use (chosenEngine, the same choice `ask` makes), and whether it is
    // ready: never a key's value or a command's path, only whether each is set.
    let engineOk: boolean;
    const chosen = chosenEngine();
    if (chosen === null) {
      engineOk = false;
      console.log(`FAIL engine: HUNTAWAY_ENGINE must be ${ENGINE_NAMES.join(' or ')}`);
    } else if (chosen === 'pipe') {
      engineOk = pipeConfigured();
      // A set HUNTAWAY_PIPE_CMD wins over Claude Code's settings (engines.ts), so registering the server can't fix a
      // bad one: say which of the two to fix.
      const commandSet = typeof process.env.HUNTAWAY_PIPE_CMD === 'string' && process.env.HUNTAWAY_PIPE_CMD !== '';
      console.log(engineOk ? 'ok   engine: pipe (a pipe command is configured)'
        : commandSet
          ? 'FAIL engine: pipe (HUNTAWAY_PIPE_CMD is set but is not a non-empty JSON list of strings: fix it, or unset it to use Claude Code\'s pipe server)'
          : "FAIL engine: pipe (no usable pipe command: add the Pipe's MCP server with claude mcp add --scope user pipe -- <command>, or set HUNTAWAY_PIPE_CMD to a JSON command list)");
    } else {
      const paid = paidDoctor(paidEngine(chosen)!);
      engineOk = paid.ok;
      for (const line of paid.lines) console.log(line);
    }
    if (isStandalone() && args.fleetFile === undefined && getWorkerAlias() === null) {
      engineOk = false;
      console.log('FAIL alias: standalone needs this machine\'s name (HUNTAWAY_ALIAS; install with --alias NAME)');
    }

    process.exitCode = nodeRes.ok && fleetRes.ok && engineOk ? 0 : 1;
    return;
  }

  // command === 'status'
  if (isStandalone() && args.fleetFile === undefined) {
    // No Router here, by the owner's choice at install: this machine only. Never a fallback for a missing Router.
    const now = new Date();
    const runs = loadLocalRuns(now.toISOString());
    const alias = getWorkerAlias();
    if (args.json) {
      if (alias === null) {
        // The contract carries the owner's name for the machine, never a made-up label.
        process.stderr.write(NO_ALIAS);
        process.exitCode = 1;
        return;
      }
      if (runs === null) {
        process.stderr.write(RUNS_UNREADABLE);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(JSON.stringify(standaloneSnapshot({ now, alias, runs }), null, 2) + '\n');
      return;
    }
    console.log(`${alias ?? 'This machine'}  on  (standalone: subscription room isn't tracked without the Router)`);
    console.log(formatRunsHuman(runs));
    printPaidStatus();
    if (runs === null) process.exitCode = 1;       // the exit code agrees with --json: something couldn't be read
    return;
  }
  const fleetResult = readFleet(args.fleetFile);
  if (!fleetResult.ok) {
    process.stderr.write(`Error: ${fleetResult.error}\n`);
    process.exitCode = fleetResult.exitCode;
    return;
  }

  if (args.json) {
    const now = new Date();
    const runs = loadLocalRuns(now.toISOString());
    if (runs === null) {
      // Never report "no runs" when they just can't be read: a program reading this must see the failure.
      process.stderr.write(RUNS_UNREADABLE);
      process.exitCode = 1;
      return;
    }
    const snap = buildSnapshot({ now, fleet: fleetResult.fleet, runs });
    process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
    return;
  }

  const machines = machinesFromFleet(fleetResult.fleet);
  const width = Math.max(8, ...machines.map((m) => m.alias.length + 2));
  for (const m of machines) {
    const statusStr = m.online ? 'on' : 'asleep';
    const details = m.online ? formatSubscriptions(m.subscriptions) : formatLastSeen(m.lastSeenAt);
    console.log(`${m.alias.padEnd(width)}${statusStr.padEnd(8)}${details}`.trimEnd());
  }
  const { stale, readAt } = isStale(fleetResult.fleet);
  console.log(`Reading ${readAt === null ? 'time unknown' : `as of ${readAt.slice(0, 16).replace('T', ' ')} UTC`}${stale ? ' (stale)' : ''}`);
  const localRuns = loadLocalRuns(new Date().toISOString());
  console.log(formatRunsHuman(localRuns));
  printPaidStatus();
  if (localRuns === null) process.exitCode = 1;
}

// Never let an unexpected error print a stack trace (it would show install paths and the username). An error while
// the modules load (before this guard exists) can still show them; that needs a broken install.
// A reader that goes away (EPIPE) ends `status` and `doctor` at once, but never an `ask` mid-run: it must still
// settle its run, so its output errors are ignored and it finishes normally.
const asking = process.argv[2] === 'ask';
process.stdout.on('error', (error: { code?: string }) => {
  if (asking) return;
  process.exit(error.code === 'EPIPE' ? 0 : 1);
});
process.stderr.on('error', () => {
  if (!asking) process.exit(1);            // an ask still settles its run when nobody is reading its messages
});
// Every file any command creates is the owner's alone.
process.umask(0o077);
try {
  await main();
} catch {
  process.stderr.write('Error: huntaway stopped unexpectedly\n');
  process.exitCode = 1;
}

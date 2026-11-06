import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { RequestLog, type Request, type RequestState } from '../core/request-log.ts';
import { getHuntawayHome, keepDays, OPEN_BUSY, orphanOutcome, orphanedRuns, pruneHistory, recordRunTransition, withOpenLock } from '../status/runs.ts';
import { LONGEST_WAIT_SECONDS } from './anthropic.ts';
import { preparePaid, type PreparedPaid } from './paid.ts';
import { closeAllClients, ENGINE_NAMES, paidEngine, submitJob, type AskOptions, type PaidEngineName } from './engines.ts';

/**
 * The engine a plain `huntaway ask` uses, from HUNTAWAY_ENGINE: the owner's own API key by default; the pipe (a Router
 * setup, on the owner's subscriptions) only when chosen, as `install-local.sh --router` writes it. null for any other
 * value, which is a usage error, never a fallback. `doctor` checks the same choice.
 */
export function chosenEngine(env: NodeJS.ProcessEnv = process.env): 'pipe' | PaidEngineName | null {
  const value = env.HUNTAWAY_ENGINE;
  if (value === undefined || value === '' || value === 'anthropic') return 'anthropic';
  return value === 'pipe' || paidEngine(value) ? value as 'pipe' | PaidEngineName : null;
}

/** Parse `huntaway ask` arguments; usage errors print `usage` and exit 2 before anything is recorded. */
export function parseAskArgs(argv: string[], usage: string): AskOptions {
  const fail = (): never => {
    process.stderr.write(usage);
    process.exit(2);
  };
  // The default engine is chosenEngine()'s; `--engine` (below) overrides it for one question.
  const chosen = chosenEngine();
  if (chosen === null) {
    process.stderr.write(`Error: HUNTAWAY_ENGINE must be ${ENGINE_NAMES.join(' or ')}\n`);
    process.exit(2);
  }
  let engine: AskOptions['engine'] = chosen;
  let family: AskOptions['family'] = 'claude';
  let model: string | undefined;
  let effort: AskOptions['effort'] = 'medium';
  let timeout = 600;
  let maxTokens = 1024;
  let familyGiven = false;
  let effortGiven = false;
  let maxTokensGiven = false;
  let timeoutGiven = false;
  let questionArg: string | undefined;
  let rest = false;
  const value = (i: number): string => {
    const v = argv[i];
    if (v === undefined || v === '' || v.startsWith('-')) fail();
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!rest && arg === '--') {
      rest = true;                                  // everything after -- is the question, even "-5 C?"
      if (questionArg !== undefined || i === argv.length - 1) fail();
      questionArg = argv.slice(i + 1).join(' ');
      break;
    } else if (!rest && arg === '--engine') {
      const v = value(++i);
      // The fake engine exists for Huntaway's own tests; it would put made-up runs in a real log, so it needs a switch.
      if (v !== 'pipe' && !paidEngine(v) && !(v === 'fake' && process.env.HUNTAWAY_ENABLE_FAKE_ENGINE === '1')) fail();
      engine = v as AskOptions['engine'];
    } else if (!rest && arg === '--family') {
      const v = value(++i);
      if (v !== 'claude' && v !== 'codex') fail();
      family = v as AskOptions['family'];
      familyGiven = true;
    } else if (!rest && arg === '--model') {
      const v = value(++i);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) fail();   // anthropic.ts repeats the model in an error: keep it plain
      model = v;
    } else if (!rest && arg === '--effort') {
      const v = value(++i);
      if (v !== 'low' && v !== 'medium' && v !== 'high') fail();
      effort = v as AskOptions['effort'];
      effortGiven = true;
    } else if (!rest && arg === '--timeout') {
      const v = value(++i);
      if (!/^[1-9][0-9]{0,4}$/.test(v)) fail();
      timeout = Number(v);
      timeoutGiven = true;
    } else if (!rest && arg === '--max-tokens') {
      const v = value(++i);
      if (!/^[1-9][0-9]{0,3}$/.test(v) || Number(v) > 8192) fail();   // an unstreamed answer this size fits in 5 minutes
      maxTokens = Number(v);
      maxTokensGiven = true;
    } else if (!rest && arg.startsWith('-') && arg !== '-') {
      fail();
    } else if (questionArg !== undefined) {
      fail();
    } else {
      questionArg = arg;
    }
  }
  if (questionArg === undefined) fail();
  let question = questionArg as string;
  if (question === '-' && !rest) {
    if (process.stdin.isTTY) {
      process.stderr.write('Error: with "-", pipe the question in (for example: echo "question" | huntaway ask -)\n');
      process.exit(2);
    }
    try {
      question = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    } catch {
      fail();
    }
  }
  if (question.trim().length === 0) fail();
  const paid = paidEngine(engine);
  if (paid && familyGiven && !(engine === 'anthropic' && family === 'claude')) fail();
  // An option the chosen engine would silently ignore is a usage error instead.
  if ((paid && effortGiven) || (!paid && maxTokensGiven)) fail();
  if (engine === 'openai' && maxTokens < 16) fail();
  if (paid) {
    // One API call can wait at most five minutes (see LONGEST_WAIT_SECONDS): a longer --timeout would be a promise
    // Huntaway can't keep, so it is a usage error, and the default fits.
    if (timeoutGiven && timeout > LONGEST_WAIT_SECONDS) fail();
    if (!timeoutGiven) timeout = LONGEST_WAIT_SECONDS;
  }
  const defaultModel = engine === 'anthropic' ? 'claude-sonnet-5-5' : paid ? paid.models.find(m => m.default)!.id : family === 'claude' ? 'opus' : 'gpt-6.1-sol';
  return { engine, family, model: model ?? defaultModel, effort, timeout, maxTokens, question };
}

/** Seconds and exactly six microsecond digits, as the request log requires. */
function microTimestamp(ms: number, bump: number): string {
  const micros = BigInt(ms) * 1000n + BigInt(bump);
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

/** On a terminal, drop control, escape and direction-override sequences a model answer could carry. */
export function forTerminal(text: string, isTTY: boolean = Boolean(process.stdout.isTTY)): string {
  if (!isTTY) return text;
  return text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

const KEY_DAMAGED = 'huntaway: the install key is damaged';
const KEY_UNAVAILABLE = 'huntaway: the install key could not be created';
const KEY_UNREADABLE = 'huntaway: the install key could not be read';
const FOLDER_UNSAFE = 'huntaway: the folder is not safe';

/**
 * Whether Huntaway's folder can be used: a real folder (lstat, so never a link), the owner's (when the platform has
 * user ids), and writable by nobody else, so no one can swap a file in it for a link. Its parent is the owner's home
 * (or a folder the owner chose), whose safety is the owner's.
 */
export function safeFolder(folder: { isDirectory(): boolean; uid: number; mode: number }, uid: number | null): boolean {
  return folder.isDirectory() && (uid === null || folder.uid === uid) && (folder.mode & 0o022) === 0;
}

/** A per-install secret, so the stored question fingerprint can't be brute-forced from short questions. */
function installKey(homeDir: string): Buffer {
  const path = join(homeDir, 'key');
  if (!existsSync(path)) {
    // Written whole under a private name, then linked into place: a parallel run never reads a half-written key.
    const temp = `${path}.${process.pid}.tmp`;
    try {
      rmSync(temp, { force: true });                     // a temp name left by a crashed run with this pid
      writeFileSync(temp, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
      linkSync(temp, path);
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') {                 // EEXIST: another run won
        try { unlinkSync(temp); } catch { /* never written */ }
        throw new Error(KEY_UNAVAILABLE);
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // the key is in place; a leftover temp name is harmless (the uninstaller's purge removes it)
    }
  }
  let hex: string;
  try {
    hex = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(KEY_UNREADABLE);
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(KEY_DAMAGED);
  return Buffer.from(hex, 'hex');
}

/** Fixed words for each way opening can fail: never a path. */
export function openError(error: unknown): string {
  switch ((error as { message?: string })?.message) {
    case OPEN_BUSY:
      return 'Error: another huntaway run is opening the request log; try again in a moment\n';
    case 'Database requires recovery':
      // Huntaway never guesses what a damaged log held: a guess could hide a question that may have run.
      return 'Error: the request log needs recovery: an earlier run stopped while creating or writing it. Huntaway ' +
        'will not guess what it held. Keep every file in the Huntaway folder as it is and ask for help; see "If ' +
        'the request log needs recovery" in the README.\n';
    case KEY_DAMAGED:
      return 'Error: the install key is damaged. Delete the file named "key" in the Huntaway folder and run again ' +
        '(fingerprints of earlier questions will no longer match).\n';
    case KEY_UNAVAILABLE:
      return 'Error: the install key could not be created\n';
    case KEY_UNREADABLE:
      return 'Error: the install key could not be read\n';
    case FOLDER_UNSAFE:
      return 'Error: the Huntaway folder must be a real folder of yours (not a link) that no one else, not even your group, can write to\n';
    default:
      return 'Error: the request log could not be opened\n';
  }
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const TERMINAL: readonly RequestState[] = ['answered', 'refused', 'failed', 'cancelled', 'expired', 'uncertain'];

/**
 * Run one owner question exactly once and return the exit code: 0 answered (and recorded), 1 anything else.
 * Never retries the engine. Huntaway never writes the question or the answer to disk (only a keyed HMAC of the
 * question); the engine itself (the pipe, and the official CLIs behind it) keeps its own records.
 * An interruption (Ctrl-C, SIGTERM, an unexpected error) still leaves an honest outcome: failed if nothing was sent,
 * uncertain once the job may exist.
 */
export async function runAsk(options: AskOptions): Promise<number> {
  const homeDir = getHuntawayHome();
  if (homeDir === null) {
    process.stderr.write('Error: HUNTAWAY_HOME must be an absolute path\n');
    return 1;
  }
  let paid: PreparedPaid | undefined;
  const engine = paidEngine(options.engine);
  if (engine) {
    try { paid = preparePaid(engine, options); }
    catch (error) {
      // Setup errors are fixed words from the shared layer, never a key or a provider body.
      process.stderr.write(`Error: ${(error as Error).message}\n`);
      return 1;
    }
  }
  process.umask(0o077);                                   // every file this run creates (and SQLite's) is owner-only
  let log: RequestLog;
  let key: Buffer;
  try {
    if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    // The folder must be a real folder of the owner's that nobody else can write to (so no one can swap a file in it
    // for a link); it is then made owner-only, however it was made.
    if (!safeFolder(lstatSync(homeDir), typeof process.getuid === 'function' ? process.getuid() : null)) {
      throw new Error(FOLDER_UNSAFE);
    }
    chmodSync(homeDir, 0o700);
    // Files an older version left readable are tightened before they are opened (SQLite gives a log's side files the
    // log's own mode).
    const dbPath = join(homeDir, 'requests.db');
    for (const f of ['requests.db', 'requests.db-wal', 'requests.db-shm', 'runs.db', 'key']) {
      const path = join(homeDir, f);
      if (existsSync(path) && lstatSync(path).isFile()) chmodSync(path, 0o600);
    }
    log = withOpenLock(homeDir, () => new RequestLog(dbPath));
    chmodSync(dbPath, 0o600);
    chmodSync(join(homeDir, 'runs.db'), 0o600);          // the open lock may have made it: owner-only either way
    key = installKey(homeDir);
  } catch (error) {
    process.stderr.write(openError(error));
    return 1;
  }

  let req: Request | null = null;
  let sent = false;
  let where = '';                                        // " (pipe request X)" once the engine names the job

  // The request log is the source of truth. A stale version (e.g. a recovery bumped it) is refreshed and a busy
  // database is retried briefly; the ENGINE is never retried. The run list is best-effort and never decides anything.
  const move = (to: RequestState): boolean => {
    if (req === null) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        req = log.transition(req.key, req.version, to);
        try {
          recordRunTransition(homeDir, req.key, to);
        } catch {
          warn('Warning: the run list could not be updated\n');
        }
        return true;
      } catch {
        let fresh: Request | null = null;
        try {
          fresh = log.get(req.key);
        } catch {
          fresh = null;
        }
        if (fresh !== null && fresh.version !== req.version) {
          req = fresh;                 // a newer version: try the transition from there
        } else {
          sleep(50 * (attempt + 1));   // busy or refused: wait a moment and try once more
        }
        if (req.state === to) return true;
      }
    }
    return false;
  };

  // Settle a run that was cut short: nothing sent -> it never started; sent -> it may have run.
  const settle = (): void => {
    if (req === null || TERMINAL.includes(req.state)) return;
    if (req.state === 'received') move('refused');
    else if (req.state === 'queued') move('cancelled');
    else move(sent ? 'uncertain' : 'failed');
  };

  const warn = (text: string): void => {
    try {
      process.stderr.write(text);
    } catch {
      // a closed terminal: nothing to tell
    }
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    const code = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
    try {
      settle();                                       // the outcome first: it is what the owner relies on
      warn(sent
        ? `Stopped. It may have run${where}; it was not retried.\n`
        : 'Stopped before anything was sent. You can send it again.\n');
    } catch {
      // settle failed: the next ask settles this run
    } finally {
      try {
        closeAllClients();                            // then close the pipe connection this run opened
      } catch {
        // nothing more to close
      }
      try {
        log.close();
      } catch {
        // already closed
      }
      process.exit(code);
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);

  // Runs left in progress by a crashed ask (kill -9, power loss) can never finish: record them honestly first.
  try {
    for (const orphan of orphanedRuns(homeDir)) {
      const o = log.get(orphan);
      if (o === null) continue;
      try {
        if (TERMINAL.includes(o.state)) {
          recordRunTransition(homeDir, o.key, o.state);   // the log already ended it: bring the run list up to date
          continue;
        }
        const to = orphanOutcome(o.state);
        log.transition(o.key, o.version, to);
        recordRunTransition(homeDir, o.key, to);
      } catch {
        // another process got there first
      }
    }
  } catch {
    // reconciliation is best effort
  }

  // Huntaway's own history ages out (it never touches anything it did not write).
  const days = keepDays();
  if (days === null) {
    warn('Warning: HUNTAWAY_KEEP_DAYS must be whole days from 1 to 3660; old history was kept\n');
  } else {
    try {
      pruneHistory(homeDir, log, days);
    } catch {
      // cleanup is best effort: the next ask tries again
    }
  }

  try {
    const contentHash = createHmac('sha256', key).update(options.question).digest('hex');
    const started = Date.now();
    for (let bump = 0; req === null && bump < 1000; bump++) {
      try {
        const result = log.record({
          team: 'local', channel: 'cli', ts: microTimestamp(started, bump), agent: 'huntaway',
          thread: microTimestamp(started, bump), contentHash,
        });
        if (result.created) req = result.request;
      } catch (error) {
        // Another request already holds this microsecond: try the next one. Anything else stops here.
        if ((error as Error)?.message !== 'Request identity conflict') break;
      }
    }
    if (req === null) {
      process.stderr.write('Error: the request could not be recorded\n');
      return 1;
    }
    try {
      recordRunTransition(homeDir, (req as Request).key, 'received');
    } catch {
      // A run is listed before it can be sent, so status and the next ask can always find it. Later updates to the
      // listing are best-effort; this first one is required.
      try {
        settle();
      } catch {
        // not listed, so no later ask will find it: it stays "received" in the log, which is honest (never sent)
      }
      process.stderr.write('Error: the run list could not be updated, so nothing was sent. You can send it again.\n');
      return 1;
    }
    if (!move('queued') || !move('submitting')) {
      settle();
      process.stderr.write('Error: the request log refused to start this run (a recovery may be in progress). Nothing ran.\n');
      return 1;
    }

    // When the log can't take the outcome (it shows another state), the message says so instead of contradicting it.
    const unrecorded = (): string => ` The request log shows this run as ${req?.state ?? 'unknown'}; check before sending again.`;
    const submitted = await submitJob(options, { onSent: () => { sent = true; } }, paid);
    if (submitted.outcome === 'refused') {
      const ok = move('failed');
      warn(`Error: it failed before starting: ${submitted.why}.${ok ? ' Nothing ran; you can send it again.' : unrecorded()}\n`);
      return 1;
    }
    if (submitted.outcome === 'uncertain') {
      const ok = move('uncertain');
      warn(`Error: not sure it started (${submitted.why}). It may have run and was not retried.${ok ? ' Check before sending again.' : unrecorded()}\n`);
      return 1;
    }
    where = submitted.requestId === 'fake' || submitted.requestId === 'api' ? ''
      : paidEngine(options.engine) ? ` (API request ${submitted.requestId})` : ` (pipe request ${submitted.requestId})`;
    if (!move('dispatched')) {
      try {
        settle();
      } finally {
        submitted.abandon();                          // close the pipe connection, or the command would never exit
      }
      warn(`Error: the request log could not record the start${where}; the job may run anyway and was not retried.\n`);
      return 1;
    }
    const result = await submitted.wait();
    if (result.status === 'completed') {
      if (!move('posting')) {
        settle();
        warn(`Error: the request log could not record the answer${where}; not printing it. It ran; it was not retried.\n`);
        return 1;
      }
      process.stdout.write(forTerminal(result.answer.endsWith('\n') ? result.answer : result.answer + '\n'));
      if (result.truncated) warn(`Note: the answer stopped at --max-tokens (${options.maxTokens}); ask again with a higher limit for more.\n`);
      if (!move('answered')) {
        settle();
        warn('Warning: the answer was printed but could not be recorded as answered.\n');
        return 1;
      }
      return 0;
    }
    if (result.status === 'failed') {
      const ok = move('failed');
      warn(`Error: the job failed: ${result.why}${where}.${ok ? ' You can send it again.' : unrecorded()}\n`);
      return 1;
    }
    const ok = move('uncertain');
    warn(`Error: not sure it finished (${result.why})${where}. It may have run and was not retried.${ok ? ' Check before sending again.' : unrecorded()}\n`);
    return 1;
  } catch {
    try {
      settle();
    } catch {
      // the next ask settles this run
    } finally {
      try {
        closeAllClients();
      } catch {
        // nothing more to close
      }
    }
    process.stderr.write(sent
      ? `Error: huntaway stopped unexpectedly; the job may have run${where} and was not retried.\n`
      : 'Error: huntaway stopped unexpectedly before sending anything.\n');
    return 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    log.close();
  }
}

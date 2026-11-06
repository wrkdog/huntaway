import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getHuntawayHome } from '../status/runs.ts';
import type { AskOptions, SubmitHooks, SubmitResult, WaitResult } from './engines.ts';
import { SpendLedger, ledgerNow, type Reservation, type Spend } from './ledger.ts';
import { modelsFor, testMode, type Model, type Prices } from './models.ts';
import { paidRequest, type PaidRequest, type PaidResponse } from './paid-fetch.ts';

export type Usage = {
  input: bigint; output: bigint; standard: boolean;
  /** Included in input, charged at twice the input rate. */
  cache: bigint;
};
export type PaidAnswer = { answer: string; truncated: boolean; refused: boolean; usage: Usage | null };
export type PaidEngine = {
  name: string; label: string; keyName: string; url: string; countPath: string;
  models: readonly Model[]; notRun: ReadonlySet<number>;
  headers: (key: string) => Record<string, string>;
  countBody: (options: AskOptions, model: Model) => unknown;
  /** Include the question verbatim in the billed request. */
  requestBody: (options: AskOptions, model: Model) => unknown;
  readCount: (body: unknown) => bigint | null;
  readAnswer: (body: unknown) => PaidAnswer | null;
  errorType: (body: unknown) => string;
  refusal: (status: number, type: string, model: string) => string;
};
export type Caps = { question: bigint; day: bigint };
export type PreparedPaid = { submit: (hooks: SubmitHooks) => Promise<SubmitResult> };

export const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;
const max = (a: bigint, b: bigint): bigint => a > b ? a : b;
/** Decimal parsing never passes through floating point. */
function dollars(value: string | undefined, places: number, limit: bigint): bigint | null {
  if (value === undefined || !new RegExp(`^[0-9]+(?:\\.[0-9]{1,${places}})?$`).test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return amount <= limit ? amount : null;
}
const CAPS_ERROR = 'Set HUNTAWAY_MAX_USD_PER_QUESTION and HUNTAWAY_MAX_USD_PER_DAY (0.01 to 1000, at most 2 decimals; day at least question), for example HUNTAWAY_MAX_USD_PER_QUESTION=1 HUNTAWAY_MAX_USD_PER_DAY=10';
export function paidCaps(): Caps {
  const question = dollars(process.env.HUNTAWAY_MAX_USD_PER_QUESTION, 2, 1_000_000_000n);
  const day = dollars(process.env.HUNTAWAY_MAX_USD_PER_DAY, 2, 1_000_000_000n);
  if (question === null || day === null || question < 10_000n || day < question) throw new Error(CAPS_ERROR);
  return { question, day };
}
/** Round UP to cents, including reservations and very small nonzero spend. */
export function cents(amount: bigint): string {
  const rounded = ceilDiv(amount, 10_000n);
  return `${rounded / 100n}.${String(rounded % 100n).padStart(2, '0')}`;
}
/** Three significant figures, nearest, using integer arithmetic only. */
export function about(amount: bigint): string {
  const digits = amount.toString().length;
  const step = 10n ** BigInt(Math.max(0, digits - 3));
  const rounded = ((amount + step / 2n) / step) * step;
  const fraction = String(rounded % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
  return `${rounded / 1_000_000n}${fraction ? '.' + fraction : ''}`;
}
export function modelPrices(engine: PaidEngine, id: string): { model: Model; override: boolean } {
  const entries = modelsFor(engine.models);
  const entry = entries.find(m => m.id === id);
  if (!entry) throw new Error('The model is not in the paid capability table; choose another with --model');
  const settingFor = (m: Model): string => `HUNTAWAY_PRICE_${engine.name.toUpperCase()}_${m.id.toUpperCase().replace(/[.-]/g, '_')}`;
  const setting = settingFor(entry);
  const value = process.env[setting];
  if (value === undefined) return { model: entry, override: false };
  const fail = (): never => { throw new Error(`${setting} must unambiguously name one model and not lower either table price (input,output dollars per million, 0 to 1000, at most 6 decimals)`); };
  if (entries.filter(m => settingFor(m) === setting).length !== 1) fail();
  const parts = value.split(',');
  if (parts.length !== 2) fail();
  const input = dollars(parts[0], 6, 1_000_000_000n);
  const output = dollars(parts[1], 6, 1_000_000_000n);
  if (input === null || output === null || input < entry.standard.input || output < entry.standard.output) return fail();
  return { override: true, model: { ...entry, standard: { input, output },
    priority: { input: max(input, entry.priority.input), output: max(output, entry.priority.output) } } };
}
export function cost(input: bigint, output: bigint, prices: Prices, cache = 0n): bigint {
  return ceilDiv((input + cache) * prices.input + output * prices.output, 1_000_000n);
}
/** bodyBytes is the larger of the exact billed JSON's raw and question-NFKC byte counts. */
export function hardInput(model: Model, maxTokens: number, bodyBytes: number): bigint {
  const bound = BigInt(maxTokens);
  const limit = model.hardInputLimit - (model.sharedContext ? bound : 0n);
  const bytes = 2n * BigInt(bodyBytes) + model.overhead;
  return model.byteBound && bytes < limit ? bytes : limit;
}
export function hardWorst(model: Model, maxTokens: number, bodyBytes: number): bigint {
  return cost(hardInput(model, maxTokens, bodyBytes), BigInt(maxTokens), model.standard);
}
export function capRefusal(required: bigint): string {
  return `HUNTAWAY_MAX_USD_PER_QUESTION is too low for this request; choose a cheaper model or raise the cap to $${cents(required)}`;
}

/** A key that can go in a header. Empty is unset; it never permits fallback when a nonempty environment key is invalid. */
export function usableKey(key: unknown): key is string {
  return typeof key === 'string' && /^[\x21-\x7e]{1,512}$/.test(key);
}
function permittedKey(key: unknown): key is string {
  return usableKey(key) && key.startsWith('hwtest-') === testMode();
}
function securityEnv(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...(process.env.USER === undefined ? {} : { USER: process.env.USER }) };
}
type Stored = { state: 'found'; key: string } | { state: 'missing' | 'unreadable' };
function fakeKeychain(): Record<string, unknown> {
  const path = process.env.HUNTAWAY_TEST_KEYCHAIN_FILE;
  if (!path) throw new Error('The keychain could not be read');
  if (!existsSync(path)) return {};
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('The keychain could not be read');
  return doc;
}
function storedKey(engine: string): Stored {
  if (testMode()) {
    try {
      const doc = fakeKeychain();
      if (!Object.hasOwn(doc, engine)) return { state: 'missing' };
      return typeof doc[engine] === 'string' ? { state: 'found', key: doc[engine] as string } : { state: 'unreadable' };
    } catch { return { state: 'unreadable' }; }
  }
  if (process.platform !== 'darwin') return { state: 'missing' };
  const result = spawnSync('/usr/bin/security', ['find-generic-password', '-s', 'huntaway', '-a', engine, '-w'], {
    env: securityEnv(), timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
  });
  if (result.status === 44) return { state: 'missing' };
  return result.status === 0 && !result.error
    ? { state: 'found', key: result.stdout.replace(/\n$/, '') } : { state: 'unreadable' };
}
export function paidKey(engine: PaidEngine): { key: string; source: string } {
  const fromEnv = process.env[engine.keyName];
  if (fromEnv) {
    if (!usableKey(fromEnv)) throw new Error(`${engine.keyName} is not a usable key`);
    if (!permittedKey(fromEnv)) throw new Error('The API key is refused by the test switch');
    return { key: fromEnv, source: 'key set in the environment' };
  }
  const stored = storedKey(engine.name);
  if (stored.state === 'unreadable') throw new Error("The keychain couldn't be read");
  if (stored.state === 'missing') throw new Error(`${engine.keyName} is not set; no key in the keychain (on Linux use the environment)`);
  if (!permittedKey(stored.key)) throw new Error('The keychain key is not a usable key for this test switch');
  return { key: stored.key, source: 'key in the keychain' };
}
function writeStored(engine: string, key: string | null): boolean {
  if (key !== null && !/^[A-Za-z0-9._-]{20,512}$/.test(key)) return false;
  if (testMode()) {
    const path = process.env.HUNTAWAY_TEST_KEYCHAIN_FILE;
    if (!path) return false;
    const temp = `${path}.${process.pid}.tmp`;
    try {
      const doc = fakeKeychain();
      if (key === null) delete doc[engine]; else doc[engine] = key;
      writeFileSync(temp, JSON.stringify(doc), { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
      return true;
    } catch { return false; }
    finally { try { unlinkSync(temp); } catch { /* No temporary file. */ } }
  }
  if (process.platform !== 'darwin') return false;
  const args = key === null ? ['delete-generic-password', '-s', 'huntaway', '-a', engine] : ['-i'];
  const result = spawnSync('/usr/bin/security', args, {
    input: key === null ? undefined : `add-generic-password -U -s huntaway -a ${engine} -w "${key}"\n`,
    env: securityEnv(), timeout: 10_000, killSignal: 'SIGKILL', stdio: ['pipe', 'ignore', 'ignore'],
  });
  return !result.error && (result.status === 0 || (key === null && result.status === 44));
}
async function keyLine(): Promise<string | null> {
  let terminalState: string | undefined;
  const terminal = Boolean(process.stdin.isTTY);
  if (terminal) {
    const state = spawnSync('/bin/stty', ['-g'], { env: securityEnv(), stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' });
    if (state.status !== 0) return null;
    terminalState = state.stdout.trim();
    if (spawnSync('/bin/stty', ['-echo'], { env: securityEnv(), stdio: ['inherit', 'ignore', 'ignore'] }).status !== 0) return null;
    process.stderr.write('API key: ');
  }
  const restore = (): void => {
    if (terminalState !== undefined) spawnSync('/bin/stty', [terminalState], { env: securityEnv(), stdio: ['inherit', 'ignore', 'ignore'] });
  };
  const onSignal = (): void => { restore(); process.exit(1); };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, onSignal);
  try {
    return await new Promise<string | null>(resolve => {
      const lines = createInterface({ input: process.stdin, terminal: false });
      let done = false;
      lines.once('line', line => { done = true; lines.close(); process.stdin.pause(); resolve(line); });
      lines.once('close', () => { if (!done) resolve(null); });
      lines.once('error', () => { lines.close(); resolve(null); });
    });
  } finally {
    restore();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.removeListener(signal, onSignal);
    if (terminal) process.stderr.write('\n');
  }
}
export async function runKey(action: 'set' | 'remove', engine: PaidEngine): Promise<number> {
  const failed = (): number => { process.stderr.write(action === 'set' ? "Error: the key couldn't be stored\n" : "Error: the key couldn't be removed\n"); return 1; };
  if (!testMode() && process.platform !== 'darwin') {
    process.stderr.write('Error: huntaway key requires macOS; on Linux use the environment\n');
    return 1;
  }
  if (action === 'remove') return writeStored(engine.name, null) ? 0 : failed();
  const key = await keyLine();
  if (key === null || !/^[A-Za-z0-9._-]{20,512}$/.test(key) || !permittedKey(key)) return failed();
  const before = storedKey(engine.name);
  if (before.state === 'unreadable' || (before.state === 'found' && !/^[A-Za-z0-9._-]{20,512}$/.test(before.key))) return failed();
  if (writeStored(engine.name, key)) {
    const after = storedKey(engine.name);
    if (after.state === 'found' && after.key === key) return 0;
  }
  // Never delete an older item. Restore it if the write succeeded but verification failed.
  if (before.state === 'found') writeStored(engine.name, before.key);
  else writeStored(engine.name, null);
  return failed();
}

export function paidUrl(engine: PaidEngine): string {
  if (!testMode()) return engine.url;
  const stand = process.env[`HUNTAWAY_TEST_${engine.name.toUpperCase()}_URL`];
  try {
    if (!stand || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}\//.test(stand)) throw new Error();
    const url = new URL(stand);
    if (url.username || url.password || url.search || url.hash || Number(url.port) < 1) throw new Error();
    return url.href;
  } catch { throw new Error('A valid local stand-in URL is required by the test switch'); }
}

// Moved unchanged from anthropic.ts: only a request certainly never sent may be repeated.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']);
export function networkOutcome(error: unknown, aborted: boolean): { outcome: 'refused' | 'uncertain'; why: string } {
  if (aborted) return { outcome: 'uncertain', why: 'no answer within --timeout' };
  const cause = (error as { cause?: { code?: unknown; message?: unknown; errors?: { code?: unknown }[] } }).cause;
  // An attempt-per-address failure counts as "not sent" only when every attempt was.
  const codes = Array.isArray(cause?.errors) && cause.errors.length > 0 ? cause.errors.map((e) => e?.code) : [cause?.code];
  if (codes.every((code) => typeof code === 'string' && NOT_SENT.has(code))) {
    return { outcome: 'refused', why: 'the API could not be reached' };
  }
  if (cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
    return { outcome: 'uncertain', why: 'no answer within 5 minutes, the longest one API call can wait' };
  }
  // Node's fetch says "redirect" when it refuses to follow one; if that wording changes this falls back to "lost",
  // which is still "may have run".
  return typeof cause?.message === 'string' && /redirect/iu.test(cause.message)
    ? { outcome: 'uncertain', why: 'the API answered with a redirect, which Huntaway never follows' }
    : { outcome: 'uncertain', why: 'the connection to the API was lost' };
}

/** Setup precedes the request log: missing caps or keys leave no run or install secret. */
export function preparePaid(engine: PaidEngine, options: AskOptions, request: PaidRequest = paidRequest): PreparedPaid {
  const deadline = Date.now() + Math.min(options.timeout, 300) * 1000;
  const caps = paidCaps();
  const { model, override } = modelPrices(engine, options.model);
  // Serialize the billed body once and send these exact bytes, including all framing/settings.
  const requestBody = JSON.stringify(engine.requestBody(options, model));
  const rawBytes = Buffer.byteLength(requestBody, 'utf8');
  // Only the count normalizes. Rebuild through the adapter so every occurrence and
  // any framing or escaping it adds is counted, while the billed body stays unchanged.
  const normalizedBody = JSON.stringify(engine.requestBody({ ...options, question: options.question.normalize('NFKC') }, model));
  const normalizedBytes = Buffer.byteLength(normalizedBody, 'utf8');
  const bodyBytes = Math.max(rawBytes, normalizedBytes);
  const inputBound = hardInput(model, options.maxTokens, bodyBytes);
  const reserved = hardWorst(model, options.maxTokens, bodyBytes);
  if (reserved > caps.question) throw new Error(capRefusal(reserved));
  process.stderr.write(`This question uses your paid ${engine.label} API key; any charge goes to that account. Huntaway first asks ${engine.label} to count the question (free), which sends it to ${engine.label}. Caps: $${cents(caps.question)} a question, $${cents(caps.day)} a day (Huntaway's own use on this machine).${override ? ' A price override is in use.' : ''}\n`);
  const { key } = paidKey(engine);
  const url = paidUrl(engine);
  return { submit: hooks => submitPaid(engine, options, hooks, model, caps, reserved, inputBound, key, url, requestBody, deadline, request) };
}

async function submitPaid(engine: PaidEngine, options: AskOptions, hooks: SubmitHooks, model: Model, caps: Caps,
  reserved: bigint, inputBound: bigint, key: string, url: string, requestBody: string, deadline: number,
  request: PaidRequest): Promise<SubmitResult> {
  let ledger: SpendLedger;
  const reservation: Reservation = { engine: engine.name, model: model.id, revision: model.safetyRevision, estimated: 0n, reserved };
  try {
    const home = getHuntawayHome();
    if (home === null) throw new Error();
    ledger = new SpendLedger(join(home, 'spend.sqlite'));
  } catch { return { outcome: 'refused', why: 'the spend ledger could not be opened' }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  const settle = (id: bigint, usage: Usage | null, outcome: 'completed' | 'refused' | 'not_run', estimatedTenths: bigint): void => {
    if (outcome !== 'not_run' && usage === null) {
      try { ledger.keepReservation(id, outcome, false); } catch { /* The existing reservation remains. */ }
      return;
    }
    const amount = usage === null ? 0n : cost(usage.input, usage.output, usage.standard ? model.standard : model.priority, usage.cache);
    const overrun = usage !== null && (usage.input > inputBound || usage.input * 10n > estimatedTenths || usage.output > BigInt(options.maxTokens) ||
      amount > reserved || !usage.standard || usage.cache > 0n);
    if (overrun) process.stderr.write('Warning: a spend overrun was detected; this model is blocked until a reviewed safety revision.\n');
    try {
      ledger.settle(id, { amount, input: usage?.input ?? null, output: usage?.output ?? null, outcome, overrun });
    } catch {
      // An amount outside SQLite's integer range must still block this model. A failed
      // settling write otherwise retains the reservation; never erase it to make room.
      try { ledger.keepReservation(id, 'uncertain', overrun); } catch { /* The existing reservation remains. */ }
      process.stderr.write('Warning: the spend could not be settled; its full reservation is kept.\n');
    }
  };
  try {
    try { ledger.check(reservation, caps.day); }
    catch (error) { return { outcome: 'refused', why: ledgerRefusal(error, reserved) }; }
    if (Date.now() >= deadline) return { outcome: 'refused', why: 'no answer within --timeout; nothing billed was sent' };
    let counted: bigint | null;
    const countController = new AbortController();
    const stopCount = (): void => countController.abort();
    controller.signal.addEventListener('abort', stopCount, { once: true });
    const countTimer = setTimeout(stopCount, 30_000);
    try {
      const response = await request(new URL(engine.countPath, url), { method: 'POST', headers: engine.headers(key),
        body: JSON.stringify(engine.countBody(options, model)), redirect: 'error', signal: countController.signal });
      if (response.status !== 200) return { outcome: 'refused', why: 'the API refused the token count; nothing billed was sent' };
      counted = engine.readCount(await response.json());
      if (counted === null || typeof counted !== 'bigint' || counted < 0n) return { outcome: 'refused', why: 'the API token count could not be read; nothing billed was sent' };
    } catch (error) {
      if (countController.signal.aborted && !controller.signal.aborted && Date.now() < deadline) {
        return { outcome: 'refused', why: 'no token count within 30 seconds; nothing billed was sent' };
      }
      const network = networkOutcome(error, countController.signal.aborted);
      return { outcome: 'refused', why: `${network.why}; the count failed, nothing billed was sent` };
    } finally {
      countController.abort(); // Also close an unread error body; the count must never keep the CLI alive.
      clearTimeout(countTimer);
      controller.signal.removeEventListener('abort', stopCount);
    }
    if (controller.signal.aborted || Date.now() >= deadline) return { outcome: 'refused', why: 'the token count used all of --timeout; nothing billed was sent' };
    // Keep fractional estimated tokens exactly, in tenths. Round the final sum UP once.
    const estimatedTenths = counted * 11n + 640n;
    reservation.estimated = ceilDiv(estimatedTenths * model.standard.input + BigInt(options.maxTokens) * 10n * model.standard.output, 10_000_000n);
    let booked: { id: bigint; used: bigint };
    try { booked = ledger.reserve(reservation, caps.day); }
    catch (error) { return { outcome: 'refused', why: ledgerRefusal(error, reserved) }; }
    // A synchronous SQLite lock wait can use up the deadline before an abort timer fires.
    if (Date.now() >= deadline) {
      settle(booked.id, null, 'not_run', estimatedTenths);
      return { outcome: 'refused', why: 'the reservation used all of --timeout; nothing billed was sent' };
    }
    process.stderr.write(`At most $${cents(reserved)} for this question (about $${about(reservation.estimated)} by ${engine.label}'s count); $${cents(booked.used)} of your $${cents(caps.day)} used in the last 24 hours.\n`);
    let response: PaidResponse;
    hooks.onSent();
    try {
      response = await request(url, { method: 'POST', headers: engine.headers(key),
        body: requestBody, redirect: 'error', signal: controller.signal });
    } catch (error) {
      const result = networkOutcome(error, controller.signal.aborted);
      if (result.outcome === 'refused') settle(booked.id, null, 'not_run', estimatedTenths);
      else { try { ledger.keepReservation(booked.id, 'uncertain', false); } catch { /* Keep the reservation. */ } }
      return result;
    }
    const header = response.headers.get('request-id');
    // Even a syntactically valid request id cannot echo the auth secret.
    const requestId = header !== null && /^[A-Za-z0-9_-]{1,80}$/.test(header) && !header.includes(key) && !header.includes(key.slice(-32)) ? header : 'api';
    let body: unknown = null;
    let bodyRead = true;
    try { body = await response.json(); } catch { bodyRead = false; }
    const type = engine.errorType(body);
    if (engine.notRun.has(response.status)) {
      settle(booked.id, null, 'not_run', estimatedTenths);
      return { outcome: 'refused', why: engine.refusal(response.status, type, model.id) };
    }
    let result: WaitResult;
    if (!bodyRead) {
      result = { status: 'uncertain', why: controller.signal.aborted ? 'no answer within --timeout' : "the API's answer could not be read" };
    } else if (response.status === 200) {
      const answer = engine.readAnswer(body);
      if (answer === null) result = { status: 'uncertain', why: "the API's answer could not be read" };
      else {
        const usage = validatedUsage(answer.usage);
        settle(booked.id, usage, answer.refused ? 'refused' : 'completed', estimatedTenths);
        if (answer.refused) result = { status: 'failed', why: 'the model refused the question' };
        else if (answer.answer.length > 0) result = { status: 'completed', answer: answer.answer, truncated: answer.truncated };
        // Valid usage proves it ran even if it completed without text.
        else if (usage !== null) result = { status: 'failed', why: `The answer used all of --max-tokens (${options.maxTokens}) before any text; ask again with a higher --max-tokens.` };
        else result = { status: 'uncertain', why: 'the API answered without any text' };
      }
    } else result = { status: 'uncertain', why: `the API failed while handling it (${response.status} ${type})` };
    if (result.status === 'uncertain') {
      try { ledger.keepReservation(booked.id, 'uncertain', false); } catch { /* Keep the reservation. */ }
    }
    return { outcome: 'accepted', requestId, abandon: () => {}, wait: async () => result };
  } finally {
    controller.abort(); // Close unread response bodies and any connection still being established.
    clearTimeout(timer);
    ledger.close();
  }
}
/** Provider readers normalize their fields; the layer validates the common settlement contract too. */
function validatedUsage(usage: Usage | null): Usage | null {
  if (usage === null || typeof usage.input !== 'bigint' || usage.input < 0n ||
      typeof usage.output !== 'bigint' || usage.output < 0n || typeof usage.cache !== 'bigint' ||
      usage.cache < 0n || usage.cache > usage.input || typeof usage.standard !== 'boolean') return null;
  return usage;
}

function ledgerRefusal(error: unknown, required: bigint): string {
  // Only our two fixed decisions may pass on; SQLite exceptions can contain paths or data.
  const message = (error as Error)?.message;
  if (message === 'The per-day cap has no room in the last 24 hours') {
    return `${message}; this request needs $${cents(required)} of headroom in HUNTAWAY_MAX_USD_PER_DAY`;
  }
  return message === 'This model is blocked after a spend overrun; a reviewed safety revision is required'
    ? message : 'the spend ledger could not be read or locked';
}

export function readSpend(): Spend {
  const home = getHuntawayHome();
  if (home === null) throw new Error('The spend ledger could not be read');
  const path = join(home, 'spend.sqlite');
  if (!existsSync(path)) {
    if (['-wal', '-shm', '-journal'].some(s => existsSync(path + s))) throw new Error('The spend ledger could not be read');
    return { used: 0n, overruns: [] };
  }
  const ledger = new SpendLedger(path, true);
  try { return ledger.snapshot(); } finally { ledger.close(); }
}
function formatSpendLine({ used }: Spend): string {
  const day = dollars(process.env.HUNTAWAY_MAX_USD_PER_DAY, 2, 1_000_000_000n);
  return `Paid API: $${cents(used)} of ${day !== null && day >= 10_000n ? '$' + cents(day) : 'an unset day cap'} used in the last 24 hours (Huntaway's own use on this machine)`;
}
export function spendLine(): { ok: boolean; line: string } {
  try { return { ok: true, line: formatSpendLine(readSpend()) }; }
  catch { return { ok: false, line: 'Paid API: spend ledger unavailable' }; }
}
export function paidDoctor(engine: PaidEngine): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  let spend: Spend | null = null;
  try { spend = readSpend(); } catch { /* Every spend line below reports this same failed read. */ }
  try {
    const caps = paidCaps();
    const entries = modelsFor(engine.models);
    const defaultModel = entries.find(m => m.default)!;
    const { override } = modelPrices(engine, defaultModel.id);
    const { source } = paidKey(engine);
    if (spend === null) throw new Error('The spend ledger could not be read');
    lines.push(`ok   engine: ${engine.name} (paid API; ${source}; caps $${cents(caps.question)} a question, $${cents(caps.day)} a day; $${cents(spend.used)} used in the last 24 hours)`);
    if (override) lines.push('ok   prices: A price override is in use.');
  } catch (error) {
    ok = false;
    // The operations above expose only fixed setup words except SQLite, handled separately below.
    const message = (error as Error)?.message;
    const known = typeof message === 'string' && (message === CAPS_ERROR || message.startsWith('HUNTAWAY_') || message.startsWith(engine.keyName) ||
      message.startsWith('The keychain') || message === 'The API key is refused by the test switch' ||
      message === 'A valid local stand-in URL is required by the test switch');
    lines.push(`FAIL engine: ${engine.name} (${known ? message : 'the spend ledger could not be read'})`);
  }
  // Show every model's required cap, and all blocks, even if the default setup failed.
  for (const entry of modelsFor(engine.models)) {
    try {
      const { model } = modelPrices(engine, entry.id);
      lines.push(`info model ${model.id}: per-question cap $${cents(hardWorst(model, 1024, 10_240))} for a 10,240-byte request body at --max-tokens 1024`);
      if (ledgerNow() - Date.parse(model.checked + 'T00:00:00Z') > 60 * 86_400_000) {
        lines.push(`FAIL prices: ${model.id} table is more than 60 days old`); ok = false;
      }
    } catch { lines.push('FAIL prices: the price override is invalid'); ok = false; }
  }
  if (spend !== null) {
    for (const overrun of spend.overruns) {
      const model = modelsFor(engine.models).find(m => m.id === overrun.model);
      if (overrun.engine === engine.name && model && overrun.revision >= model.safetyRevision) {
        lines.push(`FAIL overrun: ${model.id} is blocked pending a reviewed safety revision`); ok = false;
      }
    }
  } else { lines.push('FAIL spend: the spend ledger could not be read'); ok = false; }
  lines.push(spend === null ? 'Paid API: spend ledger unavailable' : formatSpendLine(spend));
  return { ok, lines };
}

/**
 * Probes: an account's official status surfaces, turned into pipe evidence (U4).
 *
 * - Identity for U1's IdentityLedger: Claude's `auth status`, Codex's app-server `account/read`.
 *   Both are local, so an outage never looks like a sign-out (L11).
 * - Allowance readings for U1's AllowanceLedger: Claude's `/usage`, Codex's
 *   `account/rateLimits/read`. Claude's `/usage` answers from a cache, silently, when it cannot
 *   reach the service (L14). So a reading counts only when the same probe reached the service.
 * - The CLI version, flagged below a configured minimum; the provider's official model list,
 *   which answers an unknown model id (L5). Claude publishes none.
 *
 * Every part is ok, or says why not: signed out only on the official status's word, offline
 * when the service cannot be reached, unknown otherwise. Only ok evidence reaches a ledger, and
 * only for the account the probe ran as. Runs as the runner does: the account's own login
 * folder, an allow-listed environment, cwd /tmp, no stdin, bounded time and output, and the
 * whole process group killed at the end.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { AccountConfig } from './identity.ts';
import type { AllowanceLedger, BucketReading } from './allowance.ts';
import type { IdentityLedger, ObservedIdentity } from './availability.ts';
import { claudeUsageBucket, codexBucket } from './buckets.ts';

type Provider = 'claude' | 'codex';

/** Two TCP attempts, each bounded by 10 s; callers allow 21 s overall. */
export async function tcpReachable(host: string, dial: (options: { host: string; port: number }) => Socket = connect): Promise<boolean> {
  const once = () => new Promise<boolean>((resolve) => {
    const socket = dial({ host, port: 443 });
    const end = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(10_000, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
  return await once() || await once();
}

export type ProbeOptions = {
  /** Paths to the official CLIs; by default `claude` and `codex` on the allow-listed PATH. */
  cli: { claude?: string; codex?: string };
  /** Source of the allow-listed environment; process.env by default. */
  env?: Record<string, string | undefined>;
  /** Whether the provider's service can be reached now; a TCP connection by default. */
  reachable?: (provider: Provider) => Promise<boolean>;
  /** Per command, in ms; 30 s by default. */
  timeoutMs?: number;
  now?: () => Date;
  /** The oldest CLI version still fit to run, per provider. */
  minVersion?: Partial<Record<Provider, string>>;
  codexCredits?: { floor: number };
};

export type IdentityProbe =
  | { state: 'signed-in' | 'signed-out'; identity: ObservedIdentity; reason?: string }
  | { state: 'offline' | 'unknown'; reason: string };
export type AllowanceProbe =
  /** `verified` is false when the probe cannot prove the reading is fresh (Claude's /usage, L14). */
  | { state: 'ok'; buckets: BucketReading[]; measuredAt: string; verified: boolean }
  | { state: 'offline' | 'signed-out' | 'unknown'; reason: string };
export type VersionProbe =
  | { state: 'ok'; version: string; outdated: boolean; minimum: string | null }
  | { state: 'unknown'; reason: string };
export type ModelsProbe = { state: 'ok'; models: string[] } | { state: 'none' | 'unknown'; reason: string };
export type ProbeReport = {
  accountId: string;
  provider: Provider;
  identity: IdentityProbe;
  allowance: AllowanceProbe;
  version: VersionProbe;
  models: ModelsProbe;
};

const ENV_KEYS: ReadonlySet<string> = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TERM']);
const LOGIN_VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as const;
const SERVICE_HOST = { claude: 'api.anthropic.com', codex: 'chatgpt.com' } as const;
const MAX_OUTPUT = 1024 * 1024;
const REACH_MS = 21_000;
/** The router's isolating argv: a free local command, with no MCP servers, settings or session. */
const USAGE_ARGV = ['-p', '/usage', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--setting-sources', '', '--no-session-persistence', '--tools', ''];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const sha8 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);

/** Probe one account through its provider's official CLI. Never throws for the provider's sake. */
export async function probeAccount(account: AccountConfig, options: ProbeOptions): Promise<ProbeReport> {
  const provider = account.provider;
  const accountId = account.id;
  if (provider !== 'claude' && provider !== 'codex') {
    const reason = `${String(provider)} has no probe yet`;
    return { accountId, provider: provider as Provider, identity: { state: 'unknown', reason }, allowance: { state: 'unknown', reason },
      version: { state: 'unknown', reason }, models: { state: 'unknown', reason } };
  }
  const clock = options.now ?? (() => new Date());
  const stamp = (): string => clock().toISOString();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cli = options.cli[provider] ?? provider;
  const env = { ...allowList(options.env ?? process.env), [LOGIN_VAR[provider]]: account.loginDir };
  const version = await probeVersion(cli, env, timeoutMs, options.minVersion?.[provider] ?? null);
  const parts = provider === 'claude'
    ? { identity: await claudeIdentity(accountId, cli, env, timeoutMs, stamp),
      allowance: await claudeAllowance(cli, env, timeoutMs, clock, options.reachable ?? serviceReachable),
      models: { state: 'none', reason: 'Claude publishes no model list; the policy is the only list' } as ModelsProbe }
    : await codexProbe(accountId, cli, env, timeoutMs, stamp, options.codexCredits);
  // Readings belong only to their account: allowance counts only when this login is the one
  // pinned in config. Anything else would record another login's allowance under this account.
  const who = parts.identity.state === 'signed-in' ? parts.identity.identity.fingerprint : null;
  const allowance: AllowanceProbe = parts.allowance.state !== 'ok' || who === account.fingerprint ? parts.allowance
    : { state: 'unknown', reason: parts.identity.state === 'signed-in' ? 'the login is not the one pinned in config, so its allowance is not this account\'s' : 'no signed-in login to bind the allowance to' };
  return { accountId, provider, version, ...parts, allowance };
}

/**
 * Record a report's ok evidence for its own account, and nothing else: a failed part leaves the
 * ledgers as they were. A part that names another account refuses the whole report.
 */
export function applyProbe(report: ProbeReport, ledgers: { identities: IdentityLedger; allowances: AllowanceLedger }): void {
  const id = report.identity;
  if ((id.state === 'signed-in' || id.state === 'signed-out') && id.identity.accountId !== report.accountId) {
    throw new Error(`the identity evidence names another account (${id.identity.accountId}), not ${report.accountId}`);
  }
  if (id.state === 'signed-in' || id.state === 'signed-out') {
    ledgers.identities.record(report.accountId, { signedIn: id.identity.signedIn, fingerprint: id.identity.fingerprint, observedAt: id.identity.observedAt });
  }
  // Allowance is this account's only when the same report shows its pinned login signed in.
  if (report.allowance.state === 'ok' && id.state === 'signed-in') {
    ledgers.allowances.record(report.accountId, report.allowance.buckets, report.allowance.measuredAt, { verified: report.allowance.verified });
  }
}

/** The answer to a model id that is not offered: the provider's own list, where there is one (L5). */
export function explainUnknownModel(models: ModelsProbe, requested: string): string {
  return models.state === 'ok'
    ? `model ${requested} is not offered; the official list is: ${models.models.join(', ')}`
    : `model ${requested} is not known, and there is no official list to check it against (${models.reason})`;
}

// ── Claude ──────────────────────────────────────────────────────────────────

async function claudeIdentity(accountId: string, cli: string, env: Record<string, string>, timeoutMs: number, stamp: () => string): Promise<IdentityProbe> {
  // `auth status` is local, and prints JSON even when signed out (exit 1).
  const ran = await run(cli, ['auth', 'status'], env, timeoutMs);
  if (!ran.ok) return { state: 'unknown', reason: ran.reason };
  let s: Obj | null = null;
  try { s = obj(JSON.parse(ran.stdout)); } catch { /* not JSON */ }
  if (!s || typeof s.loggedIn !== 'boolean') return { state: 'unknown', reason: 'auth status gave no sign-in state' };
  // The CLI answers signed in with exit 0 and signed out with exit 1; any other pairing is a failure.
  if (ran.code !== (s.loggedIn ? 0 : 1)) return { state: 'unknown', reason: `auth status exited ${String(ran.code)} while reporting loggedIn ${String(s.loggedIn)}` };
  const observedAt = stamp();
  const out = (reason: string): IdentityProbe => ({ state: 'signed-out', identity: { accountId, signedIn: false, fingerprint: null, observedAt }, reason });
  if (!s.loggedIn) return out('not signed in');
  if (s.authMethod === 'api_key' || s.apiProvider === 'bedrock' || s.apiProvider === 'vertex' || s.subscriptionType === null) {
    return out(`signed in, but not a subscription login (${String(s.authMethod)}, ${String(s.apiProvider)}, ${String(s.subscriptionType)})`);
  }
  if (s.authMethod !== 'claude.ai' || s.apiProvider !== 'firstParty' || typeof s.subscriptionType !== 'string'
    || !/^(pro|max|ultra|team|enterprise)$/iu.test(s.subscriptionType)) {
    return { state: 'unknown', reason: 'auth status has missing or malformed subscription login fields' };
  }
  if ((s.orgId !== undefined && text(s.orgId) === null) || (s.email !== undefined && text(s.email) === null))
    return { state: 'unknown', reason: 'auth status has a malformed identity id' };
  const who = text(s.orgId) ?? text(s.email);
  if (who === null) return { state: 'unknown', reason: 'auth status has no usable identity id' };
  return { state: 'signed-in', identity: { accountId, signedIn: true, fingerprint: sha8(who), observedAt } };
}

async function claudeAllowance(cli: string, env: Record<string, string>, timeoutMs: number, clock: () => Date,
  reachable: (provider: Provider) => Promise<boolean>): Promise<AllowanceProbe> {
  // /usage answers from its cache when the service is unreachable, and says nothing (L14): the
  // reading is a measurement only when this probe reaches the service.
  const up = await within(Promise.resolve().then(() => reachable('claude')), Math.min(timeoutMs, REACH_MS));
  if (up !== true) return { state: 'offline', reason: 'the service could not be reached, so /usage would answer from its cache' };
  const measured = clock();
  const ran = await run(cli, USAGE_ARGV, env, timeoutMs);
  if (!ran.ok) return { state: 'unknown', reason: ran.reason };
  if (ran.code !== 0) return { state: 'unknown', reason: `/usage exited with code ${ran.code}` };
  let d: Obj | null = null;
  try { d = obj(JSON.parse(ran.stdout)); } catch { /* not JSON */ }
  if (!d) return { state: 'unknown', reason: '/usage did not answer in JSON' };
  if (d.is_error !== false || d.num_turns !== 0 || d.total_cost_usd !== 0) {
    return { state: 'unknown', reason: '/usage ran a turn, cost something or reported an error: not a free status reading' };
  }
  const buckets = parseClaudeUsage(String(d.result ?? ''), measured);
  if (buckets === null) return { state: 'unknown', reason: '/usage reported an allowance line that could not be read in full' };
  // Both account-wide windows, or no verdict: a missing week is unmeasured, never room.
  const has = (bucket: string) => buckets.some((b) => b.bucket === bucket && b.model === null);
  if (!has('five_hour') || !has('seven_day')) return { state: 'unknown', reason: '/usage did not report both the session and the week' };
  return { state: 'ok', buckets, measuredAt: measured.toISOString(), verified: false };
}

/** The allowance lines of `/usage`, named as the runner names limits (buckets.ts); null if any of them cannot be read in full. */
export function parseClaudeUsage(result: string, now: Date): BucketReading[] | null {
  const out: BucketReading[] = [];
  for (const line of result.split('\n')) {
    // Every allowance line must be read in full: one that looks like a window but cannot be read
    // (an odd zone, a new format, a model we do not know) makes the whole reading unknown.
    // Any "Current …" window counts: one we cannot name or read makes the reading unknown.
    if (!/^\W*current\b/iu.test(line.trim())) continue;
    // A window not yet started (e.g. "Current session: 0% used") states no reset: that is a reading with none.
    const m = /^Current (session|week)(?: \(([^)]+)\))?: (\d{1,3})% used(?: · resets (.+?) \(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\))?\s*$/u.exec(line.trim());
    if (!m) return null;
    const name = claudeUsageBucket(m[1]!, m[2] ?? null);
    const percent = Number(m[3]);
    if (!name || percent > 100) return null;
    const resetsAt = m[4] === undefined ? null : resetInstant(m[4], m[5]!, now);
    if (m[4] !== undefined && resetsAt === null) return null;   // a reset was stated: unreadable is not "none"
    out.push({ ...name, usedFraction: percent / 100, resetsAt });
  }
  // No session line: verified Ultra has no five-hour limit (Claude Help Center, 2026-10-31), or no window is open.
  // With the account-wide week read, the session is at 0% now; a job's own limit still holds. Without that week: unknown.
  if (out.some((b) => b.bucket === 'seven_day' && b.model === null) && !out.some((b) => b.bucket === 'five_hour')) out.push({ bucket: 'five_hour', model: null, usedFraction: 0, resetsAt: null });
  return out;
}

/** "Sep 24 at 10:59pm" or "7:10pm", in an IANA zone: the next such time, as an instant, or null. */
function resetInstant(when: string, zone: string, now: Date): string | null {
  const m = /^(?:([A-Za-z]{3})[a-z]* (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm)$/iu.exec(when.trim());
  if (!m) return null;
  const hour12 = Number(m[3]);
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (m[5]!.toLowerCase() === 'pm' ? 12 : 0);
  const t = now.getTime();
  const today = wallParts(t, zone);
  if (!today) return null;   // an unknown zone
  let candidates: number[];
  if (m[1] !== undefined) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const day = Number(m[2]);
    if (month < 0) return null;
    // A reset is ahead: a date more than a day behind belongs to next year. A time that does not
    // exist this year (not a real date, or in a spring-forward gap) is unreadable, not next year's.
    if (!realDate(today.year, month, day)) return null;
    const thisYear = zonedInstants(today.year, month, day, hour, minute, zone);
    if (thisYear.length === 0) return null;
    candidates = thisYear.filter((c) => c >= t - 86_400_000);
    if (candidates.length === 0) candidates = realDate(today.year + 1, month, day) ? zonedInstants(today.year + 1, month, day, hour, minute, zone) : [];
  } else {
    candidates = [0, 1].flatMap((ahead) => {
      const d = new Date(Date.UTC(today.year, today.month, today.day + ahead));
      return zonedInstants(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, zone);
    }).filter((c) => c > t);
  }
  return candidates.length === 0 ? null : new Date(Math.min(...candidates)).toISOString();
}

function realDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day;
}

function wallParts(t: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const v = { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
    return Object.values(v).every(Number.isFinite) ? v : null;
  } catch { return null; }   // an unknown zone
}

/**
 * Every instant a wall time names in a zone, each checked by converting it back: none in a
 * spring-forward gap, two in a fall-back hour. The zone's offsets half a day either side cover
 * both sides of any transition, which are months apart.
 */
function zonedInstants(year: number, month: number, day: number, hour: number, minute: number, zone: string): number[] {
  const wall = Date.UTC(year, month, day, hour, minute);
  const found = new Set<number>();
  for (const probe of [wall - 43_200_000, wall + 43_200_000]) {
    const p = wallParts(probe, zone);
    if (!p) return [];
    const offset = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(probe / 1000) * 1000;
    const instant = wall - offset;
    const back = wallParts(instant, zone);
    if (back && Date.UTC(back.year, back.month, back.day, back.hour, back.minute) === wall) found.add(instant);
  }
  return [...found];
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** A full window its own credits cover counts as this much room; the queue ranks credit room last (rule 49). */
const CREDIT_HEADROOM = 0.05;

/** `codexCredits` from the config: absent is off; anything but a finite floor of 0 or more is refused (rule 49). */
export function codexCreditsConfig(value: unknown): { floor: number } | undefined {
  if (value === undefined) return undefined;
  const floor = obj(value)?.floor;
  if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0) throw new RangeError('codexCredits.floor must be a finite number of credits, 0 or more');
  return { floor };
}

/** Whether a limit's own credits may carry a full window: opted in, well formed, not spend-capped, above the floor. */
function isCreditCovered(limit: Obj, config?: { floor: number }): boolean {
  if (!config) return false;
  const c = obj(limit.credits);
  if (!c || typeof c.hasCredits !== 'boolean' || typeof c.unlimited !== 'boolean') return false;
  if (c.hasCredits !== true || limit.spendControlReached === true) return false;
  if (c.unlimited === true) return true;   // unlimited credits need no balance or floor
  // A plain decimal only: no hex, exponent, sign, separators or padding.
  const raw = c.balance;
  const balance = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(\.\d+)?$/u.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(balance) && balance > config.floor;
}

async function codexProbe(accountId: string, cli: string, env: Record<string, string>, timeoutMs: number, stamp: () => string, creditsConfig?: { floor: number }):
  Promise<Pick<ProbeReport, 'identity' | 'allowance' | 'models'>> {
  // Stamped before the questions are asked, so the evidence is never dated later than it was
  // observed: a job's limit that lands meanwhile stays newer than the reading.
  const asked = stamp();
  const session = await appServer(cli, env, timeoutMs, [
    ['account/read', { refreshToken: false }], ['account/rateLimits/read', undefined], ['model/list', {}],
  ]);
  if (!session.ok) {
    return { identity: { state: 'unknown', reason: session.reason }, allowance: { state: 'unknown', reason: session.reason }, models: { state: 'unknown', reason: session.reason } };
  }
  const [account, limits, list] = session.responses;
  const identity = codexIdentity(accountId, account, asked);
  const login = identity.state === 'signed-in' ? identity.identity.fingerprint : null;
  return { identity, allowance: codexAllowance(limits, login, asked, creditsConfig), models: codexModels(list) };
}

function codexIdentity(accountId: string, response: Obj | undefined, observedAt: string): IdentityProbe {
  const result = obj(response?.result);
  if (!result || !('account' in result)) return { state: 'unknown', reason: 'account/read gave no answer' };
  const out = (reason: string): IdentityProbe => ({ state: 'signed-out', identity: { accountId, signedIn: false, fingerprint: null, observedAt }, reason });
  if (result.account === null) return out('not signed in');
  const account = obj(result.account);
  if (!account) return { state: 'unknown', reason: 'account/read gave a malformed account' };
  if (account.type === 'apiKey') return out(`signed in, but not a subscription login (${String(account.type)})`);
  if (account.type !== 'chatgpt') return { state: 'unknown', reason: 'account/read gave an unrecognized login type' };
  // Local, so known offline: it hashes to the same fingerprint as rateLimits' networked accountId.
  const who = text(obj(result.workspaceRouting)?.chatgptAccountId);
  if (who === null) return { state: 'unknown', reason: 'account/read has no usable identity id' };
  return { state: 'signed-in', identity: { accountId, signedIn: true, fingerprint: sha8(who), observedAt } };
}

function codexAllowance(response: Obj | undefined, login: string | null, measuredAt: string, creditsConfig?: { floor: number }): AllowanceProbe {
  const error = obj(response?.error);
  if (error) {
    const message = String(error.message ?? '');
    if (error.code === -32600 && /authentication required/iu.test(message)) return { state: 'signed-out', reason: message };
    if (error.code === -32603 && /error sending request|failed to fetch/iu.test(message)) return { state: 'offline', reason: message };
    return { state: 'unknown', reason: `rateLimits failed: ${message.slice(0, 200)}` };
  }
  const result = obj(response?.result);
  if (!result) return { state: 'unknown', reason: 'account/rateLimits/read gave no answer' };
  const byId = obj(result.rateLimitsByLimitId);
  const limits = byId ? Object.values(byId) : [result.rateLimits];
  const ordinaryRefused = result.ordinaryUsageAllowed === false;
  const buckets: BucketReading[] = [];
  for (const raw of limits) {
    const limit = obj(raw);
    const limitId = text(limit?.limitId);
    if (!limit || !limitId) return { state: 'unknown', reason: 'a rate limit names no limit id' };
    const slug = limit.normalModelSlug;
    const model = slug === null || slug === undefined ? null : text(slug);
    if (slug !== null && slug !== undefined && model === null) return { state: 'unknown', reason: `the ${limitId} limit names a malformed model` };
    for (const window of ['primary', 'secondary'] as const) {
      if (limit[window] === null || limit[window] === undefined) continue;
      const w = obj(limit[window]);
      const used = w?.usedPercent;
      const resets = w?.resetsAt;
      const minutes = w?.windowDurationMins;
      // One malformed window makes the whole reading unmeasured: never a partial picture.
      if (typeof used !== 'number' || !(used >= 0 && used <= 100) || typeof minutes !== 'number' || !(minutes > 0)
        || typeof resets !== 'number' || !(resets > 1e9 && resets < 1e11)) {
        return { state: 'unknown', reason: `the ${limitId} ${window} window is malformed` };
      }
      // Refused ordinary use is one flag for the whole answer, so it fills every window of every limit: room left
      // would be drawn from credits (rule 5).
      const full = used >= 100 || ordinaryRefused;
      const covered = full && isCreditCovered(limit, creditsConfig);
      buckets.push({
        ...codexBucket(limitId, window, model),
        usedFraction: covered ? 1 - CREDIT_HEADROOM : full ? 1 : used / 100,
        resetsAt: new Date(resets * 1000).toISOString(),
        ...(covered ? { via: 'credits' as const } : {}),
      });
    }
  }
  if (buckets.length === 0) return { state: 'unknown', reason: 'rateLimits reported no window' };
  // The rate limits name their login; they must be the login account/read reported.
  const owner = text(result.accountId);
  if (owner === null || sha8(owner) !== login) return { state: 'unknown', reason: 'the rate limits do not name the signed-in login' };
  return { state: 'ok', buckets, measuredAt, verified: true };
}

function codexModels(response: Obj | undefined): ModelsProbe {
  const data = obj(response?.result)?.data;
  if (!Array.isArray(data)) return { state: 'unknown', reason: 'model/list gave no answer' };
  const models = data.map(obj).filter((m): m is Obj => m !== null && m.hidden !== true).map((m) => text(m.id)).filter((id): id is string => id !== null);
  return models.length > 0 ? { state: 'ok', models } : { state: 'unknown', reason: 'model/list is empty' };
}

/**
 * One app-server session: initialize, then each request once. Server requests and notifications
 * are ignored, never answered. Bounded in time and output; the process group dies at the end.
 */
async function appServer(cli: string, env: Record<string, string>, timeoutMs: number, requests: Array<[string, unknown]>):
  Promise<{ ok: true; responses: Array<Obj | undefined> } | { ok: false; reason: string }> {
  let child;
  try { child = spawn(cli, ['app-server', '--listen', 'stdio://'], { cwd: '/tmp', env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (e) { return { ok: false, reason: `could not start ${cli}: ${(e as Error).message}` }; }
  const responses = new Map<number, Obj>();
  return await new Promise((resolve) => {
    let buffer = '';
    let bytes = 0;
    let settled = false;
    const finish = (value: { ok: true; responses: Array<Obj | undefined> } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: `${cli} app-server did not answer within ${timeoutMs} ms` }), timeoutMs);
    const send = (m: Obj) => { child.stdin.write(`${JSON.stringify(m)}\n`); };
    child.stdin.on('error', () => {});
    child.once('error', (e) => finish({ ok: false, reason: `could not start ${cli}: ${e.message}` }));
    child.once('exit', () => finish({ ok: false, reason: `${cli} app-server exited before answering` }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return finish({ ok: false, reason: `${cli} app-server wrote more than ${MAX_OUTPUT} bytes` });
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let m: Obj | null = null;
        try { m = obj(JSON.parse(line)); } catch { continue; }
        if (!m || 'method' in m || typeof m.id !== 'number') continue;   // server requests and notifications
        if (m.id === 1) {
          send({ method: 'initialized', params: {} });
          requests.forEach(([method, params], k) => send({ id: k + 2, method, ...(params === undefined ? {} : { params }) }));
          continue;
        }
        responses.set(m.id, m);
        if (requests.every((_, k) => responses.has(k + 2))) finish({ ok: true, responses: requests.map((_, k) => responses.get(k + 2)) });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pipe_probe', version: '1' } } });
  });
}

// ── both ────────────────────────────────────────────────────────────────────

async function probeVersion(cli: string, env: Record<string, string>, timeoutMs: number, minimum: string | null): Promise<VersionProbe> {
  const ran = await run(cli, ['--version'], env, timeoutMs);
  if (!ran.ok) return { state: 'unknown', reason: ran.reason };
  if (ran.code !== 0) return { state: 'unknown', reason: `the version command exited with ${ran.code ?? 'no status'}` };
  const found = /(\d+)\.(\d+)\.(\d+)/u.exec(ran.stdout);
  if (!found) return { state: 'unknown', reason: 'the version could not be read' };
  const version = `${Number(found[1])}.${Number(found[2])}.${Number(found[3])}`;
  const floor = minimum === null ? null : /^(\d+)\.(\d+)\.(\d+)$/u.exec(minimum);
  const outdated = floor !== null && compare(version.split('.').map(Number), floor.slice(1).map(Number)) < 0;
  return { state: 'ok', version, outdated, minimum };
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

type Ran = { ok: true; code: number | null; stdout: string; stderr: string } | { ok: false; reason: string };

/** One command: no stdin, cwd /tmp, bounded time and output; its whole process group is killed at the end. */
function run(cli: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cli, args, { cwd: '/tmp', env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ ok: false, reason: `could not start ${cli}: ${(e as Error).message}` }); return; }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (r: Ran) => { if (settled) return; settled = true; clearTimeout(timer); killGroup(child.pid); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, reason: `${cli} ${args[0] ?? ''} did not finish within ${timeoutMs} ms` }), timeoutMs);
    const take = (into: Buffer[]) => (d: Buffer) => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT) finish({ ok: false, reason: `${cli} ${args[0] ?? ''} wrote more than ${MAX_OUTPUT} bytes` });
      else into.push(d);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.once('error', (e) => finish({ ok: false, reason: `could not start ${cli}: ${e.message}` }));
    child.once('close', (code) => finish({ ok: true, code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Whether a TCP connection reaches the provider's service within the bound. */
async function serviceReachable(provider: Provider): Promise<boolean> {
  return tcpReachable(SERVICE_HOST[provider]);
}

/** The promise's value, or null if it does not settle within `ms`: an unanswered check proves nothing. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  try { return await Promise.race([p.catch(() => null), timeout]); }
  finally { clearTimeout(timer); }
}

function allowList(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (ENV_KEYS.has(k) || k.startsWith('LC_'))) out[k] = v;
  return out;
}

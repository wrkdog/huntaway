import process from 'node:process';
import type { LocalRun } from './runs.ts';

export type Room = 'plenty' | 'some' | 'low' | 'none' | 'credits' | 'unknown';

/** The owner's short name for a machine: the contract's alias pattern (never a dotted hostname or an address). */
export type MachineAlias = string;
export const ALIAS_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,30}[A-Za-z0-9_-])?$/u;
export const validAlias = (value: unknown): value is MachineAlias => typeof value === 'string' && ALIAS_PATTERN.test(value);

/**
 * Standalone (no Router here) unless a fleet helper is configured: the helper runs only when HUNTAWAY_FLEET_CMD names
 * it (`install-local.sh --router` writes the Router's), never by default. "none" also means standalone.
 */
export const isStandalone = (): boolean => {
  const cmd = process.env.HUNTAWAY_FLEET_CMD;
  return cmd === undefined || cmd === '' || cmd === 'none';
};

export type SubscriptionFamily = 'claude' | 'codex' | 'gemini';

export type Subscription = {
  family: SubscriptionFamily;
  room: Room;
  resetsAt: string | null;
};

export type Machine = {
  alias: MachineAlias;
  online: boolean;
  lastSeenAt: string | null;
  subscriptions: Subscription[];
};

export type Snapshot = {
  schemaVersion: 1;
  source: 'live';
  asOf: string;
  machines: Machine[];
  runs: LocalRun[];
};

// The ECMAScript date-time form only (upper-case T and Z, or a +HH:MM offset). An explicit zone is required:
// JavaScript reads a zoneless time as the machine's local time.
const ISO_DATETIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

/**
 * Which machines in a fleet reading are the owner's, and what each is called: the owner's own configuration,
 * `HUNTAWAY_FLEET_ALIASES="nodeid=Name,nodeid=Name"` (written by `install-local.sh --fleet-aliases`), never names in
 * the code. Node ids are lower-case letters, digits and '-'; names follow the alias rule. Order is kept; a malformed
 * list, or a node id or name given twice, is refused as a whole (null), never half-used.
 */
export type FleetMachine = { nodeId: string; alias: MachineAlias };
export function fleetAliases(value: string | undefined = process.env.HUNTAWAY_FLEET_ALIASES): FleetMachine[] | null {
  if (value === undefined || value.trim() === '') return [];
  const out: FleetMachine[] = [];
  for (const part of value.split(',')) {
    const eq = part.indexOf('=');
    const nodeId = eq > 0 ? part.slice(0, eq).trim() : '';
    const alias = eq > 0 ? part.slice(eq + 1).trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(nodeId) || !validAlias(alias)) return null;
    if (out.some((m) => m.nodeId === nodeId || m.alias.toLowerCase() === alias.toLowerCase())) return null;
    out.push({ nodeId, alias });
  }
  return out;
}

// The Router names Gemini's family "google" today; "gemini" is accepted too, in case it is renamed. One entry per
// family: the first name found wins.
const TARGET_FAMILIES: readonly {
  rawFamilies: readonly string[];
  family: SubscriptionFamily;
}[] = [
  { rawFamilies: ['claude'], family: 'claude' },
  { rawFamilies: ['codex'], family: 'codex' },
  { rawFamilies: ['google', 'gemini'], family: 'gemini' },
];

export function roomFromPercent(
  remaining: number | null | undefined,
  state?: string,
): Room {
  if (
    remaining === null ||
    remaining === undefined ||
    typeof remaining !== 'number' ||
    Number.isNaN(remaining)
  ) {
    return 'unknown';
  }
  if (state === 'exhausted' || remaining <= 0) {
    return 'none';
  }
  if (remaining >= 50) {
    return 'plenty';
  }
  if (remaining >= 20) {
    return 'some';
  }
  return 'low';
}

/**
 * A time from the fleet or the run list as an ISO instant, or null. Only 1970-9999 is accepted (years 0000-0099 are
 * refused too: JavaScript would read them as 1900-1999), and a zone offset must be a real one (up to 23:59).
 */
export function toInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATETIME.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (y < 1970) return null;
  const offset = /([+-])([0-9]{2}):([0-9]{2})$/.exec(value);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return null;
  // Refuse impossible calendar values (V8 would roll Feb 30 over to Mar 2).
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d ||
      probe.getUTCHours() !== h || probe.getUTCMinutes() !== mi || probe.getUTCSeconds() !== se) {
    return null;
  }
  const date = new Date(value.replace(/(\.[0-9]{3})[0-9]+/, '$1'));
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 1970 && year <= 9999 ? date.toISOString() : null;
}

// Host status words from the fleet reading: "observed" is on, "unavailable" is asleep or unreachable. Any other
// status is not guessed at: that host is left out (and a reading with no known host is an error in the CLI).
const HOST_ONLINE: Readonly<Record<string, boolean>> = { observed: true, unavailable: false };

type Window = { remaining: number; resetAt: unknown; exhausted: boolean };

function usableWindows(windows: unknown[]): Window[] | null {
  const out: Window[] = [];
  for (const w of windows) {
    if (w === null || typeof w !== 'object') return null;
    const win = w as Record<string, unknown>;
    const state = win.state;
    const remaining = win.remainingPercent;
    // Only an observed reading counts; a stale or unknown window caps the whole account at "unknown".
    if ((state !== undefined && state !== 'observed' && state !== 'exhausted') ||
        typeof remaining !== 'number' || !Number.isFinite(remaining)) {
      return null;
    }
    out.push({ remaining, resetAt: win.resetAt, exhausted: state === 'exhausted' || remaining <= 0 });
  }
  return out.length > 0 ? out : null;
}

function latestReset(windows: Window[]): string | null {
  let best: string | null = null;
  for (const w of windows) {
    const t = toInstant(w.resetAt);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

/**
 * Codex keeps serving on credits once a plan's allowance is spent (2026-09-29). The fleet helper reports its credit
 * facts on each Codex window, null unless the window is observed. They count only on an observed window, and only when
 * the helper's own verdict agrees with the facts it rests on: no spend control reached, and unlimited or a positive
 * balance. How big the balance is does not change the room.
 */
function creditsUsable(win: Record<string, unknown>): boolean {
  const c = win.credits;
  if (win.state !== 'observed' || c === null || typeof c !== 'object' || Array.isArray(c)) return false;
  const credits = c as Record<string, unknown>;
  const balance = credits.balance;
  return credits.usable === true && credits.spendControlReached !== true &&
    (credits.unlimited === true || (typeof balance === 'number' && Number.isFinite(balance) && balance > 0));
}

function subscriptionFor(
  fleet: { pools?: unknown[] },
  rawFamily: string,
  family: SubscriptionFamily,
  provider: Record<string, unknown>,
): Subscription {
  const unknown: Subscription = { family, room: 'unknown', resetsAt: null };
  const fingerprint = provider.accountFingerprint;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0 || !Array.isArray(fleet.pools)) return unknown;
  const pool = fleet.pools.find(
    (p): p is Record<string, unknown> =>
      p !== null && typeof p === 'object' &&
      (p as Record<string, unknown>).family === rawFamily &&
      (p as Record<string, unknown>).accountFingerprint === fingerprint,
  );
  if (!pool || !Array.isArray(pool.windows)) return unknown;
  // An exhausted window decides the room whatever its siblings say: out of room until the LAST one refills, or on
  // credits when every exhausted window can keep working on them. A stale window at 0% does not count as exhausted.
  const exhausted: Window[] = [];
  let spentOnCredits = true;
  for (const w of pool.windows) {
    if (w === null || typeof w !== 'object') continue;
    const win = w as Record<string, unknown>;
    const fresh = win.state === undefined || win.state === 'observed';
    if (win.state === 'exhausted' ||
        (fresh && typeof win.remainingPercent === 'number' && Number.isFinite(win.remainingPercent) && win.remainingPercent <= 0)) {
      exhausted.push({ remaining: 0, resetAt: win.resetAt, exhausted: true });
      if (!creditsUsable(win)) spentOnCredits = false;
    }
  }
  if (exhausted.length > 0) {
    return { family, room: spentOnCredits ? 'credits' : 'none', resetsAt: latestReset(exhausted) };
  }
  const windows = usableWindows(pool.windows);
  if (windows === null) return unknown;
  const lowest = windows.reduce((min, w) => (w.remaining < min ? w.remaining : min), Infinity);
  const binding = windows.filter((w) => w.remaining === lowest);
  // Codex can refuse ordinary use before any percent reads 0 (a lagging reading): then its tightest window binds, and
  // credits decide between "credits" and "none". usableWindows has checked that every window is an object.
  const raw = pool.windows as Record<string, unknown>[];
  if (raw.some((w) => w.state === 'observed' && w.ordinaryUsageAllowed === false)) {
    const tightest = raw.filter((w) => w.remainingPercent === lowest);
    const onCredits = tightest.length > 0 && tightest.every(creditsUsable);
    return { family, room: onCredits ? 'credits' : 'none', resetsAt: latestReset(binding) };
  }
  return { family, room: roomFromPercent(lowest), resetsAt: latestReset(binding) };
}

export function machinesFromFleet(fleet: unknown, known: readonly FleetMachine[] | null = fleetAliases()): Machine[] {
  if (known === null) throw new Error('HUNTAWAY_FLEET_ALIASES is not a valid list');   // never silently empty
  if (
    fleet === null ||
    typeof fleet !== 'object' ||
    Array.isArray(fleet) ||
    !Array.isArray((fleet as Record<string, unknown>).hosts)
  ) {
    return [];
  }
  const fleetObj = fleet as { hosts: unknown[]; pools?: unknown[] };
  const machines: Machine[] = [];
  const nowIso = new Date().toISOString();
  for (const { nodeId, alias } of known) {
    // If a machine is listed twice, the first entry with a known status counts.
    const host = fleetObj.hosts.find(
      (h): h is Record<string, unknown> =>
        h !== null && typeof h === 'object' && (h as Record<string, unknown>).nodeId === nodeId &&
        typeof (h as Record<string, unknown>).status === 'string' &&
        Object.hasOwn(HOST_ONLINE, (h as Record<string, unknown>).status as string),
    );
    if (!host) continue;
    // An asleep machine keeps its subscriptions: room belongs to the account, not to whether the Mac is awake.
    const subscriptions: Subscription[] = [];
    if (Array.isArray(host.providers)) {
      for (const { rawFamilies, family } of TARGET_FAMILIES) {
        for (const rawFamily of rawFamilies) {
          const provider = host.providers.find(
            (p): p is Record<string, unknown> =>
              p !== null && typeof p === 'object' && (p as Record<string, unknown>).family === rawFamily,
          );
          if (provider) {
            subscriptions.push(subscriptionFor(fleetObj, rawFamily, family, provider));
            break;
          }
        }
      }
    }
    // A host clock ahead of this one never shows a machine as seen in the future.
    const seen = toInstant(host.observedAt);
    const ahead = seen !== null && Date.parse(seen) > Date.parse(nowIso);
    machines.push({ alias, online: HOST_ONLINE[host.status], lastSeenAt: ahead ? nowIso : seen, subscriptions });
  }
  return machines;
}

/** When the fleet was read: its own observedAt, else the OLDEST host observedAt, else null. */
export function readingTime(fleet: unknown): string | null {
  if (fleet === null || typeof fleet !== 'object') return null;
  const f = fleet as Record<string, unknown>;
  const own = toInstant(f.observedAt);
  if (own !== null) return own;
  let oldest: string | null = null;
  if (Array.isArray(f.hosts)) {
    for (const h of f.hosts) {
      const t = h !== null && typeof h === 'object' ? toInstant((h as Record<string, unknown>).observedAt) : null;
      if (t !== null && (oldest === null || t < oldest)) oldest = t;
    }
  }
  return oldest;
}

/**
 * Standalone: this machine only, seen now, with no subscriptions listed (without the Router there is no reading of
 * subscription room, and a guessed one would mislead).
 */
export function standaloneSnapshot({ now, alias, runs = [] }: { now: Date; alias: MachineAlias; runs?: LocalRun[] }): Snapshot {
  if (!validAlias(alias)) throw new Error('not a valid alias');
  const nowIso = toInstant(now.toISOString())!;
  return {
    schemaVersion: 1,
    source: 'live',
    asOf: nowIso,
    machines: [{ alias, online: true, lastSeenAt: nowIso, subscriptions: [] }],
    runs,
  };
}

/** The snapshot is as of the reading (never later than now), so a front end can tell a stale reading from a fresh one. */
export function buildSnapshot({ now, fleet, runs = [] }: { now: Date; fleet: unknown; runs?: LocalRun[] }): Snapshot {
  const nowIso = toInstant(now.toISOString())!;
  const observed = readingTime(fleet);
  return {
    schemaVersion: 1,
    source: 'live',
    asOf: observed !== null && observed < nowIso ? observed : nowIso,
    machines: machinesFromFleet(fleet),
    runs,
  };
}

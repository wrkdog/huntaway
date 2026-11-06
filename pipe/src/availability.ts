import type { AccountConfig } from './identity.ts';
import { instantOf, type AllowanceView } from './allowance.ts';

/** What the provider's status command reported for one account's login folder. */
export type ObservedIdentity = {
  accountId: string;
  signedIn: boolean;
  fingerprint: string | null;
  /** An instant: an ISO 8601 date-time with an explicit offset (see allowance.ts). */
  observedAt: string;
};
export type Health = { ok: true } | { ok: false; reason: string; until: string | null };

export type Availability =
  | { state: 'available'; headroom: number; via?: 'credits' }
  | { state: 'busy'; running: number; max: number; leased?: number }
  | { state: 'unavailable'; reason: string; until: string | null; cause?: 'allowance' }
  | { state: 'unknown'; reason: string };

export type AvailabilityInput = {
  account: AccountConfig;
  /** The ledgers themselves: the verdict reads the current evidence, so nothing saved can outlive it. */
  identities: { view(accountId: string): ObservedIdentity | undefined };
  allowances: { view(accountId: string, model?: string): AllowanceView };
  /** The model the verdict is for; allowance can be model-scoped. */
  model?: string;
  running: number;
  leased?: number;
  health?: Health;
  /** The pipe's clock, and how long a login observation stays fresh on it. */
  now: Date;
  identityMaxAgeMs: number;
};

const unknown = (reason: string): Availability => ({ state: 'unknown', reason });

export function availability({ account, identities, allowances, model, running, leased = 0, health, now, identityMaxAgeMs }: AvailabilityInput): Availability {
  const stop = (reason: string, until: string | null = null): Availability => ({ state: 'unavailable', reason, until });
  if (!account.enabled) return stop('disabled in config');
  const t = now.getTime();
  if (!Number.isFinite(t)) return unknown('the verdict clock returned an invalid time');
  if (!Number.isFinite(identityMaxAgeMs) || identityMaxAgeMs <= 0) return unknown('the login freshness window is not a real duration');
  const identity = identities.view(account.id);
  if (!identity) return unknown('login not observed yet');
  if (identity.accountId !== account.id) return unknown(`login evidence belongs to another account (${identity.accountId})`);
  const seen = instantOf(identity.observedAt);
  if (seen === null) return unknown('login evidence has no valid time');
  if (seen > t) return unknown('login evidence is later than the clock');
  if (t - seen > identityMaxAgeMs) return unknown('login evidence is stale');
  if (typeof identity.signedIn !== 'boolean') return unknown('login evidence has no valid sign-in state');
  if (!identity.signedIn) return stop('signed out');
  if (identity.fingerprint === null) return unknown('signed in, but the login could not be identified');
  if (identity.fingerprint !== account.fingerprint) return stop('signed in as a different login than the one pinned in config');
  if (health && !health.ok) return stop(health.reason, health.until);
  const allowance = allowances.view(account.id, model);
  if (!allowance || typeof allowance !== 'object') return unknown('no allowance evidence');
  if (allowance.accountId !== account.id) return unknown(`allowance evidence belongs to another account (${allowance.accountId})`);
  if (allowance.state === 'exhausted') return { ...stop(`${allowance.bucket ?? 'an unnamed limit'} allowance exhausted`, allowance.until), cause: 'allowance' } as Availability;
  if (allowance.state === 'unknown') return unknown(`allowance unknown: ${allowance.reason}`);
  if (allowance.state !== 'ok' || !Number.isFinite(allowance.headroom) || allowance.headroom < 0 || allowance.headroom > 1) {
    return unknown('malformed allowance evidence');
  }
  if (!Number.isInteger(running) || running < 0) return unknown('the running count is not a whole number of jobs');
  if (!Number.isInteger(leased) || leased < 0) return unknown('the leased count is not a whole number');
  if (running + leased >= account.maxConcurrency) return { state: 'busy', running, max: account.maxConcurrency, ...(leased ? { leased } : {}) };
  return { state: 'available', headroom: allowance.headroom, ...(allowance.via ? { via: allowance.via } : {}) };
}

export class IdentityLedger {
  #now: () => Date;
  #latest = new Map<string, ObservedIdentity>();
  /** The latest time this ledger has seen; observations while its clock is behind are ignored. */
  #highWater = Number.NEGATIVE_INFINITY;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  record(accountId: string, observation: { signedIn: boolean; fingerprint: string | null; observedAt?: string }): void {
    // A malformed observation is a caller's bug: named, and before the clock is touched.
    const o = observation as { signedIn?: unknown; fingerprint?: unknown; observedAt?: unknown } | null;
    if (typeof o !== 'object' || o === null || typeof o.signedIn !== 'boolean' || (o.fingerprint !== null && typeof o.fingerprint !== 'string')) {
      throw new TypeError('an identity observation needs signedIn (true or false) and a fingerprint (a string, or null)');
    }
    // observedAt, when given, is an instant (ISO 8601 with an offset).
    if (o.observedAt !== undefined && instantOf(o.observedAt) === null) {
      throw new RangeError('the login observation has no valid time: an ISO date-time with an offset');
    }
    const now = this.#now().getTime();
    if (!Number.isFinite(now)) throw new RangeError('the identity clock returned an invalid time');
    if (now < this.#highWater) return;   // the clock stepped back: ignore, never trust
    this.#highWater = now;
    const at = observation.observedAt === undefined ? now : instantOf(observation.observedAt);
    if (at === null) throw new RangeError('the login observation has no valid time: an ISO date-time with an offset');
    if (at > now) throw new RangeError('the login observation is later than the clock');
    const held = this.#latest.get(accountId);
    if (held && at < Date.parse(held.observedAt)) return;
    this.#latest.set(accountId, { accountId, signedIn: observation.signedIn, fingerprint: observation.fingerprint, observedAt: new Date(at).toISOString() });
  }

  /** The current observation; none while the clock is invalid or behind its high-water mark. */
  view(accountId: string): ObservedIdentity | undefined {
    const now = this.#now().getTime();
    if (!Number.isFinite(now) || now < this.#highWater) return undefined;
    this.#highWater = now;
    const held = this.#latest.get(accountId);
    return held ? { ...held } : undefined;
  }
}

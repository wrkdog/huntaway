import { holdKey, keyOf, modelFamily } from './buckets.ts';
export type BucketReading = {
  bucket: string;
  /** Set when the bucket limits only this model; null when it limits the whole account. */
  model: string | null;
  /** 0..1 (above 1 means over the limit), or null when the probe could not measure it. */
  usedFraction: number | null;
  /** An instant, or null for no stated reset. */
  resetsAt: string | null;
  via?: 'credits';
};
/** `observedAt`: when the job saw the limit (the runner's stamp); absent means observed now. A future instant is clamped to now. */
export type LimitHit = { bucket: string | null; model: string | null; resetsAt: string | null; observedAt?: string };
/** Private persistence marker: a resetless hit also contributes a wait to a merged hold. */
export type SavedLimitHold = Required<LimitHit> & { resetless?: boolean };

export type AllowanceView =
  | { state: 'ok'; accountId: string; headroom: number; binding: string; via?: 'credits' }
  | { state: 'exhausted'; accountId: string; bucket: string | null; until: string | null }
  | { state: 'unknown'; accountId: string; reason: string };

/** `limit` holds come from a job's own limit error; `reading` holds from a probe that read the bucket full. */
type Hold = { bucket: string | null; model: string | null; since: number; until: number | null; resetsAt: string | null; resetless?: boolean; origin: 'limit' | 'reading' };
/** `complete`: every entry could be read. An entry that could not may be any bucket, full: then the reading shows no room. */
type Snapshot = { at: number; buckets: BucketReading[]; verified: boolean; complete: boolean };
type Account = { snapshot?: Snapshot; holds: Map<string, Hold>; verifiedEver: boolean;
  known: Map<string, { bucket: string; model: string | null; missing?: { at: number; last: number; count: number } }> };
export const RESETLESS_LIMIT_WAIT_MS = 30 * 60_000;
export const RETIRE_AFTER = 3;
export const RETIRE_AFTER_MS = 30 * 60_000;
/** Whether a reading measured at `at` may clear a job's limit (see record()). */
const clears = (h: Hold, at: number, verified: boolean) =>
  verified || ((h.until === null || at >= h.until) && (!h.resetless || at - h.since >= RESETLESS_LIMIT_WAIT_MS));
const releaseAt = (h: Hold): number | null =>
  h.until === null ? null : Math.max(h.until, h.resetless ? h.since + RESETLESS_LIMIT_WAIT_MS : h.until);
// A limit whose stated reset is at or before the hit itself is treated as stating none: its reset is not evidence of when room returns.
// An instant is an ISO 8601 date-time with an explicit offset. A bare number, a date alone or a
// local time is not a time the pipe can compare, so it is not evidence (rule 8).
// It must also be a real calendar time: Date.parse moves 30 February to 2 March.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
export function instantOf(v: unknown): number | null {
  const m = typeof v === 'string' ? INSTANT.exec(v) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second = 0, offsetHours = 0, offsetMinutes = 0] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  // setUTCFullYear, unlike Date.UTC, keeps years 0-99 as they are (year 0 is a leap year).
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year!, month!, 0);
  if (month! < 1 || month! > 12 || day! < 1 || day! > lastDay.getUTCDate()) return null;
  if (hour! > 23 || minute! > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return null;
  const ms = Date.parse(v as string);
  return Number.isFinite(ms) ? ms : null;
}

// A null reset is "no stated reset". Anything else that is not an instant, a missing field
// included, is not evidence.
function resetOf(v: unknown): { ms: number | null } | null {
  if (v === null) return { ms: null };
  const ms = instantOf(v);
  return ms === null ? null : { ms };
}

// A bucket's identity: an object with a non-empty name, and a model that is a string or null
// (the whole account). Anything else is malformed and is not evidence at all. A limit hit may
// name no bucket (null) when the service named none.
function wellFormed(b: unknown, unnamed = false): boolean {
  if (typeof b !== 'object' || b === null) return false;
  const { bucket, model } = b as { bucket?: unknown; model?: unknown };
  const named = typeof bucket === 'string' && bucket !== '';
  return (named || (unnamed && bucket === null)) && (model === null || typeof model === 'string');
}

// A fraction that is missing, negative or not a number is unmeasured, not zero.
const usedOf = (b: BucketReading): number | null =>
  typeof b.usedFraction === 'number' && Number.isFinite(b.usedFraction) && b.usedFraction >= 0 ? b.usedFraction : null;

export class AllowanceLedger {
  #freshnessMs: number;
  #now: () => Date;
  #accounts = new Map<string, Account>();
  /** The latest time this ledger has seen; a clock below it has stepped back. */
  #highWater = Number.NEGATIVE_INFINITY;

  constructor(options: { freshnessMs: number; now?: () => Date }) {
    if (!Number.isFinite(options.freshnessMs) || options.freshnessMs <= 0) {
      throw new RangeError(`freshnessMs must be a positive number of milliseconds, not ${options.freshnessMs}`);
    }
    this.#freshnessMs = options.freshnessMs;
    this.#now = options.now ?? (() => new Date());
  }

  /** The ledger's clock, in ms. Evidence that cannot be stamped is refused, not guessed. */
  #time(): number {
    const t = this.#now().getTime();
    if (!Number.isFinite(t)) throw new RangeError('the ledger clock returned an invalid time');
    return t;
  }

  /** True when the clock is below the high-water mark: it stepped back. Otherwise raises the mark. */
  #steppedBack(t: number): boolean {
    if (t < this.#highWater) return true;
    this.#highWater = t;
    return false;
  }

  #account(id: string): Account {
    let a = this.#accounts.get(id);
    if (!a) this.#accounts.set(id, (a = { holds: new Map(), known: new Map(), verifiedEver: false }));
    return a;
  }
  record(accountId: string, buckets: readonly BucketReading[], measuredAt?: string, options: { verified?: boolean } = {}): void {
    const verified = options.verified !== false;
    // A reading that is not a list is a caller's bug, so it throws; a malformed entry is dropped.
    if (!Array.isArray(buckets)) throw new TypeError('a reading is a list of bucket readings');
    const now = this.#time();
    // A reading stamped by a clock that stepped back is older evidence: ignored, never trusted.
    if (this.#steppedBack(now)) return;
    let at = now;
    if (measuredAt !== undefined) {
      const measured = instantOf(measuredAt);
      if (measured === null || measured > now) return;   // no time, or later than the clock: not evidence
      at = measured;
    }
    const a = this.#account(accountId);
    // A reading stamped before the latest one is older evidence: it never replaces it.
    if (a.snapshot && at < a.snapshot.at) return;
    const read = buckets.filter((b) => wellFormed(b));
    const complete = read.length === buckets.length;
    if (verified && !a.verifiedEver) {
      // From the first verified reading, only verified readings are proof: omissions the cache counted start over.
      a.verifiedEver = true;
      for (const k of a.known.values()) delete k.missing;
    }
    if (!verified && a.verifiedEver) {
      // A cached reading on a verified account is no proof. It may hold a bucket verified readings still expect (they
      // will lift it, or retire the bucket), and nothing more: no room and no new bucket.
      for (const b of read) {
        const used = usedOf(b), reset = resetOf(b.resetsAt), key = holdKey(b, 'reading'), held = a.holds.get(key);
        if (a.known.has(keyOf(b)) && used !== null && used >= 1 && reset !== null && (!held || at > held.since)) {
          // The full observation is newer even when its reset is earlier. Keep the later gate;
          // no stated reset is stronger than a dated one.
          const extendsHold = !held || (held.until !== null && (reset.ms === null || reset.ms > held.until));
          a.holds.set(key, { bucket: b.bucket, model: b.model, since: at,
            until: extendsHold ? reset.ms : held.until, resetsAt: extendsHold ? b.resetsAt : held.resetsAt, origin: 'reading' });
        }
      }
      return;
    }
    // Every reading from here is the account's own kind: verified, or its cache when it has never had one (Claude).
    a.snapshot = { at, buckets: read.map((b) => ({ ...b })), verified, complete };
    // Only a complete reading, measured after the last one counted, is proof a bucket is gone.
    if (complete) for (const [key, k] of a.known) if (!read.some((b) => keyOf(b) === key)) {
      const missing = (k.missing ??= { at, last: -Infinity, count: 0 });
      if (at <= missing.last) continue;
      missing.last = at;
      if (++missing.count >= RETIRE_AFTER && at - missing.at >= RETIRE_AFTER_MS) this.retire(accountId, k);
    }
    for (const b of read) {
      const key = keyOf(b);
      a.known.set(key, { bucket: b.bucket, model: b.model });
      const used = usedOf(b);
      const reset = resetOf(b.resetsAt);
      if (used === null || reset === null) continue;   // unmeasured: never sets or clears a hold
      const readingKey = holdKey(b, 'reading');
      const readingHold = a.holds.get(readingKey);
      if (!readingHold || at > readingHold.since) {       // only a provably newer reading moves it
        if (used >= 1) a.holds.set(readingKey, { bucket: b.bucket, model: b.model, since: at, until: reset.ms, resetsAt: b.resetsAt, origin: 'reading' });
        else if (readingHold && this.#mayClear(a, a.snapshot)) a.holds.delete(readingKey);
      }
    }
    if (this.#mayClear(a, a.snapshot)) this.#settle(a, at, read, verified);
  }
  #mayClear(a: Account, s: Snapshot): boolean {
    return s.complete && (s.verified || !a.verifiedEver);
  }

  /** Clear the holds a reading measured at `at` lifts. Run for each new reading, and for a limit that arrives after one. */
  #settle(a: Account, at: number, valid: readonly BucketReading[], verified: boolean): void {
    for (const b of valid) {
      const used = usedOf(b);
      if (used === null || resetOf(b.resetsAt) === null) continue;
      // A job's own limit clears only with room measured after it: by a verified reading, or by
      // any reading once the limit's own stated reset has passed, or, when it stated no reset,
      // by any reading measured RESETLESS_LIMIT_WAIT_MS after it, since nothing else would end it.
      const limitKey = holdKey(b, 'limit');
      const limit = a.holds.get(limitKey);
      // Credit room never lifts a job's own limit: the job hit it with the credits already on offer (rule 49).
      if (limit && at > limit.since && used < 1 && b.via !== 'credits' && clears(limit, at, verified)) a.holds.delete(limitKey);
    }
    // A hold that names no bucket clears only on a newer reading that reports every bucket the
    // account has reported in its scope (its model, or the whole account), each measured with room.
    // With nothing in its scope yet, it stays until readings put a bucket there: no evidence of room.
    const reported = new Map(valid.map((b) => [keyOf(b), b]));
    for (const [key, h] of a.holds) {
      if (h.bucket !== null || at <= h.since || (h.origin === 'limit' && !clears(h, at, verified))) continue;
      const scope = [...a.known.values()].filter((k) => h.model === null || k.model === null || k.model === h.model);
      const room = scope.length > 0 && scope.every((k) => {
        const b = reported.get(keyOf(k));
        const used = b ? usedOf(b) : null;
        return b !== undefined && used !== null && used < 1 && b.via !== 'credits' && resetOf(b.resetsAt) !== null;
      });
      if (room) a.holds.delete(key);
    }
  }

  /** Record a job's limit, retaining both its stated-reset gate and any resetless-wait gate on the merged hold. */
  recordLimit(accountId: string, hit: LimitHit | SavedLimitHold): void {
    // A limit hit is never silently dropped: a malformed one is a caller's bug, so it throws.
    if (!wellFormed(hit, true)) throw new TypeError('a limit hit needs a bucket name (or null when the service named none) and a model (a string, or null for the whole account)');
    const reset = resetOf(hit.resetsAt);
    if (reset === null) throw new TypeError('a limit hit resets at an ISO date-time with an offset, or null');
    const marker = (hit as SavedLimitHold).resetless;
    if (marker !== undefined && typeof marker !== 'boolean') throw new TypeError('a saved resetless marker must be boolean');
    const seen = hit.observedAt === undefined ? null : instantOf(hit.observedAt);
    if (hit.observedAt !== undefined && seen === null) throw new TypeError('a limit hit observedAt must be an ISO date-time with an offset');
    // A limit hit always counts, even when the clock stepped back: it only ever holds. It
    // raises the high-water mark too, so no account's reading can be stamped behind it.
    const t = this.#time(), steppedBack = this.#steppedBack(t);
    const observed = seen !== null && seen <= t ? seen : t;
    const at = steppedBack ? Math.max(observed, this.#highWater) : observed;
    const a = this.#account(accountId);
    const until = reset.ms !== null && reset.ms > at ? reset.ms : null;
    const key = holdKey(hit, 'limit');
    const held = a.holds.get(key);
    const floor = held?.until !== null && held?.until !== undefined && (until === null || held.until >= until) ? held.until : until;
    const resetsAt = floor === held?.until ? held.resetsAt : until === null ? null : hit.resetsAt;
    // Keep both independent gates. The provider reset remains distinct from the private wait.
    a.holds.set(key, { bucket: hit.bucket, model: hit.model, since: Math.max(held?.since ?? at, at), until: floor,
      resetsAt, resetless: held?.resetless === true || until === null || marker === true, origin: 'limit' });
    // A reading already recorded, measured after the limit was seen, is weighed against it now.
    if (a.snapshot && a.snapshot.at > at && this.#mayClear(a, a.snapshot)) this.#settle(a, a.snapshot.at, a.snapshot.buckets, a.snapshot.verified);
  }
  limitHolds(accountId: string): SavedLimitHold[] {
    return [...(this.#accounts.get(accountId)?.holds.values() ?? [])].filter((h) => h.origin === 'limit')
      .map((h) => ({ bucket: h.bucket, model: h.model, resetsAt: h.resetsAt, observedAt: new Date(h.since).toISOString(),
        ...(h.resetless && h.until !== null ? { resetless: true } : {}) }));
  }

  /** A probe that failed (offline, timed out) says nothing about allowance, so nothing changes. */
  recordProbeFailure(_accountId: string): void {}
  retire(accountId: string, bucket: { bucket: string; model: string | null }): void {
    // Retirement is evidence too: stamped by the clock, ignored while it is behind.
    if (!wellFormed(bucket) || this.#steppedBack(this.#time())) return;
    const a = this.#accounts.get(accountId);
    const key = keyOf(bucket);
    a?.known.delete(key);
    a?.holds.delete(holdKey(bucket, 'reading'));
    if (a?.snapshot) a.snapshot.buckets = a.snapshot.buckets.filter((b) => keyOf(b) !== key);
  }

  /** The account as a whole, or one model on it. Exhausted outranks unknown: it is evidence. */
  readingSource(accountId: string): 'verified' | 'cache' | null { const s = this.#accounts.get(accountId)?.snapshot; return s ? s.verified ? 'verified' : 'cache' : null; }

  /** Timestamp of a complete, fresh, measured reading for this scope; never a decision stamp. */
  observedAt(accountId: string, model: string): string | null {
    const v = this.view(accountId, model), a = this.#accounts.get(accountId), s = a?.snapshot, now = this.#now().getTime();
    if (v.state === 'unknown' || !s?.complete || !Number.isFinite(now) || now < this.#highWater || now < s.at || now - s.at > this.#freshnessMs) return null;
    const applies = (b: { model: string | null }) => b.model === null || b.model === modelFamily(model);
    const buckets = s.buckets.filter(applies), reported = new Set(buckets.map(keyOf));
    if (!buckets.length || [...a!.known].some(([key,b]) => applies(b) && !reported.has(key)) || buckets.some(b => usedOf(b) === null || resetOf(b.resetsAt) === null || (instantOf(b.resetsAt) ?? Infinity) <= now)) return null;
    return new Date(s.at).toISOString();
  }

  /** Fresh reading proof for automatic fallback. Job holds never supply this certificate. */
  ordinaryExhaustion(accountId: string, model: string): { observedAt: string; until: string | null } | null {
    const observedAt = this.observedAt(accountId, model);
    if (!observedAt) return null;
    const bucket = this.#accounts.get(accountId)!.snapshot!.buckets.find(b =>
      (b.model === null || b.model === modelFamily(model)) && ((usedOf(b) ?? -1) >= 1 || b.via === 'credits'));
    return bucket ? { observedAt, until: bucket.resetsAt } : null;
  }

  view(accountId: string, model?: string): AllowanceView {
    const unknown = (reason: string): AllowanceView => ({ state: 'unknown', accountId, reason });
    const a = this.#accounts.get(accountId);
    if (!a) return unknown('no reading');
    const now = this.#now().getTime();
    if (!Number.isFinite(now)) return unknown('the ledger clock returned an invalid time');
    if (this.#steppedBack(now)) return unknown('the ledger clock stepped back');
    // A bucket scoped to a model applies to that model's family (`claude-fable-5-1` is `fable`).
    const family = model === undefined ? undefined : modelFamily(model);
    const applies = (b: { model: string | null }) => b.model === null || b.model === family;

    let longest: Hold | undefined;
    let longestIndefinite = false;
    let longestRelease = Number.NEGATIVE_INFINITY;
    let lapsed: Hold | undefined;
    for (const h of a.holds.values()) {
      if (!applies(h)) continue;
      // A reading has arrived since the ledger started, but none reports this job's limit's bucket (retired, never
      // reported, or not read since a restart): no reading will clear it, so its reset does, or the resetless wait (L13).
      // With no reading at all, the job's own limit is the only evidence, and it stands.
      const inScope = [...a.known.values()].some((k) => h.model === null || k.model === null || k.model === h.model);
      const unread = h.origin === 'limit' && a.snapshot !== undefined && (h.bucket !== null ? !a.known.has(keyOf(h)) : !inScope);
      // A reported but unmeasured bucket cannot establish that its limit has lifted (A9).
      const stillUnmeasured = h.origin === 'limit' && h.resetless === true && !unread && h.bucket !== null &&
        a.snapshot?.buckets.some((b) => keyOf(b) === keyOf(h) && usedOf(b) === null);
      const release = releaseAt(h);
      if (unread && now >= (release ?? h.since + RESETLESS_LIMIT_WAIT_MS)) { a.holds.delete(holdKey(h, h.origin)); continue; }
      if (!stillUnmeasured && release !== null && now >= release) lapsed ??= h;
      else {
        // The provider's stated reset is not an honest public end time when a later private
        // resetless wait still holds the gate. Keep the stated time only when it is the later gate.
        const indefinite = h.until === null || stillUnmeasured === true ||
          (h.resetless === true && release !== null && h.until !== null && release > h.until);
        if (!longest || (indefinite && !longestIndefinite) || (!indefinite && !longestIndefinite && release! > longestRelease)) {
          longest = h;
          longestIndefinite = indefinite;
          longestRelease = release ?? Number.POSITIVE_INFINITY;
        }
      }
    }
    if (longest) return { state: 'exhausted', accountId, bucket: longest.bucket, until: longestIndefinite ? null : longest.resetsAt };
    // The hold has lapsed, but every reading of that bucket predates it.
    if (lapsed) return unknown(`${lapsed.bucket ?? 'an unnamed limit'} reset at ${lapsed.resetsAt}; no reading since`);

    const s = a.snapshot;
    if (!s) return unknown('no reading');
    if (now < s.at) return unknown('the clock is earlier than the last reading');
    if (now - s.at > this.#freshnessMs) return unknown(`the last reading is older than ${this.#freshnessMs} ms`);
    if (!s.complete) return unknown('the last reading had an entry that could not be read');
    // A bucket seen before but missing now is unmeasured: omission is not evidence.
    const reported = new Set(s.buckets.map(keyOf));
    for (const [key, k] of a.known) {
      if (applies(k) && !reported.has(key)) return unknown(`${k.bucket} was not reported in the last reading`);
    }
    let binding: { bucket: string; used: number } | undefined;
    let credits = false;
    for (const b of s.buckets) {
      if (!applies(b)) continue;
      const used = usedOf(b);
      const reset = resetOf(b.resetsAt);
      if (used === null || reset === null) return unknown(`${b.bucket} is unmeasured`);
      if (reset.ms !== null && now >= reset.ms) return unknown(`${b.bucket} reset at ${b.resetsAt}; no reading since`);
      if (used >= 1) return { state: 'exhausted', accountId, bucket: b.bucket, until: b.resetsAt };
      if (!binding || used > binding.used) binding = { bucket: b.bucket, used };
      if (b.via === 'credits') credits = true;   // any covered window: the account draws on credits (rule 49)
    }
    if (!binding) return unknown('no bucket in the reading applies');
    return { state: 'ok', accountId, headroom: 1 - binding.used, binding: binding.bucket, ...(credits ? { via: 'credits' as const } : {}) };
  }
}

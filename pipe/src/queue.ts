import type { AccountConfig } from './identity.ts';
import { instantOf } from './allowance.ts';
import { FIRST_INSTANT, LAST_INSTANT, PRIORITIES, ordinaryRoom, ordinaryExhausted, validPlacement, validAutomatic, type Route, type RequestError, type Evidence, type RequestRecord, type RequesterLoad, type Wait, type WaitKind } from './store.ts';

export type { Evidence } from './store.ts';

export type AccountStatus = {
  account: AccountConfig;
  running: number;
  leased?: number;
  evidence: (model: string) => Evidence;
  limitHold?: (model: string) => { accountId: string; until: string | null } | null;
};

export type PlanOptions = {
  now: Date;
  pinWaitMs: number;
  evidenceMaxAgeMs: number;
  load: ReadonlyMap<string, RequesterLoad>;
};

export type Plan = {
  dispatch: Array<{ requestId: string; accountId: string; evidence: Evidence; route?: Route }>;
  waits: Array<{ requestId: string } & Wait>;
  fail: Array<{ requestId: string; reason: string; code?: RequestError['kind']; until?: string | null }>;
};

/** One candidate account, judged for one request. */
type Judged =
  | { id: string; state: 'free'; preference: number; load: number; headroom: number; credits: boolean; evidence: Evidence }
  | { id: string; state: 'exhausted' | 'reserve' | 'busy' | 'stopped' | 'avoided' | 'disabled' | 'excluded'; why: string; until: number | null };
type Free = Extract<Judged, { state: 'free' }>;
type Blocked = Exclude<Judged, Free>;

const iso = (ms: number) => new Date(ms).toISOString();
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
/** Longer than any sane wait or freshness window; beyond it a duration is broken, not patient. */
const YEAR_MS = 366 * 86_400_000;
const BACKGROUND_AGE_MS = 30 * 60_000;

export function plan(waiting: readonly RequestRecord[], accounts: readonly AccountStatus[], options: PlanOptions): Plan {
  const out: Plan = { dispatch: [], waits: [], fail: [] };
  const { pinWaitMs, evidenceMaxAgeMs } = options;
  const now = options.now.getTime();
  const wait = (r: RequestRecord, kind: WaitKind, reason: string, until: string | null, stoppedSince?: string) =>
    out.waits.push({ requestId: r.id, kind, reason, until, ...(stoppedSince === undefined ? {} : { stoppedSince }) });
  const fail = (r: RequestRecord, reason: string) => out.fail.push({ requestId: r.id, reason });

  // A plan that cannot tell the time, or judge freshness, dispatches nothing (rule 8).
  const broken = !(Number.isFinite(now) && now >= FIRST_INSTANT && now <= LAST_INSTANT) ? 'the plan clock returned a time that is not an instant'
    : !(Number.isFinite(evidenceMaxAgeMs) && evidenceMaxAgeMs > 0 && evidenceMaxAgeMs <= YEAR_MS) ? 'evidenceMaxAgeMs is not a real duration'
    : !(Number.isFinite(pinWaitMs) && pinWaitMs >= 0 && pinWaitMs <= YEAR_MS) ? 'pinWaitMs is not a real duration'
    : null;
  if (broken !== null) {
    for (const r of waiting) if (r.automatic) out.fail.push({ requestId: r.id, reason: broken, code: 'admission_unknown', until: null }); else wait(r, 'paused', `nothing is dispatched: ${broken}`, null, r.waiting?.stoppedSince);
    return out;
  }

  const byId = new Map(accounts.map((a) => [a.account.id, a]));
  const assigned = new Map<string, number>();
  const judge = (a: AccountStatus, r: RequestRecord): Judged => {
    const { id, maxConcurrency } = a.account;
    const blocked = (state: Blocked['state'], why: string, until: number | null = null): Blocked => ({ id, state, why, until });
    if (r.exclude?.includes(id)) return blocked('excluded', 'is excluded by this request');
    if (!r.automatic && r.avoid.includes(id)) return blocked('avoided', 'already failed this request');
    if (a.account.enabled !== true) return blocked('disabled', 'is disabled in config');
    const e = a.evidence(r.model);
    // A time is evidence only as an instant: an ISO date-time with an offset (U1, rule 8).
    const seen = instantOf(e?.observedAt);
    if (e?.accountId !== id) return blocked('stopped', `is unknown: its evidence names ${String(e?.accountId)}`);
    if (e.model !== r.model) return blocked('stopped', `is unknown: its evidence is for model ${String(e.model)}, not ${r.model}`);
    if (seen === null) return blocked('stopped', 'is unknown: its evidence has no valid time');
    if (seen > now) return blocked('stopped', 'is unknown: its evidence is later than the plan clock');
    if (now - seen > evidenceMaxAgeMs) return blocked('stopped', `is unknown: its evidence is stale (observed ${e.observedAt})`);
    const measured = instantOf(e.allowanceObservedAt);
    if (r.automatic && (measured === null || measured > now || now - measured > evidenceMaxAgeMs)) return blocked('stopped', 'allowance observation unknown or stale');
    const v = e.verdict;
    if (typeof v !== 'object' || v === null) return blocked('stopped', 'is unknown: its evidence has no verdict');
    const leased = a.leased ?? 0, used = a.running + leased + (assigned.get(id) ?? 0);
    switch (v.state) {
      case 'available':
        if (!(typeof v.headroom === 'number' && v.headroom >= 0 && v.headroom <= 1)) return blocked('stopped', 'is unknown: its verdict is malformed');
        if (r.automatic && (v.headroom === 0 || v.via === 'credits')) return blocked('exhausted', 'ordinary allowance exhausted');
        if (r.automatic && r.provider === 'claude' && v.via === undefined && v.headroom <= r.automatic.reviewReserve) return blocked('reserve', 'review reserve floor reached');
        if (r.placement === 'ordinary_headroom' && !ordinaryRoom(v)) return blocked('stopped', v.via === 'credits' || v.headroom === 0 ? 'is unavailable: ordinary allowance exhausted (credit room excluded)' : 'is unknown: no valid ordinary subscription room');
        if (r.automatic && r.avoid.includes(id)) return blocked('avoided', 'ordinary room on an avoided primary is not exhaustion');
        if (used < maxConcurrency) return { id, state: 'free', preference: a.account.preference ?? 0, load: used, headroom: v.headroom, credits: v.via === 'credits', evidence: e };
        return blocked('busy', `is busy (${leased ? `${used - leased} running, ${leased} leased, ` : ''}${used}/${maxConcurrency})`);
      case 'busy': return blocked('busy', `is busy (${v.leased ? `${v.running} running, ${v.leased} leased, ` : ''}${v.running + (v.leased ?? 0)}/${v.max})`);
      case 'unavailable': {
        if (r.automatic && !ordinaryExhausted(e, id, r.model, now, evidenceMaxAgeMs)) return blocked('stopped', 'fresh measured ordinary exhaustion unknown');
        const until = typeof v.until === 'string' ? v.until : null;
        return blocked(r.automatic && v.cause === 'allowance' ? 'exhausted' : 'stopped', `is unavailable: ${v.reason}${until ? ` until ${until}` : ''}`, until === null ? null : instantOf(until));
      }
      case 'unknown': return blocked('stopped', `is unknown: ${v.reason}`);
      default: return blocked('stopped', 'is unknown: its verdict is malformed');
    }
  };

  const valid: RequestRecord[] = [];
  for (const r of waiting) {
    const why = malformed(r);
    if (why === null) valid.push(r);
    else fail(r, `the record is malformed: ${why}`);
  }

  /** Plans one request: dispatch, wait or fail. True only when it dispatched. */
  const place = (r: RequestRecord): boolean => {
    if (r.automatic) {
      const refuse = (code: RequestError['kind'], reason: string, until: string | null = null) => { out.fail.push({ requestId: r.id, code, reason, until }); return false; };
      if (r.notBefore && Date.parse(r.notBefore) > now) return refuse('admission_backoff', `automatic retry backs off after ${r.error?.kind ?? 'unknown'} until ${r.notBefore}`, r.notBefore);
      const resets: Array<number | null> = [];
      for (const route of [{ provider: r.provider, model: r.model, effort: r.effort, reason: r.reason }, r.automatic.fallback]) {
        const candidates = accounts.filter(a => a.account.provider === route.provider && a.account.enabled === true && !r.exclude?.includes(a.account.id) && (route.provider === r.provider || !r.avoid.includes(a.account.id)));
        const judged = candidates.map(a => judge(a, { ...r, ...route }));
        const best = judged.filter((c): c is Free => c.state === 'free').sort((x,y) => y.preference-x.preference || y.headroom-x.headroom || x.load-y.load || x.id.localeCompare(y.id))[0];
        if (best) { assigned.set(best.id, (assigned.get(best.id) ?? 0)+1); out.dispatch.push({requestId:r.id,accountId:best.id,evidence:best.evidence,route}); return true; }
        const blocked = judged as Blocked[];
        if (!blocked.length || blocked.some(c => !['exhausted','busy','reserve'].includes(c.state))) return refuse('admission_unknown', `${route.provider}: current ordinary allowance evidence unknown`);
        if (blocked.some(c => c.state === 'busy')) return refuse('admission_busy', `${route.provider}: ordinary room exists but accounts are busy`);
        if (blocked.some(c => c.state === 'reserve')) return refuse('review_reserve', 'Claude admission refused at the 10% trial admission floor', earliest(resets, now));
        resets.push(...blocked.map(c => c.until));
        if (route.provider === 'claude') return refuse('admission_exhausted', 'automatic routes exhausted', earliest(resets, now));
      }
      return refuse('admission_unknown', 'automatic route unknown');
    }
    const pin = r.pin === undefined ? undefined : byId.get(r.pin);
    if (r.pin !== undefined && pin?.account.provider !== r.provider) { fail(r, `pinned to ${r.pin}, which is not a configured ${r.provider} account`); return false; }
    if (r.pin !== undefined && r.avoid.includes(r.pin)) { fail(r, `pinned to ${r.pin}, which already failed this request`); return false; }
    const notBefore = r.notBefore === null ? null : instantOf(r.notBefore);
    if (notBefore !== null && notBefore > now) {
      wait(r, 'backoff', `backing off until ${iso(notBefore)} (last error: ${r.error?.kind ?? 'none'})`, iso(notBefore), r.waiting?.stoppedSince);
      return false;
    }

    const judged = (pin ? [pin] : accounts.filter((a) => a.account.provider === r.provider)).map((a) => judge(a, r));
    // Credit room comes after every account with ordinary room, whatever its preference or load (rule 49).
    const best = judged.filter((c): c is Free => c.state === 'free')
      .sort((x, y) => Number(x.credits) - Number(y.credits) || y.preference - x.preference || (r.placement === 'ordinary_headroom' ? y.headroom - x.headroom : 0) || x.load - y.load || y.headroom - x.headroom || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
    if (best) {
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
      out.dispatch.push({ requestId: r.id, accountId: best.id, evidence: best.evidence });
      return true;
    }

    const blocked = judged.filter((c): c is Blocked => c.state !== 'free');
    const list = blocked.map((c) => `${c.id} ${c.why}`).join('; ');
    if (pin && r.exclude?.includes(pin.account.id)) {
      const since = Math.min(instantOf(r.waiting?.stoppedSince) ?? now, now);
      const what = `the pinned account ${pin.account.id} is excluded by this request`;
      if (now - since > pinWaitMs) fail(r, `${what}; waited since ${iso(since)}, longer than the ${minutes(pinWaitMs)} a request waits for one`);
      else wait(r, 'pinned_account', what, iso(since + pinWaitMs), iso(since));
    } else if (pin) {
      const c = blocked[0]!;
      if (c.state === 'busy') { wait(r, 'pinned_account', `the pinned account ${list}`, null); return false; }
      if (c.state === 'stopped' && c.why.startsWith('is unavailable: offline since ')) { wait(r, 'pinned_account', `the pinned account ${list}`, null); return false; }
      // A temporary hold on the pin, from its verdict or a recorded limit. Each ends at its reset (null: none stated).
      const hold = pin.limitHold?.(r.model);
      const limits = [
        ...(c.state === 'stopped' && /^is unavailable: .*\b(?:exhausted|limit(?:ed)?|auth|sign-in)\b/i.test(c.why) ? [c.until] : []),
        ...(hold?.accountId === pin.account.id ? [instantOf(hold.until)] : []),
      ];
      const held = limits.some((t) => t === null || t > now);
      const lapsed = limits.filter((t): t is number => t !== null && t <= now);
      const since = Math.max(Math.min(instantOf(r.waiting?.stoppedSince) ?? now, now), ...lapsed);
      const reset = earliest(limits, now);
      if (held) {
        wait(r, 'pinned_account', `the pinned account ${list}; a hold keeps it waiting, and the ${minutes(pinWaitMs)} a pin waits starts again ${reset === null ? 'when it lifts' : `at ${reset}`}`, reset, reset ?? iso(now));
      } else if (now - since > pinWaitMs) {
        fail(r, `the pinned account ${list}; stopped since ${iso(since)}, longer than the ${minutes(pinWaitMs)} a pin waits, with no reset within that time`);
      } else {
        wait(r, 'pinned_account', `the pinned account ${list}; stopped since ${iso(since)}`, earliest([since + pinWaitMs], now), iso(since));
      }
    } else if (blocked.length === 0 || (blocked.some((c) => c.state === 'disabled' || c.state === 'excluded') && blocked.every((c) => c.state === 'avoided' || c.state === 'disabled' || c.state === 'excluded'))) {
      const since = Math.min(instantOf(r.waiting?.stoppedSince) ?? now, now);
      const what = blocked.length === 0 ? `no ${r.provider} account is configured` : `no ${r.provider} account can take it: ${list}`;
      if (now - since > pinWaitMs) fail(r, `${what}; waited since ${iso(since)}, longer than the ${minutes(pinWaitMs)} a request waits for one`);
      else wait(r, 'no_route', what, iso(since + pinWaitMs), iso(since));
    } else if (blocked.every((c) => c.state === 'avoided')) {
      fail(r, `every ${r.provider} account already failed this request: ${blocked.map((c) => c.id).join(', ')}`);
    } else {
      wait(r, 'no_free_account', `no ${r.provider} account is free: ${list}`, blocked.some((c) => c.state === 'busy') ? null : earliest(blocked.map((c) => c.until), now));
    }
    return false;
  };

  inTurns(valid, options.load, now, place);
  return out;
}

export function inTurns(valid: readonly RequestRecord[], load: ReadonlyMap<string, RequesterLoad>, now: number, place: (r: RequestRecord) => boolean): void {
  const turns = new Map<string, { running: number; last: number }>(valid.map((r) => [r.requester, { running: load.get(r.requester)?.running ?? 0,
    last: instantOf(load.get(r.requester)?.lastDispatchedAt) ?? Number.NEGATIVE_INFINITY }]));
  const bySeq = [...valid].sort((a, b) => a.seq - b.seq);
  let latest = Math.max(now, ...[...turns.values()].map((t) => t.last).filter(Number.isFinite));
  for (const priority of PRIORITIES) {
    const lanes = new Map<string, RequestRecord[]>();
    for (const r of bySeq) {
      const effective = r.priority === 'background' && (instantOf(r.createdAt) ?? now) <= now - BACKGROUND_AGE_MS ? 'interactive' : r.priority;
      if (effective !== priority) continue;
      const lane = lanes.get(r.requester);
      if (lane) lane.push(r); else lanes.set(r.requester, [r]);
    }
    const rank = (who: string) => turns.get(who)!;
    while (lanes.size > 0) {
      // -Infinity minus -Infinity is NaN, which is falsy: two never-dispatched requesters tie on it.
      const [who, lane] = [...lanes].sort(([a, x], [b, y]) =>
        rank(a).running - rank(b).running || rank(a).last - rank(b).last || x[0]!.seq - y[0]!.seq)[0]!;
      const r = lane.shift()!;
      if (lane.length === 0) lanes.delete(who);
      if (place(r)) { rank(who).running += 1; rank(who).last = ++latest; }
    }
  }
}

/** Why a record cannot be planned, or null. The store validates rows; the plan does not rely on it. */
function malformed(r: RequestRecord): string | null {
  if (!validAutomatic(r)) return 'invalid automatic route';
  if (!validPlacement(r.placement)) return 'unknown placement';
  if (!(PRIORITIES as readonly string[]).includes(r.priority)) return `unknown priority "${String(r.priority)}"`;
  if (!Array.isArray(r.avoid)) return 'avoid is not a list';
  if (r.exclude !== undefined && (!Array.isArray(r.exclude) || !r.exclude.every((id) => typeof id === 'string' && id.trim() !== ''))) return 'exclude is not a list of account ids';
  if (r.notBefore !== null && instantOf(r.notBefore) === null) return `notBefore "${r.notBefore}" is not a time`;
  return null;
}

/** The earliest valid time still ahead, as ISO; lapsed and unreadable times are dropped. */
function earliest(times: ReadonlyArray<number | null>, now: number): string | null {
  const ahead = times.filter((t): t is number => t !== null && Number.isFinite(t) && t > now);
  return ahead.length === 0 ? null : iso(Math.min(...ahead));
}

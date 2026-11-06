/**
 * READ-CONTRACT-01: what a dashboard may read. Cards and health are built from an allowlist of codes, times, counts, a
 * branch and a commit, and display aliases, never by spreading a record; an unknown value is null (rules 6, 48).
 */
import type { HousekeepingStatus } from './disk.ts';
import { hostAlias } from './host.ts';
import type { AllowanceView } from './allowance.ts';
import type { ObservedIdentity } from './availability.ts';
import type { Attempt, RequestRecord } from './store.ts';

export const CARD_SCHEMA = 'pipe-card/1';
/** `alias`: the account's display name, or null for an id no longer configured (it may now name another account). */
export type CardOptions = { alias(accountId: string): string | null; runnerAlive(attempt: Attempt): boolean | null; draining: boolean };
export type HealthInput = {
  housekeeping?: HousekeepingStatus;
  version?: string | null; host?: string | null; startedAt: string; clockCurrent: boolean; draining: boolean;
  accounts: Array<{ alias: string; provider: string; enabled: boolean; running: number; identity: ObservedIdentity | null;
    allowance: AllowanceView; lastProbeAt?: string | null; consecutiveProbeFailures?: number | null }>;
};

export function card(r: RequestRecord, attempts: readonly Attempt[], o: CardOptions) {
  const open = attempts.find((a) => a.endedAt === null);
  const final = r.state === 'completed' || r.state === 'failed' || r.state === 'cancelled' || r.state === 'start_mismatch';
  const w = r.mutating && r.state === 'completed' ? r.workspace : null;
  const clock = (open ?? attempts[attempts.length - 1])?.events ?? null;   // the open attempt's, else the last one's
  return {
    id: r.id, seq: r.seq, project: r.project, requester: r.requester, kind: r.kind, priority: r.priority, mutating: r.mutating,
    state: r.state, errorKind: r.error?.kind ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt,
    startCommit: r.workspace?.startCommit ?? null,
    proof: { tests: null, review: null, backup: null },
    startedAt: attempts[0]?.startedAt ?? null,
    finishedAt: final ? r.finishedAt ?? r.updatedAt : null,         // stamped once by the store; a final state absorbs
    waiting: r.state !== 'queued' ? null : o.draining ? { kind: 'draining', until: null }
      : r.waiting?.kind ? { kind: r.waiting.kind, until: r.waiting.until } : null,
    account: open ? { alias: o.alias(open.accountId) } : null,
    events: clock ? { lastEventAt: clock.lastAt, eventCount: clock.count } : null,   // the event clock (READ-CONTRACT-01 step 2)
    attempts: attempts.map((a, i) => ({
      n: i + 1, host: hostAlias(a.dispatch?.host), account: { alias: o.alias(a.accountId) }, startedAt: a.startedAt, endedAt: a.endedAt, closedAt: a.closedAt ?? null,
      outcome: a.outcome?.kind ?? null, runnerAlive: a.endedAt === null ? o.runnerAlive(a) : null,
    })),
    saved: w ? { state: w.saved ?? 'pending', branch: w.branch, commit: w.saved === 'saved' ? w.commit : null,
      diff: w.saved === 'no_changes' ? { files: 0, insertions: 0, deletions: 0 } : w.saved === 'saved' && w.diff &&
        [w.diff.files, w.diff.insertions, w.diff.deletions].every(n => Number.isSafeInteger(n) && n >= 0)
        ? { files: w.diff.files, insertions: w.diff.insertions, deletions: w.diff.deletions } : null } : null,
  };
}

const RELEASE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:-dirty)?$/;

export function health(h: HealthInput) {
  return {
    service: { host: hostAlias(h.host), version: typeof h.version === 'string' && RELEASE.test(h.version) ? h.version : null, startedAt: h.startedAt, clockCurrent: h.clockCurrent, draining: h.draining },
    ...(h.housekeeping ? { housekeeping: { worktreeCount: h.housekeeping.worktreeCount, freeGiB: h.housekeeping.freeGiB,
      freeShare: h.housekeeping.freeShare, tier: h.housekeeping.tier, keepHours: h.housekeeping.keepHours, unsaveable: h.housekeeping.unsaveable,
      gate: { entries: h.housekeeping.gate.entries, oldestAgeMs: h.housekeeping.gate.oldestAgeMs },
      lastPass: h.housekeeping.lastPass ? { at: h.housekeeping.lastPass.at, durationMs: h.housekeeping.lastPass.durationMs,
        removed: h.housekeeping.lastPass.removed, kept: Object.fromEntries(['retention', 'unsaved', 'unsaveable', 'needs-archive', 'orphan', 'running', 'locked', 'deferred', 'deferred-capacity', 'partial-removal']
          .map(k => [k, h.housekeeping!.lastPass!.kept[k] ?? 0])), failed: h.housekeeping.lastPass.failed } : null } } : {}),
    accounts: h.accounts.map((a) => ({
      alias: a.alias, provider: a.provider, enabled: a.enabled, running: a.running,
      signedIn: a.identity?.signedIn ?? null, signedInObservedAt: a.identity?.observedAt ?? null,
      allowance: { state: a.allowance.state, until: a.allowance.state === 'exhausted' ? a.allowance.until : null },
      lastProbeAt: a.lastProbeAt ?? null, consecutiveProbeFailures: a.consecutiveProbeFailures ?? null,
    })),
  };
}

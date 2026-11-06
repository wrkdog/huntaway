/**
 * Lead grader, U4's first step: evidence names its model (docs/PLAN.md, U4; asked for by U2's
 * review). An account's verdict is for one model: one model's allowance can be spent while
 * another's is not (Claude's weekly model buckets). Evidence for another model is unknown to the
 * plan, and the claim refuses it, so U4's probes produce evidence already bound to its model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type DispatchEvidence, type NewRequest, type RequestRecord } from '../src/store.ts';
import { plan, type AccountStatus } from '../src/queue.ts';
import type { AccountConfig } from '../src/identity.ts';

const T0 = Date.parse('2026-09-24T12:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const OPTS = { now: at(10), pinWaitMs: 60 * 60_000, evidenceMaxAgeMs: 15 * 60_000, load: new Map() };

function cfg(id: string): AccountConfig {
  return { id, provider: 'claude', loginDir: `/logins/${id}`, fingerprint: `fp-${id}`, maxConcurrency: 1, enabled: true };
}
function request(over: Partial<NewRequest> = {}): NewRequest {
  return { requester: 'dev-a', project: 'pipe', kind: 'code', provider: 'claude', model: 'opus', effort: 'high',
    reason: 'a routine change', prompt: 'do the thing', mutating: false, priority: 'background', ...over };
}
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-u4e-'));
  return new Store(join(dir, 'pipe.sqlite'), { now: () => at(10) });
}
const dispatch = (model: string): DispatchEvidence =>
  ({ accountId: 'claude-a', model, observedAt: iso(9), verdict: { state: 'available', headroom: 0.5 }, grant: ['Read'] });

test('E1 the plan treats evidence for another model as unknown, and says which', () => {
  const store = openStore();
  const r = store.submit(request({ model: 'opus' }));
  const waiting = store.get(r.id) as RequestRecord;
  const lying: AccountStatus = { account: cfg('claude-a'), running: 0,
    evidence: () => ({ accountId: 'claude-a', model: 'fable', observedAt: iso(9), verdict: { state: 'available', headroom: 0.9 } }) };
  const p = plan([waiting], [lying], OPTS);
  assert.deepEqual(p.dispatch, [], 'no dispatch on another model\'s allowance');
  assert.equal(p.waits.length, 1);
  assert.match(JSON.stringify(p.waits[0]), /evidence is for model fable, not opus/u);
});

test('E2 the plan asks for the request\'s model and dispatches on evidence for it', () => {
  const store = openStore();
  const r = store.submit(request({ model: 'fable', reason: 'hard' }));
  const asked: string[] = [];
  const honest: AccountStatus = { account: cfg('claude-a'), running: 0,
    evidence: (model) => { asked.push(model); return { accountId: 'claude-a', model, observedAt: iso(9), verdict: { state: 'available', headroom: 0.5 } }; } };
  const p = plan([store.get(r.id) as RequestRecord], [honest], OPTS);
  assert.deepEqual(asked, ['fable']);
  assert.equal(p.dispatch.length, 1);
  assert.equal(p.dispatch[0]!.evidence.model, 'fable');
});

test('E3 the claim refuses evidence for another model, and records the model it ran on', () => {
  const store = openStore();
  const r = store.submit(request({ model: 'opus' }));
  const refused = store.startAttempt(r.id, cfg('claude-a'), dispatch('fable'));
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.reason, /the dispatch evidence is for model fable, not opus/u);
  const missing = store.startAttempt(r.id, cfg('claude-a'), { ...dispatch('opus'), model: undefined } as never);
  assert.equal(missing.ok, false, 'evidence that names no model is refused');
  const started = store.startAttempt(r.id, cfg('claude-a'), dispatch('opus'));
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.ok ? started.attempt.dispatch.model : '', 'opus');
  const stored = store.attempts(r.id)[0]!;
  assert.equal(stored.dispatch.model, 'opus', 'the record keeps the model the verdict was for');
});

/** E1's canonical identity and content-free reuse metadata. Endpoint namespaces are stored separately. */
import { createHash } from 'node:crypto';

export type DispatchClass = 'first' | 'confirm' | 'reassess' | 'repeat';
export type AdmissionMetadata = { admissionKey: string; dispatchClass: DispatchClass; predecessorId?: string };
export type Reuse = { requestId: string; verdict: string | null; timeSavedMs: number | null };
export type CapacityOptions = { E6_CAPACITY_HOOK?: boolean; landing_rank_bound?: number };
export class AdmissionError extends Error {
  status = 400;
  code = 'invalid_request';
}
export function conflict(): never {
  throw Object.assign(new AdmissionError('The admission key is already bound to a different request.'), { status: 409, code: 'idempotency_conflict' });
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, canonical(value)])) : v;
export function admission(body: Record<string, unknown>, providers: string[], brief: string) {
  for (const k of ['idempotencyKey', 'repository', 'evidenceVersion', 'policyVersion'])
    if (body[k] !== undefined && (typeof body[k] !== 'string' || !(body[k] as string).trim())) throw new AdmissionError(`${k} must be non-empty text`);
  for (const k of ['head', 'base']) if (body[k] !== undefined && (typeof body[k] !== 'string' || !/^[0-9a-f]{40}$/i.test(body[k] as string)))
    throw new AdmissionError(`${k} must be a full 40-character hex commit`);
  const repository = body.repository ?? body.repo ?? body.cwd ?? null;
  const head = typeof body.head === 'string' ? body.head.toLowerCase() : null, base = typeof body.base === 'string' ? body.base.toLowerCase() : null;
  const families = [...new Set(providers.map(p => p === 'codex' ? 'openai' : p === 'claude' ? 'anthropic' : 'google'))].sort();
  const evidenceVersion = body.evidenceVersion ?? 'unversioned', policyVersion = body.policyVersion ?? 'unversioned';
  const tuple = [repository, head, base, families, sha256(brief), evidenceVersion, policyVersion];
  const key = (body.idempotencyKey as string | undefined) ?? (body.evidenceVersion !== undefined || body.policyVersion !== undefined ? sha256(JSON.stringify(tuple)) : undefined);
  return { key, explicit: body.idempotencyKey !== undefined, briefSha256: tuple[4] as string,
    scope: JSON.stringify([repository, head, families]), basis: JSON.stringify([base, evidenceVersion, policyVersion]),
    fingerprint: sha256(JSON.stringify(canonical(Object.fromEntries(Object.entries({ ...body, repository, head, base, evidenceVersion, policyVersion })
      .filter(([k]) => k !== 'idempotencyKey' && k !== 'landing_rank'))))) };
}
export type Admission = ReturnType<typeof admission>;
export function reuse(id: string, verdict: string | null, createdAt: string, finishedAt?: string | null, completed = false): Reuse {
  const elapsed = completed ? Date.parse(finishedAt ?? '') - Date.parse(createdAt) : NaN;
  return { requestId: id, verdict, timeSavedMs: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null };
}
export function validateCapacity(options: CapacityOptions): void {
  if (options.E6_CAPACITY_HOOK !== undefined && typeof options.E6_CAPACITY_HOOK !== 'boolean') throw new AdmissionError('E6_CAPACITY_HOOK must be boolean');
  if (options.E6_CAPACITY_HOOK && (!Number.isSafeInteger(options.landing_rank_bound) || options.landing_rank_bound! < 1))
    throw new AdmissionError('landing_rank_bound must be a positive integer when E6_CAPACITY_HOOK is enabled');
}

export type AdmissionFields = {
  idempotencyKey?: string;
  repository?: string;
  head?: string;
  base?: string;
  evidenceVersion?: string;
  policyVersion?: string;
};
export type StoredAdmission = {
  admissionKey?: string;
  dispatchClass?: AdmissionMetadata['dispatchClass'];
  predecessorId?: string;
  reuse?: Reuse | null;
};
export function admissionFields(optional: (check: (value: unknown) => boolean) => (value: unknown) => boolean,
  filled: (value: unknown) => boolean): Record<keyof AdmissionFields, [(value: unknown) => boolean, string]> {
  return {
    idempotencyKey: [optional(filled), 'non-empty text when given'],
    repository: [optional(filled), 'a non-empty label when given'],
    head: [optional(v => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v)), 'a full commit hash when given'],
    base: [optional(v => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v)), 'a full commit hash when given'],
    evidenceVersion: [optional(filled), 'non-empty text when given'],
    policyVersion: [optional(filled), 'non-empty text when given'],
  };
}
export function storedAdmission(raw: Record<string, unknown>): StoredAdmission {
  return typeof raw.admissionKey === 'string' && typeof raw.dispatchClass === 'string' &&
    ['first', 'confirm', 'reassess', 'repeat'].includes(raw.dispatchClass) ? {
      admissionKey: raw.admissionKey, dispatchClass: raw.dispatchClass as DispatchClass,
      ...(typeof raw.predecessorId === 'string' ? { predecessorId: raw.predecessorId } : {}), reuse: null } : {};
}

/** Content-free list projection; unkeyed legacy rows retain their exact original shape. */
import type { Store } from './store.ts';

export function listRequests(store: Store, state: string | null, requester: string | null) {
  const requests = store.list(state ?? undefined, requester ?? undefined);
  const held = store.heldReviews(requester ?? undefined).filter(() =>
    !state || state === 'queued-for-capacity')
    .slice(0, 500 - requests.length)
    .map(({ id, requester, createdAt, updatedAt, admissionKey, dispatchClass, predecessorId }) => ({ id, requester, state: 'queued-for-capacity',
      seq: null, createdAt, updatedAt, admissionKey, dispatchClass, predecessorId: predecessorId ?? null, reuse: null, admissionState: 'queued-for-capacity', accountId: null }));
  const byRequest = new Map(store.openAttempts().map((attempt) => [attempt.requestId, attempt.accountId]));
  return [...requests.map(({ id, requester, state, seq, createdAt, updatedAt, admissionKey, dispatchClass, predecessorId }) => ({
    id, requester, state, seq, createdAt, updatedAt,
    ...(admissionKey === undefined ? {} : { admissionKey, dispatchClass: dispatchClass ?? null, predecessorId: predecessorId ?? null, reuse: null }),
    accountId: byRequest.get(id) ?? null,
  })), ...held];
}

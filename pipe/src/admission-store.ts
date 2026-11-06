/** E1 persistence helpers. Store owns every write transaction and its clock. */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Store, NewRequest, RequestRecord } from './store.ts';
import type { SavedStart } from './saved-base.ts';
import { reviewSetupFailed } from './telemetry.ts';
import { admission, AdmissionError, conflict, reuse, type Admission, type AdmissionMetadata } from './admission.ts';

type Row = Record<string, unknown>;
export const FIELD_LIMIT = 1024 * 1024;
export const directory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const ADMISSIONS = `CREATE TABLE IF NOT EXISTS admissions (
  seq INTEGER PRIMARY KEY, namespace TEXT NOT NULL, admission_key TEXT NOT NULL, request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, scope TEXT NOT NULL, basis TEXT NOT NULL, history TEXT NOT NULL,
  explicit INTEGER CHECK (explicit IN (0, 1)),
  UNIQUE(namespace, admission_key)
); CREATE INDEX IF NOT EXISTS admissions_scope ON admissions(namespace, scope, seq)`;

export class StoreAdmissions {
  #db: DatabaseSync;
  #store: Pick<Store, 'get' | 'review' | 'attempts' | 'insertReview'>;
  #stamp: () => string;
  #error: new (message: string) => Error;
  constructor(db: DatabaseSync, store: Pick<Store, 'get' | 'review' | 'attempts' | 'insertReview'>, stamp: () => string, error: new (message: string) => Error) {
    this.#db = db; this.#store = store; this.#stamp = stamp; this.#error = error;
  }
  initialize(): void {
    this.#db.exec(ADMISSIONS);
    if (!(this.#db.prepare('PRAGMA table_info(admissions)').all() as Row[]).some(column => column.name === 'explicit')) {
      this.#db.exec(`ALTER TABLE admissions ADD COLUMN explicit INTEGER CHECK (explicit IN (0, 1));
        UPDATE admissions SET explicit = CASE WHEN json_type(requests.body, '$.idempotencyKey') = 'text' THEN 1 ELSE 0 END
          FROM requests WHERE admissions.namespace = 'request' AND admissions.request_id = requests.id`);
    }
  }

  submit(body: NewRequest, startSource?: SavedStart, identity = admission(body, [body.provider], body.prompt)): RequestRecord {
    const admitted = this.admit('request', identity, randomUUID());
    if (admitted.repeated) {
      const original = this.#store.get(admitted.id)!;
      return { ...original, ...admitted.metadata, reuse: reuse(original.id, null, original.createdAt, original.finishedAt, original.state === 'completed') };
    }
    const id = admitted.id, storedBody = JSON.stringify({ ...body, ...admitted.metadata, ...(startSource ? { startSource } : {}) });
    if (Buffer.byteLength(storedBody) > FIELD_LIMIT) throw new this.#error('request exceeds the 1 MiB stored body limit');
    if (body.cwd !== undefined && !directory(body.cwd)) throw new this.#error('cwd must be an existing directory');
    if (body.pinnedStartCommit !== undefined) this.#db.exec('PRAGMA user_version = 4');
    else if (body.automatic && Number(this.#db.prepare('PRAGMA user_version').get()!.user_version) < 3) this.#db.exec('PRAGMA user_version = 3');   // old engines must not discard automatic intent
    const at = this.#stamp();
    this.#db.prepare("INSERT INTO requests (id, requester, state, body, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)")
      .run(id, body.requester, storedBody, at, at);
    return this.#store.get(id)!;
  }

  submitReviewSeat(reviewId: string, body: NewRequest, seat: Record<string, unknown>): RequestRecord {
    const id = randomUUID();
    if (body.expectedStartCommit !== undefined) throw new this.#error('review seats cannot select a saved start');
    if (body.automatic) throw new this.#error('review seats require one fixed route');
    const row = this.#db.prepare('SELECT body FROM reviews WHERE id = ?').get(reviewId) as Row | undefined;
    if (!row) throw new this.#error('review is missing');
    if (body.cwd !== undefined && !directory(body.cwd)) throw new this.#error('cwd must be an existing directory');
    const review = JSON.parse(String(row.body)) as { seats: Record<string, unknown>[] } & Partial<AdmissionMetadata>;
    if (!Array.isArray(review.seats)) throw new this.#error('review seats are invalid');
    const at = this.#stamp();
    this.#db.prepare("INSERT INTO requests (id, requester, state, body, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)")
      .run(id, body.requester, JSON.stringify({ ...body, ...(review.admissionKey ? { admissionKey: review.admissionKey, dispatchClass: review.dispatchClass } : {}) }), at, at);
    review.seats.push({ ...seat, requestId: id, status: 'waiting' });
    this.#db.prepare('UPDATE reviews SET body = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(review), at, reviewId);
    return this.#store.get(id)!;
  }

  hasReviewAdmission(identity: Admission): boolean {
    if (identity.key === undefined) return false;
    const row = this.#db.prepare("SELECT * FROM admissions WHERE namespace = 'review' AND admission_key = ?").get(identity.key);
    if (!row || !this.reusable('review', row)) return false;
    if (row.fingerprint !== identity.fingerprint) conflict();
    return true; // Only skips repeated object reads; admitReview still owns the atomic decision.
  }

  releaseReview(id: string): boolean {
    return Number(this.#db.prepare(`UPDATE reviews
      SET body = json_remove(json_set(body, '$.admissionState', 'admitted'), '$.capacitySetup')
      WHERE id = ? AND state = 'running' AND json_extract(body, '$.admissionState') = 'queued-for-capacity'`).run(id).changes) === 1;
  }

  /** Key lookup and original creation/release share the same write transaction, before checkout. */
  admitReview(id: string, body: object, identity: Admission, held: boolean, canAdmit = () => true): { id: string; prepare: boolean; repeated: boolean } {
    if (!canAdmit()) throw Object.assign(new AdmissionError('service admission is paused'), { status: 503, code: 'admission_paused' });
    const admitted = this.admit('review', identity, id);
    if (!admitted.repeated) {
      this.#store.insertReview(id, 'running', { ...body, ...admitted.metadata, admissionState: held ? 'queued-for-capacity' : 'admitted' });
      return { id, prepare: !held, repeated: false };
    }
    const original = this.#store.review(admitted.id)!;
    const release = original.admissionState === 'queued-for-capacity' && !held;
    if (release) this.#db.prepare("UPDATE reviews SET body = json_remove(json_set(body, '$.admissionState', 'admitted'), '$.capacitySetup') WHERE id = ?").run(admitted.id);
    return { id: admitted.id, prepare: release, repeated: true };
  }

  reusable(namespace: 'request' | 'review', row: Row): boolean {
    const original = namespace === 'request' ? this.#store.get(String(row.request_id)) : this.#store.review(String(row.request_id));
    if (!original) throw new this.#error('admission record has no original request');
    // Unknown legacy review provenance retains its binding; it cannot authorize a replacement.
    if (row.explicit !== 0) return true;
    if (namespace === 'request') return ['queued', 'running', 'completed'].includes(String(original.state)) ||
      this.#store.attempts(String(row.request_id)).some(a => a.endedAt === null);
    const review = original as { state?: string; setupFailed?: unknown; seats?: { provider: string; requestId: string; status: string }[] };
    let activeWork = false;
    const seats = review.seats?.map(s => {
      if (s.provider === 'gemini') {
        if (s.status === 'waiting' || s.status === 'running') activeWork = true;
        return s;
      }
      if (!s.requestId) return s;
      const request = this.#store.get(s.requestId);
      if (request?.state === 'queued' || request?.state === 'running' || this.#store.attempts(s.requestId).some(a => a.endedAt === null)) {
        activeWork = true;
        return { ...s, status: 'waiting' };
      }
      return s.status === 'waiting' || s.status === 'running' ? { ...s, status: 'closed' } : s;
    });
    return activeWork || !reviewSetupFailed(review) && (review.state === 'running' &&
      (!seats?.length || seats.some(s => s.status === 'waiting' || s.status === 'running')) || review.state === 'finished' &&
      !!seats?.length && seats.every(s => s.status === 'voted' || s.status === 'advice'));
  }

  admit(namespace: 'request' | 'review', identity: Admission, id: string) {
    if (identity.key === undefined) return { id, repeated: false, metadata: {} as Partial<AdmissionMetadata> };
    const row = this.#db.prepare('SELECT * FROM admissions WHERE namespace = ? AND admission_key = ?').get(namespace, identity.key);
    if (row && this.reusable(namespace, row)) {
      if (row.fingerprint !== identity.fingerprint) conflict();
      id = String(row.request_id);
      this.#db.prepare("UPDATE admissions SET history = json_insert(history, '$[#]', 'repeat') WHERE seq = ? AND json_extract(history, '$[#-1]') != 'repeat'").run(row.seq!);
      return { id, repeated: true, metadata: { admissionKey: identity.key, dispatchClass: 'repeat' as const } };
    }
    const scope = namespace === 'request' ? JSON.stringify([identity.scope, identity.briefSha256]) : identity.scope;
    const prior = this.#db.prepare('SELECT * FROM admissions WHERE namespace = ? AND scope = ? ORDER BY seq DESC LIMIT 1').get(namespace, scope);
    const previous: { state?: string; receipt?: unknown; briefSha256?: string } | undefined = prior
      ? namespace === 'review' ? this.#store.review(String(prior.request_id)) : this.#store.get(String(prior.request_id)) : undefined;
    const approved = namespace === 'request' ? previous?.state === 'completed'
      : previous?.state === 'finished' && (previous.receipt as { quorum?: { approved?: boolean } } | undefined)?.quorum?.approved === true;
    const dispatchClass = !prior ? 'first' : approved && prior.basis === identity.basis &&
      (namespace === 'request' || previous?.briefSha256 !== identity.briefSha256) ? 'confirm' : 'reassess';
    // Move only the key's binding; the predecessor record, attempts and receipt remain intact.
    if (row) this.#db.prepare('DELETE FROM admissions WHERE seq = ?').run(row.seq!);
    this.#db.prepare('INSERT INTO admissions (namespace, admission_key, request_id, fingerprint, scope, basis, history, explicit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(namespace, identity.key, id, identity.fingerprint, scope, identity.basis,
        JSON.stringify([...(row ? JSON.parse(String(row.history)) as string[] : []), dispatchClass]), Number(identity.explicit));
    return { id, repeated: false, metadata: { admissionKey: identity.key, dispatchClass,
      ...(row ? { predecessorId: String(row.request_id) } : {}) } as AdmissionMetadata };
  }

  heldReviews(requester?: string): Record<string, unknown>[] {
    return (this.#db.prepare(`SELECT id FROM reviews WHERE state = 'running' AND
      json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.admissionState') = 'queued-for-capacity'
      AND (? IS NULL OR json_extract(CASE WHEN json_valid(body) THEN body ELSE '{}' END, '$.requester') = ?)
      ORDER BY created_at DESC LIMIT 500`).all(requester ?? null, requester ?? null) as Row[]).map(row => this.#store.review(String(row.id))!);
  }

}

/**
 * One naming for allowance buckets, used by the runner (limit errors) and the probe (readings)
 * alike. A hold clears only with a newer reading of the same bucket and model, so a hold named
 * one way and a reading named another would never meet.
 *
 * Names follow the service: Claude's `rateLimitType` (`five_hour`, `seven_day`,
 * `seven_day_<model>`) and Codex's limit id and window. A Claude week that belongs to one model
 * is scoped to that model's family, so a spent Fable week never holds Opus.
 */
export type BucketName = { bucket: string; model: string | null };

// Collision-free: a null model (the whole account) and an empty model name are different buckets.
export const keyOf = (b: { bucket: string | null; model: string | null }) => JSON.stringify([b.bucket, b.model]);
// A job's limit and a reading's hold on one bucket are kept apart: each has its own reset and clearing rule.
export const holdKey = (b: { bucket: string | null; model: string | null }, origin: 'limit' | 'reading') => JSON.stringify([b.bucket, b.model, origin]);

/**
 * A Claude rate-limit type, as a limit error names it, for a job running `model`. A week scoped
 * to another family, or a type the pipe does not know, holds the whole account's week: a later
 * week reading can clear that, where a name no reading uses would never be cleared.
 */
export function claudeLimitBucket(rateLimitType: string, model: string): BucketName {
  if (rateLimitType === 'five_hour' || rateLimitType === 'seven_day') return { bucket: rateLimitType, model: null };
  const scoped = /^seven_day_([a-z0-9]+)$/u.exec(rateLimitType);
  if (scoped && scoped[1] === modelFamily(model)) return { bucket: 'seven_day', model: scoped[1] };
  return { bucket: 'seven_day', model: null };
}

/**
 * A line of Claude's `/usage`: "Current session", "Current week (all models)" or
 * "Current week (<Model>)". Null for a window the pipe does not know.
 */
export function claudeUsageBucket(window: string, scope: string | null): BucketName | null {
  if (window === 'session' && scope === null) return { bucket: 'five_hour', model: null };
  if (window !== 'week') return null;
  if (scope === null || scope.toLowerCase() === 'all models') return { bucket: 'seven_day', model: null };
  const family = scope.trim().toLowerCase();
  return /^[a-z0-9]+$/u.test(family) ? { bucket: 'seven_day', model: family } : null;
}

/** A Codex rate-limit window: `<limitId>:primary|secondary`, scoped to the model it names, if any. */
export function codexBucket(limitId: string, window: 'primary' | 'secondary', modelSlug: string | null): BucketName {
  return { bucket: `${limitId}:${window}`, model: modelSlug };
}

/** The name a model's allowance is scoped by: a Claude model's family, any other model as is. */
export function modelFamily(model: string): string {
  return /^claude-([a-z]+)-\d/u.exec(model)?.[1] ?? model;
}

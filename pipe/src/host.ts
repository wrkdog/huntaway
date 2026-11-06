/** Executor labels are explicit ASCII aliases; missing or malformed evidence stays unknown. */
export const hostAlias = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(v) ? v : null;

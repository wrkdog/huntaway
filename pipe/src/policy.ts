export const PROVIDERS = ['claude', 'codex', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];
export type Use = 'default' | 'hard';
export type ProviderPolicy = { models: Record<string, Use>; efforts: string[] };
export type Policy = Partial<Record<Provider, ProviderPolicy>>;
export const ARGON_MODEL = 'gemini-4.0-argon';
export const geminiReadOnly = (r: { kind?: unknown; model?: unknown; mutating?: unknown }): boolean =>
  r.mutating === false && (r.kind === 'chat' || r.model === ARGON_MODEL && (r.kind === 'question' || r.kind === 'review'));

export type Choice = { provider: string; model?: string; effort?: string; reason?: string };
export type ChoiceCode = 'unknown_provider' | 'choice_required' | 'unknown_model' | 'unsupported_effort' | 'reason_required';
export type ChoiceResult =
  | { ok: true; use: Use; reason: string }
  | { ok: false; code: ChoiceCode; message: string; options: string[] };

export class PolicyError extends Error {
  override name = 'PolicyError';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProvider = (p: string): p is Provider => (PROVIDERS as readonly string[]).includes(p);
const chosen = (s: string | undefined): s is string => s !== undefined && s.trim() !== '';

export function parsePolicy(raw: unknown): Policy {
  if (!isObject(raw)) throw new PolicyError('policy must be an object keyed by provider');
  const entries = Object.entries(raw);
  if (entries.length === 0) throw new PolicyError(`policy names no provider; expected some of ${PROVIDERS.join(', ')}`);
  const policy: Policy = {};
  for (const [provider, value] of entries) {
    if (!isProvider(provider)) throw new PolicyError(`unknown provider "${provider}"; expected one of ${PROVIDERS.join(', ')}`);
    policy[provider] = parseProvider(provider, value);
  }
  return policy;
}

function parseProvider(provider: Provider, value: unknown): ProviderPolicy {
  const fail = (why: string) => new PolicyError(`${provider}: ${why}`);
  if (!isObject(value) || !isObject(value.models) || !Array.isArray(value.efforts)) {
    throw fail('expected { models: { <id>: "default" | "hard" }, efforts: [<level>, ...] }');
  }
  const models: Record<string, Use> = {};
  for (const [id, use] of Object.entries(value.models)) {
    if (id.trim() === '') throw fail('a model id is empty');
    if (use !== 'default' && use !== 'hard') throw fail(`model "${id}" is "${String(use)}"; expected "default" or "hard"`);
    Object.defineProperty(models, id, { value: use, enumerable: true });
  }
  const defaults = Object.keys(models).filter((id) => models[id] === 'default');
  if (defaults.length !== 1) throw fail(`needs exactly one default model; found ${defaults.length} (${defaults.join(', ') || 'none'})`);
  const efforts = value.efforts;
  if (efforts.length === 0) throw fail('offers no effort levels');
  for (const [i, e] of efforts.entries()) {
    if (typeof e !== 'string' || e.trim() === '') throw fail(`effort #${i + 1} is not a level name`);
    if (efforts.indexOf(e) !== i) throw fail(`effort "${e}" is listed twice`);
  }
  return { models, efforts: [...(efforts as string[])] };
}

export function checkChoice(policy: Policy, choice: Choice): ChoiceResult {
  const refuse = (code: ChoiceCode, message: string, options: string[]): ChoiceResult => ({ ok: false, code, message, options });
  const { provider, model, effort } = choice;
  const offered = isProvider(provider) && Object.hasOwn(policy, provider) ? policy[provider] : undefined;
  if (!offered) {
    const known = Object.keys(policy);
    return refuse('unknown_provider', `provider "${provider}" is not in the policy; choose one of ${known.join(', ')}`, known);
  }
  const models = Object.keys(offered.models);
  const menu = `models: ${models.map((m) => `${m} (${offered.models[m]})`).join(', ')}; efforts: ${offered.efforts.join(', ')}`;
  if (!chosen(model) || !chosen(effort)) {
    return refuse('choice_required', `${provider} needs an active choice of model and effort; ${menu}`, chosen(model) ? [...offered.efforts] : models);
  }
  if (!Object.hasOwn(offered.models, model)) {
    return refuse('unknown_model', `${provider} has no model "${model}"; choose one of ${models.join(', ')}`, models);
  }
  if (!offered.efforts.includes(effort)) {
    return refuse('unsupported_effort', `${provider} has no effort "${effort}"; choose one of ${offered.efforts.join(', ')}`, [...offered.efforts]);
  }
  // Every accepted choice says why (AGENTS rule 4); the reason is kept for the record.
  const reason = chosen(choice.reason) ? choice.reason.trim() : undefined;
  const use = offered.models[model]!;
  if (reason === undefined && use === 'hard') {
    const fallback = models.filter((m) => offered.models[m] === 'default');
    return refuse('reason_required', `${model} is kept for hard problems; state why this one is hard, or choose ${fallback.join(', ')}`, fallback);
  }
  if (reason === undefined) return refuse('reason_required', `say why ${model} at ${effort} effort fits this task`, []);
  return { ok: true, use, reason };
}

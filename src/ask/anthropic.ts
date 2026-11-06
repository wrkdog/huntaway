import type { AskOptions, SubmitHooks, SubmitResult } from './engines.ts';
import { ANTHROPIC_MODELS } from './models.ts';
import { paidUrl, preparePaid, type PaidEngine, type PreparedPaid, type Usage } from './paid.ts';

// Compatibility for callers of the original engine; network outcomes now belong to the shared layer.
export { usableKey, networkOutcome } from './paid.ts';
export const LONGEST_WAIT_SECONDS = 300;

// Endpoint, auth, max_tokens, service_tier, usage and stop reasons:
// https://platform.claude.com/docs/en/api/messages/create (checked 2026-11-05).
// The free count accepts the same model/messages/thinking input:
// https://platform.claude.com/docs/en/build-with-claude/token-counting
// Status decisions retained from the existing engine:
// https://platform.claude.com/docs/en/api/errors
const NOT_RUN = new Set([400, 401, 403, 404, 413, 429, 529]);
const ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'billing_error', 'permission_error',
  'not_found_error', 'request_too_large', 'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error']);

const object = (body: unknown): Record<string, unknown> | null =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Invalid usage retains the reservation; tier violations with valid tokens instead settle at priority. */
function readUsage(body: unknown): Usage | null {
  const u = object(body);
  if (!u || !integer(u.input_tokens) || !integer(u.output_tokens)) return null;
  const created = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  // Null is present and invalid; only absence means zero for optional cache fields.
  if ((Object.hasOwn(u, 'cache_creation_input_tokens') && !integer(u.cache_creation_input_tokens)) ||
      (Object.hasOwn(u, 'cache_read_input_tokens') && !integer(u.cache_read_input_tokens))) return null;
  if (!integer(created) || !integer(read)) return null;
  const input = BigInt(u.input_tokens) + BigInt(created) + BigInt(read);
  const output = BigInt(u.output_tokens);
  if (Object.hasOwn(u, 'total_tokens') && (!integer(u.total_tokens) || BigInt(u.total_tokens) !== input + output)) return null;
  if (Object.hasOwn(u, 'output_tokens_details')) {
    const details = object(u.output_tokens_details);
    if (!details || !integer(details.thinking_tokens) || BigInt(details.thinking_tokens) > output) return null;
  }
  if (Object.hasOwn(u, 'cache_creation')) {
    const cache = object(u.cache_creation);
    if (!cache || !integer(cache.ephemeral_1h_input_tokens) || !integer(cache.ephemeral_5m_input_tokens) ||
        BigInt(cache.ephemeral_1h_input_tokens) + BigInt(cache.ephemeral_5m_input_tokens) !== BigInt(created)) return null;
  }
  return { input, output, cache: BigInt(created) + BigInt(read), standard: u.service_tier === 'standard' };
}

export const ANTHROPIC: PaidEngine = {
  name: 'anthropic', label: 'Anthropic', keyName: 'ANTHROPIC_API_KEY',
  url: 'https://api.anthropic.com/v1/messages', countPath: '/v1/messages/count_tokens',
  models: ANTHROPIC_MODELS, notRun: NOT_RUN,
  headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }),
  countBody: (options, model) => ({ model: model.id, messages: [{ role: 'user', content: options.question }],
    ...(model.thinking === 'between_tools' ? { thinking: { type: 'between_tools' } } : {}) }),
  requestBody: (options, model) => ({ model: model.id, max_tokens: options.maxTokens,
    messages: [{ role: 'user', content: options.question }], service_tier: 'standard_only',
    // With no tools, this is Sonnet 5.5's documented text-only equivalent of thinking off.
    ...(model.thinking === 'between_tools' ? { thinking: { type: 'between_tools' } } : {}) }),
  readCount: body => {
    const count = object(body)?.input_tokens;
    return integer(count) ? BigInt(count) : null;
  },
  readAnswer: body => {
    const doc = object(body);
    if (!doc || !Array.isArray(doc.content)) return null;
    const texts = doc.content.map(object).filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b!.text as string);
    return { answer: texts.join(''), truncated: doc.stop_reason === 'max_tokens',
      refused: doc.stop_reason === 'refusal', usage: readUsage(doc.usage) };
  },
  errorType: body => {
    const type = object(object(body)?.error)?.type;
    return typeof type === 'string' && ERROR_TYPES.has(type) ? type : 'error';
  },
  refusal: (status, type, model) => {
    const fix = status === 404 && type === 'not_found_error'
      ? `: the model ${model} is unknown, retired or not available to this key; choose another with --model` : '';
    return `the API refused the request (${status} ${type})${fix}`;
  },
};

export function anthropicUrl(): string { return paidUrl(ANTHROPIC); }
export function prepareAnthropic(options: AskOptions): PreparedPaid { return preparePaid(ANTHROPIC, options); }
export async function submitAnthropic(options: AskOptions, hooks: SubmitHooks, prepared?: PreparedPaid): Promise<SubmitResult> {
  return (prepared ?? prepareAnthropic(options)).submit(hooks);
}

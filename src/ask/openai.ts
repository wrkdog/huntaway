import type { AskOptions, SubmitHooks, SubmitResult } from './engines.ts';
import { OPENAI_MODELS, type Model } from './models.ts';
import { paidUrl, preparePaid, type PaidEngine, type PreparedPaid, type Usage } from './paid.ts';

// Checked 2026-11-05: endpoint, Bearer auth, output_text/refusal parts, incomplete_details,
// usage and the actual (not requested) service_tier:
// https://developers.openai.com/api/reference/resources/responses/methods/create
// The input-token count is free and consumes no normal inference quota:
// https://help.openai.com/en/articles/4936856-understanding-and-counting-tokens
// Exact never-ran set: invalid request, authentication, permission, missing resource,
// rate/quota refusal. Status-to-error mappings are in OpenAI's published SDK:
// https://github.com/openai/openai-python/blob/main/src/openai/_client.py
// https://developers.openai.com/api/docs/guides/error-codes
// 500 is an error WHILE processing; 503 reports overload but gives no general guarantee
// that execution never began. Neither retry guidance nor a 5xx proves no billing.
// Keep both uncertain (and retain the reservation); do not broaden this set to all 4xx.
const NOT_RUN = new Set([400, 401, 403, 404, 429]);
const ERROR_TYPES = new Set(['invalid_request_error', 'authentication_error', 'permission_error',
  'not_found_error', 'rate_limit_error', 'insufficient_quota', 'server_error', 'service_unavailable_error']);

const object = (body: unknown): Record<string, unknown> | null =>
  body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readUsage(body: unknown, tier: unknown): Usage | null {
  const u = object(body);
  if (!u || !integer(u.input_tokens) || !integer(u.output_tokens)) return null;
  const input = BigInt(u.input_tokens);
  const output = BigInt(u.output_tokens);
  if (Object.hasOwn(u, 'total_tokens') && (!integer(u.total_tokens) || BigInt(u.total_tokens) !== input + output)) return null;
  for (const [field, part, bound] of [
    ['input_tokens_details', 'cached_tokens', input],
    ['output_tokens_details', 'reasoning_tokens', output],
  ] as const) {
    if (!Object.hasOwn(u, field)) continue;
    const details = object(u[field]);
    if (!details || !integer(details[part]) || BigInt(details[part]) > bound) return null;
  }
  // Cached input is already included in input_tokens. Charge the full input rate;
  // reasoning is already included in output_tokens. Neither is added a second time.
  return { input, output, cache: 0n, standard: tier === 'default' };
}

// Checked 2026-11-06: POST /v1/responses/input_tokens accepts model, input and reasoning,
// but not max_output_tokens, service_tier or store. Send only the accepted fields we use:
// https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count
function countBody(options: AskOptions, model: Model) {
  return { model: model.id, input: options.question,
    ...(model.reasoningEffort === undefined ? {} : { reasoning: { effort: model.reasoningEffort } }) };
}

function requestBody(options: AskOptions, model: Model): unknown {
  return { ...countBody(options, model), max_output_tokens: options.maxTokens,
    service_tier: 'default', store: false };
}

export const OPENAI: PaidEngine = {
  name: 'openai', label: 'OpenAI', keyName: 'OPENAI_API_KEY',
  url: 'https://api.openai.com/v1/responses', countPath: '/v1/responses/input_tokens',
  models: OPENAI_MODELS, notRun: NOT_RUN,
  headers: key => ({ Authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
  countBody, requestBody,
  readCount: body => {
    const count = object(body)?.input_tokens;
    return integer(count) ? BigInt(count) : null;
  },
  readAnswer: body => {
    const doc = object(body);
    if (!doc || !Array.isArray(doc.output) || !['completed', 'incomplete'].includes(doc.status as string)) return null;
    const reason = object(doc.incomplete_details)?.reason;
    if (doc.status === 'incomplete' && reason !== 'max_output_tokens' && reason !== 'content_filter') return null;
    let answer = '';
    let refused = reason === 'content_filter';
    for (const item of doc.output) {
      const message = object(item);
      if (!message) return null;
      if (message.type !== 'message') continue;
      if (!Array.isArray(message.content)) return null;
      for (const part of message.content) {
        const content = object(part);
        if (!content) return null;
        if (content.type === 'refusal') refused = true;
        if (content.type === 'output_text') {
          if (typeof content.text !== 'string') return null;
          answer += content.text;
        }
      }
    }
    return { answer, truncated: reason === 'max_output_tokens', refused, usage: readUsage(doc.usage, doc.service_tier) };
  },
  errorType: body => {
    const type = object(object(body)?.error)?.type;
    return typeof type === 'string' && ERROR_TYPES.has(type) ? type : 'error';
  },
  refusal: (status, type) => `the API refused the request (${status} ${type})`,
};

export function openaiUrl(): string { return paidUrl(OPENAI); }
export function prepareOpenai(options: AskOptions): PreparedPaid { return preparePaid(OPENAI, options); }
export async function submitOpenai(options: AskOptions, hooks: SubmitHooks, prepared?: PreparedPaid): Promise<SubmitResult> {
  return (prepared ?? prepareOpenai(options)).submit(hooks);
}

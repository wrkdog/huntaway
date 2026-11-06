/** Reviewed capabilities. Money is integer micro-dollars per million tokens. */
export type Prices = { input: bigint; output: bigint };
export type Model = {
  id: string;
  default?: boolean;
  safetyRevision: number;
  standard: Prices;
  priority: Prices;
  hardInputLimit: bigint;
  byteBound: boolean;
  overhead: bigint;
  /** Some providers reject input + output above the context window; Anthropic instead stops generation. */
  sharedContext?: boolean;
  thinking: 'none' | 'between_tools';
  /** Lowest supported effort, only for OpenAI reasoning models. Absence omits reasoning. */
  reasoningEffort?: 'none' | 'minimal' | 'low';
  checked: string;
  sources: readonly string[];
};

// Checked 2026-11-05:
// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
// https://platform.claude.com/docs/en/about-claude/pricing
// $2 / $10 per MTok, no long-context premium. Include the 1.1x US-residency surcharge,
// which a workspace default can enable without a request field:
// https://platform.claude.com/docs/en/manage-claude/data-residency
// Priority commitments are legacy, with no public Sonnet 5.5 rate here:
// https://platform.claude.com/docs/en/api/service-tiers
// CONSERVATIVE FALLBACK: priority uses 5x base prices, including residency ($11 / $55).
// This is a deliberately higher allowance, not a confirmed contract price. Accounts
// with a still higher contract rate must raise it with a price override.
// https://platform.claude.com/docs/en/build-with-claude/context-windows
// Input alone above 1M is refused; input + max_tokens above 1M is accepted and output
// stops at the window. Thus do NOT subtract max_tokens from this hard input limit.
// https://platform.claude.com/docs/en/build-with-claude/thinking
// Sonnet 5.5 rejects "disabled"; between_tools with no tools returns only text.
// Thinking, if reported, is included in max_tokens, never an additional budget.
export const ANTHROPIC_MODELS: readonly Model[] = [{
  id: 'claude-sonnet-5-5', default: true, safetyRevision: 1,
  standard: { input: 2_200_000n, output: 11_000_000n },
  priority: { input: 11_000_000n, output: 55_000_000n },
  hardInputLimit: 1_000_000n, thinking: 'between_tools', checked: '2026-11-05',
  // Based on Anthropic's earlier published byte-level BPE (tiktoken).
  // Anthropic hasn't published this model's tokenizer. The factor 2 margin and
  // post-call input overrun block defend this assumption; this is not a proof.
  byteBound: true,
  overhead: 64n, // Conservative message framing allowance; no system prompt or tools.
  sources: [
    'https://platform.claude.com/docs/en/models/sonnet-5-5/overview',
    'https://platform.claude.com/docs/en/about-claude/pricing',
    'https://platform.claude.com/docs/en/manage-claude/data-residency',
    'https://platform.claude.com/docs/en/api/service-tiers',
    'https://platform.claude.com/docs/en/build-with-claude/context-windows',
    'https://platform.claude.com/docs/en/build-with-claude/thinking',
    'https://github.com/anthropics/anthropic-tokenizer-typescript',
  ],
}];

// Checked 2026-11-05. GPT-5.4 supports reasoning.effort "none" and a 1,050,000-token
// context window. With default truncation disabled, input beyond the window is rejected.
// Use the full window as the input ceiling: OpenAI documents generation stopping at
// the context boundary, not a guarantee that input + max_output_tokens is rejected.
// Subtracting the requested output budget could therefore understate accepted input.
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/reference/resources/responses/methods/create
// https://developers.openai.com/api/docs/guides/conversation-state#managing-context-for-text-generation
// max_output_tokens includes reasoning, visible output AND non-visible formatting tokens:
// https://developers.openai.com/api/docs/guides/reasoning#controlling-costs
// Base standard rates are $2.50 / $15 per MTok. Above 272K input the entire request
// costs 2x input and 1.5x output, so ALWAYS reserve at $5 / $22.50, even for short input.
// The documented 10% residency uplift requires a regional processing endpoint;
// Huntaway pins https://api.openai.com, never a regional or FedRAMP endpoint.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/guides/your-data#data-residency
// No current public GPT-5.4 Fast/priority long-context rate was confirmed:
// https://developers.openai.com/api/docs/guides/fast-mode
// CONSERVATIVE FALLBACK: priority is 5x the highest standard rate ($25 / $112.50).
// This is an allowance, not a confirmed contract price; higher contracts need overrides.
export const OPENAI_MODELS: readonly Model[] = [{
  id: 'gpt-5.4', default: true, safetyRevision: 1,
  standard: { input: 5_000_000n, output: 22_500_000n },
  priority: { input: 25_000_000n, output: 112_500_000n },
  hardInputLimit: 1_050_000n,
  thinking: 'none', reasoningEffort: 'none', checked: '2026-11-05',
  // OpenAI's published tiktoken/model.py maps the gpt-5 prefix to o200k_base.
  // openai_public.py defines that encoding; src/lib.rs encodes regex pieces as UTF-8
  // bytes and merges byte pairs, without Unicode normalization or byte expansion.
  // Thus text tokens cannot outnumber UTF-8 bytes; framing is covered separately below.
  byteBound: true,
  overhead: 64n, // Conservative framing allowance: one user string, no system prompt or tools.
  sources: [
    'https://developers.openai.com/api/docs/models/gpt-5.4',
    'https://developers.openai.com/api/docs/pricing',
    'https://developers.openai.com/api/docs/guides/your-data',
    'https://developers.openai.com/api/docs/guides/fast-mode',
    'https://developers.openai.com/api/docs/guides/reasoning',
    'https://developers.openai.com/api/docs/guides/conversation-state',
    'https://developers.openai.com/api/reference/resources/responses/methods/create',
    'https://github.com/openai/tiktoken/blob/main/tiktoken/model.py',
    'https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py',
    'https://github.com/openai/tiktoken/blob/main/src/lib.rs',
  ],
}];

export function testMode(): boolean {
  return process.env.HUNTAWAY_ENABLE_FAKE_ENGINE === '1';
}

/** Stand-ins are admitted by the switch alone, never by an address or a key. */
export function modelsFor(entries: readonly Model[]): readonly Model[] {
  if (!testMode()) return entries;
  return [...entries, ...['hwtest-model', 'hwtest.model'].map(id => ({
    id, safetyRevision: 1,
    standard: { input: 1_000_000n, output: 2_000_000n },
    priority: { input: 2_000_000n, output: 4_000_000n },
    hardInputLimit: 100_000n, thinking: 'none' as const, checked: '2026-11-05', sources: [],
    byteBound: true, // The fixed stand-in contract.
    overhead: 64n,
  }))];
}

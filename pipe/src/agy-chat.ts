// Gemini is not part of this release: see agy.ts. Every validator refuses Gemini settings, and every request for a
// Gemini prompt or model list refuses.
import type { GeminiConfig } from './agy.ts';

export const GEMINI_UNSUPPORTED = 'Gemini is not supported in this release';

export type GeminiResult = { status: 'voted' | 'failed' | 'invalid'; reason?: string; errorKind?: string; held?: boolean;
  folder: string; conversationId?: string; promptBytes: number; promptSha256: string; responseSha256?: string;
  canary: 'ok' | 'missing' | 'wrong' | 'not_visible'; reportedLabel?: string; reportedModel: string;
  startedAt?: string; endedAt?: string; exitCode?: number; response?: string };

const refuse = (): never => { throw new Error(GEMINI_UNSUPPORTED); };

/** A Gemini section in the config, a Gemini policy, or an account with provider Gemini refuses startup. */
export function validateArgonModels(config: { policy?: unknown; gemini?: unknown; accounts?: unknown }): void {
  const policy = config.policy;
  const gemini = (v: unknown) => typeof v === 'string' && v.toLowerCase() === 'gemini';
  if (config.gemini !== undefined || (policy !== null && typeof policy === 'object' && Object.keys(policy).some(gemini)) ||
    (Array.isArray(config.accounts) && config.accounts.some((a) => a !== null && typeof a === 'object' && gemini((a as { provider?: unknown }).provider))))
    refuse();
}
export function validateGeminiConfig(_config: GeminiConfig): void { refuse(); }
export function geminiPrompt(_head: string, _brief: string, _briefSha256: string, _diff: string): { text: string; token: string } {
  return refuse();
}
export function geminiChatPrompt(_input: string): { text: string; token: string } { return refuse(); }
export function geminiChatRefusal(input: Record<string, unknown>, _accounts: readonly unknown[]): string | null {
  return String(input.provider).toLowerCase() === 'gemini' ? GEMINI_UNSUPPORTED : null;
}
export async function geminiModels(_config: GeminiConfig, _env: Record<string, string | undefined>): Promise<string[]> {
  return refuse();
}

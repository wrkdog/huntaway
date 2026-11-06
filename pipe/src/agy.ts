// Gemini is not part of this release. These placeholders keep the names the rest of the Pipe imports and refuse every
// use: no Google program is ever started and no sign-in is read or copied. A Gemini config refuses startup, a Gemini
// job or review seat is refused before it runs, and nothing reports Gemini as available.
import type { Store } from './store.ts';
import type { Review, Seat } from './review.ts';
import { GEMINI_UNSUPPORTED, type GeminiResult } from './agy-chat.ts';
export { GEMINI_UNSUPPORTED, validateGeminiConfig, geminiPrompt, geminiChatPrompt, geminiChatRefusal, geminiModels } from './agy-chat.ts';
export type { GeminiResult } from './agy-chat.ts';

export type GeminiConfig = { cli: string; home: string; loginHashesFile: string; sandboxExec?: string;
  approvedModels?: string[]; authRetryDelayMs?: number; lockFile?: string; lockWaitMs?: number; protectedPaths?: string[] };

const refuse = (): never => { throw new Error(GEMINI_UNSUPPORTED); };

export const hasGemini = (_store: Store): boolean => false;
export const geminiConfig = (_store: Store): GeminiConfig | undefined => undefined;
export const geminiFolder = (_store: Store): string => refuse();
export function configureGemini(_store: Store, _config: GeminiConfig, _storePath: string, _env: Record<string, string | undefined>): void {
  refuse();
}
export async function recoverGemini(_store: Store, _log: (where: string, error: unknown) => void = () => {}): Promise<void> {}
export async function stopGemini(_store: Store): Promise<void> {}
export function runningGemini(_store: Store): number { return 0; }
export function drainGemini(_store: Store): void {}
export function startGemini(_store: Store, _review: Review, _seat: Seat, _log: (where: string, error: unknown) => void): void {
  refuse();
}
export async function loginRefusal(_prompt: string, _file: string): Promise<string | null> { return GEMINI_UNSUPPORTED; }
export async function runGemini(_config: GeminiConfig, _folder: string, _model: string, _prompt: string, _token: string,
  _env: Record<string, string | undefined>, _signal: AbortSignal, _onStart: (pid: number, birth: string | null) => void,
  _onSupervisor: (owner: { pid: number; birth: string | null }) => void = () => {}, _clockCurrent: () => boolean = () => true,
  _operation: 'review' | 'chat' | 'models' = 'review', _onBeforeSpawn: () => void = () => {}): Promise<GeminiResult> {
  return refuse();
}

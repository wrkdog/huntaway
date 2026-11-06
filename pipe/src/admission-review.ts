/** Validate and snapshot review admission before any asynchronous repository work. */
import { isAbsolute } from 'node:path';
import { checkChoice, type Policy, type Provider } from './policy.ts';
import { validPlacement, type Store, type Priority } from './store.ts';
import { validLane } from './telemetry.ts';
import { hasGemini, geminiConfig } from './agy.ts';
import { inlineText, projectText, type Projects } from './projects.ts';
import { AdmissionError, admission, validateCapacity, type CapacityOptions } from './admission.ts';

export class ReviewError extends Error { override name = 'ReviewError'; }
function refuse(message: string): never { throw new ReviewError(message); }
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const SHA = /^[0-9a-f]{40}$/i;
const FAMILY = /^[a-z][a-z0-9-]{1,31}$/;
type Builder = { family: string; context: string };

export function reviewAdmission(store: Store, policy: Policy, input: unknown,
  options: CapacityOptions & { projects?: Projects; canAdmit?: () => boolean },
  approvedModel: (family: string, model: string, approved?: readonly string[]) => boolean) {
  if (options.canAdmit && !options.canAdmit())
    throw Object.assign(new AdmissionError('service admission is paused'), { status: 503, code: 'admission_paused' });
  if (!object(input)) refuse('review must be an object');
  const raw = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  validateCapacity(options);
  if (options.E6_CAPACITY_HOOK && raw.landing_rank !== undefined && (!Number.isSafeInteger(raw.landing_rank) || (raw.landing_rank as number) < 1)) refuse('landing_rank must be a positive integer');
  const held = options.E6_CAPACITY_HOOK === true && typeof raw.landing_rank === 'number' && raw.landing_rank > options.landing_rank_bound!;
  if (!filled(raw.requester) || raw.requester.trim().startsWith('--') || Buffer.byteLength(raw.requester) > 128) refuse('requester must be a non-empty string of at most 128 UTF-8 bytes not starting with --');
  if (!filled(raw.reason)) refuse('reason must be a non-empty string');
  if (typeof raw.repo !== 'string' || !isAbsolute(raw.repo)) refuse('repo must be an absolute path');
  if (raw.repository !== undefined && !filled(raw.repository)) refuse('repository must be a non-empty label');
  if (raw.project !== undefined && !filled(raw.project)) refuse('project must be a non-empty name');
  if (!validLane(raw.lane)) refuse('lane must be a non-empty string of at most 80 characters');
  const lane = raw.lane;
  if (typeof raw.head !== 'string' || !SHA.test(raw.head)) refuse('head must be a full 40-character hex commit');
  if (raw.base !== undefined && (typeof raw.base !== 'string' || !SHA.test(raw.base))) refuse('base must be a full 40-character hex commit');
  if (typeof raw.brief !== 'string' || !raw.brief.trim() || Buffer.byteLength(raw.brief) > 256 * 1024)
    refuse('brief must be non-empty and at most 256 KiB');
  if (!Array.isArray(raw.seats) || raw.seats.length < 1 || raw.seats.length > 6) refuse('seats must have 1 to 6 choices');
  if (raw.priority !== undefined && raw.priority !== 'interactive' && raw.priority !== 'background') refuse('priority must be interactive or background');
  if (!validPlacement(raw.placement)) refuse('placement must be ordinary_headroom when given');
  const placement = raw.placement; // Snapshot admission before asynchronous worktree preparation.
  if (raw.builders !== undefined && (!Array.isArray(raw.builders) || !raw.builders.every((b) => object(b) &&
    typeof b.family === 'string' && FAMILY.test(b.family) && filled(b.context)))) refuse('builders must name a family and context');
  const repo = raw.repo as string, head = (raw.head as string).toLowerCase();
  const base = (raw.base as string | undefined)?.toLowerCase(), brief = raw.brief as string;
  const builders = (raw.builders ?? []) as Builder[];
  const priority = (raw.priority ?? 'background') as Priority;
  const choices = raw.seats.map((entry: unknown, index: number) => {
    if (!object(entry) || !filled(entry.provider) || !filled(entry.model) || !filled(entry.effort))
      refuse(`seat ${index + 1} needs provider, model and effort`);
    if (entry.provider !== 'claude' && entry.provider !== 'codex' && entry.provider !== 'gemini')
      refuse(`seat ${index + 1}: use external votes for ${entry.provider}`);
    if (placement !== undefined && entry.provider === 'gemini') refuse('ordinary_headroom placement requires native Codex or Claude seats');
    if (entry.provider === 'gemini' && !base) refuse('Gemini seats require a base commit');
    if (entry.provider === 'gemini' && !hasGemini(store)) refuse(`seat ${index + 1}: Gemini is not configured`);
    const family = entry.provider === 'claude' ? 'anthropic' : entry.provider === 'gemini' ? 'google' : 'openai';
    if (!approvedModel(family, entry.model as string, geminiConfig(store)?.approvedModels))
      refuse(`seat ${index + 1}: ${entry.model} is not an approved review model`);
    const choice = checkChoice(policy, { provider: entry.provider, model: entry.model, effort: entry.effort, reason: raw.reason as string });
    if (!choice.ok) refuse(`seat ${index + 1}: ${choice.message}`);
    return { provider: entry.provider as Provider, model: entry.model as string, effort: entry.effort as string };
  });
  // Only Claude and Codex seats carry the project's text; a Gemini-only review reads and records neither file.
  const known = (text: ReturnType<typeof projectText>) => text && 'error' in text ? refuse(text.error) : text;
  const project = raw.project as string | undefined, native = choices.some((choice) => choice.provider !== 'gemini');
  for (const key of ['contextPacket', 'outputContract'] as const) if (raw[key] !== undefined && (!inlineText(raw[key]) || !native))
    refuse(inlineText(raw[key]) ? `${key} applies to Claude and Codex seats` : `${key} must be non-empty text of at most 262144 UTF-8 bytes (well-formed Unicode)`);
  const text = (kind: 'contextPacket' | 'outputContract') => native ? inlineText(raw[kind]) ?? known(projectText(options.projects, project, kind)) : undefined;
  const packet = text('contextPacket'), contract = text('outputContract');   // per-call text replaces the project's file for this review
  const identity = admission({ requester: raw.requester, reason: raw.reason, repository: raw.repository ?? repo,
    repo, head, base, brief, builders, priority, seats: choices, project, lane: lane ?? null,
    evidenceVersion: raw.evidenceVersion, policyVersion: raw.policyVersion, idempotencyKey: raw.idempotencyKey,
    contextPacketSha256: packet?.sha256, contextPacketMode: packet ? raw.contextPacket === undefined ? 'implicit' : 'inline' : undefined,
    outputContractSha256: contract?.sha256 }, choices.map(c => c.provider), brief);
  return { raw, requester: raw.requester, reason: raw.reason, held, lane, placement, repo, head, base, brief, builders, priority, choices, project, packet, contract, identity };
}

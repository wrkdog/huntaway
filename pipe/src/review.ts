/** Durable read-only review seats and receipts; this service never merges. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { reuse, type AdmissionMetadata, type CapacityOptions, type Reuse } from './admission.ts';
import { reviewAdmission, ReviewError } from './admission-review.ts';
export { ReviewError } from './admission-review.ts';
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { makeWorktreeRoot } from './worktree-roots.ts';
import { join, resolve } from 'node:path';
import type { Policy, Provider } from './policy.ts';
import { Store, type NewRequest, type Priority } from './store.ts';
import { runGit } from './disk.ts';
import { setupKind } from './runner.ts';
import { reviewSetupFailed } from './telemetry.ts';
import { geminiPrompt, geminiFolder, startGemini, geminiConfig } from './agy.ts';
import { withPacket, type Projects, type ProjectText } from './projects.ts';

export const REVIEW_WORKTREE_ADD_TIMEOUT_MS = 120_000;
const reviewTimeout = new AsyncLocalStorage<number>();
const reviewLimit = () => reviewTimeout.getStore() ?? 120_000;
type ReviewOptions = CapacityOptions & { reviewGitTimeoutMs?: number; worktreeAddTimeoutMs?: number; projects?: Projects; canAdmit?: () => boolean };
function withReviewLimit<T>(options: { reviewGitTimeoutMs?: number }, fn: () => T): T {
  const timeout = options.reviewGitTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError('reviewGitTimeoutMs must be positive whole milliseconds');
  return reviewTimeout.run(timeout, fn);
}

export function canaryOf(response: string, token: string): 'ok' | 'missing' | 'wrong' | 'not_visible' {
  const echoes = [...response.matchAll(/^[\s>*_`]*INPUT-END-CANARY:[*_]*\s*`?([^`\r\n]*?)`?[\s>*_]*$/gm)].map(m => m[1]!.trim());
  return echoes.includes(token) ? 'ok' : echoes.includes('NOT VISIBLE') ? 'not_visible' : echoes.length ? 'wrong' : 'missing';
}

export function modelLabels(log: string): string[] {
  return [...new Set(log.split('\n').flatMap(line => {
    const match = /^[IWEF]\d{4} \d\d:\d\d:\d\d\.\d{6}[ \t]+\d+ model_config_manager\.go:\d+\] Propagating selected model override to backend: label="([^"\r\n\u2028\u2029]*)"$/.exec(line);
    return match && match[0] === line ? [match[1]!] : [];
  }))];
}

const FAMILY = /^[a-z][a-z0-9-]{1,31}$/;
const VERDICTS = ['APPROVE', 'REVISE', 'REJECT'];
const REQUIRED_FAMILIES = ['openai', 'anthropic'];
/**
 * Gemini review seats are advice only: exact configured ids join Gemini 3.8, and Google never satisfies REQUIRED_FAMILIES.
 * The approved review models (Sol 6.1 replaces the retired Sol 6.0): Claude
 * Opus 5.5 or Fable 5.1, Sol 6.1 or Astra, and Gemini 3.8. An explicit list: a model joins or leaves by a policy
 * change, never by parsing its name. The aliases name the current model. A full id (not an alias) may carry its
 * family's own date form (Anthropic -20260601, OpenAI -2026-09-01), and any Anthropic model Claude Code's context tag
 * [1m]. Gemini 3.8 is Pro or Flash, perhaps with a thinking level. A variant such as -mini or -lite is another model.
 */
const MONTH = '(?:0[1-9]|1[0-2])', DAY = '(?:0[1-9]|[12]\\d|3[01])';
const REVIEW_MODELS = new Map([
  ['anthropic', new RegExp(`^(?:opus|fable|claude-(?:opus-5-5|fable-5-1)(?:-\\d{4}${MONTH}${DAY})?)(?:\\[1m\\])?$`, 'i')],
  ['openai', new RegExp(`^(?:gpt-6\\.1-sol|gpt-6-astra)(?:-\\d{4}-${MONTH}-${DAY})?$`, 'i')],
  ['google', /^gemini-3\.8-(?:pro|flash)(?:-(?:low|medium|high))?$/i]]);
export function approvedReviewModel(family: string, model: string, approvedGeminiModels: readonly string[] = []): boolean {
  return (family === 'google' && approvedGeminiModels.includes(model)) || (REVIEW_MODELS.get(family)?.test(model) ?? false);
}
/** The model that cast a vote: the one it reported, or the one requested when it reported none. */
const voteModel = (v: { requestedModel?: string; reportedModel?: string }) =>
  v.reportedModel && v.reportedModel !== 'unknown' ? v.reportedModel : v.requestedModel ?? '';
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const hash = (v: string): string => createHash('sha256').update(v).digest('hex');
function isoZoned(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]! &&
    hour! < 24 && minute! < 60 && second! < 60;
}

function refuse(message: string): never { throw new ReviewError(message); }

type Builder = { family: string; context: string };
type RequestedSeat = { provider: Provider; model: string; effort: string };
type CapacitySetup = { requester: string; reason: string; brief: string; priority: Priority;
  packet?: ProjectText; contract?: ProjectText; inlinePacket: boolean; evidenceVersion?: string; policyVersion?: string };
export type Seat = { provider: Provider; model: string; effort: string; family: string; requestId: string;
  status: 'waiting' | 'running' | 'voted' | 'advice' | 'failed' | 'invalid'; reason?: string; verdict?: string; setupCancelled?: boolean;
  prompt?: string; token?: string; pid?: number; birth?: string | null; folder?: string;
  supervisor?: { pid: number; birth: string | null };
  conversationId?: string; promptBytes?: number; promptSha256?: string; responseSha256?: string;
  canary?: string; reportedLabel?: string; reportedModel?: string; startedAt?: string; endedAt?: string;
  exitCode?: number; errorKind?: string };
type Vote = { family: string; verdict: string; context: string; requestedModel: string; reportedModel: string;
  observedAt: string; revision: string; briefSha256: string; external?: true };
type Receipt = { kind: 'approval'; repository: string; revision: string; briefSha256: string;
  builders: Builder[]; votes: Vote[]; observations: Array<{ kind: 'advice'; provider: 'gemini'; requestedModel: string;
    reportedModel: string; verdict: string; revision: string; briefSha256: string; observedAt: string }>; quorum: ReturnType<typeof quorum> };
export type Review = { id: string; state: 'running' | 'finished' | 'queued-for-capacity'; createdAt: string; updatedAt: string;
  admissionKey?: string; dispatchClass?: AdmissionMetadata['dispatchClass']; reuse?: Reuse | null;
  predecessorId?: string;
  admissionState?: 'queued-for-capacity' | 'admitted'; finishedAt?: string; requester?: string; capacitySetup?: CapacitySetup;
  repository: string; repo: string; head: string; base?: string; briefSha256: string;
  project?: string; contextPacketSha256?: string; outputContractSha256?: string;
  placement?: NewRequest['placement'];
  lane?: string | null; round?: number | null; setupFailed?: boolean;
  requestedSeats?: RequestedSeat[]; seats: Seat[]; receipt: Receipt; worktree: string; preparing?: true;
  cleanupFailures?: number; cleanup?: string };
const preparing = new Set<string>();
const removing = new Set<string>();
const unreadable = new Set<string>();
/** The last complete JSON object carrying a verdict is authoritative, even when it is invalid. */
export function lastVerdict(text: string, head: string): { verdict: string } | { reason: string } {
  const starts: number[] = [];
  let quoted = false, escaped = false, found: Record<string, unknown> | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (starts.length && quoted) {
      if (char === '\n' || char === '\r') { starts.length = 0; quoted = false; escaped = false; continue; }
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (starts.length && char === '"') { quoted = true; continue; }
    if (char === '{') starts.push(i);
    if (char === '}' && starts.length) {
      const start = starts.pop()!;
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        if (object(value) && Object.hasOwn(value, 'verdict')) found = value;
      } catch { /* prose or malformed JSON is not a vote */ }
    }
  }
  if (!found) return { reason: 'no verdict' };
  if (typeof found.verdict !== 'string' || !VERDICTS.includes(found.verdict)) return { reason: 'unknown verdict' };
  if (typeof found.head !== 'string' || !/^[0-9a-f]{7,}$/i.test(found.head) || !head.toLowerCase().startsWith(found.head.toLowerCase()))
    return { reason: 'another head' };
  return { verdict: found.verdict };
}

/** A family approves only when all of its bound, non-builder-context votes approve. */
export function quorum(votes: Array<{ family: string; verdict: string; context: string; revision: string; briefSha256: string;
  requestedModel?: string; reportedModel?: string }>,
  builders: Builder[], revision: string, briefSha256: string, approvedGeminiModels: readonly string[] = []): {
    approved: boolean; votingFamilies: string[]; approvingFamilies: string[]
  } {
  const byFamily = new Map<string, string[]>();
  const builderContexts = new Set(builders.map((b) => b.context));
  for (const vote of votes) {
    if (vote.revision !== revision || vote.briefSha256 !== briefSha256 || builderContexts.has(vote.context)) continue;
    if (vote.verdict === 'APPROVE' && !approvedReviewModel(vote.family, vote.family === 'google' ? vote.reportedModel ?? '' : voteModel(vote), approvedGeminiModels)) continue;
    byFamily.set(vote.family, [...(byFamily.get(vote.family) ?? []), vote.verdict]);
  }
  const votingFamilies = [...byFamily.keys()].sort();
  const approvingFamilies = votingFamilies.filter((family) => byFamily.get(family)!.every((v) => v === 'APPROVE'));
  const approved = REQUIRED_FAMILIES.every((family) => approvingFamilies.includes(family));
  return { approved, votingFamilies, approvingFamilies };
}

/** Read named objects without checkout conversions. */
const PINNED = ['--no-replace-objects', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.symlinks=true',
  '-c', 'core.sparseCheckout=false'];
const reviewGit = (cwd: string, args: string[], env: Record<string, string | undefined>, input: Buffer | undefined,
  options: Parameters<typeof runGit>[5]) => runGit(cwd, [...PINNED, ...args], env, undefined, input, options);
/** Give each seat a bounded canonical diff. */
const DIFF = ['-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=true', '-c', 'core.attributesFile=/dev/null',
  'diff', '--text', '--no-color', '--no-relative',
  '--ignore-submodules=none', '--submodule=short', '--no-ext-diff', '--no-textconv', '-O/dev/null', '--src-prefix=a/',
  '--dst-prefix=b/', '--unified=3', '--inter-hunk-context=0', '--no-renames', '--diff-algorithm=myers',
  '--no-indent-heuristic', '--full-index'];
/** Remove display-only hunk context without changing hunks. */
const bare = (text: string): string => text.replace(/(^|\n)(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)[^\n]*/g, '$1$2');
const blobId = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Verify every checked-out path against its committed blob. */
async function unfaithful(worktree: string, env: Record<string, string | undefined>): Promise<string | null> {
  const entries = (await reviewGit(worktree, ['ls-files', '-s', '-z'], env, undefined, { timeoutMs: reviewLimit() })).output
    .toString('utf8').split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t'), [mode, id] = line.slice(0, tab).split(' ');
      return { mode: mode!, id: id!, path: line.slice(tab + 1) };
    });
  for (const e of entries.filter((entry) => entry.mode === '120000')) {
    const path = join(worktree, e.path);
    try { if (!lstatSync(path).isSymbolicLink() || blobId(readlinkSync(path, { encoding: 'buffer' })) !== e.id) return e.path; }
    catch { return e.path; }
  }
  const files = entries.filter((e) => e.mode === '100644' || e.mode === '100755');
  const odd = files.find((e) => e.path.includes('\n') || e.path.includes('\r') || e.path.startsWith('"'));
  if (odd) return odd.path;
  if (files.length === 0) return null;
  let ids: string[];
  try {
    ids = (await reviewGit(worktree, ['hash-object', '--no-filters', '--stdin-paths'], env,
      Buffer.from(files.map((e) => `${e.path}\n`).join('')), { timeoutMs: 120_000 })).output.toString('utf8').trim().split('\n');
  } catch { return 'a file git could not read'; }
  return files.find((e, i) => ids[i] !== e.id)?.path ?? null;
}
/** Clears `preparing` on the stored review in one step, keeping what was saved meanwhile (an external vote). */
function prepared(store: Store, id: string): void {
  const latest = stored(store, id)!;
  delete latest.preparing;
  store.updateReview(id, 'running', latest);
}
function git(repo: string, args: string[], env: Record<string, string | undefined>, timeout = reviewLimit(),
  maxBuffer = 1024 * 1024): Promise<{ output: Buffer; cut: boolean }> {
  return reviewGit(repo, args, env, undefined,
    { timeoutMs: timeout, maxOutputBytes: maxBuffer, truncateOutput: true })
    .then(({ output, truncated }) => ({ output, cut: truncated }));
}
const gitText = async (repo: string, args: string[], env: Record<string, string | undefined>, timeout?: number): Promise<string> => {
  const result = await git(repo, args, env, timeout);
  if (result.cut) throw new Error('git output exceeds 1 MiB');
  return result.output.toString('utf8').trim();
};

/** A project's output contract follows the service's schema line, which overrides a contract placed in the brief (u42). */
function seatPrompt(head: string, diff: string, brief: string, briefSha256: string, contract?: ProjectText): string {
  return `Review the exact commit ${head}; the folder you are in is a clean checkout of it.\n` +
    'This is read-only: do not edit, create or delete files, or run anything that changes state.\n' +
    diff +
    `Brief SHA-256: ${briefSha256}\n` +
    `BEGIN BRIEF\n${brief}\nEND BRIEF\n` +
    'Answer with exactly one JSON object and nothing after it:\n' +
    '{"verdict":"APPROVE | REVISE | REJECT","head":"<the commit you reviewed>","findings":[{"severity":"blocker | major | minor | nit","file":"…","line":1,"summary":"…"}],"unknowns":["…"]}\n' +
    (contract ? `BEGIN OUTPUT CONTRACT, SHA-256 ${contract.sha256}\n${contract.text}\nEND OUTPUT CONTRACT\n` +
      'The output contract\'s keys are ADDITIVE to the minimal {verdict, head, findings, unknowns} object above: return one JSON ' +
      'object with all of them and nothing after it. The service reads only verdict and head; people and later rounds read the rest.\n' : '');
}

function receipt(repository: string, head: string, briefSha256: string, builders: Builder[]): Receipt {
  return { kind: 'approval', repository, revision: head, briefSha256, builders, votes: [], observations: [],
    quorum: quorum([], builders, head, briefSha256) };
}
const view = (review: Review, approvedGeminiModels: readonly string[] = []): Omit<Review, 'worktree' | 'preparing' | 'cleanupFailures' | 'capacitySetup'> => {
  const { worktree: _worktree, preparing: _preparing, cleanupFailures: _failures, capacitySetup: _setup, ...publicReview } = review;
  const r = review.receipt;
  const result = quorum(r.votes, r.builders, r.revision, r.briefSha256, approvedGeminiModels);
  const verdict = result.approved ? 'APPROVE' : r.votes.some(v => v.verdict === 'REJECT') ? 'REJECT' : r.votes.some(v => v.verdict === 'REVISE') ? 'REVISE' : null;
  return { ...publicReview, state: review.admissionState === 'queued-for-capacity' ? 'queued-for-capacity' : review.state,
    lane: review.lane ?? null, round: review.round ?? null, setupFailed: reviewSetupFailed(review), seats: review.seats.map(({ prompt: _prompt, token: _token, birth: _birth, pid: _pid, supervisor: _supervisor,
    ...seat }) => seat), ...(review.admissionKey ? { reuse: review.dispatchClass === 'repeat'
      ? reuse(review.id, verdict, review.createdAt, review.finishedAt, review.state === 'finished' && !reviewSetupFailed(review) &&
        review.seats.length > 0 && review.seats.every(s => s.status === 'voted' || s.status === 'advice')) : null } : {}), receipt: { ...r, quorum: result } };
};
const stored = (store: Store, id: string): Review | undefined => store.review(id) as Review | undefined;

export function submitReview(store: Store, policy: Policy, worktreeRoot: string, input: unknown,
  env: Record<string, string | undefined> = process.env, options: ReviewOptions = {}) {
  return withReviewLimit(options, () => submitReviewInner(store, policy, worktreeRoot, input, env, options));
}

async function submitReviewInner(store: Store, policy: Policy, worktreeRoot: string, input: unknown,
  env: Record<string, string | undefined> = process.env, options: ReviewOptions = {}): Promise<Omit<Review, 'worktree' | 'preparing' | 'cleanupFailures'>> {
  const { raw, requester, reason, held, lane, placement, repo, head, base, brief, builders, priority, choices, project, packet, contract, identity } =
    reviewAdmission(store, policy, input, options, approvedReviewModel);
  let id: string = randomUUID();
  if (!store.hasReviewAdmission(identity)) try {
    if (!statSync(repo).isDirectory() || await gitText(repo, ['rev-parse', '--is-inside-work-tree'], env) !== 'true') refuse('repo is not a git work tree');
    if (await gitText(repo, ['cat-file', '-t', head], env) !== 'commit' ||
      (base && await gitText(repo, ['cat-file', '-t', base], env) !== 'commit'))
      refuse('head and base must name commit objects');
  } catch (e) { if (e instanceof ReviewError) throw e; refuse('repo, head or base is not a commit in this git work tree'); }
  const worktree = join(resolve(worktreeRoot), `review-${id}`);
  const briefSha256 = hash(brief), seats: Seat[] = [];
  const setup: CapacitySetup = { requester, reason, brief, priority, packet, contract,
    inlinePacket: raw.contextPacket !== undefined, evidenceVersion: raw.evidenceVersion as string | undefined, policyVersion: raw.policyVersion as string | undefined };
  const review = { requester, repository: (raw.repository ?? repo) as string, repo, head, ...(base ? { base } : {}),
    briefSha256, ...(project === undefined ? {} : { project }), ...(packet ? { contextPacketSha256: packet.sha256 } : {}),
    ...(contract ? { outputContractSha256: contract.sha256 } : {}), requestedSeats: choices, seats, setupFailed: false, lane: lane ?? null, ...(placement === undefined ? {} : { placement }),
    receipt: receipt((raw.repository ?? repo) as string, head, briefSha256, builders), worktree, preparing: true as const,
    ...(held ? { capacitySetup: setup } : {}) };
  const admitted = store.admitReview(id, review, identity, held, options.canAdmit);
  id = admitted.id;
  const original = stored(store, id)!;
  const response = () => {
    const current = stored(store, id)!;
    return view(admitted.repeated ? { ...current, dispatchClass: 'repeat', placement } : current, geminiConfig(store)?.approvedModels);
  };
  if (!admitted.prepare) return response();
  await prepareReview(store, original, setup, env, options.worktreeAddTimeoutMs);
  return response();
}

async function prepareReview(store: Store, original: Review, setup: CapacitySetup,
  env: Record<string, string | undefined>, timeoutMs = REVIEW_WORKTREE_ADD_TIMEOUT_MS): Promise<void> {
  const { id, repo, head, base, briefSha256, worktree, project } = original, choices = original.requestedSeats ?? [], seats: Seat[] = [];
  const { requester, brief, priority, packet, contract, inlinePacket } = setup, reason = `review ${id}: ${setup.reason}`;
  preparing.add(id);
  let addingWorktree = true;
  try {
    try { await makeWorktreeRoot(resolve(worktree, '..')); }
    catch (e) { throw new Error(`could not use the worktreeRoot ${resolve(worktree, '..')}: ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
    await gitText(repo, ['worktree', 'add', '--no-checkout', '--detach', worktree, head], env, timeoutMs);
    addingWorktree = false;
    if (realpathSync.native(await gitText(worktree, ['rev-parse', '--show-toplevel'], env)) !== realpathSync.native(worktree)) {
      await gitText(repo, ['worktree', 'remove', '--force', worktree], env);
      refuse('the repository sets its own work tree (core.worktree), so a review cannot have a checkout of its own');
    }
    await gitText(worktree, ['read-tree', 'HEAD'], env);
    const paths = (await reviewGit(worktree, ['ls-files', '-z'], env, undefined, { timeoutMs: reviewLimit() })).output;
    const attrs = (await reviewGit(worktree, ['check-attr', '--cached', '-z', '--stdin', 'filter'], env, paths,
      { timeoutMs: reviewLimit() })).output.toString('latin1').split('\0');
    const count = paths.toString('latin1').split('\0').length - 1;
    if (attrs.length !== count * 3 + 1) refuse('git returned incomplete filter attributes');
    const filtered = attrs.findIndex((value, index) => index % 3 === 2 && value !== 'unspecified' && value !== 'unset');
    if (filtered >= 0) {
      const path = attrs[filtered - 2];
      await gitText(repo, ['worktree', 'remove', '--force', worktree], env);
      refuse(`review worktree has a filter on ${path}`);
    }
    await gitText(worktree, ['checkout-index', '-a', '-f'], env);
    const changed = await unfaithful(worktree, env);
    if (changed) refuse(`review worktree does not hold the commit's own bytes at ${changed} (a line-ending, ident or encoding attribute, or an unreadable file)`);
    if (await gitText(worktree, ['rev-parse', 'HEAD'], env) !== head || await gitText(worktree, ['status', '--porcelain'], env) !== '')
      refuse('review worktree is not clean at the exact head');
    let diff = '', geminiDiff = '';
    if (base) {
      const raw = await git(worktree, [...DIFF, `${base}..${head}`], env, reviewLimit(), 4 * 1024 * 1024);
      const text = Buffer.from(bare(raw.output.toString('utf8')));
      diff = `BEGIN DIFF ${base}..${head}\n${text.subarray(0, 200 * 1024).toString('utf8')}\n`;
      if (raw.cut || text.length > 200 * 1024) {
        diff += 'DIFF CUT AFTER 200 KiB; changed files:\n';
        diff += `${await gitText(worktree, [...DIFF.filter((arg) => arg !== '--unified=3'), '--stat=200,160', '--stat-graph-width=40', `${base}..${head}`], env)}\n`;
      }
      diff += 'END DIFF\n';
      if (choices.some((choice) => choice.provider === 'gemini')) {
        const full = await git(worktree, [...DIFF, `${base}..${head}`], env, reviewLimit(), 2 * 1024 * 1024);
        geminiDiff = `BEGIN DIFF ${base}..${head}\n${bare(full.output.toString('utf8'))}\nEND DIFF\n`;
        if (full.cut) geminiDiff += 'DIFF EXCEEDS PROMPT LIMIT\n';
      }
    }
    prepared(store, id);
    for (const choice of choices) {
      if (choice.provider === 'gemini') {
        const { text, token } = geminiPrompt(head, brief, briefSha256, geminiDiff);
        const seat: Seat = { ...choice, family: 'google', requestId: `gemini-${randomUUID()}`,
          status: 'waiting', setupCancelled: false, prompt: text, token,
          folder: join(geminiFolder(store), randomUUID()) };
        const latest = stored(store, id)!;
        latest.seats.push(seat);
        store.updateReview(id, 'running', latest);
        seats.push(seat);
        continue;
      }
      const family = choice.provider === 'claude' ? 'anthropic' : 'openai';
      const request = store.submitReviewSeat(id, { requester, project: 'review', kind: 'code', mutating: false,
        cwd: worktree, provider: choice.provider, model: choice.model, effort: choice.effort, reason,
        prompt: packet ? withPacket(seatPrompt(head, diff, brief, briefSha256, contract), project ?? 'this review', packet, inlinePacket ? '' : brief) : seatPrompt(head, diff, brief, briefSha256, contract),
        priority, ...(packet ? { contextPacketSha256: packet.sha256 } : {}),
        repository: original.repository, head, ...(base ? { base } : {}),
        evidenceVersion: setup.evidenceVersion ?? 'unversioned', policyVersion: setup.policyVersion ?? 'unversioned',
        ...(original.placement === undefined ? {} : { placement: original.placement }) }, { ...choice, family, setupCancelled: false });
      seats.push({ ...choice, family, requestId: request.id, status: 'waiting' });
    }
  } catch (e) {
    for (const seat of seats) if (seat.provider !== 'gemini') store.cancel(seat.requestId, 'review submission failed');
    const failed = stored(store, id)!; failed.setupFailed = true;
    for (const seat of failed.seats) {
      seat.setupCancelled = true;
      if (seat.provider === 'gemini') { seat.status = 'failed'; seat.reason = 'review submission failed'; delete seat.prompt; delete seat.token; }
    }
    store.updateReview(id, 'running', failed);
    prepared(store, id);
    if (addingWorktree && setupKind(e instanceof Error ? e.message : String(e)) === 'setup_timeout') {
      throw Object.assign(new Error('review setup timed out; the review was not started'), { status: 503, code: 'setup_timeout' });
    }
    throw e;
  } finally {
    preparing.delete(id);
  }
}

export function refreshReviews(store: Store, log: (where: string, error: unknown) => void,
  env: Record<string, string | undefined> = process.env, options: CapacityOptions & { reviewGitTimeoutMs?: number } = {}): void {
  withReviewLimit(options, () => refreshReviewsInner(store, log, env, options));
}

function refreshReviewsInner(store: Store, log: (where: string, error: unknown) => void,
  env: Record<string, string | undefined> = process.env, options: CapacityOptions = {}): void {
  for (const id of store.runningReviewIds()) {
    if (preparing.has(id) || removing.has(id)) continue;
    try {
      const review = stored(store, id)!;
      if (review.admissionState === 'queued-for-capacity') {
        if (!options.E6_CAPACITY_HOOK && review.capacitySetup && store.releaseReview(id))
          void prepareReview(store, stored(store, id)!, review.capacitySetup, env).catch(e => log(`release review ${id}`, e));
      } else refreshReview(store, review, log, env);
    }
    catch (e) { if (!unreadable.has(id)) log(`refresh review ${id}`, e); unreadable.add(id); }
  }
}

function refreshReview(store: Store, review: Review, log: (where: string, error: unknown) => void,
  env: Record<string, string | undefined>): void {
  let changed = false, waiting = false;
  const submitted = [...review.seats];
  for (const choice of review.requestedSeats ?? []) {
    const index = submitted.findIndex((seat) => seat.provider === choice.provider && seat.model === choice.model && seat.effort === choice.effort);
    if (index >= 0) submitted.splice(index, 1);
    else {
      review.setupFailed = true;
      review.seats.push({ ...choice, family: choice.provider === 'claude' ? 'anthropic' : choice.provider === 'gemini' ? 'google' : 'openai', requestId: '',
        status: 'failed', setupCancelled: true, reason: 'never submitted: the review\'s setup did not finish (the service stopped, or the submission failed)' });
      changed = true;
    }
  }
  for (const seat of review.seats) {
    if (seat.status !== 'waiting') continue;
    if (seat.provider === 'gemini') {
      startGemini(store, review, seat, log);
      waiting = true;
      continue;
    }
    const request = store.get(seat.requestId);
    if (!request) { seat.status = 'failed'; seat.reason = 'request record is missing'; changed = true; continue; }
    if (request.state === 'queued' || request.state === 'running' || store.attempts(seat.requestId).some((a) => a.endedAt === null)) {
      waiting = true; continue;
    }
    changed = true;
    if (request.state !== 'completed') {
      seat.status = 'failed'; seat.reason = request.error?.message ?? `request ${request.state}`;
      continue;
    }
    const answer = lastVerdict(request.result ?? '', review.head);
    if ('reason' in answer) { seat.status = 'invalid'; seat.reason = answer.reason; continue; }
    const attempt = store.attempts(seat.requestId).findLast((a) => a.outcome?.kind === 'completed');
    const reportedModel = attempt?.reportedModel ?? 'unknown';
    if (answer.verdict === 'APPROVE' && !approvedReviewModel(seat.family, voteModel({ requestedModel: seat.model, reportedModel }), geminiConfig(store)?.approvedModels)) {
      seat.status = 'invalid'; seat.reason = `${voteModel({ requestedModel: seat.model, reportedModel })} is not an approved review model`; continue;
    }
    seat.status = 'voted'; seat.verdict = answer.verdict;
    review.receipt.votes.push({ context: `pipe-request-${seat.requestId}`, family: seat.family, verdict: answer.verdict,
      observedAt: request.updatedAt, requestedModel: seat.model, reportedModel, revision: review.head, briefSha256: review.briefSha256 });
  }
  const latest = stored(store, review.id)!;
  review.seats = review.seats.map((seat) => seat.provider === 'gemini'
    ? latest.seats.find((s) => s.requestId === seat.requestId) ?? seat : seat);
  review.receipt.observations = latest.receipt.observations;
  if (review.seats.some((seat) => seat.provider === 'gemini' && seat.status === 'running')) waiting = true;
  review.receipt.quorum = quorum(review.receipt.votes, review.receipt.builders, review.head, review.briefSha256, geminiConfig(store)?.approvedModels);
  if (changed) store.updateReview(review.id, 'running', review);
  if (!waiting) {
    removing.add(review.id);
    void (async () => {
      let removalError: unknown;
      try {
        if (existsSync(review.worktree)) await gitText(review.repo, ['worktree', 'remove', '--force', review.worktree], env);
      } catch (e) { removalError = e; }
      try {
        const latest = stored(store, review.id)!;
        if (removalError === undefined) {
          latest.state = 'finished';
          delete latest.cleanupFailures;
          delete latest.preparing;
        } else {
          const failures = (latest.cleanupFailures ?? 0) + 1;
          if (failures === 1 || failures === 10) log(`remove review worktree ${review.id}`, removalError);
          latest.cleanupFailures = failures;
          if (failures >= 10) {
            latest.state = 'finished';
            latest.cleanup = `Review worktree could not be removed: ${String(removalError instanceof Error ? removalError.message : removalError).replace(/\s+/g, ' ').slice(0, 240)}`;
            delete latest.cleanupFailures;
            delete latest.preparing;
          }
        }
        store.updateReview(review.id, latest.state, latest);
      } catch (e) { log(`finish review ${review.id}`, e); }
      finally { removing.delete(review.id); }
    })();
  }
}

export function getReview(store: Store, id: string): Omit<Review, 'worktree' | 'preparing' | 'cleanupFailures'> | undefined {
  const review = stored(store, id);
  return review && view(review, geminiConfig(store)?.approvedModels);
}

export function addExternalVote(store: Store, id: string, raw: unknown): Omit<Review, 'worktree' | 'preparing' | 'cleanupFailures'> | undefined {
  const review = stored(store, id);
  if (!review) return undefined;
  if (review.admissionState === 'queued-for-capacity') refuse('review is queued-for-capacity; votes require admission');
  if (!object(raw)) refuse('vote must be an object');
  if (typeof raw.family !== 'string' || !FAMILY.test(raw.family)) refuse('family must be a lowercase id');
  if (typeof raw.verdict !== 'string' || !VERDICTS.includes(raw.verdict)) refuse('unknown verdict');
  if (!filled(raw.context) || review.seats.some((s) => (s.provider === 'gemini' ? `pipe-${s.requestId}` : `pipe-request-${s.requestId}`) === raw.context) ||
    review.receipt.builders.some((b) => b.context === raw.context) ||
    review.receipt.votes.some((v) => v.context === raw.context && v.family !== raw.family))
    refuse('context is empty, belongs to a builder, or is used by another family');
  if (!filled(raw.requestedModel) || !filled(raw.reportedModel)) refuse('models must be non-empty');
  if ((raw.family !== 'google' || raw.verdict === 'APPROVE') && !approvedReviewModel(raw.family, raw.family === 'google' ? raw.reportedModel : voteModel(raw as { requestedModel: string; reportedModel: string }), geminiConfig(store)?.approvedModels))
    refuse('the vote\'s model is not an approved review model (Opus 5.5 or Fable 5.1, Sol 6.1 (gpt-6.1-sol) or Astra, Gemini 3.8)');
  if (!isoZoned(raw.observedAt)) refuse('observedAt must be ISO with a zone');
  if (raw.revision !== review.head) refuse('revision must equal the review head');
  if (raw.briefSha256 !== review.briefSha256) refuse('briefSha256 must equal the review brief hash');
  review.receipt.votes.push({ family: raw.family, verdict: raw.verdict, context: raw.context,
    requestedModel: raw.requestedModel, reportedModel: raw.reportedModel, observedAt: raw.observedAt,
    revision: raw.revision, briefSha256: raw.briefSha256, external: true } as Vote);
  review.receipt.quorum = quorum(review.receipt.votes, review.receipt.builders, review.head, review.briefSha256, geminiConfig(store)?.approvedModels);
  store.updateReview(id, review.state, review);
  return view(stored(store, id)!, geminiConfig(store)?.approvedModels);
}

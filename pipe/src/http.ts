/** Local JSON interface for the pipe. Every response, including errors, is bounded JSON. */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { directory } from './admission-store.ts';
import { geminiReadOnly, checkChoice, type Policy } from './policy.ts';
import { Store, StoreError, type Attempt, type NewRequest, type RequestRecord, validAutomatic } from './store.ts';
import { hasGemini, geminiConfig, geminiChatRefusal, loginRefusal } from './agy.ts';
import { card, health, CARD_SCHEMA, type HealthInput } from './cards.ts';
import { listRequests } from './admission-list.ts';
import { validSince } from './telemetry.ts';
import { configuredProjects, inlineText, projectHint, projectText, withPacket, type Projects } from './projects.ts';
import type { AccountConfig } from './identity.ts';

const LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 8 * LIMIT;
const equal = (a: string, b: string): boolean => {
  const left = createHash('sha256').update(a).digest(), right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
};
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type HttpContext = {
  token: string; policy: Policy; store: Store;
  env?: NodeJS.ProcessEnv;
  log?(where: string, error: unknown): void;
  geminiChatConfigured?(): boolean;
  admitAutomatic?(id: string): void | Promise<void>;
  currentAllowance?(accountId: string, model: string): unknown;
  accounts(): unknown[]; models(): unknown;
  leaseAccount?(id: string): { account: AccountConfig; headroom: number | null } | undefined;
  accountIds(): string[];
  draining(): boolean;
  extraRunning?(): number;
  drain(): Promise<void>;
  drainComplete?(): boolean;
  cancel(id: string): void;
  worktrees?(): Promise<unknown>;
  prune?(): Promise<unknown>;
  resetWorktree?(id: string): Promise<boolean>;
  projects?: Projects;
  reviews?: { submit(input: unknown): Promise<unknown>; get(id: string): unknown | undefined; vote(id: string, input: unknown): unknown | undefined };
  cards?: {
    alias(accountId: string): string | null;
    runnerAlive(attempt: Attempt): boolean | null;
    health(): Omit<HealthInput, 'draining'>;
  };
};

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw Object.assign(new Error('body exceeds 1 MiB'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('body must be JSON'), { status: 400 }); }
}

export async function startHttp(context: HttpContext, port = 0): Promise<{ server: Server; url: string }> {
  const hinted = new Set<string>(), hint = (project: unknown) => { const text = projectHint(context.projects, hinted, project); return text ? { hint: text } : {}; };
  const server = createServer((req, res) => {
    const send = (status: number, data: unknown): void => {
      const answer = JSON.stringify(data).replaceAll(context.token, '[redacted]');
      const over = Buffer.byteLength(answer) > RESPONSE_LIMIT;
      res.writeHead(over ? 413 : status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(over ? '{"error":{"code":"response_too_large","message":"response exceeds 8 MiB"}}' : answer);
    };
    let path = (req.url ?? '/').split('?')[0]!;
    void (async () => {
      if (!equal(req.headers.authorization ?? '', `Bearer ${context.token}`)) { send(401, { error: { code: 'unauthorized', message: 'a valid bearer token is required' } }); return; }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      path = url.pathname;
      if (req.method === 'GET' && path === '/v1/leases') {
        if (!context.store.clockIsCurrent()) { send(503, { error: { code: 'clock_unavailable', message: 'pipe clock is not current' } }); return; }
        send(200, { leases: context.store.activeLeases() }); return;
      }
      const leaseMatch = /^\/v1\/leases\/([^/]+)\/(renew|release)$/.exec(path);
      if (req.method === 'POST' && (path === '/v1/leases' || leaseMatch)) {
        let lease;
        if (leaseMatch?.[2] === 'release') {
          let id: string;
          try { id = decodeURIComponent(leaseMatch[1]!); } catch { send(400, { error: { code: 'invalid_request', message: 'lease id has invalid percent encoding' } }); return; }
          lease = context.store.releaseLease(id);
        } else {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { send(415, { error: { code: 'unsupported_media_type', message: 'send application/json' } }); return; }
          const input = await body(req);
          if (!object(input)) { send(400, { error: { code: 'invalid_request', message: 'lease request must be an object' } }); return; }
          if (leaseMatch) {
            let id: string;
            try { id = decodeURIComponent(leaseMatch[1]!); } catch { send(400, { error: { code: 'invalid_request', message: 'lease id has invalid percent encoding' } }); return; }
            lease = context.store.renewLease(id, input.ttlSeconds, accountId => context.leaseAccount?.(accountId)?.account);
          } else {
            const a = typeof input.account === 'string' ? context.leaseAccount?.(input.account) : undefined;
            if (!a || !a.account.enabled) { send(400, { error: { code: 'invalid_request', message: 'account must be configured and enabled' } }); return; }
            lease = context.store.takeLease(a.account, { holder: input.holder, ttlSeconds: input.ttlSeconds, purpose: input.purpose, headroomAtStart: a.headroom });
          }
        }
        send(lease ? path === '/v1/leases' ? 201 : 200 : 404, lease ? { lease } : { error: { code: 'not_found', message: 'lease not found' } }); return;
      }
      if (req.method === 'GET' && path === '/v1/capabilities') { send(200, { automatic: context.admitAutomatic ? 'pipe-auto-v1' : null, projects: configuredProjects(context.projects) }); return; }
      if (req.method === 'GET' && path === '/v1/stats') {
        const since = url.searchParams.get('since');
        if (!validSince(since)) { send(400, { error: { code: 'bad_request', message: 'since must be a valid YYYY-MM-DD date' } }); return; }
        send(200, context.store.stats(since)); return;
      }
      if (req.method === 'POST' && path === '/v1/drain') {
        const raw = url.searchParams.get('wait');
        const wait = raw === null ? 0 : Number(raw);
        if (!Number.isInteger(wait) || wait < 0 || wait > 30_000) { send(400, { error: { code: 'bad_request', message: 'wait must be whole milliseconds from 0 to 30000' } }); return; }
        const drained = context.drain();
        let timeout: NodeJS.Timeout | undefined;
        const confirmed = await Promise.race([drained.then(() => true), new Promise<false>((resolveWait) => { timeout = setTimeout(() => resolveWait(false), wait); })]);
        clearTimeout(timeout);
        let running = 0;
        try { running = context.store.openAttempts().length + (context.extraRunning?.() ?? 0); }
        catch (e) { if (!confirmed) throw e; running = context.drainComplete?.() ? 0 : 1; }
        send(200, { draining: true, drained: confirmed && running === 0 && (context.drainComplete?.() ?? true), running });
        return;
      }
      if (req.method === 'POST' && path === '/v1/requests') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { send(415, { error: { code: 'unsupported_media_type', message: 'send application/json' } }); return; }
        const input = await body(req);
        if (!object(input)) { send(400, { error: { code: 'invalid_request', message: 'request must be an object' } }); return; }
        if (input.idempotencyKey === undefined && input.evidenceVersion === undefined && input.policyVersion === undefined && typeof input.cwd === 'string' && !directory(input.cwd)) {
          send(400, { error: { code: 'invalid_request', message: 'cwd must be an existing directory' } }); return;
        }
        if (input.provider === 'gemini') {
          if (!geminiReadOnly(input)) { send(400, { error: { code: 'invalid_request', message: 'Gemini runs chat jobs and review seats; Gemini code jobs are not enabled' } }); return; }
          if (!hasGemini(context.store) || context.geminiChatConfigured?.() === false) { send(400, { error: { code: 'invalid_request', message: 'Gemini is not configured' } }); return; }
          const refusal = geminiChatRefusal(input, context.accounts()) ?? (typeof input.prompt === 'string'
            ? await loginRefusal(input.prompt, geminiConfig(context.store)!.loginHashesFile) : null);
          if (refusal) { send(400, { error: { code: 'invalid_request', message: refusal } }); return; }
        }
        if (['model', 'effort', 'reason'].some((key) => input[key] !== undefined && typeof input[key] !== 'string')) {
          send(400, { error: { code: 'invalid_request', message: 'model, effort and reason must be strings' } }); return;
        }
        if (!validAutomatic(input) || input.automatic !== undefined && !context.admitAutomatic) { send(400, { error: { code: 'invalid_request', message: 'automatic route unsupported or invalid' } }); return; }
        if (input.automatic !== undefined) { const fallback = checkChoice(context.policy, (input as NewRequest).automatic!.fallback); if (!fallback.ok) { send(400, { error: fallback }); return; } }
        const choice = checkChoice(context.policy, input as { provider: string; model?: string; effort?: string; reason?: string });
        if (!choice.ok) { send(400, { error: { code: choice.code, message: choice.message, options: choice.options } }); return; }
        if (input.exclude !== undefined) {
          if (!Array.isArray(input.exclude) || !input.exclude.every((id) => typeof id === 'string' && id.trim() !== '')) {
            send(400, { error: { code: 'invalid_request', message: 'exclude must be a list of account ids' } }); return;
          }
          const known = new Set(context.accountIds());
          const unknown = input.exclude.find((id: string) => !known.has(id));
          if (unknown !== undefined) { send(400, { error: { code: 'invalid_request', message: `unknown account id in exclude: ${unknown}` } }); return; }
        }
        if (Object.hasOwn(input, 'contextPacketSha256')) { send(400, { error: { code: 'invalid_request', message: 'contextPacketSha256 is set by the service' } }); return; }
        if (input.outputContract !== undefined) { send(400, { error: { code: 'invalid_request', message: 'outputContract applies to reviews; jobs take contextPacket' } }); return; }
        const given = inlineText(input.contextPacket);   // per-call text replaces the project's file for this request only
        if (input.contextPacket !== undefined && (!given || input.mutating !== true)) { send(400, { error: { code: 'invalid_request', message: given ? 'contextPacket applies to changing jobs and reviews' : 'contextPacket must be non-empty text of at most 262144 UTF-8 bytes (well-formed Unicode)' } }); return; }
        const project = input.project ?? 'default', packet = input.mutating === true && typeof project === 'string' && typeof input.prompt === 'string' && input.prompt.trim() !== '' ? given ?? projectText(context.projects, project, 'contextPacket') : undefined;   // a blank prompt stays refused
        if (packet && 'error' in packet) { send(400, { error: { code: 'invalid_request', message: packet.error } }); return; }
        const brief = input.prompt;
        if (packet) Object.assign(input, { prompt: withPacket(input.prompt as string, project as string, packet, given ? '' : input.prompt as string), contextPacketSha256: packet.sha256 });
        try {
          const submitted = await context.store.submitChecked({ priority: 'interactive', requester: 'local', project: 'default', ...input } as NewRequest, context.env, brief as string);
          if (submitted.automatic && !submitted.reuse) await context.admitAutomatic!(submitted.id);
          const { id, state, seq, createdAt } = context.store.get(submitted.id)!;
          send(201, { request: { id, state, seq, createdAt, admissionKey: submitted.admissionKey, dispatchClass: submitted.dispatchClass, predecessorId: submitted.predecessorId ?? null, reuse: submitted.reuse }, ...(input.mutating === true && !given ? hint(project) : {}) });
        }
        catch (e) { if (e instanceof StoreError) send(400, { error: { code: 'invalid_request', message: e.message } }); else throw e; }
        return;
      }
      if (req.method === 'POST' && path === '/v1/reviews' && context.reviews) {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { send(415, { error: { code: 'unsupported_media_type', message: 'send application/json' } }); return; }
        const input = await body(req), review = await context.reviews.submit(input);
        const native = object(input) && Array.isArray(input.seats) && input.seats.some((seat) => object(seat) && seat.provider !== 'gemini');
        send(201, { review, ...(native && input.contextPacket === undefined && input.outputContract === undefined ? hint(input.project) : {}) }); return;
      }
      const reviewMatch = /^\/v1\/reviews\/([^/]+)(\/votes)?$/.exec(path);
      if (reviewMatch && context.reviews) {
        let id: string;
        try { id = decodeURIComponent(reviewMatch[1]!); }
        catch { send(400, { error: { code: 'bad_request', message: 'review id has invalid percent encoding' } }); return; }
        if (req.method === 'GET' && !reviewMatch[2]) {
          const review = context.reviews.get(id);
          send(review ? 200 : 404, review ? { review } : { error: { code: 'not_found', message: 'review not found' } }); return;
        }
        if (req.method === 'POST' && reviewMatch[2]) {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { send(415, { error: { code: 'unsupported_media_type', message: 'send application/json' } }); return; }
          const review = context.reviews.vote(id, await body(req));
          send(review ? 200 : 404, review ? { review } : { error: { code: 'not_found', message: 'review not found' } }); return;
        }
      }
      if (req.method === 'GET' && path === '/v1/requests') {
        const state = url.searchParams.get('state'), requester = url.searchParams.get('requester');
        send(200, { requests: listRequests(context.store, state, requester) }); return;
      }
      if (req.method === 'GET' && path === '/v1/accounts') { send(200, { accounts: context.accounts(), draining: context.draining() }); return; }
      if (req.method === 'GET' && path === '/v1/models') { send(200, { models: context.models() }); return; }
      if (req.method === 'GET' && path === '/v1/worktrees' && context.worktrees) { send(200, await context.worktrees()); return; }
      const reset = /^\/v1\/worktrees\/([^/]+)\/reset$/.exec(path);
      if (req.method === 'POST' && reset && context.resetWorktree) { const ok = await context.resetWorktree(decodeURIComponent(reset[1]!)); send(ok ? 200 : 404, { reset: ok }); return; }
      if (req.method === 'POST' && path === '/v1/worktrees/prune' && context.prune) { send(200, await context.prune()); return; }
      const cards = context.cards;
      if (cards && req.method === 'GET' && (path === '/v1/health' || path === '/v1/cards' || path.startsWith('/v1/cards/'))) {
        const now = new Date().toISOString(), draining = context.draining(), clockCurrent = context.store.clockIsCurrent();
        const toCard = (r: RequestRecord) => card(r, context.store.attempts(r.id), { alias: cards.alias, runnerAlive: cards.runnerAlive, draining });
        const bad = (message: string) => send(400, { error: { code: 'invalid_request', message } });
        if (path === '/v1/health') { send(200, { schema: CARD_SCHEMA, now, ...health({ ...cards.health(), draining }) }); return; }
        if (path === '/v1/cards') {
          const q = url.searchParams, keys = [...q.keys()];
          if (keys.length !== new Set(keys).size) { bad('each query parameter may be given once'); return; }
          if (keys.length === 1 && q.get('open') === 'true') {
            send(200, { schema: CARD_SCHEMA, now, clockCurrent, cards: context.store.openRequests().map(toCard) }); return;
          }
          if (!q.has('after') || !keys.every((k) => k === 'after' || k === 'limit')) { bad('give open=true, or after (a change number, 0 to start) with an optional limit'); return; }
          const after = q.get('after')!, limit = q.get('limit') ?? '100';
          if (!/^(?:0|[1-9][0-9]{0,14})$/.test(after)) { bad('after must be a whole number'); return; }
          if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 500) { bad('limit must be a whole number from 1 to 500'); return; }
          const page = context.store.changedAfter(Number(after), Number(limit));
          send(200, { schema: CARD_SCHEMA, now, clockCurrent, cards: page.requests.map(toCard), next: page.next }); return;
        }
        let id: string;
        try { id = decodeURIComponent(path.slice('/v1/cards/'.length)); } catch { bad('request id has invalid percent encoding'); return; }
        const request = id.includes('/') ? undefined : context.store.get(id);
        send(request ? 200 : 404, request ? { schema: CARD_SCHEMA, now, clockCurrent, card: toCard(request) } : { error: { code: 'not_found', message: 'request not found' } }); return;
      }
      const match = /^\/v1\/requests\/([^/]+)(\/cancel|\/status)?$/.exec(path);
      if (match) {
        let id: string;
        try { id = decodeURIComponent(match[1]!); }
        catch { send(400, { error: { code: 'invalid_request', message: 'request id has invalid percent encoding' } }); return; }
        if (req.method === 'GET' && match[2] === '/status') { const status = context.store.requestStatus(id); send(status ? 200 : 404, status ? { status } : { error: { code: 'not_found', message: 'request not found' } }); return; }
        if (req.method === 'GET' && !match[2]) { const request = context.store.get(id); send(request ? 200 : 404, request ? request.automatic ? (() => { const full = context.store.requestStatus(id, true)!; const { request, ...status } = full; const a = status.selection; return { request, status: { ...status, currentAllowance: a?.requestedModel ? context.currentAllowance?.(a.accountId, a.requestedModel) ?? null : null } }; })() : { request } : { error: { code: 'not_found', message: 'request not found' } }); return; }
        if (req.method === 'POST' && match[2] === '/cancel') {
          const request = context.store.get(id);
          if (!request) { send(404, { error: { code: 'not_found', message: 'request not found' } }); return; }
          const input = req.headers['content-length'] === '0' || !req.headers['content-length'] && !req.headers['transfer-encoding'] ? {} : await body(req);
          if (!object(input) || (input.by !== undefined && (typeof input.by !== 'string' || !input.by.trim()))) {
            send(400, { error: { code: 'invalid_request', message: 'by must be a non-empty name when given' } }); return;
          }
          if (context.store.cancel(id, 'cancelled by requester', input.by as string | undefined)) context.cancel(id);
          send(200, { request: context.store.get(id) }); return;
        }
      }
      send(404, { error: { code: 'not_found', message: 'route not found' } });
    })().catch((e: unknown) => {
      const error = object(e) ? e : {};
      const status = typeof error.status === 'number' ? error.status : error.name === 'ReviewError' ? 400 : 500;
      if (status === 500) {
        context.log?.(`http ${req.method} ${path}`, e);
        send(500, { error: { code: 'internal_error', message: 'request could not be handled' } });
      } else send(status, { error: { code: typeof error.code === 'string' && typeof error.status === 'number' ? error.code : 'bad_request', message: error.message } });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP did not bind a TCP port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

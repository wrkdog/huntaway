// u29 executor host (A-D): tests first; no implementation or git writes.
// Lesson/rule 3: two-machine evidence needs the executor on the record. A service's current alias cannot
// reconstruct an older executor. Evidence: the claim and read allowlists currently discard dispatch.host.
// Unknown is null (rules 6, 48); aliases are ASCII labels, never inferred hostnames. Invalid config stays usable.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { card } from '../src/cards.ts';
import { startHttp } from '../src/http.ts';
import { submitReview } from '../src/review.ts';
import { startPipe, type PipeConfig } from '../src/service.ts';
import { Store, type DispatchEvidence, type NewRequest } from '../src/store.ts';

const NOW = new Date('2026-10-11T12:00:00.000Z'), TOKEN = 'u29-token-'.repeat(4);
const SECRET = 'PRIVATE_PROMPT_RESULT_PATH_FINGERPRINT_U29';
const POLICY = { claude: { models: { opus: 'default' as const }, efforts: ['high'] } };
const ACCOUNT = { id: 'claude-one', provider: 'claude' as const, enabled: true, loginDir: '/' + SECRET,
  fingerprint: SECRET, maxConcurrency: 1 };
const request = (extra: Partial<NewRequest> = {}): NewRequest => ({ requester: 'alice', project: 'pipe', kind: 'chat',
  provider: 'claude', model: 'opus', effort: 'high', reason: SECRET, prompt: SECRET, mutating: false,
  priority: 'interactive', ...extra });
const evidence = (host?: unknown): DispatchEvidence => ({ accountId: ACCOUNT.id, model: 'opus', observedAt: NOW.toISOString(),
  verdict: { state: 'available', headroom: .5 }, grant: ['Read'], ...(host === undefined ? {} : { host }) } as DispatchEvidence);
const options = { alias: () => 'Claude One', runnerAlive: () => null, draining: false };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u29-')), path = join(root, 'record.sqlite');
  const store = new Store(path, { now: () => NOW });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, store };
}
function claim(store: Store, host?: unknown) {
  const r = store.submit(request()), a = store.startAttempt(r.id, ACCOUNT, evidence(host));
  assert.ok(a.ok, 'control: a fresh, account-bound claim succeeds before checking the missing host');
  return { r, a: a.attempt };
}
function rewriteHost(path: string, id: string, host?: unknown) {
  const db = new DatabaseSync(path);
  try {
    const d = JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE id = ?').get(id)!.dispatch));
    delete d.host;
    if (host !== undefined) d.host = host;
    db.prepare('UPDATE attempts SET dispatch = ? WHERE id = ?').run(JSON.stringify(d), id);
    return d;
  } finally { db.close(); }
}

// Actual HTTP handlers with no socket dependency (u28's transport pattern). Builtin exports are restored per test.
function transport(t: TestContext) {
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  const original = http.createServer;
  http.createServer = ((cb: typeof handler) => {
    handler = cb;
    return Object.assign(new EventEmitter(), { listen(_p: number, _h: string, ready: () => void) { ready(); },
      address: () => ({ port: 1 }), close(done: () => void) { done(); }, closeAllConnections() {} });
  }) as typeof http.createServer;
  syncBuiltinESMExports();
  t.after(() => { http.createServer = original; syncBuiltinESMExports(); });
  return async (path: string, body?: unknown): Promise<any> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('HTTP fixture did not answer')), 5000);
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = Object.assign(Readable.from(text === undefined ? [] : [Buffer.from(text)]), {
        url: path, method: text === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${TOKEN}`,
          ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) },
      });
      let status: number;
      handler(req as IncomingMessage, { writeHead(code: number) { status = code; }, end(answer: string) {
        clearTimeout(timeout);
        const parsed = JSON.parse(answer);
        if (status >= 400) reject(new Error(`HTTP ${status}: ${answer}`)); else resolve(parsed);
      } } as unknown as ServerResponse);
    });
  };
}
async function api(t: TestContext) {
  const f = fixture(t), get = transport(t);
  await startHttp({ token: TOKEN, store: f.store, policy: POLICY, accounts: () => [], models: () => ({}),
    accountIds: () => [ACCOUNT.id], draining: () => false, drain: async () => {}, cancel() {},
    cards: { ...options, health: () => ({ startedAt: NOW.toISOString(), clockCurrent: true, accounts: [] }) } });
  return { ...f, get };
}

for (const host of ['A', 'host-02', 'Z' + '9'.repeat(31)]) {
  test(`A claim retains valid dispatch.host ${JSON.stringify(host)} in its JSON evidence`, t => {
    const { store, path } = fixture(t), { a } = claim(store, host);
    const db = new DatabaseSync(path);
    try {
      const raw = JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE id = ?').get(a.id)!.dispatch));
      assert.equal(raw.host, host, 'the claimed executor must be durable, not just attached to a response');
      assert.equal((a.dispatch as any).host, host);
      assert.equal((store.attempts(a.requestId)[0]!.dispatch as any).host, host);
      assert.equal(raw.accountId, ACCOUNT.id); assert.equal(raw.observedAt, NOW.toISOString());
      assert.equal(db.prepare('PRAGMA table_info(attempts)').all().some(c => c.name === 'host'), false,
        'host belongs in existing dispatch JSON; no attempts table migration');
    } finally { db.close(); }
  });
}

test('A the attempt reader preserves a recorded executor after reopening the store', t => {
  const { store, path } = fixture(t), { a } = claim(store);
  rewriteHost(path, a.id, 'host-02');
  const reopened = new Store(path, { now: () => NOW });
  try { assert.equal((reopened.attempts(a.requestId)[0]!.dispatch as any).host, 'host-02'); }
  finally { reopened.close(); }
});

test('A automatic claims retain the executor on their dispatch evidence too', t => {
  const { store, path } = fixture(t), account = { ...ACCOUNT, provider: 'codex' as const, id: 'codex-one' };
  const model = 'gpt-6.1-sol', r = store.submit(request({ provider: 'codex', model, placement: 'ordinary_headroom',
    automatic: { fallback: { provider: 'claude', model: 'opus', effort: 'high', reason: 'authorized fallback' }, reviewReserve: .1 } }));
  const policy = { ...POLICY, codex: { models: { [model]: 'default' as const }, efforts: ['high'] } };
  const started = store.startAutomatic(r.id, [{ account, running: 0, evidence: m => ({ ...evidence('host-02'),
    accountId: account.id, model: m, allowanceObservedAt: NOW.toISOString(), allowanceSource: 'verified' }) }], policy, ['Read']);
  assert.ok(started.ok, 'control: automatic primary has current ordinary room');
  const db = new DatabaseSync(path);
  try { assert.equal(JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE id = ?').get(started.attempt.id)!.dispatch)).host, 'host-02'); }
  finally { db.close(); }
});

test('A cards project each attempt executor, including an ended attempt from another machine', t => {
  const { store } = fixture(t), { r, a } = claim(store);
  const earlier = { ...a, id: 'earlier', dispatch: { ...a.dispatch, host: 'host-01' }, endedAt: NOW.toISOString(),
    outcome: { kind: 'completed' as const, result: SECRET } };
  const current = { ...a, dispatch: { ...a.dispatch, host: 'host-02' } };
  const c = card(store.get(r.id)!, [earlier, current], options);
  assert.deepEqual(c.attempts.map(x => (x as any).host), ['host-01', 'host-02']);
  assert.equal(JSON.stringify(c).includes(SECRET), false, 'executor projection remains content-free');
});

const invalidHosts = ['desk.example', 'two words', 'folder/desk', 'a'.repeat(33), '', '1desk', '-desk', 'desk_',
  ' desk', 'desk ', 'desk\n', 'dèsk', null, 7, {}, []];
for (const host of [undefined, ...invalidHosts]) {
  test(`A card host is null for absent/invalid evidence ${JSON.stringify(host)}`, t => {
    const { store } = fixture(t), { r, a } = claim(store);
    const c = card(store.get(r.id)!, [{ ...a, dispatch: evidence(host) }], options);
    assert.equal((c.attempts[0] as any).host, null, 'unknown has an explicit null; no hostname fallback');
    if (typeof host === 'string' && host) assert.equal(JSON.stringify(c).includes(host), false, 'never echo invalid alias');
  });
}

// No provider calls are needed to prove config -> service.health. The lesson below also proves config -> claim.
const hostCases = [
  ...['host-02', 'A', 'Z' + '9'.repeat(31)].map(hostAlias => ({ hostAlias, expected: hostAlias as string | null })),
  ...[undefined, ...invalidHosts].map(hostAlias => ({ hostAlias, expected: null as string | null })),
];
for (const { hostAlias, expected } of hostCases) {
  test(`A /v1/health service.host validates configured hostAlias ${JSON.stringify(hostAlias)}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pipe-u29-health-')), get = transport(t);
    const pipe = await startPipe({ accounts: [], policy: POLICY, cli: {}, token: TOKEN, storePath: join(root, 'record.sqlite'),
      worktreeRoot: root, diskFree: () => 100 * 1024 ** 3, hostAlias } as PipeConfig);
    try {
      const h = await get('/v1/health');
      assert.equal(h.service.host, expected, 'health exposes only a configured valid alias or null');
      if (expected === null && typeof hostAlias === 'string' && hostAlias) assert.equal(JSON.stringify(h).includes(hostAlias), false);
    } finally { await pipe.stop(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('A legacy attempt with no host stays null when read through GET /v1/cards/<id>', async t => {
  const f = await api(t), { r, a } = claim(f.store);
  rewriteHost(f.path, a.id);
  assert.equal((await f.get(`/v1/cards/${r.id}`)).card.attempts[0].host, null);
});

async function executor(t: TestContext, hostAlias: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'pipe-u29-lesson-')), get = transport(t), cli = join(root, 'claude.cjs');
  writeFileSync(cli, `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === '--version') console.log('2.1.280');
else if (a[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', orgId: 'u29-owner' }));
else if (a[0] === '-p' && a[1] === '/usage') console.log(JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result: 'Current session: 10% used\\nCurrent week (all models): 20% used' }));
else { process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture complete' }))); }
`, { mode: 0o755 });
  const account = { ...ACCOUNT, loginDir: root, fingerprint: createHash('sha256').update('u29-owner').digest('hex').slice(0, 8) };
  const pipe = await startPipe({ accounts: [account], policy: POLICY, cli: { claude: cli }, token: TOKEN,
    storePath: join(root, 'record.sqlite'), worktreeRoot: root, workDir: root, diskFree: () => 100 * 1024 ** 3,
    reachable: async () => true, tickMs: 20, hostAlias } as PipeConfig);
  t.after(async () => { await pipe.stop(); rmSync(root, { recursive: true, force: true }); });
  return { root, get };
}
async function claimedCard(get: Awaited<ReturnType<typeof executor>>['get']) {
  const accepted = await get('/v1/requests', request());
  const end = Date.now() + 10000;
  let c;
  do {
    c = (await get(`/v1/cards/${accepted.request.id}`)).card;
    if (c.attempts.length) break;
    assert.ok(Date.now() < end, 'control: the fixture must reach a real claim before checking executor evidence');
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (true);
  return c;
}

test('two-machine evidence needs the executor on the record (u29)', async t => {
  const { root, get } = await executor(t, 'host-02'), c = await claimedCard(get);
  assert.equal(c.attempts[0].host, 'host-02', 'configured executor must survive service claim, storage and card');
  const db = new DatabaseSync(join(root, 'record.sqlite'));
  try { assert.equal(JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE request_id = ?').get(c.id)!.dispatch)).host, 'host-02'); }
  finally { db.close(); }
});

for (const hostAlias of [undefined, 'desk.example', 'two words', 'folder/desk', 'a'.repeat(33)]) {
  test(`A service claims expose null for absent/invalid hostAlias ${JSON.stringify(hostAlias)}`, async t => {
    const { root, get } = await executor(t, hostAlias), c = await claimedCard(get);
    assert.equal(c.attempts[0].host, null, 'config validation must apply to the recorded executor too');
    if (typeof hostAlias === 'string') assert.equal(JSON.stringify(c).includes(hostAlias), false);
    const db = new DatabaseSync(join(root, 'record.sqlite'));
    try {
      const d = JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE request_id = ?').get(c.id)!.dispatch));
      assert.equal(d.host ?? null, null, 'invalid config cannot become a durable executor alias');
    } finally { db.close(); }
  });
}

const LIST_KEYS = ['id', 'requester', 'state', 'seq', 'createdAt', 'updatedAt', 'accountId'].sort();
test('B CONTROL GET /v1/requests is content-free, newest-first and binds the open account', async t => {
  const f = await api(t), { r } = claim(f.store), queued = f.store.submit(request({ requester: 'requester-b' }));
  const out = await f.get('/v1/requests');
  assert.deepEqual(out.requests.map((x: any) => x.id), [queued.id, r.id]);
  assert.deepEqual(out.requests.map((x: any) => x.accountId), [null, ACCOUNT.id]);
  for (const x of out.requests) assert.deepEqual(Object.keys(x).sort(), LIST_KEYS);
  assert.equal(JSON.stringify(out).includes(SECRET), false);
  assert.deepEqual((await f.get('/v1/requests?state=running')).requests.map((x: any) => x.id), [r.id]);
});

test('B GET /v1/requests filters requester exactly, alone and with state, without query injection', async t => {
  const f = await api(t), alice = f.store.submit(request()), running = claim(f.store).r;
  const special = 'alice &state=running/é';
  const odd = f.store.submit(request({ requester: special }));
  f.store.submit(request({ requester: 'requester-b' })); f.store.submit(request({ requester: 'alice-other' }));
  assert.deepEqual((await f.get('/v1/requests?requester=alice')).requests.map((x: any) => x.id), [running.id, alice.id]);
  assert.deepEqual((await f.get('/v1/requests?state=queued&requester=alice')).requests.map((x: any) => x.id), [alice.id]);
  assert.deepEqual((await f.get(`/v1/requests?requester=${encodeURIComponent(special)}`)).requests.map((x: any) => x.id), [odd.id]);
  assert.deepEqual((await f.get('/v1/requests?requester=missing')).requests, []);
});

test('B CONTROL GET /v1/requests keeps its existing 500-row cap', async t => {
  const f = await api(t);
  for (let i = 0; i < 505; i++) f.store.submit(request());
  const out = await f.get('/v1/requests');
  assert.equal(out.requests.length, 500); assert.equal(out.requests[0].seq, 505); assert.equal(out.requests[499].seq, 6);
});

test('B requester filtering precedes the 500-row cap, so newer foreign rows cannot hide matches', async t => {
  const f = await api(t), first = f.store.submit(request());
  for (let i = 0; i < 501; i++) f.store.submit(request({ requester: 'requester-b' }));
  assert.deepEqual((await f.get('/v1/requests?requester=alice')).requests.map((x: any) => x.id), [first.id]);
});

// CLI/MCP subprocesses receive a fixed body obtained from the real HTTP handler. A card's `now` is per read:
// fixing this transport response tests exact body passthrough without requiring two real reads at the same instant.
function clients(root: string, body: unknown) {
  const preload = join(root, 'client-transport.mjs'), capture = join(root, 'capture.json');
  writeFileSync(preload, `import { writeFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ url: String(url), method: init.method }));
  return new Response(${JSON.stringify(JSON.stringify(body))}, { status: 200, headers: { 'content-type': 'application/json' } });
};\n`);
  const run = (entry: string, args: string[], input?: string) => {
    rmSync(capture, { force: true });
    return spawnSync(process.execPath, ['--import', preload, entry, ...args], { encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root, PIPE_URL: 'http://127.0.0.1:1', PIPE_TOKEN: TOKEN }, input });
  };
  const frame = (method: string, params?: unknown): any => {
    const r = run('src/mcp.ts', [], JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) + '\n');
    assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout); assert.equal(out.id, 7); return out.result;
  };
  return { frame, run, captured: () => JSON.parse(readFileSync(capture, 'utf8')),
    data(name: string, args: unknown) {
      const out = frame('tools/call', { name, arguments: args });
      assert.equal(out.isError, undefined, JSON.stringify(out));
      return JSON.parse(out.content[0].text.split('\n').slice(1).join('\n'));
    } };
}

test('B MCP catalog advertises pipe_list with optional state and requester strings', t => {
  const f = fixture(t), c = clients(f.root, {}), tool = c.frame('tools/list').tools.find((x: any) => x.name === 'pipe_list');
  assert.ok(tool, 'missing MCP pipe_list tool');
  assert.equal(tool.inputSchema.properties.state.type, 'string');
  assert.equal(tool.inputSchema.properties.requester.type, 'string');
  assert.equal((tool.inputSchema.required ?? []).length, 0, 'listing without filters is allowed');
});

const listFilters: Array<Record<string, string>> = [{}, { state: 'running' }, { requester: 'alice &state=failed/é' }, { state: 'queued', requester: 'alice' }];
for (const filters of listFilters) {
  test(`B MCP pipe_list forwards filters and exactly returns GET /v1/requests ${JSON.stringify(filters)}`, async t => {
    const f = await api(t); claim(f.store); f.store.submit(request({ requester: 'requester-b' }));
    const query = new URLSearchParams(filters), expected = await f.get('/v1/requests' + (query.size ? `?${query}` : ''));
    const c = clients(f.root, expected);
    assert.deepEqual(c.data('pipe_list', filters), expected);
    const sent = c.captured(), url = new URL(sent.url);
    assert.equal(sent.method, 'GET'); assert.equal(url.pathname, '/v1/requests');
    assert.deepEqual([...url.searchParams].sort(), [...query].sort());
  });
  test(`B CLI pipe list forwards filters and exactly returns GET /v1/requests ${JSON.stringify(filters)}`, async t => {
    const f = await api(t); claim(f.store); f.store.submit(request({ requester: 'requester-b' }));
    const query = new URLSearchParams(filters), expected = await f.get('/v1/requests' + (query.size ? `?${query}` : ''));
    const c = clients(f.root, expected), args = Object.entries(filters).flatMap(([key, value]) => [`--${key}`, value]);
    const out = c.run('src/cli.ts', ['list', ...args]);
    assert.equal(out.status, 0, `missing pipe list command: ${out.stderr}`);
    assert.deepEqual(JSON.parse(out.stdout), expected);
    const sent = c.captured(), url = new URL(sent.url);
    assert.equal(sent.method, 'GET'); assert.equal(url.pathname, '/v1/requests');
    assert.deepEqual([...url.searchParams].sort(), [...query].sort());
  });
}

test('C CLI pipe card <id> returns the exact HTTP body returned by MCP pipe_card', async t => {
  const f = await api(t), { r } = claim(f.store), expected = await f.get(`/v1/cards/${r.id}`), c = clients(f.root, expected);
  const mcp = c.data('pipe_card', { id: r.id }); assert.deepEqual(mcp, expected, 'control: existing pipe_card passes through the HTTP body');
  const out = c.run('src/cli.ts', ['card', r.id]);
  assert.equal(out.status, 0, `missing pipe card command: ${out.stderr}`);
  assert.deepEqual(JSON.parse(out.stdout), mcp);
  const sent = c.captured(); assert.equal(sent.method, 'GET'); assert.equal(new URL(sent.url).pathname, `/v1/cards/${r.id}`);
});

test('B MCP pipe_list returns all 500 HTTP rows without the generic tool-output truncation', async t => {
  const f = await api(t);
  for (let i = 0; i < 505; i++) f.store.submit(request());
  const expected = await f.get('/v1/requests'), c = clients(f.root, expected);
  assert.equal(expected.requests.length, 500, 'control: HTTP cap');
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 64 * 1024, 'control: this exercises MCP truncation');
  assert.deepEqual(c.data('pipe_list', {}), expected);
  for (const x of expected.requests) assert.deepEqual(Object.keys(x).sort(), LIST_KEYS);
  assert.equal(JSON.stringify(expected).includes(SECRET), false);
});


for (const host of invalidHosts) {
  test(`D Store normalizes malformed host at claim and read: ${JSON.stringify(host)}`, t => {
    const { store, path } = fixture(t), { a } = claim(store, host);
    const db = new DatabaseSync(path);
    try {
      const raw = JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE id = ?').get(a.id)!.dispatch));
      assert.equal(raw.host, null, 'claim normalizes before writing dispatch JSON');
      assert.equal(a.dispatch.host, null);
      assert.equal(store.attempts(a.requestId)[0]!.dispatch.host, null);
      rewriteHost(path, a.id, host);
      const rewritten = JSON.parse(String(db.prepare('SELECT dispatch FROM attempts WHERE id = ?').get(a.id)!.dispatch));
      assert.deepEqual(rewritten.host, host, 'control: the malformed value really is stored');
      assert.equal(store.attempts(a.requestId)[0]!.dispatch.host, null, 'reader normalizes persisted malformed evidence');
    } finally { db.close(); }
  });
}

for (const requester of ['a'.repeat(129), 'é'.repeat(65), '😀'.repeat(33), '--alice', ' --bot']) {
  test(`D requester submission refuses >128 UTF-8 bytes or -- prefix (${JSON.stringify(requester).slice(0, 16)})`, async t => {
    const f = await api(t);
    assert.throws(() => f.store.submit(request({ requester })), /requester.*128.*bytes.*--/);
    await assert.rejects(f.get('/v1/requests', request({ requester })), /HTTP 400.*requester.*128.*bytes.*--/);
    await assert.rejects(submitReview(f.store, POLICY, f.root, { requester, reason: 'r', repo: f.root, head: 'a'.repeat(40), brief: 'b', seats: ['claude:opus:high'] }), /requester.*128.*bytes.*--/);
    assert.equal(f.store.list().length, 0, 'refusal creates no request');
  });
}

for (const requester of ['a'.repeat(128), 'é'.repeat(64), '😀'.repeat(32)]) {
  test(`D requester accepts exactly 128 UTF-8 bytes and filters exactly (${requester[0]})`, async t => {
    const f = await api(t), r = f.store.submit(request({ requester }));
    assert.equal(r.requester, requester);
    assert.deepEqual((await f.get(`/v1/requests?requester=${encodeURIComponent(requester)}`)).requests.map((x: any) => x.id), [r.id]);
  });
}

for (const [args, error] of [
  [['--staet', 'queued'], 'unknown list flag: --staet'],
  [['--state=queued'], 'unknown list flag: --state=queued'],
  [['--requester=alice'], 'unknown list flag: --requester=alice'],
  [['--state', 'queued', '--state', 'failed'], 'repeated list flag: --state'],
  [['--requester', 'alice', '--requester', 'requester-b'], 'repeated list flag: --requester'],
  [['alice'], 'unexpected list argument: alice'],
  [['--state'], '--state needs a value'],
  [['--state', '--requester', 'alice'], '--state needs a value'],
  [['--requester'], '--requester needs a value'],
  [['--requester', '--alice'], '--requester needs a value'],
] as const) {
  test(`D pipe list refuses ambiguous flags: ${args.join(' ')}`, t => {
    const f = fixture(t), c = clients(f.root, { requests: [] }), out = c.run('src/cli.ts', ['list', ...args]);
    assert.equal(out.status, 2);
    assert.equal(out.stderr.split('\n')[0], error);
    assert.equal(out.stdout, '', 'bad flags cannot produce an unfiltered list');
    assert.throws(() => c.captured(), /ENOENT/, 'refusal is before transport');
  });
}

test('D pipe list retains --config alongside exact filters', t => {
  const f = fixture(t), file = join(f.root, 'config.json'), c = clients(f.root, { requests: [] });
  writeFileSync(file, '{}');
  const out = c.run('src/cli.ts', ['list', '--state', 'queued', '--config', file, '--requester', 'alice']);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual([...new URL(c.captured().url).searchParams].sort(), [['requester', 'alice'], ['state', 'queued']]);
});

test('D pipe_list rejects oversized legacy output without returning partial JSON', t => {
  const f = fixture(t), body = { requests: Array.from({ length: 500 }, (_, seq) => ({ seq, requester: 'a'.repeat(2200) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024, 'control: 500 legacy rows can exceed the byte cap');
  const c = clients(f.root, body), out = c.frame('tools/call', { name: 'pipe_list', arguments: {} });
  assert.equal(out.isError, true);
  assert.equal(out.content[0].text, 'pipe_list response exceeds 1 MiB; filter by state or requester');
});

test('D pipe_list retains all 500 rows with maximum-size requesters', async t => {
  const f = await api(t);
  for (let i = 0; i < 500; i++) f.store.submit(request({ requester: 'a' + '\u0001'.repeat(127) }));
  const body = await f.get('/v1/requests');
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024 * 1024);
  assert.deepEqual(clients(f.root, body).data('pipe_list', {}), body);
});


test('D requester admission bound preserves oversized legacy request records', async t => {
  const f = await api(t), r = f.store.submit(request()), requester = 'legacy-' + 'a'.repeat(200);
  const db = new DatabaseSync(f.path);
  try {
    const body = JSON.parse(String(db.prepare('SELECT body FROM requests WHERE id = ?').get(r.id)!.body));
    body.requester = requester;
    db.prepare('UPDATE requests SET requester = ?, body = ? WHERE id = ?').run(requester, JSON.stringify(body), r.id);
  } finally { db.close(); }
  assert.equal(f.store.get(r.id)!.state, 'queued', 'a new admission bound must not fail existing work');
  assert.equal(f.store.get(r.id)!.requester, requester);
  assert.equal((await f.get(`/v1/requests?requester=${encodeURIComponent(requester)}`)).requests[0].id, r.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AllowanceLedger } from '../src/allowance.ts';
import { startPipe } from '../src/service.ts';
import { requestJson } from '../src/client.ts';

test('a new limit observed during a backward clock step survives an older room reading', () => {
  let time = Date.parse('2026-09-24T12:00:00Z');
  const ledger = new AllowanceLedger({ freshnessMs: 60_000, now: () => new Date(time) });
  const room = [{ bucket: 'week', model: null, usedFraction: 0.1, resetsAt: '2026-09-25T12:00:00Z' }];
  ledger.record('a', room);
  time += 10_000;
  ledger.record('a', room);
  time -= 5_000;
  ledger.recordLimit('a', { bucket: 'week', model: null, resetsAt: '2026-09-25T12:00:00Z', observedAt: new Date(time).toISOString() });
  time += 6_000;
  assert.equal(ledger.view('a').state, 'exhausted');
  assert.equal(ledger.limitHolds('a')[0]?.observedAt, '2026-09-24T12:00:10.000Z');
});

test('MCP rejects a multi-megabyte frame before newline and reads the next frame', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (part: string) => { output += part; });
  try {
    child.stdin.write(Buffer.alloc(4 * 1024 * 1024, 120));
    const until = Date.now() + 3000;
    while (!output.includes('\n') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(output.includes('\n'), 'the oversized frame is rejected without waiting for its newline');
    assert.deepEqual(JSON.parse(output.trim()), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request frame exceeds 1 MiB plus framing' } });
    child.stdin.end('\n{"jsonrpc":"2.0","id":8,"method":"initialize"}\n');
    await new Promise<void>((resolve, reject) => child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}`))));
    const frames = output.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(frames.length, 2);
    assert.equal(frames[1].id, 8);
  } finally { child.kill(); }
});

test('drain client polls drain confirmations and reports an unconfirmed shutdown', async () => {
  const { drainClient } = await import('../src/cli.ts') as typeof import('../src/cli.ts') & { drainClient: (url: string, token: string, pollMs: number) => Promise<void> };
  const fetchWas = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    paths.push(`${options?.method}:${path}`);
    if (paths.length === 1) return new Response('{"draining":true,"drained":false,"running":1}');
    throw new TypeError('fetch failed');
  };
  try {
    await assert.rejects(() => drainClient('http://127.0.0.1:8123', 'secret', 0), /serviceGone/);
    assert.deepEqual(paths, ['POST:/v1/drain', 'POST:/v1/drain']);
  } finally { globalThis.fetch = fetchWas; }
});

test('drain client does not call malformed running counts drained', async () => {
  const { drainClient } = await import('../src/cli.ts') as typeof import('../src/cli.ts') & { drainClient: (url: string, token: string, pollMs: number) => Promise<void> };
  const fetchWas = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"draining":true,"drained":true}', { status: 200 });
  try { await assert.rejects(() => drainClient('http://127.0.0.1:8123', 'secret', 0), /running/i); }
  finally { globalThis.fetch = fetchWas; }
});

test('a missing CLI is unavailable from service startup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pipe-fix8-'));
  const pipe = await startPipe({ accounts: [{ id: 'a', provider: 'claude', loginDir: root, fingerprint: 'owner', maxConcurrency: 1, enabled: true }],
    policy: { claude: { models: { opus: 'default' }, efforts: ['high'] } }, storePath: join(root, 'store.sqlite'), worktreeRoot: root,
    cli: {}, env: { PATH: root, HOME: root }, token: 'x'.repeat(32) }).catch((e: Error) => {
    if (/(?:EACCES|EPERM|listen)/.test(e.message)) { t.skip(`loopback bind unavailable: ${e.message}`); return null; }
    throw e;
  });
  if (!pipe) return;
  try {
    const answer = await requestJson(pipe.url, 'x'.repeat(32), 'GET', '/v1/accounts') as { accounts: Array<{ availability: Record<string, { state: string; reason: string }> }> };
    assert.equal(answer.accounts[0]?.availability.opus?.state, 'unavailable');
    assert.match(answer.accounts[0]?.availability.opus?.reason ?? '', /claude CLI.*(found|resolve|configured)/i);
  } finally { await pipe.stop(); }
});

test('CLI resolution uses only the configured PATH and leaves missing commands unresolved', async () => {
  const { resolveCli } = await import('../src/service.ts') as typeof import('../src/service.ts') & { resolveCli: (cli: { claude?: string; codex?: string }, env: Record<string, string | undefined>) => { claude?: string; codex?: string } };
  const empty = mkdtempSync(join(tmpdir(), 'pipe-fix8-path-'));
  assert.equal(resolveCli({}, { PATH: empty }).claude, undefined);
  assert.equal(resolveCli({}, { PATH: empty }).codex, undefined);
});

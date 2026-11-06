/** Lead-owned acceptance tests for this change. The builder must not edit this file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const TOKEN = 'pipe67-test-token';
const prompt = 'P'.repeat(72 * 1024);
const result = 'PIPE67_ANSWER_SURVIVED';
const record = { request: { id: 'pipe67-id', state: 'completed', prompt, result, project: 'router' } };

async function fixture() {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.url, '/v1/requests/pipe67-id');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(record));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const mcp = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url))], {
    env: { ...process.env, PIPE_URL: `http://127.0.0.1:${address.port}`, PIPE_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', (chunk: string) => { output += chunk; });
  const call = async (id: number, name: string, args: Record<string, unknown> = {}) => {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name, arguments: { id: 'pipe67-id', ...args },
    } })}\n`);
    const end = Date.now() + 10_000;
    for (;;) {
      const line = output.split('\n').slice(0, -1).find((item) => item.includes(`"id":${id}`));
      if (line) return JSON.parse(line).result;
      assert.ok(Date.now() < end, `MCP ${name} timed out: ${output.slice(0, 400)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const close = async () => {
    mcp.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { call, close };
}

for (const name of ['pipe_status', 'pipe_wait']) {
  test(`${name} returns a large-prompt job's answer without echoing its prompt`, async () => {
    const f = await fixture();
    try {
      const response = await f.call(1, name, name === 'pipe_wait' ? { timeoutSeconds: 0 } : {});
      assert.equal(response.isError, undefined);
      const text = response.content[0].text as string;
      assert.ok(text.includes(result), 'the answer must survive the 64 KiB MCP ceiling');
      assert.ok(!text.includes(prompt.slice(0, 256)), 'prompt content is not returned by default');
      const payload = JSON.parse(text.slice(text.indexOf('\n') + 1));
      assert.equal(payload.request.id, 'pipe67-id');
      assert.equal(payload.request.prompt, undefined);
      assert.equal(payload.request.promptBytes, Buffer.byteLength(prompt));
      assert.equal(payload.request.promptSha256, createHash('sha256').update(prompt).digest('hex'));
      assert.equal(payload.request.result, result);
    } finally { await f.close(); }
  });
}

test('an explicit includePrompt request remains an opt-in to prompt disclosure', async () => {
  const f = await fixture();
  try {
    const response = await f.call(2, 'pipe_status', { includePrompt: true });
    const text = response.content[0].text as string;
    assert.ok(text.includes(prompt.slice(0, 256)));
  } finally { await f.close(); }
});

test('invalid includePrompt values fail closed rather than disclose the prompt', async () => {
  const f = await fixture();
  try {
    for (const [index, name] of ['pipe_status', 'pipe_wait'].entries()) {
      const response = await f.call(index + 3, name, { includePrompt: 'true' });
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, /includePrompt must be a boolean/u);
      assert.ok(!response.content[0].text.includes(prompt.slice(0, 256)));
    }
  } finally { await f.close(); }
});

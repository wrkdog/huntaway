import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const client of ['mcp', 'cli']) test(`P183 ${client} wait returns start_mismatch after exactly one content-free response`, t => {
  const root = mkdtempSync(join(tmpdir(), 'pipe183-client-')); t.after(() => rmSync(root, { force: true, recursive: true }));
  const preload = join(root, 'fetch.mjs');
  writeFileSync(preload, `let calls = 0; globalThis.fetch = async () => new Response(JSON.stringify(++calls === 1
    ? {request: {id: 'fixture', state: 'start_mismatch', workspace: null}}
    : {error: {message: 'terminal state was polled again'}}), {status: calls === 1 ? 200 : 500});`);
  const config = join(root, 'config.json'), token = join(root, 'token'); writeFileSync(token, 'fixture-token');
  writeFileSync(config, JSON.stringify({ url: 'http://127.0.0.1:1', tokenFile: token }));
  const entry = fileURLToPath(new URL(`../src/${client}.ts`, import.meta.url));
  const frames = [{ id: 1, method: 'tools/list' }, { id: 2, method: 'tools/call', params: { name: 'pipe_wait', arguments: { id: 'fixture' } } }];
  const output = execFileSync(process.execPath, ['--import', preload, entry, ...(client === 'cli' ? ['wait', 'fixture', '--config', config] : [])],
    { env: { PATH: process.env.PATH, HOME: root, PIPE_URL: 'http://127.0.0.1:1', PIPE_TOKEN: 'fixture-token' },
      input: client === 'mcp' ? frames.map(f => JSON.stringify({ jsonrpc: '2.0', ...f })).join('\n') + '\n' : '', encoding: 'utf8', timeout: 5000 });
  if (client === 'cli') { assert.equal(JSON.parse(output).request.state, 'start_mismatch'); return; }
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  const wait = replies.find(r => r.id === 2).result; assert.notEqual(wait.isError, true);
  assert.match(wait.content[0].text, /"state":"start_mismatch"/);
  const submit = replies.find(r => r.id === 1).result.tools.find((tool: { name: string }) => tool.name === 'pipe_submit');
  assert.equal(submit.inputSchema.properties.pinnedStartCommit.type, 'string');
  assert.equal(submit.inputSchema.properties.requireCleanStart.type, 'boolean');

});

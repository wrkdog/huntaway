// Gemini is not part of this release (src/agy.ts and src/agy-chat.ts are placeholders): a Gemini config or policy refuses
// startup before any store work, a Gemini chat job and a Gemini review seat are refused, and nothing reports Gemini as
// available. Every placeholder that would run Gemini refuses instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as agy from '../src/agy.ts';
import { validateArgonModels } from '../src/agy-chat.ts';
import { startPipe } from '../src/service.ts';

const UNSUPPORTED = /Gemini is not supported in this release/;
const policy = { claude: { models: { opus: 'default' }, efforts: ['high'] }, codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['high'] } };
const geminiConfig = { cli: '/nonexistent/agy', home: '/nonexistent/home', loginHashesFile: '/nonexistent/hashes' };

function folder(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-no-gemini-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'trees'));
  return { root, storePath: join(root, 'pipe.sqlite'), worktreeRoot: join(root, 'trees') };
}
const base = (f: ReturnType<typeof folder>) => ({ accounts: [], policy, storePath: f.storePath, worktreeRoot: f.worktreeRoot,
  workDir: f.root, cli: {}, token: 'no-gemini-fixture-token-of-32-chars', port: 0, minFreeGb: 0, tickMs: 60_000 });

test('a Gemini section in the config refuses startup before any store work', async (t) => {
  const f = folder(t);
  await assert.rejects(startPipe({ ...base(f), gemini: geminiConfig } as Parameters<typeof startPipe>[0]), UNSUPPORTED);
  assert.equal(existsSync(f.storePath), false);
});

test('a Gemini policy refuses startup before any store work', async (t) => {
  const f = folder(t);
  const withGemini = { ...policy, gemini: { models: { 'gemini-3.8-flash-high': 'default' }, efforts: ['high'] } };
  await assert.rejects(startPipe({ ...base(f), policy: withGemini } as Parameters<typeof startPipe>[0]), UNSUPPORTED);
  assert.equal(existsSync(f.storePath), false);
});

test('an account with provider Gemini refuses startup before any store work', async (t) => {
  const f = folder(t);
  mkdirSync(join(f.root, 'login'));
  const account = { id: 'google', provider: 'Gemini', loginDir: join(f.root, 'login'), fingerprint: 'x', maxConcurrency: 1, enabled: true };
  await assert.rejects(startPipe({ ...base(f), accounts: [account] } as unknown as Parameters<typeof startPipe>[0]), UNSUPPORTED);
  assert.equal(existsSync(f.storePath), false);
});

test('a running Pipe refuses a Gemini chat job and a Gemini review seat', async (t) => {
  const f = folder(t);
  const pipe = await startPipe(base(f) as Parameters<typeof startPipe>[0]);
  t.after(() => pipe.stop());
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${pipe.url}${path}`, { method: 'POST', body: JSON.stringify(body),
      headers: { authorization: 'Bearer no-gemini-fixture-token-of-32-chars', 'content-type': 'application/json' } });
    return { status: response.status, text: await response.text() };
  };
  const chat = await post('/v1/requests', { provider: 'gemini', model: 'gemini-3.8-flash-high', effort: 'high', kind: 'chat',
    mutating: false, requester: 'unit', reason: 'no gemini', prompt: 'hello' });
  assert.equal(chat.status, 400, chat.text);
  assert.match(chat.text, /Gemini is not configured/);
  const review = await post('/v1/reviews', { repo: f.root, head: 'a'.repeat(40), base: 'b'.repeat(40), brief: 'Check.\n',
    requester: 'unit', reason: 'no gemini', seats: [{ provider: 'gemini', model: 'gemini-3.8-flash-high', effort: 'high' }] });
  assert.notEqual(review.status, 200, review.text);
  assert.notEqual(review.status, 202, review.text);
  assert.match(review.text, /Gemini is not configured/);
  // An ordinary Claude chat job is still accepted: the placeholders refuse Gemini only.
  const claude = await post('/v1/requests', { provider: 'claude', model: 'opus', effort: 'high', kind: 'chat',
    mutating: false, requester: 'unit', reason: 'still works', prompt: 'hello' });
  assert.ok(claude.status >= 200 && claude.status < 300, claude.text);
});

test('every placeholder that would run Gemini refuses, and nothing reports Gemini as available', async () => {
  const store = {} as Parameters<typeof agy.hasGemini>[0];
  assert.equal(agy.hasGemini(store), false);
  assert.equal(agy.geminiConfig(store), undefined);
  assert.equal(agy.runningGemini(store), 0);
  assert.equal(agy.geminiChatRefusal({ provider: 'gemini' }, []), 'Gemini is not supported in this release');
  assert.equal(agy.geminiChatRefusal({ provider: 'claude' }, []), null);
  assert.equal(await agy.loginRefusal('anything', '/nonexistent'), 'Gemini is not supported in this release');
  assert.throws(() => agy.configureGemini(store, geminiConfig, '/nonexistent', {}), UNSUPPORTED);
  assert.throws(() => agy.validateGeminiConfig(geminiConfig), UNSUPPORTED);
  assert.throws(() => agy.geminiFolder(store), UNSUPPORTED);
  assert.throws(() => agy.geminiPrompt('h', 'b', 's', 'd'), UNSUPPORTED);
  assert.throws(() => agy.geminiChatPrompt('x'), UNSUPPORTED);
  assert.throws(() => agy.startGemini(store, {} as never, {} as never, () => {}), UNSUPPORTED);
  await assert.rejects(agy.runGemini(geminiConfig, '/nonexistent', 'm', 'p', 't', {}, new AbortController().signal, () => {}), UNSUPPORTED);
  await assert.rejects(agy.geminiModels(geminiConfig, {}), UNSUPPORTED);
  assert.throws(() => validateArgonModels({ policy, gemini: {} }), UNSUPPORTED);
  assert.throws(() => validateArgonModels({ policy, accounts: [{ provider: 'GEMINI' }] }), UNSUPPORTED);
  assert.doesNotThrow(() => validateArgonModels({ policy, accounts: [{ provider: 'claude' }] }));
});

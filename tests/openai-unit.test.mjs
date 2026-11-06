// Socket-free adapter/layer checks and real CLI/worker checks with an in-memory fetch preload.
// The unmodified openai-engine.test.mjs separately exercises real HTTP on a machine that can bind ports.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { OPENAI } from '../src/ask/openai.ts';
import { parseAskArgs } from '../src/ask/ask.ts';
import { OPENAI_MODELS, modelsFor } from '../src/ask/models.ts';
import { hardInput, hardWorst, modelPrices, preparePaid, readSpend } from '../src/ask/paid.ts';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const options = { engine: 'openai', family: 'claude', model: 'hwtest-model', effort: 'medium',
  timeout: 1, maxTokens: 1024, question: 'memory-only question' };
function setup(extra = {}) {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('HUNTAWAY_') || name === 'OPENAI_API_KEY') delete process.env[name];
  }
  const dir = mkdtempSync(join(tmpdir(), 'huntaway-openai-unit-'));
  dirs.push(dir);
  Object.assign(process.env, { HUNTAWAY_HOME: dir, HUNTAWAY_ENABLE_FAKE_ENGINE: '1',
    HUNTAWAY_TEST_OPENAI_URL: 'http://127.0.0.1:9/v1/responses', OPENAI_API_KEY: 'hwtest-memory-only-openai',
    HUNTAWAY_MAX_USD_PER_QUESTION: '0.50', HUNTAWAY_MAX_USD_PER_DAY: '5', ...extra });
  return dir;
}
const usage = (input = 10, output = 20) => ({ input_tokens: input, output_tokens: output,
  total_tokens: input + output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
const message = (content = [{ type: 'output_text', text: 'answer' }]) => ({ type: 'message', content });
const answer = (extra = {}) => ({ status: 'completed', service_tier: 'default',
  output: [message()], usage: usage(), ...extra });
const reserved = () => hardWorst(modelsFor(OPENAI_MODELS)[1], options.maxTokens,
  Buffer.byteLength(JSON.stringify(OPENAI.requestBody(options, modelsFor(OPENAI_MODELS)[1]))));
async function run(doc = answer(), status = 200, count = { input_tokens: 10 }) {
  let calls = 0;
  const result = await preparePaid(OPENAI, options, async () => {
    calls++;
    return calls === 1 ? Response.json(count) : Response.json(doc, { status });
  }).submit({ onSent() {} });
  return { result, wait: result.outcome === 'accepted' ? await result.wait() : null, calls };
}

test('OpenAI table: one reviewed default, highest standard prices, byte/context bound, and gated stand-ins', () => {
  setup();
  const model = OPENAI_MODELS[0];
  assert.equal(OPENAI_MODELS.filter(m => m.default).length, 1);
  assert.equal(model.id, 'gpt-5.4');
  assert.equal(model.safetyRevision, 1);
  assert.deepEqual(model.standard, { input: 5_000_000n, output: 22_500_000n });
  assert.equal(hardInput(model, 1024, 10_240), 20_544n);
  assert.equal(hardInput(model, 8192, 1_000_000), 1_050_000n);
  assert.equal(hardWorst(model, 1024, 10_240), 125_760n);
  assert.ok(model.sources.some(s => s.includes('tiktoken')));
  assert.deepEqual(modelsFor(OPENAI_MODELS).slice(1).map(m => m.id), ['hwtest-model', 'hwtest.model']);
  process.env.HUNTAWAY_PRICE_OPENAI_HWTEST_MODEL = '2,4';
  assert.throws(() => modelPrices(OPENAI, 'hwtest-model'), /unambiguously/);
  delete process.env.HUNTAWAY_ENABLE_FAKE_ENGINE;
  assert.deepEqual(modelsFor(OPENAI_MODELS), OPENAI_MODELS);
  assert.throws(() => modelPrices(OPENAI, 'hwtest-model'), /capability table/);
});

test('the count sends only model, input and billed reasoning; only the auth header holds the key', async () => {
  setup();
  const calls = [];
  const opts = { ...options, model: 'gpt-5.4' };
  const model = OPENAI_MODELS[0];
  assert.deepEqual(OPENAI.requestBody(opts, model), { model: model.id, input: options.question,
    max_output_tokens: 1024, service_tier: 'default', store: false, reasoning: { effort: 'none' } });
  await preparePaid(OPENAI, opts, async (url, init) => {
    assert.equal(init.headers.Authorization, `Bearer ${process.env.OPENAI_API_KEY}`);
    assert.ok(!init.body.includes(process.env.OPENAI_API_KEY));
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    calls.push({ path: new URL(url).pathname, body: init.body });
    return Response.json(calls.length === 1 ? { input_tokens: 10 } : answer());
  }).submit({ onSent() {} });
  assert.deepEqual(calls.map(c => c.path), ['/v1/responses/input_tokens', '/v1/responses']);
  assert.deepEqual(JSON.parse(calls[0].body), { model: model.id, input: options.question,
    reasoning: { effort: 'none' } });
  assert.deepEqual(JSON.parse(calls[1].body), OPENAI.requestBody(opts, model));
  assert.equal(readSpend().used, 500n);
});

test('max-tokens accepts OpenAI boundaries 16 and 8192 and Anthropic boundaries 1 and 8192', () => {
  setup();
  for (const engine of ['openai', 'anthropic']) {
    for (const maxTokens of [engine === 'openai' ? 16 : 1, 8192]) {
      process.env.HUNTAWAY_ENGINE = engine;
      for (const args of [[], ['--engine', engine]]) {
        const parsed = parseAskArgs(['--max-tokens', String(maxTokens), ...args, 'question'], 'usage');
        assert.equal(parsed.engine, engine);
        assert.equal(parsed.maxTokens, maxTokens);
      }
    }
  }
  process.env.HUNTAWAY_ENGINE = 'openai';
  assert.equal(parseAskArgs(['--max-tokens', '1', '--engine', 'anthropic', 'question'], 'usage').maxTokens, 1);
});

test('output_text parts join across messages; reasoning is excluded, refusals/filtering are fixed outcomes', () => {
  const result = OPENAI.readAnswer(answer({ output: [{ type: 'reasoning', summary: [{ text: 'hidden' }] },
    message([{ type: 'output_text', text: 'one' }, { type: 'output_text', text: ' two' }]),
    message([{ type: 'output_text', text: ' three' }])] }));
  assert.equal(result.answer, 'one two three');
  assert.equal(result.refused, false);
  assert.equal(OPENAI.readAnswer(answer({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).truncated, true);
  assert.equal(OPENAI.readAnswer(answer({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } })).refused, true);
  assert.equal(OPENAI.readAnswer(answer({ output: [message([{ type: 'refusal', refusal: 'never echo' }])] })).refused, true);
  for (const doc of [null, [], {}, answer({ status: 'failed' }), answer({ status: 'in_progress' }),
    answer({ status: 'incomplete', incomplete_details: { reason: 'unknown' } }), answer({ output: null }),
    answer({ output: [message(null)] }), answer({ output: [message([{ type: 'output_text', text: 7 }])] })]) {
    assert.equal(OPENAI.readAnswer(doc), null);
  }
});

test('usage rejects invalid/inconsistent values; cached and reasoning tokens are subsets, never added twice', () => {
  for (const u of [undefined, null, {}, { input_tokens: -1, output_tokens: 20 },
    { input_tokens: '10', output_tokens: 20 }, { input_tokens: 1.5, output_tokens: 20 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 20 }, { ...usage(), total_tokens: 99 },
    { ...usage(), total_tokens: null }, { ...usage(), input_tokens_details: null },
    { ...usage(), input_tokens_details: {} }, { ...usage(), input_tokens_details: { cached_tokens: 11 } },
    { ...usage(), output_tokens_details: { reasoning_tokens: 21 } }, { ...usage(), output_tokens_details: [] }]) {
    assert.equal(OPENAI.readAnswer(answer({ usage: u })).usage, null);
  }
  const u = { ...usage(), input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 15 } };
  assert.deepEqual(OPENAI.readAnswer(answer({ usage: u })).usage, { input: 10n, output: 20n, cache: 0n, standard: true });
  assert.ok(OPENAI.readAnswer(answer({ usage: { input_tokens: 10, output_tokens: 20 } })).usage);
  for (const tier of [undefined, null, 'auto', 'flex', 'scale', 'priority', 'fast', 'unknown']) {
    assert.equal(OPENAI.readAnswer(answer({ service_tier: tier })).usage.standard, false);
  }
});

test('only 400/401/403/404/429 prove never ran; 500/503 and other statuses retain the reservation', async () => {
  assert.deepEqual([...OPENAI.notRun], [400, 401, 403, 404, 429]);
  for (const status of [400, 401, 403, 404, 429, 500, 503, 409, 422]) {
    setup();
    const r = await run({ error: { type: 'untrusted text', message: process.env.OPENAI_API_KEY } }, status);
    assert.equal(r.calls, 2);
    const refused = OPENAI.notRun.has(status);
    assert.equal(r.result.outcome, refused ? 'refused' : 'accepted');
    if (!refused) assert.equal(r.wait.status, 'uncertain');
    assert.equal(readSpend().used, refused ? 0n : reserved());
    assert.ok(!JSON.stringify(r).includes(process.env.OPENAI_API_KEY));
  }
});

test('unreadable or invalid counts never send a billed call or reserve money', async () => {
  for (const count of [{}, { input_tokens: null }, { input_tokens: '10' }, { input_tokens: -1 }, { input_tokens: 0.1 }]) {
    setup();
    const r = await run(answer(), 200, count);
    assert.equal(r.result.outcome, 'refused');
    assert.equal(r.calls, 1);
    assert.equal(readSpend().used, 0n);
  }
});

test('known no-text and filtered calls settle usage; missing usage retains the reservation', async () => {
  for (const incomplete_details of [null, { reason: 'max_output_tokens' }, { reason: 'content_filter' }]) {
    setup();
    const r = await run(answer({ status: incomplete_details ? 'incomplete' : 'completed', output: [], incomplete_details }));
    assert.equal(r.wait.status, 'failed');
    assert.doesNotMatch(r.wait.why, /may have run/);
    assert.match(r.wait.why, incomplete_details?.reason === 'content_filter' ? /refused/ : /--max-tokens/);
    assert.equal(readSpend().used, 50n);
  }
  setup();
  const r = await run(answer({ output: [], usage: null }));
  assert.equal(r.wait.status, 'uncertain');
  assert.equal(readSpend().used, reserved());
});

test('a bad tier settles conservatively and blocks; bad usage alone keeps the reservation without blocking', async () => {
  setup();
  const r = await run(answer({ service_tier: 'priority' }));
  assert.equal(r.wait.status, 'completed');
  assert.equal(readSpend().used, 100n);
  assert.equal(readSpend().overruns.length, 1);
  assert.equal((await run()).calls, 0);
  setup();
  await run(answer({ usage: { ...usage(), total_tokens: 1 } }));
  assert.equal(readSpend().used, reserved());
  assert.equal(readSpend().overruns.length, 0);
  assert.equal((await run()).wait.status, 'completed');
});

test('CLI, key commands, doctor, and the fetch worker use OpenAI without a socket or real keychain', () => {
  const root = setup();
  const home = join(root, 'home');
  const data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  const preload = join(root, 'fetch.mjs');
  const callsFile = join(root, 'calls');
  writeFileSync(preload, `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, init) => {
      if (new URL(url).origin !== 'http://127.0.0.1:9') throw new Error('Unexpected destination');
      if (init.headers.Authorization !== 'Bearer ' + process.env.OPENAI_API_KEY) throw new Error('Invalid auth');
      appendFileSync(process.env.OPENAI_UNIT_CALLS, JSON.stringify({ path: new URL(url).pathname,
        body: JSON.parse(init.body), redirect: init.redirect }) + '\\n');
      return Response.json(String(url).endsWith('/input_tokens') ? { input_tokens: 10 }
        : process.env.OPENAI_UNIT_NO_TEXT ? { status: 'completed', output: [], usage: null } : ${JSON.stringify(answer())},
        { headers: { 'x-request-id': 'req_openai_unit' } });
    };
  `);
  const cli = (args, extra = {}, input) => spawnSync(process.execPath,
    ['--experimental-strip-types', '--import', preload, fileURLToPath(new URL('../bin/huntaway.ts', import.meta.url)), ...args],
    { encoding: 'utf8', input, env: { PATH: process.env.PATH, HOME: home, HUNTAWAY_HOME: data, HUNTAWAY_ALIAS: 'Unit',
      HUNTAWAY_ENABLE_FAKE_ENGINE: '1', HUNTAWAY_TEST_OPENAI_URL: 'http://127.0.0.1:9/v1/responses',
      HUNTAWAY_TEST_KEYCHAIN_FILE: join(home, 'keychain.json'), HUNTAWAY_ENGINE: 'openai',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY, HUNTAWAY_MAX_USD_PER_QUESTION: '1', HUNTAWAY_MAX_USD_PER_DAY: '5',
      OPENAI_UNIT_CALLS: callsFile, ...extra } });
  const r = cli(['ask', '--model', 'hwtest-model', options.question]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'answer\n');
  assert.match(r.stderr, /paid OpenAI API key/);
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c => c.path), ['/v1/responses/input_tokens', '/v1/responses']);
  assert.deepEqual(calls[0].body, { model: 'hwtest-model', input: options.question });
  assert.deepEqual(calls[1].body, { model: 'hwtest-model', input: options.question,
    max_output_tokens: 1024, service_tier: 'default', store: false });
  const noText = cli(['ask', '--model', 'hwtest-model', options.question], { OPENAI_UNIT_NO_TEXT: '1' });
  assert.equal(noText.status, 1);
  assert.match(noText.stderr, /API request req_openai_unit/);
  for (const args of [['--effort', 'low'], ['--family', 'claude'], ['--family', 'codex'], ['--timeout', '301']]) {
    assert.equal(cli(['ask', ...args, 'question']).status, 2);
  }
  const callsBefore = readFileSync(callsFile, 'utf8');
  const runsBefore = readFileSync(join(data, 'requests.db'));
  for (const maxTokens of [0, 1, 15, 8193]) {
    for (const args of [[], ['--engine', 'openai']]) {
      const invalid = cli(['ask', '--max-tokens', String(maxTokens), ...args, 'question'],
        { HUNTAWAY_ENGINE: args.length ? 'anthropic' : 'openai' });
      assert.equal(invalid.status, 2, invalid.stderr);
    }
  }
  assert.equal(readFileSync(callsFile, 'utf8'), callsBefore, 'invalid limits send neither count nor billed request');
  assert.deepEqual(readFileSync(join(data, 'requests.db')), runsBefore, 'invalid limits record no run');
  const d = cli(['doctor']);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /ok\s+engine: openai \(paid API;.*set in the environment/);
  assert.match(d.stdout, /gpt-5\.4: per-question cap \$0\.13/);
  const key = process.env.OPENAI_API_KEY;
  assert.equal(cli(['key', 'set', 'openai'], {}, key + '\n').status, 0);
  assert.match(cli(['doctor'], { OPENAI_API_KEY: '' }).stdout, /key in the keychain/);
  assert.equal(cli(['key', 'remove', 'openai']).status, 0);
  assert.equal(cli(['doctor'], { OPENAI_API_KEY: '' }).status, 1);
  const bad = cli(['ask', 'question'], { HUNTAWAY_ENGINE: 'unknown' });
  assert.equal(bad.status, 2);
  const badLine = bad.stderr.split('\n').find((l) => l.includes('HUNTAWAY_ENGINE must be '));
  assert.ok(badLine !== undefined, bad.stderr);
  for (const engine of ['pipe', 'anthropic', 'openai']) assert.match(badLine, new RegExp(`\\b${engine}\\b`), `names ${engine}`);
  for (const f of readdirSync(data)) assert.ok(!readFileSync(join(data, f)).includes(key));
  assert.ok(!(r.stdout + r.stderr + d.stdout + d.stderr + readFileSync(callsFile, 'utf8')).includes(key));
});

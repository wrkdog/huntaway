// Monetary safety regressions using an in-memory transport, without sockets or stored keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANTHROPIC } from '../src/ask/anthropic.ts';
import { about, cents, paidCaps, paidDoctor, preparePaid, readSpend } from '../src/ask/paid.ts';
import { SpendLedger } from '../src/ask/ledger.ts';

const options = { engine: 'anthropic', family: 'claude', model: 'hwtest-model', effort: 'medium',
  timeout: 5, maxTokens: 1024, question: '' };
const utf8 = text => Buffer.byteLength(text, 'utf8');
const fd = String.fromCodePoint(0xfdfa);

function setup(t, extra = {}) {
  const original = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), 'huntaway-paid-safety-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('HUNTAWAY_') || name === 'ANTHROPIC_API_KEY') delete process.env[name];
  }
  Object.assign(process.env, { HUNTAWAY_HOME: dir, HUNTAWAY_ENABLE_FAKE_ENGINE: '1',
    HUNTAWAY_TEST_NOW: '1793870400000', HUNTAWAY_TEST_ANTHROPIC_URL: 'http://127.0.0.1:9/v1/messages',
    ANTHROPIC_API_KEY: `hwtest-${randomUUID()}`, HUNTAWAY_MAX_USD_PER_QUESTION: '0.50',
    HUNTAWAY_MAX_USD_PER_DAY: '5', ...extra });
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

for (const [label, question] of [
  ['NFKC expansion', fd.repeat(600)],
  ['mixed expansion and contraction', `${fd}${String.fromCodePoint(0xbd, 0xfb01)} `.repeat(200)],
  ['contraction', `a${String.fromCodePoint(0x3000, 0xfb01, 0x212b)}e${String.fromCodePoint(0x301)}`.repeat(300)],
  ['JSON escaping after normalization', `${fd}${String.fromCodePoint(0xff02, 0xff3c)}\n`.repeat(200)],
  ['unchanged ASCII and JSON escaping', 'question\n"\\'.repeat(200)],
  ['hard input limit', fd.repeat(2000)],
]) {
  test(`${label}: reservation uses max(raw JSON, question-NFKC JSON) and sends raw text`, async t => {
    setup(t);
    const opts = { ...options, question };
    const model = { id: opts.model, thinking: 'none' };
    const raw = JSON.stringify(ANTHROPIC.requestBody(opts, model));
    const normalized = JSON.stringify(ANTHROPIC.requestBody({ ...opts, question: question.normalize('NFKC') }, model));
    const expected = BigInt(Math.min(100000, 2 * Math.max(utf8(raw), utf8(normalized)) + 64) + 2048);
    let calls = 0;
    const stderr = [];
    t.mock.method(process.stderr, 'write', text => { stderr.push(text); return true; });
    const prepared = preparePaid(ANTHROPIC, opts, async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).messages[0].content, question);
      if (calls === 1) return Response.json({ input_tokens: 10 });
      assert.equal(init.body, raw);
      assert.equal(readSpend().used, expected, 'the full reservation precedes the billed request');
      return Response.json({}, { status: 500 });
    });
    const result = await prepared.submit({ onSent() {} });
    assert.equal(result.outcome, 'accepted');
    assert.equal(calls, 2);
    assert.equal(readSpend().used, expected, 'uncertainty retains the same reservation');
    assert.ok(stderr.join('').includes(`At most $${cents(expected)} for this question`));
  });
}

test('NFKC expansion refuses the question cap before the count and names the required cap', t => {
  setup(t, { HUNTAWAY_MAX_USD_PER_QUESTION: '0.04' });
  assert.throws(() => preparePaid(ANTHROPIC, { ...options, question: fd.repeat(600) },
    () => assert.fail('no count permitted')), /raise the cap to \$0\.05\b/);
});

test('NFKC expansion refuses insufficient day headroom before a second count', async t => {
  setup(t, { HUNTAWAY_MAX_USD_PER_QUESTION: '0.05', HUNTAWAY_MAX_USD_PER_DAY: '0.06' });
  let calls = 0;
  const request = async () => ++calls === 1 ? Response.json({ input_tokens: 10 }) : Response.json({}, { status: 500 });
  const first = await preparePaid(ANTHROPIC, { ...options, question: fd.repeat(600) }, request).submit({ onSent() {} });
  assert.equal(first.outcome, 'accepted');
  const second = await preparePaid(ANTHROPIC, { ...options, question: fd.repeat(600) }, request).submit({ onSent() {} });
  assert.equal(second.outcome, 'refused');
  assert.match(second.why, /per-day.*\$0\.05.*headroom/);
  assert.equal(calls, 2);
});

test('a huge counted estimate at override prices clamps only the stored estimate to int64', async t => {
  const dir = setup(t, { HUNTAWAY_MAX_USD_PER_QUESTION: '1000', HUNTAWAY_MAX_USD_PER_DAY: '1000',
    HUNTAWAY_PRICE_ANTHROPIC_CLAUDE_SONNET_5_5: '1000,1000' });
  const stderr = [];
  t.mock.method(process.stderr, 'write', text => { stderr.push(text); return true; });
  let calls = 0;
  const result = await preparePaid(ANTHROPIC, { ...options, model: 'claude-sonnet-5-5', question: 'question' },
    async () => ++calls === 1 ? Response.json({ input_tokens: Number.MAX_SAFE_INTEGER }) : Response.json({}, { status: 500 }))
    .submit({ onSent() {} });
  assert.equal(result.outcome, 'accepted', 'an informational estimate cannot prevent a call that fits the hard caps');
  assert.equal(calls, 2);
  const estimate = (BigInt(Number.MAX_SAFE_INTEGER) * 11n + 640n) * 100n + 1024000n;
  const maxInteger = (1n << 63n) - 1n;
  assert.ok(estimate > maxInteger);
  assert.ok(stderr.join('').includes(`about $${about(estimate)} by Anthropic's count`), 'display the full estimate');
  const db = new DatabaseSync(join(dir, 'spend.sqlite'), { readOnly: true });
  try {
    const query = db.prepare('SELECT estimated, reserved FROM spend');
    query.setReadBigInts(true);
    const row = query.get();
    assert.equal(row.estimated, maxInteger);
    assert.equal(row.reserved, readSpend().used);
    assert.ok(row.reserved < 1000000000n);
  } finally { db.close(); }
});

test('doctor reports the 10,240-byte cap as information even under a smaller configured cap', t => {
  setup(t, { HUNTAWAY_MAX_USD_PER_QUESTION: '0.01' });
  const doctor = paidDoctor(ANTHROPIC);
  assert.equal(doctor.ok, true);
  assert.ok(doctor.lines.includes('info model claude-sonnet-5-5: per-question cap $0.06 for a 10,240-byte request body at --max-tokens 1024'));
  assert.ok(doctor.lines.includes('info model hwtest-model: per-question cap $0.03 for a 10,240-byte request body at --max-tokens 1024'));
  assert.ok(!doctor.lines.some(line => line.startsWith('FAIL')));
});

test('doctor handles non-string exception messages without calling string methods', t => {
  const dir = setup(t);
  new SpendLedger(join(dir, 'spend.sqlite')).close();
  for (const message of [undefined, null, 42, {}]) {
    const mock = t.mock.method(SpendLedger.prototype, 'snapshot', () => { throw { message }; });
    try {
      const doctor = paidDoctor(ANTHROPIC);
      assert.equal(doctor.ok, false);
      assert.ok(doctor.lines.includes('FAIL engine: anthropic (the spend ledger could not be read)'));
    } finally { mock.mock.restore(); }
  }
});

test('missing caps use the $1 per-question and $10 per-day example', t => {
  setup(t);
  delete process.env.HUNTAWAY_MAX_USD_PER_QUESTION;
  assert.throws(paidCaps, /HUNTAWAY_MAX_USD_PER_QUESTION=1 HUNTAWAY_MAX_USD_PER_DAY=10$/);
});

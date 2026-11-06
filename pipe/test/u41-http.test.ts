import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:net';
import { Readable } from 'node:stream';
import { startHttp } from '../src/http.ts';
import { parsePolicy } from '../src/policy.ts';
import type { Store } from '../src/store.ts';

// Exercise the request handler without opening a loopback socket in the builder sandbox.
test('HTTP error replies and logger preserve their public contract without a socket', async (t) => {
  t.mock.method(Server.prototype, 'listen', function(this: Server, _port: number, _host: string, ready: () => void) {
    queueMicrotask(ready); return this;
  });
  t.mock.method(Server.prototype, 'address', () => ({ address: '127.0.0.1', family: 'IPv4', port: 12345 }));
  for (const [label, error, status, code, logged] of [
    ['unexpected', new Error('private diagnostic'), 500, 'internal_error', true],
    ['coded refusal', Object.assign(new Error('review setup timed out; the review was not started'), { status: 503, code: 'setup_timeout' }), 503, 'setup_timeout', false],
    ['status only', Object.assign(new Error('body too large'), { status: 413 }), 413, 'bad_request', false],
    ['review validation', Object.assign(new Error('invalid review'), { name: 'ReviewError' }), 400, 'bad_request', false],
    ['coded internal error', Object.assign(new Error('private diagnostic'), { status: 500, code: 'private_code' }), 500, 'internal_error', true],
  ] as const) await t.test(label, async () => {
    const logs: Array<[string, unknown]> = [];
    const { server } = await startHttp({ token: 'test-token', store: {} as Store,
      policy: parsePolicy({ codex: { models: { 'gpt-6.1-sol': 'default' }, efforts: ['low'] } }),
      accounts: () => [], accountIds: () => [], models: () => ({}), draining: () => false, drain: async () => {}, cancel: () => {},
      reviews: { submit: async () => { throw error; }, get: () => undefined, vote: () => undefined },
      log: (where, thrown) => { logs.push([where, thrown]); } });
    const request = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', url: '/v1/reviews?private=query',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' } });
    const response = await new Promise<{ status: number; body: { error: { code: string; message: string } } }>(resolve => {
      let received = 0;
      server.emit('request', request, { writeHead(value: number) { received = value; }, end(data: string) { resolve({ status: received, body: JSON.parse(data) }); } });
    });
    assert.equal(response.status, status);
    assert.equal(response.body.error.code, code);
    assert.equal(response.body.error.message, status === 500 ? 'request could not be handled' : error.message);
    assert.deepEqual(logs, logged ? [['http POST /v1/reviews', error]] : []);
    server.removeAllListeners();
  });
});

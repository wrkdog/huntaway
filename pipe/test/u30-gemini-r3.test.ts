import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { recheckHeld } from '../src/service.ts';
import type { RunnerIdentity, Store } from '../src/store.ts';

test('R3 a held Gemini runner retains its supervisor proof until both groups are gone', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const closed = once(child, 'close');
  await once(child, 'spawn');
  const runner = { pid: dead, startedAt: 'unverified:gone',
    supervisor: { pid: child.pid!, startedAt: 'unverified:live' } };
  const held = new Map<string, RunnerIdentity & { supervisor?: RunnerIdentity }>([['attempt', runner]]);
  const writes: string[] = [];
  const store = {
    recoveryAttempts: () => [],
    noteClosed: (id: string) => { writes.push(`closed:${id}`); },
    reconcile: (_reason: string, _kind: string, eligible: (id: string) => boolean) => {
      assert.equal(eligible('attempt'), true);
      assert.equal(eligible('other'), false);
      writes.push('reconciled');
    },
  } as unknown as Store;
  try {
    await recheckHeld(store, held, () => {});
    assert.equal(held.size, 1, 'a dead runner alone cannot release a live supervisor');
    assert.deepEqual(writes, [], 'unproved closure grants no durable completion');
    child.kill('SIGKILL');
    await closed;
    await recheckHeld(store, held, () => {});
    assert.equal(held.size, 0);
    assert.deepEqual(writes, ['closed:attempt', 'reconciled']);
  } finally { child.kill('SIGKILL'); await closed; }
});

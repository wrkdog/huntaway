import test from 'node:test';
import assert from 'node:assert/strict';
import { health } from '../src/cards.ts';

// Byte-preserved behavioral case from the Gemini draft; invalid service fixtures remain inert evidence.
test('health(): accepts only 40 or 64 lower-hex commit IDs (-dirty allowed); invalid/sentinels become null', () => {
  const baseHealth = {
    startedAt: '2026-09-30T10:00:00.000Z',
    clockCurrent: true,
    draining: false,
    accounts: [],
  };

  // Valid 40-hex SHA1 clean and dirty
  const h40Clean = health({ ...baseHealth, version: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' });
  assert.equal(h40Clean.service.version, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const h40Dirty = health({ ...baseHealth, version: '4b825dc642cb6eb9a060e54bf8d69288fbee4904-dirty' });
  assert.equal(h40Dirty.service.version, '4b825dc642cb6eb9a060e54bf8d69288fbee4904-dirty');

  // Valid 64-hex SHA256 clean and dirty
  const sha256Str = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const h64Clean = health({ ...baseHealth, version: sha256Str });
  assert.equal(h64Clean.service.version, sha256Str);
  const h64Dirty = health({ ...baseHealth, version: `${sha256Str}-dirty` });
  assert.equal(h64Dirty.service.version, `${sha256Str}-dirty`);

  // Sentinels and invalid formats: must return null, never leak free text, paths or objects
  const invalidSentinels: unknown[] = [
    'v1.0.0-failing',
    '/etc/passwd',
    '/opt/checkout/pipe',
    '4B825DC642CB6EB9A060E54BF8D69288FBEE4904', // uppercase hex disallowed
    '4b825dc642cb6eb9a060e54bf8d69288fbee4904\nDROP TABLE',
    '4b825dc642cb6eb9a060e54bf8d69288fbee490', // 39 chars
    '4b825dc642cb6eb9a060e54bf8d69288fbee49040', // 41 chars
    '4b825dc642cb6eb9a060e54bf8d69288fbee4904-dirty-extra',
    { leak: 'internal_path_or_secret' },
    ['4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
    123456,
    true,
    null,
    undefined,
  ];

  for (const invalid of invalidSentinels) {
    const res = health({ ...baseHealth, version: invalid as string | null | undefined });
    assert.equal(res.service.version, null, `expected null for sentinel: ${JSON.stringify(invalid)}`);
  }
});

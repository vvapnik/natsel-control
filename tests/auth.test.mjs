import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate } from '../src/auth.js';

// Node lacks crypto.subtle.timingSafeEqual (a Workers extension); emulate it for tests.
crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));

const req = (auth) => new Request('https://x/api/pool', { headers: auth ? { Authorization: auth } : {} });

test('bearer token', async () => {
  const env = { API_TOKEN: 's3cret' };
  assert.equal(await authenticate(req('Bearer s3cret'), env), 'token');
  await assert.rejects(authenticate(req('Bearer wrong'), env), { status: 401 });
  await assert.rejects(authenticate(req(), env), { status: 401 });
});

test('nothing configured refuses every request', async () => {
  await assert.rejects(authenticate(req('Bearer x'), {}), { status: 500 });
});

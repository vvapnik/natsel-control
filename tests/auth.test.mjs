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

test('panel session: login, cookie, logout', async () => {
  const { login, logout } = await import('../src/session.js');
  const env = { PANEL_LOGIN: 'admin', PANEL_PASSWORD: 'pw', SESSION_SECRET: 'k' };
  const post = (body) => new Request('https://x/api/login', { method: 'POST', body: JSON.stringify(body) });

  await assert.rejects(login(post({ login: 'admin', password: 'nope' }), env), { status: 401 });
  const res = await login(post({ login: 'admin', password: 'pw' }), env);
  const set = res.headers.get('set-cookie');
  assert.match(set, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = set.split(';')[0];
  const withCookie = (c) => new Request('https://x/api/pool', { headers: { Cookie: c } });

  assert.equal(await authenticate(withCookie(cookie), env), 'admin');
  const [name, value] = cookie.split('=');
  const forged = `${name}=${value.replace(/^admin/, 'root')}`;
  await assert.rejects(authenticate(withCookie(forged), env), { status: 401 });
  await assert.rejects(authenticate(withCookie(cookie), { ...env, SESSION_SECRET: 'other' }), { status: 401 });
  assert.match(logout().headers.get('set-cookie'), /Max-Age=0/);
});

test('expired session is refused', async () => {
  const { login, sessionUser } = await import('../src/session.js');
  const env = { PANEL_LOGIN: 'a', PANEL_PASSWORD: 'b', SESSION_SECRET: 'k' };
  const res = await login(new Request('https://x', { method: 'POST', body: '{"login":"a","password":"b"}' }), env, Date.now() - 13 * 3600_000);
  const req = new Request('https://x', { headers: { Cookie: res.headers.get('set-cookie').split(';')[0] } });
  assert.equal(await sessionUser(req, env), null);
});

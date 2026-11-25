// Panel sign-in by login and password: POST /api/login sets an HMAC-signed, HttpOnly session cookie.
// Credentials and the signing key are Worker secrets: PANEL_LOGIN, PANEL_PASSWORD, SESSION_SECRET.

import { HttpError } from './rules.js';

export const COOKIE = 'natsel_session';
const TTL_S = 12 * 3600;
const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

export const configured = (env) => Boolean(env.PANEL_LOGIN && env.PANEL_PASSWORD && env.SESSION_SECRET);

function cookieValue(request) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return '';
}

/** Returns the signed-in login, or null when the request carries no valid session. */
export async function sessionUser(request, env, now = Date.now()) {
  if (!configured(env)) return null;
  const [login, exp, mac] = cookieValue(request).split('.');
  if (!login || !exp || !mac) return null;
  if (Number(exp) * 1000 < now) return null;
  if (!(await sameSecret(mac, await sign(`${login}.${exp}`, env.SESSION_SECRET)))) return null;
  return decodeURIComponent(login);
}

const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const reply = (data, status, setCookie) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(setCookie && { 'set-cookie': setCookie }) },
  });

/** POST /api/login { login, password } */
export async function login(request, env, now = Date.now()) {
  if (!configured(env)) throw new HttpError(500, 'panel sign-in is not configured (PANEL_LOGIN, PANEL_PASSWORD, SESSION_SECRET)');
  let creds;
  try {
    creds = await request.json();
  } catch {
    throw new HttpError(400, 'body must be JSON { login, password }');
  }
  const user = String(creds?.login ?? '');
  const pass = String(creds?.password ?? '');
  const okUser = await sameSecret(user, env.PANEL_LOGIN);
  const okPass = await sameSecret(pass, env.PANEL_PASSWORD);
  if (!(okUser && okPass)) {
    await new Promise((r) => setTimeout(r, 500)); // slows down guessing
    throw new HttpError(401, 'wrong login or password');
  }
  const exp = Math.floor(now / 1000) + TTL_S;
  const payload = `${encodeURIComponent(user)}.${exp}`;
  return reply({ login: user, expires: new Date(exp * 1000).toISOString() }, 200, cookie(`${payload}.${await sign(payload, env.SESSION_SECRET)}`, TTL_S));
}

/** POST /api/logout */
export const logout = () => reply({ ok: true }, 200, cookie('', 0));

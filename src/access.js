// Cloudflare Access: every request must carry a valid `Cf-Access-Jwt-Assertion` for our application.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import { HttpError } from './rules.js';

let jwksCache = { url: '', keys: null, at: 0 };

async function keys(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (jwksCache.url === url && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(503, 'cannot fetch Access certs');
  const { keys } = await res.json();
  jwksCache = { url, keys, at: Date.now() };
  return keys;
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

/** Returns the caller's identity (email) or throws 401/403. */
export async function authenticate(request, env) {
  if (env.ACCESS_DISABLED === '1') return 'local';
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(500, 'Cloudflare Access is not configured');

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'missing Access token');
  const [h, p, s] = token.split('.');
  if (!s) throw new HttpError(401, 'malformed Access token');

  const header = json(h);
  const jwk = (await keys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') throw new HttpError(401, 'unknown Access key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new HttpError(401, 'bad Access signature');

  const claims = json(p);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new HttpError(403, 'wrong Access audience');
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new HttpError(403, 'wrong Access issuer');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new HttpError(401, 'expired Access token');
  return claims.email ?? claims.sub ?? 'unknown';
}

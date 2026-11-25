// Authentication: a bearer token (POC default) or Cloudflare Access, whichever is configured.

import { authenticate as access } from './access.js';
import { HttpError } from './rules.js';

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/** Returns the caller's identity or throws 401/500. */
export async function authenticate(request, env) {
  if (env.ACCESS_DISABLED === '1') return 'local';
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return access(request, env);
  if (!env.API_TOKEN) throw new HttpError(500, 'no authentication configured (API_TOKEN or Cloudflare Access)');

  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await sameSecret(token, env.API_TOKEN))) throw new HttpError(401, 'bad or missing API token');
  return 'token';
}

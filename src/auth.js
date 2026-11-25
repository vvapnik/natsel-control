// Authentication: Cloudflare Access if configured; otherwise a panel session (login/password)
// or a bearer token for scripts.

import { authenticate as access } from './access.js';
import { HttpError } from './rules.js';
import { configured as panelConfigured, sessionUser } from './session.js';

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/** Returns the caller's identity or throws 401/500. */
export async function authenticate(request, env) {
  if (env.ACCESS_DISABLED === '1') return 'local';
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return access(request, env);
  if (!env.API_TOKEN && !panelConfigured(env)) {
    throw new HttpError(500, 'no authentication configured (PANEL_LOGIN/PANEL_PASSWORD/SESSION_SECRET, API_TOKEN or Cloudflare Access)');
  }

  const user = await sessionUser(request, env);
  if (user) return user;

  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !env.API_TOKEN || !(await sameSecret(token, env.API_TOKEN))) throw new HttpError(401, 'sign in or send an API token');
  return 'token';
}

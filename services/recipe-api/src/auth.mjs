import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { ApiError, UUID, authRequired } from './errors.mjs';

export const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);

export function createVerifier(issuer) {
  const url = new URL(issuer);
  if (url.href !== issuer || !issuer.endsWith('/auth/v1') || url.search || url.hash ||
      url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && loopback(url.hostname)))) {
    throw new Error('Invalid RECIPE_AUTH_ISSUER');
  }
  const jwks = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'), {
    timeoutDuration: 4_000, cacheMaxAge: 600_000, cooldownDuration: 15_000,
  });
  return async token => {
    try {
      const { payload } = await jwtVerify(token, (header, input) => {
        if (typeof header.kid !== 'string' || !header.kid) throw authRequired();
        return jwks(header, input);
      }, {
        algorithms: ['ES256', 'RS256'], issuer, audience: 'authenticated',
        requiredClaims: ['sub', 'exp', 'role'], clockTolerance: 0,
      });
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub) ||
          payload.role !== 'authenticated' || payload.is_anonymous === true) throw authRequired();
      return payload.sub.toLowerCase();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof errors.JWKSTimeout || err instanceof TypeError || err.code === 'ERR_JOSE_GENERIC') {
        throw new ApiError(503, 'identity_unavailable');
      }
      throw authRequired();
    }
  };
}

export async function accountFromRequest(req, isPublic, verify) {
  const headers = req.headersDistinct.authorization;
  if (!headers) {
    if (isPublic) return null;
    throw authRequired();
  }
  if (headers.length !== 1 || headers[0].length > 8192) throw authRequired();
  const match = /^Bearer ([a-zA-Z0-9_.-]+)$/i.exec(headers[0]);
  if (!match) throw authRequired();
  return verify(match[1]);
}

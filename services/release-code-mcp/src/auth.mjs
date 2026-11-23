import { createRemoteJWKSet, errors, jwtVerify } from 'jose';

export const SCOPE = 'release-code:read';
export const ACCOUNT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function publicUrl(raw) {
  const url = new URL(raw);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.href !== raw ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
  ) {
    throw new Error('Invalid service URL');
  }
  return url;
}

export function accountVerifier({ issuer, audience, jwksUrl }) {
  publicUrl(issuer);
  publicUrl(audience);
  const jwks = createRemoteJWKSet(publicUrl(jwksUrl), {
    timeoutDuration: 4000,
    cooldownDuration: 15000,
    cacheMaxAge: 600000,
  });
  return async (req) => {
    const headers = req.headersDistinct.authorization;
    if (headers?.length !== 1 || headers[0].length > 8192) return null;
    const credential = /^Bearer ([-\w]+\.[-\w]+\.[-\w]+)$/i.exec(headers[0]);
    if (!credential) return null;
    try {
      const { payload } = await jwtVerify(
        credential[1],
        (header, input) => {
          if (typeof header.kid !== 'string' || !header.kid) throw new Error('Invalid key');
          return jwks(header, input);
        },
        {
          algorithms: ['ES256'],
          typ: 'at+jwt',
          issuer,
          audience,
          maxTokenAge: 600,
          requiredClaims: ['iat', 'exp', 'scope', 'sub'],
        }
      );
      if (
        payload.aud !== audience ||
        typeof payload.sub !== 'string' ||
        !ACCOUNT.test(payload.sub) ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 600 ||
        typeof payload.scope !== 'string' ||
        !payload.scope.split(' ').includes(SCOPE)
      )
        return null;
      return payload.sub.toLowerCase();
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || error instanceof TypeError || error.code === 'ERR_JOSE_GENERIC') {
        throw new Error('Account key service unavailable');
      }
      return null;
    }
  };
}

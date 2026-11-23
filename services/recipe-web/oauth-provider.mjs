const supported = new Set(['github', 'google', 'apple']);
const challenge = /^[A-Za-z0-9_-]{43}$/;
const callbackErrors = new Set(['error', 'error_code', 'error_description']);

export function oauthProviders(names) {
  return Array.isArray(names) ? [...new Set(names.filter(name => supported.has(name)))] : [];
}

export function oauthCallback(url) {
  const params = url.searchParams;
  if (url.hash || [...params.keys()].some(key => params.getAll(key).length !== 1)) return {kind: 'failed'};
  const code = params.get('code');
  if (params.size === 1 && code && code.isWellFormed() && Buffer.byteLength(code) <= 2048 && !/[\x00-\x1f\x7f]/.test(code)) {
    return {kind: 'code', code};
  }
  if (code !== null || !params.has('error') || [...params.keys()].some(key => !callbackErrors.has(key))) return {kind: 'failed'};
  return {kind: ['access_denied', 'user_cancelled_authorize'].includes(params.get('error')) ? 'cancelled' : 'failed'};
}

export function validOAuthAuthorizeUrl(value, {provider, supabaseOrigin, callbackUrl}) {
  if (!supported.has(provider) || typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try {url = new URL(value);} catch {return false;}
  const params = url.searchParams;
  const expected = ['provider', 'redirect_to', 'code_challenge', 'code_challenge_method'];
  const accountChoice = params.has('prompt');
  if (accountChoice && (!['github', 'google'].includes(provider) || params.getAll('prompt').length !== 1 || params.get('prompt') !== 'select_account')) return false;
  const codeChallenge = params.get('code_challenge');
  return url.origin === supabaseOrigin && url.pathname === '/auth/v1/authorize' && !url.username && !url.password && !url.hash &&
    params.size === expected.length + Number(accountChoice) && expected.every(name => params.getAll(name).length === 1) &&
    params.get('provider') === provider && params.get('redirect_to') === callbackUrl && challenge.test(codeChallenge ?? '') &&
    Buffer.from(codeChallenge, 'base64url').toString('base64url') === codeChallenge && ['s256', 'S256'].includes(params.get('code_challenge_method'));
}

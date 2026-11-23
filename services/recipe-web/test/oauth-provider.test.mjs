import test from 'node:test';
import assert from 'node:assert/strict';
import {oauthProviders, oauthCallback, validOAuthAuthorizeUrl} from '../oauth-provider.mjs';

const supabaseOrigin = 'https://issuer.example';
const callbackUrl = 'https://accounts.example/auth/native/callback';
const challenge = Buffer.alloc(32, 7).toString('base64url');
const authorize = (provider, extra = {}) => {
  const url = new URL('/auth/v1/authorize', supabaseOrigin);
  url.search = new URLSearchParams({provider, redirect_to: callbackUrl, code_challenge: challenge, code_challenge_method: 's256', ...extra});
  return url;
};

test('only explicitly configured supported OAuth providers are selectable', () => {
  assert.deepEqual(oauthProviders(['github', 'google', 'apple', 'phone', 'unknown', 'github']), ['github', 'google', 'apple']);
  assert.deepEqual(oauthProviders(['github']), ['github']);
  assert.deepEqual(oauthProviders(['GOOGLE', null, {}, 1]), []);
  assert.deepEqual(oauthProviders(undefined), []);
});

test('callbacks distinguish a bounded single code from provider denial without exposing descriptions', () => {
  assert.deepEqual(oauthCallback(new URL('https://accounts.example/auth/callback?code=opaque-code')), {kind: 'code', code: 'opaque-code'});
  for (const error of ['access_denied', 'user_cancelled_authorize']) {
    assert.deepEqual(oauthCallback(new URL('https://accounts.example/auth/callback?' + new URLSearchParams({error, error_description: 'private upstream detail'}))), {kind: 'cancelled'});
  }
  assert.deepEqual(oauthCallback(new URL('https://accounts.example/auth/callback?error=server_error&error_code=provider_error')), {kind: 'failed'});
});

test('ambiguous, malformed or mixed callback parameters cannot exchange a code', () => {
  for (const query of ['', '?code=', '?code=one&code=two', '?code=one&error=access_denied', '?code=one&next=https://evil.example',
    '?error=access_denied&error=server_error', '?error=access_denied&next=/library', '?code=%00', '?code=%0a', '?code=' + 'a'.repeat(2049), '?code=one#fragment']) {
    assert.deepEqual(oauthCallback(new URL('https://accounts.example/auth/callback' + query)), {kind: 'failed'}, query.slice(0, 100));
  }
});

test('all three providers retain the exact issuer, callback and PKCE challenge', () => {
  for (const provider of ['github', 'google', 'apple']) {
    assert.equal(validOAuthAuthorizeUrl(authorize(provider).href, {provider, supabaseOrigin, callbackUrl}), true);
    assert.equal(validOAuthAuthorizeUrl(authorize(provider, {prompt: 'select_account'}).href, {provider, supabaseOrigin, callbackUrl}), provider !== 'apple');
  }
});

test('native authorization rejects provider/callback substitution, extra fields and noncanonical challenges', () => {
  const expected = {provider: 'google', supabaseOrigin, callbackUrl};
  for (const value of [
    authorize('github').href, authorize('google', {redirect_to: 'https://evil.example/callback'}).href,
    authorize('google', {redirect_to: callbackUrl + '?returnTo=/account'}).href,
    authorize('google', {code_challenge: 'invalid'}).href,
    authorize('google', {code_challenge: challenge.slice(0, -1) + 'd'}).href,
    authorize('google', {prompt: 'none'}).href, authorize('google', {unknown: 'injected'}).href,
    authorize('google').href + '&provider=apple', authorize('google').href + '#fragment',
    authorize('google').href.replace('https://issuer.example', 'https://issuer.example.evil.test'),
    authorize('google').href.replace('https://issuer.example', 'https://user:secret@issuer.example'),
  ]) assert.equal(validOAuthAuthorizeUrl(value, expected), false, value);
});

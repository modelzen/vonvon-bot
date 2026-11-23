import { describe, expect, it } from 'vitest';
import { accountAvatarDataUrlSchema, accountAvatarMaxBytes, accountAvatarUrlSchema, accountStatusSchema } from '../src/desktop-account.js';

describe('desktop account avatars', () => {
  it.each([
    'https://avatars.githubusercontent.com/u/123?v=4&s=96',
    'https://lh3.googleusercontent.com/a/abc=s96-c',
    'https://lh6.googleusercontent.com/a-/abc?sz=96',
  ])('accepts the public profile avatar URL %s', value => {
    expect(accountAvatarUrlSchema.parse(value)).toBe(value);
  });

  it.each([
    'https://example.com/user.png', 'http://avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com:444/u/1', 'https://user:secret@avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com.evil.example/u/1', 'https://lh3.googleusercontent.com.evil.example/a/abc',
    'https://googleusercontent.com/a/abc', 'https://anything.googleusercontent.com/a/abc',
    'https://127.0.0.1/u/1', 'https://[::1]/u/1', 'https://2130706433/u/1',
    'https://avatars.githubusercontent.com/u/1?access_token=secret', 'https://lh3.googleusercontent.com/a/abc?token=secret',
    'https://avatars.githubusercontent.com/u/1?v=4&v=5', 'https://avatars.githubusercontent.com/u/1?s=999999',
    'https://avatars.githubusercontent.com/u/1#secret',
  ])('refuses untrusted or credential-bearing avatar URL %s', value => {
    expect(accountAvatarUrlSchema.safeParse(value).success).toBe(false);
  });

  it('accepts only bounded raster data URLs in the signed-in IPC status', () => {
    const status = { kind: 'signedIn', accountId: '00000000-0000-4000-8000-000000000001', displayName: 'Example',
      provider: 'github', persistence: 'secure' };
    expect(accountStatusSchema.safeParse({ ...status, avatarDataUrl: 'data:image/png;base64,YQ==' }).success).toBe(true);
    for (const value of ['data:image/svg+xml;base64,YQ==', 'data:image/gif;base64,YQ==', 'data:text/html;base64,YQ==',
      'data:image/png;base64,', 'data:image/png;base64,not base64', 'https://avatars.githubusercontent.com/u/1',
      'data:image/png;base64,' + Buffer.alloc(accountAvatarMaxBytes + 1).toString('base64')]) {
      expect(accountAvatarDataUrlSchema.safeParse(value).success).toBe(false);
      expect(accountStatusSchema.safeParse({ ...status, avatarDataUrl: value }).success).toBe(false);
    }
    expect(accountAvatarDataUrlSchema.safeParse('data:image/webp;base64,' + Buffer.alloc(accountAvatarMaxBytes).toString('base64')).success).toBe(true);
  });
});


it('accepts all 60 Unicode nickname characters supported by account profiles', () => {
  const status = {kind: 'signedIn', accountId: '11111111-1111-4111-8111-111111111111', displayName: '🦉'.repeat(60), provider: 'github', persistence: 'secure'};
  expect(accountStatusSchema.safeParse(status).success).toBe(true);
  expect(accountStatusSchema.safeParse({...status, displayName: '🦉'.repeat(81)}).success).toBe(false);
});

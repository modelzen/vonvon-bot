import { expect, it, vi } from 'vitest';
import { createRateLimiter, LIMITS } from '../src/remote/rate-limit';

const clock = () => { let at = 1_000_000; return { now: () => at, pass: (ms: number) => { at += ms; } }; };

// D3 第 5 节 / devices 4.3: main 必败, there was no rate limiter.
it('allows 4 unauthenticated connections per IP and 32 in all', () => {
  const limiter = createRateLimiter();
  for (let n = 0; n < 4; n++) expect(limiter.connectionOpened('192.0.2.1')).toBe('ok');
  expect(limiter.connectionOpened('192.0.2.1')).toBe('too_many');
  limiter.connectionClosed('192.0.2.1', false);
  expect(limiter.connectionOpened('192.0.2.1')).toBe('ok');
  // an authenticated one frees its place; its close does not free another
  limiter.connectionAuthenticated('192.0.2.1');
  limiter.connectionClosed('192.0.2.1', true);
  expect(limiter.connectionOpened('192.0.2.1')).toBe('ok');
  limiter.connectionClosed('192.0.2.1', false);
  const all = createRateLimiter();
  for (let ip = 0; ip < 8; ip++) for (let n = 0; n < 4; n++) expect(all.connectionOpened(`192.0.2.${ip}`)).toBe('ok');
  expect(all.connectionOpened('192.0.2.200')).toBe('too_many');
  expect(LIMITS).toMatchObject({ perIp: 4, total: 32 });
});
it('bans an IP for 60 s on its 21st handshake in a minute, and does not count a valid invite', () => {
  const time = clock();
  const onBan = vi.fn();
  const limiter = createRateLimiter({ now: time.now, onBan });
  for (let n = 0; n < 20; n++) expect(limiter.handshakeStarted('192.0.2.1', 'private')).toBe('ok');
  expect(limiter.handshakeStarted('192.0.2.1', 'private')).toBe('rate_limited');
  expect(onBan).toHaveBeenCalledTimes(1);
  expect(onBan).toHaveBeenCalledWith('192.0.2.1');
  expect(limiter.handshakeStarted('192.0.2.2', 'private')).toBe('ok');
  time.pass(59_000);
  expect(limiter.isBanned('192.0.2.1')).toBe(true);
  expect(limiter.handshakeStarted('192.0.2.1', 'private')).toBe('rate_limited');
  expect(onBan).toHaveBeenCalledTimes(1);
  time.pass(2_000);
  expect(limiter.handshakeStarted('192.0.2.1', 'private')).toBe('ok');

  const invited = createRateLimiter({ now: time.now });
  for (let n = 0; n < 15; n++) { invited.handshakeStarted('192.0.2.3', 'private'); invited.handshakeFailed('192.0.2.3', 'unknown_client', true); invited.handshakeFailed('192.0.2.3', 'pairing_failed', true); }
  expect(invited.handshakeStarted('192.0.2.3', 'private')).toBe('ok');
  const unknown = createRateLimiter({ now: time.now });
  for (let n = 0; n < 10; n++) { unknown.handshakeStarted('192.0.2.4', 'private'); unknown.handshakeFailed('192.0.2.4', 'unknown_client', false); }
  expect(unknown.handshakeStarted('192.0.2.4', 'private')).toBe('rate_limited');
});
it('takes 10 handshakes a second in all on an exposed address, and none of that on a private one', () => {
  const time = clock();
  const limiter = createRateLimiter({ now: time.now });
  const exposed = Array.from({ length: 20 }, (_, ip) => limiter.handshakeStarted(`198.51.100.${ip}`, 'exposed'));
  expect(exposed.indexOf('rate_limited')).toBe(10);
  expect(exposed.slice(10).every(result => result === 'rate_limited')).toBe(true);
  expect(Array.from({ length: 20 }, (_, ip) => limiter.handshakeStarted(`192.0.2.${ip}`, 'private')).every(result => result === 'ok')).toBe(true);
  time.pass(1_001);
  expect(limiter.handshakeStarted('198.51.100.50', 'exposed')).toBe('ok');
});

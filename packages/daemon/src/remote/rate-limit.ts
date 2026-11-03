/** devices 4.3 (SEC-7): the limits a remote connection meets before any DH. All in memory, gone on a restart; no timer,
 * old entries are dropped as `now()` passes them. */
export interface RateLimiter {
  /** A connection not authenticated yet: at most 4 per IP and 32 in all, else `too_many`. */
  connectionOpened(ip: string): 'ok' | 'too_many';
  /** Past its hello: it no longer counts against the unauthenticated limit. */
  connectionAuthenticated(ip: string): void;
  connectionClosed(ip: string, authenticated: boolean): void;
  /** A banned IP, an empty bucket (which bans it for 60 s) or, on an exposed address, 10 handshakes in the last second. */
  handshakeStarted(ip: string, exposure: 'private' | 'exposed'): 'ok' | 'rate_limited';
  /** A failure takes another token, except an unknown key or a refused pairing that named a valid invite: the owner
   * retrying a link does not lock himself out. */
  handshakeFailed(ip: string, reason: 'handshake_failed' | 'unknown_client' | 'pairing_failed', validInvite: boolean): void;
  isBanned(ip: string): boolean;
}
export const LIMITS = { perIp: 4, total: 32, perMinute: 20, banMs: 60_000, exposedPerSecond: 10 } as const;
/** Entries kept before a sweep drops the idle ones (a full bucket, no ban). */
const SWEEP_AT = 1024;

export function createRateLimiter(opts: { now?: () => number; onBan?: (ip: string) => void } = {}): RateLimiter {
  const now = opts.now ?? Date.now;
  const open = new Map<string, number>();
  let openTotal = 0;
  const buckets = new Map<string, { tokens: number; at: number; bannedUntil: number }>();
  let exposed: number[] = [];
  const refill = (ip: string): { tokens: number; at: number; bannedUntil: number } => {
    const at = now();
    const bucket = buckets.get(ip) ?? { tokens: LIMITS.perMinute, at, bannedUntil: 0 };
    bucket.tokens = Math.min(LIMITS.perMinute, bucket.tokens + (at - bucket.at) * LIMITS.perMinute / 60_000);
    bucket.at = at;
    buckets.set(ip, bucket);
    return bucket;
  };
  const sweep = (): void => {
    if (buckets.size < SWEEP_AT) return;
    const at = now();
    for (const [ip, bucket] of buckets) {
      if (bucket.bannedUntil <= at && bucket.tokens + (at - bucket.at) * LIMITS.perMinute / 60_000 >= LIMITS.perMinute) buckets.delete(ip);
    }
  };
  /** One token, or a 60-second ban (told once) when the bucket is empty. */
  const take = (ip: string): boolean => {
    const bucket = refill(ip);
    if (bucket.bannedUntil > bucket.at) return false;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return true; }
    bucket.bannedUntil = bucket.at + LIMITS.banMs;
    opts.onBan?.(ip);
    return false;
  };
  const isBanned = (ip: string): boolean => (buckets.get(ip)?.bannedUntil ?? 0) > now();
  const leaveUnauthenticated = (ip: string): void => {
    const count = open.get(ip) ?? 0;
    if (count === 0) return;
    if (count === 1) open.delete(ip); else open.set(ip, count - 1);
    openTotal -= 1;
  };
  return {
    connectionOpened(ip) {
      if (openTotal >= LIMITS.total || (open.get(ip) ?? 0) >= LIMITS.perIp) return 'too_many';
      open.set(ip, (open.get(ip) ?? 0) + 1);
      openTotal += 1;
      return 'ok';
    },
    connectionAuthenticated: leaveUnauthenticated,
    connectionClosed(ip, authenticated) { if (!authenticated) leaveUnauthenticated(ip); },
    handshakeStarted(ip, exposure) {
      sweep();
      if (isBanned(ip) || !take(ip)) return 'rate_limited';
      if (exposure === 'exposed') {
        const at = now();
        exposed = exposed.filter(time => time > at - 1_000);
        if (exposed.length >= LIMITS.exposedPerSecond) return 'rate_limited';
        exposed.push(at);
      }
      return 'ok';
    },
    handshakeFailed(ip, reason, validInvite) {
      if (validInvite && reason !== 'handshake_failed') return;
      if (!isBanned(ip)) take(ip);
    },
    isBanned,
  };
}

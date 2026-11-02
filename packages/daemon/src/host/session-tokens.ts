import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Where a Bot session runs: a private chat, a group, or a document's comments (devices 5.1). */
export type SessionPlace = 'dm' | 'group' | 'comment';
/** What a session token stands for (devices 5.3): which bot, where, and which session; the host keeps it in memory only. */
export interface SessionRecord { appId: string; chatId?: string; place: SessionPlace; threadId?: string; sessionId: string; issuedAt: number; lastUsedAt: number }
export type SessionInput = Omit<SessionRecord, 'issuedAt' | 'lastUsedAt'>;
export interface SessionTokens {
  /** `vs1.<sessionId>.<32 random bytes, base64url>`; issuing again for a sessionId replaces its token. */
  issue(input: SessionInput): string;
  /** The record, its use noted; undefined for a malformed, unknown, wrong or idle (24 h) token, which last one is dropped. */
  resolve(token: string): SessionRecord | undefined;
  revoke(sessionId: string): void;
  /** A bot process exited: all its sessions end with it. */
  revokeAll(appId: string): void;
  size(): number;
}

export const SESSION_ID_RE = /^ses_[0-9a-f]{16}$/;
export const SESSION_TOKEN_RE = /^vs1\.(ses_[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
/** The hello's credential is a session token, not the owner's: the daemon tells them by this prefix (devices 4.5). */
export const SESSION_TOKEN_PREFIX = 'vs1.';
export function looksLikeSessionToken(value: string | undefined): value is string {
  return value !== undefined && SESSION_TOKEN_RE.test(value);
}
export const SESSION_IDLE_MS = 86_400_000;

const digest = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/**
 * The host's session tokens (devices-4a 4.1): never written to disk and never logged; only the sessionId is. The secret is
 * kept as its sha256 and compared in constant time, so the table holds nothing a log or a dump could replay.
 */
export function createSessionTokens(opts: { now?: () => number; idleMs?: number } = {}): SessionTokens {
  const now = opts.now ?? Date.now;
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  const records = new Map<string, { record: SessionRecord; secret: Buffer }>();
  return {
    issue(input) {
      if (!SESSION_ID_RE.test(input.sessionId)) throw new Error('Invalid session id');
      const secret = randomBytes(32).toString('base64url');
      const at = now();
      // A revoke lost with its IPC message would leave a record behind: the idle ones go as new ones come.
      for (const [id, entry] of records) if (at - entry.record.lastUsedAt > idleMs) records.delete(id);
      records.set(input.sessionId, { record: { ...input, issuedAt: at, lastUsedAt: at }, secret: digest(secret) });
      return `${SESSION_TOKEN_PREFIX}${input.sessionId}.${secret}`;
    },
    resolve(token) {
      const match = SESSION_TOKEN_RE.exec(token);
      if (!match) return undefined;
      const [, sessionId, secret] = match as unknown as [string, string, string];
      const entry = records.get(sessionId);
      if (!entry || !timingSafeEqual(entry.secret, digest(secret))) return undefined;
      const at = now();
      if (at - entry.record.lastUsedAt > idleMs) { records.delete(sessionId); return undefined; }
      entry.record.lastUsedAt = at;
      return { ...entry.record };
    },
    revoke(sessionId) { records.delete(sessionId); },
    revokeAll(appId) { for (const [id, entry] of records) if (entry.record.appId === appId) records.delete(id); },
    size() { return records.size; },
  };
}

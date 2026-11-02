import { describe, expect, it } from 'vitest';
import { createSessionTokens, looksLikeSessionToken, SESSION_IDLE_MS, SESSION_TOKEN_RE } from '../src/host/session-tokens';

/** devices-4a 4.1: the host's Bot-session tokens. main 必败: there were none. */
describe('session tokens', () => {
  const clock = () => { let at = 1_000; return { now: () => at, advance: (ms: number) => { at += ms; } }; };
  const group = { appId: 'cli_x', place: 'group' as const, chatId: 'oc_y', sessionId: 'ses_0123456789abcdef' };

  it('issues vs1 tokens that resolve to their session until revoked', () => {
    const tokens = createSessionTokens();
    const token = tokens.issue(group);
    expect(token).toMatch(SESSION_TOKEN_RE);
    expect(looksLikeSessionToken(token)).toBe(true);
    expect(tokens.resolve(token)).toMatchObject(group);
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    expect(tokens.resolve(`${token.slice(0, -1)}${last}`)).toBeUndefined();
    expect(tokens.resolve('vs1.ses_0123456789abcdef.short')).toBeUndefined();
    tokens.revoke(group.sessionId);
    expect(tokens.resolve(token)).toBeUndefined();
    expect(tokens.size()).toBe(0);
  });

  it('ends a bot\'s sessions together, and only that bot\'s', () => {
    const tokens = createSessionTokens();
    const a = tokens.issue(group);
    const b = tokens.issue({ ...group, sessionId: 'ses_1111111111111111', place: 'dm', chatId: 'oc_dm' });
    const other = tokens.issue({ appId: 'cli_z', place: 'comment', sessionId: 'ses_2222222222222222' });
    tokens.revokeAll('cli_x');
    expect([tokens.resolve(a), tokens.resolve(b)]).toEqual([undefined, undefined]);
    expect(tokens.resolve(other)).toMatchObject({ appId: 'cli_z', place: 'comment' });
  });

  it('drops a token unused for 24 hours; use keeps it alive', () => {
    const time = clock();
    const tokens = createSessionTokens({ now: time.now });
    const token = tokens.issue(group);
    time.advance(SESSION_IDLE_MS - 1);
    expect(tokens.resolve(token)).toBeDefined();
    time.advance(SESSION_IDLE_MS);
    expect(tokens.resolve(token)).toBeDefined();
    time.advance(SESSION_IDLE_MS + 1_000);
    expect(tokens.size()).toBe(1);
    expect(tokens.resolve(token)).toBeUndefined();
    expect(tokens.size()).toBe(0);
  });

  // D4a review SEC-1/R5: a connection made with a token must learn that its session ended
  it('tells who listens which sessions ended, and keeps an active session alive while it is used', () => {
    const time = clock();
    const tokens = createSessionTokens({ now: time.now });
    const ended: string[] = [];
    const stop = tokens.onEnd(sessionId => ended.push(sessionId));
    tokens.issue(group);
    tokens.issue({ ...group, sessionId: 'ses_1111111111111111' });
    tokens.issue({ appId: 'cli_z', place: 'comment', sessionId: 'ses_2222222222222222' });
    expect(tokens.active(group.sessionId)).toBe(true);
    tokens.revoke(group.sessionId);
    tokens.revoke(group.sessionId);
    expect(tokens.active(group.sessionId)).toBe(false);
    tokens.issue({ ...group, sessionId: 'ses_1111111111111111' });
    tokens.revokeAll('cli_z');
    expect(ended).toEqual([group.sessionId, 'ses_1111111111111111', 'ses_2222222222222222']);
    // a request is a use; a look (a snapshot pushed) is not
    time.advance(SESSION_IDLE_MS - 1);
    expect(tokens.active('ses_1111111111111111', true)).toBe(true);
    time.advance(SESSION_IDLE_MS - 1);
    expect(tokens.active('ses_1111111111111111')).toBe(true);
    time.advance(2);
    expect(tokens.active('ses_1111111111111111')).toBe(false);
    expect(ended.at(-1)).toBe('ses_1111111111111111');
    stop();
    tokens.issue(group);
    tokens.revoke(group.sessionId);
    expect(ended).toHaveLength(4);
  });

  it('replaces a session\'s token when issued again, and refuses a malformed session id', () => {
    const tokens = createSessionTokens();
    const first = tokens.issue(group);
    const second = tokens.issue(group);
    expect(tokens.resolve(first)).toBeUndefined();
    expect(tokens.resolve(second)).toMatchObject({ sessionId: group.sessionId });
    expect(() => tokens.issue({ ...group, sessionId: 'ses_bad' })).toThrow();
    for (const value of [undefined, '1', 'vs1.bad', `vs1.ses_0123456789abcdef.${'a'.repeat(42)}`]) expect(looksLikeSessionToken(value)).toBe(false);
  });
});

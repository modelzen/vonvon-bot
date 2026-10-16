import { describe, expect, it } from 'vitest';
import { isTopicReply, reachedAt, type MessageMeta } from '../src/bot/recall';

// Which sessions a recalled message reached (s15): delivered marks, the
// watermark, the topic registry's first-message time and the session's `from`.
describe('reachedAt', () => {
  const main = (extra: object = {}) => ({ threadId: 'oc_chat', lastSeenAt: 1000, ...extra });
  const topic = (extra: object = {}) => ({ threadId: 'omt_t', lastSeenAt: 1000, from: 100, ...extra });
  const line = (at: number, extra: Partial<MessageMeta> = {}): MessageMeta => ({ at, from: 'user', ...extra });

  it('takes a delivered message at its mark, even when the lookup failed', () => {
    expect(reachedAt(main({ seen: [{ id: 'om_t', at: 1500 }] }), 'oc_chat', 'om_t', undefined, undefined)).toBe(1500);
    expect(reachedAt(main(), 'oc_chat', 'om_t', undefined, undefined)).toBeUndefined();
  });

  it('gives a main session the main-area lines under its watermark and since its from, never a topic reply', () => {
    expect(reachedAt(main(), 'oc_chat', 'om_x', line(900), undefined)).toBe(900);
    expect(reachedAt(main(), 'oc_chat', 'om_x', line(1001), undefined)).toBeUndefined();
    expect(reachedAt(main({ from: 950 }), 'oc_chat', 'om_x', line(900), undefined)).toBeUndefined();
    // A topic's first message is a main-area line; a reply in it is not.
    expect(reachedAt(main(), 'oc_chat', 'om_root', line(900, { threadId: 'omt_t' }), undefined)).toBe(900);
    expect(reachedAt(main(), 'oc_chat', 'om_r', line(900, { threadId: 'omt_t', rootId: 'om_root' }), undefined)).toBeUndefined();
  });

  it("gives a topic session its own topic's messages, and the main lines its opening carried", () => {
    expect(reachedAt(topic(), 'oc_chat', 'om_r', line(900, { threadId: 'omt_t', rootId: 'om_root' }), 300)).toBe(900);
    expect(reachedAt(topic(), 'oc_chat', 'om_r', line(900, { threadId: 'omt_other', rootId: 'om_o' }), 300)).toBeUndefined();
    expect(reachedAt(topic(), 'oc_chat', 'om_m', line(200), 300)).toBe(200);
    expect(reachedAt(topic(), 'oc_chat', 'om_m', line(50), 300)).toBeUndefined(); // before the opening
    expect(reachedAt(topic(), 'oc_chat', 'om_m', line(400), 300)).toBeUndefined(); // after the topic opened
    expect(reachedAt(topic({ from: undefined }), 'oc_chat', 'om_m', line(200), 300)).toBeUndefined(); // a record from before s15
    expect(reachedAt(topic(), 'oc_chat', 'om_m', line(200), undefined)).toBeUndefined(); // not in the registry
  });

  it('tells a topic reply from a topic first message', () => {
    expect(isTopicReply(line(1, { threadId: 'omt_t', rootId: 'om_root' }), 'om_r')).toBe(true);
    expect(isTopicReply(line(1, { threadId: 'omt_t', rootId: 'om_root' }), 'om_root')).toBe(false);
    expect(isTopicReply(line(1, { threadId: 'omt_t' }), 'om_root')).toBe(false);
    expect(isTopicReply(line(1, { rootId: 'om_q' }), 'om_x')).toBe(false); // a reply chain in the main area
  });
});

import {expect, it} from 'vitest';
import {conversationTime} from '../src/conversation-time';

it('shows local clock time for today and preserves the full timestamp', () => {
  const value = new Date(2026, 9, 25, 10, 20).getTime();
  const time = conversationTime(value, new Date(2026, 9, 25, 10, 30).getTime());
  expect(time?.label).toBe('10:20');
  expect(time?.dateTime).toBe(new Date(value).toISOString());
  expect(time?.title).toContain('2026');
});

it('uses calendar days across midnight, month/year boundaries, and daylight saving', () => {
  for (const [now, yesterday] of [
    [new Date(2026, 9, 25, 0, 1), new Date(2026, 9, 24, 23, 59)],
    [new Date(2026, 0, 1, 12), new Date(2025, 11, 31, 0, 1)],
    [new Date(2026, 2, 9, 0, 1), new Date(2026, 2, 8, 0, 1)],
    [new Date(2026, 10, 2, 12), new Date(2026, 10, 1, 23, 59)],
  ]) expect(conversationTime(yesterday.getTime(), now.getTime())?.label).toBe('昨天');
});

it('shows dates for older or future days, including the year when needed', () => {
  const now = new Date(2026, 9, 25, 10, 30).getTime();
  expect(conversationTime(new Date(2026, 9, 23).getTime(), now)?.label).toBe('10月23日');
  expect(conversationTime(new Date(2025, 9, 23).getTime(), now)?.label).toBe('2025年10月23日');
  expect(conversationTime(new Date(2026, 9, 26).getTime(), now)?.label).toBe('10月26日');
});

it('omits invalid dates without throwing during rendering', () => {
  for (const value of [NaN, Infinity, -Infinity, 1e20]) expect(conversationTime(value)).toBeNull();
});

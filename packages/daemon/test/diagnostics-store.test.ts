import { afterEach, describe, expect, it, vi } from 'vitest';
import { botDiagnosticsSchema, type NotReplied } from '@vonvon/protocol';
import { createDiagnosticsStore, errorDetail, fitDetail, NOT_REPLIED_LIMIT, QUIET_LIMIT, parseDiagnosticsIpc, reportNotReplied, reportScopeDenied, setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';

const record = (fields: Partial<Omit<NotReplied, 'count'>> = {}): Omit<NotReplied, 'count'> =>
  ({ at: 1_000_000, groupId: 'oc_fixture_group', place: 'main', reason: 'signed-out', backend: 'codex', ref: 'abc123', ...fields });
const replied = (fields?: Partial<Omit<NotReplied, 'count'>>): DiagnosticsEvent => ({ kind: 'notReplied', record: record(fields) });

afterEach(() => { vi.useRealTimers(); setDiagnosticsSink(undefined); });

describe('diagnostics store', () => {
  it('merges the same group, place, reason and backend within 10 minutes into a count', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    store.accept('cli_a', replied());
    store.accept('cli_a', replied({ at: 1_000_000 + 9 * 60_000, sender: '某人', ref: 'def456' }));
    expect(store.view('cli_a')?.notReplied).toEqual([{ ...record({ at: 1_000_000 + 9 * 60_000, sender: '某人', ref: 'def456' }), count: 2 }]);
    store.accept('cli_a', replied({ at: 1_000_000 + 20 * 60_000 }));
    store.accept('cli_a', replied({ at: 1_000_000 + 20 * 60_000, reason: 'quota' }));
    store.accept('cli_a', replied({ at: 1_000_000 + 20 * 60_000, reason: 'quota', place: 'topic' }));
    store.accept('cli_a', replied({ at: 1_000_000 + 20 * 60_000, reason: 'quota', place: 'topic', backend: 'claude' }));
    expect(store.view('cli_a')?.notReplied.map(item => [item.reason, item.place, item.backend, item.count])).toEqual([
      ['quota', 'topic', 'claude', 1], ['quota', 'topic', 'codex', 1], ['quota', 'main', 'codex', 1], ['signed-out', 'main', 'codex', 1], ['signed-out', 'main', 'codex', 2],
    ]);
    expect(store.view('cli_b')).toBeUndefined();
  });

  it('merges into any matching record within 10 minutes as a new value, so the snapshot sees the count', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    store.accept('cli_a', replied());
    const before = store.view('cli_a');
    store.accept('cli_a', replied({ ref: 'def456' }));
    expect(before?.notReplied[0]?.count).toBe(1);
    store.accept('cli_a', replied({ groupId: 'oc_other_group' }));
    store.accept('cli_a', replied({ at: 1_000_000 + 60_000 }));
    expect(store.view('cli_a')?.notReplied.map(item => [item.groupId, item.count])).toEqual([['oc_fixture_group', 3], ['oc_other_group', 1]]);
  });

  it('keeps 30 records newest first, and each scope\'s latest denial within 24 hours', () => {
    let now = 5_000_000;
    const store = createDiagnosticsStore({ changed: () => {}, now: () => now });
    for (let i = 0; i < 35; i++) store.accept('cli_a', replied({ at: i * 11 * 60_000, ref: String(i) }));
    const records = store.view('cli_a')!.notReplied;
    expect(records).toHaveLength(30);
    expect([records[0]?.ref, records.at(-1)?.ref]).toEqual(['34', '5']);
    store.accept('cli_a', { kind: 'scopeDenied', denial: { scope: 'im:message:readonly', where: 'history', at: now - 1000 } });
    store.accept('cli_a', { kind: 'scopeDenied', denial: { scope: 'im:message:readonly', where: 'send', at: now } });
    store.accept('cli_a', { kind: 'scopeDenied', denial: { scope: 'im:chat:readonly', where: 'chat-info', at: now } });
    expect(store.view('cli_a')?.deniedScopes).toEqual([{ scope: 'im:chat:readonly', where: 'chat-info', at: now }, { scope: 'im:message:readonly', where: 'send', at: now }]);
    now += 24 * 60 * 60_000;
    expect(store.view('cli_a')?.deniedScopes).toEqual([]);
  });

  it('keeps at most 10 judgements that did not answer, so they never push out the failures (s25, s25b)', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    store.accept('cli_a', replied({ reason: 'quota' }));
    // Different groups, so none merge.
    for (let i = 0; i < 40; i++) store.accept('cli_a', replied({ groupId: `oc_${i}`, reason: (['judge-skip', 'judge-superseded', 'judge-empty'] as const)[i % 3], at: 1_000_000 + i }));
    const kept = store.view('cli_a')!.notReplied;
    expect(kept.filter(item => item.reason !== 'quota')).toHaveLength(QUIET_LIMIT);
    expect(kept[0]!.groupId).toBe('oc_39');
    expect(kept.at(-1)!.reason).toBe('quota');
    for (let i = 0; i < 40; i++) store.accept('cli_a', replied({ groupId: `oc_f${i}`, reason: 'failed' }));
    expect(store.view('cli_a')!.notReplied).toHaveLength(NOT_REPLIED_LIMIT);
  });

  it('counts another bot\'s @ past the cap, refused by a setting or dropped as quiet; a failed count is not (s27a-0)', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    store.accept('cli_a', replied({ reason: 'quota' }));
    for (let i = 0; i < 30; i++) store.accept('cli_a', replied({ groupId: `oc_${i}`, reason: (['bot-wake-cap', 'bot-wake-not-allowed', 'bot-wake-dropped'] as const)[i % 3], at: 1_000_000 + i }));
    expect(store.view('cli_a')!.notReplied.filter(item => item.reason !== 'quota')).toHaveLength(QUIET_LIMIT);
    for (let i = 0; i < 30; i++) store.accept('cli_a', replied({ groupId: `oc_w${i}`, reason: 'bot-wake-failed', at: 2_000_000 + i }));
    const failed = store.view('cli_a')!.notReplied;
    expect(failed).toHaveLength(NOT_REPLIED_LIMIT);
    expect(failed.every(item => item.reason === 'bot-wake-failed')).toBe(true);
  });

  it('drops a deleted bot, and refreshes the page at most once a second', () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const store = createDiagnosticsStore({ changed });
    for (let i = 0; i < 10; i++) store.accept('cli_a', replied({ at: i }));
    store.accept('cli_b', replied());
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenCalledOnce();
    store.retain(new Set(['cli_b']));
    expect([store.view('cli_a'), store.view('cli_b')?.notReplied.length]).toEqual([undefined, 1]);
    store.accept('cli_b', replied());
    store.close();
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('counts a record reported for several messages as that many (s18c)', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    store.accept('cli_a', { kind: 'notReplied', record: record({ reason: 'restarted' }), times: 3 });
    expect(store.view('cli_a')?.notReplied.map(item => item.count)).toEqual([3]);
    store.accept('cli_a', { kind: 'notReplied', record: record({ reason: 'restarted', at: 1_000_000 + 9 * 60_000 }), times: 2 });
    expect(store.view('cli_a')?.notReplied.map(item => item.count)).toEqual([5]);
    const seen: DiagnosticsEvent[] = [];
    setDiagnosticsSink(event => seen.push(event));
    reportNotReplied(record({ reason: 'restarted' }), 3);
    reportNotReplied(record({ reason: 'restarted' }), 1);
    expect(seen).toEqual([{ kind: 'notReplied', record: record({ reason: 'restarted' }), times: 3 }, { kind: 'notReplied', record: record({ reason: 'restarted' }) }]);
  });

  it('tells the login cache when a Claude turn failed for its login', () => {
    const claudeSignedOut = vi.fn();
    const store = createDiagnosticsStore({ changed: () => {}, claudeSignedOut, now: () => 5_000_000 });
    store.accept('cli_a', replied({ backend: 'codex' }));
    store.accept('cli_a', replied({ reason: 'quota', backend: 'claude' }));
    expect(claudeSignedOut).not.toHaveBeenCalled();
    store.accept('cli_a', replied({ backend: 'claude', at: 42 }));
    expect(claudeSignedOut).toHaveBeenCalledWith(5_000_000); // when it failed, not when the message was sent
  });
});

describe('diagnostics events', () => {
  it('accepts only well-formed IPC messages', () => {
    const event = replied();
    expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event })).toEqual(event);
    expect(parseDiagnosticsIpc({ fcb: 'fcb.connection' })).toBeUndefined();
    expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event: replied({ reason: 'no-such-reason' as never }) })).toBeUndefined();
    expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event: replied({ detail: 'x'.repeat(121) }) })).toBeUndefined();
    expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event: { kind: 'notReplied', record: { ...record(), text: 'message text' } } })).toBeUndefined();
    expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event: replied({ groupId: 'ou_person' }) })).toBeUndefined();
  });

  it('hands checked events to the sink, and never throws into a turn', () => {
    const seen: DiagnosticsEvent[] = [];
    setDiagnosticsSink(event => seen.push(event));
    reportNotReplied(record());
    reportNotReplied(record({ detail: 'x'.repeat(200) }));
    reportScopeDenied('im:message:readonly', 'names', 7);
    reportScopeDenied('im:message', 'send', 8); // not one the console check reads
    expect(seen).toEqual([replied(), { kind: 'scopeDenied', denial: { scope: 'im:message:readonly', where: 'names', at: 7 } }]);
    setDiagnosticsSink(() => { throw new Error('sink broke'); });
    expect(() => reportNotReplied(record())).not.toThrow();
  });

  it('keeps an error\'s first line without control characters, cut to 120', () => {
    expect(errorDetail(new Error('first\u0007 line\nsecond line'))).toBe('first line');
    expect(errorDetail('y'.repeat(300))).toHaveLength(120);
    expect(errorDetail(new Error(''))).toBeUndefined();
  });
});

it('accepts old snapshots and new bounded IPC, replaces live attention and clears it on restart', () => {
  expect(botDiagnosticsSchema.safeParse({ notReplied: [], deniedScopes: [] }).success).toBe(true);
  const store = createDiagnosticsStore({ changed: () => {} });
  const event: DiagnosticsEvent = { kind: 'attention', groups: [{ groupId: 'oc_a', main: { mode: 'watch', intervalMs: 60000 }, focusedTopics: 1, watchedTopics: 2, budget: { kind: 'no-glance', until: 123 } }] };
  expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event })).toEqual(event);
  expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event: { ...event, groups: [{ ...event.groups[0], focusedTopics: -1 }] } })).toBeUndefined();
  store.accept('a', event);
  store.accept('a', { kind: 'customPrompt', groupId: 'oc_a' });
  store.accept('a', { kind: 'customPrompt', groupId: 'oc_a' });
  expect(store.view('a')?.customPromptGroups).toEqual(['oc_a']);
  expect(botDiagnosticsSchema.safeParse(store.view('a')).success).toBe(true);
  expect(botDiagnosticsSchema.omit({attention: true, customPromptGroups: true}).parse(store.view('a'))).toEqual({notReplied: [], deniedScopes: []});
  store.accept('a', { kind: 'attention', groups: [] });
  expect(store.view('a')?.attention).toEqual([]);
  store.clearLive('a');
  expect(store.view('a')).toBeUndefined();
  store.close();
});

it('redacts diagnostics before shortening the detail', () => {
  const token = `vvs1_${'a'.repeat(43)}`;
  const prefix = 'x'.repeat(100);
  expect(fitDetail(token)).toBe('[已隐藏的 vonvon 令牌]');
  expect(errorDetail(new Error(token))).toBe('[已隐藏的 vonvon 令牌]');
  for (const detail of [fitDetail(`${prefix} ${token}`), errorDetail(new Error(`${prefix} ${token}`))]) {
    expect(detail).not.toContain('vvs1_');
    expect(detail).toContain('[已隐藏的 vonvon 令牌]');
    expect(detail!.length).toBeLessThanOrEqual(120);
  }
});

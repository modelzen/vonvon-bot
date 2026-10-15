import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotReplied } from '@vonvon/protocol';
import { createDiagnosticsStore, errorDetail, parseDiagnosticsIpc, reportNotReplied, reportScopeDenied, setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';

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

  it('tells the login cache when a Claude turn failed for its login', () => {
    const claudeSignedOut = vi.fn();
    const store = createDiagnosticsStore({ changed: () => {}, claudeSignedOut });
    store.accept('cli_a', replied({ backend: 'codex' }));
    store.accept('cli_a', replied({ reason: 'quota', backend: 'claude' }));
    expect(claudeSignedOut).not.toHaveBeenCalled();
    store.accept('cli_a', replied({ backend: 'claude', at: 42 }));
    expect(claudeSignedOut).toHaveBeenCalledWith(42);
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

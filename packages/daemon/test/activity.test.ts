import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_ACTIVITY_STALE_MS, BOT_LATEST_ACTION_SHOWN_MS, botDiagnosticsSchema, type BotActivity, type BotDecision } from '@vonvon/protocol';
import { createRunActivity } from '../src/bot/activity';
import { ACTIVITY_LIMIT, DECISION_LIMIT, createDiagnosticsStore, parseDiagnosticsIpc, setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';

let events: DiagnosticsEvent[];
const actions = () => events.flatMap(event => event.kind === 'activity' ? [event.activity] : []);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); events = []; setDiagnosticsSink(event => events.push(event)); });
afterEach(() => { setDiagnosticsSink(undefined); vi.useRealTimers(); });

describe('safe run activities', () => {
  it('requires explicit reasoning and text deltas, never assumes thinking while waiting for output', () => {
    const run = createRunActivity('oc_a');
    expect(actions().at(-1)?.phase).toBe('processing');
    run.accept({ type: 'turn_started', turnId: 'secret-turn' });
    expect(actions()).toHaveLength(1);
    run.accept({ type: 'thinking_delta', itemId: 'r', delta: 'PRIVATE REASONING' });
    expect(actions().at(-1)?.phase).toBe('thinking');
    for (let i = 0; i < 200; i++) run.accept({ type: 'thinking_delta', itemId: 'r', delta: 'SECRET' });
    expect(actions()).toHaveLength(2);
    run.accept({ type: 'thinking', itemId: 'r', text: 'PRIVATE REASONING' });
    expect(actions().at(-1)?.phase).toBe('processing');
    run.accept({ type: 'text_delta', itemId: 'm', delta: 'PRIVATE MESSAGE' });
    expect(actions().at(-1)?.phase).toBe('responding');
    run.accept({ type: 'text', itemId: 'm', text: 'PRIVATE MESSAGE' });
    expect(actions().at(-1)?.phase).toBe('processing');
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|secret-turn/);
    run.end();
  });

  it('tracks overlapping tools by id, avoids duplicate counts, and resets after the last result', () => {
    const run = createRunActivity('oc_a');
    const command = { type: 'tool_use', itemId: 'a', title: 'cat /private/secret', detail: 'TOKEN', kind: 'command' } as const;
    run.accept(command); run.accept(command);
    expect(actions().at(-1)).toMatchObject({ phase: 'tool', toolKind: 'command', activeToolCount: 1 });
    run.accept({ type: 'tool_use', itemId: 'b', title: 'search private query', kind: 'search' });
    expect(actions().at(-1)).toMatchObject({ phase: 'tool', toolKind: 'tool', activeToolCount: 2 });
    run.accept({ type: 'tool_result', itemId: 'a', output: 'PRIVATE OUTPUT' });
    expect(actions().at(-1)).toMatchObject({ phase: 'tool', toolKind: 'search', activeToolCount: 1 });
    run.accept({ type: 'tool_result', itemId: 'b' });
    expect(actions().at(-1)).toMatchObject({ phase: 'processing' });
    expect(actions().at(-1)).not.toHaveProperty('activeToolCount');
    expect(JSON.stringify(events)).not.toMatch(/private|TOKEN|OUTPUT/);
    run.end();
  });

  it('uses confirmed wait/compaction/retry states and removes failed or interrupted runs', () => {
    const run = createRunActivity('oc_a');
    run.accept({ type: 'tool_use', itemId: 'a', title: 'private', kind: 'file' });
    run.waiting(true);
    expect(actions().at(-1)?.phase).toBe('waiting');
    run.waiting(false);
    expect(actions().at(-1)?.phase).toBe('tool');
    run.accept({ type: 'tool_result', itemId: 'a' });
    run.accept({ type: 'compaction', phase: 'start' });
    expect(actions().at(-1)?.phase).toBe('compacting');
    run.accept({ type: 'compaction', phase: 'end' });
    expect(actions().at(-1)?.phase).toBe('processing');
    run.accept({ type: 'error', message: 'PRIVATE ERROR', willRetry: true });
    expect(actions().at(-1)?.phase).toBe('retrying');
    run.accept({ type: 'error', message: 'PRIVATE ERROR', willRetry: false });
    expect(events.at(-1)).toEqual({ kind: 'activityEnded', id: actions()[0]!.id });
    const count = events.length;
    run.accept({ type: 'text_delta', itemId: 'late', delta: 'LATE PRIVATE' }); run.waiting(true);
    run.end(); run.end(); vi.advanceTimersByTime(60_000);
    expect(events).toHaveLength(count);
    expect(JSON.stringify(events)).not.toContain('PRIVATE ERROR');
  });

  it('keeps running goal children through a parent turn boundary and cleans them on cancellation', () => {
    const run = createRunActivity('oc_a');
    run.accept({ type: 'subagent_step', id: 'child', stepId: 's', title: '/private/file', kind: 'file', status: 'running' });
    run.accept({ type: 'done', turnId: 't1' });
    expect(events.at(-1)?.kind).toBe('activity');
    expect(actions().at(-1)).toMatchObject({ phase: 'tool', activeToolCount: 1 });
    run.accept({ type: 'turn_started', turnId: 't2' });
    run.accept({ type: 'subagent_status', id: 'child', status: 'stopped' });
    expect(actions().at(-1)?.phase).toBe('processing');
    run.accept({ type: 'done', turnId: 't2' });
    expect(events.at(-1)?.kind).toBe('activityEnded');
    run.accept({ type: 'turn_started', turnId: 't3' });
    expect(actions().at(-1)?.phase).toBe('processing');
    run.end();
    expect(events.at(-1)?.kind).toBe('activityEnded');
  });

  it('renews a quiet live tool without inventing a newer action; stopped trackers cannot resurrect', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    setDiagnosticsSink(event => { events.push(event); store.accept('bot', event); });
    const run = createRunActivity('oc_a');
    run.accept({ type: 'tool_use', itemId: 'a', title: 'long command', kind: 'command' });
    const before = actions().at(-1)!;
    vi.advanceTimersByTime(90_000);
    expect(actions().at(-1)).toEqual(before);
    expect(store.view('bot')?.activities?.[0]).toMatchObject({ updatedAt: before.updatedAt, observedAt: Date.now(), phase: 'tool' });
    run.end(); const count = events.length;
    run.accept({ type: 'text_delta', itemId: 'late', delta: 'late' }); run.waiting(true);
    vi.advanceTimersByTime(90_000);
    expect(events).toHaveLength(count);
    expect(store.view('bot')?.activities).toEqual([]);
    store.close();
  });
});

describe('bounded home diagnostics', () => {
  const activity = (fields: Partial<BotActivity> = {}): BotActivity => ({ id: randomUUID(), groupId: 'oc_a', phase: 'processing', startedAt: Date.now(), updatedAt: Date.now(), ...fields });
  const decision = (fields: Partial<BotDecision> = {}): BotDecision => ({ id: randomUUID(), groupId: 'oc_a', place: 'main', decision: 'skip', trigger: 'focus', decidedAt: Date.now(), messageAt: 10, ...fields });

  it('terminates only the matching concurrent run, clears live state on restart, and preserves decision history', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    setDiagnosticsSink(event => store.accept('bot', event));
    const first = createRunActivity('oc_a'), second = createRunActivity('oc_b');
    const ids = store.view('bot')!.activities!.map(item => item.id);
    expect(ids).toHaveLength(2);
    first.end();
    expect(store.view('bot')!.activities).toHaveLength(1);
    const survivingId = store.view('bot')!.activities![0]!.id;
    store.accept('bot', { kind: 'activityEnded', id: ids.find(id => id !== survivingId)! });
    expect(store.view('bot')!.activities![0]!.id).toBe(survivingId);
    store.accept('bot', { kind: 'decision', decision: decision() });
    store.clearLive('bot');
    expect(store.view('bot')!.activities).toEqual([]);
    expect(store.view('bot')!.decisions).toHaveLength(1);
    second.end();
    expect(store.view('bot')!.activities).toEqual([]);
    store.retain(new Set()); expect(store.view('bot')).toBeUndefined(); store.close();
  });

  it('expires leases even when a provider timestamps an action in the future, and bounds both lists', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    for (let i = 0; i < 60; i++) store.accept('bot', { kind: 'activity', activity: activity({ updatedAt: Date.now() + i }) });
    for (let i = 0; i < 40; i++) store.accept('bot', { kind: 'decision', decision: decision({ decidedAt: Date.now() + i }) });
    expect(store.view('bot')!.activities).toHaveLength(ACTIVITY_LIMIT);
    expect(store.view('bot')!.decisions).toHaveLength(DECISION_LIMIT);
    expect(store.view('bot')!.decisions![0]!.decidedAt).toBe(Date.now() + 39);
    expect(botDiagnosticsSchema.safeParse(store.view('bot')).success).toBe(true);
    vi.advanceTimersByTime(BOT_ACTIVITY_STALE_MS);
    expect(store.view('bot')!.activities).toEqual([]);
    store.close();
  });

  it('rejects extra content at the IPC boundary rather than leaking it into a snapshot', () => {
    for (const event of [
      { kind: 'activity', activity: { ...activity(), title: 'private command' } },
      { kind: 'decision', decision: { ...decision(), reason: 'original message' } },
      { kind: 'decision', decision: { ...decision(), decision: 'completed' } },
    ]) expect(parseDiagnosticsIpc({ fcb: 'fcb.diagnostics', event })).toBeUndefined();
  });

  it('keeps only the newest successful action and expires it after five minutes', () => {
    const store = createDiagnosticsStore({ changed: () => {} });
    store.accept('bot', { kind: 'latestAction', action: { id: randomUUID(), groupId: 'oc_a', kind: 'replied', at: Date.now() } });
    store.accept('bot', { kind: 'latestAction', action: { id: randomUUID(), groupId: 'oc_b', kind: 'memory-saved', at: Date.now() - 1 } });
    expect(store.view('bot')?.latestAction).toMatchObject({ groupId: 'oc_a', kind: 'replied' });
    store.clearLive('bot');
    expect(store.view('bot')?.latestAction?.kind).toBe('replied');
    vi.advanceTimersByTime(BOT_LATEST_ACTION_SHOWN_MS);
    expect(store.view('bot')?.latestAction).toBeUndefined();
    store.close();
  });
});

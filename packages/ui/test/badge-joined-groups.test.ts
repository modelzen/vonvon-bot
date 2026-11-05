import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {agentIdSchema, groupIdSchema, type CommandResult} from '@vonvon/protocol';
import {badgeDirectoryFor} from '../src/useBadgeJoinedGroups';

const agent = agentIdSchema.parse('cli_badge');
const other = agentIdSchema.parse('cli_other');
const group = (id: string, bound = false) => ({id: groupIdSchema.parse('oc_' + id), name: id, bound});
const page = (names: string[], nextCursor?: string): CommandResult => ({
  kind: 'groups', groups: names.map(name => group(name, name === 'bound')), nextCursor,
});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { vi.useRealTimers(); });

it('reads all pages once and preserves both joined-only and bound groups over repeated snapshot refreshes', async () => {
  const run = vi.fn().mockResolvedValueOnce(page(['joined', 'bound'], 'two')).mockResolvedValueOnce(page(['bound', 'last']));
  const directory = badgeDirectoryFor({run});
  await Promise.all([directory.refresh(agent, true), directory.refresh(agent, true)]);
  vi.advanceTimersByTime(5_000);
  await directory.refresh(agent, true);
  expect(run.mock.calls).toEqual([
    [{type: 'listJoinedGroups', agentId: agent, summaryOnly: true}],
    [{type: 'listJoinedGroups', agentId: agent, summaryOnly: true, cursor: 'two'}],
  ]);
  expect(directory.snapshot().get(agent)).toEqual([group('joined'), group('bound', true), group('last')]);
});

it('keeps the last complete result on a repeated page token and distinguishes an empty list from failure', async () => {
  const run = vi.fn().mockResolvedValueOnce(page(['known'])).mockResolvedValueOnce(page(['partial'], 'loop'))
    .mockResolvedValueOnce(page([], 'loop')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([]));
  const directory = badgeDirectoryFor({run});
  await directory.refresh(agent, true);
  vi.advanceTimersByTime(60_000);
  await directory.refresh(agent, true);
  expect(directory.snapshot().get(agent)).toEqual([group('known')]);
  await directory.refresh(other, true);
  expect(directory.snapshot().has(other)).toBe(false);
  vi.advanceTimersByTime(60_000);
  await directory.refresh(other, true);
  expect(directory.snapshot().get(other)).toEqual([]);
});

it('uses the original request shape for a daemon that predates badge summaries', async () => {
  const run = vi.fn().mockResolvedValueOnce(page(['old-daemon']));
  await badgeDirectoryFor({run}).refresh(agent, false);
  expect(run).toHaveBeenCalledExactlyOnceWith({type: 'listJoinedGroups', agentId: agent});
});

it('keeps a late response on its own device even when both devices have the same bot ID', async () => {
  let resolve!: (result: CommandResult) => void;
  const previous = badgeDirectoryFor({run: vi.fn(() => new Promise<CommandResult>(r => { resolve = r; }))});
  const current = badgeDirectoryFor({run: vi.fn().mockResolvedValue(page(['current']))});
  const late = previous.refresh(agent, true);
  await current.refresh(agent, true);
  resolve(page(['previous']));
  await late;
  expect(previous.snapshot().get(agent)).toEqual([group('previous')]);
  expect(current.snapshot().get(agent)).toEqual([group('current')]);
});

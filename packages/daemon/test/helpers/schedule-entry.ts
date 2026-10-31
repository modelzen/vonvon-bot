import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createScheduleCommands } from '../../src/admin/schedule-commands';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../../src/agent/entry/registry';
import { createScheduleTools } from '../../src/agent/entry/schedule-tools';
import { toolReplyText, type AgentTool } from '../../src/agent/entry/tools';
import type { AgentThread } from '../../src/agent/types';
import type { RunNowResult, Scheduler } from '../../src/bot/schedule/scheduler';
import { createScheduleStore } from '../../src/bot/schedule/store';
import type { StoredTask } from '../../src/bot/schedule/types';

/** The schedule tools as an agent session meets them: the real registry, tools, command core and store on a temp file. */
export const MIN = 60_000;
export const NOW = Date.parse('2026-11-01T02:00:00Z'); // Sunday 10:00 in Shanghai
export const HOST = 'Asia/Shanghai', G = 'oc_group', OTHER = 'oc_other';
export const OWNER = 'ou_owner', ADMIN = 'ou_admin', MEMBER = 'ou_member';

export const stored = (id: string, patch: Partial<StoredTask> = {}): StoredTask => ({
  id, chatId: G, revision: `rev-${id}`, name: `任务 ${id}`, instruction: '看一下构建', spec: { kind: 'daily', time: '09:00' },
  timeZone: HOST, placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'chat', openId: MEMBER, role: 'member' },
  createdAt: NOW - 60 * MIN, updatedAt: NOW - 60 * MIN, cursor: NOW - 60 * MIN, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], ...patch,
});
export const human = (openId = OWNER, more: Partial<TurnFacts> = {}): TurnFacts => ({
  requesterOpenId: openId, requesterKind: 'user', triggerMessageId: 'om_trigger', retry: false, initiative: false, wake: false,
  typed: true, triggerText: '每天 9 点发日报', requesterName: '主人', ...more,
});
export function agentThread(): AgentThread {
  return {
    sessionId: 'fixture', isAlive: () => true, close: async () => {},
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {}, compact: async () => ({ compacted: false, usage: null }),
  };
}

const dirs: string[] = [];
export async function removeScheduleFixtures(): Promise<void> {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
}
/** `now` is the clock of the tools and the command core; `tools` sit beside the schedule tools in the same registry. */
export async function scheduleFixture(opts: { tasks?: StoredTask[]; place?: AgentPlace; runNow?: RunNowResult; now?: number; tools?: AgentTool[] } = {}) {
  const now = opts.now ?? NOW;
  const dir = await mkdtemp(join(tmpdir(), 'schedule-entry-')); dirs.push(dir);
  const file = join(dir, 'schedules.json');
  if (opts.tasks?.length) await writeFile(file, JSON.stringify({ version: 1, tasks: opts.tasks }));
  const store = createScheduleStore(file, { now: () => NOW, log: { info() {}, warn() {}, fail() {} }, diagnostics: () => {} });
  await store.load();
  const scheduler = { start: async () => {}, stop() {}, drain: async () => {}, wake() {}, runNow: () => opts.runNow ?? { kind: 'started', runId: 'run-1' } } satisfies Scheduler;
  const commands = createScheduleCommands({ store, scheduler, botId: 'bot-test', now: () => now, hostTimeZone: () => HOST });
  const core = commands.execute;
  const execute = vi.spyOn(commands, 'execute');
  const entries = createAgentEntries({ appId: 'bot-test', isAdmin: id => id === OWNER || id === ADMIN, isOwner: id => id === OWNER,
    tools: [...createScheduleTools({ commands, now: () => now, hostTimeZone: () => HOST }), ...opts.tools ?? []] });
  const entry = entries.issue(opts.place ?? { kind: 'group', chatId: G });
  const thread = agentThread();
  entry.attach(thread);
  let uses = 0;
  const call = (name: string, args: unknown = {}) => { const id = `use-${++uses}`; entry.noteToolUse(id); return entry.call(name, args, { toolUseId: id }); };
  return {
    /** The command core unwatched, for a test that holds a call back. */
    core, store, commands, execute, entries, entry, thread, call,
    open: (facts: TurnFacts = human()) => entries.openTurn(thread, facts),
    /** What the model reads back. */
    text: async (name: string, args: unknown = {}) => toolReplyText(await call(name, args)),
    /** The request the command core got last. */
    request: () => execute.mock.calls.at(-1)?.[1],
  };
}

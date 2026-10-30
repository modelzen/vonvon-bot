import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { ScheduleCommands } from '../../src/admin/schedule-commands';
import { CodexAppServerBackend } from '../../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../../src/agent/codex-appserver/client-pool';
import { createAgentEntries, type TurnFacts } from '../../src/agent/entry/registry';
import { createScheduleTools } from '../../src/agent/entry/schedule-tools';
import { sessionInfoTool } from '../../src/agent/entry/tools';
import type { SessionProfile } from '../../src/agent/session-profile';
import type { AgentRun } from '../../src/agent/types';
import { writeNodeExecutable } from './node-executable';

/**
 * A fake Codex app-server for the dynamic tools (定时任务 T3b). A turn's text, or a goal's objective, is a script
 * `{ calls: [{ tool, args?, threadId?, turnId? }], early? }`: each call is an `item/tool/call`, sent after the turn/start
 * answer (before it with `early`), and the turn completes once every call is answered. Starts, resumes and the
 * answers to the calls are written next to the script.
 */
const FAKE = `
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const fs = require('node:fs'), path = require('node:path');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const note = (file, value) => fs.appendFileSync(path.join(__dirname, file), JSON.stringify(value) + '\\n');
const waiting = new Map();
let turns = 0, calls = 0;
function script(threadId, turnId, text, done) {
  const { calls: list, early } = JSON.parse(text);
  let open = list.length;
  const requests = list.map(c => {
    const id = 'call-' + ++calls;
    waiting.set(id, () => { if (--open === 0) done(); });
    return { id, method: 'item/tool/call', params: { threadId: c.threadId || threadId, turnId: c.turnId || turnId,
      callId: 'c' + calls, namespace: 'vonvon_bot', tool: c.tool, arguments: c.args || {} } };
  });
  return { early, send: () => requests.forEach(send) };
}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), p = m.params || {};
  if (!m.method) { const answered = waiting.get(m.id); if (answered) { waiting.delete(m.id); note('answers', m); answered(); } return; }
  if (m.id === undefined) return;
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    note(m.method === 'thread/start' ? 'starts' : 'resumes', p);
    send({ id: m.id, result: { thread: { id: p.threadId || 'th' }, cwd: p.cwd, runtimeWorkspaceRoots: p.runtimeWorkspaceRoots,
      approvalPolicy: p.approvalPolicy, sandbox: { type: 'dangerFullAccess' } } });
  } else if (m.method === 'turn/start') {
    const turnId = 'turn-' + ++turns;
    const run = script(p.threadId, turnId, p.input[0].text, () => send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId } } }));
    if (run.early) run.send();
    send({ id: m.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId } } });
    if (!run.early) run.send();
  } else if (m.method === 'thread/goal/set') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: 'goal-turn' } } });
    script(p.threadId, 'goal-turn', p.objective, () => {
      send({ method: 'thread/goal/updated', params: { threadId: p.threadId, goal: { objective: p.objective, status: 'complete' } } });
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'goal-turn' } } });
    }).send();
  } else send({ id: m.id, result: {} });
});
setInterval(() => {}, 1 << 30);
`;

export const OWNER = 'ou_owner';
export const person = (openId: string, more: Partial<TurnFacts> = {}): TurnFacts => ({
  requesterOpenId: openId, requesterKind: 'user', triggerMessageId: `om_${openId}`, retry: false, initiative: false, wake: false, ...more,
});
export const profile = (schedule: boolean): SessionProfile => ({ instructions: '', env: {}, nativeSettings: { automaticMemory: false },
  additionalRoots: [], capabilityPackages: [], mcpServers: [], tools: { schedule } });
export type Call = { tool: string; args?: unknown; threadId?: string; turnId?: string };

const cleanups: (() => Promise<void> | void)[] = [];
export async function closeCodexToolFixtures(): Promise<void> {
  for (const close of cleanups.splice(0).reverse()) await close();
  await shutdownResidentClients();
  vi.unstubAllEnvs();
}

/** A real Codex backend and transport on the fake; the real registry with T3's schedule tools over a spied command core, and session_info, which Codex is not offered. */
export function codexToolsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tools-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  vi.stubEnv('CODEX_BIN', writeNodeExecutable(dir, 'codex', FAKE).bin);
  const execute = vi.fn<ScheduleCommands['execute']>(async () => ({ kind: 'tasks', tasks: [], now: 0, timeZone: 'Asia/Shanghai' }));
  const entries = createAgentEntries({ appId: 'bot', isAdmin: id => id === OWNER, isOwner: id => id === OWNER,
    tools: [sessionInfoTool, ...createScheduleTools({ commands: { execute }, now: () => 0, hostTimeZone: () => 'Asia/Shanghai' })] });
  const read = (file: string): Record<string, unknown>[] => {
    try { return readFileSync(join(dir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; }
  };
  async function drain(run: AgentRun) { for await (const _ of run.events) { /* the fake completes once its calls are answered */ } }
  async function open(how: 'start' | 'resume' = 'start', schedule = true) {
    const entry = entries.issue({ kind: 'group', chatId: 'oc_group' });
    const backend = new CodexAppServerBackend(), opts = { cwd: dir, entry, profile: profile(schedule) };
    const thread = how === 'start' ? await backend.startThread(opts) : await backend.resumeThread({ ...opts, sessionId: 'th' });
    entry.attach(thread);
    cleanups.push(() => thread.close());
    return {
      thread,
      /** One turn opened the way launchRun opens it, then its script. */
      async turn(facts: TurnFacts, calls: Call[], early = false) {
        const scope = entries.openTurn(thread, facts);
        await drain(thread.runStreamed({ text: JSON.stringify({ calls, early }) }));
        scope.close();
      },
      goal: (calls: Call[]) => drain(thread.runGoal(JSON.stringify({ calls }))),
    };
  }
  return {
    execute, open, starts: () => read('starts'), resumes: () => read('resumes'),
    /** The answers to the calls so far, in the order the calls were made: what the model read, and whether it failed. */
    answers: () => read('answers').sort((a, b) => Number(String(a.id).slice(5)) - Number(String(b.id).slice(5))).map(({ result }) => {
      const { contentItems, success } = result as { contentItems: { text: string }[]; success: boolean };
      return { text: contentItems.map(item => item.text).join(''), success };
    }),
  };
}

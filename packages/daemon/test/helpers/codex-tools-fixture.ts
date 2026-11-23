import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { ScheduleCommands } from '../../src/admin/schedule-commands';
import { CodexAppServerBackend } from '../../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../../src/agent/codex-appserver/client-pool';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../../src/agent/entry/registry';
import { feedbackTool } from '../../src/agent/entry/feedback-tool';
import { releaseCodeTools } from '../../src/agent/entry/release-code-tools';
import { createScheduleTools } from '../../src/agent/entry/schedule-tools';
import { sessionInfoTool } from '../../src/agent/entry/tools';
import type { SessionProfile } from '../../src/agent/session-profile';
import type { AgentRun } from '../../src/agent/types';
import { writeNodeExecutable } from './node-executable';

/**
 * A fake Codex app-server for the dynamic tools (定时任务 T3b). A turn's text, or a goal's objective, is a script
 * `{ calls: [{ tool, args?, threadId?, turnId? }], early? }`: each call is an `item/tool/call`, sent after the turn/start
 * answer (before it with `early`), and the turn completes once every call is answered. Session starts and resumes,
 * the answers to the calls and the pid of the process that ran a turn are written next to the script.
 */
const FAKE = `
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const fs = require('node:fs'), path = require('node:path');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const note = (file, value) => fs.appendFileSync(path.join(__dirname, file), JSON.stringify(value) + '\\n');
const waiting = new Map();
let turns = 0, calls = 0;
function script(threadId, turnId, text, done) {
  let instruction;
  try { instruction = JSON.parse(text); } catch {
    note('inputs', {threadId, text});
    // Ordinary orchestrator prompts ask the fake model to use only a tool its native rollout advertised.
    const rollout = path.join(__dirname, 'tools-' + threadId);
    const tools = fs.existsSync(rollout) ? JSON.parse(fs.readFileSync(rollout, 'utf8')) : [];
    const scripted = path.join(__dirname, 'next-turn');
    if (fs.existsSync(scripted)) {
      const planned = JSON.parse(fs.readFileSync(scripted, 'utf8'));
      fs.unlinkSync(scripted);
      instruction = {...planned, calls: planned.calls.filter(c => tools.some(ns => ns.tools.some(t => t.name === c.tool)))};
    } else instruction = {calls: text.includes('反馈测试') && tools.some(ns => ns.tools.some(t => t.name === 'feedback_prepare'))
      ? [{tool: 'feedback_prepare', args: {summary: {kind: 'bug', title: '标题', description: '说明'}}}] : []};
  }
  const { calls: list, early } = instruction;
  function finish() {
    const release = instruction.hold || (text.includes('hold-old-turn') && 'release-turn');
    if (!release) return done();
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(__dirname, release))) return;
      clearInterval(timer);
      done();
    }, 10);
  }
  let open = list.length;
  const requests = list.map((c, index) => {
    const id = 'call-' + ++calls;
    waiting.set(id, () => { if (--open === 0) finish(); else if (instruction.sequential) send(requests[index + 1]); });
    return { id, method: 'item/tool/call', params: { threadId: c.threadId || threadId, turnId: c.turnId || turnId,
      callId: 'c' + calls, namespace: c.namespace || 'vonvon_bot', tool: c.tool, arguments: c.args || {} } };
  });
  return {early, send: () => requests.length ? instruction.sequential ? send(requests[0]) : requests.forEach(send) : finish()};
}
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line), p = m.params || {};
  if (!m.method) { const answered = waiting.get(m.id); if (answered) { waiting.delete(m.id); note('answers', m); answered(); } return; }
  if (m.id === undefined) return;
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (!p.ephemeral) note(m.method === 'thread/start' ? 'starts' : 'resumes', p); // not the warm pool's thread
    const failStart = path.join(__dirname, 'fail-start');
    if (m.method === 'thread/start' && !p.ephemeral && fs.existsSync(failStart)) {
      fs.unlinkSync(failStart);
      return send({id: m.id, error: {code: -32000, message: 'fixture refused thread/start'}});
    }
    if (m.method === 'thread/start' && !p.ephemeral) fs.writeFileSync(path.join(__dirname, 'tools-th'), JSON.stringify(p.dynamicTools || []));
    send({ id: m.id, result: { thread: { id: p.threadId || 'th' }, cwd: p.cwd, runtimeWorkspaceRoots: p.runtimeWorkspaceRoots,
      approvalPolicy: p.approvalPolicy, sandbox: { type: 'dangerFullAccess' } } });
  } else if (m.method === 'turn/start') {
    note('pids', { pid: process.pid });
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
}).on('close', () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

export const OWNER = 'ou_owner';
export const person = (openId: string, more: Partial<TurnFacts> = {}): TurnFacts => ({
  requesterOpenId: openId, requesterKind: 'user', triggerMessageId: `om_${openId}`, retry: false, initiative: false, wake: false, ...more,
});
export const profile = (schedule: boolean): SessionProfile => ({ instructions: '', env: {}, nativeSettings: { automaticMemory: false },
  additionalRoots: [], capabilityPackages: [], mcpServers: [], tools: { schedule } });
export type Call = { tool: string; namespace?: string; args?: unknown; threadId?: string; turnId?: string };

const threads: (() => Promise<void>)[] = [];
const dirs: string[] = [];
/**
 * Every fake is stopped before its directory goes, the warm-pool one too: a fake whose script or note files are gone
 * exits with code 1, and the pool's shutdown that reports it is memoized, so every later test of the file fails too.
 * A failed step does not skip the others: the error is thrown once everything is stopped and removed.
 */
export async function closeCodexToolFixtures(): Promise<void> {
  const errors: unknown[] = [];
  for (const close of threads.splice(0).reverse()) await close().catch((error: unknown) => { errors.push(error); });
  await shutdownResidentClients().catch((error: unknown) => { errors.push(error); });
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, 'Codex tool fixture cleanup failed');
}

/** A real Codex backend and transport on the fake; the real registry with T3's schedule tools over a spied command core, and session_info, which Codex is not offered. */
export function codexToolsFixture(feedbackEnabled?: (chatId: string) => boolean, codeEnabled?: (chatId: string) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tools-'));
  dirs.push(dir);
  vi.stubEnv('CODEX_BIN', writeNodeExecutable(dir, 'codex', FAKE).bin);
  const execute = vi.fn<ScheduleCommands['execute']>(async () => ({ kind: 'tasks', tasks: [], now: 0, timeZone: 'Asia/Shanghai' }));
  const entries = createAgentEntries({ appId: 'bot', isAdmin: id => id === OWNER, feedbackEnabled, codeEnabled,
    tools: [sessionInfoTool, ...(feedbackEnabled ? [feedbackTool] : []), ...(codeEnabled ? releaseCodeTools() : []), ...createScheduleTools({ commands: { execute }, now: () => 0, hostTimeZone: () => 'Asia/Shanghai' })] });
  const read = (file: string): Record<string, unknown>[] => {
    try { return readFileSync(join(dir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; }
  };
  async function drain(run: AgentRun) { for await (const _ of run.events) { /* the fake completes once its calls are answered */ } }
  async function open(how: 'start' | 'resume' = 'start', schedule = true, place: AgentPlace = { kind: 'group', chatId: 'oc_group' }) {
    const entry = entries.issue(place);
    const backend = new CodexAppServerBackend(), opts = { cwd: dir, entry, profile: { ...profile(schedule), tools: { schedule, feedback: Boolean(feedbackEnabled), releaseCode: Boolean(place.chatId && codeEnabled?.(place.chatId)) } } };
    const thread = how === 'start' ? await backend.startThread(opts) : await backend.resumeThread({ ...opts, sessionId: 'th' });
    entry.attach(thread);
    threads.push(() => thread.close());
    return {
      thread, entry,
      /** One turn opened the way launchRun opens it, then its script; the turn closes however the run ends. */
      async turn(facts: TurnFacts, calls: Call[], early = false) {
        const scope = entries.openTurn(thread, facts);
        try { await drain(thread.runStreamed({ text: JSON.stringify({ calls, early }) })); }
        finally { scope.close(); }
      },
      goal: (calls: Call[]) => drain(thread.runGoal(JSON.stringify({ calls }))),
    };
  }
  let scripts = 0;
  return {
    seedTools(sessionId: string, names: string[]) {
      writeFileSync(join(dir, 'tools-' + sessionId), JSON.stringify([{namespace: 'vonvon_bot', tools: names.map(name => ({name}))}]));
    },
    scriptNext(calls: Call[], hold = false, options?: {sequential?: boolean}) {
      const release = 'release-script-' + ++scripts;
      writeFileSync(join(dir, 'next-turn'), JSON.stringify({calls, ...options, ...(hold ? {hold: release} : {})}));
      return () => writeFileSync(join(dir, release), '');
    },
    failNextStart: () => writeFileSync(join(dir, 'fail-start'), ''),
    execute, open, releaseTurn: () => writeFileSync(join(dir, 'release-turn'), ''), inputs: () => read('inputs'), starts: () => read('starts'), resumes: () => read('resumes'),
    /** The process that ran the latest turn. */
    pid: () => read('pids').at(-1)?.pid as number | undefined,
    /** The answers to the calls so far, in the order the calls were made: what the model read, and whether it failed. */
    answers: () => read('answers').sort((a, b) => Number(String(a.id).slice(5)) - Number(String(b.id).slice(5))).map(({ result }) => {
      const { contentItems, success } = result as { contentItems: { text: string }[]; success: boolean };
      return { text: contentItems.map(item => item.text).join(''), success };
    }),
  };
}

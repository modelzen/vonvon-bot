import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { loadBackendDep } from '../src/agent/backend-loader';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { AUTO_COMPACT_SETTINGS } from '../src/agent/claude-agent/thread';
import { createAgentEntries } from '../src/agent/entry/registry';
import type { AgentTool } from '../src/agent/entry/tools';
const live = process.env.CLAUDE_LIVE === '1';
it.runIf(live).each([
  ['qa', false], ['write', false], ['full', false], ['qa', true],
] as const)('real Claude entry: %s network=%s', { timeout: 180_000 }, async (mode, network) => {
  const root = await mkdtemp(join(tmpdir(), 's46-live-')), cwd = join(root, 'work'); await mkdir(cwd);
  const sdk = await loadBackendDep<typeof import('@anthropic-ai/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');
  let listed = false, calls = 0, callbacks = 0, matched = false, samePid = false;
  const ids = new Set<string>(), callbackIds = new Set<string>(), order: string[] = [];
  const parentPid = process.pid;
  const facade: ClaudeSdkFacade = { ...sdk, query: params => {
    const original = params.options?.canUseTool;
    const q = sdk.query({ ...params, options: { ...params.options, settingSources: [], strictMcpConfig: true,
      settings: { ...AUTO_COMPACT_SETTINGS, disableAllHooks: true },
      canUseTool: async (name, input, opts) => {
        if (name.startsWith('mcp__vonvon_bot__')) { callbacks++; callbackIds.add(opts.toolUseID); order.push('callback'); }
        if (!original) throw Error('missing production permission callback');
        return original(name, input, opts);
      } } });
    return new Proxy(q, { get(target, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        for await (const event of target) {
          if (event.type === 'system' && event.subtype === 'init') listed = event.tools.includes('mcp__vonvon_bot__session_info');
          yield event;
        }
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) satisfies Query;
  } };
  const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => true });
  const entry = entries.issue({ kind: 'p2p' }), call = entry.call.bind(entry), note = entry.noteToolUse.bind(entry);
  entry.noteToolUse = id => { ids.add(id); order.push('event'); note(id); };
  entry.call = async (name, args, origin) => {
    calls++; samePid = process.pid === parentPid; order.push('handler');
    matched = typeof origin?.toolUseId === 'string' && ids.has(origin.toolUseId)
      && (mode === 'full' || callbackIds.has(origin.toolUseId));
    return call(name, args, origin);
  };
  const thread = await new ClaudeAgentBackend(async () => facade, () => undefined).startThread({ cwd, mode, network, model: 'claude-haiku-5-5', entry });
  entry.attach(thread);
  const turn = entries.openTurn(thread, { requesterKind: 'user', requesterOpenId: 'fixture', triggerMessageId: 'm1', retry: false, initiative: false, wake: false });
  try {
    for await (const event of thread.runStreamed({ text: '调用 vonvon_bot 的 session_info 工具，然后只回 ok。不要调用别的工具。' }).events) {
      expect(event.type === 'error' && !event.willRetry).toBe(false);
    }
    expect(listed).toBe(true); expect(calls).toBeGreaterThan(0); expect(samePid).toBe(true); expect(matched).toBe(true);
    expect(callbacks > 0).toBe(mode !== 'full');
    console.log(JSON.stringify({ mode, network, listed, calls, callbacks, samePid, matched, order }));
  } finally { turn.close(); await thread.close(); entries.closeAll('shutdown'); }
});
it.runIf(live)('real Claude delayed T1 settings call cannot borrow T2', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 's46-turn-live-')); let commits = 0, invoked = false;
  let changed: (() => void) | undefined;
  let finished: (() => void) | undefined; const completed = new Promise<void>(resolve => { finished = resolve; });
  const tools: AgentTool[] = [{ name: 'probe_set', class: 'settings', description: 'Run the isolated authorization probe. Call once.', input: z.object({}),
    async run(_args, ctx) { invoked = true; changed?.(); await new Promise(resolve => setTimeout(resolve, 5_000)); try { return await ctx.commit?.(async () => { commits++; return {}; }); } finally { finished?.(); } } }];
  const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => true, tools });
  const entry = entries.issue({ kind: 'p2p' });
  const sdk = await loadBackendDep<ClaudeSdkFacade>('@anthropic-ai/claude-agent-sdk');
  const facade: ClaudeSdkFacade = { ...sdk, query: params => sdk.query({ ...params, options: { ...params.options, settingSources: [], strictMcpConfig: true, settings: { ...AUTO_COMPACT_SETTINGS, disableAllHooks: true } } }) };
  const thread = await new ClaudeAgentBackend(async () => facade, () => undefined).startThread({ cwd: root, mode: 'qa', model: 'claude-haiku-5-5', entry }); entry.attach(thread);
  const facts = { requesterKind: 'user' as const, requesterOpenId: 'fixture', triggerMessageId: 'm1', retry: false, initiative: false, wake: false };
  const first = entries.openTurn(thread, facts);
  changed = () => { first.close(); entries.openTurn(thread, { ...facts, triggerMessageId: 'm2' }); };
  try {
    for await (const event of thread.runStreamed({ text: 'Call mcp__vonvon_bot__probe_set exactly once. Do not retry and do not call other tools.' }).events) expect(event.type === 'error' && !event.willRetry).toBe(false);
    expect(invoked).toBe(true); await completed; expect(commits).toBe(0);
  } finally { entries.closeAll('shutdown'); await thread.close(); }
});

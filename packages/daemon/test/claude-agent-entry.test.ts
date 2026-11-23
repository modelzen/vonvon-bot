import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSdkMcpServer, tool, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { createAgentEntries } from '../src/agent/entry/registry';
import { feedbackTool } from '../src/agent/entry/feedback-tool';
import { releaseCodeTools } from '../src/agent/entry/release-code-tools';
import type { CodeSource } from '../src/release-code/host';
import { claudeAccess, decide } from '../src/agent/claude-agent/permission';
import type { AgentEntry, AgentThread, AgentToolReply } from '../src/agent/types';
const threads: AgentThread[] = [];
afterEach(async () => { await Promise.all(threads.splice(0).map(t => t.close())); vi.unstubAllEnvs(); });
function entry() {
  return { tools: () => [{ name: 'session_info', description: 'test', input: z.object({}) }],
    call: vi.fn<AgentEntry['call']>(async () => ({ ok: true, result: { v: 1 } })),
    noteToolUse: vi.fn(), attach: vi.fn(), revoke: vi.fn(), sessionId: 'ses_0123456789abcdef' } satisfies AgentEntry;
}
function fixture(withSdk = true, stream?: AsyncIterable<SDKMessage>) {
  let options: Options | undefined;
  const registered: string[] = [];
  const schemas = new Map<string, object>();
  const handlers = new Map<string,(args: object, extra: unknown) => Promise<unknown>>();
  let end: (() => void) | undefined;
  let invoke: ((args: object, extra: unknown) => Promise<unknown>) | undefined;
  const query = vi.fn<ClaudeSdkFacade['query']>(params => {
    options = params.options;
    return Object.assign((async function* (): AsyncGenerator<SDKMessage> { if (stream) yield* stream; await new Promise<void>(resolve => { end = resolve; }); })(),
      { close: () => end?.(), interrupt: async () => {} }) as unknown as Query;
  });
  const makeTool: typeof tool = (name, description, schema, handler, ...rest) => {
    registered.push(name);
    schemas.set(name, schema);
    invoke = (args, extra) => handler(args as never, extra as never);
    handlers.set(name, invoke);
    return tool(name, description, schema, handler, ...rest);
  };
  const sdk = { query, listSessions: vi.fn(), getSessionInfo: vi.fn(), getSessionMessages: vi.fn(), renameSession: vi.fn(),
    ...(withSdk ? { createSdkMcpServer, tool: makeTool } : {}) } satisfies ClaudeSdkFacade;
  return { registered, schemas, handlers, backend: new ClaudeAgentBackend(async () => sdk, () => undefined), query,
    options: () => options, invoke: (args: object, extra: unknown) => { if (!invoke) throw Error('missing handler'); return invoke(args, extra); } };
}
it('registers all optional diagnostic and suggestion fields with the actual Claude tool schema', async () => {
  const f = fixture();
  const grant = createAgentEntries({appId: 'fixture', isAdmin: () => false, feedbackEnabled: () => true,
    tools: [feedbackTool]}).issue({kind: 'group', chatId: 'oc_help'});
  const thread = await f.backend.startThread({cwd:'/fixture', entry:grant});
  threads.push(thread);
  const shape = f.schemas.get('feedback_prepare');
  expect(shape).toBeDefined();
  const parser = z.object(shape as z.ZodRawShape);
  const base = {kind:'feature', title:'标题', description:'说明'};
  const summary = {...base, checks:'检查过程', sourceEvidence:'0.10.1 packages/ui/src/app.ts:21 路由匹配', openQuestions:'待复核',
    useCase:'当前手工处理', acceptanceCriteria:'只需一次操作'};
  expect(parser.parse({summary})).toMatchObject({summary});
  expect(parser.parse({summary:base})).toMatchObject({summary:base});
});

it.each([
  ['start', undefined], ['resume', undefined], ['start', { permissionMode: 'plan' }], ['resume', { permissionMode: 'plan' }],
] as const)('%s carries entry separately from the serializable profile with native %j', async (action, native) => {
  const root = mkdtempSync(join(tmpdir(), 's46-sdk-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  mkdirSync(join(root, 'projects', '-fixture'), { recursive: true });
  writeFileSync(join(root, 'projects', '-fixture', 'saved.jsonl'), JSON.stringify({ type: 'user', uuid: 'm', message: { role: 'user', content: 'fixture' } }) + '\n');
  const e = entry(), f = fixture();
  threads.push(action === 'start' ? await f.backend.startThread({ cwd: root, mode: 'qa', entry: e, native })
    : await f.backend.resumeThread({ cwd: root, mode: 'qa', entry: e, sessionId: 'saved', native }));
  expect(f.options()?.mcpServers?.vonvon_bot).toMatchObject({ type: 'sdk', name: 'vonvon_bot' });
  expect(f.options()).toMatchObject({ permissionMode: native ? 'plan' : 'default', sandbox: { enabled: true }, settings: { autoMemoryEnabled: false } });
  expect(f.options()?.env?.VONVON_SESSION).toBe('1');
  await expect(f.invoke({}, { _meta: { 'claudecode/toolUseId': 'u1' } })).resolves.toEqual({ content: [{ type: 'text', text: '{"v":1}' }] });
  expect(e.call).toHaveBeenLastCalledWith('session_info', {}, { toolUseId: 'u1' });
  const refusal: AgentToolReply = { ok: false, code: 'refused', reason: 'unknown-origin', message: 'refused' };
  e.call.mockResolvedValueOnce(refusal);
  await expect(f.invoke({}, {})).resolves.toEqual({ content: [{ type: 'text', text: 'refused' }], isError: true });
  expect(e.call).toHaveBeenLastCalledWith('session_info', {}, { toolUseId: undefined });
  await threads.at(-1)?.close();
  expect(e.revoke).toHaveBeenCalledWith('closed');
});
it('exposes the opted-in release-code MCP and resolves SDK tool_use to the actual member', async () => {
  const registry = createAgentEntries({appId:'fixture', isAdmin:() => false,
    codeEnabled:chat => chat === 'oc_help', tools:releaseCodeTools()});
  let send!: () => void;
  const pause = new Promise<void>(resolve => {send = resolve;});
  const stream = (async function* (): AsyncGenerator<SDKMessage> {
    await pause;
    const block = {type:'tool_use',id:'code-read',name:'mcp__vonvon-release-code__read',input:{path:'README.md'}};
    yield {type:'assistant',message:{content:[block]}} as SDKMessage;
  })();
  const chatId = 'oc_help', openId = 'ou_member', messageId = 'om_user';
  const grant = registry.issue({kind:'group',chatId});
  const f = fixture(true,stream);
  const thread = await f.backend.startThread({cwd:'/fixture',entry:grant});
  threads.push(thread); grant.attach(thread);
  expect(f.options()?.mcpServers?.['vonvon-release-code']).toMatchObject({name:'vonvon-release-code'});
  expect(f.options()?.allowedTools).toEqual(expect.arrayContaining(['mcp__vonvon-release-code__rg','mcp__vonvon-release-code__read']));
  const call = vi.fn<CodeSource['call']>(async () => 'code reply');
  registry.openTurn(thread,{requesterKind:'user',requesterOpenId:openId,triggerMessageId:messageId,
    retry:false,initiative:false,wake:false,releaseCode:{chatId,openId,messageId,call}});
  const noted=vi.spyOn(grant,'noteToolUse');
  send();
  await vi.waitFor(()=>expect(noted).toHaveBeenCalledWith('code-read'));
  const invoke = () => f.handlers.get('read')!({path:'README.md'},{_meta:{'claudecode/toolUseId':'code-read'}});
  await expect(invoke()).resolves.toEqual({content:[{type:'text',text:'code reply'}]});
  let running: AbortSignal | undefined;
  call.mockImplementationOnce(async (_name, _args, signal) => {
    running = signal;
    await new Promise<void>(done => signal.addEventListener('abort', () => done(), {once:true}));
    signal.throwIfAborted();
    return 'unreachable';
  });
  const pending = invoke();
  await vi.waitFor(() => expect(running).toBeDefined());
  registry.noteSteer(thread,{kind:'user',openId:'ou_another'});
  await expect(pending).resolves.toMatchObject({isError:true});
  expect(running?.aborted).toBe(true);
  await expect(invoke()).resolves.toMatchObject({isError:true});
  expect(call).toHaveBeenCalledTimes(2);
  const other = fixture();
  threads.push(await other.backend.startThread({cwd:'/fixture',entry:registry.issue({kind:'group',chatId:'oc_other'})}));
  expect(other.options()?.mcpServers?.['vonvon-release-code']).toBeUndefined();
});

it.each([true, false])('keeps sessions usable without entry or without SDK MCP exports (%s)', async withSdk => {
  const f = fixture(withSdk);
  threads.push(await f.backend.startThread({ cwd: '/fixture', ...(withSdk ? {} : { entry: entry() }) }));
  expect(f.options()?.mcpServers).toBeUndefined();
});
it.each(['qa', 'write', 'full'] as const)('preserves %s permission decisions for vonvon MCP', async mode => {
  const verdict = await decide(claudeAccess(mode, false, '/fixture', '/fixture'),
    { toolName: 'mcp__vonvon_bot__session_info', input: {}, extra: {} }, 'callback');
  expect(verdict).toEqual({ kind: 'allow' });
});

it.each([0, 255, 256])('keeps streamed/full duplicate origins in their original turn after %i other IDs', async count => {
  let advance: (() => void) | undefined;
  let pause = 0;
  const wait = () => { pause++; return new Promise<void>(resolve => { advance = resolve; }); };
  const block = { type: 'tool_use', id: 'origin-1', name: 'mcp__vonvon_bot__t_set', input: {} };
  const messages = (async function* (): AsyncGenerator<SDKMessage> {
    await wait();
    yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: block } } as SDKMessage;
    await wait();
    for (let i = 0; i < count; i++) yield { type: 'stream_event', event: { type: 'content_block_start', index: i + 1, content_block: { ...block, id: `other-${i}` } } } as SDKMessage;
    await wait();
    yield { type: 'assistant', message: { content: [block] } } as SDKMessage;
  })();
  const write = vi.fn(async () => 'changed');
  const registry = createAgentEntries({ appId: 'fixture', isAdmin: () => true,
    tools: [{ name: 't_set', class: 'settings', description: 'test', input: z.object({}),
      run: async (_args, ctx) => { if (!ctx.commit) throw Error('missing commit'); return ctx.commit(async guard => { guard(); return write(); }); } }] });
  const grant = registry.issue({ kind: 'p2p', chatId: 'dm' });
  const noted = vi.spyOn(grant, 'noteToolUse'), called = vi.spyOn(grant, 'call');
  const f = fixture(true, messages);
  const thread = await f.backend.startThread({ cwd: '/fixture', entry: grant });
  threads.push(thread); grant.attach(thread);
  const facts = { requesterOpenId: 'owner', requesterKind: 'user', triggerMessageId: 'message', retry: false, initiative: false, wake: false } as const;
  const first = registry.openTurn(thread, facts);
  advance?.();
  await vi.waitFor(() => expect(noted).toHaveBeenCalledWith('origin-1'));
  await expect(f.invoke({}, { _meta: { 'claudecode/toolUseId': 'origin-1' } })).resolves.toMatchObject({ content: [{ text: 'changed' }] }); // a text result reads as text (toolReplyText)
  expect(noted.mock.invocationCallOrder[0]).toBeLessThan(called.mock.invocationCallOrder[0]!);
  advance?.(); await vi.waitFor(() => expect(pause).toBe(3));
  first.close(); registry.openTurn(thread, { ...facts, triggerMessageId: 'next-message' });
  advance?.();
  await vi.waitFor(() => expect(noted).toHaveBeenCalledTimes(count + 2));
  const late = await f.invoke({}, { _meta: { 'claudecode/toolUseId': 'origin-1' } });
  expect.soft(write).toHaveBeenCalledOnce();
  expect(late).toMatchObject({ isError: true });
  await expect(called.mock.results.at(-1)?.value).resolves.toMatchObject({ reason: 'turn-ended' });
  expect(write).toHaveBeenCalledOnce();
  const order: string[] = [];
  const revoke = grant.revoke.bind(grant);
  vi.spyOn(grant, 'revoke').mockImplementation(reason => { order.push('revoke'); revoke(reason); });
  f.options()?.abortController?.signal.addEventListener('abort', () => order.push('abort'));
  await thread.close();
  expect(order).toEqual(['revoke', 'abort']);
});

it.each(['group', 'doc', 'p2p'] as const)('registers the shared %s discovery list with Claude without exposing forbidden writers', async kind => {
  const write = vi.fn(async () => 'changed');
  const registry = createAgentEntries({ appId: 'fixture', isAdmin: () => true,
    tools: [
      { name: 't_read', class: 'read', description: 'read', input: z.object({}), run: async () => 'read' },
      { name: 't_set', class: 'settings', description: 'write', input: z.object({}), run: write },
    ] });
  const grant = registry.issue({ kind });
  const f = fixture();
  const thread = await f.backend.startThread({ cwd: '/fixture', entry: grant });
  threads.push(thread); grant.attach(thread);
  expect(f.registered).toEqual(kind === 'p2p' ? ['t_read', 't_set'] : ['t_read']);
  expect(f.registered).toEqual(grant.tools().map(spec => spec.name));
  expect(await grant.call('t_read', {})).toEqual({ ok: true, result: 'read' });
  if (kind !== 'p2p') expect(await grant.call('t_set', {}, { toolUseId: 'forged' })).toMatchObject({ ok: false, reason: 'not-dm' });
  expect(write).not.toHaveBeenCalled();
});

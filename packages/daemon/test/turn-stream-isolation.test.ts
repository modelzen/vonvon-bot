import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { writeNodeExecutable } from './helpers/node-executable';
import type { AgentEvent, AgentRun, AgentThread } from '../src/agent/types';

// Exercise the real JSON-RPC transport, notification queue and backend together.
// Deliberately interleave host, stale and child turns around the start response.
const SERVER = `#!/usr/bin/env node
const readline = require('node:readline');
const send = (msg) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...msg}) + '\\n');
const event = (method, threadId, turnId, extra = {}) => send({method, params: {
  threadId, ...(method.startsWith('turn/') ? {turn:{id:turnId}} : {turnId}), ...extra
}});
let count = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (typeof msg.id !== 'number') return;
  if (['thread/compact/start', 'thread/goal/set'].includes(msg.method)) {
    setTimeout(() => send({id:msg.id,error:{code:-32000,message:'rejected'}}), 20); return;
  }
  if (msg.method !== 'turn/start') {
    send({id:msg.id,result:msg.method === 'thread/start' ? {thread:{id:'host'}} : {}});
    return;
  }
  const id = 'turn-' + (++count);
  const text = msg.params.input[0].text;
  if (text === 'reject') {
    setTimeout(() => send({id:msg.id,error:{code:-32000,message:'start rejected'}}), 20);
    return;
  }
  if (text === 'activity') {
    send({id:msg.id,result:{turn:{id}}});
    const activity = (parent, turn, child) => event('item/started',parent,turn,{item:{
      type:'subAgentActivity',id:'spawn-'+child,kind:'started',agentThreadId:child,agentPath:'root/'+child}});
    activity('host',id,'activity-child');
    event('turn/started','activity-child','child-turn');
    event('turn/started','activity-child','child-turn-new');
    event('turn/completed','activity-child','child-turn',{turn:{id:'child-turn',status:'failed'}});
    activity('activity-child','child-turn-new','activity-grandchild');
    event('turn/started','activity-grandchild','grandchild-turn');
    event('item/started','activity-grandchild','grandchild-turn',{item:{
      type:'commandExecution',id:'nested-step',command:'pwd',cwd:'/repo'}});
    event('turn/completed','activity-grandchild','grandchild-turn',{turn:{id:'grandchild-turn',status:'completed'}});
    event('turn/completed','activity-child','child-turn-new',{turn:{id:'child-turn-new',status:'completed'}});
    event('turn/completed','host',id); return;
  }
  if (text === 'children') {
    send({id:msg.id,result:{turn:{id}}});
    const register = (child, parent) => send({method:'thread/started',params:{thread:{id:child,
      source:{subagent:{thread_spawn:{parent_thread_id:parent,depth:1,agent_path:null,agent_nickname:'小助手',agent_role:null}}}}}});
    const steps = child => {
      event('turn/started',child,'child-turn');
      event('item/started',child,'child-turn',{item:{type:'commandExecution',id:child+'-step',command:'pwd',cwd:'/repo'}});
      event('error',child,'child-turn',{error:{message:'child only'},willRetry:false});
      event('turn/completed',child,'child-turn',{turn:{id:'child-turn',status:'completed'}});
    };
    register('child','host'); steps('child');
    register('child3','child'); steps('child3');
    event('item/completed','host',id,{item:{type:'collabAgentToolCall',id:'spawn',tool:'spawnAgent',
      receiverThreadIds:['child2'],senderThreadId:'host',prompt:'count',agentsStates:{}}});
    steps('child2');
    event('item/started','host',id,{item:{type:'collabAgentToolCall',id:'spawn-started',tool:'spawnAgent',
      receiverThreadIds:['child4'],senderThreadId:'host',prompt:'count',agentsStates:{}}});
    steps('child4');
    event('turn/completed','host',id); return;
  }
  if (text === 'clean') {
    send({id:msg.id,result:{turn:{id}}});
    event('turn/started','host',id);
    event('item/agentMessage/delta','host',id,{itemId:id,delta:'correct clean'});
    event('turn/completed','host',id);
    return;
  }
  const foreign = (threadId, turnId) => {
    event('turn/started',threadId,turnId);
    event('item/agentMessage/delta',threadId,turnId,{itemId:'foreign',delta:'WRONG'});
    event('error',threadId,turnId,{willRetry:false,error:{message:'foreign error'}});
    event('turn/completed',threadId,turnId);
  };
  foreign('host','stale');
  foreign('child','child-turn');
  // Real notifications can precede the turn/start response.
  event('turn/started','host',id);
  event('item/agentMessage/delta','host',id,{itemId:id,delta:'correct '+text});
  foreign('host','stale');
  foreign('child',id); // even a matching turn ID must not cross thread boundaries
  setTimeout(() => {
    send({id:msg.id,result:{turn:{id}}});
    event('turn/completed','host',id);
    foreign('host',id); // leftovers after done must not poison the next request
  }, 20);
});
`;
const dir = mkdtempSync(join(tmpdir(), 'turn-isolation-'));
const { bin } = writeNodeExecutable(dir, 'codex', SERVER);
afterAll(async () => {
  await shutdownResidentClients();
  rmSync(dir, { recursive: true, force: true });
});

async function withThread(fn: (thread: AgentThread) => Promise<void>): Promise<void> {
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  let thread: AgentThread | undefined;
  try {
    thread = await new CodexAppServerBackend().startThread({ cwd: dir });
    await fn(thread);
  } finally {
    await thread?.close();
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
}
async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of run.events) events.push(e);
  return events;
}

describe('ordinary turn notification isolation', () => {
  it('accepts only the response-identified host turn, including events buffered before the response', async () => {
    await withThread(async (thread) => {
      const run = thread.runStreamed({ text: 'first' });
      expect(await collect(run)).toEqual([
        { type: 'turn_started', turnId: 'turn-1' },
        { type: 'text_delta', itemId: 'turn-1', delta: 'correct first' },
        { type: 'done', turnId: 'turn-1' },
      ]);
      expect(run.turnId()).toBeUndefined();
      const next = thread.runStreamed({ text: 'second' });
      expect(await collect(next)).toEqual([
        { type: 'turn_started', turnId: 'turn-2' },
        { type: 'text_delta', itemId: 'turn-2', delta: 'correct second' },
        { type: 'done', turnId: 'turn-2' },
      ]);
    });
  });

  it('does not leave an abandoned notification read after a rejected start', async () => {
    await withThread(async (thread) => {
      expect(await collect(thread.runStreamed({ text: 'reject' }))).toEqual([
        { type: 'error', message: 'start rejected', willRetry: false },
      ]);
      const events = await collect(thread.runStreamed({ text: 'clean' }));
      expect(events.map(e => e.type)).toEqual(['turn_started', 'text_delta', 'done']);
      expect(events[1]).toMatchObject({ delta: 'correct clean' });
    });
  });

  it('clears the steering target before handing terminal events to slow card consumers', async () => {
    await withThread(async (thread) => {
      const run = thread.runStreamed({ text: 'first' });
      for await (const event of run.events) {
        expect(run.turnId()).toBe(event.type === 'done' ? undefined : 'turn-1');
      }
    });
  });
});

it.each(['compact', 'goal'])('a rejected %s leaves no reader to steal the next turn', async operation => {
 await withThread(async thread => {
  if (operation === 'compact') await expect(thread.compact()).rejects.toThrow('rejected');
  else expect(await collect(thread.runGoal('test'))).toEqual([expect.objectContaining({type:'error'})]);
  expect(await collect(thread.runStreamed({text:'clean'}))).toEqual([
   {type:'turn_started',turnId:'turn-1'},
   {type:'text_delta',itemId:'turn-1',delta:'correct clean'},
   {type:'done',turnId:'turn-1'},
  ]);
 });
});


it('routes registered children and grandchildren through the child channel', async () => {
  await withThread(async thread => {
    const events = await collect(thread.runStreamed({ text: 'children' }));
    for (const id of ['child', 'child2', 'child3', 'child4']) {
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_start', id }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_step', id, stepId: id + '-step' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_status', id, status: 'completed' }));
    }
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_start', id: 'child', name: '小助手' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_start', id: 'child3', parentId: 'child' }));
    expect(events.some(e => e.type === 'error' || (e.type === 'tool_use' && e.itemId.endsWith('-step')))).toBe(false);
  });
});


it('registers code-mode activity items on parent and child threads without thread/started', async () => {
  await withThread(async thread => {
    const events = await collect(thread.runStreamed({ text: 'activity' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_start', id: 'activity-child' }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'subagent_start', id: 'activity-grandchild', parentId: 'activity-child',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'subagent_step', id: 'activity-grandchild', stepId: 'nested-step', status: 'running',
    }));
    expect(events.filter(e => e.type === 'subagent_status' && e.id === 'activity-child')).toEqual([
      { type: 'subagent_status', id: 'activity-child', status: 'running' },
      { type: 'subagent_status', id: 'activity-child', status: 'running' },
      { type: 'subagent_status', id: 'activity-child', status: 'completed', result: undefined },
    ]);
    expect(events.filter(e => e.type === 'tool_use')).toEqual([
      expect.objectContaining({ itemId: 'spawn-activity-child' }),
    ]);
  });
});

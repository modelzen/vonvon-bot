import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import type { AgentEvent } from '../src/agent/types';
import { writeNodeExecutable } from './helpers/node-executable';

const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-stop-'));
const requestsFile = join(dir, 'requests.jsonl');
const { bin } = writeNodeExecutable(dir, 'codex', `
const fs = require('node:fs');
const send = msg => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...msg})+'\\n');
const event = (method,params) => send({method,params});
let scenario;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (typeof msg.id !== 'number') return;
  fs.appendFileSync(${JSON.stringify(requestsFile)},JSON.stringify(msg)+'\\n');
  if (msg.method === 'turn/interrupt') {
    if (scenario?.startsWith('scope-') && msg.params.threadId === 'host') {
      if (scenario.startsWith('scope-restore')) event('turn/started',{threadId:'scoped-child',turn:{id:'restored-turn'}});
      if (scenario.includes('goal')) event('thread/goal/updated',{threadId:'host',turnId:null,
        goal:{objective:scenario,status:'complete',tokensUsed:0,timeUsedSeconds:0,tokenBudget:null}});
      event('turn/completed',{threadId:'host',turn:{id:'turn',status:'interrupted'}});
    }
    if (scenario === 'late' && msg.params.threadId === 'host') setTimeout(() => event('turn/started',{threadId:'late-child',turn:{id:'late-turn'}}),20);
    send(msg.params.threadId === 'host' ? {id:msg.id,error:{code:-32000,message:'parent failed'}} : {id:msg.id,result:{}});
    return;
  }
  send({id:msg.id,result:msg.method === 'thread/start' ? {thread:{id:'host'}} :
    msg.method === 'thread/resume' ? {thread:{id:'resumed'}} : msg.method === 'turn/start' ? {turn:{id:'turn'}} : {}});
  if (msg.method === 'turn/start' || (msg.method === 'thread/goal/set' && msg.params.objective.startsWith('scope-'))) {
    event('turn/started',{threadId:'host',turn:{id:'turn'}});
    scenario = msg.method === 'turn/start' ? msg.params.input[0].text : msg.params.objective;
    const collab = (tool, ids, agentsStates = {}) => event('item/completed',{threadId:'host',turnId:'turn',item:{
      type:'collabAgentToolCall',id:tool+JSON.stringify(ids),tool,senderThreadId:'host',receiverThreadIds:ids,prompt:'work',agentsStates}});
    const start = (id, turnId = id+'-turn') => event('turn/started',{threadId:id,turn:{id:turnId}});
    if (scenario.startsWith('scope-')) {
      if (scenario === 'scope-next') {
        start('scoped-child','next-turn');
        event('item/started',{threadId:'scoped-child',turnId:'next-turn',item:{type:'commandExecution',id:'next-step',command:'pwd',cwd:'/repo'}});
        event('turn/completed',{threadId:'host',turn:{id:'turn',status:'completed'}}); return;
      }
      collab('spawnAgent',['scoped-child']);
      if (!scenario.includes('noid')) start('scoped-child');
      if (scenario.startsWith('scope-restore')) {
        if (scenario.includes('closed')) event('thread/closed',{threadId:'scoped-child'});
        else event('turn/completed',{threadId:'scoped-child',turn:{id:'scoped-child-turn',status:'completed'}});
        collab(scenario.endsWith('sendInput') ? 'sendInput' : 'resumeAgent',['scoped-child']);
        collab('spawnAgent',['another-child']);
      }
      event('item/agentMessage/delta',{threadId:'host',turnId:'turn',itemId:'ready',delta:'ready'}); return;
    }
    if (scenario === 'revive') {
      for (const [receivers, states] of [[null,null],[{},[]],[42,'invalid']]) collab('spawnAgent',receivers,states);
      collab('spawnAgent',['A']); start('A');
      event('future/notification',{threadId:'A',turn:null});
      event('turn/completed',{threadId:'A',turn:null});
      for (const tool of ['sendInput','resumeAgent']) {
        collab(tool,[tool]); start(tool);
        event('item/started',{threadId:tool,turnId:tool+'-turn',item:{type:'commandExecution',id:tool+'-step',command:'pwd',cwd:'/repo'}});
      }
      event('turn/completed',{threadId:'A',turn:{id:'A-turn',status:'completed'}});
      collab('spawnAgent',['B']); collab('sendInput',['A']); start('A','A-turn-new');
      event('item/started',{threadId:'A',turnId:'A-turn-new',item:{type:'commandExecution',id:'resumed-step',command:'pwd',cwd:'/repo'}});
      event('turn/completed',{threadId:'host',turn:{id:'turn',status:'completed'}}); return;
    }
    if (scenario === 'many') {
      for (let i = 0; i < 65; i++) { collab('spawnAgent',['active-'+i]); start('active-'+i); }
      event('turn/completed',{threadId:'host',turn:{id:'turn',status:'completed'}}); return;
    }
    if (scenario === 'late') { collab('spawnAgent',['late-child']); return; }
    if (scenario === 'states') {
      const agentsStates = {};
      for (const status of ['errored','shutdown','notFound']) {
        collab('spawnAgent',[status]); start(status); agentsStates[status] = {status};
      }
      collab('wait',Object.keys(agentsStates),agentsStates); return;
    }
    if (msg.params.input[0].text !== 'hold') for (const id of ['child1','child2','unstarted']) {
      event('thread/started',{thread:{id,source:{subagent:{thread_spawn:{parent_thread_id:'host',depth:1,
        agent_path:null,agent_nickname:null,agent_role:null}}}}});
      if (id !== 'unstarted') event('turn/started',{threadId:id,turn:{id:id+'-turn'}});
    }
    if (scenario === 'single') event('turn/completed',{threadId:'child2',turn:{id:'child2-turn',status:'completed'}});
    if (msg.params.input[0].text === 'hold') for (const id of ['child1','child2']) event('item/started',{
      threadId:id,turnId:id+'-turn',item:{type:'commandExecution',id:id+'-step',command:'pwd',cwd:'/repo'}});
    if (msg.params.input[0].text !== 'hold') event('turn/completed',{threadId:'host',turn:{id:'turn',status:'completed'}});
  }
  if (msg.method === 'thread/goal/set') for (const status of ['active','complete']) event('thread/goal/updated',{threadId:msg.params.threadId,turnId:null,
    goal:{objective:msg.params.objective,status,tokensUsed:0,timeUsedSeconds:0,tokenBudget:null}});
});
`);
const requests = (): Array<{ method: string; params: { threadId?: string; turnId?: string } }> =>
  readFileSync(requestsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));

afterAll(async () => {
  await shutdownResidentClients();
  rmSync(dir, { recursive: true, force: true });
});

it('retains running children across parent turns and interrupts them even when the parent interrupt fails', async () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
  try {
    const initial: AgentEvent[] = [];
    for await (const event of thread.runStreamed({ text: 'finish' }).events) initial.push(event);
    expect(initial.at(-1)).toMatchObject({ type: 'done' });
    expect(initial.filter(event => event.type === 'subagent_status')).toHaveLength(2);
    const run = thread.runStreamed({ text: 'hold' });
    const seen: string[] = [];
    const drained = (async () => {
      for await (const event of run.events) {
        expect(event.type).not.toBe('subagent_start');
        if (event.type === 'subagent_step') seen.push(event.id);
      }
    })();
    await vi.waitFor(() => expect(seen).toEqual(['child1', 'child2']));
    await expect(thread.abort('turn')).rejects.toThrow('parent failed');
    expect(requests().filter(r => r.method === 'turn/interrupt').map(r => r.params)).toEqual([
      { threadId: 'host', turnId: 'turn' },
      { threadId: 'child1', turnId: 'child1-turn' },
      { threadId: 'child2', turnId: 'child2-turn' },
    ]);
    await thread.close();
    await drained;
  } finally {
    await thread.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});

it('leaves user multi-agent settings untouched on start, resume, turn and both goal paths', async () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const backend = new CodexAppServerBackend();
  const started = await backend.startThread({ cwd: dir });
  const resumed = await backend.resumeThread({ cwd: dir, sessionId: 'resumed' });
  try {
    for await (const event of started.runStreamed({ text: 'finish' }).events) void event;
    for (const thread of [started, resumed]) {
      for await (const event of thread.runGoal('count').events) void event;
    }
    const logged = requests();
    for (const method of ['thread/start', 'thread/resume', 'turn/start', 'thread/goal/set']) {
      const matching = logged.filter(r => r.method === method);
      expect(matching.length).toBeGreaterThan(0);
      for (const request of matching) expect(JSON.stringify(request.params)).not.toContain('multi_agent');
    }
    expect(logged.filter(r => r.method === 'thread/goal/set').map(r => r.params.threadId)).toEqual(['host', 'resumed']);
  } finally {
    await started.close();
    await resumed.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});


it('receives A again after A completes, B spawns and sendInput resumes A without thread/started', async () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
  try {
    const events: AgentEvent[] = [];
    for await (const event of thread.runStreamed({ text: 'revive' }).events) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'subagent_step', id: 'A', stepId: 'resumed-step' }));
    expect(events.filter(event => event.type === 'subagent_start' && event.id === 'A')).toHaveLength(1);
    for (const id of ['sendInput', 'resumeAgent']) expect(events).toContainEqual(expect.objectContaining({
      type: 'subagent_step', id, stepId: id + '-step',
    }));
  } finally {
    await thread.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});

it.each(['late', 'states'])('handles child interruption lifecycle: %s', async scenario => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
  const offset = requests().length;
  const seen: AgentEvent[] = [];
  const drained = (async () => {
    for await (const event of thread.runStreamed({ text: scenario }).events) seen.push(event);
  })();
  try {
    await vi.waitFor(() => expect(seen.filter(event => event.type === (scenario === 'late' ? 'subagent_start' : 'subagent_status'))).toHaveLength(scenario === 'late' ? 1 : 6));
    if (scenario === 'states') {
      for (const [id, status] of [['errored', 'failed'], ['shutdown', 'stopped'], ['notFound', 'stopped']]) {
        expect(seen).toContainEqual(expect.objectContaining({ type: 'subagent_status', id, status }));
      }
    }
    await expect(thread.abort('turn')).rejects.toThrow('parent failed');
    const interrupts = () => requests().slice(offset).filter(request => request.method === 'turn/interrupt').map(request => request.params);
    expect(interrupts()).toEqual([{ threadId: 'host', turnId: 'turn' }]);
    if (scenario === 'late') await vi.waitFor(() => expect(interrupts()).toContainEqual({ threadId: 'late-child', turnId: 'late-turn' }));
  } finally {
    await thread.close();
    await drained;
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});


it('interrupts all 65 active children after the parent turn ends', async () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
  const offset = requests().length;
  try {
    for await (const event of thread.runStreamed({ text: 'many' }).events) void event;
    await expect(thread.abort('turn')).rejects.toThrow('parent failed');
    const interrupted = requests().slice(offset).filter(request => request.method === 'turn/interrupt');
    expect(interrupted).toHaveLength(66);
    for (let i = 0; i < 65; i++) expect(interrupted).toContainEqual(expect.objectContaining({
      params: { threadId: 'active-' + i, turnId: 'active-' + i + '-turn' },
    }));
  } finally {
    await thread.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});


it.each(['stream-noid', 'stream-known', 'goal-noid', 'goal-known', 'restore-sendInput', 'restore-resumeAgent', 'restore-closed-sendInput', 'restore-closed-resumeAgent'])(
  'handles pending stop across parent scope or child restoration: %s', async variant => {
    const previous = process.env.CODEX_BIN;
    process.env.CODEX_BIN = bin;
    const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
    const seen: AgentEvent[] = [];
    const run = variant.startsWith('goal') ? thread.runGoal('scope-' + variant) : thread.runStreamed({ text: 'scope-' + variant });
    const drained = (async () => { for await (const event of run.events) seen.push(event); })();
    try {
      await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ type: 'text_delta', delta: 'ready' })));
      const offset = requests().length;
      await expect(thread.abort('turn')).rejects.toThrow('parent failed');
      await drained;
      if (variant.startsWith('restore')) {
        await vi.waitFor(() => expect(requests().slice(offset)).toContainEqual(expect.objectContaining({
          method: 'turn/interrupt', params: { threadId: 'scoped-child', turnId: 'restored-turn' },
        })));
      } else {
        const beforeNext = requests().length;
        const next: AgentEvent[] = [];
        for await (const event of thread.runStreamed({ text: 'scope-next' }).events) next.push(event);
        expect(next).toContainEqual(expect.objectContaining({ type: 'subagent_step', stepId: 'next-step' }));
        await thread.steer({ text: 'barrier' }, 'turn');
        expect(requests().slice(beforeNext).filter(request => request.method === 'turn/interrupt')).toEqual([]);
      }
    } finally {
      await thread.close();
      await drained;
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
    }
  },
);


it.each([false, true])('stops only the requested running child across parent turns (goal=%s) and rejects unavailable children', async goal => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
  try {
    const run = thread.runStreamed({ text: 'single' });
    for await (const event of run.events) void event;
    expect(run.stopSubagent).toBeTypeOf('function');
    await expect(run.stopSubagent?.('unknown')).rejects.toThrow('这个子 agent 已经结束');
    await expect(run.stopSubagent?.('child2')).rejects.toThrow('这个子 agent 已经结束');
    await expect(run.stopSubagent?.('unstarted')).rejects.toThrow('这个子 agent 还没开始回合');
    const next = goal ? thread.runGoal('scope-goal-known') : thread.runStreamed({ text: 'hold' });
    const drained = (async () => { for await (const event of next.events) void event; })();
    const offset = requests().length;
    await next.stopSubagent?.('child1');
    expect(requests().slice(offset).filter(request => request.method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'child1', turnId: 'child1-turn' } }),
    ]);
    await thread.close();
    await drained;
  } finally {
    await thread.close();
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});

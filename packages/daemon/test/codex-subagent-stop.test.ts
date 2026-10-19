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
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (typeof msg.id !== 'number') return;
  fs.appendFileSync(${JSON.stringify(requestsFile)},JSON.stringify(msg)+'\\n');
  if (msg.method === 'turn/interrupt') {
    send(msg.params.threadId === 'host' ? {id:msg.id,error:{code:-32000,message:'parent failed'}} : {id:msg.id,result:{}});
    return;
  }
  send({id:msg.id,result:msg.method === 'thread/start' ? {thread:{id:'host'}} :
    msg.method === 'thread/resume' ? {thread:{id:'resumed'}} : msg.method === 'turn/start' ? {turn:{id:'turn'}} : {}});
  if (msg.method === 'turn/start') {
    event('turn/started',{threadId:'host',turn:{id:'turn'}});
    if (msg.params.input[0].text !== 'hold') for (const id of ['child1','child2','unstarted']) {
      event('thread/started',{thread:{id,source:{subagent:{thread_spawn:{parent_thread_id:'host',depth:1,
        agent_path:null,agent_nickname:null,agent_role:null}}}}});
      if (id !== 'unstarted') event('turn/started',{threadId:id,turn:{id:id+'-turn'}});
    }
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

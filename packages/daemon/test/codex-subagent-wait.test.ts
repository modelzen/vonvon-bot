import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import type { AgentEvent } from '../src/agent/types';
import { writeNodeExecutable } from './helpers/node-executable';

const fixture = `
const fs = require('node:fs');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
const event = (method,params) => send({method,params});
const done = (threadId,id,status='completed') => event('turn/completed',{threadId,turn:{id,status}});
let serial=0, scenario;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 fs.appendFileSync(__dirname+'/wire',JSON.stringify(m)+'\\n');
 if (!m.method) return;
 if (m.method==='turn/start') {
  const turnId='parent-'+ ++serial; scenario=m.params.input[0].text;
  send({id:m.id,result:{turn:{id:turnId}}});
  event('turn/started',{threadId:'host',turn:{id:turnId}});
  if (scenario==='clean') { done('host',turnId); return; }
  event('thread/started',{thread:{id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'host',depth:1,agent_path:null,agent_nickname:'worker',agent_role:null}}}}});
  const childTurn=scenario==='ask-same-turn'?turnId:'child-turn';
  if (scenario!=='late') event('turn/started',{threadId:'child',turn:{id:childTurn}});
  const ask=(threadId,id)=>send({id:'question',method:'item/tool/requestUserInput',params:{threadId,turnId:id,itemId:'q',questions:[{id:'q',header:'Pick',question:'Choose',isOther:true,isSecret:false,options:[{label:'Yes',description:''}]}]}});
  if (scenario.startsWith('ask-')) ask(scenario==='ask-foreign'?'foreign':'child',scenario==='ask-stale'?'old':childTurn);
  if (scenario==='ask-cancel') event('serverRequest/resolved',{threadId:'child',requestId:'question'});
  done('host',turnId);
  if (scenario==='duplicate') done('host',turnId);
  if (scenario==='eof') setTimeout(()=>process.exit(0),30);
  if (scenario==='late') setTimeout(()=>event('turn/started',{threadId:'child',turn:{id:'child-turn'}}),30);
  return;
 }
 if (m.method==='turn/interrupt') {
  done(m.params.threadId,m.params.turnId,'interrupted');
  if (scenario==='ask-finish') setTimeout(()=>send({method:'serverRequest/resolved',params:{threadId:'child',requestId:'question'}}),5);
 }
 if (m.method==='turn/steer') done('child','child-turn');
 send({id:m.id,result:m.method==='thread/start'?{thread:{id:'host'}}:{}});
});
`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await shutdownResidentClients();
  vi.unstubAllEnvs();
});
async function start(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-wait-'));
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  const { bin } = writeNodeExecutable(dir, 'codex', fixture);
  vi.stubEnv('CODEX_BIN', bin);
  const thread = await new CodexAppServerBackend().startThread({ cwd: dir });
  cleanup.push(() => thread.close());
  const wire = (): Array<{ method?: string; id?: string; params?: unknown; result?: unknown }> =>
    readFileSync(join(dir, 'wire'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const run = thread.runStreamed({ text: scenario });
  const events: AgentEvent[] = [];
  const drained = (async () => { for await (const event of run.events) events.push(event); })();
  cleanup.push(async () => { await thread.close(); await drained; });
  await vi.waitFor(() => expect(events).toContainEqual({ type: 'awaiting_subagents' }));
  return { thread, run, events, drained, wire };
}
it.each(['normal', 'late', 'duplicate'])('waits for children, clears steering identity and interrupts only live children: %s', async scenario => {
  const { thread, run, events, drained, wire } = await start(scenario);
  expect(run.turnId()).toBeUndefined();
  expect(events.some(event => event.type === 'done')).toBe(false);
  await thread.abort('parent-1');
  await drained;
  expect(events.at(-1)).toMatchObject({ type: 'done' });
  expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  expect(wire().filter(m => m.method === 'turn/interrupt').map(m => m.params)).toEqual([{ threadId: 'child', turnId: 'child-turn' }]);
  const next: AgentEvent[] = [];
  for await (const event of thread.runStreamed({ text: 'clean' }).events) next.push(event);
  expect(next.map(event => event.type)).toEqual(['turn_started', 'done']);
});
it.each(['ask-answer', 'ask-finish', 'ask-stale', 'ask-foreign', 'ask-cancel', 'ask-same-turn'])('routes child questions and retires continuations: %s', async scenario => {
  const { thread, run, events, drained, wire } = await start(scenario);
  const ask = events.find(event => event.type === 'ask');
  const valid = scenario !== 'ask-stale' && scenario !== 'ask-foreign' && scenario !== 'ask-cancel';
  if (valid) {
    expect(ask).toMatchObject({ type: 'ask', subagentId: 'child' });
    if (ask?.type !== 'ask') throw new Error('missing child ask');
    expect(run.askPending?.(ask.request.id)).toBe(true);
    if (scenario === 'ask-answer') await run.respondToAsk?.(ask.request.id, { kind: 'answered', answer: { kind: 'text', text: 'Yes' } });
  } else if (scenario !== 'ask-cancel') expect(ask).toBeUndefined();
  if (scenario === 'ask-cancel') expect(events).toContainEqual(expect.objectContaining({ type: 'ask_cancelled' }));
  await thread.abort('parent-1');
  await drained;
  if (scenario === 'ask-finish') {
    const cancelled = events.findIndex(event => event.type === 'ask_cancelled');
    expect(cancelled).toBeGreaterThan(-1);
    expect(events[cancelled]).toMatchObject({ requestId: ask?.type === 'ask' ? ask.request.id : '' });
    expect(events[cancelled + 1]).toMatchObject({ type: 'subagent_status', id: 'child' });
  }
  await vi.waitFor(() => expect(wire().filter(m => !m.method && m.id === 'question')).toHaveLength(scenario === 'ask-cancel' ? 0 : 1));
  if (scenario !== 'ask-cancel') expect(wire().find(m => !m.method && m.id === 'question')?.result).toEqual({ answers: scenario === 'ask-answer' ? { q: { answers: ['Yes'] } } : {} });
});
it('does not synthesize done when the transport exits while waiting', async () => {
  const { events, drained } = await start('eof');
  await drained;
  expect(events.some(event => event.type === 'done')).toBe(false);
});
it('settles after a natural child completion without interrupting', async () => {
  const { thread, events, drained, wire } = await start('normal');
  await thread.steer({ text: 'fixture finish child' }, 'parent-1');
  await drained;
  expect(events.at(-1)).toMatchObject({ type: 'done' });
  expect(wire().some(m => m.method === 'turn/interrupt')).toBe(false);
});

it('retires a waiting child question without done when the transport is closed', async () => {
  const { thread, run, events, drained } = await start('ask-answer');
  const ask = events.find(event => event.type === 'ask');
  if (ask?.type !== 'ask') throw new Error('missing question');
  await thread.close();
  await drained;
  expect(events.some(event => event.type === 'done')).toBe(false);
  expect(run.askPending?.(ask.request.id)).toBe(false);
});

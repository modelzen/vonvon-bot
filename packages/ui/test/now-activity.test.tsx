import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {agentIdSchema, groupIdSchema, membershipSchema, type BotDecision, type DesktopSnapshot} from '@vonvon/protocol';
import {NowActivity} from '../src/NowActivity';
import {decisionTrigger, nowDecisions} from '../src/now-activity';

const agentId = agentIdSchema.parse('cli_activity');
const groupId = groupIdSchema.parse('oc_activity');
const member = membershipSchema.parse({id:'activity',agentId,groupId,name:'讨论群',directory:'/test',backend:'codex-appserver',conversation:'smart',response:'mention',permission:{administrator:'full',member:'full',network:false},stale:false,enabled:true});
const decision = (overrides: Partial<BotDecision> = {}): BotDecision => ({id:'11111111-1111-4111-8111-111111111111',groupId,place:'main',decision:'skip',trigger:'glance',decidedAt:200,messageAt:100,messageCount:3,...overrides});
function snapshot(records: BotDecision[]): DesktopSnapshot {
  return {revision:1,observedAt:250,stale:false,host:{kind:'connected',ownership:'owned',version:'test'},agents:[{id:agentId,name:'测试 Bot',enabled:true,running:true,connection:'connected',activation:'active',diagnostics:{notReplied:[],deniedScopes:[],decisions:records}}],groups:[{id:groupId,name:'讨论群'}],memberships:[member],tools:[],jobs:[],application:{platform:'macos',version:'test',loginItem:false,dataPath:'/test'}};
}

it('orders by actual decision time and keeps only still-bound groups', () => {
  const view = snapshot([decision({id:'older',decidedAt:200,messageAt:999}),decision({id:'newer',decidedAt:300}),decision({id:'removed',groupId:'oc_removed',decidedAt:999})]);
  expect(nowDecisions(view).map(item => item.id)).toEqual(['newer','older']);
  expect(nowDecisions(view)[0]).toMatchObject({bot:'测试 Bot',group:'讨论群'});
});

it('keeps different Bots separate and bounds the displayed history', () => {
  const view = snapshot(Array.from({length:40},(_,i)=>decision({id:`event-${i}`,decidedAt:i})));
  expect(nowDecisions(view)).toHaveLength(30);
  expect(nowDecisions(view)[0]?.id).toBe('event-39');
});

it('only adds the batch count for a glance; a mention is a trigger, not a rationale', () => {
  expect(decisionTrigger(decision())).toBe('查看新消息 · 3 条');
  expect(decisionTrigger(decision({trigger:'mention'}))).toBe('收到 @ 提及');
  expect(decisionTrigger(decision({trigger:'bot-mention'}))).toBe('被其他 Bot 提及');
});

it('renders decisions as intent and excludes older recent-conversation contents', () => {
  const view = snapshot([decision({decision:'topic'})]);
  const html = renderToStaticMarkup(<NowActivity snapshot={view}/>);
  expect(html).toContain('群动态');
  expect(html).toContain('开新话题回复');
  expect(html).not.toContain('已新建');
  expect(html).not.toContain('已回复');
  expect(html).not.toContain('暂停按钮');
});

it('does not manufacture events for empty, unsupported, or offline snapshots', () => {
  const view = snapshot([]);
  expect(renderToStaticMarkup(<NowActivity snapshot={view}/>)).toContain('暂时没有新动态');
  view.stale = true;
  expect(renderToStaticMarkup(<NowActivity snapshot={view}/>)).toContain('连接恢复后显示群动态');
  view.stale = false;
  delete view.agents[0]!.diagnostics!.decisions;
  expect(renderToStaticMarkup(<NowActivity snapshot={view}/>)).toContain('新动态将在智能模式判断后显示');
});

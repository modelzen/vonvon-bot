// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {
  accountStatusSchema, communityRequestSchema, desktopAuthoringReplySchema, desktopAuthoringRequestSchema,
  desktopSnapshotSchema, type AccountStatus, type CommunityRequest, type DesktopAuthoringOperation,
  type DesktopAuthoringReply, type DesktopAuthoringRequest, type RecipeDraft,
} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRoot} from '../src/devices/DesktopRoot';
import * as authoringUi from '../src/community/authoring/LegacyDraftChat';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {canonicalizeRichRecipeContent,recipeRichDraftSchema,type AuthoringHandoff} from '@vonvon/protocol';
import {A, B, devicesState} from './devices-fixture';

const accountA = '44444444-4444-4444-8444-444444444444';
const accountB = '66666666-6666-4666-8666-666666666666';
const draftId = '55555555-5555-4555-8555-555555555555';
const operationId = '019a8000-0000-7000-8000-000000000001';
const challengeId = '77777777-7777-4777-8777-777777777777';
const evidence = 'a'.repeat(64);
const botA = 'cli_author_a';
const groupA = 'oc_author_a';
const signedIn = (accountId = accountA): AccountStatus => accountStatusSchema.parse({kind:'signedIn',accountId,displayName:accountId === accountA ? '账号甲' : '账号乙',provider:'github',persistence:'memory'});
const snapshot = (view: unknown) => {
  const suffix = view === B ? 'b' : 'a';
  const botId = 'cli_author_' + suffix;
  const groupId = 'oc_author_' + suffix;
  return desktopSnapshotSchema.parse({revision:1,observedAt:1,stale:false,host:{kind:'connected',ownership:'attached',version:'0.10.1'},jobs:[],tools:[],
    agents:[{id:botId,name:'Bot '+suffix.toUpperCase(),tenant:'feishu',enabled:true,running:true,connection:'connected',activation:'active'}],
    groups:[{id:groupId,name:'群聊 '+suffix.toUpperCase()}],
    memberships:[{id:JSON.stringify([botId,groupId]),agentId:botId,groupId,name:'群聊 '+suffix.toUpperCase(),directory:'/tmp/synthetic-authoring',backend:'codex-appserver',conversation:'threads',response:'mention',permission:{administrator:'full',member:'full',network:false},stale:false,enabled:true}],
    application:{platform:'linux',version:'0.10.1',loginItem:false,dataPath:'/tmp/synthetic-authoring'},
  });
};
type Session = Extract<DesktopAuthoringReply,{kind:'session'}>;
let root: Root;
let emit: (value: unknown) => void;
let status: AccountStatus;
let calls: DesktopAuthoringRequest[];
let cloudCalls: CommunityRequest[];
let sessions: Map<string,Session>;
let nextHandle: number;
let linked: boolean;
let recipient: boolean;
let operations: DesktopAuthoringOperation[];
let draft: RecipeDraft;
let authoring: (request: DesktopAuthoringRequest) => Promise<DesktopAuthoringReply>;
let cloud: (request: CommunityRequest) => Promise<unknown>;
let sourceRecord: unknown;
let currentHandoff:AuthoringHandoff|undefined;
let deviceSnapshot= snapshot;
let facade: ReturnType<typeof createDesktopFacades>;
const success = (value: unknown) => ({ok:true,value});
const text = () => document.querySelector('main')?.textContent ?? '';
const dialog = (title: string) => [...document.querySelectorAll('[role="dialog"]')].find(element=>element.querySelector('header h2')?.textContent===title);
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label);
  expect(button, label).toBeDefined(); expect(button!.disabled, label).toBe(false);
  await act(async () => button!.click());
}
async function fill(label: string,value: string) {
  const input = document.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[aria-label="${label}"]`);
  expect(input,label).not.toBeNull();
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(input,value);input!.dispatchEvent(new Event('input',{bubbles:true}));});
  return input!;
}
async function chooseSource() {
  await click('社区');await click('创作中心');await click('准备配方');
  const fields=dialog('准备配方')!.querySelectorAll('select');
  expect(Array.from(fields).map(select=>select.selectedOptions[0]?.textContent)).toEqual(['Bot A','群聊 A']);
}
async function openDraftChat(editing=false) {
  linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');
  if(editing)await click('编辑草稿');
  await click('在飞书继续编辑');await act(async()=>document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());
  await click('确认编辑 Bot');await click('发送继续编辑卡片');
}
async function acceptChatRevision(revision:number) {
  operations=[{...operations[0]!,state:'completed',receipt:{operationId,status:'accepted',stateRevision:3,draftId: draft.draftId,revision}}];
  await click('重新核验并继续');
}
function sessionFor(request: DesktopAuthoringRequest): Session {
  if (!('handle' in request)) throw new Error('Expected scoped authoring request');
  const session = sessions.get(request.handle);
  if (!session) throw new Error('操作已关闭，请重新核验。');
  return session;
}
function op(session:Session,state:DesktopAuthoringOperation['state']='waiting'):DesktopAuthoringOperation {
  const reply = desktopAuthoringReplySchema.parse({kind:'operation',operation:{operationId,purpose:'prepareDraft',state,deliveryUnknown:false,groupId:groupA,groupName:'群聊 A',createdAt:1,target:session.target}});
  if(reply.kind!=='operation')throw new Error('Invalid operation fixture');
  return reply.operation;
}
async function defaultAuthoring(request: DesktopAuthoringRequest):Promise<DesktopAuthoringReply> {
  if (request.type==='open'||request.type==='openDraftSource') {
    const botId=request.type==='open'?request.botId:snapshot(request.viewId).agents[0]!.id;
    const handle = `00000000-0000-4000-8000-${String(++nextHandle).padStart(12,'0')}`;
    const next = desktopAuthoringReplySchema.parse({kind:'session',handle,target:{accountId:request.accountId,accountName:request.accountId===accountA?'账号甲':'账号乙',viewId:request.viewId,botId,botName:botId===botA?'Bot A':'Bot B'},linked,operations:operations.filter(item=>item.target.accountId===request.accountId&&item.target.viewId===request.viewId&&item.target.botId===botId),...(request.type==='openDraftSource'&&{sourceGroup:{groupId:groupA,groupName:'群聊 A'}})});
    if (next.kind!=='session') throw new Error('Expected session fixture'); sessions.set(handle,next);return next;
  }
  if(request.type==='restoreHandoff'){
    let session=request.handle?sessions.get(request.handle):undefined;
    if(!session){
      const opened=await defaultAuthoring(request.target.kind==='source'
        ?{type:'open',accountId:request.accountId,viewId:request.viewId,botId:request.target.botId,groupId:request.target.groupId}
        :{type:'openDraftSource',accountId:request.accountId,viewId:request.viewId,draftId:request.target.draftId,baseRevision:request.target.baseRevision});
      if(opened.kind!=='session')throw new Error('Expected recovery session');
      session=opened;
    }
    if(!linked)return {kind:'handoffLinkRequired',session};
    if(!currentHandoff||currentHandoff.retryId!==request.retryId)return {kind:'handoffUnavailable',retryId:request.retryId,reason:'notFound'};
    return {kind:'handoffRestored',session:{...session,linked,operations},handoff:currentHandoff};
  }
  const session = sessionFor(request);
  switch(request.type) {
    case 'detach': case 'close': sessions.delete(request.handle);return {kind:'closed'};
    case 'beginHandoff':case 'beginDraftHandoff':{
      currentHandoff={retryId:request.retryId,groupId:snapshot(session.target.viewId).groups[0]!.id,state:'selecting',...(request.type==='beginDraftHandoff'&&{draftId:request.draftId})};
      return {kind:'handoff',handoff:currentHandoff};
    }
    case 'handoffStatus':case 'cancelHandoff':{
      if(!currentHandoff||currentHandoff.retryId!==request.retryId)throw new Error('来源请求不存在。');
      if(request.type==='cancelHandoff')currentHandoff={...currentHandoff,state:'cancelled'};
      return {kind:'handoff',handoff:currentHandoff};
    }
    case 'sourceHistory': return {kind:'sourceHistory',entries:[],nextCursor:null};
    case 'status': return {...session,linked,operations:operations.filter(item=>item.target.accountId===session.target.accountId&&item.target.viewId===session.target.viewId&&item.target.botId===session.target.botId)};
    case 'beginLink': return {kind:'challenge',challengeId,code:'0123456789abcdefabcd',expiresAt:Date.now()+300000};
    case 'inspectLink': return recipient ? {kind:'link',linked:false,recipient:{openId:'ou_verified',chatId:snapshot(A).groups[0]!.id,tenantKey:'tenant_verified'},evidence} : {kind:'link',linked:false};
    case 'confirmLink': linked=true;return {kind:'link',linked:true,recipient:{openId:'ou_verified',chatId:snapshot(A).groups[0]!.id,tenantKey:'tenant_verified'}};
    case 'reviewSource': return {kind:'source',target:session.target,groupId:request.groupId,groupName:'群聊 A',role:'只整理公开资料',reviewToken:evidence,untracked:true};
    case 'prepare': operations=[op(session)];return {kind:'operation',operation:operations[0]!};
    case 'edit': operations=[{...op(session),purpose:'editDraft',draftId:request.draftId,baseRevision:request.baseRevision}];return {kind:'operation',operation:operations[0]!};
    case 'inspectCandidate': return {kind:'candidate',operation:operations[0]!,payloadDigest:evidence,content:operations[0]!.purpose==='editDraft'?{schemaVersion:1,draftId,baseRevision:1,changes:[{op:'setDraftRole',value:'已核对的新角色'}]}:{public:{name:'',summary:'',overview:'正文由本人填写',version:'1',access:'direct'},config:{role:'已核对的新角色'}}};
    case 'cancel': operations=operations.map(item=>({...item,state:'cancelPending'}));return {kind:'operation',operation:operations[0]!};
    case 'resume': case 'resend': return {kind:'operation',operation:operations[0]!};
    case 'accept': throw new Error('Renderer must never accept a Feishu candidate');
  }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('IntersectionObserver',class {observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('matchMedia',()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
  HTMLElement.prototype.scrollIntoView=vi.fn();
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn(async()=>{})}});
  document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
  localStorage.clear();deviceSnapshot=snapshot;currentHandoff=undefined;status=signedIn();sourceRecord=null;calls=[];cloudCalls=[];sessions=new Map();nextHandle=0;linked=false;recipient=false;operations=[];
  draft={draftId,recipeId:null,revision:1,public:{name:'同一份私人草稿',summary:'本人填写的公开简介',overview:'',version:'1',access:'direct'},config:{role:'只整理公开资料'}};
  authoring=defaultAuthoring;
  cloud=async request=>{
    if(request.type==='catalog')return {hero:null,items:[],nextCursor:null};
    if(request.type==='drafts')return {items:[draft]};
    if(request.type==='publications')return {items:[]};
    if(request.type==='draft')return draft;
    if(request.type==='recoverRichDraftMetadata'&&draft.format==='rich-v2')return {status:'current',draft};
    if(request.type==='saveDraft') {draft={...draft,public:request.public,config:request.config,revision:draft.revision+1};return draft;}
    throw new Error('Unexpected cloud request '+request.type);
  };
  facade=createDesktopFacades({receive:listener=>{emit=listener;return()=>{};},invoke:async(channel,...args)=>{
    try {
      if(channel===desktopChannels.subscribe)return success(undefined);
      if(channel===desktopChannels.accountStatus)return success(status);
      if(channel===desktopChannels.snapshot)return success(deviceSnapshot(args.at(-1)));
      if(channel===desktopChannels.memory)return success({kind:'newCounts',projects:{},bots:{},dm:{}});
      if(channel===desktopChannels.run)return success({kind:'pendingGroups',groups:[]});
      if(channel===desktopChannels.admin)return success({kind:'judgeUsage',days:[],unreadBots:0});
      if(channel===desktopChannels.environment)return success({kind:'backends',entries:[]});
      if(channel===desktopChannels.recipeAuthoring){const request=desktopAuthoringRequestSchema.parse(args[0]);calls.push(request);return success(desktopAuthoringReplySchema.parse(await authoring(request)));}
      if(channel===desktopChannels.community){const request=communityRequestSchema.parse(args[0]);cloudCalls.push(request);return success(await cloud(request));}
      if(channel===desktopChannels.recipeSource)return success({source:sourceRecord});
      if(channel===desktopChannels.collaboration)return success({kind:'project',project:{name:'群聊 A',chatId:groupA,cwd:'/tmp/synthetic-authoring',kind:'multi',backend:'codex-appserver',enabled:true,revision:'1'}});
      if(channel===desktopChannels.close)return success(undefined);
      throw new Error('Unexpected desktop channel '+channel);
    }catch(error){return {ok:false,error:{kind:'rpc',message:error instanceof Error?error.message:'Fixture failed'}};}
  }});
});
afterEach(async()=>{await act(async()=>root.unmount());vi.useRealTimers();Reflect.deleteProperty(navigator,'clipboard');vi.unstubAllGlobals();vi.restoreAllMocks();});
async function draw(view=A) {
  await act(async()=>{emit({type:'devices',value:devicesState({id:view})});emit({type:'account',value:status});root.render(<DesktopRoot fallback={facade.client} shell={facade.shell}/>);});
}

it('opens over the creator workspace, links the actual private recipient, and sends once without reading source files in the App',async()=>{
  await draw();await chooseSource();
  expect(text()).toContain('草稿箱');
  expect(calls).toEqual([]);
  await click('确认');
  expect(calls.map(r=>r.type)).toEqual(['open','beginLink']);
  expect(calls[0]).toMatchObject({accountId:accountA,viewId:A,botId:botA,groupId:groupA});
  await click('我已发送，核对收件人');
  expect(dialog('准备配方')?.textContent).toContain('尚未收到关联命令');
  recipient=true;await click('我已发送，核对收件人');
  expect(dialog('准备配方')?.textContent).toContain('ou_verified');
  expect(calls.find(r=>r.type==='beginHandoff')).toBeUndefined();
  await click('这不是我，重新关联');expect(dialog('准备配方')?.textContent).not.toContain('ou_verified');
  await click('我已发送，核对收件人');await click('确认是我的私聊');
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  expect(calls).toContainEqual({type:'confirmLink',handle:[...sessions.keys()][0],challengeId,evidence});
  expect(dialog('准备配方')?.textContent).toContain('请在 Bot 私聊里选择内容');
  expect(dialog('准备配方')?.querySelector('input[type=checkbox]')).toBeNull();
  expect(calls.some(r=>['richInventory','richSourceOptions','richPrepare','accept'].includes(r.type))).toBe(false);
  await click('取消准备');expect(dialog('准备配方')?.textContent).toContain('已取消本次准备');
});

it.each(['dialog','application'] as const)('returns to source selection after confirmed cancellation and reopening the %s',async(kind)=>{
  linked=true;await draw();await chooseSource();await click('确认');
  const retryId=currentHandoff!.retryId;
  await click('取消准备');expect(dialog('准备配方')?.textContent).toContain('已取消本次准备');
  await click('关闭');
  if(kind==='application') {
    await act(async()=>root.unmount());root=createRoot(document.getElementById('root')!);
    await draw();await click('社区');await click('创作中心');
  }
  const before=calls.length;
  await click('准备配方');
  expect(dialog('准备配方')?.querySelectorAll('select')).toHaveLength(2);
  expect(dialog('准备配方')?.textContent).not.toContain('已取消本次准备');
  expect(calls.slice(before)).toEqual([]);
  await click('确认');
  expect(calls.filter(r=>r.type==='beginHandoff').map(r=>r.retryId)).toEqual([retryId,currentHandoff!.retryId]);
  expect(currentHandoff!.retryId).not.toBe(retryId);
});

it('retires a historical cancelled preparation after checking it and lets the next confirmation start a new one',async()=>{
  linked=true;await draw();await chooseSource();await click('确认');
  const retryId=currentHandoff!.retryId;
  await click('关闭');
  currentHandoff={...currentHandoff!,state:'cancelled'};
  await act(async()=>root.unmount());root=createRoot(document.getElementById('root')!);
  await draw();await click('社区');await click('创作中心');await click('准备配方');
  expect(calls.filter(r=>r.type==='restoreHandoff').at(-1)).toMatchObject({retryId});
  expect(dialog('准备配方')?.querySelectorAll('select')).toHaveLength(2);
  expect(dialog('准备配方')?.textContent).not.toContain('已取消本次准备');
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  await click('确认');
  expect(currentHandoff!.retryId).not.toBe(retryId);
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(2);
});

it.each(['selecting','deliveryUnknown','prepared'] as const)('restores a %s preparation instead of returning to source selection or sending another card',async(state)=>{
  linked=true;await draw();await chooseSource();await click('确认');
  const retryId=currentHandoff!.retryId;
  currentHandoff={...currentHandoff!,state};
  await click('关闭');await click('准备配方');
  expect(dialog('准备配方')?.querySelector('select')).toBeNull();
  expect(calls.filter(r=>r.type==='restoreHandoff').at(-1)).toMatchObject({retryId});
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
});

it('retains the retry identity across uncertain delivery and reopens only the accepted draft',async()=>{
  vi.useFakeTimers();linked=true;
  let lose=true;
  authoring=async r=>{const result=await defaultAuthoring(r);if(r.type==='beginHandoff'&&lose){lose=false;throw new Error('发送结果待核实');}return result;};
  await draw();await chooseSource();await click('确认');
  expect(dialog('准备配方')?.textContent).toContain('发送结果待核实');
  const initial=calls.find(r=>r.type==='beginHandoff')!;
  await click('关闭');await click('准备配方');
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  expect(calls.filter(r=>r.type==='restoreHandoff').at(-1)).toMatchObject({retryId:initial.retryId});
  expect(dialog('准备配方')?.textContent).toContain('请在 Bot 私聊里选择内容');
  const session=[...sessions.values()][0]!;
  operations=[{...op(session,'completed'),receipt:{status:'accepted',operationId,draftId,revision:1,stateRevision:3}}];
  currentHandoff={...currentHandoff!,state:'prepared',operationId};
  await act(async()=>vi.advanceTimersByTimeAsync(2000));expect(dialog('准备配方')?.textContent).toContain('私人草稿已保存');
  const view=Array.from(dialog('准备配方')!.querySelectorAll('button')).find(b=>b.textContent==='查看草稿')!;
  await act(async()=>view.click());
  expect(cloudCalls.filter(r=>r.type==='draft')).toEqual([{type:'draft',accountId:accountA,draftId}]);
});

it('revalidates the original retry after a disconnected session, without dispatching a second request',async()=>{
  linked=true;await draw();await chooseSource();await click('确认');
  const retryId=currentHandoff!.retryId;
  await click('关闭');
  let fail=true;authoring=async r=>{if(r.type==='restoreHandoff'&&fail){fail=false;throw new Error('请重新核验本人私聊。');}return defaultAuthoring(r);};
  await click('准备配方');expect(dialog('准备配方')?.textContent).toContain('重新核验本人私聊');
  await click('重试本次准备');expect(calls.filter(r=>r.type==='beginHandoff').map(r=>r.retryId)).toEqual([retryId]);
  expect(calls.filter(r=>r.type==='restoreHandoff').at(-1)).toMatchObject({retryId});
});

it.each(['stopped','unbound'] as const)('gives a %s Bot one actionable destination without opening a private session',async(kind)=>{
  deviceSnapshot=view=>{const s=snapshot(view);if(kind==='stopped')s.agents[0]!.running=false;else s.memberships=[];return s;};
  await draw();await click('社区');await click('创作中心');await click('准备配方');
  const box=dialog('准备配方')!;
  expect(box.querySelector('select')).toBeNull();expect(box.textContent).toContain(kind==='stopped'?'前往 Bot':'前往群组');
  expect(calls).toEqual([]);
});

it('never sends the previous account’s pending preparation after switching accounts',async()=>{
  await draw();await chooseSource();await click('确认');
  expect(dialog('准备配方')?.textContent).toContain('复制关联命令');
  await act(async()=>{status=signedIn(accountB);emit({type:'account',value:status});});
  expect(dialog('准备配方')).toBeUndefined();
  await click('创作中心');await click('准备配方');expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(0);
  await click('确认');expect(calls.filter(r=>r.type==='open').at(-1)).toMatchObject({accountId:accountB});
});

it('does not adopt a late open or send a card after the source device switches',async()=>{
  linked=true;
  let finish:(()=>void)|undefined;
  authoring=async r=>{const v=await defaultAuthoring(r);if(r.type==='open')return new Promise(resolve=>{finish=()=>resolve(v);});return v;};
  await draw();await chooseSource();await click('确认');
  const original=[...sessions.keys()][0]!;
  await act(async()=>emit({type:'devices',value:devicesState({id:B})}));
  await act(async()=>finish?.());
  expect(calls).toContainEqual({type:'detach',handle:original});expect(calls.some(r=>r.type==='beginHandoff')).toBe(false);
  expect(dialog('准备配方')?.textContent).not.toContain('Bot A');expect(dialog('准备配方')?.textContent).toContain('Bot B');
});

it('expires an unverified challenge and requires a new one before sending',async()=>{
  vi.useFakeTimers();await draw();await chooseSource();await click('确认');
  await act(async()=>vi.advanceTimersByTimeAsync(300000));expect(dialog('准备配方')?.textContent).toContain('短码已到期');
  const inspect=Array.from(dialog('准备配方')!.querySelectorAll('button')).find(b=>b.textContent==='我已发送，核对收件人')!;
  expect(inspect.disabled).toBe(true);await click('重新获取短码');expect(inspect.disabled).toBe(false);
  expect(calls.some(r=>r.type==='beginHandoff')).toBe(false);
});

it('keeps the same private draft and dirty text when Feishu saves a newer revision, then sends the current revision when reopened',async()=>{
  linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('编辑草稿');
  const input=await fill('配方名称','尚未保存的本地输入');input.focus();
  await click('在飞书继续编辑');await act(async()=>document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());await click('确认编辑 Bot');await click('发送继续编辑卡片');
  expect(calls.find(request=>request.type==='edit')).toMatchObject({draftId,baseRevision:1});
  draft={...draft,revision:2,public:{...draft.public,name:'飞书保存的新名称'}};
  operations=[{...operations[0]!,state:'completed',receipt:{operationId,status:'accepted',stateRevision:3,draftId,revision:2}}];await click('重新核验并继续');
  expect(document.querySelector('[aria-label="配方名称"]')).toBe(input);expect(input.value).toBe('尚未保存的本地输入');expect(text()).toContain('云端已有修订 2');
  await click('核对新修订');expect(document.querySelector('[role="dialog"]')?.textContent).toContain('飞书保存的新名称');
  await click('保留当前输入，使用此修订继续编辑');expect(input.value).toBe('尚未保存的本地输入');
  await click('发送继续编辑卡片');expect(calls.filter(request=>request.type==='edit').at(-1)).toMatchObject({draftId,baseRevision:2});
  await click('暂停聊天编辑');expect(calls.some(request=>request.type==='close')).toBe(true);expect(cloudCalls.some(request=>request.type==='deleteDraft')).toBe(false);
});

it('keeps an old-revision editing rejection visible and leaves the saved draft unchanged',async()=>{
  linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('在飞书继续编辑');
  await act(async()=>document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());await click('确认编辑 Bot');
  authoring=async request=>{if(request.type==='edit')throw new Error('草稿已在其他地方修改，请读取最新修订。');return defaultAuthoring(request);};
  await click('发送继续编辑卡片');expect(text()).toContain('请读取最新修订');expect(text()).toContain('同一份私人草稿');
  expect(cloudCalls.some(request=>request.type==='saveDraft'||request.type==='deleteDraft')).toBe(false);
});

it('never shows publication controls for a public third-party detail even when it was acquired',async()=>{
  cloud=async request=>{
    const detail={recipeId:A,versionId:B,revision:1,public:{...draft.public,name:'其他作者作品'},owned:false,acquired:true,config:draft.config};
    if(request.type==='catalog')return {hero:{recipeId:A,versionId:B,revision:1,public:detail.public},items:[],nextCursor:null};
    if(request.type==='detail')return detail;
    if(request.type==='shareLink')return {url:'https://community.example/recipes/'+A+'/versions/'+B};
    throw new Error('Unexpected third-party management request');
  };
  await draw();await click('社区');await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());
  expect(text()).toContain('其他作者作品');expect(text()).not.toContain('准备新版');expect(text()).not.toContain('管理此版本');expect(text()).not.toContain('发布管理');
  expect(cloudCalls.some(request=>request.type==='codes'||request.type==='issueCodes'||request.type==='saveDraft')).toBe(false);
});

it('opens the actual group Share tab with the current Bot and group fixed, and shares another author original version',async()=>{
  linked=true;
  sourceRecord={recipeId:A,versionId:B,revision:1,authorId:accountB,installedAt:1,sourceToken:evidence};
  const originalCloud=cloud;
  cloud=async request=>{
    if(request.type==='detail')return {recipeId:A,versionId:B,revision:1,public:{...draft.public,name:'原作者作品',access:'coded'},owned:false,acquired:true,config:draft.config};
    if(request.type==='shareLink')return {url:'https://community.example/recipes/'+A+'/versions/'+B};
    return originalCloud(request);
  };
  await draw();
  await click('群组');
  await act(async()=>document.querySelector<HTMLButtonElement>('.group-directory-identity')!.click());
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="设置 群聊 A 中的 Bot A"]')!.click());
  await click('分享');
  expect(document.querySelector('nav[aria-label="群设置"] button[aria-current]')?.textContent).toBe('分享');
  expect(text()).toContain('原作者作品');expect(text()).toContain('这是其他作者的作品');expect(text()).not.toContain('管理此版本');
  expect(document.querySelector('.authoring-source-list')).toBeNull();expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click('从本群准备配方');
  expect(dialog('准备配方')?.querySelector('select')).toBeNull();expect(dialog('准备配方')?.textContent).toContain('Bot A');
  await click('确认');expect(calls.find(r=>r.type==='beginHandoff')).toMatchObject({groupId:groupA});
  await click('关闭');
  expect(cloudCalls.find(request=>request.type==='shareLink')).toMatchObject({recipeId:A,versionId:B});
  await click('分享链接');expect(text()).toContain('已复制');expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://community.example/recipes/'+A+'/versions/'+B);
});

it('refreshes an untouched private draft after chat saves without opening a second draft',async()=>{
  linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('在飞书继续编辑');
  await act(async()=>document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());await click('确认编辑 Bot');await click('发送继续编辑卡片');
  draft={...draft,revision:2,public:{...draft.public,name:'私聊更新后的同一草稿'}};
  operations=[{...operations[0]!,state:'completed',receipt:{operationId,status:'accepted',stateRevision:3,draftId,revision:2}}];
  await click('重新核验并继续');expect(text()).toContain('私聊更新后的同一草稿');expect(text()).toContain('修订 2');
  expect(cloudCalls.filter(request=>request.type==='draft').every(request=>request.draftId===draftId)).toBe(true);
  expect(cloudCalls.some(request=>request.type==='saveDraft')).toBe(false);
});

it('keeps a newer successful save when an earlier chat refresh arrives late',async()=>{
  linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('编辑草稿');
  await click('在飞书继续编辑');await act(async()=>document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());await click('确认编辑 Bot');await click('发送继续编辑卡片');
  draft={...draft,revision:2,public:{...draft.public,name:'飞书修订'}};
  const stale=draft;let finish:((value:RecipeDraft)=>void)|undefined;let delay=true;const prior=cloud;
  cloud=async request=>{
    if(request.type==='draft'&&delay){delay=false;return new Promise(resolve=>{finish=resolve;});}
    if(request.type==='saveDraft'&&request.target.kind==='existing'&&request.target.revision!==draft.revision)throw new Error('修订冲突');
    return prior(request);
  };
  operations=[{...operations[0]!,state:'completed',receipt:{operationId,status:'accepted',stateRevision:3,draftId,revision:2}}];
  await click('重新核验并继续');expect(finish).toBeDefined();
  await fill('配方名称','本地已保存修订');await click('保存私人草稿');expect(text()).toContain('修订冲突');
  await click('读取最新草稿');await click('保留当前输入，使用此修订继续编辑');await click('保存私人草稿');
  expect(draft.revision).toBe(3);
  await click('预览发布');expect(dialog('确认发布到社区')?.textContent).toContain('本地已保存修订');
  await act(async()=>finish!(stale));
  expect((document.querySelector('[aria-label="配方名称"]') as HTMLInputElement).value).toBe('本地已保存修订');
  expect(document.querySelector('.authoring-draft-panel .community-muted')?.textContent).toContain('修订 3');
  expect(text()).toContain('私人草稿已保存');
  expect(dialog('确认发布到社区')?.textContent).toContain('本地已保存修订');
});

it('shows a failed accepted revision refresh on the read-only draft and retries the same draft',async()=>{
  linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('在飞书继续编辑');
  await act(async()=>document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());await click('确认编辑 Bot');await click('发送继续编辑卡片');
  draft={...draft,revision:2,public:{...draft.public,name:'重试后读到的同一草稿'}};
  const prior=cloud;cloud=async request=>{if(request.type==='draft')throw new Error('刷新失败哨兵');return prior(request);};
  operations=[{...operations[0]!,state:'completed',receipt:{operationId,status:'accepted',stateRevision:3,draftId,revision:2}}];
  await click('重新核验并继续');
  expect(text()).toContain('云端已保存，但 App 尚未读取最新修订');expect(text()).toContain('刷新失败哨兵');
  expect(text()).toContain('当前显示修订 1');expect(text()).toContain('云端已保存修订 2');expect(text()).toContain('同一份私人草稿');
  cloud=prior;await click('重新读取新修订');
  expect(text()).toContain('重试后读到的同一草稿');expect(text()).not.toContain('刷新失败哨兵');
  expect(document.querySelector('.authoring-draft-panel .community-muted')?.textContent).toContain('修订 2');
  expect(cloudCalls.filter(request=>request.type==='draft').every(request=>request.draftId===draftId)).toBe(true);
  expect(cloudCalls.some(request=>request.type==='saveDraft')).toBe(false);
});

it('shows a slow accepted-revision read and retains input entered while it is pending',async()=>{
  await openDraftChat();
  draft={...draft,revision:2,public:{...draft.public,name:'飞书已保存的内容'}};
  let finish:((value:RecipeDraft)=>void)|undefined;const prior=cloud;
  cloud=async request=>request.type==='draft'?new Promise(resolve=>{finish=resolve;}):prior(request);
  await acceptChatRevision(2);
  expect(text()).toContain('正在读取最新草稿');expect(text()).toContain('当前显示修订 1');expect(text()).toContain('云端已保存修订 2');
  await click('编辑草稿');const input=await fill('配方名称','读取期间继续输入');input.focus();input.setSelectionRange(2,4);
  await act(async()=>finish!(draft));
  expect(document.querySelector('[aria-label="配方名称"]')).toBe(input);expect(input.value).toBe('读取期间继续输入');
  expect(input.selectionStart).toBe(2);expect(input.selectionEnd).toBe(4);expect(text()).toContain('云端已有修订 2');
  await click('核对新修订');expect(document.querySelector('[role="dialog"]')?.textContent).toContain('飞书已保存的内容');
  await click('保留当前输入，使用此修订继续编辑');expect(input.value).toBe('读取期间继续输入');
  expect(document.querySelector('.authoring-draft-panel .community-muted')?.textContent).toContain('修订 2');
});

it('discards a late refresh failure after rebasing and saving a newer local revision',async()=>{
  await openDraftChat(true);
  draft={...draft,revision:2};let reject:((error:Error)=>void)|undefined;let delay=true;const prior=cloud;
  cloud=async request=>{
    if(request.type==='draft'&&delay){delay=false;return new Promise((_,fail)=>{reject=fail;});}
    if(request.type==='saveDraft'&&request.target.kind==='existing'&&request.target.revision!==draft.revision)throw new Error('修订冲突');
    return prior(request);
  };
  await acceptChatRevision(2);await fill('配方名称','本地成功的新修订');await click('保存私人草稿');
  await click('读取最新草稿');await click('保留当前输入，使用此修订继续编辑');await click('保存私人草稿');await click('预览发布');
  await act(async()=>reject!(new Error('已经过时的刷新错误')));
  expect(text()).not.toContain('已经过时的刷新错误');expect(text()).not.toContain('App 尚未读取最新修订');
  expect(dialog('确认发布到社区')?.textContent).toContain('本地成功的新修订');
  expect(document.querySelector('.authoring-draft-panel .community-muted')?.textContent).toContain('修订 3');
});

it.each(['success','failure'] as const)('keeps the newest overlapping refresh pending after an older %s',async(outcome)=>{
  await openDraftChat();
  draft={...draft,revision:2};const stale=draft;
  let finishFirst:((value:RecipeDraft)=>void)|undefined;let rejectFirst:((error:Error)=>void)|undefined;let finishSecond:((value:RecipeDraft)=>void)|undefined;let reads=0;const prior=cloud;
  cloud=async request=>{
    if(request.type==='draft')return ++reads===1?new Promise((resolve,reject)=>{finishFirst=resolve;rejectFirst=reject;}):new Promise(resolve=>{finishSecond=resolve;});
    return prior(request);
  };
  await acceptChatRevision(2);await click('发送继续编辑卡片');
  draft={...draft,revision:3,public:{...draft.public,name:'第二次读取的修订'}};await acceptChatRevision(3);
  await act(async()=>{if(outcome==='success')finishFirst!(stale);else rejectFirst!(new Error('更早读取的错误'));});
  expect(text()).toContain('正在读取最新草稿');expect(text()).toContain('当前显示修订 1');expect(text()).toContain('云端已保存修订 3');expect(text()).not.toContain('更早读取的错误');
  await act(async()=>finishSecond!(draft));
  expect(text()).toContain('第二次读取的修订');expect(text()).not.toContain('更早读取的错误');
  expect(document.querySelector('.authoring-draft-panel .community-muted')?.textContent).toContain('修订 3');
});

it('requires retry when the server read is older than the accepted cloud receipt',async()=>{
  await openDraftChat();await acceptChatRevision(2);
  expect(text()).toContain('云端已保存，但 App 尚未读取最新修订');expect(text()).toContain('尚未读取到目标草稿的新修订');
  expect(text()).toContain('当前显示修订 1');
  draft={...draft,revision:2,public:{...draft.public,name:'读取恢复后的原稿'}};await click('重新读取新修订');
  expect(text()).toContain('读取恢复后的原稿');expect(text()).not.toContain('尚未读取到目标草稿的新修订');
});

it('retains dirty input through a failed chat refresh and a successful retry until explicit conflict review',async()=>{
  await openDraftChat(true);const input=await fill('配方名称','失败与重试期间的输入');
  draft={...draft,revision:2,public:{...draft.public,name:'云端保留的修订'}};const prior=cloud;
  cloud=async request=>{if(request.type==='draft')throw new Error('读取暂时失败');return prior(request);};
  await acceptChatRevision(2);expect(text()).toContain('读取暂时失败');expect(input.value).toBe('失败与重试期间的输入');
  cloud=prior;await click('重新读取新修订');expect(input.value).toBe('失败与重试期间的输入');expect(text()).not.toContain('读取暂时失败');
  await click('核对新修订');expect(dialog('核对最新草稿')?.textContent).toContain('云端保留的修订');
  await click('保留当前输入，使用此修订继续编辑');expect(input.value).toBe('失败与重试期间的输入');
  expect(cloudCalls.some(request=>request.type==='saveDraft')).toBe(false);
});

it.each(['route','account'] as const)('ignores an abandoned %s refresh and its original onSaved callback after returning',async(kind)=>{
  const callbacks:Array<Parameters<typeof authoringUi.LegacyDraftChat>[0]['onSaved']>=[];
  const original=authoringUi.LegacyDraftChat;
  vi.spyOn(authoringUi,'LegacyDraftChat').mockImplementation(props=>{callbacks.push(props.onSaved);return original(props);});
  await openDraftChat();const oldCallback=callbacks[0]!;
  let reject:((error:Error)=>void)|undefined;const prior=cloud;
  cloud=async request=>request.type==='draft'?new Promise((_,fail)=>{reject=fail;}):prior(request);
  await acceptChatRevision(2);
  if(kind==='account') {
    await act(async()=>{status=signedIn(accountB);emit({type:'account',value:status});});
    expect(text()).not.toContain('同一份私人草稿');expect(text()).not.toContain('当前显示修订');
    const reads=cloudCalls.filter(request=>request.type==='draft').length;await act(async()=>oldCallback(draftId,2));
    expect(cloudCalls.filter(request=>request.type==='draft')).toHaveLength(reads);
    await act(async()=>{status=signedIn();emit({type:'account',value:status});});
  } else await click('返回创作中心');
  cloud=prior;operations=[];
  draft={...draft,draftId:challengeId,public:{...draft.public,name:'现在打开的另一份草稿'}};
  if(kind==='account')await click('创作中心');
  await click('查看草稿');
  const reads=cloudCalls.filter(request=>request.type==='draft').length;
  await act(async()=>{oldCallback(draftId,2);reject!(new Error('离开前的私有刷新错误'));});
  expect(cloudCalls.filter(request=>request.type==='draft')).toHaveLength(reads);
  expect(document.querySelector('.community-detail h1')?.textContent).toBe('现在打开的另一份草稿');expect(text()).not.toContain('离开前的私有刷新错误');
});

it('opens the exact published version from private group history and keeps uncertain records passive', async () => {
  linked = false;
  const secondOp = '019a8000-0000-7000-8000-000000000002';
  const thirdOp = '019a8000-0000-7000-8000-000000000003';
  authoring = async r => {
    if (r.type !== 'sourceHistory') return defaultAuthoring(r);
    return r.cursor ? {kind:'sourceHistory', entries:[{
      state:'published',operationId:thirdOp,draftId,recipeId:A,versionId:B,name:'本群最早的版本',version:'1.2',revision:2,
    }],nextCursor:null} : {kind:'sourceHistory',entries:[
      {state:'draft',operationId,draftId,recipeId:A,versionId:null,name:'私有历史草稿',version:'',revision:3},
      {state:'unknown',operationId:secondOp,draftId:null,recipeId:null,versionId:null},
    ],nextCursor:secondOp};
  };
  cloud = async r => {
    if (r.type === 'detail') return {recipeId:A,versionId:B,revision:2,owned:true,acquired:false,public:{...draft.public,name:'本群最早的版本'},config:{role:'历史版本角色'}};
    if (r.type === 'shareLink') return {url:'https://community.example/recipes/'+A+'/versions/'+B};
    if (r.type === 'catalog') return {hero:null,items:[],nextCursor:null};
    throw new Error('Unexpected request '+r.type);
  };
  await draw(); await click('群组');
  await act(async()=>document.querySelector<HTMLButtonElement>('.group-directory-identity')!.click());
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="设置 群聊 A 中的 Bot A"]')!.click());
  await click('分享');
  await click('本群分享历史');
  expect(text()).toContain('私有历史草稿');
  expect(text()).toContain('保存结果待核实');
  expect(cloudCalls.some(r=>r.type==='detail'||r.type==='draft'||r.type==='publishDraft')).toBe(false);
  await click('更多记录');
  expect(text()).toContain('私有历史草稿');
  expect(text()).toContain('本群最早的版本');
  await click('查看发布版本'); await click('能力');
  expect(text()).toContain('历史版本角色');
  expect(cloudCalls.find(r=>r.type==='detail')).toMatchObject({recipeId:A,versionId:B,accountId:accountA});
  expect(cloudCalls.some(r=>r.type==='publishDraft')).toBe(false);
});

it('refreshes a detached draft detail only for its account and draft without opening another chat lease',async()=>{
  linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');
  const before=cloudCalls.filter(r=>r.type==='draft').length;
  draft={...draft,revision:2,public:{...draft.public,name:'后台保存后的新名称'}};
  for(const ids of [{accountId:accountB,draftId},{accountId:accountA,draftId:challengeId}]) {
    await act(async()=>emit({type:'authoringSaved',value:{...ids,revision:2}}));
  }
  expect(cloudCalls.filter(r=>r.type==='draft')).toHaveLength(before);
  await act(async()=>emit({type:'authoringSaved',value:{accountId:accountA,draftId,revision:2}}));
  expect(text()).toContain('后台保存后的新名称'); expect(text()).toContain('修订 2');
  expect(calls.filter(r=>r.type==='open')).toHaveLength(0);
});

it('continues a rich draft at its verified source and keeps publication information editable when that source is unavailable',async()=>{
  const content=JSON.parse(readFileSync(resolve(process.cwd(),'../protocol/test/fixtures/recipe-rich-v2.content.json'),'utf8'));
  content.parts=[];content.memories=[];delete content.finalLogo;
  for(const field of ['name','summary','overview','version'])content.public[field].value=Reflect.get(draft.public,field);
  const doc=canonicalizeRichRecipeContent(content);
  draft=recipeRichDraftSchema.parse({draftId,recipeId:null,revision:1,public:draft.public,format:'rich-v2',sourceIntentId:operationId,
    rich:{content:doc.content,texts:{},canonical:Buffer.from(doc.canonicalUTF8).toString('base64url')}});
  linked=true;let missing=true;
  authoring=async r=>{if(r.type==='openDraftSource'&&missing)throw new Error('原 Bot 或群绑定已变化');return defaultAuthoring(r);};
  await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('在飞书私聊中修改');
  expect(dialog('在飞书私聊中修改')?.textContent).toContain('原 Bot 或群绑定已变化');
  expect(dialog('在飞书私聊中修改')?.querySelector('select')).toBeNull();
  await click('关闭');expect(text()).toContain('编辑发布信息');
  missing=false;await click('在飞书私聊中修改');
  expect(calls.filter(r=>r.type==='beginDraftHandoff')).toHaveLength(1);
  expect(calls.find(r=>r.type==='openDraftSource')).toMatchObject({accountId:accountA,viewId:A,draftId,baseRevision:1});
  expect(dialog('在飞书私聊中修改')?.textContent).toContain('群聊 A');
  expect(calls.some(r=>['open','richEdit','richInventory','saveDraft','saveRichMetadata'].includes(r.type))).toBe(false);
});


it.each(['selecting','prepared'] as const)('restores a truly deleted %s handle and keeps one private card and original draft',async state=>{
  vi.useFakeTimers();linked=true;let cardsSent=0;
  authoring=async request=>{if(request.type==='beginHandoff')cardsSent++;return defaultAuthoring(request);};
  await draw();await chooseSource();await click('确认');
  const initial=calls.find(r=>r.type==='beginHandoff')!;
  const original=sessions.get(initial.handle)!;
  if(state==='prepared'){
    operations=[op(original,'candidate')];currentHandoff={...currentHandoff!,state:'prepared',operationId};
    await act(async()=>vi.advanceTimersByTimeAsync(2000));
  }
  sessions.clear();
  await act(async()=>vi.advanceTimersByTimeAsync(state==='prepared'?4000:2000));
  expect(dialog('准备配方')?.textContent).toContain('操作已关闭');
  const before=calls.length;
  await click('重试本次准备');
  expect(calls.slice(before).find(r=>r.type==='restoreHandoff')).toMatchObject({accountId:accountA,viewId:A,handle:initial.handle,
    retryId:initial.retryId,target:{kind:'source',botId:botA,groupId:groupA}});
  const resumed=[...sessions.values()].at(-1)!;
  expect(resumed.handle).not.toBe(initial.handle);
  expect(resumed.target).toEqual(original.target);
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  expect(dialog('准备配方')?.textContent).toContain(state==='prepared'?'等待本人在飞书确认候选':'请在 Bot 私聊里选择内容');
  operations=[{...op(original,'completed'),receipt:{status:'accepted',operationId,draftId,revision:1,stateRevision:3}}];
  currentHandoff={...currentHandoff!,state:'prepared',operationId};
  await act(async()=>vi.advanceTimersByTimeAsync(2000));
  expect(dialog('准备配方')?.textContent).toContain('私人草稿已保存');
  await click('查看草稿');
  expect(cloudCalls.filter(r=>r.type==='draft')).toEqual([{type:'draft',accountId:accountA,draftId}]);
  expect(cardsSent).toBe(1);
});

it('retains an unavailable recovery pointer until an explicit new preparation',async()=>{
  linked=true;await draw();await chooseSource();await click('确认');
  const initial=calls.find(r=>r.type==='beginHandoff')!;
  const key=Object.keys(localStorage).find(key=>key.startsWith('recipe-private-handoff:'))!;
  const stored=localStorage.getItem(key);
  await click('关闭');currentHandoff=undefined;
  for(let i=0;i<2;i++){
    await click('准备配方');
    expect(dialog('准备配方')?.textContent).toContain('确认是否已有草稿');
    expect(localStorage.getItem(key)).toBe(stored);
    expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
    if(i===0)await click('查看创作中心');
  }
  expect(calls.filter(r=>r.type==='restoreHandoff').map(r=>r.retryId)).toEqual([initial.retryId,initial.retryId]);
  await click('重新准备');
  expect(dialog('准备配方')?.querySelectorAll('select')).toHaveLength(2);
  expect(localStorage.getItem(key)).toBeNull();
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  await click('确认');
  const begins=calls.filter(r=>r.type==='beginHandoff');
  expect(begins).toHaveLength(2);expect(begins[1]!.retryId).not.toBe(initial.retryId);
});

it('restores the retained preparation after private-link confirmation instead of beginning again',async()=>{
  linked=true;await draw();await chooseSource();await click('确认');
  const initial=calls.find(r=>r.type==='beginHandoff')!;
  await click('关闭');linked=false;
  await click('准备配方');recipient=true;
  await click('我已发送，核对收件人');await click('确认是我的私聊');
  expect(calls.filter(r=>r.type==='restoreHandoff').map(r=>r.retryId)).toEqual([initial.retryId,initial.retryId]);
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  expect(dialog('准备配方')?.textContent).toContain('请在 Bot 私聊里选择内容');
});

it('keeps a usable handle and polling after a transient restore error',async()=>{
  vi.useFakeTimers();linked=true;await draw();await chooseSource();await click('确认');
  const initial=calls.find(r=>r.type==='beginHandoff')!;
  let fail=true;
  authoring=async request=>{
    if(request.type==='handoffStatus'&&fail)throw new Error('临时读取失败');
    if(request.type==='restoreHandoff'&&fail){fail=false;throw new Error('临时恢复失败');}
    return defaultAuthoring(request);
  };
  await act(async()=>vi.advanceTimersByTimeAsync(2000));await click('重试本次准备');
  expect(dialog('准备配方')?.textContent).toContain('临时恢复失败');
  expect(sessions.has(initial.handle)).toBe(true);
  expect(calls.filter(r=>r.type==='detach')).toHaveLength(0);
  await act(async()=>vi.advanceTimersByTimeAsync(4000));
  expect(dialog('准备配方')?.textContent).not.toContain('临时恢复失败');
  expect(calls.filter(r=>r.type==='handoffStatus').at(-1)).toMatchObject({handle:initial.handle});
});

it.each(['close','device','account'] as const)('detaches a late restored handle after %s without changing the next flow',async change=>{
  vi.useFakeTimers();linked=true;await draw();await chooseSource();await click('确认');
  sessions.clear();await act(async()=>vi.advanceTimersByTimeAsync(2000));
  let finish:(()=>void)|undefined,lateHandle:string|undefined;
  authoring=async request=>{
    const value=await defaultAuthoring(request);
    if(request.type==='restoreHandoff'&&value.kind==='handoffRestored'){
      lateHandle=value.session.handle;
      return new Promise(resolve=>{finish=()=>resolve(value);});
    }
    return value;
  };
  const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='重试本次准备')!;
  await act(async()=>{button.click();});
  expect(finish).toBeDefined();
  if(change==='close')await click('关闭');
  if(change==='device')await act(async()=>emit({type:'devices',value:devicesState({id:B})}));
  if(change==='account')await act(async()=>{status=signedIn(accountB);emit({type:'account',value:status});});
  const currentText=dialog('准备配方')?.textContent;
  await act(async()=>{finish!();});
  expect(calls).toContainEqual({type:'detach',handle:lateHandle});
  expect(dialog('准备配方')?.textContent).toBe(currentText);
  expect(sessions.has(lateHandle!)).toBe(false);
});


it('keeps polling after a successful restore that reuses the same handle',async()=>{
  vi.useFakeTimers();linked=true;await draw();await chooseSource();await click('确认');
  const initial=calls.find(r=>r.type==='beginHandoff')!;
  const original=sessions.get(initial.handle)!;
  let fail=true;
  authoring=async request=>{if(request.type==='handoffStatus'&&fail)throw new Error('临时读取失败');return defaultAuthoring(request);};
  await act(async()=>vi.advanceTimersByTimeAsync(2000));
  fail=false;await click('重试本次准备');
  expect(sessions.has(initial.handle)).toBe(true);
  operations=[{...op(original,'completed'),receipt:{status:'accepted',operationId,draftId,revision:1,stateRevision:3}}];
  currentHandoff={...currentHandoff!,state:'prepared',operationId};
  await act(async()=>vi.advanceTimersByTimeAsync(12000));
  expect(dialog('准备配方')?.textContent).toContain('私人草稿已保存');
  await click('查看草稿');
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  expect(cloudCalls.filter(r=>r.type==='draft')).toEqual([{type:'draft',accountId:accountA,draftId}]);
});


function useRichDraft(){
  const content=JSON.parse(readFileSync(resolve(process.cwd(),'../protocol/test/fixtures/recipe-rich-v2.content.json'),'utf8'));
  content.parts=[];content.memories=[];delete content.finalLogo;
  for(const field of ['name','summary','overview','version'])content.public[field].value=Reflect.get(draft.public,field);
  const doc=canonicalizeRichRecipeContent(content);
  draft=recipeRichDraftSchema.parse({draftId,recipeId:null,revision:1,public:draft.public,format:'rich-v2',sourceIntentId:operationId,
    rich:{content:doc.content,texts:{},canonical:Buffer.from(doc.canonicalUTF8).toString('base64url')}});
}

it.each([false,true])('finds the original unresolved edit pointer after the draft advances (restart App %s)',async restart=>{
  useRichDraft();linked=true;await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('在飞书私聊中修改');
  const initial=calls.find(r=>r.type==='beginDraftHandoff')!;
  const original=sessions.get(initial.handle)!;
  const key=Object.keys(localStorage).find(key=>key.startsWith('recipe-private-handoff:'))!;
  await click('关闭');
  draft={...draft,revision:2};
  if(restart){
    await act(async()=>root.unmount());root=createRoot(document.getElementById('root')!);
    await draw();await click('社区');await click('创作中心');await click('查看草稿');
  }else await act(async()=>emit({type:'authoringSaved',value:{accountId:accountA,draftId,revision:2}}));
  operations=[{...op(original,'completed'),purpose:'editDraft',groupId:undefined,draftId,baseRevision:1,
    receipt:{status:'accepted',operationId,draftId,revision:2,stateRevision:3}}];
  currentHandoff={...currentHandoff!,state:'prepared',operationId};
  await click('在飞书私聊中修改');
  expect(calls.filter(r=>r.type==='restoreHandoff')).toEqual([expect.objectContaining({retryId:initial.retryId,target:{kind:'draft',draftId,baseRevision:1}})]);
  expect(calls.filter(r=>r.type==='beginDraftHandoff')).toHaveLength(1);
  expect(dialog('在飞书私聊中修改')?.textContent).toContain('私人草稿已保存');
  expect(localStorage.getItem(key)).not.toBeNull();
  await click('查看草稿');expect(localStorage.getItem(key)).toBeNull();
});

it('keeps ambiguous legacy edit pointers until an explicit new preparation',async()=>{
  useRichDraft();linked=true;draft={...draft,revision:3};
  const prefix='recipe-private-handoff:';
  const keys=[1,2].map(revision=>prefix+JSON.stringify([accountA,A,draftId,revision,null,null,null,null]));
  for(const key of keys)localStorage.setItem(key,JSON.stringify({retryId:crypto.randomUUID()}));
  await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('在飞书私聊中修改');
  expect(dialog('在飞书私聊中修改')?.textContent).toContain('确认是否已有草稿');
  expect(calls).toEqual([]);expect(keys.every(key=>localStorage.getItem(key)!==null)).toBe(true);
  await click('查看创作中心');
  expect(document.querySelector('.community-studio-heading h2')?.textContent).toBe('创作中心');
  expect(keys.every(key=>localStorage.getItem(key)!==null)).toBe(true);
  await click('查看草稿');await click('在飞书私聊中修改');await click('重新准备');
  expect(keys.every(key=>localStorage.getItem(key)===null)).toBe(true);
  await click('在飞书私聊中修改');
  expect(calls.filter(r=>r.type==='beginDraftHandoff')).toEqual([expect.objectContaining({draftId,baseRevision:3})]);
});

it('ignores unresolved draft pointers from another account, view or draft',async()=>{
  useRichDraft();linked=true;
  for(const [account,view,id] of [[accountB,A,draftId],[accountA,B,draftId],[accountA,A,challengeId]]){
    localStorage.setItem('recipe-private-handoff:'+JSON.stringify([account,view,id,1,null,null,null,null]),JSON.stringify({retryId:crypto.randomUUID()}));
  }
  await draw();await click('社区');await click('创作中心');await click('查看草稿');await click('在飞书私聊中修改');
  expect(calls.filter(r=>r.type==='restoreHandoff')).toEqual([]);
  expect(calls.filter(r=>r.type==='beginDraftHandoff')).toHaveLength(1);
});

it('navigates from a group recovery failure to the creation center and retains its pointer',async()=>{
  linked=true;await draw();await click('群组');
  await act(async()=>document.querySelector<HTMLButtonElement>('.group-directory-identity')!.click());
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="设置 群聊 A 中的 Bot A"]')!.click());
  await click('分享');await click('从本群准备配方');await click('确认');await click('关闭');currentHandoff=undefined;
  const key=Object.keys(localStorage).find(key=>key.startsWith('recipe-private-handoff:'))!;
  const pointer=localStorage.getItem(key);
  await click('从本群准备配方');await click('查看创作中心');
  expect(document.querySelector('.community-studio-heading h2')?.textContent).toBe('创作中心');
  expect(localStorage.getItem(key)).toBe(pointer);expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
});

it('navigates from a published-version recovery failure to the creation center',async()=>{
  useRichDraft();linked=true;
  const rich=draft.format==='rich-v2'?draft.rich:undefined;
  const originalCloud=cloud;
  const publication={recipeId:A,versionId:B,revision:1,public:draft.public,format:'rich-v2' as const};
  cloud=async request=>{
    if(request.type==='publications')return {items:[publication]};
    if(request.type==='detail')return {...publication,owned:true,acquired:false,state:'listed',rich};
    if(request.type==='shareLink')return {url:'https://community.example/recipes/'+A+'/versions/'+B};
    return originalCloud(request);
  };
  await draw();await click('社区');await click('创作中心');await click('管理此版本');await click('准备新版');await click('确认');await click('关闭');
  currentHandoff=undefined;
  await click('准备新版');await click('查看创作中心');
  expect(document.querySelector('.community-studio-heading h2')?.textContent).toBe('创作中心');
  expect(calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
  expect(calls.find(r=>r.type==='restoreHandoff')).toMatchObject({target:{kind:'source',parent:{recipeId:A,versionId:B}}});
});

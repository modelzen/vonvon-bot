// @vitest-environment jsdom
import {z} from 'zod';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {
  accountStatusSchema, recipeSummarySchema, recipeLibraryGroupsSchema, recipeLibraryVersionsSchema, communityRequestSchema, desktopAuthoringReplySchema, desktopAuthoringRequestSchema,
  desktopSnapshotSchema, type AccountStatus, type CommunityRequest, type DesktopAuthoringOperation,
  type DesktopAuthoringReply, type DesktopAuthoringRequest, type RecipeBrowseDetail, type RecipeDraft,
} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRoot} from '../src/devices/DesktopRoot';
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
let nativeLoginCalls: number;
let acknowledgedNavigations: string[];
let linked: boolean;
let externalCalls: string[];
let externalFailure: boolean;
let recipient: boolean;
let operations: DesktopAuthoringOperation[];
let draft: RecipeDraft;
let authoring: (request: DesktopAuthoringRequest) => Promise<DesktopAuthoringReply>;
let cloud: (request: CommunityRequest) => Promise<unknown>;
let sourceRecord: unknown;
let currentHandoff:AuthoringHandoff|undefined;
let deviceSnapshot= snapshot;
let facade: ReturnType<typeof createDesktopFacades>;
const pageCursor='aa.'+'a'.repeat(64);
function groupedReply(value: unknown, scope: string) {
  const page=z.object({items:z.array(recipeSummarySchema.extend({owned:z.boolean().optional(),acquired:z.boolean().optional(),versionCount:z.number().optional(),state:z.enum(['listed','withdrawn']).optional()})),nextCursor:z.string().nullable().optional()}).parse(value);
  return recipeLibraryGroupsSchema.parse({items:page.items.map(item=>{
    const {overview:_overview,...info}=item.public;
    return {...item,public:info,format:item.format??'role-v1',creator:item.creator??{authorId:accountA,displayName:'测试作者'},hasDisplayLogo:item.hasDisplayLogo??false,state:item.state??'listed',owned:item.owned??scope==='published',acquired:item.acquired??scope!=='published',versionCount:item.versionCount??1};
  }),nextCursor:page.nextCursor?pageCursor:null});
}
const success = (value: unknown) => ({ok:true,value});
const text = () => document.querySelector('main')?.textContent ?? '';
const dialog = (title: string) => [...document.querySelectorAll('[role="dialog"]')].find(element=>element.querySelector('header h2')?.textContent===title);
function browseFixture(recipeId: string, versionId: string, overrides: Partial<RecipeBrowseDetail> = {}): RecipeBrowseDetail {
  return {recipeId, versionId, revision: 1, format: 'role-v1', public: draft.public,
    creator: {authorId: accountB, displayName: '配方作者'}, owned: false, acquired: false,
    state: 'listed', hasDisplayLogo: false, preview: {settings: [], skills: [], ruleCount: 0, taskCount: 0}, ...overrides};
}
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
  await click('社区'); await click('我的配方'); await click('创作配方');
  const selects = document.querySelectorAll('select');
  expect(Array.from(selects).map(select => select.selectedOptions[0]?.textContent)).toEqual(['Bot A', '群聊 A']);
  await click('前往私聊创作');
}
async function openDraft() {
  await draw(); await click('社区'); await click('我的配方'); await click('创作中'); await click('查看配方');
}
async function defaultAuthoring(request: DesktopAuthoringRequest): Promise<DesktopAuthoringReply> {
  if (request.type === 'resourceHandoff') return {kind: 'resourceHandoff', accountId: request.accountId, viewId: request.viewId, botId: request.botId,
    botName: 'Bot A', tenant: 'feishu', target: request.target, requestId: request.requestId, delivery: 'sent'};
  if (request.type === 'creatorContinue') return {kind: 'creatorContinuing', delivery: request.entry.kind === 'draft' ? 'queued' : 'delivered', retryId: request.retryId, accountId: request.accountId, viewId: request.source?.viewId ?? (request.entry.kind === 'source' ? request.entry.viewId : A), botId: request.source?.botId ?? (request.entry.kind === 'source' ? request.entry.botId : botA), tenant: 'feishu', botName: 'Bot A'};
  if (request.type === 'open') {
    const handle = `00000000-0000-4000-8000-${String(++nextHandle).padStart(12, '0')}`;
    const session = {kind: 'session', handle, target: {accountId: request.accountId, accountName: '作者', viewId: request.viewId, botId: request.botId, botName: 'Bot A'}, linked, operations: []} satisfies Session;
    sessions.set(handle, session); return session;
  }
  if (request.type === 'detach' || request.type === 'close') {sessions.delete(request.handle); return {kind: 'closed'};}
  if (request.type === 'beginLink') return {kind: 'challenge', challengeId, code: '0123456789abcdefabcd', expiresAt: Date.now() + 300000};
  if (request.type === 'inspectLink') return recipient ? {kind: 'link', linked: false, recipient: {openId: 'ou_verified', chatId: groupA, tenantKey: 'tenant_verified'}, evidence} : {kind: 'link', linked: false};
  if (request.type === 'confirmLink') {linked = true; return {kind: 'link', linked: true};}
  if (request.type === 'sourceHistory') return {kind: 'sourceHistory', entries: [], nextCursor: null};
  throw new Error('Unexpected authoring request ' + request.type);
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('IntersectionObserver',class {observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('matchMedia',()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}));
  HTMLElement.prototype.scrollIntoView=vi.fn();
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn(async()=>{})}});
  document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
  localStorage.clear();nativeLoginCalls=0;acknowledgedNavigations=[];deviceSnapshot=snapshot;currentHandoff=undefined;status=signedIn();sourceRecord=null;calls=[];cloudCalls=[];sessions=new Map();nextHandle=0;linked=false;recipient=false;operations=[];externalCalls=[];externalFailure=false;
  draft={draftId,recipeId:null,revision:1,public:{name:'同一份私人草稿',summary:'本人填写的公开简介',overview:'',version:'1',access:'direct'},config:{role:'只整理公开资料'}};
  authoring=defaultAuthoring;
  cloud=async request=>{
    if(request.type==='catalog')return {hero:null,items:[],nextCursor:null};
    if(request.type==='recipeGroups')return {items:[],nextCursor:null};
    if(request.type==='drafts')return {items:[draft]};
    if(request.type==='publications')return {items:[]};
    if(request.type==='draft')return draft;
    if(request.type==='recoverRichDraftMetadata'&&draft.format==='rich-v2')return {status:'current',draft};
    if(request.type==='browse') return browseFixture(request.recipeId,request.versionId,{revision:7,creator:{authorId:accountA,displayName:'作者'},owned:true});
    if(request.type==='shareLink') return {url:'https://community.example/recipe'};
    throw new Error('Unexpected cloud request '+request.type);
  };
  facade=createDesktopFacades({receive:listener=>{emit=listener;return()=>{};},invoke:async(channel,...args)=>{
    try {
      if(channel===desktopChannels.subscribe)return success(undefined);
      if(channel===desktopChannels.accountStatus)return success(status);
      if(channel===desktopChannels.accountLogin){nativeLoginCalls++;status={kind:'signingIn'};emit({type:'account',value:status});return success(status);}
      if(channel===desktopChannels.accountCancel){status={kind:'signedOut',reason:'cancelled'};emit({type:'account',value:status});return success(status);}
      if(channel===desktopChannels.recipePreviewPending)return success([]);
      if(channel===desktopChannels.recipePreviewAcknowledge){acknowledgedNavigations.push(String(args[0]));return success(undefined);}
      if(channel===desktopChannels.snapshot)return success(deviceSnapshot(args.at(-1)));
      if(channel===desktopChannels.memory)return success({kind:'newCounts',projects:{},bots:{},dm:{}});
      if(channel===desktopChannels.run)return success({kind:'pendingGroups',groups:[]});
      if(channel===desktopChannels.admin)return success({kind:'judgeUsage',days:[],unreadBots:0});
      if(channel===desktopChannels.environment)return success({kind:'backends',entries:[]});
      if(channel===desktopChannels.recipeAuthoring){const request=desktopAuthoringRequestSchema.parse(args[0]);calls.push(request);return success(desktopAuthoringReplySchema.parse(await authoring(request)));}
      if(channel===desktopChannels.community){const request=communityRequestSchema.parse(args[0]);cloudCalls.push(request);const value=await cloud(request);if(request.type==='recipeGroups')return success(groupedReply(value,request.scope));if(request.type==='recipeGroupVersions'){const page=groupedReply(value,request.scope);return success(recipeLibraryVersionsSchema.parse({...page,items:page.items.map(({versionCount:_count,...version})=>version)}));}return success(value);}
      if(channel===desktopChannels.recipeSource)return success({source:sourceRecord});
      if(channel===desktopChannels.collaboration)return success({kind:'project',project:{name:'群聊 A',chatId:groupA,cwd:'/tmp/synthetic-authoring',kind:'multi',backend:'codex-appserver',enabled:true,revision:'1'}});
      if(channel===desktopChannels.external) {externalCalls.push(String(args[0])); if (externalFailure) throw new Error('Synthetic browser failure'); return success(undefined);}
      if(channel===desktopChannels.close)return success(undefined);
      throw new Error('Unexpected desktop channel '+channel);
    }catch(error){return {ok:false,error:{kind:'rpc',message:error instanceof Error?error.message:'Fixture failed'}};}
  }});
});
afterEach(async()=>{await act(async()=>root.unmount());vi.useRealTimers();Reflect.deleteProperty(navigator,'clipboard');vi.unstubAllGlobals();vi.restoreAllMocks();});
async function draw(view=A) {
  await act(async()=>{emit({type:'devices',value:devicesState({id:view})});emit({type:'account',value:status});root.render(<DesktopRoot fallback={facade.client} shell={facade.shell}/>);});
}

async function openResource() {
  const normal = cloud;
  cloud = async request => request.type === 'recipeGroups' ? {items: [{recipeId: accountB, versionId: draftId, revision: 1, public: draft.public}], nextCursor: null}
    : request.type === 'latestVersion' ? {status: 'unknown'}
      : request.type === 'browse' ? browseFixture(request.recipeId,request.versionId,{acquired:true}) : normal(request);
  await draw(); await click('社区'); await click('我的配方');
  await act(async () => document.querySelector<HTMLButtonElement>('.community-card')!.click());
  await click('交给 Bot');
}

it('hands an exact acquired resource to private chat without selecting or writing a group', async () => {
  await openResource();
  expect(calls).toEqual([]);
  expect(document.querySelector('select')?.getAttribute('aria-label')).toBe('接收配方的 Bot');
  expect(document.querySelectorAll('select')).toHaveLength(1);
  await click('前往私聊');
  expect(calls).toEqual([{type: 'resourceHandoff', accountId: accountA, viewId: A, botId: botA,
    target: {recipeId: accountB, versionId: draftId}, requestId: expect.any(String)}]);
  expect(externalCalls).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('私聊引导已发送');
  expect(cloudCalls.filter(request => request.type === 'browse')).toEqual([{type:'browse',accountId:accountA,recipeId:accountB,versionId:draftId}]);
  expect(cloudCalls.some(request => ['detail', 'richDetail', 'saveDraft', 'publishDraft', 'acquire'].includes(request.type))).toBe(false);
});

it('reconciles an uncertain resource delivery with the original identity and target', async () => {
  const normal = authoring;
  let attempts = 0;
  authoring = async request => {
    const reply = await normal(request);
    return reply.kind === 'resourceHandoff' && ++attempts === 1 ? {...reply, delivery: 'unknown'} : reply;
  };
  await openResource(); await click('前往私聊');
  expect(externalCalls).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('尚未确认');
  await click('核对交付');
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect(externalCalls).toHaveLength(1);
});

it('automatically reconciles one uncertain delivery using its original request', async () => {
  const normal = authoring;
  let attempts = 0;
  authoring = async request => {
    const reply = await normal(request);
    return reply.kind === 'resourceHandoff' && ++attempts === 1 ? {...reply, delivery: 'unknown'} : reply;
  };
  await openResource(); vi.useFakeTimers(); await click('前往私聊');
  await act(async () => {await vi.advanceTimersByTimeAsync(1500);});
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect(externalCalls).toHaveLength(1);
  expect(dialog('交给 Bot')?.textContent).toContain('私聊引导已发送');
});

it('keeps persistent uncertainty explicit after one automatic reconciliation', async () => {
  const normal = authoring;
  authoring = async request => {
    const reply = await normal(request);
    return reply.kind === 'resourceHandoff' ? {...reply, delivery: 'unknown'} : reply;
  };
  await openResource(); vi.useFakeTimers(); await click('前往私聊');
  await act(async () => {await vi.advanceTimersByTimeAsync(30_000);});
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  expect(externalCalls).toHaveLength(0);
  expect(dialog('交给 Bot')?.textContent).toContain('尚未确认');
});

it('reopens only the original Bot chat after its confirmed resource delivery', async () => {
  externalFailure = true;
  await openResource(); await click('前往私聊');
  expect(calls.filter(request => request.type === 'resourceHandoff')).toHaveLength(1);
  externalFailure = false; await click('打开 Bot 私聊');
  expect(externalCalls).toHaveLength(2); expect(externalCalls[1]).toBe(externalCalls[0]);
  expect(calls.filter(request => request.type === 'resourceHandoff')).toHaveLength(1);
});

it('links the first verified private recipient before repeating the same resource intent', async () => {
  const normal = authoring;
  authoring = async request => {
    if (request.type === 'resourceHandoff' && !linked) {
      const session = await defaultAuthoring({type: 'open', accountId: request.accountId, viewId: request.viewId, botId: request.botId});
      if (session.kind !== 'session') throw new Error('Fixture expected a session');
      return {kind: 'handoffLinkRequired', session};
    }
    return normal(request);
  };
  await openResource(); await click('前往私聊');
  expect(document.querySelector<HTMLInputElement>('[aria-label="私聊关联命令"]')?.value).toContain('/recipe link ');
  recipient = true; await click('我已发送，核对收件人'); await click('确认是我的私聊');
  const deliveries = calls.filter(request => request.type === 'resourceHandoff');
  expect(deliveries).toHaveLength(2); expect(deliveries[1]).toEqual(deliveries[0]);
  expect(externalCalls).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('私聊引导已发送');
});

it('discards a late resource handoff after switching accounts', async () => {
  const normal = authoring;
  let finish: (() => void) | undefined;
  authoring = async request => {
    if (request.type === 'resourceHandoff') await new Promise<void>(resolve => {finish = resolve;});
    return normal(request);
  };
  await openResource();
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '前往私聊')!.click();
  });
  await act(async () => {emit({type: 'account', value: signedIn(accountB)}); finish?.();});
  expect(externalCalls).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps the granted library version instead of looking up and opening an ungranted public update', async () => {
  const normal = cloud;
  cloud = async request => request.type === 'recipeGroups' ? {items: [{recipeId: accountB, versionId: draftId, revision: 1, public: draft.public}], nextCursor: null} : normal(request);
  await draw(); await click('社区'); await click('我的配方');
  expect(document.querySelector('.community-library-update')).toBeNull();
  expect(cloudCalls.some(request=>request.type==='latestVersion')).toBe(false);
  await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());
  expect(cloudCalls.filter(request=>request.type==='browse')).toEqual([{type:'browse',accountId:accountA,recipeId:accountB,versionId:draftId}]);
  expect(cloudCalls.some(request=>request.type==='acquire')).toBe(false);expect(calls).toEqual([]);
});

it('shows one account resource with its newest acquired version', async () => {
  const normal = cloud;
  cloud = async request => request.type === 'recipeGroups' ? {items: [{recipeId: accountB, versionId: operationId, revision: 2, versionCount:2, public: {...draft.public, version: '2.0'}}], nextCursor: null} : request.type === 'latestVersion' ? {status: 'unknown'}
    : request.type === 'browse' ? browseFixture(request.recipeId,request.versionId,{revision:2,public:{...draft.public,version:'2.0'},acquired:true}) : normal(request);
  await draw(); await click('社区'); await click('我的配方');
  expect(document.querySelectorAll('.community-card')).toHaveLength(1);
  expect(document.querySelector('.community-card-footer')?.textContent).toContain('2.0');
  expect(cloudCalls.filter(request => request.type === 'latestVersion')).toEqual([]);
  expect([...document.querySelectorAll('button')].some(button=>button.textContent==='选择版本 · 2 个')).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('.community-card')!.click());
  expect(cloudCalls.filter(request => request.type === 'browse')).toEqual([{type: 'browse', accountId: accountA, recipeId: accountB, versionId: operationId}]);
  expect(document.body.textContent).toContain('交给 Bot');
});


it('keeps My Recipes readonly and starts known draft continuation directly without choosing another source', async () => {
  localStorage.setItem('recipe-private-handoff:old', 'keep-existing-user-data');
  await openDraft();
  expect(document.querySelector('h1')?.textContent).toBe(draft.public.name);
  expect(document.querySelectorAll('.community-detail-layout nav button')).toHaveLength(5);
  expect(document.querySelector('input, textarea')).toBeNull();
  expect(text()).not.toMatch(/预览发布|编辑发布信息|编辑草稿/);
  await click('继续创作');
  expect(calls).toEqual([{type: 'creatorContinue', retryId: expect.any(String), accountId: accountA, entry: {kind: 'draft', draftId, revision: 1}}]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Bot 已接收继续创作请求');
  expect(document.body.textContent).not.toContain('已连接创作私聊');
  expect(localStorage.getItem('recipe-private-handoff:old')).toBe('keep-existing-user-data');
  expect(cloudCalls.map(request => request.type)).toEqual(['catalog', 'recipeGroups', 'drafts', 'draft']);
});

it('chooses actual source once and associates the private recipient before exact source continuation', async () => {
  await draw(); await chooseSource();
  expect(calls.map(request => request.type)).toEqual(['open', 'beginLink']);
  expect(document.querySelector<HTMLInputElement>('[aria-label="私聊关联命令"]')?.value).toBe('/recipe link 0123456789abcdefabcd');
  expect(calls[0]).toMatchObject({accountId: accountA, viewId: A, botId: botA, groupId: groupA});
  recipient = true;
  await click('我已发送，核对收件人');
  expect(document.body.textContent).toContain('ou_verified');
  await click('确认是我的私聊');
  expect(calls.filter(request => request.type === 'creatorContinue')).toEqual([{type: 'creatorContinue', retryId: expect.any(String), accountId: accountA, entry: {kind: 'source', viewId: A, botId: botA, groupId: groupA}}]);
  expect(calls.filter(request => ['beginHandoff', 'beginDraftHandoff', 'restoreHandoff'].includes(request.type))).toEqual([]);
  expect(calls.filter(request => request.type === 'open')).toHaveLength(1);
  expect(calls.at(-1)?.type).toBe('detach');
});

it('shows finite ambiguous sources without inferring a Bot from the active device or display name', async () => {
  linked = true;
  const normal = authoring;
  authoring = async request => request.type === 'creatorContinue' && !request.source
    ? {kind: 'creatorSourceRequired', options: [{viewId: B, botId: 'cli_author_b', botName: '相同名称'}, {viewId: A, botId: botA, botName: '相同名称'}]}
    : normal(request);
  await openDraft(); await click('继续创作');
  expect(calls).toHaveLength(1);
  expect(document.querySelectorAll('.authoring-source-list button')).toHaveLength(2);
  expect(document.querySelector('.authoring-source-list')?.textContent).toContain('家里');
  expect(document.querySelector('.authoring-source-list')?.textContent).not.toContain(B);
  await act(async () => document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());
  expect(calls.some(request => request.type === 'open')).toBe(false);
  expect(calls.filter(request => request.type === 'creatorContinue').at(-1)).toMatchObject({entry: {kind: 'draft', draftId, revision: 1}, source: {viewId: B, botId: 'cli_author_b'}});
});

it('ignores an association opened after the device switches and detaches only its obsolete handle', async () => {
  const normal = authoring;
  let finish!: (value: DesktopAuthoringReply) => void;
  authoring = async request => request.type === 'open' ? new Promise(resolve => {finish = resolve;}) : normal(request);
  await draw(); await chooseSource();
  const first = calls.find(request => request.type === 'open');
  if (first?.type !== 'open') throw new Error('Expected source open');
  await draw(B);
  await act(async () => finish(await normal(first)));
  expect(calls.filter(request => request.type === 'creatorContinue' || request.type === 'beginLink')).toEqual([]);
  expect(calls.filter(request => request.type === 'detach')).toHaveLength(1);
});

it('ignores an old account continuation receipt after another account takes over', async () => {
  let finish!: (value: DesktopAuthoringReply) => void;
  authoring = async () => new Promise(resolve => {finish = resolve;});
  await openDraft(); await click('继续创作');
  status = signedIn(accountB); await draw();
  await act(async () => finish({kind: 'creatorContinuing', delivery: 'delivered', retryId: challengeId, accountId: accountA, viewId: A, botId: botA, tenant: 'feishu', botName: 'Bot A'}));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(text()).not.toContain(draft.public.name);
  expect(externalCalls).toEqual([]);
});

it('routes only the current account and draft publication to the exact owned immutable version', async () => {
  await openDraft();
  const receipt = {accountId: accountA, draftId, recipeId: A, versionId: B, revision: 77};
  for (const value of [{...receipt, accountId: accountB}, {...receipt, draftId: A}]) await act(async () => emit({type: 'authoringPublished', value}));
  expect(document.querySelector('.recipe-draft-page')).not.toBeNull();
  expect(cloudCalls.filter(request => request.type === 'browse')).toEqual([]);
  await act(async () => emit({type: 'authoringPublished', value: receipt}));
  expect(cloudCalls.filter(request => request.type === 'browse')).toEqual([{type: 'browse', accountId: accountA, recipeId: A, versionId: B}]);
  expect(document.querySelector('.recipe-draft-page')).toBeNull();
  expect(document.querySelector('h1')?.textContent).toBe(draft.public.name);
  expect(document.body.textContent).not.toContain('创作新版本');
  expect(document.body.textContent).toContain('删除此版本');
  expect(calls).toEqual([]);
});

it('does not let a mismatched creator receipt claim that another account or source is ready', async () => {
  authoring = async () => ({kind: 'creatorContinuing', retryId: challengeId, delivery: 'delivered', accountId: accountB, viewId: B, botId: 'cli_author_b', tenant: 'lark', botName: 'Bot B'});
  await openDraft(); await click('继续创作');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('来源已变化');
  expect(document.body.textContent).not.toContain('已连接创作私聊');
});

it('expires a challenge before either recipient inspection or confirmation and keeps the work private', async () => {
  vi.useFakeTimers();
  await draw(); await chooseSource();
  await act(async () => vi.advanceTimersByTime(300001));
  expect(document.body.textContent).toContain('关联命令已过期');
  expect(calls.filter(request => request.type === 'creatorContinue')).toEqual([]);
  await click('重新关联');
  expect(calls.filter(request => request.type === 'beginLink')).toHaveLength(2);
});

it('keeps group settings free of recipe creation and source-version controls', async () => {
  sourceRecord = {recipeId: A, versionId: B, revision: 1, authorId: accountB, installedAt: 1, sourceToken: evidence};
  await draw(); await click('群组');
  await act(async () => document.querySelector<HTMLButtonElement>('.group-directory-identity')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="设置 群聊 A 中的 Bot A"]')!.click());
  expect([...document.querySelectorAll('.group-design-tabs button')].map(button => button.textContent)).not.toContain('分享');
  expect(text()).not.toMatch(/配方来源|检查新版|忽略此版本|从本群准备配方|创作配方/);
  expect(calls.filter(request => request.type === 'creatorContinue')).toEqual([]);
});

it('closes a continuation for an older draft revision when chat saves newer content', async () => {
  await openDraft(); await click('继续创作');
  draft = {...draft, revision: 2, public: {...draft.public, name: '新内容'}};
  await act(async () => emit({type: 'authoringSaved', value: {accountId: accountA, draftId, revision: 2}}));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(document.querySelector('h1')?.textContent).toBe('新内容');
  await click('继续创作');
  expect(calls.filter(request => request.type === 'creatorContinue').at(-1)).toMatchObject({entry: {kind: 'draft', draftId, revision: 2}});
});

it('opens the verified original private chat after sending the guide and retries opening without sending another card', async () => {
  linked = true;
  externalFailure = true;
  await draw(); await chooseSource();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已连接创作私聊');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Synthetic browser failure');
  expect(externalCalls).toEqual(['https://applink.feishu.cn/client/bot/open?appId=cli_author_a']);
  const sent = calls.filter(request => request.type === 'creatorContinue');
  expect(sent).toHaveLength(1);
  expect(document.querySelector('[aria-label="私聊关联命令"]')).toBeNull();
  externalFailure = false;
  await click('打开 Bot 私聊');
  expect(externalCalls).toHaveLength(2);
  expect(calls.filter(request => request.type === 'creatorContinue')).toEqual(sent);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it('continues a saved draft in its original Lark Bot even while another device is active', async () => {
  authoring = async request => request.type === 'creatorContinue'
    ? {kind: 'creatorContinuing', delivery: 'restored', retryId: request.retryId, accountId: accountA, viewId: B, botId: 'cli_author_b', botName: '原来源 Bot', tenant: 'lark'}
    : defaultAuthoring(request);
  await openDraft();
  await click('继续创作');
  expect(document.querySelector('[role="dialog"] select')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原来源 Bot');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(draft.public.name);
  expect(externalCalls).toEqual(['https://applink.larksuite.com/client/bot/open?appId=cli_author_b']);
  expect(calls).toEqual([{type: 'creatorContinue', retryId: expect.any(String), accountId: accountA, entry: {kind: 'draft', draftId, revision: 1}}]);
});

it('keeps a saved draft continuation and chat-open retry bound to its source when the selected device changes', async () => {
  await openDraft(); await click('继续创作'); await click('打开 Bot 私聊');
  await draw(B);
  expect(calls.filter(request => request.type === 'creatorContinue')).toHaveLength(1);
  expect(externalCalls).toEqual(['https://applink.feishu.cn/client/bot/open?appId=cli_author_a']);
  await click('打开 Bot 私聊');
  expect(calls.filter(request => request.type === 'creatorContinue')).toHaveLength(1);
  expect(externalCalls).toEqual(['https://applink.feishu.cn/client/bot/open?appId=cli_author_a', 'https://applink.feishu.cn/client/bot/open?appId=cli_author_a']);
});

it('refreshes the draft list after successful deletion', async () => {
  const prior = cloud;
  let deleted = false;
  cloud = async request => {
    if (request.type === 'deleteDraft') {deleted = true; return {draftId, deleted};}
    if (request.type === 'drafts' && deleted) return {items: []};
    return prior(request);
  };
  await openDraft(); await click('删除未发布配方'); await click('删除');
  expect(deleted).toBe(true);
  expect(cloudCalls.filter(r => r.type === 'drafts')).toHaveLength(2);
  expect(document.querySelector('.community-workspace-tabs [aria-current]')?.textContent).toBe('创作中');
  expect(document.querySelector('.community-studio-row strong')).toBeNull();
});

it('retains the original continuation across a transient stale membership read', async () => {
  linked = true;
  await draw(); await chooseSource();
  expect(calls.filter(r=>r.type==='creatorContinue')).toHaveLength(1);
  const first = snapshot(A);
  await act(async () => emit({type:'snapshot', view:A, value:{...first,revision:2, memberships:first.memberships.map(item=>({...item,stale:true}))}}));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已连接创作私聊');
  await act(async () => emit({type:'snapshot', view:A, value:{...first,revision:3}}));
  expect(calls.filter(r=>r.type==='creatorContinue')).toHaveLength(1);
  expect(externalCalls).toHaveLength(1);
});

it('shows a background private-chat save in the open drafts list and ignores other accounts',async()=>{
  const prior=cloud;
  let ready=false;
  cloud=async request=>request.type==='drafts'?{items:ready?[draft]:[]}:prior(request);
  await draw();await click('社区');await click('我的配方');await click('创作中');
  expect(text()).toContain('还没有创作中的配方');
  const reads=()=>cloudCalls.filter(row=>row.type==='drafts').length;
  const before=reads();
  ready=true;
  await act(async()=>emit({type:'authoringSaved',value:{accountId:accountB,draftId,revision:1}}));
  expect(reads()).toBe(before);
  await act(async()=>emit({type:'authoringSaved',value:{accountId:accountA,draftId,revision:1}}));
  expect(reads()).toBe(before+1);
  expect(text()).toContain(draft.public.name);
  expect(document.querySelector('[aria-label="我的配方内容"] [aria-current="page"]')?.textContent).toBe('创作中');
});

it('reconciles a missed save when returning from Feishu to the open drafts list',async()=>{
  const prior=cloud;
  let ready=false;
  cloud=async request=>request.type==='drafts'?{items:ready?[draft]:[]}:prior(request);
  await draw();await click('社区');await click('我的配方');await click('创作中');
  expect(text()).toContain('还没有创作中的配方');
  ready=true;
  await act(async()=>window.dispatchEvent(new Event('focus')));
  expect(text()).toContain(draft.public.name);
  await click('已获取');
  const before=cloudCalls.filter(row=>row.type==='drafts').length;
  await act(async()=>window.dispatchEvent(new Event('focus')));
  expect(cloudCalls.filter(row=>row.type==='drafts')).toHaveLength(before);
});

it('preserves acquired pagination on a separate draft save', async () => {
 const prior=cloud;
 cloud=async request=>{
   if(request.type==='recipeGroups'){
     const id=request.cursor?B:A;
     return {items:[{recipeId:id,versionId:id,revision:1,public:{...draft.public,name:request.cursor?'第二页':'第一页'}}],nextCursor:request.cursor?null:B};
   }
   return prior(request);
 };
 await draw(); await click('社区'); await click('我的配方'); await click('加载更多');
 expect(document.querySelectorAll('.community-card')).toHaveLength(2);
 await act(async()=>emit({type:'authoringSaved',value:{accountId:accountA,draftId,revision:2}}));
 expect(document.querySelectorAll('.community-card')).toHaveLength(2);
 const main=document.getElementById('main-content')!;
 main.scrollTop=320;
 await click('创作中');
 expect(main.scrollTop).toBe(0);
 await click('已获取');
 expect(main.scrollTop).toBe(320);
 expect(document.querySelectorAll('.community-card')).toHaveLength(2);
 expect(cloudCalls.filter(row=>row.type==='recipeGroups').map(row=>row.cursor)).toEqual([undefined,pageCursor]);
});

it.each(['deliveryUnknown','lostReply'] as const)('preserves the request key and separates chat-open from send recovery after %s',async fault=>{
  linked=true;
  authoring=async request=>{
    const reply=await defaultAuthoring(request);
    if(request.type!=='creatorContinue'||reply.kind!=='creatorContinuing'||request.recover)return reply;
    if(fault==='lostReply')throw Error('fixture lost reply');
    return {...reply,delivery:'deliveryUnknown'};
  };
  await draw();await chooseSource();
  expect(document.body.textContent).not.toContain('已连接创作私聊');
  expect(externalCalls).toEqual([]);
  if(fault==='deliveryUnknown'){
    await click('打开 Bot 私聊');
    expect(calls.filter(row=>row.type==='creatorContinue')).toHaveLength(1);
    await click('核对并重试');
  }else await click('核对上次请求');
  const [original,recovery]=calls.filter(row=>row.type==='creatorContinue');
  expect(original?.retryId).toEqual(expect.any(String));
  expect(recovery).toEqual({...original,recover:fault==='deliveryUnknown'?'handoff':'request'});
  expect(document.body.textContent).toContain('已连接创作私聊');
  expect(externalCalls).toHaveLength(fault==='deliveryUnknown'?2:1);
});
it('invalidates an in-flight continuation when the real group binding changes and never restarts it on another snapshot',async()=>{
  linked=true;
  let finish!:()=>void;
  authoring=async request=>{
    if(request.type==='creatorContinue')await new Promise<void>(resolve=>{finish=resolve;});
    return defaultAuthoring(request);
  };
  await draw();await chooseSource();
  const first=snapshot(A);
  await act(async()=>emit({type:'snapshot',view:A,value:{...first,revision:2,memberships:first.memberships.map(row=>({...row,bindingIncarnation:B}))}}));
  await act(async()=>{finish();});
  await act(async()=>emit({type:'snapshot',view:A,value:{...first,revision:3}}));
  expect(externalCalls).toEqual([]);
  expect(calls.filter(row=>row.type==='creatorContinue')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"] select')).not.toBeNull();
});

it.each(['queued','restored'] as const)('distinguishes a %s draft continuation from a newly sent card',async delivery=>{
  authoring=async request=>{
    const reply=await defaultAuthoring(request);
    return reply.kind==='creatorContinuing'?{...reply,delivery}:reply;
  };
  await openDraft();await click('继续创作');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(delivery==='queued'?'正在准备草稿':'可以回到原私聊继续创作');
  expect(document.body.textContent).not.toContain('已连接创作私聊');
  expect(externalCalls).toHaveLength(delivery==='queued'?0:1);
  await click('打开 Bot 私聊');
  expect(calls.filter(row=>row.type==='creatorContinue')).toHaveLength(1);
});

it('recovers the original handoff after the confirmation succeeded but its continuation reply was lost',async()=>{
  let first=true;
  authoring=async request=>{
    if(request.type==='creatorContinue'&&first){first=false;throw Error('fixture lost reply');}
    return defaultAuthoring(request);
  };
  await draw();await chooseSource();recipient=true;
  await click('我已发送，核对收件人');await click('确认是我的私聊');
  await click('核对上次请求');
  const [initial,recovery]=calls.filter(row=>row.type==='creatorContinue');
  expect(recovery).toEqual({...initial,recover:'request'});
  expect(calls.filter(row=>row.type==='confirmLink')).toHaveLength(1);
  expect(externalCalls).toHaveLength(1);
});

it('does not send or open again while snapshots refresh an unconfirmed handoff',async()=>{
  linked=true;
  authoring=async request=>{
    const reply=await defaultAuthoring(request);
    return reply.kind==='creatorContinuing'?{...reply,delivery:'deliveryUnknown'}:reply;
  };
  await draw();await chooseSource();
  const first=snapshot(A);
  for(const [i,stale] of [true,false,false].entries())await act(async()=>emit({type:'snapshot',view:A,value:{...first,revision:2+i,memberships:first.memberships.map(row=>({...row,stale}))}}));
  expect(calls.filter(row=>row.type==='creatorContinue')).toHaveLength(1);
  expect(externalCalls).toHaveLength(0);
  expect(document.body.textContent).toContain('核对并重试');
});

it('does not open a newly inferred chat when a legacy request lost both its reply and its original source',async()=>{
  authoring=async request=>{
    if(request.type!=='creatorContinue')return defaultAuthoring(request);
    if(!request.recover)throw Error('fixture lost reply');
    return {kind:'creatorUnverified',retryId:request.retryId,accountId:request.accountId};
  };
  await openDraft();await click('继续创作');await click('核对上次请求');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('之前创作的私聊');
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('打开 Bot 私聊');
  expect(externalCalls).toHaveLength(0);
});

it('retains the unresolved delivery identity when its dialog reopens', async () => {
  const normal = authoring;
  authoring = async r => {const v = await normal(r); return v.kind === 'resourceHandoff' ? {...v,delivery:'unknown'} : v;};
  await openResource(); await click('前往私聊');
  expect(dialog('交给 Bot')?.textContent).toContain('尚未确认');
  await act(async () => [...dialog('交给 Bot')!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='关闭')!.click());
  await click('交给 Bot'); await click('前往私聊');
  const ids=calls.filter(r=>r.type==='resourceHandoff').map(r=>r.requestId);
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  expect(externalCalls).toHaveLength(0);
});

it('reconciles delivery after a consumed first-link challenge', async () => {
  const normal = authoring;
  let failDelivery = true;
  authoring = async r => {
    if(r.type==='resourceHandoff'&&!linked){
      const session=await defaultAuthoring({type:'open',accountId:r.accountId,viewId:r.viewId,botId:r.botId});
      if(session.kind!=='session') throw Error('invalid fixture');
      return {kind:'handoffLinkRequired',session};
    }
    if(r.type==='resourceHandoff'&&linked&&failDelivery) {failDelivery=false;throw Error('transient transport failure');}
    if(r.type==='confirmLink'&&linked) throw Error('consumed challenge');
    return normal(r);
  };
  await openResource(); await click('前往私聊');
  recipient=true; await click('我已发送，核对收件人'); await click('确认是我的私聊');
  expect(linked).toBe(true); expect(dialog('交给 Bot')?.textContent).toContain('transient transport failure');
  const before=calls.filter(r=>r.type==='resourceHandoff').length;
  await click('核对交付');
  expect(dialog('交给 Bot')?.textContent).toContain('私聊引导已发送');
  expect(calls.filter(r=>r.type==='resourceHandoff')).toHaveLength(before+1);
  expect(calls.filter(r=>r.type==='confirmLink')).toHaveLength(1);
});

it('reports a chat-opening failure while keeping delivery confirmed', async () => {
  externalFailure=true; await openResource(); await click('前往私聊');
  expect(dialog('交给 Bot')?.textContent).toContain('私聊引导已发送');
  expect(dialog('交给 Bot')?.textContent).toContain('未能打开私聊');
  expect(dialog('交给 Bot')?.textContent).not.toContain('交付尚未完成');
  expect(externalCalls).toHaveLength(1);
});

async function arrangeFirstLink(afterLink?: (request: DesktopAuthoringRequest) => Promise<DesktopAuthoringReply>) {
  authoring = async r=>{
    if(r.type==='resourceHandoff'&&!linked){
      const session=await defaultAuthoring({type:'open',accountId:r.accountId,viewId:r.viewId,botId:r.botId});
      if(session.kind!=='session')throw Error('fixture session');
      return {kind:'handoffLinkRequired',session};
    }
    return afterLink ? afterLink(r) : defaultAuthoring(r);
  };
}
it('reconciles a lost confirmation reply through the original resource intent', async () => {
  await arrangeFirstLink(async request=>{
    if(request.type==='confirmLink'){
      if(linked)throw Error('consumed challenge');
      await defaultAuthoring(request);
      throw Error('confirmation reply lost');
    }
    return defaultAuthoring(request);
  });
  await openResource(); await click('前往私聊'); recipient=true;
  await click('我已发送，核对收件人'); await click('确认是我的私聊');
  expect(linked).toBe(true); expect(dialog('交给 Bot')?.textContent).toContain('confirmation reply lost');
  await click('核对交付');
  expect(dialog('交给 Bot')?.textContent).toContain('私聊引导已发送');
  expect(calls.filter(r=>r.type==='resourceHandoff')).toHaveLength(2);
  expect(calls.filter(r=>r.type==='confirmLink')).toHaveLength(1);
});
it('shows each inspected recipient fact before confirmation', async () => {
  await arrangeFirstLink(); await openResource(); await click('前往私聊'); recipient=true;
  await click('我已发送，核对收件人');
  expect(dialog('交给 Bot')?.textContent).toContain('确认是我的私聊');
  for(const fact of ['ou_verified',groupA,'tenant_verified']) expect(dialog('交给 Bot')?.textContent).toContain(fact);
});
it('discards a late receipt after an A to B to A device round trip', async () => {
  let resolveHandoff!:()=>void;
  authoring=async r=>{
    if(r.type==='resourceHandoff')await new Promise<void>(resolve=>resolveHandoff=resolve);
    return defaultAuthoring(r);
  };
  await openResource(); await click('前往私聊');
  await act(async()=>emit({type:'devices',value:devicesState({id:B})}));
  expect(dialog('交给 Bot')?.textContent).toContain('账号或设备已切换');
  await act(async()=>emit({type:'devices',value:devicesState({id:A})}));
  await act(async()=>resolveHandoff());
  expect(externalCalls).toHaveLength(0);
});
it('releases a late native handle after its dialog closes', async () => {
  let resolveLink!:()=>void;
  authoring=async r=>{
    if(r.type==='resourceHandoff'){
      await new Promise<void>(resolve=>resolveLink=resolve);
      const session=await defaultAuthoring({type:'open',accountId:r.accountId,viewId:r.viewId,botId:r.botId});
      if(session.kind!=='session')throw Error('fixture session');
      return {kind:'handoffLinkRequired',session};
    }
    return defaultAuthoring(r);
  };
  await openResource(); await click('前往私聊');
  await act(async()=>[...dialog('交给 Bot')!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='关闭')!.click());
  await act(async()=>resolveLink());
  expect(sessions.size).toBe(0);
  expect(calls.some(r=>r.type==='detach')).toBe(true);
});

it('keeps the newer dialog ownership when the same native link handle arrives late', async () => {
  let finish: (() => void) | undefined, shared: Session | undefined, attempts = 0;
  authoring = async request => {
    if (request.type !== 'resourceHandoff') return defaultAuthoring(request);
    if (!shared) {
      const value = await defaultAuthoring({type: 'open', accountId: request.accountId, viewId: request.viewId, botId: request.botId});
      if (value.kind !== 'session') throw new Error('Fixture expected a session');
      shared = value;
    }
    if (++attempts === 1) await new Promise<void>(resolve => {finish = resolve;});
    return {kind: 'handoffLinkRequired', session: shared};
  };
  await openResource(); await click('前往私聊');
  await act(async () => [...dialog('交给 Bot')!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '关闭')!.click());
  await click('交给 Bot'); await click('前往私聊');
  expect(document.querySelector('[aria-label="私聊关联命令"]')).not.toBeNull();
  await act(async () => finish?.());
  expect(calls.filter(request => request.type === 'detach')).toEqual([]);
  expect(sessions.size).toBe(1);
  await act(async () => [...dialog('交给 Bot')!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '关闭')!.click());
  expect(sessions.size).toBe(0);
});

it('preserves an unresolved resource intent after leaving and returning to the community', async () => {
  const normal = authoring;
  authoring = async request => {
    const reply = await normal(request);
    return reply.kind === 'resourceHandoff' ? {...reply, delivery: 'unknown'} : reply;
  };
  await openResource(); await click('前往私聊');
  await act(async () => [...dialog('交给 Bot')!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '关闭')!.click());
  await click('Bot'); await click('社区');
  await click('交给 Bot'); await click('前往私聊');
  const requests = calls.filter(request => request.type === 'resourceHandoff');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
});

it('starts a new explicit delivery after the former request definitely failed', async () => {
  const normal = authoring;
  let failed = false;
  authoring = async request => {
    const reply = await normal(request);
    if (reply.kind === 'resourceHandoff' && !failed) {failed = true; return {...reply, delivery: 'unavailable'};}
    return reply;
  };
  await openResource(); await click('前往私聊'); await click('重新交付');
  const requests = calls.filter(request => request.type === 'resourceHandoff');
  expect(requests).toHaveLength(2); expect(requests[1]?.requestId).not.toBe(requests[0]?.requestId);
  expect(requests[1]?.target).toEqual(requests[0]?.target);
  expect(externalCalls).toHaveLength(1);
});

it('keeps incomplete publication metadata in private preview and guides back to Bot chat', async () => {
  draft.public = {...draft.public, name: '', summary: '', version: ''};
  await openDraft();
  expect(document.querySelector('h1')?.textContent).toBe('未命名配方');
  expect(document.body.textContent).toContain('请在 Bot 私聊中补充名称、简介、版本后再发布');
  const publish = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '发布到社区');
  expect(publish?.disabled).toBe(true);
  expect(calls.some(request => request.type === 'preparePublication')).toBe(false);
  await click('继续创作');
  expect(calls).toMatchObject([{type: 'creatorContinue', entry: {kind: 'draft', draftId, revision: 1}}]);
});

it('releases a terminal failed intent before closing and reopening the delivery dialog', async () => {
  const normal = authoring;
  authoring = async request => {
    const reply = await normal(request);
    return reply.kind === 'resourceHandoff' ? {...reply, delivery: 'unavailable'} : reply;
  };
  await openResource(); await click('前往私聊');
  await act(async () => [...dialog('交给 Bot')!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '关闭')!.click());
  await click('交给 Bot'); await click('前往私聊');
  const requests = calls.filter(request => request.type === 'resourceHandoff');
  expect(requests).toHaveLength(2); expect(requests[1]?.requestId).not.toBe(requests[0]?.requestId);
  expect(externalCalls).toHaveLength(0);
});

it('keeps the original Bot on an explicit retry when another Bot becomes the only online choice', async () => {
  const normal = authoring;
  let failed = false;
  authoring = async request => {
    const reply = await normal(request);
    if (reply.kind === 'resourceHandoff' && !failed) {failed = true; return {...reply, delivery: 'unavailable'};}
    return reply;
  };
  await openResource(); await click('前往私聊');
  const next = {...snapshot(B), revision: 2};
  deviceSnapshot = () => next;
  await act(async () => emit({type: 'snapshot', view: A, value: next}));
  await click('重新交付');
  expect(calls.filter(request => request.type === 'resourceHandoff')).toHaveLength(1);
  expect(externalCalls).toHaveLength(0);
  expect(dialog('交给 Bot')?.textContent).toContain('接收 Bot：Bot A');
  expect(dialog('交给 Bot')?.textContent).toContain('原 Bot 暂不可用');
  const restored = {...snapshot(A), revision: 3};
  deviceSnapshot = () => restored;
  await act(async () => emit({type: 'snapshot', view: A, value: restored}));
  await click('核对交付');
  const requests = calls.filter(request => request.type === 'resourceHandoff');
  expect(requests).toHaveLength(2); expect(requests[1]?.botId).toBe(botA);
  expect(externalCalls).toHaveLength(1);
});

it('opens the existing Bot and group chooser directly from a website creation navigation without sending anything', async () => {
  linked = true;
  await draw();
  await act(async()=>emit({type:'recipePreview',value:{kind:'create',navigationId:draftId}}));
  expect(dialog('创作配方')).toBeDefined();
  expect(Array.from(document.querySelectorAll('select')).map(select=>select.selectedOptions[0]?.textContent)).toEqual(['Bot A','群聊 A']);
  expect(calls).toEqual([]);
  expect(externalCalls).toEqual([]);
  expect(cloudCalls.some(request=>['publishDraft','saveDraft','acquire'].includes(request.type))).toBe(false);
  await click('前往私聊创作');
  expect(calls.find(request=>request.type==='creatorContinue')).toMatchObject({accountId:accountA,entry:{kind:'source',viewId:A,botId:botA,groupId:groupA}});
});
it('offers App login before revealing creation sources and retains the incoming creation after login', async () => {
  status={kind:'signedOut'};
  await draw();
  await act(async()=>emit({type:'recipePreview',value:{kind:'create',navigationId:draftId}}));
  expect(dialog('创作配方')?.textContent).toContain('登录后可以');
  expect([...document.querySelectorAll('button')].some(button=>button.textContent==='登录'&&!button.disabled)).toBe(true);
  expect(document.querySelector('[aria-label="配方来源 Bot"]')).toBeNull();
  expect(calls).toEqual([]);
  status=signedIn();
  await act(async()=>emit({type:'account',value:status}));
  expect(document.querySelector('[aria-label="配方来源 Bot"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="配方来源群聊"]')).not.toBeNull();
  expect(calls).toEqual([]);
});

it('combines personal recipe states and starts creation from the same account-scoped library', async () => {
  const normal=cloud;
  cloud=async request=>request.type==='recipeGroups'?{items:request.scope==='published'?[{recipeId:accountB,versionId:challengeId,revision:1,owned:true,public:{...draft.public,name:'已发布测试配方'}}]:[{recipeId:A,versionId:B,revision:1,public:{...draft.public,name:'已获取测试配方'}}],nextCursor:null}:normal(request);
  await draw(); await click('社区');
  expect([...document.querySelectorAll('[aria-label="配方导航"] button')].map(button=>button.textContent)).toEqual(['Bot 配方','我的配方','Bot 租赁 敬请期待']);
  await click('我的配方');
  expect([...document.querySelectorAll('[aria-label="我的配方内容"] button')].map(button=>button.textContent)).toEqual(['已获取','创作中','已发布']);
  const visible=()=>[...document.querySelectorAll('.community-workspace-section:not([hidden])')].map(section=>section.textContent).join('');
  expect(visible()).toContain('已获取测试配方');expect(visible()).not.toContain('同一份私人草稿');expect(visible()).not.toContain('已发布测试配方');
  await click('已发布');expect(visible()).toContain('已发布测试配方');expect(visible()).not.toContain('已获取测试配方');expect(visible()).not.toContain('同一份私人草稿');
  expect(document.querySelector('.community-studio-heading h2')?.textContent).toBe('我的配方');
  await click('创作配方');
  expect([...document.querySelectorAll('select')].map(select=>select.selectedOptions[0]?.textContent)).toEqual(['Bot A','群聊 A']);
  expect(calls).toEqual([]);expect(externalCalls).toEqual([]);
  await click('取消');
  status=signedIn(accountB);await act(async()=>emit({type:'account',value:status}));
  expect(document.querySelector('.community-studio-heading')).toBeNull();
  expect(document.querySelector('[aria-label="配方导航"] [aria-current="page"]')?.textContent).toBe('Bot 配方');
});

it('guides anonymous users into the same personal library without reading any private recipes',async()=>{
  status={kind:'signedOut'};await draw();await click('社区');await click('我的配方');
  expect(document.body.textContent).toContain('登录后继续');
  expect([...document.querySelectorAll('button')].some(button=>button.textContent==='登录')).toBe(true);
  expect(cloudCalls.some(request=>['recipeGroups','drafts','publications'].includes(request.type))).toBe(false);
  expect(document.body.textContent).not.toContain('成为创作者');
});
it('shows one clear empty personal-library state and permits creation without a creator role',async()=>{
  const normal=cloud;cloud=async request=>request.type==='drafts'?{items:[]}:request.type==='recipeGroups'?{items:[],nextCursor:null}:normal(request);
  await draw();await click('社区');await click('我的配方');
  expect(document.querySelector('.community-workspace-section')?.textContent).toContain('还没有获取配方');
  const createButton=[...document.querySelectorAll('button')].find(button=>button.textContent==='创作配方');
  expect(createButton?.closest('.glow-button')?.getAttribute('data-variant')).toBe('dark');
  await click('创作配方');expect(document.querySelector('[aria-label="配方来源 Bot"]')).not.toBeNull();expect(calls).toEqual([]);
});
it('does not let late library reads from the previous account populate the new account library',async()=>{
  const normal=cloud;let finish!:(value:unknown)=>void;
  cloud=async request=>request.type==='recipeGroups'&&request.accountId===accountA?new Promise(resolve=>{finish=resolve;}):normal(request);
  await draw();await click('社区');await click('我的配方');expect(finish).toBeTypeOf('function');
  status=signedIn(accountB);await act(async()=>emit({type:'account',value:status}));await click('我的配方');
  await act(async()=>finish({items:[{recipeId:A,versionId:B,revision:1,public:{...draft.public,name:'旧账号私有哨兵'}}],nextCursor:null}));
  expect(document.body.textContent).not.toContain('旧账号私有哨兵');
  expect(cloudCalls.filter(request=>request.type==='recipeGroups').map(request=>request.accountId)).toEqual([accountA,accountB]);
});

it('loads granted version metadata on demand with retry and pagination, then opens and shares only the chosen version',async()=>{
  const normal=cloud;let failed=false;
  const item=(versionId:string,revision:number)=>({recipeId:accountB,versionId,revision,public:{...draft.public,version:String(revision)},versionCount:3});
  cloud=async request=>{
    if(request.type==='recipeGroups')return {items:[item(operationId,3)],nextCursor:null};
    if(request.type==='recipeGroupVersions'){
      if(!failed){failed=true;throw Error('临时版本读取失败');}
      return {items:request.cursor?[item(challengeId,1)]:[item(draftId,2)],nextCursor:request.cursor?null:pageCursor};
    }
    return normal(request);
  };
  await draw();await click('社区');await click('我的配方');
  expect(cloudCalls.some(request=>request.type==='recipeGroupVersions'||request.type==='latestVersion')).toBe(false);
  expect(document.querySelector('.community-card-footer')?.textContent).toContain('3');
  await click('选择版本 · 3 个');expect(document.querySelector('[role="alert"]')?.textContent).toContain('临时版本读取失败');
  await click('重试读取版本');await click('加载更多版本');
  const select=document.querySelector<HTMLSelectElement>('.community-library-versions select')!;
  expect([...select.options].map(option=>option.value)).toEqual([operationId,draftId,challengeId]);
  await act(async()=>{select.value=draftId;select.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());
  expect(cloudCalls.filter(request=>request.type==='browse')).toEqual([{type:'browse',accountId:accountA,recipeId:accountB,versionId:draftId}]);
  expect(cloudCalls.filter(request=>request.type==='shareLink')).toEqual([{type:'shareLink',recipeId:accountB,versionId:draftId}]);
  await click('返回我的配方');expect(document.querySelector('.community-card-footer')?.textContent).toContain('2');
  expect(cloudCalls.some(request=>request.type==='acquire'||request.type==='latestVersion')).toBe(false);
});
it('keeps equal names as different recipe groups and deduplicates paginated groups by recipe ID',async()=>{
  const normal=cloud;const item=(recipeId:string,versionId:string)=>({recipeId,versionId,revision:1,public:{...draft.public,name:'同名配方'}});
  cloud=async request=>request.type==='recipeGroups'?{items:request.cursor?[item(A,B),item(accountB,challengeId)]:[item(A,B)],nextCursor:request.cursor?null:pageCursor}:normal(request);
  await draw();await click('社区');await click('我的配方');await click('加载更多');
  expect(document.querySelectorAll('.community-card')).toHaveLength(2);
  expect([...document.querySelectorAll('.community-card h2')].map(node=>node.textContent)).toEqual(['同名配方','同名配方']);
});
it('discards a late version list from the old scope instead of offering it in the new permission scope',async()=>{
  const normal=cloud;let finish!:(value:unknown)=>void;
  const item=(versionId:string,version:string)=>({recipeId:accountB,versionId,revision:1,public:{...draft.public,version},versionCount:2});
  cloud=async request=>request.type==='recipeGroups'?{items:[item(operationId,'当前授权')],nextCursor:null}:request.type==='recipeGroupVersions'?request.scope==='acquired'?new Promise(resolve=>{finish=resolve;}):{items:[item(draftId,'新范围允许版本')],nextCursor:null}:normal(request);
  await draw();await click('社区');await click('我的配方');await click('选择版本 · 2 个');
  await click('已发布');await click('选择版本 · 2 个');
  await act(async()=>finish({items:[item(challengeId,'旧范围迟到版本')],nextCursor:null}));
  expect(document.querySelector('.community-library-versions')?.textContent).toContain('新范围允许版本');
  expect(document.querySelector('.community-library-versions')?.textContent).not.toContain('旧范围迟到版本');
});
it('drops pending version metadata and selected versions when the account changes',async()=>{
  const normal=cloud;let finish!:(value:unknown)=>void;
  const item={recipeId:accountB,versionId:operationId,revision:2,public:draft.public,versionCount:2};
  cloud=async request=>request.type==='recipeGroups'?{items:[item],nextCursor:null}:request.type==='recipeGroupVersions'?new Promise(resolve=>{finish=resolve;}):normal(request);
  await draw();await click('社区');await click('我的配方');await click('选择版本 · 2 个');
  status=signedIn(accountB);await act(async()=>emit({type:'account',value:status}));
  await act(async()=>finish({items:[{...item,versionId:draftId,public:{...draft.public,name:'旧账号版本哨兵'}}],nextCursor:null}));
  expect(document.body.textContent).not.toContain('旧账号版本哨兵');expect(document.querySelector('.community-library-versions')).toBeNull();
});

it.each([false,true])('opens the exact handoff in the public view and waits for confirmation (owned=%s)',async owned=>{
  const normal=cloud;cloud=async request=>request.type==='browse'?browseFixture(request.recipeId,request.versionId,{owned,acquired:!owned}):normal(request);
  await draw();await act(async()=>emit({type:'recipePreview',value:{kind:'handoff',recipeId:accountB,versionId:draftId,navigationId:challengeId}}));
  expect(dialog('交给 Bot')).toBeDefined();expect(calls).toEqual([]);expect(acknowledgedNavigations).toContain(challengeId);
  expect(cloudCalls.filter(request=>request.type==='browse')).toEqual([{type:'browse',accountId:accountA,recipeId:accountB,versionId:draftId}]);
  await click('关闭');await draw();expect(dialog('交给 Bot')).toBeUndefined();expect(calls).toEqual([]);
  expect(document.body.textContent).toContain(owned ? '我的作品' : '已获取此版本');
  expect(document.body.textContent).toContain('去我的配方查看');
  expect(document.body.textContent).not.toMatch(/创作新版本|下架此版本|删除此版本/);
  await click('交给 Bot');await click('前往私聊');expect(calls.filter(request=>request.type==='resourceHandoff')).toMatchObject([{target:{recipeId:accountB,versionId:draftId}}]);
});
it('retains an anonymous handoff through explicit login cancellation and retry, then offers only the same entitled version',async()=>{
  status={kind:'signedOut'};const normal=cloud;
  cloud=async request=>request.type==='browse'?browseFixture(request.recipeId,request.versionId,{acquired:Boolean(request.accountId)}):normal(request);
  await draw();await act(async()=>emit({type:'recipePreview',value:{kind:'handoff',recipeId:accountB,versionId:draftId,navigationId:challengeId}}));
  expect(dialog('交给 Bot')).toBeUndefined();expect(acknowledgedNavigations).not.toContain(challengeId);
  await click('登录并继续');expect(nativeLoginCalls).toBe(1);await click('取消登录');expect(document.body.textContent).toContain('已取消登录');
  await click('登录并继续');status=signedIn();await act(async()=>emit({type:'account',value:status}));
  expect(dialog('交给 Bot')).toBeDefined();expect(calls).toEqual([]);expect(acknowledgedNavigations).toContain(challengeId);
  expect(cloudCalls.filter(request=>request.type==='browse').every(request=>request.recipeId===accountB&&request.versionId===draftId)).toBe(true);
  expect(cloudCalls.some(request=>request.type==='acquire')).toBe(false);
});
it('requires explicit acquisition of an unentitled coded handoff before offering the Bot chooser',async()=>{
  let acquired=false;const normal=cloud;
  cloud=async request=>request.type==='browse'?browseFixture(request.recipeId,request.versionId,{public:{...draft.public,access:'coded'},acquired,preview:acquired?{settings:[],skills:[],ruleCount:0,taskCount:0}:undefined}):request.type==='acquire'?(acquired=true,{recipeId:accountB,versionId:draftId,owned:false,acquired:true}):normal(request);
  await draw();await act(async()=>emit({type:'recipePreview',value:{kind:'handoff',recipeId:accountB,versionId:draftId,navigationId:challengeId}}));
  expect(dialog('交给 Bot')).toBeUndefined();expect(calls).toEqual([]);expect(cloudCalls.some(request=>request.type==='acquire')).toBe(false);
  await click('获取配方');await fill('分享码','EXACT-CODE');
  await act(async()=>document.getElementById('community-acquire-code')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(cloudCalls.filter(request=>request.type==='acquire')).toMatchObject([{accountId:accountA,versionId:draftId,code:'EXACT-CODE'}]);
  expect(dialog('交给 Bot')).toBeDefined();expect(calls).toEqual([]);
});
it('ignores a late entitlement read from an older handoff navigation',async()=>{
  const normal=cloud;let finish!:(value:unknown)=>void;
  cloud=async request=>request.type==='browse'&&request.versionId===draftId?new Promise(resolve=>{finish=resolve;}):request.type==='browse'?browseFixture(request.recipeId,request.versionId,{public:{...draft.public,version:'新版目标'},acquired:true}):normal(request);
  await draw();await act(async()=>emit({type:'recipePreview',value:{kind:'handoff',recipeId:accountB,versionId:draftId,navigationId:challengeId}}));
  await act(async()=>emit({type:'recipePreview',value:{kind:'handoff',recipeId:accountB,versionId:B,navigationId:accountA}}));
  await act(async()=>finish(browseFixture(accountB,draftId,{public:{...draft.public,version:'旧版迟到'},acquired:true})));
  expect(dialog('交给 Bot')?.textContent).toContain('新版目标');expect(dialog('交给 Bot')?.textContent).not.toContain('旧版迟到');expect(calls).toEqual([]);
});
it('opens the drafts navigation in the local personal-library filter without starting creation or sending a message',async()=>{
  await draw();await act(async()=>emit({type:'recipePreview',value:{kind:'drafts',navigationId:challengeId}}));
  expect(document.querySelector('[aria-label="我的配方内容"] [aria-current="page"]')?.textContent).toBe('创作中');
  expect(document.body.textContent).toContain(draft.public.name);expect(acknowledgedNavigations).toContain(challengeId);expect(calls).toEqual([]);
});

it('requires a new exact entitlement read for a fresh handoff even when the same version was previously entitled',async()=>{
  const normal=cloud;let count=0,finish!:(value:unknown)=>void;
  cloud=async request=>request.type==='browse'?++count===1?browseFixture(request.recipeId,request.versionId,{acquired:true}):new Promise(resolve=>{finish=resolve;}):normal(request);
  await draw();await act(async()=>emit({type:'recipePreview',value:{kind:'handoff',recipeId:accountB,versionId:draftId,navigationId:challengeId}}));
  expect(dialog('交给 Bot')).toBeDefined();await click('关闭');
  await act(async()=>emit({type:'recipePreview',value:{kind:'handoff',recipeId:accountB,versionId:draftId,navigationId:accountA}}));
  expect(dialog('交给 Bot')).toBeUndefined();
  await act(async()=>finish(browseFixture(accountB,draftId,{acquired:false})));
  expect(dialog('交给 Bot')).toBeUndefined();expect(calls).toEqual([]);expect(cloudCalls.some(request=>request.type==='acquire')).toBe(false);
});

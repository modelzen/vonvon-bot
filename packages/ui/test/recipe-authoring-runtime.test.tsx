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
  await click('社区'); await click('我的配方'); await click('分享配方');
  const selects = document.querySelectorAll('select');
  expect(Array.from(selects).map(select => select.selectedOptions[0]?.textContent)).toEqual(['Bot A', '群聊 A']);
  await click('在飞书继续');
}
async function openDraft() {
  await draw(); await click('社区'); await click('我的配方'); await click('查看配方');
}
async function defaultAuthoring(request: DesktopAuthoringRequest): Promise<DesktopAuthoringReply> {
  if (request.type === 'creatorContinue') return {kind: 'creatorContinuing', accountId: request.accountId, viewId: request.source?.viewId ?? (request.entry.kind === 'source' ? request.entry.viewId : A), botId: request.source?.botId ?? (request.entry.kind === 'source' ? request.entry.botId : botA)};
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
  localStorage.clear();deviceSnapshot=snapshot;currentHandoff=undefined;status=signedIn();sourceRecord=null;calls=[];cloudCalls=[];sessions=new Map();nextHandle=0;linked=false;recipient=false;operations=[];
  draft={draftId,recipeId:null,revision:1,public:{name:'同一份私人草稿',summary:'本人填写的公开简介',overview:'',version:'1',access:'direct'},config:{role:'只整理公开资料'}};
  authoring=defaultAuthoring;
  cloud=async request=>{
    if(request.type==='catalog')return {hero:null,items:[],nextCursor:null};
    if(request.type==='drafts')return {items:[draft]};
    if(request.type==='publications')return {items:[]};
    if(request.type==='draft')return draft;
    if(request.type==='recoverRichDraftMetadata'&&draft.format==='rich-v2')return {status:'current',draft};
    if(request.type==='detail') return {recipeId:request.recipeId,versionId:request.versionId,revision:7,public:draft.public,config:{role:'已发布内容'},owned:true,acquired:false};
    if(request.type==='shareLink') return {url:'https://community.example/recipe'};
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


it('keeps My Recipes readonly and starts known draft continuation directly without choosing another source', async () => {
  localStorage.setItem('recipe-private-handoff:old', 'keep-existing-user-data');
  await openDraft();
  expect(document.querySelector('h1')?.textContent).toBe(draft.public.name);
  expect(document.querySelectorAll('.community-detail-layout nav button')).toHaveLength(5);
  expect(document.querySelector('input, textarea')).toBeNull();
  expect(text()).not.toMatch(/预览发布|编辑发布信息|发布到社区|编辑草稿/);
  await click('在飞书继续创作');
  expect(calls).toEqual([{type: 'creatorContinue', accountId: accountA, entry: {kind: 'draft', draftId, revision: 1}}]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('可以回到 Bot 私聊继续创作');
  expect(document.body.textContent).not.toContain('已发送');
  expect(localStorage.getItem('recipe-private-handoff:old')).toBe('keep-existing-user-data');
  expect(cloudCalls.map(request => request.type)).toEqual(['catalog', 'drafts', 'publications', 'draft']);
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
  expect(calls.filter(request => request.type === 'creatorContinue')).toEqual([{type: 'creatorContinue', accountId: accountA, entry: {kind: 'source', viewId: A, botId: botA, groupId: groupA}}]);
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
  await openDraft(); await click('在飞书继续创作');
  expect(calls).toHaveLength(1);
  expect(document.querySelectorAll('.authoring-source-list button')).toHaveLength(2);
  expect(document.querySelector('.authoring-source-list')?.textContent).toContain('家里');
  expect(document.querySelector('.authoring-source-list')?.textContent).not.toContain(B);
  await act(async () => document.querySelector<HTMLButtonElement>('.authoring-source-list button')!.click());
  expect(calls.find(request => request.type === 'open')).toMatchObject({viewId: B, botId: 'cli_author_b'});
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
  await openDraft(); await click('在飞书继续创作');
  status = signedIn(accountB); await draw();
  await act(async () => finish({kind: 'creatorContinuing', accountId: accountA, viewId: A, botId: botA}));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(text()).not.toContain(draft.public.name);
});

it('routes only the current account and draft publication to the exact owned immutable version', async () => {
  await openDraft();
  const receipt = {accountId: accountA, draftId, recipeId: A, versionId: B, revision: 77};
  for (const value of [{...receipt, accountId: accountB}, {...receipt, draftId: A}]) await act(async () => emit({type: 'authoringPublished', value}));
  expect(document.querySelector('.recipe-draft-page')).not.toBeNull();
  expect(cloudCalls.filter(request => request.type === 'detail')).toEqual([]);
  await act(async () => emit({type: 'authoringPublished', value: receipt}));
  expect(cloudCalls.filter(request => request.type === 'detail')).toEqual([{type: 'detail', accountId: accountA, recipeId: A, versionId: B}]);
  expect(document.querySelector('.recipe-draft-page')).toBeNull();
  expect(document.querySelector('h1')?.textContent).toBe(draft.public.name);
  await click('创作新版本');
  expect(calls).toEqual([{type: 'creatorContinue', accountId: accountA, entry: {kind: 'version', recipeId: A, versionId: B}}]);
});

it('does not let a mismatched creator receipt claim that another account or source is ready', async () => {
  authoring = async () => ({kind: 'creatorContinuing', accountId: accountB, viewId: B, botId: 'cli_author_b'});
  await openDraft(); await click('在飞书继续创作');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('来源已变化');
  expect(document.body.textContent).not.toContain('可以回到 Bot 私聊');
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

it('opens group Share with its exact Bot and group and preserves another author original share link', async () => {
  linked = true;
  sourceRecord = {recipeId: A, versionId: B, revision: 1, authorId: accountB, installedAt: 1, sourceToken: evidence};
  const normal = cloud;
  cloud = async request => {
    if (request.type === 'detail') return {recipeId: A, versionId: B, revision: 1, public: {...draft.public, name: '原作者作品', access: 'coded'}, owned: false, acquired: true, config: draft.config};
    if (request.type === 'shareLink') return {url: 'https://community.example/recipes/' + A + '/versions/' + B};
    return normal(request);
  };
  await draw(); await click('群组');
  await act(async () => document.querySelector<HTMLButtonElement>('.group-directory-identity')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="设置 群聊 A 中的 Bot A"]')!.click());
  await click('分享');
  expect(text()).toContain('这是其他作者的作品');
  await click('从本群准备配方');
  expect(document.querySelector('[role="dialog"] select')).toBeNull();
  expect(calls.filter(request => request.type === 'creatorContinue')).toEqual([{type: 'creatorContinue', accountId: accountA, entry: {kind: 'source', viewId: A, botId: botA, groupId: groupA}}]);
  await click('完成');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await click('分享链接');
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://community.example/recipes/' + A + '/versions/' + B);
});

it('closes a continuation for an older draft revision when chat saves newer content', async () => {
  await openDraft(); await click('在飞书继续创作');
  draft = {...draft, revision: 2, public: {...draft.public, name: '新内容'}};
  await act(async () => emit({type: 'authoringSaved', value: {accountId: accountA, draftId, revision: 2}}));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(document.querySelector('h1')?.textContent).toBe('新内容');
  await click('在飞书继续创作');
  expect(calls.filter(request => request.type === 'creatorContinue').at(-1)).toMatchObject({entry: {kind: 'draft', draftId, revision: 2}});
});

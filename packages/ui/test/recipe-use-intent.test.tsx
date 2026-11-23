// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {
  agentIdSchema, groupIdSchema, desktopSnapshotSchema,
  commandSchema, type Command, type AccountStatus, type RecipeUseRequest, type RecipeUseReply, type ProjectSettingsView,
} from '@vonvon/protocol';
import {createDesktopFacades, type FacadeTransport} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRoot} from '../src/devices/DesktopRoot';
import {projectState} from '../../daemon/src/server/projection';
import type {AdminState} from '../../daemon/src/server/state';
import {useCommunity} from '../src/community/community-context';
import {RecipeSourcePanel} from '../src/recipes/RecipeSourcePanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {A, B, devicesState} from './devices-fixture';
import {recipeBridge} from './helpers/recipe-bridge';
import {recipeConnections} from './helpers/recipe-connections';

const accountId = '44444444-4444-4444-8444-444444444444';
const otherAccount = '99999999-9999-4999-8999-999999999999';
const recipeId = '55555555-5555-4555-8555-555555555555';
const versionId = '66666666-6666-4666-8666-666666666666';
const nextVersion = '77777777-7777-4777-8777-777777777777';
const handle = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const botId = agentIdSchema.parse('cli_recipe_ui');
const groupId = groupIdSchema.parse('oc_recipe_ui');
const token = 'a'.repeat(64);
const secondHandle = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const name = '多语言配方🦉和很长的名字'.repeat(5);
const setup = {steps: [{kind: 'config' as const, title: '准备账号', instructions: '阅读并手动准备，不自动执行。', required: true}]};
const detail = {recipeId, versionId, revision: 1, public: {name, summary: '帮助 Bot 协作', overview: '说明', version: '1.0', access: 'direct' as const}, config: {role: '新职责', setup}, owned: false, acquired: true};
const baseReview = {reviewToken: token, currentRole: '当前职责', baseRole: '上次职责', incomingRole: '新职责', currentSetup: setup, baseSetup: setup, incomingSetup: setup, roleChoiceRequired: false, setupChoiceRequired: false};
const snapshot = desktopSnapshotSchema.parse({revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [{id: botId, name: '原目标🦉机器人', enabled: true, running: true, connection: 'connected', activation: 'active'}], groups: [{id: groupId, name: '已连接的群'}], memberships: [],
  tools: [{tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'}], jobs: [], application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/synthetic'}});


function projectedSnapshot(directory = '/synthetic') {
  const bindings = [{id: botId, name: '本地绑定甲'}, {id: 'cli_second', name: '另一 Bot 的本地绑定乙'}];
  const bots: AdminState['bots'] = bindings.map(({id, name}) => ({
    appId: id, name: id, running: true, active: true, current: id === botId, tenant: 'feishu', connection: 'connected',
    completionReminder: {mode: 'failures', longTaskMinutes: 3},
    projects: [{chatId: groupId, name, cwd: directory, kind: 'single', backend: 'codex-appserver', mode: 'write', network: false,
      guestMode: 'qa', blank: false, origin: 'joined', noMention: false, allowedUsersCount: 0, sessionCount: 0, createdAt: 1}],
  }));
  return desktopSnapshotSchema.parse({...snapshot, ...projectState({version: 'test', generatedAt: 1, bots}, snapshot, new Set())});
}


let root: Root, facade: ReturnType<typeof createDesktopFacades>;
let services: FacadeTransport['invoke'];
let dispatch: (event: unknown) => void;
let requests: RecipeUseRequest[], status: AccountStatus;
let useReply: (r: RecipeUseRequest) => RecipeUseReply | Promise<RecipeUseReply>;
let entitled: boolean;
let readSnapshot: () => Promise<unknown>;
let acquireReply: () => Promise<void>;
let readIdentity: (request: Extract<Command, {type: 'readGroupIdentity'}>) => unknown | Promise<unknown>;
let directoryChoices: string[];
let identityRequests: Array<Extract<Command, {type: 'readGroupIdentity'}>>;
const groupTwo=groupIdSchema.parse('oc_second');
function Launcher() {
  const community=useCommunity()!;
  return <><button onClick={() => community.open({kind:'detail',recipe:detail})}>打开配方</button>
    {[groupId,groupTwo].map(id => <div data-scope={id} key={id}><RecipeSourcePanel view={{scope:{botId},identity:{chatId:id}} as ProjectSettingsView}/></div>)}</>;
}
async function draw() {
  await act(async()=>{root.render(<DesktopRoot fallback={facade.client} shell={facade.shell} renderApp={()=><DraftGuardProvider><Launcher/></DraftGuardProvider>}/>);});
}
async function device(id:string,phase:'ready'|'failed'='ready') {await act(async()=>dispatch({type:'devices',value:devicesState({id,phase})}));}
async function account(id:string) {await act(async()=>{status={...status,accountId:id}; dispatch({type:'account',value:status});});}
const button=(text:string, scope:ParentNode=document)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].find(el=>(el.getAttribute('aria-label')??el.textContent)===text);
async function click(text:string,scope:ParentNode=document) {const b=button(text,scope);expect(b,text).toBeDefined();await act(async()=>b!.click());}
async function inGroup(id:string,label:string) {await click(label,document.querySelector('[data-scope="'+id+'"]')!);}
const asRead={recipeId, versionId, revision:1,authorId:accountId,installedAt:1,sourceToken:token};
const prepared={kind:'prepared' as const,handle,groupId,review:baseReview};
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true); HTMLElement.prototype.scrollIntoView = function(){};
  vi.stubGlobal('ResizeObserver',class{observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('IntersectionObserver',class{observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
  document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
  requests=[];entitled=true;
  status={kind:'signedIn',accountId,displayName:'Synthetic',provider:'github',persistence:'memory'};
  useReply=r=>r.type==='begin' && !r.groupId ? {kind:'choose',handle}
    : r.type==='begin' ? {...prepared,groupId:r.groupId!,handle:r.groupId===groupTwo?secondHandle:handle}
    : r.type==='confirm' ? {kind:'applied',groupId:r.handle===secondHandle?groupTwo:groupId,handle:r.handle} : prepared;
  readSnapshot=async()=>({...snapshot,groups:[{id:groupId,name:'甲组'},{id:groupTwo,name:'乙组'}]});
  acquireReply=async()=>{}; identityRequests=[]; directoryChoices=[];
  readIdentity=request=>({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: request.groupId === groupTwo ? '乙组' : '甲组'});
  services=async(channel,raw)=>{
    let v:unknown;
    if(channel===desktopChannels.subscribe) v=undefined;
    else if(channel===desktopChannels.accountStatus) v=status;
    else if(channel===desktopChannels.snapshot) v=await readSnapshot();
    else if(channel===desktopChannels.run) {const request=commandSchema.parse(raw); if(request.type==='readGroupIdentity'){identityRequests.push(request);v=await readIdentity(request);} else if(request.type==='listJoinedGroups') v={kind:'groups',groups:[{id:groupTwo,name:'现有群',bound:false}]}; else v={kind:'pendingGroups',groups:[]};}
    else if(channel===desktopChannels.directory) {
      if (raw.type==='choose') {directoryChoices.push(raw.path); v={kind:'folderChosen',folder:{token:directoryChoices.length===1 ? handle : secondHandle,displayPath:raw.path}};}
      else v={kind:'suggestions',root:'/synthetic',path:null,parent:null,entries:[{name:'工作目录',path:'/synthetic/work',hidden:false}],truncated:false};
    }
    else if(channel===desktopChannels.environment) v={kind:'backends',entries:[]};
    else if(channel===desktopChannels.settings) v={kind:'refused',message:'not configured'};
    else if(channel===desktopChannels.recipeUse){requests.push(raw); v=await useReply(raw);}
    else if(channel===desktopChannels.recipeSource){v=raw.type==='read'?{source:asRead}:{source:asRead,latest:{recipeId,versionId:nextVersion, revision:2,version:'2.0',entitled}};}
    else if(channel===desktopChannels.community){if(raw.type==='acquire') await acquireReply(); v=raw.type==='detail'?{...detail,versionId:raw.versionId,acquired:entitled}:raw.type==='shareLink'?{url:'https://example.invalid/share'}:raw.type==='catalog'?{hero:{recipeId,versionId:nextVersion,revision:2,public:detail.public},items:[],nextCursor:null}:raw.type==='acquire'?(entitled=true,{recipeId,versionId:raw.versionId,owned:false,acquired:true}):{items:[]};}
    else return {ok:false,error:{kind:'rpc',message:'synthetic channel unavailable'}};
    return {ok:true,value:v};
  };
  facade=createDesktopFacades({receive:listener=>{dispatch=listener;return ()=>{};},invoke:services});
  dispatch({type:'account',value:status});dispatch({type:'devices',value:devicesState({id:A,phase:'ready'})});
});
afterEach(async()=>{await act(async()=>root.unmount());vi.unstubAllGlobals();});
it('offers the exact current target without silently confirming a suspended group',async()=>{
  await draw();
  await inGroup(groupId,'检查新版');await inGroup(groupId,'预览更新');
  expect(requests.at(-1)).toMatchObject({type:'begin',groupId});
  await click('稍后继续');
  await inGroup(groupTwo,'检查新版');await inGroup(groupTwo,'预览更新');
  expect(button('确认应用到这个群')).toBeUndefined();
  expect(document.body.textContent).toContain('甲组'); expect(document.body.textContent).toContain('乙组');
  expect(document.body.textContent).toContain('旧操作会保留');
  await click('开始当前目标');
  expect(requests.filter(r=>r.type==='begin')).toEqual([expect.objectContaining({groupId}),expect.objectContaining({groupId:groupTwo})]);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('乙组');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('原目标🦉机器人');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('机房');
  await click('确认应用到这个群');
  expect(requests.at(-1)).toEqual({type:'confirm',handle:secondHandle});
  expect(requests.some(r=>r.type==='cancel')).toBe(false);
});
it('returns to bot selection using a fresh snapshot after an interruption before bot selection',async()=>{
  await draw();await click('打开配方');await click('添加到群聊');
  expect(document.querySelector('input[name="join-bot"]')).not.toBeNull();
  await device(A,'failed');
  let nextSnapshot!:(value:unknown)=>void; readSnapshot=()=>new Promise(resolve=>nextSnapshot=resolve);
  await device(A);
  expect(button('恢复原操作')).toBeUndefined();expect(document.querySelector('input[name="join-bot"]')).toBeNull();
  await act(async()=>nextSnapshot({...snapshot,agents:[{...snapshot.agents[0]!,name:'恢复后的机器人'}]}));
  expect(document.querySelector('input[name="join-bot"]')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('恢复后的机器人');expect(requests).toHaveLength(0);
});
it.each(['device', 'account'] as const)('requires a new begin after a pending response crosses a %s round trip',async kind=>{
  let done!:(reply:RecipeUseReply)=>void;
  useReply = r=>r.type==='begin'?new Promise(resolve=>done=resolve):{kind:'applied',handle,groupId};
  await draw();await inGroup(groupId,'检查新版'); await inGroup(groupId,'预览更新');
  if (kind === 'device') {await device(B); await device(A);}
  else {await account(otherAccount); await account(accountId);}
  expect(button('恢复原操作')).toBeDefined();
  await act(async()=>done(prepared));
  expect(button('恢复原操作')).toBeDefined();expect(button('确认应用到这个群')).toBeUndefined();
  useReply=()=>prepared; await click('恢复原操作');
  expect(requests.map(r=>r.type)).toEqual(['begin','begin']);
  expect(button('确认应用到这个群')).toBeDefined();
});
it('lets another account start independently while preserving the original private operation',async()=>{
  await draw();await inGroup(groupId,'检查新版');await inGroup(groupId,'预览更新');await click('稍后继续');
  await account(otherAccount);await inGroup(groupTwo,'检查新版');await inGroup(groupTwo,'预览更新');
  expect(requests.map(r=>r.type)).toEqual(['begin','begin']);expect(requests[1]).toMatchObject({accountId:otherAccount,groupId:groupTwo});
  expect(document.body.textContent).not.toContain('请回到发起操作时的账号');
  expect(requests.some(r=>r.type==='cancel')).toBe(false);
  await click('稍后继续'); await account(accountId); await inGroup(groupId,'检查新版'); await inGroup(groupId,'预览更新');
  expect(button('确认应用到这个群')).toBeDefined(); expect(requests.map(r=>r.type)).toEqual(['begin','begin','begin']);
  expect(requests[2]).toMatchObject({accountId,groupId});
});
it('keeps global search behind the active recipe join dialog and restores focus and the background',async()=>{
  await draw();await click('打开配方');button('添加到群聊')!.focus();await click('添加到群聊');
  await act(async()=>document.querySelector<HTMLInputElement>('input[name="join-bot"]')!.click());await click('下一步');
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true})));
  expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  expect(document.querySelector('#root')!.hasAttribute('inert')).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
  await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  await act(async()=>{await new Promise(r=>setTimeout(r,650));}); expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
  expect(document.querySelector('#root')!.hasAttribute('inert')).toBe(false);
  expect(document.activeElement?.textContent).toBe('添加到群聊');
});

it('drops the abandoned group acquisition intent when leaving its detail navigation',async()=>{
  entitled=false;await draw();await inGroup(groupId,'检查新版');await inGroup(groupId,'获取新版');
  await click('返回 Bot 配方');
  const card=document.querySelector<HTMLButtonElement>('.community-card--hero');
  expect(card,document.body.textContent ?? '').not.toBeNull();await act(async()=>card!.click());
  await click('获取配方');
  expect(document.querySelector('input[name="join-bot"]')).not.toBeNull();
  expect(requests).toEqual([]);
});


it('continues the old target only after that choice is explicit', async () => {
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新'); await click('稍后继续');
  await inGroup(groupTwo, '检查新版'); await inGroup(groupTwo, '预览更新'); await click('继续旧目标');
  expect(requests.map(request => request.type)).toEqual(['begin']);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('甲组');
  await click('确认应用到这个群'); expect(requests.at(-1)).toEqual({type: 'confirm', handle});
});

it.each(['device', 'account'] as const)('drops acquisition targeting after a %s round trip', async kind => {
  entitled = false; await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '获取新版');
  if (kind === 'device') {await device(B); await device(A);}
  else {await account(otherAccount); await account(accountId);}
  await click('获取配方');
  expect(document.querySelector('input[name="join-bot"]')).not.toBeNull(); expect(requests).toEqual([]);
});

it('requires the current detail action after a targeted acquisition crosses a device switch', async () => {
  let complete!: () => void; acquireReply = () => new Promise(resolve => complete = resolve);
  entitled = false; await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '获取新版');
  await click('获取配方'); await device(B); await act(async () => complete());
  expect(requests).toEqual([]); expect(document.querySelector('input[name="join-bot"]')).toBeNull();
  acquireReply = async () => {}; await click('获取配方');
  expect(document.querySelector('input[name="join-bot"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLInputElement>('input[name="join-bot"]')!.click()); await click('下一步');
  expect(requests).toEqual([{type: 'begin', accountId, viewId: B, recipeId, versionId: nextVersion, botId}]);
});

it('does not enable confirmation until the exact platform identity is read, and can retry without losing the preview', async () => {
  readSnapshot = async () => ({...snapshot, groups: []});
  readIdentity = async () => {throw new Error('offline');};
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  expect(button('确认应用到这个群')!.disabled).toBe(true);
  expect(document.body.textContent).toContain('输入已保留');
  readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '已核对的目标群'});
  await click('刷新群名');
  expect(button('确认应用到这个群')!.disabled).toBe(false);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('已核对的目标群');
});


it('requires platform group identity instead of another bot local binding alias', async () => {
  const projected = projectedSnapshot();
  expect(projected.groups[0]?.name).toBe('另一 Bot 的本地绑定乙');
  readSnapshot = async () => projected;
  readIdentity = () => {throw new Error('unavailable');};
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).not.toContain('群聊：另一 Bot 的本地绑定乙');
  expect(dialog.textContent).toContain('本地名称：本地绑定甲');
  expect(button('确认应用到这个群')!.disabled).toBe(true);
});

it.each(['cancel', 'finish'] as const)('preserves the current target chooser after hidden old %s closes late', async action => {
  let done!: (reply: RecipeUseReply) => void;
  useReply = request => request.type === action ? new Promise(resolve => done = resolve)
    : action === 'finish' ? {kind: 'applied', handle, groupId}
    : {...prepared, kind: 'review', review: {...baseReview, roleChoiceRequired: true}};
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  await click(action === 'finish' ? '完成' : '取消应用'); await click('稍后继续');
  await inGroup(groupTwo, '检查新版'); await inGroup(groupTwo, '预览更新');
  const current = button('开始当前目标')!; current.focus();
  await act(async () => done({kind: 'closed'}));
  expect(button('开始当前目标')).toBe(current);
  expect(document.activeElement).toBe(current);
  expect(button('继续旧目标')!.disabled).toBe(true);
  expect(button('确认应用到这个群')).toBeUndefined();
  expect(requests.map(request => request.type)).toEqual(['begin', action]);
  useReply = request => ({...prepared, groupId: groupTwo, handle: secondHandle});
  await click('开始当前目标');
  expect(requests.at(-1)).toMatchObject({type: 'begin', groupId: groupTwo});
});


it('uses the chosen Bot and physical group through the strict facade despite colliding local aliases, and refreshes a rename without changing the install handle', async () => {
  readSnapshot = async () => projectedSnapshot();
  readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '飞书物理群名'});
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(`群聊：飞书物理群名（${groupId}）`);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('本地名称：本地绑定甲');
  expect(identityRequests).toEqual([{type: 'readGroupIdentity', agentId: botId, groupId}]);
  readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '飞书改名后'});
  await click('刷新群名'); await click('确认应用到这个群');
  expect(requests.at(-1)).toEqual({type: 'confirm', handle});
  expect(identityRequests.at(-1)).toEqual({type: 'readGroupIdentity', agentId: botId, groupId});
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain(`群聊：飞书改名后（${groupId}）`);
});

it.each(['wrongBot', 'wrongGroup', 'empty'] as const)('refuses %s identity evidence instead of enabling confirmation', async kind => {
  readIdentity = request => ({kind: 'groupIdentity', agentId: kind === 'wrongBot' ? 'cli_other' : request.agentId, groupId: kind === 'wrongGroup' ? groupTwo : request.groupId, name: kind === 'empty' ? ' ' : '不能展示的名称'});
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  expect(button('确认应用到这个群')!.disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('不能展示的名称');
});

it.each(['account', 'accountSession', 'device', 'binding', 'registration'] as const)('discards late group-name evidence after a %s change', async kind => {
  let done!: (value: unknown) => void;
  readIdentity = () => new Promise(resolve => done = resolve);
  if (kind === 'binding') readSnapshot = async () => projectedSnapshot();
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  const oldDone = done;
  if (kind === 'account') await account(otherAccount);
  else if (kind === 'accountSession') await account(accountId);
  else if (kind === 'device') await device(B);
  else await act(async () => dispatch({type: 'snapshot', view: A, value: kind === 'binding' ? {...projectedSnapshot('/changed'), revision: 2} : {...snapshot, revision: 2, agents: [{...snapshot.agents[0]!, registeredAt: 99}]}}));
  await act(async () => oldDone({kind: 'groupIdentity', agentId: botId, groupId, name: '迟到的私有群名'}));
  expect(document.body.textContent).not.toContain('迟到的私有群名');
  expect(requests.map(request => request.type)).toEqual(['begin']);
  if (kind === 'account' || kind === 'accountSession' || kind === 'device') {
    readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '恢复后群名'});
    if (kind === 'account' || kind === 'accountSession') await account(accountId); else await device(A);
    await click('恢复原操作');
    expect(requests.at(-1)).toMatchObject({type: 'begin', accountId, viewId: A, botId, groupId});
    expect(button('确认应用到这个群')!.disabled).toBe(false);
  } else expect(button('确认应用到这个群')!.disabled).toBe(true);
});

it('retains the custom role and same review while group-name refresh fails and recovers', async () => {
  useReply = () => ({...prepared, kind: 'review', review: {...baseReview, roleChoiceRequired: true}});
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  await act(async () => document.querySelector<HTMLInputElement>('input[name="recipe-role"][value="custom"]')!.click());
  const input = document.querySelector<HTMLTextAreaElement>('[aria-label="合并后的本群角色"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '保留的手动合并🦉');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  readIdentity = () => {throw new Error('offline');}; await click('刷新群名');
  expect(document.body.textContent).toContain('输入已保留');
  expect(input.value).toBe('保留的手动合并🦉');
  expect(button('预览所选内容')!.disabled).toBe(true);
  readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '恢复后的群名'});
  await click('刷新群名');
  expect(document.querySelector('[aria-label="合并后的本群角色"]')).toBe(input);
  expect(input.value).toBe('保留的手动合并🦉'); expect(button('预览所选内容')!.disabled).toBe(false);
  expect(requests.map(request => request.type)).toEqual(['begin']);
});

it('disambiguates equal platform group names with immutable physical IDs', async () => {
  readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '同名群'});
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新'); await click('稍后继续');
  await inGroup(groupTwo, '检查新版'); await inGroup(groupTwo, '预览更新');
  const chooser = document.querySelector('[role="dialog"]')!;
  expect(chooser.textContent).toContain(`同名群（${groupId}）`);
  expect(chooser.textContent).toContain(`同名群（${groupTwo}）`);
  await click('开始当前目标'); await click('确认应用到这个群');
  expect(requests.at(-1)).toEqual({type: 'confirm', handle: secondHandle});
});

it('does not let another account late closure dismiss the active account operation', async () => {
  let done!: (reply: RecipeUseReply) => void;
  useReply = request => request.type === 'cancel' ? new Promise(resolve => done = resolve) : {...prepared, groupId: request.type === 'begin' ? request.groupId! : groupId};
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新'); await click('取消应用'); await click('稍后继续');
  await account(otherAccount); await inGroup(groupTwo, '检查新版'); await inGroup(groupTwo, '预览更新');
  const dialog = document.querySelector('[role="dialog"]');
  await act(async () => done({kind: 'closed'}));
  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect(dialog!.textContent).toContain(`（${groupTwo}）`);
  expect(dialog!.textContent).not.toContain(`（${groupId}）`);
  expect(button('开始当前目标')).toBeUndefined();
});

it('hides cached and delayed chooser group names when the real remote connection fails', async () => {
  const connection = recipeConnections(); connection.add(A);
  const link = await connection.ready(A);
  const stop = connection.devices.onState(value => dispatch({type: 'devices', value}));
  dispatch({type: 'devices', value: connection.devices.state()});
  try {
    await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新'); await click('稍后继续');
    let done!: (value: unknown) => void;
    readIdentity = request => request.groupId === groupTwo ? new Promise(resolve => done = resolve)
      : {kind: 'groupIdentity', agentId: botId, groupId, name: '已核对的旧目标'};
    await inGroup(groupTwo, '检查新版'); await inGroup(groupTwo, '预览更新');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('群聊：已核对的旧目标');
    await act(async () => link.end('client_revoked'));
    expect(connection.devices.state().active.phase).toBe('failed');
    expect.soft(document.querySelector('[role="dialog"]')!.textContent).not.toContain('群聊：已核对的旧目标');
    await act(async () => done({kind: 'groupIdentity', agentId: botId, groupId: groupTwo, name: '断线后迟到的群名'}));
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('断线后迟到的群名');
    expect(requests.map(request => request.type)).toEqual(['begin']);
  } finally {stop(); await connection.devices.dispose();}
});

it.each(['connecting', 'offline'] as const)('pauses a prepared local operation across a real %s and reattached transition', async status => {
  const connection = recipeConnections();
  const stop = connection.devices.onState(value => dispatch({type: 'devices', value}));
  dispatch({type: 'devices', value: connection.devices.state()});
  try {
    await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
    expect(button('确认应用到这个群')!.disabled).toBe(false);
    readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '重连后重新读取'});
    await act(async () => connection.devices.setLocal({status}));
    expect(connection.devices.state().active.phase).toBe('ready');
    expect(connection.devices.state().devices[0]!.status).toBe(status);
    expect.soft(button('确认应用到这个群')?.disabled ?? true).toBe(true);
    await act(async () => {
      connection.devices.setLocal({status: 'online'});
      dispatch({type: 'reattached', view: 'local'});
      dispatch({type: 'snapshot', view: 'local', value: snapshot});
    });
    expect.soft(button('确认应用到这个群')?.disabled ?? true).toBe(true);
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('群聊：甲组');
    await click('恢复原操作');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('群聊：重连后重新读取');
    expect(identityRequests).toHaveLength(2);
    expect(requests.map(request => request.type)).toEqual(['begin', 'begin']);
    await click('确认应用到这个群');
    expect(requests.filter(request => request.type === 'confirm')).toEqual([{type: 'confirm', handle}]);
  } finally {stop(); await connection.devices.dispose();}
});

it.each(['account', 'same account', 'device', 'local reconnect'] as const)('rejects the previous lookup after a fresh identity across a real %s round trip', async kind => {
  const connection = recipeConnections();
  if (kind === 'device') {connection.add(A); connection.add(B); await connection.ready(A);}
  const view = connection.devices.state().active.id;
  const originalClient = facade.shell.devices.clientFor(view);
  const stop = connection.devices.onState(value => dispatch({type: 'devices', value}));
  dispatch({type: 'devices', value: connection.devices.state()});
  try {
    let done!: (value: unknown) => void;
    readIdentity = () => new Promise(resolve => done = resolve);
    await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
    const oldDone = done;
    readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '新连接已核对'});
    await act(async () => {
      if (kind === 'device') {
        await connection.ready(B); await connection.ready(A);
      } else if (kind === 'local reconnect') {
        connection.devices.setLocal({status: 'connecting'});
        connection.devices.setLocal({status: 'online'});
      } else {
        if (kind === 'account') {status = {...status, accountId: otherAccount}; dispatch({type: 'account', value: status});}
        status = {...status, accountId}; dispatch({type: 'account', value: status});
      }
      if (kind === 'device' || kind === 'local reconnect') {
        dispatch({type: 'reattached', view}); dispatch({type: 'snapshot', view, value: snapshot});
      }
    });
    expect(facade.shell.devices.clientFor(view)).toBe(originalClient);
    expect(button('确认应用到这个群')).toBeUndefined();
    await click('恢复原操作');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('群聊：新连接已核对');
    await act(async () => oldDone({kind: 'groupIdentity', agentId: botId, groupId, name: '过期连接迟到的群名'}));
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('过期连接迟到的群名');
    await act(async () => {
      connection.devices.setLocal({status: 'online'});
      for (const revision of [2, 3, 4]) dispatch({type: 'snapshot', view, value: {...snapshot, revision, observedAt: revision}});
    });
    expect(identityRequests).toHaveLength(2);
    expect(button('确认应用到这个群')!.disabled).toBe(false);
    expect(requests.map(request => request.type)).toEqual(['begin', 'begin']);
    await click('确认应用到这个群');
    expect(requests.filter(request => request.type === 'confirm')).toEqual([{type: 'confirm', handle}]);
  } finally {stop(); await connection.devices.dispose();}
});

it('requires a new identity and review when the same facade client receives reattachment with an identical snapshot', async () => {
  const connection = recipeConnections();
  const stop = connection.devices.onState(value => dispatch({type: 'devices', value}));
  dispatch({type: 'devices', value: connection.devices.state()});
  try {
    await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
    readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '重附加后核对'});
    await act(async () => {
      dispatch({type: 'reattached', view: 'local'});
      dispatch({type: 'snapshot', view: 'local', value: snapshot});
    });
    expect(button('确认应用到这个群')).toBeUndefined();
    await click('恢复原操作');
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('群聊：重附加后核对');
    expect(identityRequests).toHaveLength(2);
    expect(requests.map(request => request.type)).toEqual(['begin', 'begin']);
  } finally {stop(); await connection.devices.dispose();}
});

it('clears chooser evidence during a real remote disconnect and rereads on recovery', async () => {
  const connection = recipeConnections(); connection.add(A);
  const link = await connection.ready(A);
  const stop = connection.devices.onState(value => dispatch({type: 'devices', value}));
  dispatch({type: 'devices', value: connection.devices.state()});
  try {
    await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新'); await click('稍后继续');
    const pending: Array<(value: unknown) => void> = [];
    readIdentity = () => new Promise(resolve => pending.push(resolve));
    await inGroup(groupTwo, '检查新版'); await inGroup(groupTwo, '预览更新');
    await act(async () => link.end('closed'));
    expect(connection.devices.state().active.phase).toBe('reconnecting');
    expect(button('继续旧目标')!.disabled).toBe(true);
    expect(button('开始当前目标')!.disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('群聊：甲组');
    await act(async () => {
      for (const resolve of pending) resolve({kind: 'groupIdentity', agentId: botId, groupId: groupTwo, name: '连接断开后迟到'});
    });
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('连接断开后迟到');
    readIdentity = request => ({kind: 'groupIdentity', agentId: request.agentId, groupId: request.groupId, name: '恢复核对-' + request.groupId});
    await act(async () => {await connection.devices.switchTo('local'); await connection.ready(A);});
    expect(button('开始当前目标')!.disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('群聊：恢复核对-' + groupId);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('群聊：恢复核对-' + groupTwo);
    const reads = identityRequests.length;
    await act(async () => dispatch({type: 'snapshot', view: A, value: {...snapshot, revision: 2}}));
    expect(identityRequests).toHaveLength(reads);
    await click('开始当前目标'); await click('确认应用到这个群');
    expect(requests.map(request => request.type)).toEqual(['begin', 'begin', 'confirm']);
    expect(requests.at(-1)).toEqual({type: 'confirm', handle: secondHandle});
  } finally {stop(); await connection.devices.dispose();}
});


it('requires fresh evidence after a controlled restart whose first revision is higher, even though the device never went offline', async () => {
  const {devices} = recipeConnections();
  let newOwner = false;
  const h = recipeBridge(devices, status, snapshot, async command => {
    if (command.type !== 'readGroupIdentity') return {kind:'pendingGroups',groups:[]};
    identityRequests.push(command);
    return {kind:'groupIdentity',agentId:command.agentId,groupId:command.groupId,name:newOwner ? '重启后群名' : '重启前群名'};
  }, services);
  facade = createDesktopFacades(h.transport);
  useReply = request => request.type === 'confirm' ? {kind:'applied',groupId,handle:request.handle} : {...prepared,handle:newOwner ? secondHandle : handle};
  try {
    await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
    const original = facade.shell.devices.clientFor('local');
    expect(button('确认应用到这个群')!.disabled).toBe(false);
    newOwner = true;
    await act(async () => h.replace({...snapshot,revision:2}));
    expect(devices.state().devices[0]!.status).toBe('online');
    expect(facade.shell.devices.clientFor('local')).toBe(original);
    expect(button('确认应用到这个群')).toBeUndefined();
    expect(document.body.textContent).not.toContain('群聊：重启前群名');
    await click('恢复原操作');
    expect(document.body.textContent).toContain('群聊：重启后群名');
    await act(async () => {for (const revision of [3,4,5]) h.push({...snapshot,revision});});
    expect(identityRequests).toHaveLength(2);
    expect(requests.map(r => r.type)).toEqual(['begin','begin']);
    await click('确认应用到这个群');
    expect(requests.at(-1)).toEqual({type:'confirm',handle:secondHandle});
  } finally {await h.dispose(); await devices.dispose();}
});

async function fillBuffer(selector: string, text: string) {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text); el.dispatchEvent(new Event('input', {bubbles:true}));});
}

it.each(['role','create','bind'] as const)('keeps unsent %s text and choices for the original target through a local outage', async kind => {
  const {devices} = recipeConnections();
  const stop = devices.onState(value => dispatch({type:'devices',value}));
  dispatch({type:'devices',value:devices.state()});
  let recovered = false;
  useReply = () => kind === 'role'
    ? {...prepared,handle:recovered ? secondHandle : handle,kind:'review',review:{...baseReview,roleChoiceRequired:true,setupChoiceRequired:true}}
    : {kind:'choose',handle:recovered ? secondHandle : handle};
  try {
    await draw();
    if (kind === 'role') {
      await inGroup(groupId,'检查新版'); await inGroup(groupId,'预览更新');
      await act(async () => {document.querySelector<HTMLInputElement>('input[name="recipe-role"][value="custom"]')!.click(); document.querySelector<HTMLInputElement>('input[name="recipe-setup"]')!.click();});
    } else {
      await click('打开配方'); await click('添加到群聊');
      await act(async () => document.querySelector<HTMLInputElement>('input[name="join-bot"]')!.click()); await click('下一步');
      if (kind === 'bind') {
        await click('连接已有群聊'); await click('查找已经加入的群');
        await act(async () => document.querySelector<HTMLButtonElement>('.join-group-list button')!.click());
      }
      const mode = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(el => el.textContent?.startsWith('独立话题'))!;
      await act(async () => mode.click());
    }
    const selector = '[aria-label="' + ({role:'合并后的本群角色',create:'飞书群名称',bind:'本地绑定名称'}[kind]) + '"]';
    const value = '未提交的输入🦉' + kind;
    await fillBuffer(selector,value);
    recovered = true;
    await act(async () => {devices.setLocal({status:'connecting'});devices.setLocal({status:'online'});dispatch({type:'reattached',view:'local'});dispatch({type:'snapshot',view:'local',value:snapshot});});
    expect(document.querySelector(selector)).toBeNull();
    await click('恢复原操作');
    expect(document.querySelector<HTMLInputElement>(selector)?.value).toBe(value);
    expect(button({role:'预览所选内容',create:'创建并连接',bind:'连接并发送欢迎卡片'}[kind])!.disabled).toBe(false);
    expect(requests.map(r => r.type)).toEqual(['begin','begin']);
  } finally {stop();await devices.dispose();}
});

it('requires a fresh explicit directory choice after recovery without losing the create draft or silently choosing the default', async () => {
  const {devices} = recipeConnections();
  const stop = devices.onState(value => dispatch({type:'devices',value}));
  dispatch({type:'devices',value:devices.state()});
  let recovered = false;
  useReply = r => r.type === 'begin' ? {kind:'choose',handle:recovered ? secondHandle : handle} : prepared;
  async function chooseFolder() {
    await act(async () => {await vi.advanceTimersByTimeAsync(200);});
    await act(async () => document.querySelector<HTMLButtonElement>('.join-directory-select')!.click());
  }
  try {
    await draw(); await click('打开配方'); await click('添加到群聊');
    await act(async () => document.querySelector<HTMLInputElement>('input[name="join-bot"]')!.click()); await click('下一步');
    await fillBuffer('[aria-label="飞书群名称"]','保留的群名称');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(el => el.textContent?.startsWith('独立话题'))!.click());
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    await act(async () => document.querySelector<HTMLInputElement>('[aria-label="目录来源"] input[value="existing"]')!.click());
    await chooseFolder();
    expect(button('创建并连接')!.disabled).toBe(false);
    recovered = true;
    await act(async () => {devices.setLocal({status:'connecting'}); devices.setLocal({status:'online'});});
    await click('恢复原操作');
    expect(document.querySelector<HTMLInputElement>('[aria-label="飞书群名称"]')?.value).toBe('保留的群名称');
    expect(document.querySelector<HTMLInputElement>('[aria-label="目录来源"] input[value="existing"]')?.checked).toBe(true);
    expect(document.body.textContent).toContain('重新选择工作目录');
    expect(button('创建并连接')!.disabled).toBe(true);
    expect(directoryChoices).toEqual(['/synthetic/work']);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="选择工作目录"]')!.click());
    await chooseFolder(); await click('创建并连接');
    expect(requests.filter(r => r.type === 'join')).toEqual([{type:'join',handle:secondHandle,input:{
      action:'createProject',agentId:botId,name:'保留的群名称',folder:{kind:'existing',folderToken:secondHandle},tool:'codex',conversation:'threads',
    }}]);
  } finally {vi.useRealTimers(); stop(); await devices.dispose();}
});

it('discards the private review draft when recovery presents changed content or a different target', async () => {
  let changed = false;
  useReply = r => ({kind:'review',handle:changed ? secondHandle : handle,groupId:r.type==='begin' && r.groupId ? r.groupId : groupId,
    review:{...baseReview,reviewToken:changed ? 'b'.repeat(64) : token,roleChoiceRequired:true}});
  await draw(); await inGroup(groupId,'检查新版'); await inGroup(groupId,'预览更新');
  const custom = () => document.querySelector<HTMLInputElement>('input[name="recipe-role"][value="custom"]')!;
  const text = '[aria-label="合并后的本群角色"]';
  await act(async () => custom().click()); await fillBuffer(text,'甲的私有草稿');
  await account(otherAccount); expect(document.body.textContent).not.toContain('甲的私有草稿'); expect(document.querySelector(text)).toBeNull();
  changed = true;
  await account(accountId); await click('恢复原操作');
  expect(document.querySelector(text)).toBeNull(); expect(custom().checked).toBe(false);
  await act(async () => custom().click()); await fillBuffer(text,'版本乙同群私有草稿');
  await click('稍后继续'); await inGroup(groupTwo,'检查新版'); await inGroup(groupTwo,'预览更新'); await click('开始当前目标');
  expect(custom().checked).toBe(false);
  await act(async () => custom().click());
  expect(document.querySelector<HTMLTextAreaElement>(text)?.value).toBe(baseReview.currentRole);
  expect(requests.every(r => r.type==='begin')).toBe(true);
});

it('opens installed rich setup through the real shell source facade, labels manual evidence and confirms exact task conditions',async()=>{
  const projected=projectedSnapshot();readSnapshot=async()=>projected;
  const normal=services,setupCalls:unknown[]=[];const stepId='11111111-1111-4111-8111-111111111112',nativeStep='11111111-1111-4111-8111-111111111113';let readiness='pending',taskState='paused';
  services=async(channel,raw,...rest)=>{
    if(channel!==desktopChannels.recipeSource||raw.groupId!==groupId)return normal(channel,raw,...rest);
    const source={...asRead,format:'rich-v2'};
    if(raw.type!=='setup')return {ok:true,value:{source}};
    setupCalls.push(raw);
    if(raw.action.kind==='acknowledge')readiness='acknowledged';
    if(raw.action.kind==='enableTask')taskState='active';
    return {ok:true,value:{source,setup:{kind:'richSetup',groupId,token:'d'.repeat(64),steps:[{itemId:stepId,originId:stepId,kind:'context',title:'核对报告',instructions:'提交前手动检查内容。',required:true,action:{kind:'manual'},readiness},{itemId:nativeStep,originId:nativeStep,kind:'config',title:'本群权限',instructions:'打开权限设置。',required:false,action:{kind:'nativeSettings',entry:'permission'},readiness:'pending'}],tasks:[{id:'rt_fixture',name:'定期摘要',state:taskState,token:'e'.repeat(64),instruction:'核对所选文档，准备待确认摘要。',schedule:'每周一 09:00',timeZone:'Asia/Shanghai',placement:'newTopic'}],...(raw.action.kind==='openSettings'?{open:'permission'}:{})}}};
  };
  facade=createDesktopFacades({receive:listener=>{dispatch=listener;return()=>{};},invoke:services});dispatch({type:'account',value:status});dispatch({type:'devices',value:devicesState({id:A,phase:'ready'})});
  const destinations:unknown[]=[];const opened=(event:Event)=>destinations.push((event as CustomEvent).detail);window.addEventListener('vonvon:open-setting',opened);
  try{
    await draw();const scope=document.querySelector('[data-scope="'+groupId+'"]')!;expect(scope.textContent).toContain('使用设置');expect(scope.textContent).toContain('尚未核对');
    await click('我已手动核对',scope);expect(scope.textContent).toContain('本人已手动确认');expect(scope.textContent).not.toContain('已由当前设备核验');
    await click('前往设置',scope);expect(destinations[0]).toMatchObject({page:'collaboration',selection:{kind:'membership',id:projected.memberships[0]!.id},section:'权限'});
    await click('核对并启用',scope);const dialog=document.querySelector('[role="dialog"]')!;expect(dialog.textContent).toContain('核对所选文档，准备待确认摘要。');expect(dialog.textContent).toContain('每周一 09:00');expect(dialog.textContent).toContain('这台设备上此 Bot 的管理员配置');
    await click('启用此任务',dialog);expect(setupCalls.at(-1)).toMatchObject({type:'setup',viewId:A,botId,groupId,sourceToken:token,action:{kind:'enableTask',taskToken:'e'.repeat(64),token:'d'.repeat(64)}});expect(JSON.stringify(setupCalls.at(-1))).not.toContain('actor');
  }finally{window.removeEventListener('vonvon:open-setting',opened);}
});

it('offers the group identity retry while a rich review is blocked by an unreadable group name',async()=>{
  readIdentity=()=>{throw new Error('offline');};
  useReply=()=>({kind:'richReview',handle,groupId,reviewToken:token,conflicts:[]});
  await draw();await inGroup(groupId,'检查新版');await inGroup(groupId,'预览更新');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('暂时无法读取飞书群名');
  const confirm=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='确认这些选择并预览应用')!;
  expect(confirm.disabled).toBe(true);
  readIdentity=request=>({kind:'groupIdentity',agentId:request.agentId,groupId:request.groupId,name:'重新核对群名'});
  await click('刷新群名');expect(confirm.disabled).toBe(false);
});

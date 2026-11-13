// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {
  agentIdSchema, groupIdSchema, desktopSnapshotSchema,
  type AccountStatus, type RecipeUseRequest, type RecipeUseReply, type ProjectSettingsView,
} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRoot} from '../src/devices/DesktopRoot';
import {projectState} from '../../daemon/src/server/projection';
import {useCommunity} from '../src/community/community-context';
import {RecipeSourcePanel} from '../src/recipes/RecipeSourcePanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {A, B, devicesState} from './devices-fixture';

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


let root: Root, facade: ReturnType<typeof createDesktopFacades>;
let dispatch: (event: unknown) => void;
let requests: RecipeUseRequest[], status: AccountStatus;
let useReply: (r: RecipeUseRequest) => RecipeUseReply | Promise<RecipeUseReply>;
let entitled: boolean;
let readSnapshot: () => Promise<unknown>;
let acquireReply: () => Promise<void>;
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
const button=(text:string, scope:ParentNode=document)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].find(el=>el.textContent===text);
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
  acquireReply=async()=>{};
  facade=createDesktopFacades({receive: listener=>{dispatch=listener;return ()=>{};},invoke:async(channel,raw)=>{
    let v:unknown;
    if(channel===desktopChannels.subscribe) v=undefined;
    else if(channel===desktopChannels.accountStatus) v=status;
    else if(channel===desktopChannels.snapshot) v=await readSnapshot();
    else if(channel===desktopChannels.run) v={kind:'pendingGroups',groups:[]};
    else if(channel===desktopChannels.environment) v={kind:'backends',entries:[]};
    else if(channel===desktopChannels.settings) v={kind:'refused',message:'not configured'};
    else if(channel===desktopChannels.recipeUse){requests.push(raw); v=await useReply(raw);}
    else if(channel===desktopChannels.recipeSource){v=raw.type==='read'?{source:asRead}:{source:asRead,latest:{recipeId,versionId:nextVersion, revision:2,version:'2.0',entitled}};}
    else if(channel===desktopChannels.community){if(raw.type==='acquire') await acquireReply(); v=raw.type==='detail'?{...detail,versionId:raw.versionId,acquired:entitled}:raw.type==='shareLink'?{url:'https://example.invalid/share'}:raw.type==='catalog'?{hero:{recipeId,versionId:nextVersion,revision:2,public:detail.public},items:[],nextCursor:null}:raw.type==='acquire'?(entitled=true,{recipeId,versionId:raw.versionId,owned:false,acquired:true}):{items:[]};}
    else return {ok:false,error:{kind:'rpc',message:'synthetic channel unavailable'}};
    return {ok:true,value:v};
  }});
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

it('does not enable confirmation until the current snapshot identifies the target group', async () => {
  readSnapshot = async () => ({...snapshot, groups: []});
  await draw(); await inGroup(groupId, '检查新版'); await inGroup(groupId, '预览更新');
  expect(button('确认应用到这个群')!.disabled).toBe(true);
  expect(document.body.textContent).toContain('核对后才能确认应用');
  await act(async () => dispatch({type: 'snapshot', view: A, value: {...snapshot, revision: 2, groups: [{id: groupId, name: '已核对的目标群'}]}}));
  expect(button('确认应用到这个群')!.disabled).toBe(false);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('已核对的目标群');
});


it('requires platform group identity instead of another bot local binding alias', async () => {
  const admin = {bots: [['cli_recipe_ui', '本地绑定甲'], ['cli_second', '另一 Bot 的本地绑定乙']].map(([id, label]) => ({
    name: id, appId: id, running: true, active: true, connection: 'connected',
    projects: [{chatId: groupId, name: label, cwd: '/synthetic', kind: 'single', backend: 'codex', mode: 'write', network: false}],
  }))};
  const projected = projectState(admin as never, snapshot, new Set());
  expect(projected.groups[0]?.name).toBe('另一 Bot 的本地绑定乙');
  readSnapshot = async () => desktopSnapshotSchema.parse({...snapshot, ...projected});
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

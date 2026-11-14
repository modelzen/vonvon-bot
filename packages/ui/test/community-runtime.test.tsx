// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {communityRequestSchema, type AccountShell, type CommunityRequest, type RecipeDetail} from '@vonvon/protocol';
import {createDesktopFacades} from '../../desktop/src/facade';
import {desktopChannels} from '../../desktop/src/ipc-contract';
import {DesktopRootView} from '../src/devices/DesktopRoot';
import {CommunityPage} from '../src/community/CommunityPage';
import {useCommunity} from '../src/community/community-context';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {A, B, devicesState, fakeShell, newClient} from './devices-fixture';

const accountId = '44444444-4444-4444-8444-444444444444';
const draftId = '55555555-5555-4555-8555-555555555555';
const recipe: RecipeDetail = {recipeId: A, versionId: B, revision: 1, public: {name: '真实配方', summary: '简介', overview: '# 正文', version: '1', access: 'direct'}, owned: false, acquired: false, config: {role: '角色'}};
const summary = {recipeId: recipe.recipeId, versionId: recipe.versionId, revision: recipe.revision, public: recipe.public};
let root: Root;
let calls: CommunityRequest[];
let handle: (request: CommunityRequest) => Promise<unknown>;
const status = {kind: 'signedIn' as const, accountId, displayName: 'Fixture', provider: 'github' as const, persistence: 'memory' as const};
const account: AccountShell = {status: async () => status, onStatus: listener => {listener(status); return () => {};}, login: async () => status, cancelLogin: async () => status, logout: async () => ({kind: 'signedOut'})};
function Host() {
  const community = useCommunity()!;
  return <DraftGuardProvider><button onClick={() => community.open({kind: 'detail', recipe: {recipeId: A, versionId: B}, privateView: true})}>打开已发布版本</button><button onClick={() => community.open({kind: 'draft'})}>打开私人草稿</button><CommunityPage/></DraftGuardProvider>;
}
const client = newClient();
let shell: ReturnType<typeof fakeShell>;
const draw = async (state = devicesState({id: 'local'})) => {
  await act(async () => {root.render(<DesktopRootView state={state} fallback={client} shell={shell} renderApp={() => <Host/>}/>);});
};
async function click(text: string) {
  const button = [...document.querySelectorAll('[role="dialog"] button'), ...document.querySelectorAll('button')].find(button => button.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => {button!.click();});
}
async function fill(label: string, value: string) {
  if (label === '分享码' && !document.querySelector('[aria-label="分享码"]')) await click('获取配方');
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  expect(input, label).not.toBeNull();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', {bubbles: true}));});
  return input;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!); calls = [];
  handle = async request => {
    if (request.type === 'catalog') return {hero: summary, items: [], nextCursor: null};
    if (request.type === 'detail') return recipe;
    if (request.type === 'shareLink') return {url: 'https://community.example/recipes/' + A + '/versions/' + B};
    if (request.type === 'saveDraft') return {draftId, recipeId: null, revision: 1, public: request.public, config: request.config};
    if (request.type === 'publishDraft') return {...summary, firstCode: 'A'.repeat(32)};
    throw new Error('Unexpected request');
  };
  const community = createDesktopFacades({receive: () => () => {}, invoke: async (channel, raw) => {
    if (channel !== desktopChannels.community) return {ok: true, value: undefined};
    try {const request = communityRequestSchema.parse(raw); calls.push(request); return {ok: true, value: await handle(request)};}
    catch (failure) {return {ok: false, error: {kind: 'validation', message: 'strict boundary rejected request', ...(failure && typeof failure === 'object' && 'code' in failure ? {code: failure.code} : {}), ...(failure && typeof failure === 'object' && 'retryAfter' in failure ? {retryAfter: failure.retryAfter} : {})}};}
  }}).shell.community;
  shell = {...fakeShell(), account, community} as typeof shell;
});
afterEach(async () => {await act(async () => root.unmount()); vi.unstubAllGlobals();});

it('opens an actual catalog card through the production facade and strict main request schema', async () => {
  await draw();
  await act(async () => document.querySelector<HTMLButtonElement>('.community-card')!.click());
  expect(document.querySelector('.community-detail h1')?.textContent).toBe(recipe.public.name);
  expect(calls.filter(request => request.type === 'detail' || request.type === 'shareLink')).toEqual([
    {type: 'detail', accountId, recipeId: A, versionId: B}, {type: 'shareLink', recipeId: A, versionId: B},
  ]);
});
it('uses only immutable IDs when opening a just-published receipt', async () => {
  await draw(); await click('打开私人草稿');
  await fill('配方名称', '发布的名称'); await fill('公开简介', '公开简介');
  await click('预览发布'); await click('发布到社区');
  expect(document.querySelector('.community-detail h1')?.textContent).toBe(recipe.public.name);
  expect(calls.filter(request => request.type === 'detail' || request.type === 'shareLink')).toEqual([
    {type: 'detail', accountId, recipeId: A, versionId: B}, {type: 'shareLink', recipeId: A, versionId: B},
  ]);
  const catalogs=calls.filter(request=>request.type==='catalog').length;
  await click('返回 Bot 配方');
  expect(calls.filter(request=>request.type==='catalog')).toHaveLength(catalogs+1);
});
it('keeps the actual editor DOM, caret, unsaved text and uncertain request key across reconnects and device switches', async () => {
  let attempts = 0;
  const normal = handle;
  handle = async request => {if (request.type === 'saveDraft' && ++attempts === 1) throw new Error('receipt lost'); return normal(request);};
  await draw(); await click('打开私人草稿');
  const input = await fill('配方名称', '保留这份未保存输入');
  await click('保存私人草稿');
  input.focus(); input.setSelectionRange(2, 4);
  for (const state of [devicesState({id: A, phase: 'connecting'}), devicesState({id: A, phase: 'ready'}), devicesState({id: A, phase: 'failed'}), devicesState({id: B, phase: 'ready'}), devicesState({id: 'local'})]) {
    await draw(state);
    const current = document.querySelector<HTMLInputElement>('[aria-label="配方名称"]');
    expect(current).toBe(input); expect(current?.value).toBe('保留这份未保存输入');
    expect(current?.selectionStart).toBe(2); expect(current?.selectionEnd).toBe(4);
  }
  await click('保存私人草稿');
  const saves = calls.filter(request => request.type === 'saveDraft');
  expect(saves).toHaveLength(2); expect(saves[1]).toEqual(saves[0]);
});

it('recovers an uncertain new-draft save before applying later edits without creating a second draft', async () => {
  let attempts=0;
  handle=async request=>{
    if(request.type==='catalog')return {hero:null,items:[],nextCursor:null};
    if(request.type!=='saveDraft')throw new Error('Unexpected draft request');
    if(++attempts===1)throw new Error('回执丢失');
    return {draftId,recipeId:null,revision:attempts-1,public:request.public,config:request.config};
  };
  await draw();await click('打开私人草稿');await fill('配方名称','原名称');await click('保存私人草稿');
  await fill('配方名称','新名称');await click('保存私人草稿');
  const saves=calls.filter(request=>request.type==='saveDraft');
  expect(saves).toHaveLength(3);expect(saves[0]).toEqual(saves[1]);expect(saves[0]!.target.kind).toBe('new');
  expect(saves[2]).toMatchObject({target:{kind:'existing',draftId,revision:1},public:{name:'新名称'}});
  expect(document.querySelector<HTMLInputElement>('[aria-label="配方名称"]')?.value).toBe('新名称');
  expect(document.querySelector('main')?.textContent).toContain('私人草稿已保存');
});

it('recovers a lost code-batch receipt using the same key while retaining only still-available plaintext codes', async () => {
  const available = {codeId: draftId, status: 'available' as const, code: 'A'.repeat(32)};
  const redeemed = {codeId: A, status: 'redeemed' as const};
  const disabled = {codeId: B, status: 'disabled' as const};
  let attempts = 0; const normal = handle;
  handle = async request => {
    if (request.type === 'detail') return {...recipe, owned: true, public: {...recipe.public, access: 'coded'}};
    if (request.type === 'codes') return {items: [available, redeemed, disabled].map(item => ({codeId: item.codeId, status: item.status, suffix: 'AAAA', redeemedAt: null})), nextCursor: null};
    if (request.type === 'issueCodes') {if (++attempts === 1) throw new Error('receipt lost'); return {items: [available, redeemed, disabled]};}
    return normal(request);
  };
  await draw(); await click('打开已发布版本');
  await fill('生成分享码数量', '3'); await click('生成分享码');
  expect(document.querySelector<HTMLInputElement>('[aria-label="生成分享码数量"]')?.disabled).toBe(true);
  await click('重试上一批');
  const issues = calls.filter(request => request.type === 'issueCodes');
  expect(issues).toHaveLength(2); expect(issues[1]).toEqual(issues[0]);
  expect(document.querySelector('.community-code-text')).toBeNull();
  expect(document.querySelector('.community-codes')?.textContent).not.toContain(available.code);
  expect(document.querySelector('.community-codes')?.textContent).toContain('复制分享码');
  expect(document.querySelector('.community-codes')?.textContent).toContain('已兑换');
  expect(document.querySelector('.community-codes')?.textContent).toContain('已停用');
});

it('preserves valid astral field and search limits all the way through the strict boundary', async () => {
  await draw();
  const query = await fill('搜索配方', '🦉'.repeat(120));
  expect(query.maxLength).toBe(-1);
  await click('搜索');
  expect(calls.filter(request => request.type === 'catalog').at(-1)).toMatchObject({query: '🦉'.repeat(120)});
  await click('打开私人草稿');
  const name = await fill('配方名称', '🦉'.repeat(60));
  await fill('公开简介', '🦉'.repeat(240)); await fill('版本', '🦉'.repeat(40));
  expect(name.maxLength).toBe(-1);
  await click('保存私人草稿');
  expect(calls.filter(request => request.type === 'saveDraft').at(-1)).toMatchObject({public: {name: '🦉'.repeat(60), summary: '🦉'.repeat(240), version: '🦉'.repeat(40)}});
});

it.each(['operation_expired','request_upgrade_required'])('reconciles a native %s attempt through the facade and requires explicit confirmation before replacing the key', async failure => {
  let offline = false;
  const normal = handle;
  handle = async request => {
    if (request.type === 'acquire') throw {code: failure};
    if (request.type === 'detail' && offline) throw new Error('offline');
    return normal(request);
  };
  await draw(); await click('打开已发布版本');
  offline = true; await click('获取配方');
  const first = calls.find(request => request.type === 'acquire')!;
  expect(first.requestId).toMatch(/^a2\./);
  offline = false; await click('获取配方');
  expect(document.body.textContent).toContain('已确认尚未获取');
  const attempts = () => calls.filter(request => request.type === 'acquire');
  expect(attempts()).toHaveLength(2); expect(attempts()[1]).toEqual(first);
  await click('获取配方');
  expect(attempts()).toHaveLength(3); expect(attempts()[2]!.requestId).not.toBe(first.requestId);
});

it.each(['acquire_rate_limited','rate_limited'])('retains a native uncertain raw code after %s across a failed detail refresh and device changes', async failure => {
  const normal = handle;
  let failedRead = false;
  handle = async request => {
    if (request.type === 'acquire') throw {code: failure, retryAfter: 60};
    if (request.type === 'detail') {if (failedRead) throw new Error('offline'); const {config: _config, ...publicRecipe} = recipe; return {...publicRecipe, public: {...recipe.public, access: 'coded'}};}
    return normal(request);
  };
  await draw(); await click('打开已发布版本'); await fill('分享码', 'Ab-CD'); await click('获取配方');
  expect(document.body.textContent).toContain('60 秒');
  expect(document.body.textContent).not.toContain('分享码不可用');
  for (const state of [devicesState({id:A,phase:'connecting'}),devicesState({id:A,phase:'ready'}),devicesState({id:'local'})]) await draw(state);
  expect(document.querySelector<HTMLInputElement>('[aria-label="分享码"]')?.value).toBe('Ab-CD');
  await click('获取配方');
  const attempts=calls.filter(request=>request.type==='acquire');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
  failedRead=true;await click('重试读取');
  failedRead=false;await click('重试读取');
  expect(document.querySelector<HTMLInputElement>('[aria-label="分享码"]')?.value).toBe('Ab-CD');
});

it('ignores a native late successful attempt after route A-B-A and leaves the new page editable', async () => {
  let finish!: (value: unknown) => void;
  const normal=handle;
  handle=async request=>request.type==='acquire'?new Promise(resolve=>{finish=resolve;}):normal(request);
  await draw();await click('打开已发布版本');
  await click('获取配方');
  await click('返回 Bot 配方');await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());
  await act(async()=>{finish({recipeId:A,versionId:B,owned:false,acquired:true});});
  expect(document.body.textContent).not.toContain('已获取，已保存在你的账号中');
  expect([...document.querySelectorAll('button')].find(button=>button.textContent==='获取配方')?.disabled).toBe(false);
  expect(calls.filter(request=>request.type==='acquire')).toHaveLength(1);
});

it('ignores a native old-account receipt after another account opens the same version', async () => {
  const listeners = new Set<Parameters<AccountShell['onStatus']>[0]>();
  let current = status;
  shell.account = {...account, status: async () => current, onStatus: listener => {listeners.add(listener); listener(current); return () => {listeners.delete(listener);};}};
  const normal=handle;
  let finish!: (value: unknown) => void;
  handle=async request=>request.type==='acquire'?new Promise(resolve=>{finish=resolve;}):normal(request);
  await draw();await click('打开已发布版本');await click('获取配方');
  await act(async()=>{current={...status,accountId:draftId};listeners.forEach(listener=>listener(current));});
  await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());
  const before=calls.filter(request=>request.type==='detail').length;
  await act(async()=>{finish({recipeId:A,versionId:B,owned:false,acquired:true});});
  expect(document.body.textContent).not.toContain('已获取，已保存在你的账号中');
  expect(calls.filter(request=>request.type==='detail')).toHaveLength(before);
  expect([...document.querySelectorAll('button')].find(button=>button.textContent==='获取配方')?.disabled).toBe(false);
});

it('recovers a clock-rejected native attempt only after a checked explicit retry with a corrected key', async () => {
  const now=Date.now();let clock=now+86400000,acquired=false;
  vi.spyOn(Date,'now').mockImplementation(()=>clock);
  const normal=handle;
  handle=async request=>{
    if(request.type==='acquire') {
      const born=parseInt(request.requestId.slice(3).replaceAll('-','').slice(0,12),16);
      if(born>now+120000)throw {code:'operation_clock_skew'};
      acquired=true;return {recipeId:A,versionId:B,owned:false,acquired:true};
    }
    if(request.type==='detail'){const {config:_config,...publicRecipe}=recipe;return {...publicRecipe,public:{...recipe.public,access:'coded'},acquired,...(acquired?{config:recipe.config}:{})};}
    return normal(request);
  };
  try {
    await draw();await click('打开已发布版本');await fill('分享码','Ab-CD');await click('获取配方');
    expect(document.body.textContent).toContain('校准设备时间');expect(document.body.textContent).toContain('再次点击');
    expect(calls.filter(request=>request.type==='detail')).toHaveLength(2);
    expect(calls.filter(request=>request.type==='acquire')).toHaveLength(1);
    await click('重试读取');
    expect(document.querySelector<HTMLInputElement>('[aria-label="分享码"]')?.value).toBe('Ab-CD');
    expect(calls.filter(request=>request.type==='acquire')).toHaveLength(1);
    clock=now;await click('获取配方');
    const attempts=calls.filter(request=>request.type==='acquire');expect(attempts).toHaveLength(2);
    expect(attempts[1]!.requestId).not.toBe(attempts[0]!.requestId);expect(attempts[1]).toMatchObject({code:'Ab-CD'});
    expect(document.body.textContent).toContain('已获取，已保存在你的账号中');
  } finally {vi.restoreAllMocks();}
});

it('keeps a native clock-rejected raw/key until an online exact-version read confirms the existing entitlement', async () => {
  let offline=false,acquired=false;const normal=handle;
  handle=async request=>{
    if(request.type==='acquire')throw {code:'operation_clock_skew'};
    if(request.type==='detail'){
      if(offline)throw new Error('offline');
      const {config:_config,...publicRecipe}=recipe;return {...publicRecipe,public:{...recipe.public,access:'coded'},acquired,...(acquired?{config:recipe.config}:{})};
    }
    return normal(request);
  };
  await draw();await click('打开已发布版本');await fill('分享码','Ab-CD');offline=true;await click('获取配方');
  expect(document.querySelector<HTMLInputElement>('[aria-label="分享码"]')?.value).toBe('Ab-CD');
  offline=false;acquired=true;await click('获取配方');
  const attempts=calls.filter(request=>request.type==='acquire');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
  expect(document.body.textContent).toContain('已获取，已保存在你的账号中');
});

it('keeps a clock-rejected native key when reconciliation returns another version',async()=>{
  let mismatched=false;const normal=handle;
  handle=async request=>{
    if(request.type==='acquire')throw {code:'operation_clock_skew'};
    if(request.type==='detail'&&mismatched)return {...recipe,versionId:draftId};
    return normal(request);
  };
  await draw();await click('打开已发布版本');mismatched=true;await click('获取配方');await click('获取配方');
  const attempts=calls.filter(request=>request.type==='acquire');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
  expect(document.body.textContent).toContain('获取结果暂未确认');
});

it('ignores a native clock reconciliation after route A-B-A and preserves the current attempt',async()=>{
  let finish!:(value:unknown)=>void,reads=0;const normal=handle;
  handle=async request=>{
    if(request.type==='acquire')throw {code:'operation_clock_skew'};
    if(request.type==='detail'&&++reads===2)return new Promise(resolve=>{finish=resolve;});
    return normal(request);
  };
  await draw();await click('打开已发布版本');await click('获取配方');expect(finish).toBeTypeOf('function');
  await click('返回 Bot 配方');await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());
  await act(async()=>{finish({...recipe,acquired:true});});
  expect(document.body.textContent).not.toContain('已获取，已保存在你的账号中');
  await click('获取配方');const attempts=calls.filter(request=>request.type==='acquire');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
});

it('ignores native clock reconciliation after an account change and preserves the new account input',async()=>{
  const listeners=new Set<Parameters<AccountShell['onStatus']>[0]>();let current=status;
  shell.account={...account,status:async()=>current,onStatus:listener=>{listeners.add(listener);listener(current);return()=>{listeners.delete(listener);};}};
  let finish!:(value:unknown)=>void,reads=0;const normal=handle;
  handle=async request=>{
    if(request.type==='acquire')throw {code:'operation_clock_skew'};
    if(request.type==='detail'){
      if(++reads===2)return new Promise(resolve=>{finish=resolve;});
      const {config:_config,...publicRecipe}=recipe;return {...publicRecipe,public:{...recipe.public,access:'coded'}};
    }
    return normal(request);
  };
  await draw();await click('打开已发布版本');await fill('分享码','OLD-CODE');await click('获取配方');expect(finish).toBeTypeOf('function');
  await act(async()=>{current={...status,accountId:draftId};listeners.forEach(listener=>listener(current));});
  await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());await fill('分享码','NEW-CODE');
  await act(async()=>{finish({...recipe,acquired:true});});
  expect(document.body.textContent).not.toContain('已获取，已保存在你的账号中');
  expect(document.querySelector<HTMLInputElement>('[aria-label="分享码"]')?.value).toBe('NEW-CODE');
  expect([...document.querySelectorAll('button')].find(button=>button.textContent==='获取配方')?.disabled).toBe(false);
});

it('retains edited text and reconciles an uncertain submission across a native detail reread',async()=>{
  let offline=false;const normal=handle;
  handle=async request=>{
    if(request.type==='acquire')throw {code:'unavailable'};
    if(request.type==='detail'){
      if(offline)throw new Error('offline');
      return {recipeId:A,versionId:B,revision:1,owned:false,acquired:false,public:{...recipe.public,access:'coded'}};
    }
    return normal(request);
  };
  const attempts=()=>calls.filter(request=>request.type==='acquire');
  await draw();await click('打开已发布版本');await fill('分享码','Old-Code');await click('获取配方');
  await fill('分享码','New-Code');await click('重试读取');
  expect(document.querySelector<HTMLInputElement>('[aria-label="分享码"]')?.value).toBe('New-Code');
  offline=true;await click('获取配方');expect(attempts()).toHaveLength(1);
  offline=false;await click('获取配方');expect(attempts()).toHaveLength(1);
  expect(document.body.textContent).toContain('已确认尚未获取');
  await click('获取配方');expect(attempts()).toHaveLength(2);
  expect(attempts()[1]!.requestId).not.toBe(attempts()[0]!.requestId);
  expect(attempts()[1]!.code).toBe('New-Code');
});

it('renders complete rich configuration through the strict facade and hides every private tab in coded introductions',async()=>{
  const {canonicalizeRichRecipeContent}=await import('@vonvon/protocol');
  const {readFileSync}=await import('node:fs');const {resolve}=await import('node:path');
  const content=JSON.parse(readFileSync(resolve(process.cwd(),'../protocol/test/fixtures/recipe-rich-v2.content.json'),'utf8'));
  content.parts=[];content.memories=[];delete content.finalLogo;
  const doc=canonicalizeRichRecipeContent(content);
  const normal=handle;let acquired=false;
  handle=async request=>{
    if(request.type==='detail')return {...summary,format:'rich-v2',public:{...recipe.public,access:'coded'},owned:false,acquired,...(acquired?{rich:{content:doc.content,texts:{},canonical:Buffer.from(doc.canonicalUTF8).toString('base64url')}}:{})};
    if(request.type==='acquire'){acquired=true;return {recipeId:A,versionId:B,owned:false,acquired:true};}
    return normal(request);
  };
  await draw();await act(async()=>document.querySelector<HTMLButtonElement>('.community-card')!.click());
  expect(document.querySelector('[aria-label="配方详细信息"]')?.textContent).toBe('概览');
  expect(document.querySelector('.community-detail')?.textContent).not.toContain(content.role.text.value);
  await fill('分享码','VALID');await click('获取配方');
  for(const section of ['模型与权限','能力','沟通方式','记忆','任务','使用前准备']){
    await click(section);expect(document.querySelector('.community-detail-content h2')?.textContent).toBe(section==='能力'?'角色':section);
  }
  await click('记忆');expect(document.querySelector('.community-config')?.textContent).toBe('记忆');
  await click('能力');expect(document.querySelector('.community-detail-content')?.textContent).toContain(content.role.text.value);
});

it('opens coded acquisition in a focused dialog and keeps an uncertain retry bound to the same request', async () => {
  const normal = handle;
  let acquired = false, attempts = 0;
  handle = async request => {
    if (request.type === 'detail') {const {config, ...intro} = recipe; return {...intro, public: {...recipe.public, access: 'coded'}, acquired, ...(acquired ? {config} : {})};}
    if (request.type === 'acquire') {
      if (++attempts === 1) throw new Error('receipt lost');
      acquired = true;
      return {recipeId: A, versionId: B, owned: false, acquired: true};
    }
    return normal(request);
  };
  await draw(); await click('打开已发布版本');
  expect(document.querySelector('[aria-label="分享码"]')).toBeNull();
  const trigger = [...document.querySelectorAll('button')].find(button => button.textContent === '获取配方')!;
  expect(trigger.disabled).toBe(false);
  await click('获取配方');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('分享码');
  expect(calls.filter(request => request.type === 'acquire')).toHaveLength(0);
  await fill('分享码', 'VALID'); await click('获取配方');
  expect(document.querySelector('[role="dialog"] [aria-label="分享码"]')).not.toBeNull();
  await click('获取配方');
  const requests = calls.filter(request => request.type === 'acquire');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(document.body.textContent).toContain('已获取，已保存在你的账号中');
});


it('keeps rental content distinct and explicitly returns other routes to recipes', async () => {
  const normal = handle;
  handle = async request => request.type === 'drafts' || request.type === 'publications' ? {items: []} : normal(request);
  await draw();
  const rental = [...document.querySelectorAll('button')].find(button => button.textContent?.startsWith('Bot 租赁'))!;
  await act(async () => rental.click());
  expect(document.querySelector('.community-section-heading')).toBeNull();
  expect(document.querySelector('.community-empty h2')?.textContent).toBe('Bot 租赁');
  expect(document.body.textContent?.match(/敬请期待/g)).toHaveLength(1);
  await click('打开已发布版本');
  await click('返回 Bot 配方');
  expect(document.querySelector('.community-tabs button[aria-current="page"]')?.textContent).toBe('Bot 配方');
  expect(document.querySelector('.community-card')).not.toBeNull();
  expect(document.querySelector('.community-empty')).toBeNull();
});

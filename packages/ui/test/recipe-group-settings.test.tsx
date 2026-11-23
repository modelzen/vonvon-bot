// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {RecipeRichSetting} from '@vonvon/protocol';
import {RecipeGroupConfiguration} from '../src/community/RecipeGroupConfiguration';
import {PermissionSummary} from '../src/settings/SettingsPanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {permissionValue} from './permission-fixture';
import type {RecipeDisplay} from '../src/community/RecipeContent';

let root: Root;
const id = '11111111-1111-4111-8111-111111111111';
const identity = {itemId:id,originId:id};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){} unobserve(){}});
  document.body.innerHTML='<div id="root"></div>';
  root=createRoot(document.getElementById('root')!);
});
afterEach(async()=>{await act(async()=>root.unmount());vi.unstubAllGlobals();});
function recipe(settings:RecipeRichSetting[],ruleCount=0,omittedSettingCount=0):RecipeDisplay{
  return {public:{name:'周报助手',summary:'整理周报',overview:'MCP https://secret.invalid/?token=private',version:'1',access:'direct'},
    preview:{settings,skills:[],ruleCount,taskCount:0,omittedSettingCount}};
}
async function show(settings:RecipeRichSetting[],section:'模型与权限'|'沟通方式',count=0,omitted=0){
  await act(async()=>root.render(<RecipeGroupConfiguration recipe={recipe(settings,count,omitted)} section={section}/>));
}
function findRow(title:string,parent:ParentNode=document){
  return [...parent.querySelectorAll('.ss-row')].find(element=>element.querySelector('.ss-row__title')?.textContent===title);
}
it('shows separate provider, recommended model and effort values, model-specific access, and actual native permission details',async()=>{
  await show([
    {...identity,field:'model.recommendation',value:{backend:'claude-agent',selection:{kind:'explicit',model:'opus-fixture',effort:'high'}}},
    {...identity,field:'modelAccess.recommendation',value:{backend:'codex-appserver',models:['first','second'],efforts:['low'],modelEfforts:{first:['high','max']},defaultModel:'first',defaultEffort:'max'}},
    {...identity,field:'permission.requirement',value:{mode:'write'}},
    {...identity,field:'permission.codex.requirement',value:{sandbox:'workspace-write',network:false}},
  ],'模型与权限');
  expect(findRow('Provider')?.textContent).toContain('Codex');
  expect(findRow('推荐模型')?.textContent).toMatch(/Claude.*opus-fixture/);
  expect(findRow('推荐思考强度')?.textContent).toContain('high');
  expect(document.querySelector('[aria-label="查看可用思考强度"]')?.textContent).toContain('high、max、low');
  const view=[...document.querySelectorAll('button')].find(b=>b.textContent==='查看权限')!;
  await act(async()=>view.click());
  const modal=document.querySelector('[role="dialog"]')!;
  expect(findRow('文件访问范围',modal)?.textContent).toContain('工作区可写');
  expect(findRow('网络访问',modal)?.textContent).toContain('关闭');
  expect(modal.querySelector('dl')).toBeNull();
  expect(modal.textContent).not.toContain('Claude');expect(document.body.textContent).not.toContain('secret.invalid');
});
it('renders smart mode and declared communication options, counts rules and omits schema identifiers and card templates',async()=>{
  await show([
    {...identity,field:'sessionMode',value:'smart'},{...identity,field:'response.noMention',value:false},
    {...identity,field:'run.pendingPolicy',value:'queue'},
    {...identity,field:'presentation.showToolCalls',value:false},
    {...identity,field:'judge.recommendation',value:{kind:'llm',backend:'codex-appserver',model:'judge-fixture',effort:'low'}},
    {...identity,field:'presentation.cardDisplay',value:{version:1,blocks:[],reply:{streamText:true,collapseAfterRun:false}}},
  ],'沟通方式',2);
  expect(findRow('免 @')?.textContent).toContain('由 Bot 判断');expect(findRow('不 @ 也能发起任务')).toBeUndefined();
  expect(findRow('新消息处理')?.textContent).toContain('排队等待');expect(findRow('决策模型')?.textContent).toContain('judge-fixture');
  expect(findRow('群内规则')?.textContent).toContain('2 项');expect(findRow('消息卡片')?.textContent).toContain('0 个区块');
  expect(findRow('流式回复')?.textContent).toContain('开启');expect(findRow('展示工具调用')?.textContent).toContain('关闭');
  expect(document.body.textContent).not.toContain('secret.invalid');expect(document.body.textContent).not.toContain('itemId');
});
it('keeps omitted preview settings distinct from an empty recipe and avoids empty action menus',async()=>{
  await show([],'模型与权限');
  expect(findRow('Provider')?.textContent).toContain('沿用目标群设置');
  expect(findRow('推荐模型')?.textContent).toContain('沿用目标群设置');
  expect(document.querySelector('button')).toBeNull();
  await show([],'沟通方式',0,3);
  expect(findRow('会话模式')?.textContent).toContain('概览未提供');
  expect(findRow('会话模式')?.textContent).not.toContain('沿用');
  expect(findRow('决策模型')?.textContent).toContain('概览未提供');
  expect(findRow('提醒方式')?.textContent).toContain('概览未提供');
  expect(document.querySelectorAll('.ss-row')).toHaveLength(3);
  await show([],'沟通方式');
  for(const label of ['会话模式','决策模型','提醒方式'])expect(findRow(label)?.textContent).toContain('沿用目标群设置');
  expect(findRow('群内规则')).toBeUndefined();expect(document.querySelector('button')).toBeNull();
});


it('opens the editable group permission summary and saves the selected tier at the displayed revision',async()=>{
  const stored=permissionValue('qa'), revision='group-revision-7';
  const section={stored,effective:stored,revision,access:{kind:'writable' as const},apply:[]};
  const saved={...section,stored:permissionValue('write'),effective:permissionValue('write'),revision:'group-revision-8'};
  const save=vi.fn().mockResolvedValue({kind:'saved',result:{kind:'saved',section:{value:saved},effects:[]}});
  await act(async()=>root.render(<DraftGuardProvider><PermissionSummary section={section} provider="Codex" save={save}/></DraftGuardProvider>));
  const action=[...document.querySelectorAll('button')].find(button=>button.textContent==='修改权限')!;
  await act(async()=>action.click());
  const dialog=document.querySelector<HTMLElement>('[role="dialog"]')!;
  const option=dialog.querySelector<HTMLInputElement>('input[type="radio"][value="write"]')!;
  await act(async()=>option.click());
  expect(option.checked).toBe(true);expect(save).not.toHaveBeenCalled();
  const confirm=[...dialog.querySelectorAll('button')].find(button=>button.textContent==='保存权限')!;
  expect(confirm.disabled).toBe(false);
  await act(async()=>confirm.click());
  expect(save).toHaveBeenCalledExactlyOnceWith({mode:'write'},revision);
});

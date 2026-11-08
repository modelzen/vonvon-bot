import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type ProjectSettingsView} from '@vonvon/protocol';
import {Button} from '../src/reference/components/ui';
import {ProjectPanel} from '../src/settings/SettingsPanel';
import {ResponseMemberPicker} from '../src/settings/ResponseMemberPicker';
import {PeopleRows, PeopleSearch} from '../src/management/PeoplePicker';
import {permissionValue} from './permission-fixture';

type Bank = {states:unknown[]; refs:Array<{current:unknown}>};
const h=vi.hoisted(()=>({banks:{} as Record<string,Bank>,key:'',si:0,ri:0,client:{settings:vi.fn()}}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
  useState:(initial:unknown)=>{const bank=h.banks[h.key]!;const at=h.si++;if(!(at in bank.states))bank.states[at]=typeof initial==='function'?initial():initial;return [bank.states[at],(next:unknown)=>{bank.states[at]=typeof next==='function'?next(bank.states[at]):next;}];},
  useRef:(initial:unknown)=>h.banks[h.key]!.refs[h.ri++]??={current:initial},useContext:()=>[],useEffect:()=>{},useLayoutEffect:()=>{},
}));
vi.mock('../src/client-context',()=>({useClient:()=>h.client,useShellCapabilities:()=>undefined}));
vi.mock('../src/settings/DraftGuard',()=>({useDraft:()=>{}}));
type Element=ReactElement<Record<string,any>>;
function nodes(node:ReactNode):Element[]{return Array.isArray(node)?node.flatMap(nodes):isValidElement<Record<string,any>>(node)?[node,...(node.type===PeopleRows ? nodes(PeopleRows(node.props as Parameters<typeof PeopleRows>[0])) : node.type===PeopleSearch ? nodes(PeopleSearch(node.props as Parameters<typeof PeopleSearch>[0])) : []),...nodes(node.props.children),...nodes(node.props.trailing),...nodes(node.props.action)]:[];}
function at<T>(key:string,render:()=>T){h.key=key;h.si=h.ri=0;h.banks[key]??={states:[],refs:[]};return render();}
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}
const section=<T,>(stored:T)=>({stored,effective:stored,revision:'r',access:{kind:'writable' as const},apply:[]});
function fixture():ProjectSettingsView{return {scope:{kind:'project',botId:agentIdSchema.parse('cli_fixture'),projectName:'demo'},identity:{chatId:'oc_fixture',backend:'codex-appserver',cwd:'/fixture',kind:'smart'},sections:{permission:section(permissionValue()),response:section({noMention:false}),model:section({selection:{kind:'default'}})},members:{openIds:[],revision:'members-1',roster:{state:'complete',otherBots:true,entries:[{openId:'ou_person',name:'张三',kind:'person'},{openId:'ou_bot',name:'研发助手',kind:'bot'}]}}};}
beforeEach(()=>{h.banks={};vi.clearAllMocks();h.client.settings.mockResolvedValue({kind:'acted',result:{kind:'saved'}});});

it('adds a selected group member with the current audience revision and preserves the all-members reset',async()=>{
  const view=fixture();const refresh=vi.fn().mockResolvedValue(undefined);
  const render=()=>at('panel',()=>nodes(ProjectPanel({view,refresh,partition:'members'})));
  expect(render().some(node=>node.props.title==='所有成员')).toBe(true);
  render().find(node=>node.type===Button&&node.props['aria-label']==='指定成员')!.props.onClick();
  render().find(node=>node.type===ResponseMemberPicker)!.props.onPick('ou_person');await flush();
  expect(h.client.settings).toHaveBeenCalledExactlyOnceWith({type:'act',action:{kind:'projectMember',botId:'cli_fixture',projectName:'demo',openId:'ou_person',membership:'present',revision:'members-1'}});
  expect(refresh).toHaveBeenCalledOnce();
  view.members={...view.members,openIds:['ou_person'],revision:'members-2'};
  await render().find(node=>node.type===Button&&node.props.children==='恢复所有成员')!.props.onClick();
  expect(h.client.settings).toHaveBeenLastCalledWith({type:'act',action:{kind:'projectAudience',botId:'cli_fixture',projectName:'demo',audience:'all',revision:'members-2'}});
});

it('does not mutate a readonly audience and refreshes after an audience conflict',async()=>{
  const view=fixture();view.members.openIds=['ou_person'];const refresh=vi.fn().mockResolvedValue(undefined);
  const render=()=>at('panel',()=>nodes(ProjectPanel({view,refresh,partition:'members'})));
  h.client.settings.mockResolvedValueOnce({kind:'acted',result:{kind:'conflict'}});
  render().find(node=>node.type===Button&&node.props['aria-label']==='移除 张三')!.props.onClick();await flush();expect(refresh).toHaveBeenCalledOnce();
  view.sections.permission.access={kind:'readonly',reason:'owner-offline',message:'只读'};
  const reset=render().find(node=>node.type===Button&&node.props.children==='恢复所有成员')!;expect(reset.props.disabled).toBe(true);await reset.props.onClick();
  render().find(node=>node.type===Button&&node.props['aria-label']==='移除 张三')!.props.onClick();await flush();expect(h.client.settings).toHaveBeenCalledTimes(1);
});

it('browses people and bots by name, hides selected members and has no manual ID entry',()=>{
  const onPick=vi.fn();const props={roster:fixture().members.roster,selected:['ou_bot'],busy:false,readonly:false,onPick,onRefresh:vi.fn(),onClose:vi.fn()};
  const render=()=>at('picker',()=>nodes(ResponseMemberPicker(props)));
  const person=render().find(node=>node.type===Button&&node.props['aria-label']==='添加 张三')!;person.props.onClick();expect(onPick).toHaveBeenCalledWith('ou_person');
  expect(render().some(node=>node.props['aria-label']==='添加 研发助手')).toBe(false);
  expect(render().some(node=>node.type==='details' || node.props['aria-label']==='成员 Open ID')).toBe(false);
  render().find(node=>node.props['aria-label']==='搜索群成员')!.props.onChange({target:{value:'没人'}});
  expect(render().some(node=>node.props['aria-label']==='添加 张三')).toBe(false);
  expect(render().some(node=>node.props.children==='没有匹配的成员。')).toBe(true);
});

it('shared candidate rows block selection while readonly or busy',()=>{
  const onPick=vi.fn();
  const rows=nodes(PeopleRows({people:[{openId:'ou_person',name:'张三'}],label:'群成员',disabled:true,onPick,empty:'空'}));
  const button=rows.find(node=>node.type===Button)!;
  expect(button.props.disabled).toBe(true);button.props.onClick();expect(onPick).not.toHaveBeenCalled();
});

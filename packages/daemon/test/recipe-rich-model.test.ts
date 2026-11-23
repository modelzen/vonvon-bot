import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {proposeRich,type RichModelInput,type RichModelItem} from '../src/recipe/authoring-rich-model';

const signal=()=>new AbortController().signal;
const item=(kind:RichModelItem['kind'],value:unknown,field?:string):RichModelItem=>({itemId:randomUUID(),kind,value,...(field&&{field})});
const publicItem=(field='name')=>item('publicText','原文',field);
function run(selected:RichModelItem[],commands:unknown[],instruction='把名称完整改为「新名称」',phase:RichModelInput['phase']='edit'){
  const parser={proposeRich:vi.fn().mockResolvedValue({kind:'proposal',commands})};
  return {parser,answer:proposeRich({selected,instruction,phase},signal(),parser)};
}

it.each([
  ['name','Vonvon「答疑」助手'],
  ['summary','解答「用法」，整理排错反馈。'],
  ['overview','## 使用前\n请运行 setup 技能。\n保留 "引号" 和换行。'],
  ['version','v1.1（试用）'],
])('maps direct public %s text to the selected stable identity',async(field,text)=>{
  const other=publicItem('summary'),target=publicItem(field);
  const {answer}=run([other,target],[{action:'setPublicText',target:'T2',text}],'请把这项完整改为「'+text+'」');
  await expect(answer).resolves.toEqual({kind:'proposal',changes:[{op:'setPublicText',itemId:target.itemId,field,value:text}],omitted:[]});
});

it.each([
  ['string',JSON.stringify('新名称')],
  ['name wrapper',JSON.stringify({name:'新名称'})],
  ['value wrapper',JSON.stringify({value:'新名称'})],
])('does not infer public text from generic edit %s',async(_label,valueJson)=>{
  await expect(run([publicItem()],[{action:'edit',target:'T1',valueJson}]).answer).rejects.toThrow('公开文字');
});

it.each([
  {action:'setPublicText',target:'T1',text:{value:'新名称'}},
  {action:'setPublicText',target:'T1',text:{name:'新名称'}},
  {action:'setPublicText',target:'T1',text:null},
  {action:'setPublicText',target:'T1',text:12},
  {action:'setPublicText',target:'T1',text:'新名称',valueJson:'"新名称"'},
  {action:'setPublicText',target:'T1',text:'新名称',itemId:randomUUID()},
  {action:'setPublicText',target:'T1',text:'新名称',field:'summary'},
  {action:'setPublicText',target:'T1',text:'新名称',accountId:randomUUID()},
])('rejects malformed or identity-bearing public command %#',async command=>{
  await expect(run([publicItem()],[command]).answer).rejects.toThrow();
});

it.each([
  {action:'setPublicText',target:'T0',text:'新名称'},
  {action:'setPublicText',target:'T2',text:'新名称'},
  {action:'setPublicText',target:'name',text:'新名称'},
])('rejects an unselected alias %#',async command=>{
  await expect(run([publicItem()],[command]).answer).rejects.toThrow('目标不在本轮');
});

it.each([
  item('role',{kind:'inline',value:'原规则'}),
  item('setting',{field:'sessionMode',value:'multi'},'sessionMode'),
  item('skill',{name:'说明技能'}),
])('rejects the public command for a non-public target %#',async target=>{
  await expect(run([target],[{action:'setPublicText',target:'T1',text:'新名称'}]).answer).rejects.toThrow('公开文案目标');
});

it.each(['','   '])('rejects empty public text %j',async text=>{
  await expect(run([publicItem()],[{action:'setPublicText',target:'T1',text}]).answer).rejects.toThrow();
});

it('rejects duplicate aliases across commands before returning any patch',async()=>{
  await expect(run([publicItem()],[
    {action:'setPublicText',target:'T1',text:'新名称'},
    {action:'setPublicText',target:'T1',text:'新名称'},
  ]).answer).rejects.toThrow('重复修改');
});

it.each([['name',61],['summary',241],['version',41]])('enforces protocol limits for %s',async(field,size)=>{
  const text='字'.repeat(Number(size));
  await expect(run([publicItem(String(field))],[{action:'setPublicText',target:'T1',text}],'改为「'+text+'」').answer).rejects.toThrow();
});

it('screens private paths before invoking the parser',async()=>{
  const {answer,parser}=run([publicItem()],[{action:'setPublicText',target:'T1',text:'/Users/private/example'}],'把名称改为 /Users/private/example');
  await expect(answer).rejects.toThrow();
  expect(parser.proposeRich).not.toHaveBeenCalled();
});

it('keeps mixed public, role, setting, copy and remove operations typed and scoped',async()=>{
  const selected=[publicItem(),item('role',{kind:'inline',value:'旧规则'}),
    item('setting',{field:'sessionMode',value:'multi'},'sessionMode'),item('skill',{name:'原技能'}),item('rule',{purpose:'work',text:{kind:'inline',value:'原规则'}})];
  const {answer}=run(selected,[
    {action:'setPublicText',target:'T1',text:'新名称'},
    {action:'edit',target:'T2',valueJson:JSON.stringify({kind:'inline',value:'只整理公开资料'})},
    {action:'edit',target:'T3',valueJson:JSON.stringify({field:'sessionMode',value:'single'})},
    {action:'copy',target:'T4',valueJson:'null'},
    {action:'remove',target:'T5',valueJson:'null'},
  ]);
  await expect(answer).resolves.toEqual({kind:'proposal',changes:[
    {op:'setPublicText',itemId:selected[0]!.itemId,field:'name',value:'新名称'},
    {op:'setRoleText',itemId:selected[1]!.itemId,value:{kind:'inline',value:'只整理公开资料'}},
    {op:'setSetting',itemId:selected[2]!.itemId,value:{field:'sessionMode',value:'single'}},
    {op:'copyItem',source:{kind:'skill',itemId:selected[3]!.itemId}},
    {op:'removeItem',kind:'rule',itemId:selected[4]!.itemId},
  ],omitted:[]});
});

it('retains strict generic operation payloads and protected-setting checks',async()=>{
  const setting=item('setting',{field:'sessionMode',value:'multi'},'sessionMode');
  const protectedSetting=item('setting',{field:'permission.requirement',value:{mode:'qa'}},'permission.requirement');
  for(const command of [
    {action:'edit',target:'T1',valueJson:'{not json'},
    {action:'edit',target:'T1',valueJson:JSON.stringify({field:'response.noMention',value:true})},
    {action:'edit',target:'T1',valueJson:JSON.stringify({field:'sessionMode',value:'single',accountId:randomUUID()})},
    {action:'remove',target:'T1',valueJson:'{}'},
  ])await expect(run([setting],[command]).answer).rejects.toThrow();
  await expect(run([protectedSetting],[{action:'edit',target:'T1',valueJson:JSON.stringify({field:'permission.requirement',value:{mode:'full'}})}]).answer).rejects.toThrow('模型和权限');
});

it('allows omission only for a selected optional item in creation',async()=>{
  const skill=item('skill',{name:'可选技能'}),command={action:'omit',target:'T1',valueJson:'null'};
  await expect(run([skill],[command],'本次不带这个技能','create').answer).resolves.toEqual({kind:'proposal',changes:[],omitted:[skill.itemId]});
  await expect(run([skill],[command]).answer).rejects.toThrow();
  await expect(run([publicItem()],[command],'不带名称','create').answer).rejects.toThrow();
});

it('rejects malformed top-level identity metadata and mismatched clarify commands',async()=>{
  for(const raw of [
    {kind:'proposal',accountId:randomUUID(),commands:[{action:'setPublicText',target:'T1',text:'新名称'}]},
    {kind:'clarify',commands:[{action:'setPublicText',target:'T1',text:'新名称'}]},
    {kind:'proposal',commands:[]},
  ])await expect(proposeRich({instruction:'把名称改为新名称',selected:[publicItem()],phase:'edit'},signal(),{proposeRich:vi.fn().mockResolvedValue(raw)})).rejects.toThrow();
});

it('accepts AI-authored Markdown as an explicitly selected public candidate',async()=>{
  const target=publicItem('overview'),text='# 使用方式\n\n先整理问题，再生成答疑草稿。';
  const {answer}=run([target],[{action:'setPublicText',target:'T1',text}],'请创作 Markdown 概览，说明答疑配方的使用方式。');
  await expect(answer).resolves.toEqual({kind:'proposal',changes:[{op:'setPublicText',itemId:target.itemId,field:'overview',value:text}],omitted:[]});
});

it.each(['/Users/private/example','api_key: secret','ou_private123'])('rejects sensitive AI-authored public text %j',async text=>{
  await expect(run([publicItem()],[{action:'setPublicText',target:'T1',text}],'请帮我创作名称').answer).rejects.toThrow('敏感');
});

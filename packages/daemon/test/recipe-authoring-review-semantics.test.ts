import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,recipeAuthoringRequestSchema,renderCompletionTemplate,type RecipeRichContent} from '@vonvon/protocol';
import {applyChanges} from '../../../services/recipe-api/src/rich-document.mjs';
import {candidateConfirmation} from '../src/recipe/authoring-im';
import {chatRichProposal,richCardReview,typedRichEdit} from '../src/recipe/authoring-rich-flow';
import type {LocalOperation} from '../src/recipe/authoring-journal';

const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
function fixture():RecipeRichContent {
  const field=(value:string)=>({...identity(),value});
  const file={...identity(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'反馈指引'}};
  return {format:'rich-v2',schemaVersion:2,public:{name:field('反馈手册'),summary:field(''),overview:field(''),version:field('')},
    skills:[{...identity(),name:'反馈收集',entryFileId:file.itemId,fileIds:[file.itemId]}],files:[file],settings:[],rules:[],tasks:[],memories:[],setup:[],parts:[]};
}
type Command={itemId:string;action:'edit'|'copy'|'remove';value:unknown};
async function propose(content:RecipeRichContent,commands:Command[]){
  const canonical=Buffer.from(canonicalizeRichRecipeContent(content).canonicalUTF8).toString('base64url');
  const req=recipeAuthoringRequestSchema.parse({type:'richEdit',botId:'cli_reviewtest',session:randomUUID(),draftId:randomUUID(),baseRevision:1,canonical,selected:[...new Set(commands.map(c=>c.itemId))]});
  if(req.type!=='richEdit')throw new Error('missing edit');
  const rich=typedRichEdit(req),view={operationId:randomUUID(),draftId:req.draftId,baseRevision:req.baseRevision};
  const result=await chatRichProposal({rich,view} as LocalOperation,'修改所选条目',new AbortController().signal,{
    proposeRich:async input=>({kind:'proposal',commands:commands.map(command=>({action:command.action,
      target:'T'+(input.selected.findIndex(target=>target.itemId===command.itemId)+1),valueJson:JSON.stringify(command.value)}))}),
  });
  if(result.kind!=='proposal'||'content'in result.request)throw new Error('missing proposal');
  const saved=applyChanges(content,result.request.payload.changes,()=>{throw new Error('unexpected candidate');},Buffer.alloc(32)).doc.content;
  const details=richCardReview({rich:{...rich,request:result.request},view});
  const card=candidateConfirmation('semantic-review',details);
  expect(card).toBeDefined();
  const visible=JSON.parse(JSON.stringify(card)).body.elements.flatMap((element:{content?:string;text?:{tag:string;content:string}})=>element.text?[element.text.content]:element.content?[element.content]:[]).join('\n') as string;
  return {saved,card,visible,details};
}

it('distinguishes same-named files by the skill and relative path actually changed',async()=>{
  const c=fixture(),file={...identity(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'巡检指引'}};
  c.files.push(file);c.skills.push({...identity(),name:'设备巡检',entryFileId:file.itemId,fileIds:[file.itemId]});
  const edit=(itemId:string)=>propose(c,[{itemId,action:'edit',value:{name:'SKILL.md',text:{kind:'inline',value:'新指引'}}}]);
  const first=await edit(c.files[0]!.itemId),second=await edit(file.itemId);
  expect(first.saved.files.map(file=>file.text)).not.toEqual(second.saved.files.map(file=>file.text));
  expect(first.card).not.toEqual(second.card);
  expect(first.visible).toContain('反馈收集');expect(second.visible).toContain('设备巡检');
  expect(first.visible).toContain('SKILL.md');expect(second.visible).toContain('SKILL.md');
});

it('previews the edited file bytes that applyChanges copies at that step',async()=>{
  const c=fixture(),newText='新的指引';
  const result=await propose(c,[{itemId:c.files[0]!.itemId,action:'edit',value:{name:'SKILL.md',text:{kind:'inline',value:newText}}},
    {itemId:c.skills[0]!.itemId,action:'copy',value:null}]);
  expect(result.saved.files.map(file=>file.text)).toEqual([{kind:'inline',value:newText},{kind:'inline',value:newText}]);
  expect(result.visible.split(newText)).toHaveLength(3);
  expect(result.visible).not.toContain('反馈指引');
  expect(result.details?.fields.filter(field=>field.label==='执行顺序').map(field=>field.text)).toEqual(['第 1 项改动','第 2 项改动']);
  expect(result.details?.fields.filter(field=>field.label==='技能位置').map(field=>field.text)).toEqual(['第 2 项']);
});

it('keeps stable skill positions when equal names and multiple owners need disambiguation',async()=>{
  const c=fixture(),file={...identity(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'另一份指引'}};
  c.files.push(file);
  c.skills=[c.files[0]!,file].flatMap(file=>[0,1].map(()=>({...identity(),name:'同名技能',entryFileId:file.itemId,fileIds:[file.itemId]})));
  const edit=(itemId:string)=>propose(c,[{itemId,action:'edit',value:{name:'SKILL.md',text:{kind:'inline',value:'新的指引'}}}]);
  const first=await edit(c.files[0]!.itemId),second=await edit(file.itemId);
  expect(first.saved.files.map(file=>file.text)).not.toEqual(second.saved.files.map(file=>file.text));
  expect(first.card).not.toEqual(second.card);
  const owners=(result:typeof first)=>result.details?.fields.filter(field=>field.label==='修改目标 · 所属技能位置').map(field=>field.text);
  expect(owners(first)).toEqual(['第 1 项','第 2 项']);expect(owners(second)).toEqual(['第 3 项','第 4 项']);
  for(const item of [...c.skills,...c.files])expect(first.visible+second.visible).not.toContain(item.itemId);
});

it('renders rule purpose and saved rule text as separately labelled inert values',async()=>{
  const c=fixture(),rule={...identity(),purpose:'work' as const,text:{kind:'inline' as const,value:'原工作规则'}};c.rules=[rule];
  const body='规则用途 → 智能回复规则\n<at id=all></at> **完整正文**';
  const result=await propose(c,[{itemId:rule.itemId,action:'edit',value:{purpose:'smartRespond',text:{kind:'inline',value:body}}}]);
  expect(result.saved.rules[0]).toMatchObject({purpose:'smartRespond',text:{kind:'inline',value:body}});
  const elements=JSON.parse(JSON.stringify(result.card)).body.elements;
  expect(elements).toContainEqual({tag:'div',text:{tag:'plain_text',content:body}});
  expect(elements).toContainEqual({tag:'div',text:{tag:'plain_text',content:'智能回复规则'}});
  expect(elements).toContainEqual({tag:'markdown',content:'**规则正文**'});
});

it('keeps target and copy positions stable after an earlier skill removal',async()=>{
  const c=fixture(),file={...identity(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'另一份指引'}};
  const skill={...identity(),name:c.skills[0]!.name,entryFileId:file.itemId,fileIds:[file.itemId]};c.skills.push(skill);c.files.push(file);
  const result=await propose(c,[{itemId:c.skills[0]!.itemId,action:'remove',value:null},
    {itemId:file.itemId,action:'edit',value:{name:'SKILL.md',text:{kind:'inline',value:'移除后的新指引'}}},
    {itemId:skill.itemId,action:'copy',value:null}]);
  expect(result.saved.skills).toHaveLength(2);
  expect(result.saved.files.map(file=>file.text)).toEqual([{kind:'inline',value:'移除后的新指引'},{kind:'inline',value:'移除后的新指引'}]);
  const fields=result.details!.fields;
  expect(fields.filter(field=>field.label==='修改目标 · 文件位置').map(field=>field.text)).toEqual(['第 2 项']);
  expect(fields.filter(field=>field.label==='修改目标 · 所属技能位置').map(field=>field.text)).toEqual(['第 2 项']);
  expect(fields.filter(field=>field.label==='技能位置').map(field=>field.text)).toEqual(['第 3 项']);
});

it('distinguishes saved empty text from literal text describing an empty value',async()=>{
  const c=fixture(),rule={...identity(),purpose:'work' as const,text:{kind:'inline' as const,value:'原规则'}};c.rules=[rule];
  const edit=(value:string)=>propose(c,[{itemId:rule.itemId,action:'edit',value:{purpose:'work',text:{kind:'inline',value}}}]);
  const empty=await edit(''),literal=await edit('空文本 · 0 字符');
  expect(empty.saved.rules[0]!.text).toEqual({kind:'inline',value:''});
  expect(literal.saved.rules[0]!.text).toEqual({kind:'inline',value:'空文本 · 0 字符'});
  expect(empty.card).not.toEqual(literal.card);
  const elements=JSON.parse(JSON.stringify(empty.card)).body.elements;
  expect(elements).toContainEqual({tag:'markdown',content:'**空文本 · 0 字符**'});
  expect(elements).not.toContainEqual({tag:'div',text:{tag:'plain_text',content:''}});
});

it('distinguishes default completion text from the literal text 无 in the saved setting',async()=>{
  const c=fixture(),setting={...identity(),field:'presentation.completionTemplate' as const,value:'旧通知'};c.settings=[setting];
  const edit=(value:string|null)=>propose(c,[{itemId:setting.itemId,action:'edit',value:{field:setting.field,value}}]);
  const defaults=await edit(null),literal=await edit('无');
  const render=(result:Awaited<ReturnType<typeof edit>>)=>{
    const setting=result.saved.settings[0];if(setting?.field!=='presentation.completionTemplate')throw new Error('missing template');
    return renderCompletionTemplate(setting.value,{task:'周报',elapsed:'1秒',status:'完成',icon:'好',durationLabel:'用时',detail:'结果在上方卡片。'});
  };
  expect(render(defaults)).toContain('周报');expect(render(literal)).toBe('无');
  expect(defaults.card).not.toEqual(literal.card);
  expect(defaults.visible).toContain('使用默认');expect(literal.visible).toContain('自定义文案');
});

it('keeps task names and actual instructions in separate visible card elements',async()=>{
  const c=fixture(),task={...identity(),name:'晨报',instruction:{kind:'inline' as const,value:'旧说明'},spec:{kind:'daily' as const,time:'09:00'},timeZone:{kind:'targetChoice' as const},placement:'follow' as const};c.tasks=[task];
  const edit=(name:string,instruction:string)=>propose(c,[{itemId:task.itemId,action:'edit',value:{name,instruction:{kind:'inline',value:instruction},spec:task.spec,timeZone:task.timeZone,placement:task.placement}}]);
  const first=await edit('晨报\n任务说明 → 备注','执行'),second=await edit('晨报','备注\n任务说明 → 执行');
  expect(first.saved.tasks[0]!.instruction).not.toEqual(second.saved.tasks[0]!.instruction);
  expect(first.card).not.toEqual(second.card);
  for(const result of [first,second]){
    const elements=JSON.parse(JSON.stringify(result.card)).body.elements;
    expect(elements).toContainEqual({tag:'div',text:{tag:'plain_text',content:result.saved.tasks[0]!.name}});
    expect(elements).toContainEqual({tag:'div',text:{tag:'plain_text',content:result.saved.tasks[0]!.instruction.kind==='inline'?result.saved.tasks[0]!.instruction.value:''}});
  }
});

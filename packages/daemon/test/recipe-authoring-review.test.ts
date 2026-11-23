import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,recipeAuthoringRequestSchema,type RecipeRichContent} from '@vonvon/protocol';
import {candidateConfirmation,authoringCard} from '../src/recipe/authoring-im';
import {preparedRich,richCardReview,richReviewDigest,type RichLocalDraft} from '../src/recipe/authoring-rich-flow';
import {itemsOf} from '../src/recipe/authoring-rich-snapshot';

const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
function content():RecipeRichContent {
  const field=(value:string)=>({...identity(),value});
  const file={...identity(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'x'.repeat(65536)}};
  return {format:'rich-v2',schemaVersion:2,public:{name:field(''),summary:field(''),overview:field(''),version:field('')},
    role:{...identity(),text:{kind:'inline',value:'负责整理反馈\n保留事实'}},skills:[{...identity(),name:'整理反馈',entryFileId:file.itemId,fileIds:[file.itemId]}],files:[file],settings:[],rules:[],tasks:[],memories:[],setup:[],parts:[]};
}
function capture(c=content()) {
  const selected=itemsOf(c).map(i=>i.itemId),options={skills:[{skill:'整理反馈',files:['SKILL.md']}],includeTasks:false,includeBotMemories:false};
  const inventory={content:c,lease:'a'.repeat(64),files:{},evidence:new Map(itemsOf(c).map(i=>[i.itemId,{kind:'native' as const}]))};
  const req=recipeAuthoringRequestSchema.parse({type:'richPrepare',botId:'cli_reviewtest',session:randomUUID(),groupId:'oc_reviewtest',selection:{options,selected,reviewToken:inventory.lease,sourceAttested:true,public:{name:'',summary:'',overview:'',version:''},access:'direct',setup:[]},attestations:[]});
  if(req.type!=='richPrepare')throw new Error();
  const rich=preparedRich(req,inventory,randomUUID());
  rich.privateSelection=true;
  return rich;
}
const review=(rich:RichLocalDraft)=>richCardReview({view:{operationId:randomUUID()},rich});
const visible=(body:ReturnType<typeof candidateConfirmation>)=>{
  const parsed=JSON.parse(JSON.stringify(body??{}));
  return (parsed.body?.elements??[]).flatMap((e:{text?:{content?:string}})=>e.text?.content?[e.text.content]:[]).join('\n');
};

it('summarizes an unchanged 64KB private capture by actual names while binding every source byte',()=>{
  const rich=capture(),details=review(rich),body=candidateConfirmation('ref',details);
  expect(body).toBeDefined();
  const text=visible(body);
  expect(text).toContain('仅保存私人草稿');expect(text).toContain('完整内容在 App 核对');expect(text).toContain('发布前再次确认');
  expect(text).toContain('整理反馈');expect(text).toContain('SKILL.md');expect(text).toContain('65536');
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{64}|entryFileId|fileIds|JSON/);
  expect(text).not.toContain('x'.repeat(100));
  const before=richReviewDigest(rich);
  if(!rich.request||!('content'in rich.request))throw new Error();
  rich.request.content.files[0]!.text={kind:'inline',value:'changed'.repeat(9000)};
  expect(richReviewDigest(rich)).not.toBe(before);
  expect(candidateConfirmation('ref',review(rich))).toBeUndefined();
});
it('shows model public and role edits as complete human text and keeps long edits closed',()=>{
  const c=content(),canonical=Buffer.from(canonicalizeRichRecipeContent(c).canonicalUTF8).toString('base64url');
  const rich:RichLocalDraft={request:{format:'rich-v2',baseCanonical:canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:randomUUID(),baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes:[
    {op:'setPublicText',itemId:c.public.name.itemId,field:'name',value:'反馈手册'},
    {op:'setRoleText',itemId:c.role!.itemId,value:{kind:'inline',value:'第一行\n第二行'}},
  ]}}};
  const text=visible(candidateConfirmation('ref',review(rich)));
  expect(text).toContain('名称 → 反馈手册');expect(text).toContain('角色 → 第一行\n第二行');
  expect(text).not.toMatch(/setPublicText|setRoleText|itemId|kind|[0-9a-f]{64}/);
  if(!rich.request||'content'in rich.request)throw new Error();
  rich.request.payload.changes=[{op:'setFile',itemId:c.files[0]!.itemId,value:{name:'SKILL.md',text:{kind:'inline',value:'x'.repeat(65536)}}}];
  expect(candidateConfirmation('ref',review(rich))).toBeUndefined();
  expect(JSON.stringify(authoringCard('ref','confirm',review(rich)))).not.toContain('App 直接编辑该字段');
});
it('rejects unknown structures instead of offering opaque JSON for confirmation',()=>{
  const c=content();c.files[0]!.text={kind:'inline',value:'small source'};
  const rich=capture(c);
  if(!rich.request||!('content'in rich.request))throw new Error();
  Object.assign(rich.request.content.role!,{unknown:'unexpected'});
  expect(candidateConfirmation('ref',review(rich))).toBeUndefined();
});
it('distinguishes normal newlines, literal escape text and hidden direction controls',()=>{
  const value='第一行\n字面 \\u202e 和控制 \u202e';
  const text=visible(candidateConfirmation('ref',{draftId:'draft',revision:1,payloadDigest:'a'.repeat(64),fields:[{label:'概览',valueJson:JSON.stringify(value)}]}));
  expect(text).toContain('第一行\n');expect(text).toContain('字面 \\u202e');expect(text).toContain('控制 ⟦U+202E⟧');
  expect(text).not.toContain('\u202e');
});

it('does not summarize model edits merely because a creation has no draft id',()=>{
  const c=content();c.files[0]!.text={kind:'inline',value:'完整技能说明\n第二行'};
  const rich=capture(c);
  if(!rich.request||!('content'in rich.request))throw new Error();
  rich.request.content.public.name.value='反馈手册';rich.newFields=[c.public.name.itemId];
  const details=review(rich),body=candidateConfirmation('ref',details),text=visible(body);
  expect(body).toBeDefined();expect(details?.sourceCapture).toBeUndefined();
  expect(text).toContain('名称 → 反馈手册');expect(text).toContain('完整技能说明\n第二行');
  expect(text).toContain('负责整理反馈\n保留事实');expect(text).not.toContain('本次保存你刚选中的本地内容快照');
  expect(candidateConfirmation('ref',details)).toEqual(body);
  rich.newFields=[];
  expect(review(rich)?.sourceCapture).toBeUndefined();
});

it('shows the exact skill and file names and all changed file bytes without internal references',()=>{
  const c=content(),canonical=Buffer.from(canonicalizeRichRecipeContent(c).canonicalUTF8).toString('base64url');
  const rich:RichLocalDraft={request:{format:'rich-v2',baseCanonical:canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:randomUUID(),baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes:[
    {op:'setSkill',itemId:c.skills[0]!.itemId,value:{name:'收集反馈'}},
    {op:'setFile',itemId:c.files[0]!.itemId,value:{name:'docs/feedback.md',text:{kind:'inline',value:'# 收集反馈\n逐项核对。'}}},
  ]}}};
  const body=candidateConfirmation('ref',review(rich)),text=visible(body);
  expect(body).toBeDefined();expect(text).toContain('技能“整理反馈”名称 → 收集反馈');expect(text).toContain('文件“SKILL.md”');
  expect(text).toContain('docs/feedback.md');expect(text).toContain('# 收集反馈\n逐项核对。');expect(text).not.toContain('itemId');
  for(const item of itemsOf(c))expect(text).not.toContain(item.itemId);
});

it('rejects an unknown model operation and unavailable content instead of guessing',()=>{
  const c=content(),canonical=Buffer.from(canonicalizeRichRecipeContent(c).canonicalUTF8).toString('base64url');
  const rich:RichLocalDraft={request:{format:'rich-v2',baseCanonical:canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:randomUUID(),baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes:[
    {op:'setRoleText',itemId:c.role!.itemId,value:{kind:'part',objectId:randomUUID()}},
  ]}}};
  expect(candidateConfirmation('ref',review(rich))).toBeUndefined();
  if(!rich.request||'content'in rich.request)throw new Error();
  Object.assign(rich.request.payload.changes[0]!,{op:'unknownOperation'});
  expect(candidateConfirmation('ref',review(rich))).toBeUndefined();
});

it('keeps a literal hidden-character marker distinct from an actual hidden character',()=>{
  const text=visible(candidateConfirmation('ref',{draftId:'draft',revision:1,payloadDigest:'a'.repeat(64),fields:[{label:'概览',valueJson:JSON.stringify('字面 ⟦U+202E⟧ 控制 \u202e')}]}));
  expect(text).toContain('字面 ⟦U+27E6⟧U+202E⟦U+27E7⟧ 控制 ⟦U+202E⟧');
});

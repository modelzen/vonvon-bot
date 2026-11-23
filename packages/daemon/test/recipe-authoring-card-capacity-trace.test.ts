import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,recipeAuthoringRequestSchema,type RecipeRichContent,type RecipeRichDraftChange} from '@vonvon/protocol';
import {applyChanges} from '../../../services/recipe-api/src/rich-document.mjs';
import {candidateConfirmation} from '../src/recipe/authoring-im';
import {chatRichProposal,preparedRich,richCardReview,richReviewDigest,typedRichEdit,type RichLocalDraft} from '../src/recipe/authoring-rich-flow';
import {itemsOf} from '../src/recipe/authoring-rich-snapshot';
import {AuthoringJournal,discardAuthoringMaterial,newCarrier,type LocalOperation} from '../src/recipe/authoring-journal';

const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
const canonical=(content:RecipeRichContent)=>Buffer.from(canonicalizeRichRecipeContent(content).canonicalUTF8).toString('base64url');
function fixture(count=1):RecipeRichContent {
  const field=(value:string)=>({...identity(),value});
  const files=Array.from({length:count},(_,i)=>({...identity(),name:i?'ref-'+i+'.md':'SKILL.md',
    use:i?'reference' as const:'skillDescription' as const,text:{kind:'inline' as const,value:'x'}}));
  return {format:'rich-v2',schemaVersion:2,public:{name:field(''),summary:field(''),overview:field(''),version:field('')},
    skills:[{...identity(),name:'整理反馈',entryFileId:files[0]!.itemId,fileIds:files.map(file=>file.itemId)}],files,
    settings:[],rules:[],tasks:[],memories:[],setup:[],parts:[]};
}
function display(content:RecipeRichContent){
  const blocks=['执行耗时','执行状态'].map((name,index)=>({...identity(),id:'internal-block-'+index,
    kind:index?'status' as const:'time' as const,name,slot:index?'bottom-left' as const:'process' as const,
    mode:index?'running' as const:'always' as const,appearance:'text' as const,
    template:index?'{{status.label}}':'{{elapsed.value}}',size:'normal' as const,color:'auto' as const,warning:false,warningAt:80}));
  const setting={...identity(),field:'presentation.cardDisplay' as const,value:{version:1 as const,blocks,reply:{streamText:true,collapseAfterRun:false}}};
  content.settings=[setting];
  return setting;
}
function capture(content:RecipeRichContent,selected=itemsOf(content).map(item=>item.itemId),logo?:string){
  const options={skills:content.skills.map(skill=>({skill:skill.name,files:content.files.filter(file=>skill.fileIds.includes(file.itemId)).map(file=>file.name)})),
    includeTasks:false,includeBotMemories:false};
  const inventory={content,lease:'a'.repeat(64),files:{},evidence:new Map(itemsOf(content).map(item=>[item.itemId,{kind:'native' as const}]))};
  const request=recipeAuthoringRequestSchema.parse({type:'richPrepare',botId:'cli_reviewtest',session:randomUUID(),groupId:'oc_reviewtest',
    selection:{options,selected,...(logo&&{logo}),reviewToken:inventory.lease,sourceAttested:true,public:{name:'',summary:'',overview:'',version:''},access:'direct',setup:[]},attestations:[]});
  if(request.type!=='richPrepare')throw new Error('missing preparation');
  const rich=preparedRich(request,inventory,randomUUID());rich.privateSelection=true;
  return rich;
}
const review=(rich:RichLocalDraft)=>richCardReview({view:{operationId:'fixed-operation'},rich});
function tags(value:unknown):number {
  if(!value||typeof value!=='object')return 0;
  if(Array.isArray(value))return value.reduce((sum,item)=>sum+tags(item),0);
  return ('tag'in value&&typeof value.tag==='string'?1:0)+Object.values(value).reduce<number>((sum,item)=>sum+tags(item),0);
}
const visible=(card:ReturnType<typeof candidateConfirmation>):string=>{
  const parsed=JSON.parse(JSON.stringify(card));
  return parsed.body.elements.flatMap((element:{content?:string;text?:{content:string}})=>element.text?[element.text.content]:element.content?[element.content]:[]).join('\n');
};

it('fits all 64 selected source files within the actual recursive CardKit element budget',()=>{
  const content=fixture(64),card=candidateConfirmation('fixed-ref',review(capture(content)));
  expect(card).toBeDefined();expect(tags(card)).toBeLessThanOrEqual(200);
  for(const file of content.files)expect(visible(card)).toContain(file.name);
  const fields=Array.from({length:64},()=>({label:'概览',text:'完整新值',valueJson:JSON.stringify('完整新值'),separate:true as const}));
  expect(candidateConfirmation('fixed-ref',{draftId:'draft',revision:1,payloadDigest:'a'.repeat(64),fields})).toBeUndefined();
});

it('keeps exactly 200 recursive tags and 30000 serialized envelope bytes confirmable',()=>{
  const fields=Array.from({length:63},()=>({label:'概览',text:'完整新值',valueJson:JSON.stringify('完整新值'),separate:true as const}));
  const details={draftId:'draft',revision:1,payloadDigest:'a'.repeat(64),fields:[...fields,{label:'版本',text:'1',valueJson:'"1"'}]};
  const card=candidateConfirmation('fixed-ref',details);expect(card).toBeDefined();expect(tags(card)).toBe(200);
  const detail=(text:string)=>({...details,fields:[{label:'概览',text,valueJson:JSON.stringify(text),separate:true as const}]});
  const envelopeBytes=(body:ReturnType<typeof candidateConfirmation>)=>Buffer.byteLength(JSON.stringify({sequence:Number.MAX_SAFE_INTEGER,
    uuid:'a_'+Number.MAX_SAFE_INTEGER+'_fixed-ref',card:{type:'card_json',data:JSON.stringify(body)}}));
  const limit=30000-envelopeBytes(candidateConfirmation('fixed-ref',detail('x')))+1;
  const exact=candidateConfirmation('fixed-ref',detail('x'.repeat(limit)));expect(exact).toBeDefined();expect(envelopeBytes(exact)).toBe(30000);
  expect(candidateConfirmation('fixed-ref',detail('x'.repeat(limit+1)))).toBeUndefined();
});

it('keeps source list names bounded when names contain line breaks and literal quotes',()=>{
  const content=fixture(2);content.skills[0]!.name='整理\n名称 → "反馈"';content.files[1]!.name='参考 (甲).md';
  const card=candidateConfirmation('fixed-ref',review(capture(content)));expect(card).toBeDefined();
  expect(visible(card)).toContain('名称 → '+JSON.stringify(content.skills[0]!.name));
  expect(visible(card)).toContain('文件 2 → '+JSON.stringify(content.files[1]!.name)+' · 1 字节');
});

it('hides generated block ids in both restored setting and single-block confirmation projections',()=>{
  const source=fixture(),setting=display(source),block=setting.value.blocks[0]!,sourceIntentId=randomUUID();
  setting.value.blocks=[block];
  for(const kind of ['setting','cardBlock'] as const){
    const base=structuredClone(source);
    if(kind==='setting')base.settings=[];
    else if(base.settings[0]?.field==='presentation.cardDisplay'&&base.settings[0].value)base.settings[0].value.blocks=[];
    const sourceRef={sourceIntentId,candidateId:kind==='setting'?setting.itemId:block.itemId,expectedRevision:1};
    const change:RecipeRichDraftChange=kind==='setting'?{op:'includeCandidate',value:{kind,source:sourceRef}}:
      {op:'includeCandidate',value:{kind,source:sourceRef,parentItemId:setting.itemId}};
    const request={format:'rich-v2' as const,baseCanonical:canonical(base),candidates:[{sourceIntentId,canonical:canonical(source)}],
      payload:{format:'rich-v2' as const,purpose:'editDraft' as const,draftId:randomUUID(),baseRevision:1,requestId:randomUUID(),schemaVersion:2 as const,changes:[change]}};
    const resolve=()=>({content:source,itemId:kind==='setting'?setting.itemId:block.itemId});
    const saved=(seed:Uint8Array)=>applyChanges(base,[change],resolve,seed).doc.content.settings.flatMap(setting=>setting.field==='presentation.cardDisplay'&&setting.value?setting.value.blocks:[])[0]!;
    const previewBlock=saved(Buffer.alloc(32)),actualBlock=saved(Buffer.from(randomUUID()));
    expect(previewBlock.id).not.toBe(actualBlock.id);
    const card=candidateConfirmation('fixed-ref',review({request}));expect(card).toBeDefined();
    const text=visible(card);expect(text).toContain(block.name);expect(text).toContain('执行过程');expect(text).toContain(block.template);
    expect(text).not.toContain('显示项标识');expect(text).not.toContain(previewBlock.id);expect(text).not.toContain(actualBlock.id);
  }
});

it('shows selected block names and count and whether reply display is included in a source capture',()=>{
  const content=fixture(),setting=display(content),first=setting.value.blocks[0]!,second=setting.value.blocks[1]!;
  const one=candidateConfirmation('fixed-ref',review(capture(content,itemsOf(content).filter(item=>item.itemId!==second.itemId).map(item=>item.itemId))));
  const both=candidateConfirmation('fixed-ref',review(capture(content)));
  expect(one).toBeDefined();expect(both).toBeDefined();expect(one).not.toEqual(both);
  expect(visible(one)).toContain(first.name);expect(visible(one)).not.toContain(second.name);
  expect(visible(both)).toContain(first.name);expect(visible(both)).toContain(second.name);
  expect(visible(one)).toContain('显示项数量 → 1');expect(visible(both)).toContain('显示项数量 → 2');
  expect(visible(one)).toContain('回复显示 → 已包含');
  const withoutReply=structuredClone(content);
  if(withoutReply.settings[0]?.field==='presentation.cardDisplay'&&withoutReply.settings[0].value)delete withoutReply.settings[0].value.reply;
  const noReply=candidateConfirmation('fixed-ref',review(capture(withoutReply)));
  expect(visible(noReply)).toContain('回复显示 → 未包含');
});

it('previews a valid whole-batch file path swap while retaining each complete changed value',async()=>{
  const content=fixture(3),first=content.files[1]!,second=content.files[2]!;
  first.name='a.md';second.name='b.md';first.text={kind:'inline',value:'甲\n**正文**'};second.text={kind:'inline',value:'乙\n<at id=all></at>'};
  const request=recipeAuthoringRequestSchema.parse({type:'richEdit',botId:'cli_reviewtest',session:randomUUID(),draftId:randomUUID(),baseRevision:1,
    canonical:canonical(content),selected:[first.itemId,second.itemId]});
  if(request.type!=='richEdit')throw new Error('missing edit');
  const rich=typedRichEdit(request),view={operationId:randomUUID(),draftId:request.draftId,baseRevision:1,state:'candidate' as const,purpose:'editDraft' as const,
    targetPublicKey:Buffer.alloc(32).toString('base64url'),nonceCommitment:Buffer.alloc(32).toString('base64url'),deliveryUnknown:false,createdAt:1};
  const operation:LocalOperation={rich,view,accountId:randomUUID(),scope:'review',bot:'review',binding:'review',
    recipient:{openId:'review',chatId:'oc_reviewtest',tenantKey:'review'},carrier:newCarrier('confirm'),dispatched:false};
  const result=await chatRichProposal(operation,'交换两个路径并保留正文',new AbortController().signal,{proposeRich:async()=>({kind:'proposal',commands:[
    {action:'edit',target:'T1',valueJson:JSON.stringify({name:second.name,text:first.text})},
    {action:'edit',target:'T2',valueJson:JSON.stringify({name:first.name,text:second.text})},
  ]})});
  if(result.kind!=='proposal'||'content'in result.request)throw new Error('missing proposal');
  const saved=applyChanges(content,result.request.payload.changes,()=>{throw new Error('unexpected source');},Buffer.alloc(32)).doc.content;
  expect(saved.files.slice(1).map(file=>file.name)).toEqual(['b.md','a.md']);
  const card=candidateConfirmation('fixed-ref',richCardReview({rich:{...rich,request:result.request},view}));expect(card).toBeDefined();
  const elements=JSON.parse(JSON.stringify(card)).body.elements;
  for(const file of saved.files.slice(1)){
    expect(elements).toContainEqual({tag:'div',text:{tag:'plain_text',content:file.name}});
    expect(elements).toContainEqual({tag:'div',text:{tag:'plain_text',content:file.text.kind==='inline'?file.text.value:''}});
  }
});

it('proves cumulative source omissions and public edits while retaining the initial snapshot',async()=>{
  const content=fixture(2);content.role={...identity(),text:{kind:'inline',value:'original role'}};
  const setting=display(content),rich=capture(content),initial=structuredClone(rich);
  const op={view:{operationId:randomUUID()},rich} as LocalOperation;
  const apply=async(instruction:string,kind?:'role'|'skill'|'cardBlock')=>{
    const result=await chatRichProposal(op,instruction,new AbortController().signal,kind?{proposeRich:async input=>({kind:'proposal',commands:[
      {action:'omit',target:'T'+(input.selected.findIndex(item=>item.kind===kind)+1),valueJson:'null'},
    ]})}:undefined);
    if(result.kind!=='proposal')throw Error('missing proposal');
    rich.request=result.request;
    if('newFields'in result)rich.newFields=result.newFields;
    if(result.sourcePublicValues)rich.sourcePublicValues=result.sourcePublicValues;
    if('richSourceOriginal'in result){op.richSourceOriginal=result.richSourceOriginal;rich.sourceOmitted=result.sourceOmitted;}
    if(rich.request&&'content'in rich.request){const kept=new Set(rich.request.content.files.map(f=>f.itemId));rich.members=rich.members?.filter(m=>m.kind==='finalLogo'||kept.has(m.itemId));}
    expect(richCardReview(op)?.sourceCapture).toBe(true);
    expect(candidateConfirmation('ref',richCardReview(op))).toBeDefined();
  };
  await apply('/recipe version 2.0');await apply('排除角色','role');
  const original=structuredClone(op.richSourceOriginal);
  await apply('/recipe version 3.0');await apply('排除消息展示第一项','cardBlock');
  await apply('排除技能','skill');await apply('/recipe summary 新简介');
  expect(op.richSourceOriginal).toEqual(original);
  expect(initial.request&&'content'in initial.request&&initial.request.content.role?.text).toEqual(content.role.text);
  expect(initial.request&&'content'in initial.request&&initial.request.content.skills).toHaveLength(1);
  expect(rich.sourceOmitted).toEqual([content.role.itemId,setting.value.blocks[0]!.itemId,content.skills[0]!.itemId]);
  const card=JSON.stringify(candidateConfirmation('ref',richCardReview(op)));
  expect(card).toContain('本次排除');expect(card).toContain('整理反馈');expect(card).toContain('SKILL.md');expect(card).toContain('执行耗时');
  const mutations:((bad:RichLocalDraft)=>void)[]=[
    bad=>{delete bad.sourceCaptureDigest;},bad=>{delete bad.privateSelection;},
    bad=>{bad.sourceOmitted!.push(randomUUID());},bad=>{bad.sourceOmitted!.push(content.public.name.itemId);},
    bad=>{bad.newFields!.push(randomUUID());},
    bad=>{if(bad.request&&'content'in bad.request)bad.request.sourceVersionId=randomUUID();},
    bad=>{if(bad.request&&'content'in bad.request)bad.request.access='coded';},
    bad=>{if(bad.request&&'content'in bad.request)bad.request.content.role=content.role;},
    bad=>{if(bad.request&&'content'in bad.request)bad.request.content.skills=content.skills;},
    bad=>{if(bad.request&&'content'in bad.request)Object.assign(bad.request.content.public.name,{unknown:'hidden'});},
    bad=>{if(bad.request&&'content'in bad.request)bad.request.content.public.name.value='unauthorized';},
    bad=>{if(bad.request&&'content'in bad.request)bad.request.origins[0]!.source={kind:'releaseItem',versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'a'.repeat(64)};},
    bad=>{if(bad.request&&'content'in bad.request&&bad.request.content.settings[0]?.field==='presentation.cardDisplay'&&bad.request.content.settings[0].value)bad.request.content.settings[0].value.reply!.streamText=false;},
  ];
  expect(richCardReview({...op,richSourceOriginal:undefined})).toBeUndefined();
  const forged=structuredClone(op.richSourceOriginal!);
  if(forged.request&&'content'in forged.request)forged.request.content.public.name.value='forged snapshot';
  expect(richCardReview({...op,richSourceOriginal:forged})).toBeUndefined();
  for(const mutate of mutations){const bad=structuredClone(rich);mutate(bad);expect(richCardReview({...op,rich:bad})).toBeUndefined();}
});

it('persists the largest content and source Logo input with the omission proof in a separate verified blob',async()=>{
  const content=fixture(8);content.role={...identity(),text:{kind:'inline',value:'role'}};
  const overhead=canonicalizeRichRecipeContent(content).canonicalUTF8.length;
  for(const file of content.files.slice(0,7))file.text={kind:'inline',value:'x'.repeat(131072)};
  content.files[7]!.text={kind:'inline',value:'x'.repeat(1048576-overhead-7*131072+8)};
  expect(canonicalizeRichRecipeContent(content).canonicalUTF8.length).toBe(1048576);
  const logo=Buffer.alloc(2097152);logo.write('RIFF');logo.writeUInt32LE(logo.length-8,4);logo.write('WEBPVP8L',8);logo.writeUInt32LE(logo.length-20,16);
  const rich=capture(content,itemsOf(content).map(item=>item.itemId),logo.toString('base64url'));
  const op={view:{operationId:randomUUID(),createdAt:1000,state:'candidate'},rich} as LocalOperation;
  const result=await chatRichProposal(op,'排除角色',new AbortController().signal,{proposeRich:async input=>({kind:'proposal',commands:[
    {action:'omit',target:'T'+(input.selected.findIndex(item=>item.kind==='role')+1),valueJson:'null'},
  ]})});
  if(result.kind!=='proposal'||!('richSourceOriginal'in result))throw Error('missing proof');
  rich.request=result.request;rich.newFields=result.newFields;rich.sourcePublicValues=result.sourcePublicValues;rich.sourceOmitted=result.sourceOmitted;
  op.richSourceOriginal=result.richSourceOriginal;
  for(const kind of ['text','finalLogo']){
    const changed=structuredClone(rich),member=changed.members!.find(m=>m.kind===kind)!;
    const bytes=Buffer.from(member.bytes,'base64url');bytes.writeUInt8(bytes.readUInt8(bytes.length-1)^1,bytes.length-1);
    member.bytes=bytes.toString('base64url');member.sha256=createHash('sha256').update(bytes).digest('hex');
    expect(richCardReview({...op,rich:changed})).toBeUndefined();
  }
  const originalDigest=richReviewDigest(op.richSourceOriginal!);
  const root=await realpath(await mkdtemp(join(tmpdir(),'recipe-omit-blob-'))),journal=new AuthoringJournal(root,()=>1000);
  await journal.run(db=>{db.operations[op.view.operationId]=op;});
  const disk=JSON.parse(await readFile(join(root,'recipe-authoring/journal.json'),'utf8')).operations[op.view.operationId];
  expect(disk.richSourceOriginalBlob).toMatch(/^[a-f0-9]{64}$/);expect(disk.richBlob).not.toBe(disk.richSourceOriginalBlob);
  for(const hash of [disk.richBlob,disk.richSourceOriginalBlob])expect((await stat(join(root,'recipe-authoring/rich-'+hash+'.json'))).size).toBeLessThan(12*1024*1024);
  await journal.run(db=>{
    const restored=db.operations[op.view.operationId]!;
    expect(richCardReview(restored)?.sourceCapture).toBe(true);expect(richReviewDigest(restored.richSourceOriginal!)).toBe(originalDigest);
    expect(restored.rich!.members!.find(m=>m.kind==='finalLogo')!.bytes).toBe(logo.toString('base64url'));
  });
  await journal.run(db=>{discardAuthoringMaterial(db.operations[op.view.operationId]!);});
  await expect(stat(join(root,'recipe-authoring/rich-'+disk.richSourceOriginalBlob+'.json'))).rejects.toMatchObject({code:'ENOENT'});
});

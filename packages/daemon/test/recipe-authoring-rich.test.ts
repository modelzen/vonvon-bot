import {createHash,randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {canonicalizeRichRecipeContent,type RecipeRichContent} from '@vonvon/protocol';
import {itemsOf,selectRichSnapshot,wireDigest,wireJson,type SourceEvidence} from '../src/recipe/authoring-rich-snapshot';
import {verifyFrozenRich} from '../src/recipe/authoring-rich-proof';
import {checkedRichInput,proposeRich} from '../src/recipe/authoring-rich-model';

const id=()=>({itemId:randomUUID(),originId:randomUUID()});
function fixture():RecipeRichContent {
  const field=(value:string)=>({...id(),value});
  return {format:'rich-v2',schemaVersion:2,public:{name:field('测试'),summary:field('摘要'),overview:field(''),version:field('1')},
    settings:[],skills:[],files:[],tasks:[],memories:[{...id(),text:{kind:'inline',value:'仅本地'}}],rules:[],
    setup:[{...id(),kind:'config',title:'设置模型',instructions:'选择模型',action:{kind:'nativeSettings',entry:'model'},required:true}],parts:[]};
}
function source(content:RecipeRichContent){
  return {inventory:content,selected:content.setup.map(x=>x.itemId),account:randomUUID(),attested:new Map(),ownershipClaim:true,
    access:'direct' as const,evidence:new Map<string,SourceEvidence>(itemsOf(content).map(i=>[i.itemId,{kind:'native'}]))};
}
describe('explicit rich source review',()=>{
  it('requires a matching reached edge, explicit ownership, omits unselected memory',()=>{
    const c=fixture(),options=source(c),item=c.setup[0]!,edge={versionId:randomUUID(),itemId:randomUUID(),baselineSha256:wireDigest(item)};
    expect(selectRichSnapshot(options).content.memories).toHaveLength(0);
    expect(()=>selectRichSnapshot({...options,ownershipClaim:false})).toThrow();
    options.evidence.set(item.itemId,{kind:'managed',parents:[edge]});
    expect(()=>selectRichSnapshot(options)).toThrow();
    options.attested.set(edge.versionId+':'+edge.itemId,{...edge,authorId:randomUUID(),access:'coded'});
    expect(()=>selectRichSnapshot(options)).toThrow();
    options.attested.set(edge.versionId+':'+edge.itemId,{...edge,authorId:options.account,access:'coded'});
    expect(selectRichSnapshot(options).origins.at(-1)?.source).toEqual({kind:'releaseItem',...edge});
  });
  it('validates actual frozen remapped values and original source review independently',()=>{
    const reviewed=selectRichSnapshot(source(fixture())),op=randomUUID(),dest=randomUUID();
    const content=structuredClone(reviewed.content);
    for(const item of itemsOf(content))Object.assign(item,id());
    const response=()=>{
      const doc=canonicalizeRichRecipeContent(content),payload=wireJson({purpose:'prepareDraft',format:'rich-v2',content,sourceIntentId:op});
      const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
      return {format:'rich-v2',canonical:Buffer.from(doc.canonical).toString('base64url'),contentSha256:sha(doc.canonical),logicalBytes:doc.logicalBytes,
       payload:Buffer.from(payload).toString('base64url'),payloadDigest:sha(payload),sourceReviewSha256:wireDigest(reviewed),destinationDraftId:dest};
    };
    expect(verifyFrozenRich(op,dest,reviewed,response()).destinationDraftId).toBe(dest);
    expect(()=>verifyFrozenRich(op,dest,{...reviewed,access:'coded'},response())).toThrow();
    content.setup[0]!.instructions='未核对的修改';
    expect(()=>verifyFrozenRich(op,dest,reviewed,response())).toThrow();
  });
  it('treats setup as a normal selected skill and rejects structured setup suggestions',async()=>{
    const item={...id(),name:'setup'}, input={phase:'edit' as const,instruction:'把技能名称保持为 setup',selected:[{kind:'skill' as const,itemId:item.itemId,value:{name:'setup'}}]};
    expect(JSON.stringify(checkedRichInput(input))).not.toContain(item.itemId);
    const parser={proposeRich:vi.fn().mockResolvedValue({kind:'proposal',commands:[{action:'edit',target:'T1',valueJson:JSON.stringify({name:'setup'})}]})};
    const answer=await proposeRich(input,new AbortController().signal,parser);
    expect(answer.kind==='proposal' && answer.changes[0]).toMatchObject({op:'setSkill',itemId:item.itemId,value:{name:'setup'}});
    parser.proposeRich.mockResolvedValue({kind:'proposal',commands:[{action:'addSetup',target:'',valueJson:'{}'}]});
    await expect(proposeRich(input,new AbortController().signal,parser)).rejects.toThrow();
    parser.proposeRich.mockResolvedValue({kind:'proposal',commands:[{action:'remove',target:'T2',valueJson:'null'}]});
    await expect(proposeRich(input,new AbortController().signal,parser)).rejects.toThrow();
  });
});

it('derives the exact selected text-package digest and verifies each broker receipt before binding the independent freeze',async()=>{
  const {bindRichMembers,richMemberCap,richReviewDigest}=await import('../src/recipe/authoring-rich-flow');
  const doc=fixture(),f={...id(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'# 整理资料'}};
  const skill={...id(),name:'整理',entryFileId:f.itemId,fileIds:[f.itemId]};
  doc.skills=[skill];doc.files=[f];
  const options=source(doc);
  options.selected.push(f.itemId,skill.itemId);
  const request=selectRichSnapshot(options),bytes=Buffer.from(f.text.value);
  const sha256=createHash('sha256').update(bytes).digest('hex'), member={itemId:f.itemId,kind:'text' as const,bytes:bytes.toString('base64url'),sha256};
  const local={request,members:[member]};
  const descriptor={objectId:randomUUID(),kind:'text' as const,bytes:bytes.length,sha256,mediaType:'text/plain;charset=utf-8' as const};
  expect(()=>bindRichMembers(local,[{...descriptor,sha256:'0'.repeat(64)}],randomUUID())).toThrow();
  const bound=bindRichMembers(local,[descriptor],randomUUID());
  if(!('content' in bound))throw new Error();
  expect(bound.content.files[0]!.text).toEqual({kind:'part',objectId:descriptor.objectId});
  expect(richMemberCap(local)).toBeGreaterThanOrEqual(2*Buffer.byteLength(wireJson(bound.content))+bytes.length);
  expect(richReviewDigest(local)).not.toBe(wireDigest(bound));
});

it('edits an overview with setup instructions without manufacturing structured steps',async()=>{
  const {chatRichProposal}=await import('../src/recipe/authoring-rich-flow');
  const c=fixture(),selected=c.public.overview.itemId,draftId=randomUUID();
  const canonical=Buffer.from(canonicalizeRichRecipeContent(c).canonicalUTF8).toString('base64url');
  const value='使用前请让 Bot 运行 setup 技能。';
  const parser={proposeRich:vi.fn().mockResolvedValue({kind:'proposal',commands:[{action:'edit',target:'T1',valueJson:JSON.stringify(value)}]})};
  const operation={view:{draftId,baseRevision:3},rich:{base:{canonical,selected:[selected,c.setup[0]!.itemId]}}};
  const result=await chatRichProposal(operation as Parameters<typeof chatRichProposal>[0],'把概览改为：'+value,new AbortController().signal,parser);
  expect(result.kind==='proposal'&&'payload' in result.request&&result.request.payload.changes).toEqual([{op:'setPublicText',field:'overview',itemId:selected,value}]);
  expect(parser.proposeRich.mock.calls[0]?.[0].selected).not.toEqual(expect.arrayContaining([expect.objectContaining({kind:'setup'})]));
});

it('rejects every creation path for structured steps while preserving their historical confirmation text',async()=>{
  const {typedRichEdit,richCardReview,richEditTargets}=await import('../src/recipe/authoring-rich-flow');
  const content=fixture(),canonical=Buffer.from(canonicalizeRichRecipeContent(content).canonicalUTF8).toString('base64url');
  const step=content.setup[0]!,{itemId:_item,originId:_origin,...value}=step;
  const sourceIntentId=randomUUID(),req={type:'richEdit' as const,draftId:randomUUID(),baseRevision:1,canonical,selected:[content.public.name.itemId],source:{sourceIntentId,canonical}};
  for(const change of [{op:'addSetup',value,source:{kind:'accountClaim'}},{op:'setSetup',itemId:step.itemId,value},
    {op:'copyItem',source:{kind:'setup',itemId:step.itemId}},
    {op:'includeCandidate',value:{kind:'setup',source:{sourceIntentId,candidateId:step.itemId,expectedRevision:1}}}]){
    expect(()=>typedRichEdit({...req,changes:[change]} as Parameters<typeof typedRichEdit>[0])).toThrow('普通技能');
  }
  expect(richEditTargets(content,[content.public.name.itemId,step.itemId])).toHaveLength(1);
  expect(()=>richEditTargets(content,[content.public.name.itemId,randomUUID()])).toThrow('不存在');
  const request=selectRichSnapshot(source(content));
  const review=richCardReview({view:{operationId:sourceIntentId},rich:{request,newFields:[content.public.name.itemId]}} as Parameters<typeof richCardReview>[0]);
  expect(JSON.parse(review!.fields.find(field=>field.label==='旧补充说明')!.valueJson)).toEqual(value);
});

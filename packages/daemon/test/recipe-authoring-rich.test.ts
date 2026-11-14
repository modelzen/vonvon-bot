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
  it('bounds model inputs, verifies typed selected references and treats setup suggestions only as data',async()=>{
    const item=fixture().setup[0]!, input={phase:'create' as const,instruction:'请建议一个准备步骤',selected:[{kind:'setup' as const,itemId:item.itemId,value:item.title}]};
    expect(JSON.stringify(checkedRichInput(input))).not.toContain(item.itemId);
    const parser={proposeRich:vi.fn().mockResolvedValue({kind:'proposal',commands:[{action:'addSetup',target:'',
      valueJson:JSON.stringify({kind:'tool',title:'检查工具',instructions:'请确认工具已安装。',action:{kind:'manual'},required:true})}]})};
    const answer=await proposeRich(input,new AbortController().signal,parser);
    expect(answer.kind==='proposal' && answer.setup[0]?.action.kind).toBe('manual');
    parser.proposeRich.mockResolvedValue({kind:'proposal',commands:[{action:'remove',target:'T2',valueJson:'null'}]});
    await expect(proposeRich(input,new AbortController().signal,parser)).rejects.toThrow();
  });
});

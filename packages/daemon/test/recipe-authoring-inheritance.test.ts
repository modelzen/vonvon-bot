import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {agentIdSchema,groupIdSchema,type InheritedPublication,type RecipeRichContent} from '@vonvon/protocol';
const state=vi.hoisted(()=>({inventory:undefined as unknown}));
vi.mock('../src/recipe/authoring-source',()=>({groupSourceIdentity:async()=> 'identity'}));
vi.mock('../src/recipe/authoring-rich-flow',async load=>({...await load<object>(),readRichSource:async()=>state.inventory}));
import {PrivateHandoffs} from '../src/recipe/authoring-handoff';
import {bindRichMembers,richCardReview,type RichLocalDraft} from '../src/recipe/authoring-rich-flow';
import type {AuthoringJournal,Link} from '../src/recipe/authoring-journal';
import type {PrivateHandoff} from '../src/recipe/authoring-handoff-menu';
import type {AuthoringIm} from '../src/recipe/authoring-im';
function fixture(inherit=true){
 const account=randomUUID(),versionId=randomUUID(),retryId=randomUUID(),groupId=groupIdSchema.parse('oc_inherit');
 const field=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
 const content:RecipeRichContent={format:'rich-v2',schemaVersion:2,public:{name:field(''),summary:field(''),overview:field(''),version:field('')},
   role:{itemId:randomUUID(),originId:randomUUID(),text:{kind:'inline',value:'UNSELECTED ROLE'}},settings:[],skills:[],files:[],tasks:[],memories:[],rules:[],setup:[],parts:[]};
 state.inventory={lease:'a'.repeat(64),content,evidence:new Map(Object.values(content.public).map(item=>[item.itemId,{kind:'native'}]))};
 const logo=Buffer.from('524946460e000000574542505650384c020000002f00','hex').toString('base64url');
 const inherited:InheritedPublication={accountId:account,versionId,public:{name:'本人名称',summary:'本人摘要',overview:'完整介绍',version:''},access:'coded',logo};
 const recipient={openId:'ou_test',chatId:groupId,tenantKey:'tenant'},link:Link={bot:'cli_inherit',binding:'binding',recipient,sources:[]};
 const db={handoffs:{} as Record<string,PrivateHandoff>,links:{link},operations:{}};
 const ledger={run:async(fn:(value:typeof db)=>unknown)=>structuredClone(await fn(db))} as unknown as AuthoringJournal;
 const im={createJson:async()=> 'card',send:async()=> 'message',updateJson:async()=> 'updated'} as unknown as AuthoringIm;
 const native={bot:{appId:'cli_inherit'},channel:{}} as ConstructorParameters<typeof PrivateHandoffs>[0];
 const handoffs=new PrivateHandoffs(native,ledger,im,()=>1000,()=>{}),p={session:randomUUID(),account,scope:'scope'};
 const req={type:'beginHandoff' as const,botId:agentIdSchema.parse('cli_inherit'),session:p.session,retryId,groupId,groupName:'群',...(inherit&&{sourceVersionId:versionId,inherited})};
 return {handoffs,p,link,db,req,inherited,logo,retryId};
}
it('captures inherited snapshot at begin and carries identical metadata, access, parent and uploaded logo through review',async()=>{
 const f=fixture();await f.handoffs.begin(f.p,f.link,f.req);
 let row=f.db.handoffs[f.retryId]!;
 expect(row.inherited).toEqual(f.inherited);
 const resumed={...f.p,session:randomUUID()};await f.handoffs.begin(resumed,f.link,f.req);f.p.session=resumed.session;row=f.db.handoffs[f.retryId]!;
 expect(row.inherited).toEqual(f.inherited);
 const request={retryId:f.retryId,ref:row.ref,generation:row.generation,lease:'a'.repeat(64),versions:[]};row.phase={state:'awaitingAttestations',request};
 let rich:RichLocalDraft|undefined;
 await f.handoffs.answer(f.p,f.link,{type:'answerHandoff',botId:f.req.botId,session:f.p.session,request,attestations:[]},async target=>{
  rich=target.rich;
  return {kind:'operation',operation:{operationId:randomUUID(),purpose:'prepareDraft',targetPublicKey:'a'.repeat(43),nonceCommitment:'a'.repeat(43),state:'waiting',deliveryUnknown:false,createdAt:1000}};
 });
 const prepared=rich!;expect(prepared.request&&'content'in prepared.request&&prepared.request.sourceVersionId).toBe(f.inherited.versionId);
 if(!prepared.request||!('content'in prepared.request))throw Error('missing request');
 expect(Object.fromEntries(Object.entries(prepared.request.content.public).map(([k,v])=>[k,v.value]))).toEqual(f.inherited.public);
 expect(prepared.request.access).toBe('coded');expect(prepared.request.content.role).toBeUndefined();
 expect(prepared.members).toHaveLength(1);expect(prepared.members![0]!.bytes).toBe(f.logo);
 const member=prepared.members![0]!,bytes=Buffer.from(f.logo,'base64url'),packageId=randomUUID();
 const bound=bindRichMembers(prepared,[{objectId:randomUUID(),kind:'finalLogo',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'image/webp'}],packageId);
 expect(bound.logoUpload).toEqual({packageId,inputSha256:member.sha256});
 expect(richCardReview({view:{operationId:randomUUID()},rich:prepared})?.fields.some(field=>field.valueJson?.includes('本人名称'))).toBe(true);
 expect(JSON.stringify(prepared.request)).not.toContain('UNSELECTED ROLE');
});
it('keeps first creation blank and rejects account changes, snapshot drift and legacy missing snapshots',async()=>{
 const fresh=fixture(false);await fresh.handoffs.begin(fresh.p,fresh.link,fresh.req);expect(fresh.db.handoffs[fresh.retryId]!.inherited).toBeUndefined();
 const f=fixture();await f.handoffs.begin(f.p,f.link,f.req);
 await expect(f.handoffs.begin({...f.p,account:randomUUID()},f.link,f.req)).rejects.toThrow('重新准备');
 await expect(f.handoffs.begin(f.p,f.link,{...f.req,inherited:{...f.inherited,public:{...f.inherited.public,name:'changed'}}})).rejects.toThrow('重新准备');
 delete f.db.handoffs[f.retryId]!.inherited;
 await expect(f.handoffs.begin(f.p,f.link,f.req)).rejects.toThrow('重新准备');
});

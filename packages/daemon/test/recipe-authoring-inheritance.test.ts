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
it('confirms a published long inherited overview without changing its full digest-bound value',async()=>{
 const f=fixture();f.inherited.public.overview='甲'.repeat(10500);
 await f.handoffs.begin(f.p,f.link,f.req);
 const row=f.db.handoffs[f.retryId]!;
 const request={retryId:f.retryId,ref:row.ref,generation:row.generation,lease:'a'.repeat(64),versions:[]};row.phase={state:'awaitingAttestations',request};
 let prepared:RichLocalDraft|undefined;
 await f.handoffs.answer(f.p,f.link,{type:'answerHandoff',botId:f.req.botId,session:f.p.session,request,attestations:[]},async target=>{
  prepared=target.rich;return {kind:'operation',operation:{operationId:randomUUID(),purpose:'prepareDraft',targetPublicKey:'a'.repeat(43),nonceCommitment:'a'.repeat(43),state:'waiting',deliveryUnknown:false,createdAt:1000}};
 });
 expect(prepared?.request&&'content'in prepared.request&&prepared.request.content.public.overview.value).toBe(f.inherited.public.overview);
 const review=richCardReview({view:{operationId:randomUUID()},rich:prepared});
 expect(JSON.stringify(review)).toContain('完整发布信息在 App 核对');expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThan(10000);
 const before=review?.payloadDigest;
 if(prepared?.request&&'content'in prepared.request)prepared.request.content.public.overview.value+='x';
 expect(richCardReview({view:{operationId:randomUUID()},rich:prepared})?.payloadDigest).not.toBe(before);
});
import {mkdtemp,readFile,writeFile,stat,realpath,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recipeAuthoringRequestSchema} from '@vonvon/protocol';
import {AuthoringJournal as RealJournal} from '../src/recipe/authoring-journal';
it('accepts published Unicode fields and enforces byte and scalar limits',()=>{
 const f=fixture();f.inherited.public.name='🧩'.repeat(60);f.inherited.public.summary='🧩'.repeat(240);
 expect(recipeAuthoringRequestSchema.safeParse(f.req).success).toBe(true);
 f.inherited.public.name+='x';expect(recipeAuthoringRequestSchema.safeParse(f.req).success).toBe(false);
 f.inherited.public.name='ok';f.inherited.public.overview='甲'.repeat(10923);expect(recipeAuthoringRequestSchema.safeParse(f.req).success).toBe(false);
});
it('keeps large repeated snapshots outside the journal and verifies recovery blobs',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'inherit-blob-')));const journal=new RealJournal(root,()=>1000);
 const f=fixture();await f.handoffs.begin(f.p,f.link,f.req);const row=f.db.handoffs[f.retryId]!;
 row.inherited!.logo=Buffer.alloc(131072,1).toString('base64url');row.inherited!.public.overview='甲'.repeat(10922);
 await journal.run(db=>{db.handoffs=Object.fromEntries(Array.from({length:100},()=>{const retryId=randomUUID();return [retryId,{...row,retryId}];}));});
 const file=join(root,'recipe-authoring/journal.json'),disk=JSON.parse(await readFile(file,'utf8'));
 expect((await stat(file)).size).toBeLessThan(200000);
 const entry=Object.values(disk.handoffs)[0] as {inheritedBlob:string};expect(entry.inheritedBlob).toMatch(/^[a-f0-9]{64}$/);
 await journal.run(db=>{expect(Object.values(db.handoffs!)[0]!.inherited).toEqual(row.inherited);});
 await writeFile(join(root,'recipe-authoring','rich-'+entry.inheritedBlob+'.json'),'{}');
 await expect(journal.run(db=>Object.values(db.handoffs!)[0]!.inherited)).rejects.toThrow('已变化');
 const expired=new RealJournal(root,()=>row.expiresAt+7*86400000+1);
 await expired.run(db=>{expect(Object.keys(db.handoffs!)).toHaveLength(0);});
 expect((await readdir(join(root,'recipe-authoring'))).filter(name=>name.startsWith('rich-'))).toEqual([]);
});

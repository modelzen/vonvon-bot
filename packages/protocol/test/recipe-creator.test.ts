import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {recipeAuthoringRequestSchema as request, recipeAuthoringReplySchema as reply,desktopAuthoringRequestSchema,desktopAuthoringReplySchema,creatorSnapshotSchema} from '../src/index.js';

const id = randomUUID(), hash = 'a'.repeat(64), botId = 'cli_bot';
it('keeps App navigation a bounded readonly job and acknowledgement without publish parameters',()=>{
  const read={kind:'openPreview',work:{draftId:id,source:null},snapshotDigest:hash};
  const job={id,binding:id,scope:hash,task:{kind:'read',read}};
  expect(reply.safeParse({kind:'creatorJobs',jobs:[job]}).success).toBe(true);
  for(const extra of [{confirmationId:id},{revision:2},{approval:hash},{publish:true}])
    expect(reply.safeParse({kind:'creatorJobs',jobs:[{...job,task:{kind:'read',read:{...read,...extra}}}]}).success).toBe(false);
  const answer={kind:'previewOpened',work:read.work,snapshotDigest:hash,revision:2};
  expect(request.safeParse({type:'creatorAnswer',botId,session:id,id,answer}).success).toBe(true);
  expect(request.safeParse({type:'creatorAnswer',botId,session:id,id,answer:{...answer,canonical:'large'}}).success).toBe(false);
});
it('uses separate discovery and binding-checked activation on owner authoring RPC', () => {
  expect(request.safeParse({type:'creatorDiscover',botId,accountId:id}).success).toBe(true);
  expect(request.safeParse({type:'creatorOpen',botId,accountId:id,binding:id,scope:hash,wakeId:null}).success).toBe(true);
  expect(request.safeParse({type:'creatorOpen',botId,accountId:id,wakeId:null}).success).toBe(false);
  expect(reply.safeParse({kind:'session',session:id,linked:true,leaseMs:45000,binding:id}).success).toBe(false);
});
it('keeps native App review and explicit confirmation separate from Feishu callback identity',()=>{
  const confirm={type:'creatorAppConfirm',botId,session:id,id,snapshotDigest:hash,confirmationId:id};
  expect(request.safeParse(confirm).success).toBe(true);
  expect(request.safeParse({...confirm,messageId:'om_fabricated',cardId:'card_fabricated'}).success).toBe(false);
  expect(desktopAuthoringRequestSchema.safeParse({type:'confirmPublication',accountId:id,reviewId:id}).success).toBe(true);
  expect(desktopAuthoringRequestSchema.safeParse({type:'confirmPublication',accountId:id,reviewId:id,snapshotDigest:hash}).success).toBe(false);
  const draft={draftId:id,recipeId:null,revision:2,public:{name:'名称',summary:'',overview:'',version:'1',access:'direct'},config:{role:'正文'}};
  expect(desktopAuthoringRequestSchema.safeParse({type:'preparePublication',accountId:id,draft}).success).toBe(true);
  expect(desktopAuthoringRequestSchema.safeParse({type:'preparePublication',accountId:id,draft:{...draft,token:'secret'}}).success).toBe(false);
});
it('allows only secret-free HTTPS draft navigation or existing local development origins',()=>{
  const snapshot={work:{draftId:id,source:null},format:'role-v1',recipeId:null,parent:null,revision:2,
    public:{name:'名称',summary:'',overview:'',version:'1',access:'direct'},contentSha256:hash,parts:[],sections:[{title:'角色',pageHashes:[hash]}]};
  for(const origin of ['https://vonvon.cc','http://localhost:5000'])expect(creatorSnapshotSchema.safeParse({...snapshot,appPreviewUrl:`${origin}/open/draft#${id}?revision=2`}).success).toBe(true);
  for(const url of [`http://example.org/open/draft#${id}?revision=2`,`https://user:password@vonvon.cc/open/draft#${id}?revision=2`,`https://vonvon.cc/open/draft?token=secret#${id}?revision=2`,`https://vonvon.cc/open/draft#${id}?revision=2&token=secret`])
    expect(creatorSnapshotSchema.safeParse({...snapshot,appPreviewUrl:url}).success).toBe(false);
});
it('keeps plaintext out of journalable replies and arbitrary requests out of the native job', () => {
  const base = {type:'creatorAnswer',botId,session:id,id};
  const target = {recipeId:id,versionId:id};
  expect(request.safeParse({...base,answer:{kind:'issued',target,codeIds:[id]}}).success).toBe(true);
  expect(request.safeParse({...base,answer:{kind:'issued',target,codeIds:[id],code:'a'.repeat(32)}}).success).toBe(false);
  expect(reply.safeParse({kind:'creatorJobs',jobs:[{id,binding:id,scope:hash,task:{kind:'command',command:{kind:'POST',path:'/anything'},approval:hash,expiresAt:1}}]}).success).toBe(false);
});

it('keeps cold publication recovery readonly and its absence distinct from a confirmed result',()=>{
  const recover={type:'recoverPublication',accountId:id,draftId:id};
  expect(desktopAuthoringRequestSchema.safeParse(recover).success).toBe(true);
  for(const extra of [{reviewId:id},{draft:{}},{confirmationId:id},{snapshotDigest:hash}])expect(desktopAuthoringRequestSchema.safeParse({...recover,...extra}).success).toBe(false);
  for(const result of [{kind:'absent'},{kind:'pending'},{kind:'published',publication:{accountId:id,draftId:id,recipeId:id,versionId:id,revision:1}}])
    expect(desktopAuthoringReplySchema.safeParse({kind:'publicationRecovery',result}).success).toBe(true);
  expect(desktopAuthoringReplySchema.safeParse({kind:'publicationRecovery',result:{kind:'published'}}).success).toBe(false);
});

import {randomUUID} from 'node:crypto';
import {RecipeAuthoringController} from '../../../desktop/src/recipe-authoring.ts';
import {AuthoringJournal} from '../../../desktop/src/recipe-authoring-journal.ts';

export function mainController({accountId,botId,groupId,daemon,api,broker,bearer}){
  const deviceId=randomUUID(),generation=new AbortController(),saved=[];
  const account={
    status:()=>({kind:'signedIn',accountId,provider:'github',displayName:'Fixture',persistence:'memory'}),
    lease:()=>generation.signal,
    request:async(actor,path,init={},beforeSend)=>{
      if(actor!==accountId)throw Error('foreign account');
      beforeSend?.();
      const headers=new Headers(init.headers);headers.set('authorization','Bearer '+bearer);
      const origin=path.includes('/members/')||path.includes('/objects/')&&path.includes('/drafts/')?broker:api;
      return fetch(origin+path,{...init,headers});
    },
  };
  const client={recipeAuthoring:daemon,device:async()=>({kind:'deviceStatus',status:{device:{
    id:deviceId,name:'Local fixture',publicKey:Buffer.alloc(32,4).toString('base64url')},remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot:async()=>({agents:[{id:botId,name:'Fixture'}],groups:[{id:groupId,name:'Source'}],memberships:[{agentId:botId,groupId}]})};
  const controller=new RecipeAuthoringController(account,()=>({client,viewId:'local',check(){generation.signal.throwIfAborted();}}),
    new AuthoringJournal(),receipt=>saved.push(receipt));
  return {controller,saved,generation};
}

export async function savedRichPreview({accountId,botId,deviceId,session,draftJob,content,daemon}){
  const {canonicalizeRichRecipeContent}=await import('@vonvon/protocol');
  const {RecipeCreatorExecutor}=await import('../../../desktop/src/recipe-creator.ts');
  const {RecipeCreatorJournal,creatorSha}=await import('../../../desktop/src/recipe-creator-journal.ts');
  const {MetadataJournal}=await import('../../../desktop/src/community-metadata-journal.ts');
  const {work}=draftJob.task.read,{draftId,source}=work,authoring=new AuthoringJournal();
  const association={accountId,botId,deviceId,deviceKey:Buffer.alloc(32,2).toString('base64url'),viewId:'local',scope:draftJob.scope,binding:draftJob.binding};
  authoring.history.remember(association,source.preparationId,source.identity,source.groupId);
  const bytes=canonicalizeRichRecipeContent(content).canonicalUTF8;
  const manifest={objectId:randomUUID(),kind:'manifest',sha256:creatorSha(bytes),bytes:bytes.length,mediaType:'application/json'};
  const account={request:async(actor,path,init,beforeSend)=>{
    if(actor!==accountId||init?.method&&init.method!=='GET')throw Error('unexpected account request');
    await beforeSend?.();
    const draft='/v2/drafts/'+draftId;
    if(path===draft)return Response.json({format:'rich-v2',draftId,recipeId:null,revision:1,access:'direct',sourceIntentId:source.preparationId,manifest,sourceManifest:manifest,logicalBytes:bytes.length,retainedCandidateBytes:0});
    if(path===draft+'/objects/'+manifest.objectId)return new Response(bytes);
    if(path.startsWith(draft+'/creator-context?'))return Response.json({format:'rich-v2',draftId,revision:1,sourceIntentId:source.preparationId,parent:null});
    throw Error(path);
  }};
  const executor=new RecipeCreatorExecutor(account,new RecipeCreatorJournal(),new MetadataJournal(),authoring);
  const context={association,session,check(){},settled:async()=>{},rpc:daemon};
  return {run:job=>executor.run(context,job),close:()=>authoring.history.close()};
}

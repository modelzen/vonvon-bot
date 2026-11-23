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

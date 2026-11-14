import {ApiError,badInput} from './errors.mjs';
import {bodyJson,objectKeys,queryParams,requestKey,uuid} from './input.mjs';
const routes=[['GET','me/recipes','readerLibrary'],['GET','me/publications','readerPublications'],['GET','me/drafts','readerDrafts'],
 ['POST','versions/([^/]+)/acquire','readerAcquire'],['POST','versions/([^/]+)/redeem','readerRedeem']];
export function readerRoute(method,path){
  for(const [verb,pattern,action] of routes){const match=new RegExp('^(?:/api)?/v2/'+pattern+'$').exec(path);if(!match)continue;
    if(method!==verb)throw new ApiError(405,'method_not_allowed');
    return {action,isPublic:false,ids:match.slice(1).map(uuid)};
  }
}
export async function readerInput(req,url,{action,ids}){
  const {cursor}=queryParams(url,action==='readerLibrary'?['cursor']:[]);
  if(req.method==='GET')return [action,action==='readerLibrary'?[cursor]:[]];
  const body=await bodyJson(req,2048);objectKeys(body,action==='readerRedeem'?['code']:[]);
  if(action==='readerRedeem'&&(typeof body.code!=='string'||!/^[a-z0-9-]{1,128}$/i.test(body.code)))throw badInput();
  return ['readerAcquire',[...ids,body.code??null,requestKey(req,true)]];
}

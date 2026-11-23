import {ApiError,badInput} from './errors.mjs';
import {bodyJson,objectKeys,queryParams,requestKey,uuid} from './input.mjs';
const routes=[['GET','recipes/([^/]+)/latest-install-version','readerLatest'],['GET','me/recipes','readerLibrary'],['GET','me/publications','readerPublications'],['GET','me/drafts','readerDrafts'],
 ['GET','me/recipe-groups','readerRecipeGroups'],['GET','me/recipe-groups/([^/]+)/versions','readerRecipeGroupVersions'],
 ['POST','versions/([^/]+)/acquire','readerAcquire'],['POST','versions/([^/]+)/redeem','readerRedeem']];
export function readerRoute(method,path){
  for(const [verb,pattern,action] of routes){const match=new RegExp('^(?:/api)?/v2/'+pattern+'$').exec(path);if(!match)continue;
    if(method!==verb)throw new ApiError(405,'method_not_allowed');
    return {action,isPublic:false,ids:match.slice(1).map(uuid)};
  }
}
export async function readerInput(req,url,{action,ids}){
  if(action==='readerRecipeGroups'||action==='readerRecipeGroupVersions'){
    const params=url.searchParams;
    for(const key of params.keys())if(!['scope','cursor'].includes(key)||params.getAll(key).length!==1)throw badInput();
    const scope=params.get('scope'),cursor=params.get('cursor');
    if(!['all','acquired','published'].includes(scope)||cursor!==null&&(cursor.length>1600||! /^[a-f0-9]+\.[a-f0-9]{64}$/.test(cursor)))throw badInput();
    return [action,[...ids,scope,cursor]];
  }
  const {cursor}=queryParams(url,action==='readerLibrary'?['cursor']:[]);
  if(req.method==='GET')return [action,action==='readerLibrary'?[cursor]:ids];
  const body=await bodyJson(req,2048);objectKeys(body,action==='readerRedeem'?['code']:[]);
  if(action==='readerRedeem'&&(typeof body.code!=='string'||!/^[a-z0-9-]{1,128}$/i.test(body.code)))throw badInput();
  return ['readerAcquire',[...ids,body.code??null,requestKey(req,true)]];
}

export function readerOutput(req,operation,result){
  // Earlier clients reject coded preview fields until that exact version is acquired.
  const capability=req.headersDistinct['x-vonvon-browse'];
  if(operation!=='richBrowsePreview'||capability?.length===1&&capability[0]==='public-v2'||
    result?.public?.access!=='coded'||result.owned===true||result.acquired===true)return result;
  const {preview,previewUnavailable,...intro}=result;
  return intro;
}

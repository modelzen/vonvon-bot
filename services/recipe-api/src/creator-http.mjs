import {ApiError,badInput} from './errors.mjs';
import {queryParams,uuid} from './input.mjs';

export function creatorRoute(method,path){
  const match=/^(?:\/api)?\/v([12])\/drafts\/([^/]+)\/creator-context$/.exec(path);
  if(!match)return;
  if(method!=='GET')throw new ApiError(405,'method_not_allowed');
  return {action:'creatorContext',isPublic:false,format:match[1]==='1'?'role-v1':'rich-v2',draftId:uuid(match[2])};
}

export function creatorInput(_req,url,{action,format,draftId}){
  queryParams(url,['revision',...(format==='rich-v2'?['contentSha256']:[])]);
  const revision=url.searchParams.get('revision'),hash=url.searchParams.get('contentSha256');
  if(typeof revision!=='string'||!/^[1-9]\d{0,9}$/.test(revision)||Number(revision)>2147483647)throw badInput();
  if(format==='rich-v2'&&(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw badInput();
  return [action,[format,draftId,Number(revision),hash]];
}

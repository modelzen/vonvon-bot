import {ApiError,badInput} from './errors.mjs';
import {queryParams,uuid} from './input.mjs';

const routes=[
  {path:/^(?:\/api)?\/v1\/receipts\/publications\/([^/]+)$/,format:'role-v1',action:'publicationReceipt'},
  {path:/^(?:\/api)?\/v2\/receipts\/publications\/([^/]+)$/,format:'rich-v2',action:'publicationReceipt'},
  {path:/^(?:\/api)?\/v1\/receipts\/code-issuance\/([^/]+)$/,action:'codeIssuanceReceipt'},
  {path:/^(?:\/api)?\/v2\/receipts\/metadata\/([^/]+)$/,action:'metadataReceipt'},
];

export function receiptRoute(method,path){
  const route=routes.find(r=>r.path.test(path));
  if(!route)return;
  if(method!=='GET')throw new ApiError(405,'method_not_allowed');
  return {...route,isPublic:false,requestId:uuid(route.path.exec(path)[1])};
}

function positiveInteger(raw,max){
  if(typeof raw!=='string'||!/^[1-9]\d{0,9}$/.test(raw)||Number(raw)>max)throw badInput();
  return Number(raw);
}

export function receiptInput(_req,url,{action,format,requestId}){
  if(action==='metadataReceipt'){
    queryParams(url,['draftId','revision','baseManifestSha256','transformVersion','inputSha256','wireSha256']);
    const hash=name=>{
      const value=url.searchParams.get(name);
      if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw badInput();
      return value;
    };
    if(url.searchParams.get('transformVersion')!=='1')throw badInput();
    return [action,[requestId,uuid(url.searchParams.get('draftId')),positiveInteger(url.searchParams.get('revision'),2147483647),
      hash('baseManifestSha256'),1,hash('inputSha256'),url.searchParams.has('wireSha256')?hash('wireSha256'):null]];
  }
  if(action==='codeIssuanceReceipt'){
    queryParams(url,['versionId','count']);
    return [action,[requestId,uuid(url.searchParams.get('versionId')),positiveInteger(url.searchParams.get('count'),100)]];
  }
  queryParams(url,['draftId','revision',...(format==='rich-v2'?['contentSha256']:[])]);
  const hash=url.searchParams.get('contentSha256');
  if(format==='rich-v2'&&(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw badInput();
  return [action,[format,requestId,uuid(url.searchParams.get('draftId')),positiveInteger(url.searchParams.get('revision'),2147483647),hash]];
}

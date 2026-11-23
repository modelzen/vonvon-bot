import {createHash} from 'node:crypto';
import {decodeRichRecipeContent,recipeSkillDescription} from '../../../packages/protocol/dist/index.js';
import {ApiError} from './errors.mjs';
import {loopback} from './auth.mjs';

const unavailable=()=>new ApiError(503,'publication_preview_unavailable',1);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function createPublicationReader(origin='http://127.0.0.1:4318',fetchImpl=fetch){
  const base=new URL(origin);
  if(base.protocol!=='http:'||!loopback(base.hostname)||base.pathname!=='/'||base.search||base.hash||base.username||base.password)
    throw new Error('Invalid RECIPE_BROKER_ORIGIN');
  return async({draftId,descriptor,authorization,signal})=>{
    try{
      const response=await fetchImpl(`${base.origin}/v2/drafts/${draftId}/objects/${descriptor.objectId}`,{
        headers:{authorization},redirect:'error',cache:'no-store',signal,
      });
      if(!response.ok||!response.body){await response.body?.cancel();throw unavailable();}
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;
        bytes+=next.value.byteLength;if(bytes>descriptor.bytes)throw unavailable();chunks.push(next.value);}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      return Buffer.concat(chunks);
    }catch{throw unavailable();}
  };
}

export async function publicationDescriptions(args,{authorization,read,committed,currentDraft}){
  const [draftId,revision,requestId,canonical]=args;
  const {content}=decodeRichRecipeContent(canonical);
  const entries=content.skills.map(skill=>{
    const file=content.files.find(file=>file.itemId===skill.entryFileId);
    if(!file||file.use!=='skillDescription')throw unavailable();
    return {skill,file};
  });
  const external=new Map();
  for(const {file} of entries)if(file.text.kind==='part'){
    const descriptor=content.parts.find(part=>part.objectId===file.text.objectId&&part.kind==='text');
    if(!descriptor)throw unavailable();external.set(descriptor.objectId,descriptor);
  }
  if(!external.size)return;
  const source={draftId,revision,requestId,contentSha256:sha(canonical)};
  const receipt=await committed(source);
  if(receipt?.status==='committed')return;
  if(receipt?.status!=='unknown'||typeof read!=='function')throw unavailable();
  const checkDraft=async()=>{
    try{
      const draft=await currentDraft(draftId);
      if(draft?.format!=='rich-v2'||draft.draftId!==draftId||!draft.manifest)throw unavailable();
      if(draft.revision!==revision||draft.manifest.sha256!==source.contentSha256||draft.manifest.bytes!==canonical.byteLength)
        throw new ApiError(409,'conflict');
      return false;
    }catch(error){
      if(error instanceof ApiError&&[404,409].includes(error.status)&&(await committed(source))?.status==='committed')return true;
      throw error;
    }
  };
  if(await checkDraft())return;
  const abort=new AbortController(),signal=AbortSignal.any([abort.signal,AbortSignal.timeout(10_000)]),texts=new Map(),descriptors=[...external.values()];
  try{
    for(let offset=0;offset<descriptors.length;offset+=4){
      await Promise.all(descriptors.slice(offset,offset+4).map(async descriptor=>{
        signal.throwIfAborted();
        const bytes=await read({draftId,descriptor,authorization,signal});signal.throwIfAborted();
        if(!(bytes instanceof Uint8Array)||bytes.byteLength!==descriptor.bytes||sha(bytes)!==descriptor.sha256)throw unavailable();
        texts.set(descriptor.objectId,new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      }));
    }
  }catch{
    abort.abort();
    const latest=await committed(source);if(latest?.status==='committed')return;
    if(latest?.status!=='unknown')throw unavailable();
    if(await checkDraft())return;throw unavailable();
  }
  return Object.fromEntries(entries.map(({skill,file})=>[skill.itemId,recipeSkillDescription(file.text.kind==='inline'?file.text.value:texts.get(file.text.objectId))]));
}

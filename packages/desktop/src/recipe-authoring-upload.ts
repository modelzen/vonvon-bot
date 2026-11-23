import type {RecipeRichPartDescriptor} from '@vonvon/protocol';

type Member={kind:'text'|'finalLogo';sha256:string};
export async function uploadRichMembers(members:readonly Member[],ownerSignal:AbortSignal,
  upload:(index:number,ordinal:number,member:Member,signal:AbortSignal)=>Promise<RecipeRichPartDescriptor>){
  const stop=new AbortController(),signal=AbortSignal.any([ownerSignal,stop.signal]);
  const results:RecipeRichPartDescriptor[]=new Array(members.length);
  const text:number[]=[];
  let logo:number|undefined;
  for(const [index,member] of members.entries()){
    if(member.kind==='text')text.push(index);
    else if(logo===undefined)logo=index;
    else throw new Error('本次操作含多个 Logo。');
  }
  if(text.length>64)throw new Error('本次文件数量超过上限。');
  let cursor=0;
  async function worker(){
    try {
      for(;;){
        signal.throwIfAborted();
        const ordinal=cursor++,index=text[ordinal];
        if(index===undefined)return;
        results[index]=await upload(index,ordinal,members[index]!,signal);
      }
    }catch(error){
      if(!stop.signal.aborted)stop.abort(error);
      throw error;
    }
  }
  await Promise.allSettled(Array.from({length:Math.min(2,text.length)},worker));
  signal.throwIfAborted();
  if(logo!==undefined)results[logo]=await upload(logo,64,members[logo]!,signal);
  signal.throwIfAborted();
  return results;
}

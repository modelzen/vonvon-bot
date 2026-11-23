import {it,expect,vi} from 'vitest';
import {uploadRichMembers} from '../src/recipe-authoring-upload';
import type {RecipeRichPartDescriptor} from '@vonvon/protocol';
import {randomUUID} from 'node:crypto';

const text={kind:'text' as const,sha256:'a'.repeat(64)},logo={kind:'finalLogo' as const,sha256:'b'.repeat(64)};
const part=(m:{kind:'text'|'finalLogo';sha256:string}):RecipeRichPartDescriptor=>{
  const shared={objectId:randomUUID(),bytes:1,sha256:m.sha256};
  return m.kind==='text'?{...shared,kind:'text',mediaType:'text/plain;charset=utf-8'}:{...shared,kind:'finalLogo',mediaType:'image/webp'};
};
it('transfers two texts at once, keeps descriptor order and uploads Logo last',async()=>{
  const members=[text,logo,...Array.from({length:63},()=>text)],ordinals:number[]=[];
  let active=0,peak=0;
  const receipts=await uploadRichMembers(members,new AbortController().signal,async(index,ordinal,m)=>{
    peak=Math.max(++active,peak);ordinals.push(ordinal);
    if(m.kind==='finalLogo')expect(active).toBe(1);
    await new Promise(resolve=>setTimeout(resolve,index%2+1));active--;
    return {...part(m),bytes:index+1};
  });
  expect(peak).toBe(2);expect(ordinals).toEqual(Array.from({length:65},(_,i)=>i));
  expect(receipts.map(p=>p.bytes)).toEqual(members.map((_m,i)=>i+1));
});
it.each(['failed member','account switched'])('drains both writers before returning when %s',async reason=>{
  const account=new AbortController(),started:number[]=[],finished:number[]=[];
  let fail:()=>void=()=>{};
  const running=uploadRichMembers([text,text,text,logo],account.signal,async(index,_ord,m,signal)=>{
    started.push(index);
    try{
      await new Promise<void>((_resolve,reject)=>{
        if(index===0)fail=()=>reject(Error(reason));
        signal.addEventListener('abort',()=>setTimeout(()=>reject(signal.reason),5),{once:true});
      });
      return part(m);
    }finally{finished.push(index);}
  });
  await vi.waitFor(()=>expect(started).toEqual([0,1]));
  if(reason==='failed member')fail();else account.abort(Error(reason));
  await expect(running).rejects.toThrow(reason);
  expect(finished.sort()).toEqual([0,1]);expect(started).toHaveLength(2);
});

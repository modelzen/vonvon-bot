import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,openSync,readFileSync} from 'node:fs';
import {readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {writeFileAtomic} from '../server/atomic-file';
import {syncDirectory} from '../config/bot-namespace';
import type {AuthoringLedger} from './authoring-journal';

const limit=12*1024*1024;
const valid=(hash:string)=>/^[a-f0-9]{64}$/.test(hash);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const file=(dir:string,hash:string)=>join(dir,'rich-'+hash+'.json');
function read(dir:string,hash:string){
  if(!valid(hash))throw new Error('配方草稿记录无效。');
  const fd=openSync(file(dir,hash),constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>limit)throw new Error('配方草稿记录无效。');
    const text=readFileSync(fd,'utf8');
    if(sha(text)!==hash)throw new Error('配方草稿记录已变化。');
    return JSON.parse(text);
  }finally{closeSync(fd);}
}
function visit(ledger:AuthoringLedger,fn:(owner:object,key:string)=>void){
  for(const handoff of Object.values(ledger.handoffs??{})){fn(handoff,'edit');fn(handoff,'inherited');}
  for(const operation of Object.values(ledger.operations)){
    fn(operation,'rich');fn(operation,'richSaved');fn(operation,'richSourceOriginal');
  }
  for(const link of Object.values(ledger.links))for(const source of link.sources)if(source.rich)fn(source.rich,'draft');
}
export function localRichStorage(dir:string,ledger:AuthoringLedger){
  const originals=new WeakMap<object,Map<string,{hash:string;loaded:boolean}>>();
  visit(ledger,(owner,key)=>{
    const record=owner as Record<string,unknown>,hash=record[key+'Blob'];
    if(hash===undefined)return;
    if(typeof hash!=='string'||!valid(hash)||record[key]!==undefined)throw new Error('配方草稿索引无效。');
    const slot={hash,loaded:false};
    const fields=originals.get(owner)??new Map();fields.set(key,slot);originals.set(owner,fields);
    let value:unknown;
    delete record[key+'Blob'];
    Object.defineProperty(record,key,{enumerable:true,configurable:true,get(){
      if(!slot.loaded){value=read(dir,hash);slot.loaded=true;}
      return value;
    },set(next:unknown){value=next;slot.loaded=true;}});
  });
  return async ()=>{
    const live=new Set<string>(),writes=new Map<string,string>();
    visit(ledger,(owner,key)=>{
      const record=owner as Record<string,unknown>,old=originals.get(owner)?.get(key);
      if(!Object.hasOwn(record,key))return;
      let hash=old?.hash;
      if(!old||old.loaded||!Object.getOwnPropertyDescriptor(record,key)?.get){
        const data=record[key];
        if(data===undefined){delete record[key];return;}
        const text=JSON.stringify(data);
        if(Buffer.byteLength(text)>limit)throw new Error('本机配方草稿超过大小限制。');
        hash=sha(text);
        if(old?.hash!==hash)writes.set(hash,text);
      }
      if(!hash)throw new Error('配方草稿索引无效。');
      live.add(hash);delete record[key];record[key+'Blob']=hash;
    });
    for(const [hash,text] of writes)await writeFileAtomic(file(dir,hash),text,{durable:true});
    if(writes.size)await syncDirectory(dir);
    return async ()=>{
      for(const name of await readdir(dir)){
        const match=/^rich-([0-9a-f]{64})\.json$/.exec(name);
        if(match&&!live.has(match[1]!))await unlink(join(dir,name)).catch(()=>{});
      }
    };
  };
}

import {randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {richMetadataCommitSchema,richMetadataRequestSchema} from '@vonvon/protocol';

const entry=z.object({request:richMetadataRequestSchema,commit:richMetadataCommitSchema.optional()}).strict();
export type MetadataEntry=z.infer<typeof entry>;

export class MetadataJournal {
  private readonly memory=new Map<string,MetadataEntry>();
  private readonly running=new Map<string,Promise<unknown>>();
  constructor(private readonly dir?:string) {}
  key(accountId:string,draftId:string) {return accountId+'-'+draftId;}
  async exclusive<T>(key:string,action:()=>Promise<T>):Promise<T>{
    const previous=this.running.get(key);
    const run=Promise.resolve(previous).catch(()=>{}).then(action);
    this.running.set(key,run);
    try{return await run;}finally{if(this.running.get(key)===run)this.running.delete(key);}
  }
  read(key:string):MetadataEntry|undefined {
    if(!this.dir)return this.memory.get(key);
    const path=join(this.dir,key+'.json');
    try {
      if(statSync(path).size>5*1024*1024)throw new Error('保存记录过大');
      const row=entry.parse(JSON.parse(readFileSync(path,'utf8')));
      if(key!==this.key(row.request.accountId,row.request.draftId))throw new Error('保存记录与草稿不匹配');
      return row;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  write(key:string,row:MetadataEntry) {
    if(!this.dir){this.memory.set(key,row);return;}
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    const file=join(this.dir,key+'.json'),temp=file+'.'+randomUUID()+'.tmp';
    const fd=openSync(temp,'wx',0o600);
    try{
      try{writeFileSync(fd,JSON.stringify(row));fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(temp,file);
      if(process.platform!=='win32'){
        const dir=openSync(this.dir,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
      }
    }finally{try{unlinkSync(temp);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }
  clear(key:string){
    if(this.dir){try{unlinkSync(join(this.dir,key+'.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    else this.memory.delete(key);
  }
}

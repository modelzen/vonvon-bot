import {isDeepStrictEqual} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,fsyncSync,mkdirSync,openSync,opendirSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {agentIdSchema,viewIdSchema,recipeBinary32Schema,creatorCommandSchema,creatorConfirmationSchema,creatorSnapshotSchema,creatorAnswerSchema,communityRequestSchema} from '@vonvon/protocol';

const uuid=z.string().uuid(), digest=z.string().regex(/^[a-f0-9]{64}$/);
export const creatorAssociationSchema=z.object({accountId:uuid,viewId:viewIdSchema,deviceId:uuid,deviceKey:recipeBinary32Schema,botId:agentIdSchema,binding:uuid,scope:digest}).strict();
export type CreatorAssociation=z.infer<typeof creatorAssociationSchema>;
export function sameCreatorSource(a:CreatorAssociation|undefined,b:CreatorAssociation){
  return !!a&&a.accountId===b.accountId&&a.deviceId===b.deviceId&&a.deviceKey===b.deviceKey&&a.botId===b.botId&&a.viewId===b.viewId;
}
export function checkVersionSource(original:CreatorAssociation|undefined,current:CreatorAssociation){
  if(original&&!sameCreatorSource(original,current))throw new Error('已发布版本的来源不能替换');
}
const snapshot=z.object({association:creatorAssociationSchema,snapshot:creatorSnapshotSchema,canonical:z.string().max(1401000),
  pages:z.array(z.array(z.string().max(4096)).min(1).max(2048)).min(1).max(16)}).strict();
export type CreatorFrozenSnapshot=z.infer<typeof snapshot>;
const command=z.object({association:creatorAssociationSchema,id:uuid,command:creatorCommandSchema,
  grant:z.object({approval:digest,expiresAt:z.number().int().safe().nonnegative(),confirmation:creatorConfirmationSchema.optional()}).strict(),
  request:communityRequestSchema,phase:z.enum(['frozen','dispatched','unknown','awaitingReceipt','committed']),result:creatorAnswerSchema.refine(answer=>!answer.kind.startsWith('resource')).optional()}).strict();
export type CreatorCommandRecord=z.infer<typeof command>;
export const creatorSha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const creatorSnapshotDigest=(value:unknown)=>creatorSha(JSON.stringify(creatorSnapshotSchema.parse(value)));

export class RecipeCreatorJournal {
  private memory=new Map<string,unknown>();
  constructor(private readonly dir?:string) {}
  private read<S extends z.ZodTypeAny>(key:string,schema:S,cap=8*1024*1024):z.output<S>|undefined {
    if(!this.dir){const raw=this.memory.get(key);return raw===undefined?undefined:schema.parse(raw);}
    try {const path=join(this.dir,key+'.json');if(statSync(path).size>cap)throw new Error('创作记录过大');return schema.parse(JSON.parse(readFileSync(path,'utf8')));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  private write<S extends z.ZodTypeAny>(key:string,schema:S,raw:z.input<S>){
    const value=schema.parse(raw),content=JSON.stringify(value);
    if(!this.dir){this.memory.set(key,JSON.parse(content));return;}
    mkdirSync(this.dir,{recursive:true,mode:0o700});
    const path=join(this.dir,key+'.json'),tmp=path+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx',0o600);
    try {
      try{writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}
      renameSync(tmp,path);
      if(process.platform!=='win32'){const directory=openSync(this.dir,'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
    }finally{try{unlinkSync(tmp);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }
  associations(accountId:string){return (this.read('associations',creatorAssociationSchema.array().max(256))??[]).filter(row=>row.accountId===accountId);}
  remember(value:CreatorAssociation){
    const rows=this.read('associations',creatorAssociationSchema.array().max(256))??[];
    const next=rows.filter(row=>!(row.accountId===value.accountId&&row.viewId===value.viewId&&row.botId===value.botId));
    this.write('associations',creatorAssociationSchema.array().max(256),[...next,value]);
  }
  freeze(value:CreatorFrozenSnapshot){
    const row=snapshot.parse(value),id=creatorSnapshotDigest(row.snapshot);
    if(row.pages.length!==row.snapshot.sections.length || row.pages.some((pages,i)=>pages.length!==row.snapshot.sections[i]!.pageHashes.length ||
      pages.some((page,j)=>creatorSha(page)!==row.snapshot.sections[i]!.pageHashes[j])))throw new Error('预览页与快照不一致');
    if(creatorSha(Buffer.from(row.canonical,'base64url'))!==row.snapshot.contentSha256)throw new Error('预览内容与快照不一致');
    this.write('snapshot-'+id,snapshot,row);return id;
  }
  snapshot(id:string){
    const value=this.read('snapshot-'+digest.parse(id),snapshot);
    if(value&&(creatorSnapshotDigest(value.snapshot)!==id||creatorSha(Buffer.from(value.canonical,'base64url'))!==value.snapshot.contentSha256||
      value.pages.length!==value.snapshot.sections.length||value.pages.some((pages,i)=>pages.length!==value.snapshot.sections[i]!.pageHashes.length||
        pages.some((page,j)=>creatorSha(page)!==value.snapshot.sections[i]!.pageHashes[j]))))throw new Error('预览记录已改变');
    return value;
  }
  version(accountId:string,versionId:string){return this.read('version-'+uuid.parse(accountId)+'-'+uuid.parse(versionId),creatorAssociationSchema);}
  rememberVersion(association:CreatorAssociation,versionId:string){
    checkVersionSource(this.version(association.accountId,versionId),association);
    this.write('version-'+association.accountId+'-'+uuid.parse(versionId),creatorAssociationSchema,association);
  }
  command(accountId:string,id:string){return this.read('command-'+uuid.parse(accountId)+'-'+uuid.parse(id),command);}
  publications(accountId:string,draftId:string){
    const prefix='command-'+uuid.parse(accountId)+'-';uuid.parse(draftId);
    let keys:string[];
    if(!this.dir)keys=[...this.memory.keys()].filter(key=>key.startsWith(prefix));
    else {
      keys=[];
      let directory:ReturnType<typeof opendirSync>;
      try{directory=opendirSync(this.dir);}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
      try {
        let scanned=0;
        for(let entry=directory.readSync();entry;entry=directory.readSync()){
          if(++scanned>16384)throw new Error('创作记录过多，请稍后重试');
          if(entry.isFile()&&entry.name.startsWith(prefix)&&/^command-[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/.test(entry.name))keys.push(entry.name.slice(0,-5));
        }
      }finally{directory.closeSync();}
    }
    if(keys.length>4096)throw new Error('创作记录过多，请稍后重试');
    const rows:CreatorCommandRecord[]=[];
    for(const key of keys){
      const row=this.read(key,command);
      if(row&&row.association.accountId===accountId&&row.command.kind==='publish'&&row.command.snapshot.work.draftId===draftId&&row.request.type==='publishDraft'&&
        row.request.accountId===accountId&&row.request.requestId===row.id&&row.request.draftId===draftId&&row.request.revision===row.command.snapshot.revision)rows.push(row);
    }
    return rows;
  }
  save(row:CreatorCommandRecord){
    const previous=this.command(row.association.accountId,row.id);
    if(previous && (!isDeepStrictEqual(previous.command,row.command)||!isDeepStrictEqual(previous.request,row.request)||
      !isDeepStrictEqual(previous.association,row.association)))throw new Error('原请求不能替换');
    if(previous?.result && !isDeepStrictEqual(previous.result,row.result))throw new Error('原回执不能替换');
    this.write('command-'+row.association.accountId+'-'+row.id,command,row);
  }
}

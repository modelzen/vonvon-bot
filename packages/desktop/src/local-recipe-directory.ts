import {createHash} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,fsyncSync,lstatSync,mkdirSync,mkdtempSync,opendirSync,openSync,readSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {canonicalCaselessSegment,canonicalizeRichRecipeContent,isPortableDocumentName,RECIPE_RICH_LIMITS,recipeConfigSchema,recipePublicSchema,recipeRichContentSchema,type RecipeRichContent} from '@vonvon/protocol';
import {z} from 'zod';
import type {LocalRecipeDraftRecord} from './local-recipe-drafts.js';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const failure=()=>new Error('本地配方目录已变化或内容无法核对。');
const noFollow=constants.O_NOFOLLOW??0;
const checkedFile=recipeRichContentSchema.shape.files.element.omit({text:true}).extend({
  objectId:uuid.optional(),paths:z.array(z.string().min(1).max(500)).min(1).max(RECIPE_RICH_LIMITS.skills),
});
const configSchema=recipeRichContentSchema.extend({files:checkedFile.array().max(RECIPE_RICH_LIMITS.files)});
const manifestSchema=z.discriminatedUnion('format',[
  z.object({format:z.literal('role-v1'),public:recipePublicSchema,config:recipeConfigSchema}).strict(),
  z.object({format:z.literal('rich-v2'),public:recipePublicSchema,config:configSchema}).strict(),
]);
type Manifest=z.infer<typeof manifestSchema>;
type PortableFiles=Pick<RecipeRichContent,'skills'>&{files:Pick<RecipeRichContent['files'][number],'name'|'itemId'>[]};
type PrivateData=Omit<LocalRecipeDraftRecord,'draft'|'members'|'sourceCanonical'>;
interface DirectoryIndex {
  storage:'recipe-directory-v1';recordSha256:string;manifestSha256:string;
  private:PrivateData;draft:Pick<LocalRecipeDraftRecord['draft'],'draftId'|'recipeId'|'revision'|'format'|'sourceIntentId'>;
  hasLogo?:true;sourceIsCurrent?:true;sourceCanonical?:string;
  members:{descriptor:LocalRecipeDraftRecord['members'][number]['descriptor'];base64?:string}[];
}
export function isRecipeDirectoryIndex(value:unknown):value is DirectoryIndex{
  return !!value&&typeof value==='object'&&'storage' in value&&value.storage==='recipe-directory-v1';
}
function syncDirectory(path:string){
  if(process.platform==='win32')return;
  const fd=openSync(path,constants.O_RDONLY|noFollow|constants.O_DIRECTORY);
  try{fsyncSync(fd);}finally{closeSync(fd);}
}
function checkedDir(path:string){
  if(!lstatSync(path).isDirectory()||realpathSync(path)!==path)throw failure();
  return path;
}
function childDir(parent:string,component:string,create:boolean){
  const path=join(checkedDir(parent),component);
  if(create&&!existsSync(path)){
    try{mkdirSync(path,{mode:0o700});syncDirectory(parent);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }
  return checkedDir(path);
}
function diskFile(root:string,relative:string,create:boolean){
  const parts=relative.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[\\:\0]/u.test(p)))throw failure();
  let parent=root;
  for(const component of parts.slice(0,-1))parent=childDir(parent,component,create);
  return join(checkedDir(parent),parts[parts.length-1]!);
}
function readBytes(root:string,name:string,cap:number){
  const path=diskFile(root,name,false),before=lstatSync(path);
  if(!before.isFile()||before.nlink!==1||before.size>cap)throw failure();
  const fd=openSync(path,constants.O_RDONLY|noFollow|(constants.O_NONBLOCK??0));
  try{
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.size>cap||opened.dev!==before.dev||opened.ino!==before.ino)throw failure();
    const bytes=Buffer.alloc(opened.size);
    let offset=0;
    while(offset<bytes.length){
      const count=readSync(fd,bytes,offset,bytes.length-offset,null);
      if(!count)throw failure();
      offset+=count;
    }
    if(fstatSync(fd).size!==bytes.length||realpathSync(path)!==path)throw failure();
    return bytes;
  }finally{closeSync(fd);}
}
function verifyTree(root:string,expected:Iterable<string>){
  const files=new Set(expected),dirs=new Set<string>(),pending=[''];
  for(const file of files){
    const parts=file.split('/');
    for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));
  }
  while(pending.length){
    const prefix=pending.pop()!,dir=opendirSync(checkedDir(join(root,prefix)));
    try{
      for(let entry=dir.readSync();entry;entry=dir.readSync()){
        const relative=prefix?prefix+'/'+entry.name:entry.name;
        if(entry.isDirectory()&&dirs.delete(relative))pending.push(relative);
        else if(!entry.isFile()||!files.delete(relative))throw failure();
      }
    }finally{dir.closeSync();}
  }
  if(files.size||dirs.size)throw failure();
}
function writeBytes(root:string,name:string,bytes:Buffer){
  const path=diskFile(root,name,true),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|noFollow,0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  syncDirectory(dirname(path));
}
function layout(content:PortableFiles){
  const result=new Map<string,string[]>(),names=new Set<string>();
  for(const skill of content.skills){
    const safe=/^[\p{L}\p{N}][\p{L}\p{N} _.()-]*$/u.test(skill.name)&&Buffer.byteLength(skill.name)<=96&&isPortableDocumentName(skill.name+'/SKILL.md');
    let name=safe?skill.name:'skill-'+skill.itemId;
    while(names.has(canonicalCaselessSegment(name)))name+='-'+skill.itemId;
    names.add(canonicalCaselessSegment(name));
    for(const id of skill.fileIds){
      const file=content.files.find(item=>item.itemId===id);
      if(!file||!isPortableDocumentName(file.name))throw failure();
      const paths=result.get(id)??[];
      paths.push('skills/'+name+'/'+file.name);result.set(id,paths);
    }
  }
  return result;
}
function partPath(part:LocalRecipeDraftRecord['members'][number]['descriptor']){
  return part.kind==='finalLogo'?'logo.webp':'parts/'+uuid.parse(part.objectId)+'.txt';
}
function encode(record:LocalRecipeDraftRecord,recordSha256:string){
  const {draft,members,sourceCanonical,...privateData}=record;
  const files=new Map<string,Buffer>(),current=new Set<string>();
  let manifest:Manifest;
  if(draft.format==='rich-v2'){
    const content=draft.rich.content,locations=layout(content);
    const bytes=new Map(members.map(m=>[m.descriptor.objectId,Buffer.from(m.base64,'base64')]));
    const partFiles=new Set<string>();
    const documents=content.files.map(({text,...file})=>{
      const paths=locations.get(file.itemId);
      if(!paths)throw failure();
      const data=text.kind==='inline'?Buffer.from(text.value):bytes.get(text.objectId);
      if(!data)throw failure();
      for(const path of paths)files.set(path,data);
      if(text.kind==='part')partFiles.add(text.objectId);
      return {...file,paths,...(text.kind==='part'&&{objectId:text.objectId})};
    });
    for(const part of content.parts){
      current.add(part.objectId);
      if(!partFiles.has(part.objectId))files.set(partPath(part),bytes.get(part.objectId)!);
    }
    manifest={format:'rich-v2',public:draft.public,config:{...content,files:documents}};
  }else manifest={format:'role-v1',public:draft.public,config:draft.config};
  const data=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  files.set('manifest.json',data);
  const index:DirectoryIndex={storage:'recipe-directory-v1',recordSha256,manifestSha256:hash(data),private:privateData,
    draft:{draftId:draft.draftId,recipeId:draft.recipeId,revision:draft.revision,...(draft.format&&{format:draft.format}),
      ...(draft.sourceIntentId&&{sourceIntentId:draft.sourceIntentId})},
    ...(draft.logo&&{hasLogo:true}),...(sourceCanonical&&
      (draft.format==='rich-v2'&&sourceCanonical===draft.rich.canonical?{sourceIsCurrent:true}:{sourceCanonical})),
    members:members.map(member=>current.has(member.descriptor.objectId)?{descriptor:member.descriptor}:member)};
  return {files,index};
}
type DirectoryLocation={recordSha256:string;draft:{revision:number}};
function directory(root:string,account:string,draft:string,index:DirectoryLocation,create:boolean){
  const parent=childDir(childDir(childDir(root,'recipes',create),uuid.parse(account),create),uuid.parse(draft),create);
  const revision=z.number().int().positive().safe().parse(index.draft.revision);
  const name='r'+revision+'-'+sha.parse(index.recordSha256);
  return {parent,path:join(parent,name)};
}
export function recipeDirectoryPath(root:string,account:string,draft:string,index:DirectoryLocation){
  return checkedDir(directory(root,account,draft,index,false).path);
}
export function readRecipeDirectory(root:string,account:string,draftId:string,index:DirectoryIndex):LocalRecipeDraftRecord{
  const path=recipeDirectoryPath(root,account,draftId,index),bytes=readBytes(path,'manifest.json',8*1024*1024);
  if(hash(bytes)!==index.manifestSha256)throw failure();
  const manifest=manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if(manifest.format==='role-v1'){
    if(index.draft.format==='rich-v2'||index.draft.sourceIntentId||index.members.length)throw failure();
    verifyTree(path,['manifest.json']);
    const {draftId,recipeId,revision,format}=index.draft;
    return {...index.private,draft:{draftId,recipeId,revision,...(format&&{format}),public:manifest.public,config:manifest.config},members:[]};
  }
  const config=manifest.config,locations=layout(config),parts=new Map<string,Buffer>();
  const diskFiles=new Set(['manifest.json']);
  const files=config.files.map(({paths,objectId,...file})=>{
    const expected=locations.get(file.itemId);
    if(!expected||JSON.stringify(expected)!==JSON.stringify(paths))throw failure();
    for(const name of paths)diskFiles.add(name);
    const data=readBytes(path,paths[0]!,RECIPE_RICH_LIMITS.fileBytes);
    for(const duplicate of paths.slice(1))if(!readBytes(path,duplicate,RECIPE_RICH_LIMITS.fileBytes).equals(data))throw failure();
    if(objectId){
      const previous=parts.get(objectId);
      if(previous&&!data.equals(previous))throw failure();
      parts.set(objectId,data);
    }
    return {...file,text:objectId?{kind:'part' as const,objectId}:{kind:'inline' as const,value:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data)}};
  });
  const doc=canonicalizeRichRecipeContent({...config,files}),canonical=Buffer.from(doc.canonicalUTF8).toString('base64url');
  const texts:Record<string,string>={};
  for(const part of doc.content.parts){
    if(!parts.has(part.objectId))diskFiles.add(partPath(part));
    const data=parts.get(part.objectId)??readBytes(path,partPath(part),part.bytes);
    if(data.length!==part.bytes||hash(data)!==part.sha256)throw failure();
    parts.set(part.objectId,data);
    if(part.kind==='text')texts[part.objectId]=new TextDecoder('utf-8',{fatal:true}).decode(data);
  }
  verifyTree(path,diskFiles);
  const members=index.members.map(m=>{
    const data=parts.get(m.descriptor.objectId);
    if(data)return {descriptor:m.descriptor,base64:data.toString('base64')};
    if(m.base64===undefined)throw failure();
    return {descriptor:m.descriptor,base64:m.base64};
  });
  if(index.draft.format!=='rich-v2'||!index.draft.sourceIntentId)throw failure();
  const logo=doc.content.finalLogo&&parts.get(doc.content.finalLogo.objectId);
  return {...index.private,...(index.sourceIsCurrent?{sourceCanonical:canonical}:index.sourceCanonical&&{sourceCanonical:index.sourceCanonical}),
    draft:{...index.draft,format:'rich-v2',sourceIntentId:index.draft.sourceIntentId,public:manifest.public,rich:{content:doc.content,canonical,texts},
      ...(index.hasLogo&&logo&&{logo:'data:image/webp;base64,'+logo.toString('base64')})},members};
}
/** An immutable, complete revision is durable before the SQLite transaction can make it current. */
export function writeRecipeDirectory(root:string,record:LocalRecipeDraftRecord,recordSha256:string){
  const {index,files}=encode(record,recordSha256),{parent,path}=directory(root,record.association.accountId,record.draft.draftId,index,true);
  if(existsSync(path)){
    verifyTree(checkedDir(path),files.keys());
    for(const [name,data] of files)if(!readBytes(path,name,data.length).equals(data))throw failure();
    return {index};
  }
  const pending=mkdtempSync(join(parent,'.preparing-'));
  try{
    checkedDir(pending);
    for(const [name,data] of files)writeBytes(pending,name,data);
    syncDirectory(pending);renameSync(pending,path);syncDirectory(parent);
  }catch(error){rmSync(pending,{recursive:true,force:true});throw error;}
  return {index,created:path};
}

import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import {folderTokenSchema,type FolderChoice,type FolderToken} from '../shared/bridge';
import {CoreError} from './projection';

export class FolderCapabilities {
  private readonly choices = new Map<FolderToken,{path:string;expires:number;windowId:number}>();
  async grant(path:string,windowId:number):Promise<FolderChoice> {
    const canonical=await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new CoreError('invalid-directory','请选择现有文件夹。');
    const token=folderTokenSchema.parse(randomUUID());
    if(this.choices.size>=32) this.choices.clear();
    this.choices.set(token,{path:canonical,expires:Date.now()+30*60_000,windowId});
    return {token,displayPath:canonical};
  }
  async resolve(token:FolderToken,windowId:number):Promise<string> {
    const choice=this.choices.get(token);
    if(!choice||choice.windowId!==windowId||choice.expires<Date.now()) throw new CoreError('folder-expired','文件夹选择已失效，请重新选择。');
    if(await realpath(choice.path)!==choice.path||!(await stat(choice.path)).isDirectory()) throw new CoreError('directory-changed','文件夹已移动或不可用，请重新选择。');
    return choice.path;
  }
  clear():void {this.choices.clear();}
}
export function authorizationUrl(value:string):string {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='auth.openai.com'||url.username||url.password||url.port) throw new CoreError('untrusted-url','授权地址不是受支持的官方地址。');
  return url.href;
}
export function trustedSender(sender:{id:number;url:string;isMainFrame:boolean},expected:{id:number;url:string}):boolean {
  return sender.id===expected.id&&sender.isMainFrame&&sender.url===expected.url;
}

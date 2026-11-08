import {Script} from 'node:vm';
import {isAbsolute} from 'node:path';
import type {CardDisplayBlock,CardDisplayConfig,CardDisplayValues} from '@vonvon/protocol';
import {OwnedProviderProcess,ProviderProcessStoppedError} from '../agent/owned-process';

const OUTPUT_LIMIT = 16_384;
const TIMEOUT_MS = 1_500;
const retainedEnv = new Set(['PATH','HOME','USERPROFILE','TMPDIR','TEMP','TMP','LANG','LC_ALL','USER','LOGNAME','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','APPDATA','LOCALAPPDATA']);
const reserved = new Set(['__proto__','prototype','constructor']);
type ProcessResult = {code:number;stdout:string};

/** Only these variables are inherited; provider/Feishu credentials are not. */
function scriptEnvironment(): NodeJS.ProcessEnv {
  return {...Object.fromEntries(Object.entries(process.env).filter(([key])=>retainedEnv.has(key.toUpperCase()))),ELECTRON_RUN_AS_NODE:'1'};
}

function boundedProcess(command:string,args:string[],input:string,cwd:string,signal?:AbortSignal):Promise<ProcessResult> {
  return new Promise((resolve,reject)=>{
    if (signal?.aborted) {reject(new Error('脚本已取消'));return;}
    const options={cwd,env:scriptEnvironment(),stdio:['pipe','pipe','pipe'] as ['pipe','pipe','pipe']};
    // Windows needs a Job from the first instruction: taskkill cannot recover
    // descendants after the helper's parent process has already exited.
    // The same owner registry also joins graceful host/Bot shutdown on POSIX.
    const owned=new OwnedProviderProcess(command,args,options,'卡片脚本');
    const child=owned.child;
    let stdout='',bytes=0,settled=false,finishing=false,terminalError:Error|undefined;
    const finish=async(error?:Error,code=0)=>{
      terminalError??=error;
      if(error)settled=true;
      if(finishing)return;
      finishing=true;settled=Boolean(error);clearTimeout(timer);signal?.removeEventListener('abort',abort);
      // A helper may have spawned descendants. Reap the owned group on all exits.
      try{await owned.close(0);}catch(error){
        // A forced stop can report an error with the entire tree confirmed gone.
        // A genuinely unconfirmed cleanup must remain visible to the caller.
        if(!(error instanceof ProviderProcessStoppedError))terminalError??=new Error('脚本进程清理未成功完成');
      }
      settled=true;
      if(terminalError)reject(terminalError);else resolve({code,stdout});
    };
    const abort=()=>{void finish(new Error('脚本已取消'));};
    const timer=setTimeout(()=>{void finish(new Error('脚本超过 1.5 秒，已停止'));},TIMEOUT_MS);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data',(chunk:string)=>{if(settled)return;bytes+=Buffer.byteLength(chunk);if(bytes>OUTPUT_LIMIT){void finish(new Error('脚本输出超过 16 KB'));return;}stdout+=chunk;});
    // Drain, but never include stderr (which can contain user data) in logs/errors.
    child.stderr?.on('data',(chunk:Buffer)=>{if(settled)return;bytes+=chunk.length;if(bytes>OUTPUT_LIMIT)void finish(new Error('脚本输出超过 16 KB'));});
    child.once('error',()=>{void finish(new Error('脚本运行环境不可用，请检查所选语言是否已安装'));});
    child.once('close',code=>{void finish(code===0?undefined:new Error(`脚本未成功退出（${code ?? '未知'}）`),code??-1);});
    void owned.exited.then(exit=>finish(exit.code===0?undefined:new Error('脚本未成功退出'),exit.code??-1),()=>finish(new Error('脚本运行环境不可用，请检查所选语言是否已安装')));
    child.stdin?.on('error',()=>undefined);
    child.stdin?.end(input);
  });
}

function shellCommand():string {return process.platform==='win32'?'bash':'/bin/sh';}
function powershellCommand():string {return process.platform==='win32'?'powershell.exe':'pwsh';}

/** Syntax-only: configuration checks must not run user scripts as a side effect. */
export async function checkCardDisplayScriptSyntax(block:CardDisplayBlock,signal?:AbortSignal):Promise<void> {
  if(signal?.aborted)throw new Error('脚本已取消');
  if(block.source!=='script'||block.mode==='off')return;
  try {
    if(block.language==='node') {
      new Script(block.script,{filename:`card-display-${block.id}.cjs`});
    } else if(block.language==='shell') {
      await boundedProcess(shellCommand(),['-n'],block.script,process.cwd(),signal);
    } else {
      const parse='$s=[Console]::In.ReadToEnd();$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);if($e.Count){exit 1}';
      await boundedProcess(powershellCommand(),['-NoLogo','-NoProfile','-NonInteractive','-Command',parse],block.script,process.cwd(),signal);
    }
  } catch(error) {
    const detail=block.language==='node'&&error instanceof SyntaxError?error.message.slice(0,160):'请检查脚本语法和所选语言是否已安装';
    throw new Error(`“${block.name}”脚本检查未通过：${detail}`);
  }
}

function parseOutput(text:string):Record<string,unknown> {
  const value:unknown=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('脚本需输出一个 JSON 对象');
  const walk=(item:unknown,depth:number):void=>{
    if(depth>4)throw new Error('脚本输出嵌套过深');
    if(item===null||typeof item!=='object')return;
    const entries=Object.entries(item);
    if(entries.length>64)throw new Error('脚本输出字段过多');
    for(const [key,child]of entries){if(reserved.has(key)||!/^\w+$/.test(key))throw new Error('脚本输出包含无效字段名');walk(child,depth+1);}
  };
  walk(value,0);return value as Record<string,unknown>;
}

export type CardDisplayScriptResult={values:Record<string,Record<string,unknown>>;errors:{id:string;message:string}[]};
/** Bounded helpers, not a security sandbox. Failures hide only the custom widget. */
export async function runCardDisplayScripts(config:CardDisplayConfig,options:{cwd:string;values:CardDisplayValues;signal?:AbortSignal}):Promise<CardDisplayScriptResult> {
  const result:CardDisplayScriptResult={values:{},errors:[]};
  const blocks=config.blocks.filter(block=>block.kind==='custom'&&block.source==='script'&&block.mode!=='off');
  if(!blocks.length)return result;
  if(!isAbsolute(options.cwd))return {values:{},errors:blocks.map(block=>({id:block.id,message:'脚本工作目录必须是绝对路径'}))};
  let input:string;
  try {input=JSON.stringify({...options.values,cwd:options.cwd});}
  catch {return {values:{},errors:blocks.map(block=>({id:block.id,message:'脚本输入无法序列化'}))};}
  if(Buffer.byteLength(input)>OUTPUT_LIMIT)return {values:{},errors:blocks.map(block=>({id:block.id,message:'脚本输入过大'}))};
  let next=0;
  const worker=async()=>{
    while(next<blocks.length){
      const block=blocks[next++]!;
      try {
        let output:ProcessResult;
        if(block.language==='node')output=await boundedProcess(process.execPath,['--input-type=commonjs','-e',block.script],input,options.cwd,options.signal);
        else if(block.language==='shell')output=await boundedProcess(shellCommand(),['-c',block.script],input,options.cwd,options.signal);
        else output=await boundedProcess(powershellCommand(),['-NoLogo','-NoProfile','-NonInteractive','-Command',block.script],input,options.cwd,options.signal);
        result.values[block.id]=parseOutput(output.stdout);
      }catch(error){result.errors.push({id:block.id,message:error instanceof Error&&!(error instanceof SyntaxError)?error.message:'脚本未输出有效 JSON 对象'});}
    }
  };
  await Promise.all(Array.from({length:Math.min(2,blocks.length)},worker));
  return result;
}

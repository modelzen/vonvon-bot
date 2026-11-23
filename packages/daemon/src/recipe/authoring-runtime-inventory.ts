import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from '../agent/codex-appserver/app-server-client';
import { resolveCodexBin } from '../agent/codex-appserver/locate';
import type { ConfigReadResponse } from '../agent/codex-appserver/protocol';
import { claudeConfigDir, readConfiguredClaudeModel } from '../agent/claude-agent/configured-model';
import { groupBackendId, resolveModelPreference } from '../config/execution';
import type { AppConfig } from '../config/schema';
import { nativeMcpPath } from '../environment/mcp';
import type { Project } from '../project/registry';

export interface RecipeRuntimeInventory {
  provider:string;
  model:string|null;
  modelProvider?:string;
  tools:string[];
  mcp:{name:string;enabled:boolean}[];
  mcpStatus:'available'|'unavailable';
}

const record = (value:unknown):Record<string,unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const label = (value:unknown) => typeof value === 'string' && /^[\w.\u3400-\u9fff:/-]{1,128}$/u.test(value) ? value : undefined;

// Only names and enablement leave the runtime. Provider commands, arguments, URLs and credentials stay on the device.
export function recipeMcpNames(config:unknown):RecipeRuntimeInventory['mcp'] {
  return Object.entries(record(config)).filter(([name])=>Boolean(label(name))).map(([name,value])=>({
    name,enabled:record(value).enabled!==false && record(value).disabled!==true,
  })).sort((a,b)=>a.name.localeCompare(b.name));
}

async function jsonFile(file:string):Promise<Record<string,unknown>> {
  const input=await open(file,constants.O_RDONLY|constants.O_NONBLOCK).catch((error:NodeJS.ErrnoException)=>{
    if(error.code!=='ENOENT')throw error;
  });
  if(!input)return {};
  try{
    const stat=await input.stat();
    if(!stat.isFile()||stat.size>4*1024*1024)throw new Error('Provider 配置无法读取');
    const bytes=await input.readFile('utf8');
    if(Buffer.byteLength(bytes)>4*1024*1024)throw new Error('Provider 配置过大');
    return record(JSON.parse(bytes));
  }finally{await input.close();}
}

async function codexSettings(cwd:string) {
  const bin=resolveCodexBin();
  if(!bin)throw new Error('Codex unavailable');
  const client=new AppServerClient({bin,cwd,clientName:'vonvon-recipe-inventory',quietOutput:true,initializeTimeoutMs:8000});
  try {
    await client.connect();
    const {config}=await client.request<ConfigReadResponse>('config/read',{cwd,includeLayers:false},8000);
    return {model:label(config.model),modelProvider:label(config.model_provider),mcp:recipeMcpNames(config.mcp_servers)};
  }finally{await client.close();}
}

async function claudeSettings(cwd:string) {
  const home=homedir(),env=process.env;
  const [user,project,globalSettings,projectSettings,localSettings]=await Promise.all([
    jsonFile(nativeMcpPath('claude',home,env)),jsonFile(join(cwd,'.mcp.json')),
    jsonFile(join(claudeConfigDir(env,home),'settings.json')),jsonFile(join(cwd,'.claude','settings.json')),jsonFile(join(cwd,'.claude','settings.local.json')),
  ]);
  const local=record(record(user.projects)[cwd]),settings={...globalSettings,...projectSettings,...localSettings};
  const approved=new Set(Array.isArray(settings.enabledMcpjsonServers)?settings.enabledMcpjsonServers:[]);
  const disabled=new Set([...(Array.isArray(settings.disabledMcpjsonServers)?settings.disabledMcpjsonServers:[]),
    ...(Array.isArray(local.disabledMcpServers)?local.disabledMcpServers:[])]);
  const servers=new Map(recipeMcpNames(user.mcpServers).map(server=>[server.name,server]));
  for(const server of recipeMcpNames(project.mcpServers))servers.set(server.name,{...server,enabled:server.enabled&&(settings.enableAllProjectMcpServers===true||approved.has(server.name))});
  for(const server of recipeMcpNames(local.mcpServers))servers.set(server.name,server);
  const mcp=[...servers.values()].map(server=>({...server,enabled:server.enabled&&!disabled.has(server.name)})).sort((a,b)=>a.name.localeCompare(b.name));
  return {model:label(readConfiguredClaudeModel(env,home)),mcp};
}

export async function recipeRuntimeInventory(group:Project,bot:AppConfig['preferences'],tools:string[]):Promise<RecipeRuntimeInventory>{
  const provider=groupBackendId(group),model=resolveModelPreference({bot,group},provider)?.model;
  const base={provider,tools,model:model??null};
  try{
    const info=provider==='claude-agent'?await claudeSettings(group.cwd):await codexSettings(group.cwd);
    return {...base,...info,model:model??info.model??null,mcpStatus:'available'};
  }catch{return {...base,mcp:[],mcpStatus:'unavailable'};}
}

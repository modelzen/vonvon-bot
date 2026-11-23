import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as bots from '../src/config/bots';
import type { AppConfig } from '../src/config/schema';
import { NativeFeedbackIm } from '../src/feedback/im';
import { getProjectByChatIdSync } from '../src/project/registry';
import { ReleaseCodeConnections } from '../src/release-code/connection';
import { bridgeReleaseCode } from '../src/release-code/host';

const temp = vi.hoisted(() => ({root:''}));
vi.mock('../src/config/paths', async original => {
  const existing = await original<typeof import('../src/config/paths')>();
  return {...existing, paths:{get appDir() {return temp.root;}},
    botPaths:() => ({projectsFile:join(temp.root,'projects.json')})};
});

const appId = 'cli_fixture';
const identity = {appId,tenant:'feishu' as const,createdAt:1,registrationId:randomUUID()};
const cfg: AppConfig = {accounts:{app:{id:appId,secret:'fixture',tenant:'feishu'}},
  preferences:{access:{admins:['ou_admin']}}};
const help = 'oc_help', other = 'oc_other';

function message(openId:string, content:string, chatId=help, chatType:'group' | 'p2p'='group'):NormalizedMessage {
  const messageId='om_' + randomUUID();
  return {messageId,chatId,senderId:openId,chatType,content,rawContentType:'text',
    raw:{sender:{sender_type:'user',tenant_key:'org',sender_id:{open_id:openId}},
      message:{message_id:messageId,chat_id:chatId,chat_type:chatType}},
    resources:[],mentions:[],mentionAll:false,mentionedBot:true,createTime:1};
}
beforeEach(async () => {
  temp.root=await mkdtemp(join(tmpdir(),'vonvon-code-host-'));
  await writeFile(join(temp.root,'projects.json'),JSON.stringify({projects:[help,other].map(chatId =>
    ({name:chatId,chatId,cwd:temp.root,blank:true,createdAt:1}))}));
  vi.spyOn(bots,'assertBotIdentity').mockResolvedValue();
  vi.spyOn(bots,'withRegisteredBot').mockImplementation((_app,op)=>op(identity));
});
afterEach(async()=>{vi.restoreAllMocks();await rm(temp.root,{recursive:true,force:true});});
function setup() {
  const reply=vi.spyOn(NativeFeedbackIm.prototype,'reply').mockResolvedValue();
  const host=bridgeReleaseCode(identity,cfg,{rawClient:{}} as LarkChannel);
  const row=(chatId=help)=>getProjectByChatIdSync(chatId,join(temp.root,'projects.json'))!;
  return {reply,host,row};
}

it('only an administrator can enable the opted-in group; disabling revokes saved and in-flight reads',async()=>{
  const {host,row,reply}=setup();
  try {
    await host.onMessage(message('ou_member','/feedback code on'));
    expect(reply.mock.calls.at(-1)?.[1]).toContain('管理员');
    expect(host.enabled(help)).toBe(false);
    await host.onMessage(message('ou_admin','/feedback code on'));
    expect(host.enabled(help)).toBe(true);
    expect(host.enabled(other)).toBe(false);
    const initial=row().releaseCode;
    await host.onMessage(message('ou_admin','/feedback code on'));
    expect(row().releaseCode).toEqual(initial);
    const bound=host.bind(message('ou_member','查源码'),row())!;
    expect(host.bind(message('ou_member','查源码',other),row(other))).toBeUndefined();
    await host.onMessage(message('ou_member','/feedback code off'));
    expect(host.enabled(help)).toBe(true);
    let resume!:()=>void;
    const hold=new Promise<void>(resolve=>{resume=resolve;});
    const upstream=vi.spyOn(ReleaseCodeConnections.prototype,'call').mockImplementation(async()=>{
      await hold;return 'unreleased result';
    });
    const pending=bound.call('read',{path:'README.md'},new AbortController().signal,()=>{});
    await vi.waitFor(()=>expect(upstream).toHaveBeenCalledOnce());
    await host.onMessage(message('ou_admin','/feedback code off'));
    resume();
    await expect(pending).rejects.toThrow('配置已变化');
    await expect(bound.call('rg',{argv:['--files']},new AbortController().signal,()=>{})).rejects.toThrow('配置已变化');
    expect(upstream).toHaveBeenCalledOnce();
    expect(host.enabled(help)).toBe(false);
  } finally {host.close();}
});

it('pairs each group query with its author’s private login and rejects inconsistent sender metadata',async()=>{
  const {host,row}=setup();
  const begin=vi.spyOn(ReleaseCodeConnections.prototype,'begin').mockResolvedValue('login');
  const query=vi.spyOn(ReleaseCodeConnections.prototype,'call').mockResolvedValue('reply');
  try {
    await host.onMessage(message('ou_admin','/feedback code on'));
    await host.onMessage(message('ou_alice','/feedback code login'));
    expect(begin).not.toHaveBeenCalled();
    for (const id of ['ou_alice','ou_bob']) {
      await host.onMessage(message(id,'/feedback code login','oc_private','p2p'));
      const msg=message(id,'查源码');
      await host.bind(msg,row())!.call('rg',{argv:['--files']},new AbortController().signal,()=>{});
      expect(host.bind({...msg,senderId:'ou_forged'},row())).toBeUndefined();
    }
    const principals=begin.mock.calls.map(([key])=>key);
    expect(new Set(principals).size).toBe(2);
    expect(query.mock.calls.map(([key])=>key)).toEqual(principals);
  } finally {host.close();}
});

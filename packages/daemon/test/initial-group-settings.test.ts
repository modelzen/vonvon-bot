import {describe,expect,it,vi} from 'vitest';
import {DEFAULT_SMART_RULES} from '@vonvon/protocol';
import {prepareNewGroupSettings} from '../src/project/initial-settings';
import {parseBindGroupInput} from '../src/admin/groups';
import {parseCollaborationRequest} from '../src/admin/collaboration';
import type {ModelInfo} from '../src/agent/types';

const models:ModelInfo[]=[{id:'work-model',displayName:'Work',description:'',isDefault:true,hidden:false,supportedEfforts:['low','high'],defaultEffort:'low'}];
const helper=()=>({backendFor:vi.fn((_id:string)=>({peekModels:()=>models,listModels:vi.fn(async()=>models)})),readKey:vi.fn(async()=>undefined as string|undefined)});
describe('new group configuration admission',()=>{
  it('freezes explicit group settings without depending on Bot defaults',async()=>{
    const settings=await prepareNewGroupSettings({backend:'codex-appserver',kind:'multi'},helper());
    expect(settings.modelAccess).toEqual({backend:'codex-appserver',models:['work-model'],efforts:['low','high']});
    expect(settings.profile).toEqual({persona:'',memory:'',inheritPersona:true,inheritMemory:true});
    expect(settings.skills).toEqual({disabledPaths:[]});
    expect(settings.smartRules).toEqual(DEFAULT_SMART_RULES);
  });
  it('admits smart creation without a group override so the runtime inherits Bot or Provider defaults',async()=>{
    const deps=helper();
    const settings=await prepareNewGroupSettings({backend:'codex-appserver',kind:'smart'},deps);
    expect(settings.judge).toBeUndefined();
    expect(settings.modelAccess).toEqual({backend:'codex-appserver',models:['work-model'],efforts:['low','high']});
    expect(deps.backendFor).toHaveBeenCalledTimes(1);
    expect(deps.readKey).not.toHaveBeenCalled();
    expect(parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart'})).not.toHaveProperty('judge');
    expect(parseCollaborationRequest({action:'createProject',requestId:'a'.repeat(20),name:'a',backend:'codex-appserver',kind:'smart'})).not.toHaveProperty('judge');
  });
  it('keeps a cross-provider decision separate from the working model',async()=>{
    const deps=helper();
    const judge={kind:'llm' as const,backend:'claude-agent' as const,model:'work-model',effort:'high' as const};
    const settings=await prepareNewGroupSettings({backend:'codex-appserver',kind:'smart',judge},deps);
    expect(settings.judge).toEqual(judge);
    expect(settings.modelAccess?.backend).toBe('codex-appserver');
    expect(deps.backendFor.mock.calls.map(call=>call[0])).toEqual(['codex-appserver','claude-agent']);
    await expect(prepareNewGroupSettings({backend:'codex-appserver',kind:'smart',judge:{...judge,effort:'ultra'}},deps)).rejects.toThrow('Effort');
  });
  it('refuses Jev until its shared credential exists without sending a request',async()=>{
    const deps=helper();
    const input={backend:'codex-appserver',kind:'smart' as const,judge:{kind:'decision' as const,provider:'typesafe',model:'jev-latest'}};
    await expect(prepareNewGroupSettings(input,deps)).rejects.toThrow('密钥');
    deps.readKey.mockResolvedValue('fixture-key');
    expect((await prepareNewGroupSettings(input,deps)).judge).toEqual(input.judge);
    expect(deps.readKey).toHaveBeenLastCalledWith('typesafe-api-key');
  });
  it('validates and preserves decision fields in both admitted request paths',()=>{
    const judge={kind:'llm',backend:'codex-appserver',model:'work-model',effort:'low'};
    expect(parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart',judge})).toMatchObject({judge});
    expect(parseCollaborationRequest({action:'createProject',requestId:'a'.repeat(20),name:'a',backend:'codex-appserver',kind:'smart',judge})).toMatchObject({judge});
    expect(()=>parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart',judge:{...judge,command:'bad'}})).toThrow('设置无效');
  });
});

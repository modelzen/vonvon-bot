import {describe,expect,it,vi} from 'vitest';
import {DEFAULT_SMART_RULES} from '@vonvon/protocol';
import {prepareNewGroupSettings} from '../src/project/initial-settings';
import type {JudgeModels} from '../src/judge/global-models';
import {parseBindGroupInput} from '../src/admin/groups';
import {parseCollaborationRequest} from '../src/admin/collaboration';
import type {ModelInfo} from '../src/agent/types';

const models:ModelInfo[]=[{id:'work-model',displayName:'Work',description:'',isDefault:true,hidden:false,supportedEfforts:['low','high'],defaultEffort:'low'}];
const helper=()=>({backendFor:vi.fn((_id:string)=>({peekModels:()=>models,listModels:vi.fn(async()=>models),loginStatus:vi.fn(async()=>({state:'signedIn' as 'signedIn'|'signedOut',message:''}))})),readKey:vi.fn(async()=>undefined as string|undefined),readJudgeModels:vi.fn(async():Promise<JudgeModels>=>({byProvider:{}}))});
describe('new group configuration admission',()=>{
  it('freezes explicit group settings without depending on Bot defaults',async()=>{
    const settings=await prepareNewGroupSettings({backend:'codex-appserver',kind:'multi'},helper());
    expect(settings.modelAccess).toEqual({backend:'codex-appserver',models:['work-model'],efforts:['low','high']});
    // no `profile`: the role is the bot's file and the supplement and memory start empty (P4a)
    expect(settings.profile).toBeUndefined();
    expect(settings.judge).toEqual({kind:'default'});
    expect(settings.skills).toEqual({disabledPaths:[]});
    expect(settings.smartRules).toEqual(DEFAULT_SMART_RULES);
  });
  it('non-smart groups keep the host marker without requiring a configured decision provider',async()=>{
    const deps=helper();
    deps.readJudgeModels.mockRejectedValue(new Error('unavailable'));
    expect((await prepareNewGroupSettings({backend:'codex-appserver',kind:'multi'},deps)).judge).toEqual({kind:'default'});
    expect(deps.readJudgeModels).not.toHaveBeenCalled();
  });
  it('admits smart creation using the validated host default marker',async()=>{
    const deps=helper();
    const settings=await prepareNewGroupSettings({backend:'codex-appserver',kind:'smart'},deps);
    expect(settings.judge).toEqual({kind:'default'});
    expect(settings.modelAccess).toEqual({backend:'codex-appserver',models:['work-model'],efforts:['low','high']});
    expect(deps.backendFor).toHaveBeenCalledTimes(2);
    expect(deps.readKey).not.toHaveBeenCalled();
    expect(parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart'})).not.toHaveProperty('judge');
    expect(parseCollaborationRequest({action:'createProject',requestId:'a'.repeat(20),name:'a',backend:'codex-appserver',kind:'smart'})).not.toHaveProperty('judge');
  });
  it('validates explicit and implicit global defaults without selecting a fallback provider', async()=>{
    const deps=helper();
    deps.readJudgeModels.mockResolvedValue({defaultProvider:'typesafe',byProvider:{typesafe:{model:'jev-latest'}}});
    const input={backend:'codex-appserver',kind:'smart' as const};
    await expect(prepareNewGroupSettings(input,deps)).rejects.toThrow('密钥');
    await expect(prepareNewGroupSettings({...input,judge:{kind:'default'}},deps)).rejects.toThrow('密钥');
    deps.readKey.mockResolvedValue('fixture-key');
    expect((await prepareNewGroupSettings(input,deps)).judge).toEqual({kind:'default'});
    expect(deps.backendFor.mock.calls.every(([id])=>id==='codex-appserver')).toBe(true);
    deps.readJudgeModels.mockResolvedValue({defaultProvider:'claude-agent',byProvider:{}});
    deps.backendFor.mockImplementation(id=>({peekModels:()=>id==='claude-agent'?[]:models,listModels:vi.fn(async()=>[]),loginStatus:vi.fn(async()=>({state:'signedOut' as 'signedIn'|'signedOut',message:''}))}));
    await expect(prepareNewGroupSettings(input,deps)).rejects.toThrow('尚未登录');
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
    expect(parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart',judge:{kind:'default'}})).toMatchObject({judge:{kind:'default'}});
    expect(parseCollaborationRequest({action:'createProject',requestId:'a'.repeat(20),name:'a',backend:'codex-appserver',kind:'smart',judge:{kind:'default'}})).toMatchObject({judge:{kind:'default'}});
    expect(parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart',judge})).toMatchObject({judge});
    expect(parseCollaborationRequest({action:'createProject',requestId:'a'.repeat(20),name:'a',backend:'codex-appserver',kind:'smart',judge})).toMatchObject({judge});
    expect(()=>parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart',judge:{...judge,command:'bad'}})).toThrow('设置无效');
  });
  it('accepts a provider-only group choice and checks its current shared credential', async()=>{
    const deps=helper();
    const judge={kind:'provider' as const,provider:'typesafe' as const};
    await expect(prepareNewGroupSettings({backend:'codex-appserver',kind:'smart',judge},deps)).rejects.toThrow('密钥');
    deps.readKey.mockResolvedValue('fixture-key');
    expect((await prepareNewGroupSettings({backend:'codex-appserver',kind:'smart',judge},deps)).judge).toEqual(judge);
    expect(parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart',judge})).toMatchObject({judge});
    expect(()=>parseBindGroupInput({chatId:'oc_a',projectName:'a',backend:'codex-appserver',kind:'smart',judge:{...judge,model:'jev-latest'}})).toThrow('设置无效');
  });
  it('accepts a Provider default from its live catalog when Luna is absent', async()=>{
    const deps=helper();
    const judge={kind:'provider' as const,provider:'codex-appserver' as const};
    expect((await prepareNewGroupSettings({backend:'codex-appserver',kind:'smart',judge},deps)).judge).toEqual(judge);
  });
  it('rejects a selected Provider after its login expires', async()=>{
    const deps=helper();
    deps.backendFor.mockImplementation(()=>({peekModels:()=>models,listModels:vi.fn(async()=>models),loginStatus:vi.fn(async()=>({state:'signedOut' as 'signedIn'|'signedOut',message:''}))}));
    await expect(prepareNewGroupSettings({backend:'codex-appserver',kind:'smart',judge:{kind:'provider',provider:'claude-agent'}},deps)).rejects.toThrow('尚未登录');
  });
});

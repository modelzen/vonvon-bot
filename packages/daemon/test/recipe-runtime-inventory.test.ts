import {afterEach, expect, it, vi} from 'vitest';
import {recipeRuntimeInventory} from '../src/recipe/authoring-runtime-inventory';
import type {Project} from '../src/project/registry';

const rpc=vi.hoisted(()=>({connect:vi.fn(),request:vi.fn(),close:vi.fn()}));
vi.mock('../src/agent/codex-appserver/locate',()=>({resolveCodexBin:()=>'/fixture/codex'}));
vi.mock('../src/agent/codex-appserver/app-server-client',()=>({AppServerClient:class {
  connect=rpc.connect;request=rpc.request;close=rpc.close;
}}));
const group:Project={name:'团队周报',cwd:'/fixture/weekly',chatId:'oc_weekly',createdAt:1,blank:false};
afterEach(()=>vi.resetAllMocks());

it('reads the effective config for this project and only returns MCP names and enablement',async()=>{
  rpc.request.mockResolvedValue({config:{model:'fixture-model',model_provider:'team-provider',mcp_servers:{
    docs:{url:'https://private.invalid',bearer_token_env_var:'SECRET'},paused:{enabled:false,env:{key:'PRIVATE'}},
  }}});
  expect(await recipeRuntimeInventory(group,{},['session_info'])).toEqual({
    provider:'codex-appserver',modelProvider:'team-provider',model:'fixture-model',tools:['session_info'],
    mcpStatus:'available',mcp:[{name:'docs',enabled:true},{name:'paused',enabled:false}],
  });
  expect(rpc.request).toHaveBeenCalledWith('config/read',{cwd:'/fixture/weekly',includeLayers:false},8000);
  expect(rpc.close).toHaveBeenCalledOnce();
});
it('keeps the group model and marks missing provider evidence explicitly',async()=>{
  rpc.request.mockRejectedValue(new Error('offline'));
  expect(await recipeRuntimeInventory({...group,defaultModel:'group-model'},{},[])).toMatchObject({model:'group-model',mcpStatus:'unavailable',mcp:[]});
  expect(rpc.close).toHaveBeenCalledOnce();
});

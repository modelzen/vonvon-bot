import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DraftProviderBusy } from '../src/recipe/draft-instruction';
import { codexDraftParser } from '../src/recipe/codex-draft-parser';

let home:string;
const result = {kind:'proposal',changes:[{field:'name',action:'set',before:'',value:'周报'}]};
const model = 'fixture-model';
const input = {instruction:'把名称改成「周报」'};
const signal = () => AbortSignal.timeout(3000);
const fakeToken = (exp:number) => 'test.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.fixture';
const auth = (exp = Date.now()/1000+7200) => JSON.stringify({auth_mode:'chatgpt',tokens:{
  access_token:fakeToken(exp),account_id:'fixture-account',refresh_token:'SECRET-REFRESH',id_token:'SECRET-ID',
}});
const item = {type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(result)}]};
function stream(events:object[], contentType:string|null = 'text/event-stream') {
  const bytes = new TextEncoder().encode(events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join(''));
  return new Response(bytes,{headers:contentType === null ? {} : {'content-type':contentType}});
}
const ok = () => stream([{type:'response.metadata',metadata:{}},{type:'response.output_item.done',item},{type:'response.completed',response:{id:'fixture',status:'completed',output:[item]}}]);
const selected = async () => ({backend:'codex-appserver',model});

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(),'vonvon-draft-model-test-')));
  await Promise.all([writeFile(join(home,'auth.json'),auth()),writeFile(join(home,'config.toml'),'model="'+model+'"\n'),
    writeFile(join(home,'models_cache.json'),JSON.stringify({models:[{slug:model,use_responses_lite:true}]})),
    writeFile(join(home,'AGENTS.md'),'UNSELECTED_GLOBAL_INSTRUCTIONS'),writeFile(join(home,'MEMORY.md'),'UNSELECTED_MEMORY')]);
});
afterEach(async()=>{await rm(home,{force:true,recursive:true});});

it('sends one bounded Responses request with two messages, the selected model, access and account only',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(ok());
  const before=await readFile(join(home,'auth.json'));
  expect(await codexDraftParser(selected,{home,env:{},fetch:request}).propose(input,signal())).toEqual(result);
  expect(request).toHaveBeenCalledTimes(1);
  const [url,options]=request.mock.calls[0]!;
  expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(options).toMatchObject({method:'POST',redirect:'error'});
  expect(options!.signal).toBeInstanceOf(AbortSignal);
  const headers=new Headers(options!.headers);
  expect(headers.get('authorization')).toBe('Bearer '+JSON.parse(before.toString()).tokens.access_token);
  expect(headers.get('ChatGPT-Account-ID')).toBe('fixture-account');
  expect(headers.get('x-openai-internal-codex-responses-lite')).toBe('true');
  const body=JSON.parse(String(options!.body));
  expect(body).toMatchObject({model,store:false,reasoning:{context:'all_turns',effort:'low'},stream:true,tool_choice:'none',parallel_tool_calls:false,text:{format:{type:'json_schema',strict:true}}});
  expect(body.input).toHaveLength(2);expect(body.input.map((m:{role:string})=>m.role)).toEqual(['developer','user']);
  expect(JSON.parse(body.input[1].content[0].text)).toEqual(input);
  expect(body).not.toHaveProperty('tools');
  for(const leak of ['UNSELECTED',home,'SECRET-REFRESH','SECRET-ID','previous_response_id','fixture-account']) expect(String(options!.body)).not.toContain(leak);
  expect(await readFile(join(home,'auth.json'))).toEqual(before);
});
it('keeps a non-Lite model on the regular response profile',async()=>{
  await writeFile(join(home,'models_cache.json'),JSON.stringify({models:[{slug:model}]}));
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(ok());
  await codexDraftParser(selected,{home,env:{},fetch:request}).propose(input,signal());
  const [,opts]=request.mock.calls[0]!;
  expect(new Headers(opts!.headers).has('x-openai-internal-codex-responses-lite')).toBe(false);
  expect(JSON.parse(String(opts!.body)).reasoning).toEqual({effort:'low'});
});
it('accepts the observed headerless Codex SSE message and completed response',async()=>{
  const proposal = {kind:'proposal',changes:[{field:'name',action:'set',before:'',value:'每周项目简报'}]};
  const text = JSON.stringify(proposal);
  const output = {type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[],logprobs:[]}]};
  const response = stream([
    {type:'response.created',response:{status:'in_progress'}},
    {type:'response.in_progress',response:{status:'in_progress'}},
    {type:'response.output_item.added',item:{type:'message',role:'assistant',content:[]}},
    {type:'response.content_part.added',part:{type:'output_text',text:''}},
    {type:'response.output_text.delta',delta:text},
    {type:'response.metadata',metadata:{}},
    {type:'response.output_text.done',text},
    {type:'response.content_part.done',part:output.content[0]},
    {type:'response.output_item.done',item:output},
    {type:'response.completed',response:{status:'completed',output:[output]}},
  ],null);
  expect(response.headers.has('content-type')).toBe(false);
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(response);
  expect(await codexDraftParser(selected,{home,env:{},fetch:request}).propose({instruction:'把名称改成「每周项目简报」'},signal())).toEqual(proposal);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(request.mock.calls[0]![1]).toMatchObject({redirect:'error'});
});
it.each(['application/json','text/plain','text/html',''])('rejects an explicit non-SSE Content-Type %j',async contentType=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(stream([
    {type:'response.output_item.done',item},{type:'response.completed',response:{status:'completed',output:[item]}},
  ],contentType));
  await expect(codexDraftParser(selected,{home,env:{},fetch:request}).propose(input,signal())).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([null,'text/event-stream'])('rejects an SSE body over 256 KiB with Content-Type %j',async contentType=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(stream([
    {type:'response.metadata',metadata:{padding:'x'.repeat(256*1024)}},
    {type:'response.output_item.done',item},{type:'response.completed',response:{status:'completed',output:[item]}},
  ],contentType));
  await expect(codexDraftParser(selected,{home,env:{},fetch:request}).propose(input,signal())).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it('never sends on an unsupported provider, stale login, redirected config, API key mode or missing selected model',async()=>{
  const request=vi.fn<typeof fetch>();
  const run = (backend='codex-appserver',id=model,env={}) => codexDraftParser(async()=>({backend,model:id}),{home,env,fetch:request}).propose(input,signal());
  await expect(run('claude-agent')).rejects.toThrow();
  await expect(run('codex-appserver','absent')).rejects.toThrow();
  await expect(run('codex-appserver',model,{CODEX_ACCESS_TOKEN:'an override'})).rejects.toThrow();
  await writeFile(join(home,'auth.json'),auth(Date.now()/1000+60));await expect(run()).rejects.toThrow();
  await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'some-key'}));await expect(run()).rejects.toThrow();
  await writeFile(join(home,'auth.json'),auth());await writeFile(join(home,'config.toml'),'model_provider="custom"');await expect(run()).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it.each([
  [{type:'response.output_item.done',item:{type:'function_call',name:'fake'}}],
  [{type:'response.output_item.done',item}],
  [{type:'response.completed',response:{status:'completed'}}],
  [{type:'response.output_item.done',item},{type:'response.incomplete',response:{status:'incomplete'}}],
  [{type:'response.output_item.done',item},{type:'response.completed',response:{status:'completed',output:[{type:'web_search_call'}]}}],
  [{type:'response.output_item.done',item},{type:'response.output_item.done',item},{type:'response.completed',response:{status:'completed'}}],
] as object[][])('fails closed on an incomplete or unexpected provider stream %#',async(...events)=>{
  for(const contentType of [null,'text/event-stream']) {
    const request=vi.fn<typeof fetch>().mockResolvedValueOnce(stream(events,contentType));
    await expect(codexDraftParser(selected,{home,env:{},fetch:request}).propose(input,signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it('handles the observed SSE overload without retry, fallback or a proposal',async()=>{
  const request=vi.fn<typeof fetch>().mockResolvedValueOnce(stream([
    {type:'response.created',response:{status:'in_progress'}},{type:'response.in_progress',response:{status:'in_progress'}},
    {type:'response.metadata',metadata:{}},{type:'error',error:{code:'server_is_overloaded',headers:{'retry-after':'306'}}},
    {type:'response.failed',response:{status:'failed',error:{code:'server_is_overloaded'}}},
  ]));
  await expect(codexDraftParser(selected,{home,env:{},fetch:request}).propose(input,signal())).rejects.toBeInstanceOf(DraftProviderBusy);
  expect(request).toHaveBeenCalledTimes(1);
});

it('screens instructions and revision-scoped text even when the transport port is called directly',async()=>{
  const request=vi.fn<typeof fetch>();
  const adapter=codexDraftParser(selected,{home,env:{},fetch:request});
  for(const text of ['把名称改成/Users/private/'+model, 'sk-'+'z'.repeat(32), '字'.repeat(2001)]) {
    await expect(adapter.propose({instruction:text},signal())).rejects.toThrow();
    await expect(adapter.propose({instruction:'改简介',current:{field:'summary',value:text}},signal())).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
});

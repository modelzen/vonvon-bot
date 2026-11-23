import {describe,expect,it,vi} from 'vitest';
import type {AccountStatus} from '@vonvon/protocol';
import {communityRequest} from '../src/community-api.js';
import type {NativeAccount} from '../src/account-session.js';

const accountId='11111111-1111-4111-8111-111111111111',recipeId='22222222-2222-4222-8222-222222222222',versionId='33333333-3333-4333-8333-333333333333';
const cursor='abcd.'+'a'.repeat(64);
const version={recipeId,versionId,revision:3,public:{name:'配方',summary:'简介',version:'v3',access:'coded'},format:'rich-v2',creator:{authorId:accountId,displayName:'当前昵称'},hasDisplayLogo:true,state:'withdrawn',owned:false,acquired:true};
const group={...version,versionCount:3};
function fixture(){
  let state:AccountStatus={kind:'signedIn',accountId,displayName:'昵称',provider:'github',persistence:'memory'};
  const listeners=new Set<(next:AccountStatus)=>void>();
  const account:NativeAccount={status:()=>state,onStatus:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    login:async()=>state,cancelLogin:async()=>state,logout:async()=>state,dispose:async()=>{},
    request:vi.fn(async()=>Response.json({items:[group],nextCursor:cursor})),publicRequest:vi.fn()};
  return {account,emit:(next:AccountStatus)=>{state=next;for(const listener of listeners)listener(next);},listeners};
}
describe('personal recipe groups boundary',()=>{
  it('reads metadata once without expanding grants, logos, bodies or local installation state',async()=>{
    const f=fixture();
    expect(await communityRequest(f.account,{type:'recipeGroups',accountId,scope:'all'})).toEqual({items:[group],nextCursor:cursor});
    expect(f.account.request).toHaveBeenCalledExactlyOnceWith(accountId,'/v2/me/recipe-groups?scope=all',{method:'GET'},expect.any(Function));
    expect(f.account.publicRequest).not.toHaveBeenCalled();expect(f.listeners.size).toBe(0);
    vi.mocked(f.account.request).mockResolvedValue(Response.json({items:[version],nextCursor:null}));
    expect(await communityRequest(f.account,{type:'recipeGroupVersions',accountId,scope:'acquired',recipeId,cursor})).toEqual({items:[version],nextCursor:null});
    expect(f.account.request).toHaveBeenLastCalledWith(accountId,`/v2/me/recipe-groups/${recipeId}/versions?scope=acquired&cursor=${cursor}`,{method:'GET'},expect.any(Function));
    expect(f.account.request).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid request fields and changed accounts before reading',async()=>{
    const f=fixture();
    for(const extra of [{scope:'other'},{cursor:versionId},{cursor:'a'.repeat(1601)},{path:'/v2/me/drafts'}])
      await expect(communityRequest(f.account,{type:'recipeGroups',accountId,scope:'all',...extra} as never)).rejects.toThrow();
    await expect(communityRequest(f.account,{type:'recipeGroups',accountId:recipeId,scope:'all'})).rejects.toThrow('账号已切换');
    expect(f.account.request).not.toHaveBeenCalled();
  });
  it('rejects source/body fields, wrong recipe options and invalid version counts',async()=>{
    const f=fixture();
    for(const item of [{...group,config:{role:'secret'}},{...group,manifest:{}},{...group,public:{...version.public,overview:'body'}},{...group,versionCount:0}]){
      vi.mocked(f.account.request).mockResolvedValue(Response.json({items:[item],nextCursor:null}));
      await expect(communityRequest(f.account,{type:'recipeGroups',accountId,scope:'all'})).rejects.toThrow();
    }
    vi.mocked(f.account.request).mockResolvedValue(Response.json({items:[{...version,recipeId:versionId}],nextCursor:null}));
    await expect(communityRequest(f.account,{type:'recipeGroupVersions',accountId,scope:'all',recipeId})).rejects.toThrow();
  });
  it('discards responses after logout and same-account relogin while the body is arriving',async()=>{
    const f=fixture();let controller!:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start(value){controller=value;}});
    vi.mocked(f.account.request).mockResolvedValue(new Response(body));
    const pending=communityRequest(f.account,{type:'recipeGroups',accountId,scope:'all'});
    await Promise.resolve();f.emit({kind:'signedOut'});
    f.emit({kind:'signedIn',accountId,displayName:'昵称',provider:'github',persistence:'memory'});
    controller.enqueue(new TextEncoder().encode(JSON.stringify({items:[group],nextCursor:null})));controller.close();
    await expect(pending).rejects.toThrow('账号已切换');expect(f.listeners.size).toBe(0);
  });
});

import {expect,it,vi} from 'vitest';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import {desktopSnapshotSchema} from '@vonvon/protocol';
import {GroupDirectory,type GroupDirectoryState} from '../src/GroupDirectory';

type Element = ReactElement<Record<string,any>>;
function nodes(node:ReactNode):Element[]{
  if(Array.isArray(node))return node.flatMap(nodes);
  if(!isValidElement<Record<string,any>>(node))return [];
  return [node,...nodes(node.props.children)];
}
const snapshot=desktopSnapshotSchema.parse({
  revision:1,observedAt:0,stale:false,host:{kind:'connected',ownership:'owned',version:'0.7.6'},
  agents:['cli_one','cli_two','cli_three'].map(id=>({id,name:'同名助手',enabled:true,running:true,connection:'connected',activation:'active'})),
  groups:[{id:'oc_one',name:'研发群'},{id:'oc_two',name:'另一个研发群'}],
  memberships:[['cli_one','oc_one'],['cli_two','oc_one'],['cli_three','oc_one'],['cli_one','oc_two']].map(([agentId,groupId],index)=>({id:JSON.stringify([agentId,groupId]),agentId,groupId,name:`项目${index}`,directory:'/tmp/review',backend:'codex-appserver',conversation:'threads',response:'mention',permission:{administrator:'full',member:'full',network:false},stale:false})),
  tools:[],jobs:[],application:{platform:'macos',version:'0.7.6',loginItem:false,dataPath:'/tmp/review'},
});
function harness(data=snapshot){
  let state:GroupDirectoryState={query:'',expanded:{}};
  const onMembership=vi.fn();
  const render=()=>nodes(GroupDirectory({snapshot:data,state,onStateChange:next=>{state=next;},statusFor:()=>({label:'已连接',tone:'success'}),onMembership}));
  return {render,onMembership,state:()=>state};
}
it('opens the exact membership for same-name Bots and a Bot reused in another group',()=>{
 const h=harness();const rows=h.render().filter(n=>n.props.className==='group-directory-bot');
 expect(rows).toHaveLength(4);
 rows.forEach((row,index)=>{row.props.onClick();expect(h.onMembership).toHaveBeenLastCalledWith(snapshot.memberships[index]!.id);});
});
it('keeps expand/collapse independent from navigation and remembers it through remounts',()=>{
 const h=harness();let all=h.render();let parent=all.find(n=>n.props.className==='group-directory-identity')!;
 expect(parent.props['aria-expanded']).toBe(true);parent.props.onClick();
 all=h.render();expect(all.find(n=>n.props.className==='group-directory-bots')!.props.hidden).toBe(true);
 expect(h.onMembership).not.toHaveBeenCalled();
 parent=all.find(n=>n.props.className==='group-directory-identity')!;
 parent.props.onKeyDown({key:'ArrowRight',preventDefault:vi.fn()});
 expect(h.render().find(n=>n.props.className==='group-directory-bots')!.props.hidden).toBe(false);
 const count=h.render().filter(n=>n.props.className==='group-directory-identity').length;
 expect(count).toBe(2);
});
it('searches group and Bot names, expands matches, and handles no results',()=>{
 const h=harness();const input=()=>h.render().find(n=>n.type==='input')!;
 input().props.onChange({target:{value:'另一个'}});
 expect(h.render().filter(n=>n.props.className==='group-directory-identity')).toHaveLength(1);
 expect(h.render().find(n=>n.props.className==='group-directory-bots')!.props.hidden).toBe(false);
 input().props.onChange({target:{value:'同名助手'}});
 expect(h.render().filter(n=>n.props.className==='group-directory-identity')).toHaveLength(2);
 input().props.onChange({target:{value:'不存在'}});
 expect(h.render().some(n=>n.props.className==='group-directory-empty')).toBe(true);
 expect(h.render().filter(n=>n.type==='button').at(-1)!.props.disabled).toBe(true);
});
it('preserves stale, unknown Provider and missing-Bot states without hiding memberships',()=>{
 const data=structuredClone(snapshot);data.memberships[0]!.stale=true;data.memberships[0]!.backend='legacy';data.agents=data.agents.slice(0,1);
 const all=harness(data).render();const rows=all.filter(n=>n.props.className==='group-directory-bot');
 expect(rows[0]!.props.disabled).toBe(false);expect(rows[1]!.props.disabled).toBe(true);
 expect(all.find(n=>n.props.className==='group-directory-status')!.props.children).toContain('状态过期');
 expect(all.find(n=>n.props.className==='group-directory-provider')!.props.title).toContain('暂不支持修改');
});

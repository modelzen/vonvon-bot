import {expect,it,vi} from 'vitest';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import {desktopSnapshotSchema} from '@vonvon/protocol';
import {ProjectDirectory,projectEntries,type ProjectDirectoryState} from '../src/ProjectDirectory';

type Element = ReactElement<Record<string,any>>;
function nodes(node:ReactNode):Element[]{
  if(Array.isArray(node))return node.flatMap(nodes);
  if(!isValidElement<Record<string,any>>(node))return [];
  return [node,...nodes(node.props.children)];
}
const pay='prj_00000001',web='prj_00000002',empty='prj_00000003';
const memberships=[['cli_one','oc_one',pay],['cli_two','oc_one',pay],['cli_one','oc_two',web],['cli_three','oc_three',undefined]] as const;
const snapshot=desktopSnapshotSchema.parse({
  revision:1,observedAt:0,stale:false,host:{kind:'connected',ownership:'owned',version:'0.7.6'},
  agents:['cli_one','cli_two','cli_three'].map(id=>({id,name:`助手 ${id.slice(4)}`,enabled:true,running:true,connection:'connected',activation:'active'})),
  groups:[{id:'oc_one',name:'支付组群'},{id:'oc_two',name:'官网群'},{id:'oc_three',name:'新来的群'}],
  projects:[
    {id:pay,name:'支付组',revision:1,directory:'/w/pay',bindings:[{agentId:'cli_one',groupId:'oc_one'},{agentId:'cli_two',groupId:'oc_one'}]},
    {id:web,name:'官网',revision:1,directory:'/w/web',bindings:[{agentId:'cli_one',groupId:'oc_two'}]},
    {id:empty,name:'没有群的项目',revision:1,directory:'/w/none',bindings:[]},
  ],
  memberships:memberships.map(([agentId,groupId,projectId],index)=>({id:JSON.stringify([agentId,groupId]),agentId,groupId,...(projectId?{projectId}:{}),name:`项目${index}`,directory:'/tmp/r',backend:'codex-appserver',conversation:'threads',response:'mention',permission:{administrator:'qa',member:'qa',network:false},stale:false})),
  tools:[],jobs:[],application:{platform:'macos',version:'0.7.6',loginItem:false,dataPath:'/tmp/review'},
});
function harness(data=snapshot,onNewProject?:()=>void){
  let state:ProjectDirectoryState={query:'',expanded:{}};
  const onMembership=vi.fn();const onProject=vi.fn();
  const render=()=>nodes(ProjectDirectory({snapshot:data,state,onStateChange:next=>{state=next;},statusFor:()=>({label:'已连接',tone:'success'}),onProject,onMembership,onNewProject}));
  return {render,onMembership,onProject};
}
it('lists projects with their groups and Bots, then the bindings no project owns, and marks a project with no group',()=>{
 expect(projectEntries(snapshot).map(entry=>[entry.name,entry.members.length])).toEqual([['支付组',2],['官网',1],['没有群的项目',0],['还没归入项目的群',1]]);
 const all=harness().render();
 expect(all.filter(n=>n.props.className==='group-directory-identity')).toHaveLength(4);
 expect(all.filter(n=>n.props.className==='group-directory-count').map(n=>String([n.props.children].flat().join('')))).toContain('没有群');
});
it('opens the project from its own button and the exact binding from a row, without the toggle navigating',()=>{
 const h=harness();let all=h.render();
 const rows=all.filter(n=>n.props.className==='group-directory-bot');
 expect(rows).toHaveLength(4); // collapsed projects still render their rows, hidden
 expect(all.filter(n=>n.props.className==='group-directory-bots').map(n=>n.props.hidden)).toEqual([false,true,true,true]);
 const open=all.filter(n=>n.props.className==='project-directory-open');
 expect(open).toHaveLength(3); // the unowned bucket has no project page
 open[1]!.props.onClick();expect(h.onProject).toHaveBeenCalledWith(web);
 all.find(n=>n.props.className==='group-directory-identity')!.props.onClick();
 expect(h.onProject).toHaveBeenCalledTimes(1);expect(h.onMembership).not.toHaveBeenCalled();
 rows.slice(0,2).forEach(row=>row.props.onClick());
 expect(h.onMembership).toHaveBeenCalledWith(JSON.stringify(['cli_one','oc_one']));
 expect(h.onMembership).toHaveBeenCalledWith(JSON.stringify(['cli_two','oc_one']));
});
it('searches project, group and Bot names, expands matches, and handles no results',()=>{
 const h=harness();const input=()=>h.render().find(n=>n.type==='input')!;
 input().props.onChange({target:{value:'官网群'}});
 expect(h.render().filter(n=>n.props.className==='group-directory-identity')).toHaveLength(1);
 input().props.onChange({target:{value:'助手 two'}});
 expect(h.render().filter(n=>n.props.className==='group-directory-identity')).toHaveLength(1);
 input().props.onChange({target:{value:'支付组'}});
 expect(h.render().filter(n=>n.props.className==='group-directory-identity')).toHaveLength(1);
 input().props.onChange({target:{value:'不存在'}});
 expect(h.render().some(n=>n.props.className==='group-directory-empty')).toBe(true);
});
it('offers 新建项目 only when the caller can start one',()=>{
 expect(harness().render().some(n=>n.props.className==='project-directory-new')).toBe(false);
 const onNew=vi.fn();const button=harness(snapshot,onNew).render().find(n=>n.props.className==='project-directory-new')!;
 button.props.onClick();expect(onNew).toHaveBeenCalled();
});
it('a daemon with no project list shows every binding under the unowned bucket',()=>{
 const old={...snapshot,projects:undefined,memberships:snapshot.memberships.map(({projectId:_drop,...member})=>member)};
 expect(projectEntries(old).map(entry=>[entry.name,entry.members.length])).toEqual([['还没归入项目的群',4]]);
});
it('keeps stale and missing-Bot rows visible instead of hiding the binding',()=>{
 const data=structuredClone(snapshot);data.memberships[0]!.stale=true;data.agents=data.agents.slice(1);
 const rows=harness(data).render().filter(n=>n.props.className==='group-directory-bot');
 expect(rows.some(row=>row.props.disabled===true)).toBe(true);
});

import {expect,it} from 'vitest';
import {desktopSnapshotSchema,type DesktopSnapshot,type LibraryProject} from '@vonvon/protocol';
import {bindingRows,crossGroupWarning,defaultProjectChoice,deleteAgentDescription,otherProjectNotices,projectDeletable,workspaceRisks} from '../src/project-model';
import {exportText} from '../src/ProjectPage';

const pay='prj_00000001',web='prj_00000002';
const row=(agentId:string,groupId:string,projectId:string|undefined,extra:Record<string,unknown>={})=>({id:JSON.stringify([agentId,groupId]),agentId,groupId,...(projectId?{projectId}:{}),name:`${groupId}`,directory:'/r',backend:'codex-appserver',conversation:'threads',response:'mention',permission:{administrator:'full',member:'full',network:false},stale:false,...extra});
const make=(memberships:ReturnType<typeof row>[]):DesktopSnapshot=>desktopSnapshotSchema.parse({
  revision:1,observedAt:0,stale:false,host:{kind:'connected',ownership:'owned',version:'1'},
  agents:['cli_a','cli_b'].map(id=>({id,name:id==='cli_a'?'小支':'小发',enabled:true,running:true,connection:'connected',activation:'active'})),
  groups:[{id:'oc_pay',name:'支付组群'},{id:'oc_rel',name:'发布群'}],
  projects:[
    {id:pay,name:'支付组',revision:1,directory:'/w/pay',bindings:[{agentId:'cli_a',groupId:'oc_pay'},{agentId:'cli_a',groupId:'oc_rel'}]},
    {id:web,name:'小发的项目',revision:1,directory:'/w/web',bindings:[{agentId:'cli_b',groupId:'oc_pay'}]},
  ],
  memberships,tools:[],jobs:[],application:{platform:'macos',version:'1',loginItem:false,dataPath:'/t'},
});
const snapshot=make([
  row('cli_a','oc_pay',pay,{effectMode:'qa'}),
  row('cli_a','oc_rel',pay,{effectMode:'write'}),
  row('cli_b','oc_pay',web,{effectMode:'qa'}),
]);
const project=snapshot.projects![0]!;

it('D8: the writable and full-access warnings follow the effect mode, never the stored tier',()=>{
  // every row's stored tier says full; only effectMode counts
  const risks=workspaceRisks(snapshot,project);
  expect(risks.writable.map(item=>item.label)).toEqual(['发布群 · 小支']);
  expect(risks.full).toEqual([]);
  // a stored tier that is narrower than what runs is still seen as what runs
  const wide=make([row('cli_a','oc_pay',pay,{effectMode:'full',permission:{administrator:'qa',member:'qa',network:false}}),row('cli_a','oc_rel',pay,{effectMode:'qa'}),row('cli_b','oc_pay',web)]);
  const found=workspaceRisks(wide,wide.projects![0]!);
  expect(found.writable.map(item=>item.label)).toEqual(['支付组群 · 小支']);
  expect(found.full.map(item=>item.label)).toEqual(['支付组群 · 小支']);
  expect(found.shared).toBe(true);
  // an older daemon sends no effectMode: nothing is guessed from `permission`
  const old=make([row('cli_a','oc_pay',pay),row('cli_a','oc_rel',pay),row('cli_b','oc_pay',web)]);
  expect(workspaceRisks(old,old.projects![0]!)).toEqual({writable:[],full:[],shared:true});
});
it('a stale binding raises no warning, a single binding is not shared',()=>{
  const stale=make([row('cli_a','oc_pay',pay,{effectMode:'full',stale:true}),row('cli_a','oc_rel',pay,{effectMode:'qa'}),row('cli_b','oc_pay',web)]);
  expect(workspaceRisks(stale,stale.projects![0]!).writable).toEqual([]);
  const one={...project,bindings:[project.bindings[0]!]};
  expect(workspaceRisks(snapshot,one).shared).toBe(false);
});
it('lists groups and Bots with 失效 and 已停用 marks, from the library when it has them',()=>{
  const library:LibraryProject={id:project.id,name:'支付组',revision:3,workspace:{primary:'/w/pay',additional:[]},bindings:[
    {agentId:project.bindings[0]!.agentId,groupId:project.bindings[0]!.groupId,name:'x',enabled:true},
    {agentId:project.bindings[1]!.agentId,groupId:project.bindings[1]!.groupId,name:'x',enabled:false},
    {agentId:'cli_b' as never,groupId:'oc_rel' as never,name:'发布群旧名',enabled:true},
  ]};
  const rows=bindingRows(snapshot,project,library);
  expect(rows.map(item=>[item.group,item.bot,item.state])).toEqual([['支付组群','小支','ok'],['发布群','小支','disabled'],['发布群','小发','invalid']]);
  expect(bindingRows(snapshot,project).map(item=>item.state)).toEqual(['ok','ok']);
});
it('warns about another Bot of the same group that works in a different project',()=>{
  expect(otherProjectNotices(snapshot,project)).toEqual([{memberId:JSON.stringify(['cli_b','oc_pay']),group:'支付组群',bot:'小发',project:'小发的项目'}]);
  expect(otherProjectNotices(snapshot,snapshot.projects![1]!).map(item=>item.bot)).toEqual(['小支']);
});
it('deleting needs no group and no Bot',()=>{
  expect(projectDeletable(project)).toBe(false);
  expect(projectDeletable({...project,bindings:[]})).toBe(true);
});
it('the 项目 row starts on the project another Bot of the group is in, else the one the group had, else a new one',()=>{
  expect(defaultProjectChoice(snapshot,'oc_pay')).toEqual({kind:'join',id:pay,reason:'sibling'});
  expect(defaultProjectChoice(snapshot,'oc_new',web as never)).toEqual({kind:'join',id:web,reason:'previous'});
  expect(defaultProjectChoice(snapshot,'oc_new','prj_0000ffff' as never)).toEqual({kind:'new'});
  expect(defaultProjectChoice(snapshot,undefined)).toEqual({kind:'new'});
  expect(defaultProjectChoice({...snapshot,projects:undefined},'oc_pay')).toEqual({kind:'new'});
});
it('joining a project another group uses warns that the two groups see each other through the Bots',()=>{
  expect(crossGroupWarning(project,'oc_pay')).toContain('互相间接看到');
  expect(crossGroupWarning(project,'oc_pay')).toContain('项目记忆、工作区文件和可恢复的会话历史');
  expect(crossGroupWarning({...project,bindings:[project.bindings[0]!]},'oc_pay')).toBeUndefined();
  expect(crossGroupWarning(undefined,'oc_pay')).toBeUndefined();
});
it('the 移除本地 Bot confirmation counts what goes and says projects keep their memory',()=>{
  const text=deleteAgentDescription('小支',2,5);
  expect(text).toContain('2 个群绑定');expect(text).toContain('5 条 Bot 记忆');expect(text).toContain('项目的记忆和工作区属于项目，不会删');
  expect(deleteAgentDescription('小支',0,undefined)).not.toContain('条 Bot 记忆');
});
it('exports a project\'s memory as one text, a section per branch',()=>{
  expect(exportText('支付组',[{branch:'决定',markdown:'- 发版改到周四\n'},{branch:'约定',markdown:'- 通知发在发布群'}])).toBe('# 支付组\n\n## 决定\n\n- 发版改到周四\n\n## 约定\n\n- 通知发在发布群\n');
});

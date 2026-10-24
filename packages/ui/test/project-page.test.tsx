import {expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {desktopSnapshotSchema,libraryReplySchema,libraryRequestSchema,type DesktopSnapshot} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DirectoryPickerProvider} from '../src/directory-picker';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {ProjectPage} from '../src/ProjectPage';
import type {ProjectPane} from '../src/collaboration-navigation';

const requests:unknown[]=[];
const client=createClient({isOpen:()=>true,onMessage:()=>{},onClose:()=>{},onError:()=>{},send:message=>{requests.push(message);},close:async()=>{}});
const pay='prj_00000001';
const row=(agentId:string,groupId:string,effectMode:string)=>({id:JSON.stringify([agentId,groupId]),agentId,groupId,projectId:pay,name:groupId,directory:'/w/pay',backend:'codex-appserver',conversation:'threads',response:'mention',effectMode,permission:{administrator:'qa',member:'qa',network:false},stale:false});
const make=(members:ReturnType<typeof row>[]):DesktopSnapshot=>desktopSnapshotSchema.parse({
  revision:1,observedAt:0,stale:false,host:{kind:'connected',ownership:'owned',version:'1'},
  agents:['cli_a','cli_b'].map(id=>({id,name:id==='cli_a'?'小支':'小发',enabled:true,running:true,connection:'connected',activation:'active'})),
  groups:[{id:'oc_pay',name:'支付组群'},{id:'oc_rel',name:'发布群'}],
  projects:[{id:pay,name:'支付组',revision:1,directory:'/w/pay',bindings:members.map(({agentId,groupId})=>({agentId,groupId}))}],
  memberships:members,tools:[],jobs:[],application:{platform:'macos',version:'1',loginItem:false,dataPath:'/t'},
});
const two=make([row('cli_a','oc_pay','qa'),row('cli_a','oc_rel','write')]);
const render=(snapshot:DesktopSnapshot,pane:ProjectPane)=>renderToStaticMarkup(<ClientProvider client={client}><DraftGuardProvider><DirectoryPickerProvider>
  <ProjectPage project={snapshot.projects![0]!} snapshot={snapshot} pane={pane} onPane={vi.fn()} onMembership={vi.fn()} onChanged={async()=>{}} onDeleted={vi.fn()}/>
</DirectoryPickerProvider></DraftGuardProvider></ClientProvider>);

it('has memory and workspace tabs, rename and delete, and no group tabs while two groups share the project',()=>{
  const html=render(two,{kind:'map'});
  expect(html).toContain('项目「支付组」');
  for(const label of ['记忆','工作区'])expect(html).toContain(`>${label}</button>`);
  expect(html).toContain('重命名');expect(html).toContain('删除项目…');
  for(const label of ['模型与权限','能力','沟通方式','补充职责','回复规则','权限'])expect(html).not.toContain(`>${label}</button>`);
});
it('keeps group settings on the group page even for a project with one binding',()=>{
  const one=make([row('cli_a','oc_pay','qa')]);
  const html=render(one,{kind:'map'});
  for(const label of ['模型与权限','能力','沟通方式','补充职责','模型','回复规则','权限','模型看到什么'])expect(html).not.toContain(`>${label}</button>`);
  // a group pane asked of a project that has two bindings falls back to the map
  expect(render(two,{kind:'group',tab:'permission'})).toContain('id="setting-%E7%BE%A4%E5%92%8C%20Bot"');
});
it('lists the groups and Bots on 导图 and flags a same-group Bot in another project',()=>{
  const html=render(two,{kind:'map'});
  expect(html).toContain('支付组群 · 小支');expect(html).toContain('发布群 · 小支');
  expect(html).toContain('多会话 · Codex');
});
it('warns on 工作区 about writable bindings by the effect mode and about full access in a shared workspace',()=>{
  const html=render(two,{kind:'workspace'});
  expect(html).toContain('这个项目有可写档的群');
  expect(html).toContain('发布群 · 小支');
  expect(html).not.toContain('共用这个工作区的绑定里有完全访问档');
  const full=render(make([row('cli_a','oc_pay','qa'),row('cli_a','oc_rel','full')]),{kind:'workspace'});
  expect(full).toContain('共用这个工作区的绑定里有完全访问档');
  const safe=render(make([row('cli_a','oc_pay','qa'),row('cli_a','oc_rel','qa')]),{kind:'workspace'});
  expect(safe).not.toContain('可写档');expect(safe).not.toContain('完全访问档');
  expect(html).toContain('改工作区会让这个项目 2 个群的会话归档、下一轮新开');
});
it('never shows the project instruction file, its path, its content or its modification time',()=>{
  requests.length=0;
  for(const pane of [{kind:'map'},{kind:'workspace'},{kind:'context'}] as ProjectPane[]){
    const html=render(two,pane);
    expect(html).not.toContain('模型看到什么');
    expect(html).not.toMatch(/AGENTS\.md|CLAUDE\.md/);
    expect(html).not.toMatch(/修改时间|最后修改|mtime/i);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  }
});
it('the library protocol takes rename, delete and previous, with the same name rule as a group project name',()=>{
  expect(libraryRequestSchema.parse({type:'rename',projectId:pay,revision:2,name:' 发版组 '})).toMatchObject({name:'发版组'});
  expect(()=>libraryRequestSchema.parse({type:'rename',projectId:pay,revision:2,name:'a/b'})).toThrow();
  expect(()=>libraryRequestSchema.parse({type:'rename',projectId:pay,revision:2,name:'  '})).toThrow();
  expect(libraryRequestSchema.parse({type:'delete',projectId:pay,revision:1})).toEqual({type:'delete',projectId:pay,revision:1});
  expect(libraryRequestSchema.parse({type:'previous',agentId:'cli_a',groupId:'oc_pay'}).type).toBe('previous');
  expect(libraryReplySchema.parse({kind:'previous'})).toEqual({kind:'previous'});
  expect(libraryReplySchema.parse({kind:'deleted',projectId:pay}).kind).toBe('deleted');
});

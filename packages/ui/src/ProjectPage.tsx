import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ChevronRight, Download, Pencil, Trash2} from 'lucide-react';
import {backendLabel, type DesktopSnapshot, type LibraryProject, type LibraryReply, type MembershipId, type ProjectId, type SnapshotProject, type ToolState} from '@vonvon/protocol';
import {useClient} from './client-context';
import {Button, InlineNotice} from './reference/components/ui';
import {ConfirmDialog, Dialog} from './reference/components/ui/Dialog';
import {WorkspaceFields, GroupDesignSettings, type GroupSettingsTab} from './settings/GroupDesignSettings';
import {useDraft, useDraftGuard} from './settings/DraftGuard';
import {groupDesignTabs} from './GroupWorkspace';
import {bindingRows, otherProjectNotices, projectDeletable, workspaceRisks} from './project-model';
import {settingAnchor} from './search';
import type {ProjectPane} from './collaboration-navigation';
import './group-workspace.css';

const failText = (error: unknown, fallback = '操作未完成，请重试。') => error instanceof Error ? error.message : fallback;
const conversationLabel = {threads: '多会话', shared: '单会话', smart: '智能'} as const;
export const projectTabs: readonly [ProjectPane['kind'], string][] = [['map', '导图'], ['workspace', '工作区'], ['context', '模型看到什么']];

/** One file out of a project's per-branch markdown export (memory.export), for 删除项目 to hand over before the memory goes. */
export function exportText(name: string, files: readonly {branch: string; markdown: string}[]): string {
  return [`# ${name}`, ...files.map(file => `## ${file.branch}\n\n${file.markdown.trim()}`)].join('\n\n') + '\n';
}

/** The library's own record of the project (revision, workspace, bindings); the snapshot only has the main folder. */
function useLibraryProject(projectId: ProjectId, revision: number) {
  const client = useClient();
  const [library, setLibrary] = useState<LibraryProject>();
  const [error, setError] = useState<string>();
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    try {
      const reply = await client.library({type: 'list'});
      if (request !== serial.current) return;
      if (reply.kind !== 'list') throw new Error('项目暂时读不到。');
      setLibrary(reply.projects.find(item => item.id === projectId)); setError(undefined);
    } catch (failure) {if (request === serial.current) setError(failText(failure, '项目暂时读不到。'));}
  }, [client, projectId]);
  useEffect(() => {void refresh();}, [refresh, revision]);
  useEffect(() => () => {serial.current++;}, []);
  return {library, error, refresh};
}

type Props = {
  project: SnapshotProject;
  snapshot: DesktopSnapshot;
  pane: ProjectPane;
  tools?: readonly ToolState[];
  onPane: (pane: ProjectPane) => void;
  onMembership: (id: MembershipId) => void;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
  onOpenTools?: () => void;
  onOpenProviders?: () => void;
  onOpenSecrets?: () => void;
};
// Intent: one project, its groups and Bots, and the workspace they share. Pages are plain: the owner leads a later visual pass.
export function ProjectPage({project, snapshot, pane, tools, onPane, onMembership, onChanged, onDeleted, onOpenTools, onOpenProviders, onOpenSecrets}: Props) {
  const guard = useDraftGuard();
  const {library, error, refresh} = useLibraryProject(project.id, snapshot.revision);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const only = project.bindings.length === 1 ? snapshot.memberships.find(item => item.agentId === project.bindings[0]!.agentId && item.groupId === project.bindings[0]!.groupId) : undefined;
  const onlyAgent = only && snapshot.agents.find(agent => agent.id === only.agentId);
  const onlyGroup = only && snapshot.groups.find(group => group.id === only.groupId);
  const tab = pane.kind === 'group' && !only ? 'map' : pane.kind;
  return <div className="group-design-workspace project-page">
    <header className="group-design-heading">
      <h2 title={project.name}>项目「{project.name}」</h2>
      <Button size="sm" onClick={() => setDialog('rename')}><Pencil size={13} aria-hidden="true"/>重命名</Button>
      <Button size="sm" onClick={() => setDialog('delete')}><Trash2 size={13} aria-hidden="true"/>删除项目…</Button>
    </header>
    <nav className="group-design-tabs" aria-label="项目页">
      {projectTabs.map(([kind, label]) => <button type="button" key={kind} aria-current={tab === kind ? 'page' : undefined} onClick={() => guard.navigate(() => onPane({kind} as ProjectPane))}>{label}</button>)}
      {only && groupDesignTabs.map(([value, label]) => <button type="button" key={value} aria-current={pane.kind === 'group' && pane.tab === value ? 'page' : undefined} onClick={() => guard.navigate(() => onPane({kind: 'group', tab: value}))}>{label}</button>)}
    </nav>
    {error && <InlineNotice title="读取未完成" tone="warning">{error}<Button size="sm" onClick={() => void refresh()}>重试</Button></InlineNotice>}
    {tab === 'map' && <ProjectMap project={project} snapshot={snapshot} library={library} onMembership={onMembership}/>}
    {tab === 'workspace' && <ProjectWorkspace project={project} snapshot={snapshot} library={library} refresh={async () => {await refresh(); await onChanged();}}/>}
    {tab === 'context' && <section id={settingAnchor('模型看到什么')} aria-label="模型看到什么"><p className="group-control-note">这一页会列出 vonvon 交给模型的角色设定和记忆。现在还没有开放。</p></section>}
    {pane.kind === 'group' && only && onlyAgent && onlyGroup && <div className="project-page-group" aria-label={`${onlyGroup.name} 的设置`}>
      <p className="group-control-note">{onlyAgent.name} 在 {onlyGroup.name} 里的设置。聊天方式、对话记录和解除绑定在<button type="button" className="gd-text-action" onClick={() => guard.navigate(() => onMembership(only.id))}>群设置页</button>。</p>
      <GroupDesignSettings scope={{kind: 'project', botId: only.agentId, projectName: only.name}} tab={pane.tab as GroupSettingsTab} tools={tools} botName={onlyAgent.name} groupName={onlyGroup.name}
        onOpenTools={onOpenTools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets}/>
    </div>}
    <RenameDialog open={dialog === 'rename'} project={project} library={library} onClose={() => setDialog(null)} onDone={async () => {setDialog(null); await refresh(); await onChanged();}}/>
    <DeleteDialog open={dialog === 'delete'} project={project} library={library} onClose={() => setDialog(null)} onDone={async () => {setDialog(null); await onChanged(); onDeleted();}}/>
  </div>;
}

function ProjectMap({project, snapshot, library, onMembership}: {project: SnapshotProject; snapshot: DesktopSnapshot; library?: LibraryProject; onMembership: (id: MembershipId) => void}) {
  const rows = bindingRows(snapshot, project, library);
  const notices = otherProjectNotices(snapshot, project);
  return <section id={settingAnchor('群和 Bot')} className="project-map" aria-label="群和 Bot">
    <h3>群和 Bot</h3>
    {!rows.length && <p className="group-control-note">没有群在用这个项目。到 Bot 页把一个群连进来，或删除这个项目。</p>}
    <ul className="project-binding-list">
      {rows.map(row => <li key={`${row.agentId}:${row.groupId}`}>
        <button type="button" className="project-binding" disabled={!row.member} aria-label={`设置 ${row.group} 中的 ${row.bot}`} onClick={() => row.member && onMembership(row.member.id)}>
          <strong>{row.group} · {row.bot}</strong>
          <small>{row.member ? `${conversationLabel[row.member.conversation]} · ${backendLabel(row.member.backend)}` : ''}</small>
          {row.state === 'invalid' && <span className="group-directory-status" data-tone="warning">已失效</span>}
          {row.state === 'disabled' && <span className="group-directory-status" data-tone="neutral">已停用</span>}
          {row.member && <ChevronRight size={13} aria-hidden="true"/>}
        </button>
      </li>)}
    </ul>
    {notices.map(notice => <InlineNotice key={notice.memberId} title="同一个群里的另一个 Bot 用的是别的项目" tone="warning"
      actions={<Button size="sm" onClick={() => onMembership(notice.memberId)}>去设置</Button>}>
      {notice.bot} 在 {notice.group} 用的是项目「{notice.project}」，记忆和目录和这里不通。在 {notice.bot} 的群设置页可以换到这个项目。
    </InlineNotice>)}
  </section>;
}

function ProjectWorkspace({project, snapshot, library, refresh}: {project: SnapshotProject; snapshot: DesktopSnapshot; library?: LibraryProject; refresh: () => Promise<void>}) {
  const client = useClient();
  const risks = useMemo(() => workspaceRisks(snapshot, project), [snapshot, project]);
  const stored = useMemo(() => library ? {primary: library.workspace.primary, directories: [library.workspace.primary, ...library.workspace.additional], repositories: library.workspace.repositories ?? []} : undefined, [library]);
  const [draft, setDraft] = useState(stored);
  const [touchedRepositories, setTouchedRepositories] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {setDraft(stored); setTouchedRepositories(false);}, [stored]);
  const dirty = Boolean(draft && stored && JSON.stringify(draft) !== JSON.stringify(stored));
  async function save() {
    if (!draft || !library || busy) return false;
    if (!draft.directories.includes(draft.primary)) {setError('请选择一个主目录。'); return false;}
    setBusy(true); setError(''); setNotice('');
    try {
      // `repositories` stays out unless it was edited: out means each Bot's own default, [] would clear it.
      const keep = touchedRepositories || library.workspace.repositories !== undefined;
      const reply: LibraryReply = await client.library({type: 'workspace', projectId: project.id, revision: library.revision, workspace: {
        primary: draft.primary, additional: draft.directories.filter(path => path !== draft.primary), ...(keep ? {repositories: draft.repositories} : {})}});
      if (reply.kind !== 'workspace') throw new Error('工作区没有保存。');
      const failed = reply.rebound.filter(item => item.state === 'failed').length;
      setNotice(!reply.changed ? '工作区没有变化。' : `已保存。${reply.rebound.filter(item => item.state === 'archived').length} 个群的会话已归档，下一轮重新开场。${failed ? `${failed} 个群没有跟上，下次启动会补上。` : ''}`);
      await refresh();
      return true;
    } catch (failure) {setError(failText(failure)); return false;}
    finally {setBusy(false);}
  }
  useDraft(dirty, {title: '项目工作区', save, discard: () => {setDraft(stored); setTouchedRepositories(false);}});
  return <section id={settingAnchor('工作区')} aria-label="工作区">
    {risks.writable.length > 0 && <InlineNotice title="这个项目有可写档的群" tone="warning">
      {risks.writable.map(item => item.label).join('、')}：可写的 Bot 能改工作区里的文件，包括所有群都会读的项目指令文件。
    </InlineNotice>}
    {risks.shared && risks.full.length > 0 && <InlineNotice title="共用这个工作区的绑定里有完全访问档" tone="warning">{risks.full.map(item => item.label).join('、')}。</InlineNotice>}
    <p className="group-control-note">改工作区会让这个项目 {new Set(project.bindings.map(binding => binding.groupId)).size} 个群的会话归档、下一轮新开。</p>
    {draft ? <>
      <WorkspaceFields value={draft} disabled={busy} onChange={next => {setTouchedRepositories(touched => touched || JSON.stringify(next.repositories) !== JSON.stringify(draft.repositories)); setDraft(next);}}/>
      <div className="project-page-actions"><Button variant="primary" loading={busy} disabled={!dirty || busy} onClick={() => void save()}>保存工作区</Button></div>
    </> : <p className="gd-empty" role="status">正在读取…</p>}
    {error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}
    {notice && <p role="status" className="group-control-note">{notice}</p>}
  </section>;
}

function RenameDialog({open, project, library, onClose, onDone}: {open: boolean; project: SnapshotProject; library?: LibraryProject; onClose: () => void; onDone: () => Promise<void>}) {
  const client = useClient();
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {if (open) {setName(project.name); setError('');}}, [open, project.name]);
  const problem = /[/\\]/.test(name) ? '名称里不能有 / 或 \\。' : /[\x00-\x1f]/.test(name) ? '名称里不能有控制字符。' : name.length > 100 ? '名称最多 100 个字。' : undefined;
  async function submit() {
    if (!library || busy || problem || !name.trim()) return;
    setBusy(true); setError('');
    try {
      const reply = await client.library({type: 'rename', projectId: project.id, revision: library.revision, name: name.trim()});
      if (reply.kind !== 'renamed') throw new Error('名称没有保存。');
      await onDone();
    } catch (failure) {setError(failText(failure));} finally {setBusy(false);}
  }
  return <Dialog open={open} title="重命名项目" onClose={busy ? undefined : onClose} footer={<>
    <Button disabled={busy} onClick={onClose}>取消</Button>
    <Button variant="primary" loading={busy} disabled={!library || !name.trim() || Boolean(problem) || name.trim() === project.name} onClick={() => void submit()}>保存</Button></>}>
    <label className="group-control-note">项目名<input className="settings-field" aria-label="项目名" value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)}/></label>
    <p className="group-control-note">项目名不跟群名联动，改了不影响群里的叫法。</p>
    {problem && <p className="gd-note" role="status">{problem}</p>}
    {error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}
  </Dialog>;
}

function DeleteDialog({open, project, library, onClose, onDone}: {open: boolean; project: SnapshotProject; library?: LibraryProject; onClose: () => void; onDone: () => Promise<void>}) {
  const client = useClient();
  const deletable = projectDeletable(project);
  const [count, setCount] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(''); setCount(undefined);
    void client.memory({type: 'list', scope: {kind: 'project', projectId: project.id}}).then(reply => {if (active && reply.kind === 'list') setCount(reply.used);}).catch(() => undefined);
    return () => {active = false;};
  }, [client, open, project.id]);
  async function download() {
    try {
      const reply = await client.memory({type: 'export', scope: {kind: 'project', projectId: project.id}});
      if (reply.kind !== 'exported') throw new Error('导出没有完成。');
      const url = URL.createObjectURL(new Blob([exportText(project.name, reply.files)], {type: 'text/markdown'}));
      const link = document.createElement('a');
      link.href = url; link.download = `${project.name}.md`; link.click();
      URL.revokeObjectURL(url);
    } catch (failure) {setError(failText(failure));}
  }
  async function remove() {
    if (!library || busy) return;
    setBusy(true); setError('');
    try {
      const reply = await client.library({type: 'delete', projectId: project.id, revision: library.revision});
      if (reply.kind !== 'deleted') throw new Error('项目没有删除。');
      await onDone();
    } catch (failure) {setError(failText(failure));} finally {setBusy(false);}
  }
  if (!deletable) return <Dialog open={open} title="这个项目还不能删" onClose={onClose} footer={<Button onClick={onClose}>知道了</Button>}>
    <p className="group-control-note">还有 {project.bindings.length} 个群和 Bot 在用它。先让它们解绑，或在群设置页换到别的项目，才能删。</p>
  </Dialog>;
  return <ConfirmDialog open={open} title={`删除项目「${project.name}」？`} tone="danger" confirmLabel="删除项目" pending={busy} onCancel={onClose} onConfirm={() => void remove()}
    description={`项目记忆${count === undefined ? '' : `（${count} 条）`}、它的修改记录会一起删掉，不能恢复。工作区里的文件不动。`}
    error={error || undefined}>
    <Button size="sm" onClick={() => void download()}><Download size={13} aria-hidden="true"/>先导出记忆</Button>
  </ConfirmDialog>;
}

import {useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, Folder, GitBranch, Plus, RefreshCw, X} from 'lucide-react';
import type {DesktopSnapshot, FolderChoice, LibraryProject, Membership, ProjectId, ProjectSettingsView} from '@vonvon/protocol';
import {useActiveDevice, useClient} from '../client-context';
import {whereName} from '../device-copy';
import {DirectorySearchStep} from '../DirectorySearchStep';
import {DIRECTORY_PROBLEM_TEXT} from '../management/DiagnosticsPanel';
import {workspaceRisks} from '../project-model';
import {Button, IconButton, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {settingAnchor} from '../search';
import {useDraft} from './DraftGuard';
import {AnnouncedReadonlyMessages, hasReadonlyMessage} from './readonly-messages';
import {errorText} from './SettingsPanel';
import {
  addAdditionalDirectory,
  pathBaseName,
  promoteAdditionalDirectory,
  removeAdditionalDirectory,
  removeLegacyRepository,
  replacePrimary,
  sameWorkspaceDraft,
  sharedWorkspaceSummary,
  workspaceSummaryMeta,
  type WorkspaceDraft,
} from './workspace-model';
import './group-workspace-section.css';

const failText = (error: unknown, fallback = '操作未完成，请重试。') => (error instanceof Error ? error.message : fallback);

function draftFromView(view: ProjectSettingsView, member?: Membership): WorkspaceDraft {
  const stored = view.sections.workspace?.stored;
  const primary = stored?.primary || member?.directory || view.identity.cwd;
  const additional = (stored?.directories ?? []).filter(path => path !== primary);
  const repositories = stored?.repositories ?? [];
  return {primary, additional, repositories};
}

function draftFromLibrary(project: LibraryProject): WorkspaceDraft {
  return {
    primary: project.workspace.primary,
    additional: [...project.workspace.additional],
    repositories: [...(project.workspace.repositories ?? [])],
  };
}

type Props = {
  view: ProjectSettingsView;
  member?: Membership;
  snapshot?: DesktopSnapshot;
  onRefresh: () => Promise<void>;
  onChanged?: () => Promise<void>;
  onProject?: (id: ProjectId) => void;
};

/** Group workspace summary on 模型与权限 plus a focused modal editor (replacing primary or managing extra folders). */
export function GroupWorkspaceSection({view, member, snapshot, onRefresh, onChanged, onProject}: Props) {
  const client = useClient();
  const where = useActiveDevice();
  const announcedReadonly = useContext(AnnouncedReadonlyMessages);
  const projectId = member?.projectId;
  const memberProject = useMemo(
    () => (projectId ? snapshot?.projects?.find(item => item.id === projectId) : undefined),
    [snapshot?.projects, projectId],
  );
  const shared = useMemo(() => sharedWorkspaceSummary(snapshot, memberProject, member), [snapshot, memberProject, member]);
  const risks = useMemo(
    () => (snapshot && memberProject ? workspaceRisks(snapshot, memberProject) : undefined),
    [snapshot, memberProject],
  );

  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<'primary' | 'additional' | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [library, setLibrary] = useState<LibraryProject>();
  const [baseline, setBaseline] = useState<WorkspaceDraft>(() => draftFromView(view, member));
  const [draft, setDraft] = useState<WorkspaceDraft>(() => draftFromView(view, member));
  const [touchedRepositories, setTouchedRepositories] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const loadSerial = useRef(0);

  const hostOffline = Boolean(snapshot && snapshot.host.kind !== 'connected');
  const workspaceAccess = view.sections.workspace?.access;
  const readonlyAccess = hostOffline
    ? {kind: 'readonly' as const, reason: 'host-offline', message: '后台服务尚未连接，当前只读。'}
    : workspaceAccess?.kind === 'readonly'
      ? workspaceAccess
      : undefined;
  const readonly = Boolean(readonlyAccess);

  const summaryWorkspace = useMemo(
    () => (library && library.id === projectId ? draftFromLibrary(library) : draftFromView(view, member)),
    [library, projectId, view, member],
  );
  const summaryMeta = workspaceSummaryMeta(
    summaryWorkspace.additional.length,
    summaryWorkspace.repositories.length,
    shared.summary,
  );

  const loadWorkspace = useCallback(async () => {
    const serial = ++loadSerial.current;
    setError('');
    setHint('');
    setLoadError('');
    setTouchedRepositories(false);
    if (!projectId) {
      const current = draftFromView(view, member);
      setLibrary(undefined);
      setBaseline(current);
      setDraft(current);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const reply = await client.library({type: 'list'});
      if (serial !== loadSerial.current) return;
      if (reply.kind !== 'list') throw new Error('工作区暂时读不到。');
      const found = reply.projects.find(item => item.id === projectId);
      if (!found) {
        // Older or unlinked fallback when the library does not list this row.
        const current = draftFromView(view, member);
        setLibrary(undefined);
        setBaseline(current);
        setDraft(current);
        return;
      }
      const next = draftFromLibrary(found);
      setLibrary(found);
      setBaseline(next);
      setDraft(next);
    } catch (failure) {
      if (serial !== loadSerial.current) return;
      setLoadError(failText(failure, '工作区暂时读不到。'));
    } finally {
      if (serial === loadSerial.current) setLoading(false);
    }
  }, [client, member, projectId, view]);

  const workspaceRevision = view.sections.workspace?.revision;
  useEffect(() => () => { loadSerial.current++; }, []);
  useEffect(() => {
    if (!open) setLibrary(undefined);
  }, [open, projectId, workspaceRevision]);

  const dirty = open && !loading && !loadError && !sameWorkspaceDraft(draft, baseline);

  function openDialog() {
    setOpen(true);
    setPicking(null);
    setPickerBusy(false);
    setError('');
    setHint('');
    void loadWorkspace();
  }

  function discardAndClose() {
    if (saving) return;
    loadSerial.current++;
    setPicking(null);
    setPickerBusy(false);
    setDraft(baseline);
    setTouchedRepositories(false);
    setError('');
    setHint('');
    setLoadError('');
    setOpen(false);
  }

  function handlePick(choice: FolderChoice) {
    setHint('');
    setError('');
    if (picking === 'primary') {
      setDraft(current => replacePrimary(current, choice.displayPath));
    } else if (picking === 'additional') {
      const result = addAdditionalDirectory(draft, choice.displayPath);
      if (result.duplicate === 'primary') setHint('这个目录已经是当前主目录。');
      else if (result.duplicate === 'additional') setHint('这个目录已在其他目录列表中。');
      else setDraft(result.draft);
    }
    setPicking(null);
  }

  async function save(): Promise<boolean> {
    if (saving || readonly || loading || loadError || !draft.primary) return false;
    setSaving(true);
    setError('');
    setHint('');
    try {
      if (library && projectId) {
        const keepRepositories = touchedRepositories || library.workspace.repositories !== undefined;
        const reply = await client.library({
          type: 'workspace',
          projectId: library.id,
          revision: library.revision,
          workspace: {
            primary: draft.primary,
            additional: draft.additional,
            ...(keepRepositories ? {repositories: draft.repositories} : {}),
          },
        });
        if (reply.kind !== 'workspace') throw new Error('工作区没有保存。');
        const nextLibrary: LibraryProject = {
          ...library,
          revision: reply.project.revision,
          workspace: reply.project.workspace,
        };
        const nextDraft = draftFromLibrary(nextLibrary);
        setLibrary(nextLibrary);
        setBaseline(nextDraft);
        setDraft(nextDraft);
        setTouchedRepositories(false);
        const archived = reply.rebound.filter(item => item.state === 'archived').length;
        const failed = reply.rebound.filter(item => item.state === 'failed').length;
        const message = !reply.changed
          ? '工作区没有变化。'
          : shared.shared
            ? `工作区已保存。${archived} 个群的会话已归档，下一轮重新开场。${failed ? `有 ${failed} 个群没有跟上，下次启动会补上。` : ''}`
            : `工作区已保存。当前会话已归档，下一轮重新开场。${failed ? '部分状态将在下次启动时同步。' : ''}`;
        setSavedNotice(message);
        setOpen(false);
        setPicking(null);
        await Promise.all([onRefresh(), onChanged?.()]);
        return true;
      }
      const section = view.sections.workspace;
      if (!section) throw new Error('当前后台版本暂不支持修改工作区。');
      const reply = await client.settings({
        type: 'save',
        edit: {
          scope: view.scope,
          section: 'workspace',
          revision: section.revision,
          patch: {
            primary: draft.primary,
            directories: [draft.primary, ...draft.additional],
            ...(touchedRepositories ? {repositories: draft.repositories} : {}),
          },
        },
      });
      const failure = errorText(reply);
      if (failure) {
        setError(failure);
        return false;
      }
      if (reply.kind !== 'saved' || reply.result.kind !== 'saved') {
        setError('工作区没有保存，请重试。');
        return false;
      }
      setBaseline(draft);
      setTouchedRepositories(false);
      setSavedNotice('工作区已保存。当前会话已归档，下一轮重新开场。');
      setOpen(false);
      setPicking(null);
      await Promise.all([onRefresh(), onChanged?.()]);
      return true;
    } catch (failure) {
      setError(failText(failure, '工作区没有保存，请重试。'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  useDraft(dirty, {title: '工作区', save, discard: discardAndClose});

  const removeTooltip = where.isRemote ? `移除引用，保留${whereName(where)}上的文件` : '移除引用，保留本机文件';
  const dialogDescription = picking
    ? undefined
    : readonlyAccess
      ? readonlyAccess.message
      : shared.shared
        ? `此工作区${shared.summary}，保存后会归档相关群的会话，下一轮重新开场。`
        : `修改后会归档本群当前会话，下一轮重新开场；${whereName(where)}上的原文件保留。`;

  return <>
    <SettingsGroup
      label="工作区"
      id={settingAnchor('工作区')}
      className="workspace-summary"
      footer={readonlyAccess && !hasReadonlyMessage(announcedReadonly, readonlyAccess) ? readonlyAccess.message : undefined}
    >
      <SettingsRow
        title={<span title={summaryWorkspace.primary}>{pathBaseName(summaryWorkspace.primary)}</span>}
        description={<>
          <span className="workspace-summary__path" title={summaryWorkspace.primary}>{summaryWorkspace.primary}</span>
          {(summaryMeta || (shared.shared && memberProject && onProject)) && <span className="workspace-summary__meta">
            {summaryMeta}
            {shared.shared && memberProject && onProject && <>
              {summaryMeta && <span aria-hidden="true">·</span>}
              <button type="button" className="workspace-summary__project-link" onClick={() => onProject(memberProject.id)}>查看项目</button>
            </>}
          </span>}
        </>}
        trailing={<span data-search-title="修改工作区"><Button size="sm" onClick={openDialog}>{readonly ? '查看工作区' : '修改工作区'}</Button></span>}
      />
      {member?.directoryProblem && <InlineNotice title="当前工作目录位置异常" tone="warning">
        {DIRECTORY_PROBLEM_TEXT[member.directoryProblem]}。请点击「修改工作区」更换主目录，原文件不会自动迁移。
      </InlineNotice>}
      {savedNotice && <p className="workspace-summary__status" role="status">{savedNotice}</p>}
    </SettingsGroup>
    <Dialog
      open={open}
      size="lg"
      title={picking
        ? <span className="workspace-dialog-title">
          <IconButton label="返回工作区" variant="ghost" size="sm" disabled={pickerBusy} onClick={() => setPicking(null)}><ArrowLeft size={16}/></IconButton>
          <span>{picking === 'primary' ? '更换主目录' : '添加目录'}</span>
        </span>
        : '工作区'}
      description={dialogDescription}
      onClose={saving ? undefined : picking ? () => { if (!pickerBusy) setPicking(null); } : discardAndClose}
      footer={picking
        ? <><span className="directory-key-hints">↑ ↓ 选择 <span>↵ 使用目录</span></span><Button disabled={pickerBusy} onClick={() => setPicking(null)}>返回</Button></>
        : readonly
          ? <Button onClick={discardAndClose}>关闭</Button>
          : <><Button disabled={saving} onClick={discardAndClose}>取消</Button><Button variant="primary" loading={saving} disabled={!dirty || saving || loading || Boolean(loadError)} onClick={() => void save()}>保存工作区</Button></>}
    >
      {picking
        ? <DirectorySearchStep onBusyChange={setPickerBusy} onChoose={handlePick}/>
        : <div className="workspace-dialog">
          {loading && <p className="gd-empty" role="status">正在读取工作区…</p>}
          {!loading && loadError && <InlineNotice title="读取未完成" tone="warning">
            {loadError}
            <IconButton size="sm" variant="ghost" label="重试" title="重新读取工作区" onClick={() => void loadWorkspace()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>
          </InlineNotice>}
          {!loading && !loadError && <>
            {shared.shared && risks && risks.writable.length > 0 && <InlineNotice title="共用此工作区的群里有可写档" tone="warning">
              {risks.writable.map(item => item.label).join('、')}：可写的 Bot 能改工作区里的文件。
            </InlineNotice>}
            {shared.shared && risks && risks.full.length > 0 && <InlineNotice title="共用此工作区的绑定里有完全访问档" tone="warning">
              {risks.full.map(item => item.label).join('、')}。
            </InlineNotice>}
            {member?.directoryProblem && draft.primary === baseline.primary && <InlineNotice title="当前主目录位置异常" tone="warning">
              {DIRECTORY_PROBLEM_TEXT[member.directoryProblem]}。请选择其他目录作为主目录。
            </InlineNotice>}
            <section className="workspace-dialog__block" aria-label="主目录">
              <div className="workspace-dialog__heading">
                <h3>主目录</h3>
                {!readonly && <Button size="sm" disabled={saving} onClick={() => { setHint(''); setPicking('primary'); }}>更换目录</Button>}
              </div>
              <div className="workspace-dialog__primary-row">
                <Folder size={17} aria-hidden="true"/>
                <span className="gd-directory-copy">
                  <strong>{pathBaseName(draft.primary)}</strong>
                  <small title={draft.primary}>{draft.primary}</small>
                </span>
              </div>
              <p className="gd-note">会话从主目录启动，并按 Provider 规则加载其中的说明文件与技能。</p>
            </section>
            <section className="workspace-dialog__block" aria-label="其他目录">
              <div className="workspace-dialog__heading">
                <h3>其他目录</h3>
                {!readonly && <button type="button" className="gd-text-action" disabled={saving} onClick={() => { setHint(''); setPicking('additional'); }}><Plus size={13} aria-hidden="true"/>添加目录</button>}
              </div>
              {draft.additional.length > 0
                ? <ul className="workspace-dialog__list">{draft.additional.map(path => <li className="gd-directory-row" key={path}>
                  <Folder size={16} aria-hidden="true"/>
                  <span className="gd-directory-copy">
                    <strong>{pathBaseName(path)}</strong>
                    <small title={path}>{path}</small>
                  </span>
                  {!readonly && <div className="gd-directory-actions">
                    <button type="button" className="gd-text-action" disabled={saving} onClick={() => { setHint(''); setDraft(current => promoteAdditionalDirectory(current, path)); }}>设为主目录</button>
                    <button type="button" className="gd-icon-action" disabled={saving} aria-label={`移除${pathBaseName(path)}`} title={removeTooltip} onClick={() => { setHint(''); setDraft(current => removeAdditionalDirectory(current, path)); }}><X size={14} aria-hidden="true"/></button>
                  </div>}
                </li>)}</ul>
                : <p className="gd-note">需要同时访问其他文件夹或代码仓库时，可在此添加。</p>}
            </section>
            {draft.repositories.length > 0 && <section className="workspace-dialog__block" aria-label="代码仓库">
              <div className="workspace-dialog__heading"><h3>代码仓库</h3></div>
              <p className="gd-note">旧配置中的代码仓库与其他目录等效，可保留或移除。</p>
              <ul className="workspace-dialog__list">{draft.repositories.map(path => <li className="gd-directory-row" key={path}>
                <GitBranch size={16} aria-hidden="true"/>
                <span className="gd-directory-copy">
                  <strong>{pathBaseName(path)}</strong>
                  <small title={path}>{path}</small>
                </span>
                {!readonly && <div className="gd-directory-actions">
                  <button type="button" className="gd-icon-action" disabled={saving} aria-label={`移除${pathBaseName(path)}`} title={removeTooltip} onClick={() => { setHint(''); setTouchedRepositories(true); setDraft(current => removeLegacyRepository(current, path)); }}><X size={14} aria-hidden="true"/></button>
                </div>}
              </li>)}</ul>
            </section>}
            {shared.shared && memberProject && onProject && <div className="workspace-dialog__footer-note">
              <span>多个群或 Bot 共用此工作区与项目记忆。</span>
              <button type="button" className="workspace-summary__project-link" disabled={saving} onClick={() => { discardAndClose(); onProject(memberProject.id); }}>查看项目页</button>
            </div>}
            {hint && <p className="gd-note" role="status">{hint}</p>}
            {error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}
          </>}
        </div>}
    </Dialog>
  </>;
}

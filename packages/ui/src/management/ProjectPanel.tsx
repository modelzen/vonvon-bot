import {useDirectoryPicker} from '../directory-picker';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, InlineNotice, Toggle } from "../reference/components/ui";
import { ConfirmDialog } from "../reference/components/ui/Dialog";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import { conversationCopy, conversationSchema, modeToConversation, type AgentId, type Conversation, type FolderChoice, type GroupId } from "@vonvon/protocol";
import type { CollaborationClient, CollaborationReply, ProjectRecord } from "@vonvon/protocol";
import "../settings/settings.css";
import {useClient, useShellCapabilities} from '../client-context';
import {groupUrl, openExternalUrl} from '../url-actions';
import {useDraft, useDraftGuard} from "../settings/DraftGuard";
import {settingAnchor} from '../search';
import {SettingChoices} from '../settings/SettingChoices';
import {AnnouncedReadonlyMessages, OFFLINE_SETTINGS_MESSAGE} from '../settings/readonly-messages';

type Props = {
  scope: { kind: "project"; agentId: AgentId; groupId: GroupId; projectName: string };
  request: CollaborationClient;
  onChanged: () => Promise<void>;
  inactiveReason?: string;
  children?: ReactNode;
};

function sameBinding(a: ProjectRecord, b: ProjectRecord): boolean {
  return a.name === b.name && a.chatId === b.chatId && a.cwd === b.cwd && a.kind === b.kind && a.backend === b.backend && a.enabled === b.enabled;
}


/** What the 会话方式 row says under a pick: its own line, or what a switch does to 免@ (s21, s25c). */
export function conversationNote(target: Conversation, current: Conversation): string {
  if (target === current) return conversationCopy[target].subtitle;
  if (target === "smart") return "智能开话题没有免 @，回不回由 Bot 判断；以后切回多会话或单会话时免 @ 是关。";
  if (current === "smart") return "切过去以后免 @ 是关，需要时在本页的「不 @ 也能发起任务」里改。";
  return "切换会话方式不改免 @，需要时在本页的「不 @ 也能发起任务」里改。";
}

/** What the page says after a save. Removing warns with the failed group step's raw error; a save's warning is a whole
 * sentence already ("已改成智能开话题，但没能在群里说一句：…", s25c), so it gets no second lead (审查低). */
export function appliedNotice(success: string, reply: { warning?: string; message?: string }, warningLead = "飞书群后续操作未完成："): string {
  return reply.warning ? `${success} ${warningLead}${reply.warning}` : reply.message || success;
}

/** The 会话方式 picker: the three of product.md 3.4, in its order. */
export function ConversationRow({ target, current, disabled, onChange, otherBots }: { otherBots?: boolean; target: Conversation; current: Conversation; disabled: boolean; onChange: (next: Conversation) => void }) {
  return <SettingsRow className="group-choice-row" title="会话方式" description={<>{conversationNote(target, current)}{otherBots && <><br />群里还有别的 bot。几个 bot 都选智能，它们才能互相 @、各自判断接不接话。</>}</>} trailing={<SettingChoices label="项目会话方式" value={target} disabled={disabled} onChange={onChange} stacked choices={conversationSchema.options.map(value => ({value, label: conversationCopy[value].title}))}/>} />;
}

export function removalNotice(reply: Pick<Extract<CollaborationReply, {kind: 'applied'}>, 'groupEffect' | 'warning'>): string {
  const base = '群绑定已解除，工作目录和文件已保留。';
  if (reply.warning) return appliedNotice(base, reply);
  if (reply.groupEffect === 'left') return `${base} Bot 已退出飞书群。`;
  if (reply.groupEffect === 'transferred') return `${base} 已转交飞书群主。`;
  if (reply.groupEffect === 'failed') return `${base} 飞书群后续操作未完成，请在飞书中检查。`;
  return base;
}

function replyError(reply: CollaborationReply): string | undefined {
  return reply.kind === "refused" ? reply.message : undefined;
}

type ProjectStatusState =
  | { kind: "loading" }
  | { kind: "ready"; enabled: boolean }
  | { kind: "error"; message: string };

export function ProjectStatus({ scope, request }: Pick<Props, "scope" | "request">) {
  const [state, setState] = useState<ProjectStatusState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    void request({ action: "project", agentId: scope.agentId, groupId: scope.groupId, projectName: scope.projectName })
      .then((reply) => {
        if (!active) return;
        setState(reply.kind === "project"
          ? { kind: "ready", enabled: reply.project.enabled }
          : { kind: "error", message: replyError(reply) ?? "无法读取群内状态。" });
      })
      .catch((failure: unknown) => {
        if (active) setState({ kind: "error", message: failure instanceof Error ? failure.message : "无法读取群内状态。" });
      });
    return () => { active = false; };
  }, [scope.agentId, scope.groupId, scope.projectName, request]);

  const status = state.kind === "loading" ? "读取中…" : state.kind === "ready" ? (state.enabled ? "已开启" : "已关闭") : "读取失败";
  return <SettingsRow title="在这个群中使用 Bot" description={state.kind === "error" ? state.message : undefined} value={<span role="status">{status}</span>} />;
}

export function ProjectPanel({ scope, request, onChanged, inactiveReason, children }: Props) {
  const shell = useShellCapabilities();
  const client = useClient();
  const [otherBots, setOtherBots] = useState(false);
  useEffect(() => {
    let active = true;
    setOtherBots(false);
    void client.settings({type: "read", scope: {kind: "project", botId: scope.agentId, projectName: scope.projectName}}).then(reply => {
      if (active && reply.kind === "view" && reply.view.scope.kind === "project" && "members" in reply.view && "chatId" in reply.view.identity && reply.view.identity.chatId === scope.groupId) {
        setOtherBots(reply.view.members.roster?.otherBots === true);
      }
    }).catch(() => {});
    return () => {active = false;};
  }, [client, scope.agentId, scope.projectName, scope.groupId]);
  const guard = useDraftGuard();
  const pickDirectory = useDirectoryPicker();
  const requestRef = useRef(request);
  requestRef.current = request;
  const inactiveRef = useRef(inactiveReason);
  inactiveRef.current = inactiveReason;
  const baseline = useRef<ProjectRecord | undefined>(undefined);
  const busy = useRef(false);
  const [folder, setFolder] = useState<FolderChoice>();
  const [conversation, setConversation] = useState<Conversation>("threads");
  const [enabled, setEnabled] = useState(true);
  const [project, setProject] = useState<ProjectRecord>();
  const [removed, setRemoved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const current = project ? modeToConversation(project.kind) : undefined;
  const changed = !!project && (conversation !== current || enabled !== project.enabled || !!folder);
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const bindingDisabled = saving || loading || !!inactiveReason;

  function acceptProject(next: ProjectRecord | undefined) {
    baseline.current = next;
    setProject(next);
  }

  useEffect(() => {
    let active = true;
    if (inactiveReason) {
      setLoading(false);
      setDeleteArmed(false);
      return;
    }
    setLoading(true);
    setError("");
    void requestRef.current({ action: "project", agentId: scope.agentId, projectName: scope.projectName, groupId: scope.groupId })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "project") {
          // A restart must not silently rebase an unsaved binding change onto
          // somebody else's update. Keep its original baseline for save's guard.
          if (changedRef.current && baseline.current) {
            if (!sameBinding(baseline.current, reply.project)) {
              setError('群绑定已在其他位置修改。请重新打开后再操作；当前修改已保留。');
            } else acceptProject(reply.project);
            return;
          }
          acceptProject(reply.project);
          setConversation(modeToConversation(reply.project.kind));
          setEnabled(reply.project.enabled);
        } else setError(replyError(reply) ?? "无法读取群内设置。");
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "无法读取群内设置。");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope.agentId, scope.projectName, scope.groupId, inactiveReason]);

  const target = { agentId: scope.agentId, projectName: scope.projectName, groupId: scope.groupId };
  async function reconciledRevision(): Promise<string | undefined> {
    if (inactiveRef.current) return undefined;
    const accepted = baseline.current;
    if (!accepted) return undefined;
    const reply = await requestRef.current({action: 'project', ...target});
    if (inactiveRef.current) return undefined;
    if (reply.kind !== 'project') {
      setError(replyError(reply) ?? '无法读取群内设置，请重新打开后重试。');
      return undefined;
    }
    if (!sameBinding(accepted, reply.project)) {
      setError('群绑定已在其他位置修改。请重新打开后再操作；当前修改已保留。');
      return undefined;
    }
    return reply.project.revision;
  }
  async function run(operation: () => Promise<CollaborationReply | undefined>, success: string, warningLead?: string) {
    if (busy.current || inactiveRef.current) return false;
    busy.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const reply = await operation();
      if (!reply) return false;
      if (reply.kind === "refused") { setError(reply.message); return false; }
      if (reply.kind !== "applied") { setError("daemon 返回了意外结果，请刷新后重试。"); return false; }
      if (reply.project) {
        acceptProject(reply.project);
        setFolder(undefined);
      } else {
        setRemoved(true);
        acceptProject(undefined);
        setDeleteArmed(false);
      }
      setNotice(reply.project ? appliedNotice(success, reply, warningLead) : removalNotice(reply));
      await onChanged();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败，请重试。");
      return false;
    } finally { busy.current = false; setSaving(false); }
  }

  async function saveDraft() {
    if (!baseline.current) return false;
    return run(async () => {
      const expectedRevision = await reconciledRevision();
      if (!expectedRevision || inactiveRef.current) return undefined;
      return requestRef.current({action: 'editProject', ...target, expectedRevision, ...(folder ? {folderToken: folder.token} : {}), conversation, enabled});
    }, '群内设置已保存。', '');
  }
  async function removeProject() {
    return run(async () => {
      const expectedRevision = await reconciledRevision();
      if (!expectedRevision || inactiveRef.current) return undefined;
      return requestRef.current({action: 'removeProject', ...target, expectedRevision});
    }, '群绑定已解除，工作目录和文件已保留。');
  }
  function discard() {
    setFolder(undefined);
    setConversation(project ? modeToConversation(project.kind) : 'threads');
    setEnabled(project?.enabled ?? true);
  }
  useDraft(changed, {title: '群内设置', save: inactiveReason ? undefined : saveDraft, discard});

  return <AnnouncedReadonlyMessages.Provider value={inactiveReason ? [OFFLINE_SETTINGS_MESSAGE] : []}>
    <section aria-label="群内设置" id={settingAnchor('群绑定')}>
    <SettingsGroup className="group-binding-settings" footer={project && (folder || conversation !== current) ? "新任务使用新的目录或会话方式，原目录和文件保留。" : undefined}>
      {inactiveReason && <SettingsRow title={inactiveReason} />}
      {loading && !inactiveReason && <SettingsRow title="正在读取群内设置" />}
      {project && <>
        <SettingsRow title="在这个群中使用 Bot" description="关闭后不处理群消息，设置和记录保留。" trailing={<Toggle className="settings-row-switch" aria-label="在这个群中使用 Bot" label="在这个群中使用 Bot" checked={enabled} disabled={bindingDisabled} onChange={event => setEnabled(event.target.checked)}/>} />
        <SettingsRow title="飞书群" description={<><span>{project.name}</span><span className="group-help-note">发送 <code>/help</code> 查看群内命令。</span></>} trailing={<Button size="sm" onClick={() => void openExternalUrl(groupUrl(scope.groupId), 'group', shell).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "无法打开飞书群。"))}>在飞书打开</Button>} />
        <SettingsRow title="工作目录" description={folder?.displayPath ?? project.cwd} trailing={<Button size="sm" disabled={bindingDisabled} onClick={() => void pickDirectory().then((choice) => { if (choice && !inactiveRef.current) setFolder(choice); }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "目录选择失败。"))}>更换目录</Button>} />
        <ConversationRow otherBots={otherBots} target={conversation} current={modeToConversation(project.kind)} disabled={bindingDisabled} onChange={setConversation} />
        <div className="settings-edit-actions"><Button size="sm" disabled={!changed || saving} onClick={discard}>放弃修改</Button><Button size="sm" variant="primary" loading={saving} disabled={!changed || bindingDisabled} onClick={() => void saveDraft()}>保存群内设置</Button></div>
      </>}
    </SettingsGroup>
    </section>
    {!removed && children}
    {project && !removed && <details className="membership-settings-details group-more-actions">
      <summary>更多操作</summary>
      <SettingsGroup id={settingAnchor('解除项目绑定')} className="membership-settings-danger" label="解除群绑定" footer="再次使用需要重新绑定；工作目录和文件会保留。">
        <SettingsRow title="解除绑定" description="移除当前 Bot 与这个群的关联。" trailing={<Button size="sm" variant="danger" disabled={bindingDisabled} onClick={() => setDeleteArmed(true)}>解除群绑定…</Button>} />
      </SettingsGroup>
    </details>}
    <ConfirmDialog open={deleteArmed && !inactiveReason} title="解除这个群的绑定？" tone="danger" confirmLabel="解除群绑定" pending={saving}
      description={`将解除“${project?.name ?? scope.projectName}”与当前 Bot 的绑定，再次使用需要重新绑定。工作目录和文件会保留。`}
      onCancel={() => setDeleteArmed(false)} onConfirm={() => {setDeleteArmed(false); guard.navigate(() => {void removeProject();});}}>
      <p>如果 Bot 加入了已有群，它会退出群聊；如果群由 Bot 创建，会尝试把群主转交给 Bot 所有者。</p>
    </ConfirmDialog>
    {error && !inactiveReason && <InlineNotice title="群内操作未完成" tone="danger">{error}</InlineNotice>}
    {notice && <InlineNotice title="群内设置已更新">{notice}</InlineNotice>}
  </AnnouncedReadonlyMessages.Provider>;
}

import {useDirectoryPicker} from '../directory-picker';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, InlineNotice } from "../reference/components/ui";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import { conversationCopy, conversationSchema, modeToConversation, type AgentId, type Conversation, type FolderChoice, type GroupId } from "@vonvon/protocol";
import type { CollaborationClient, CollaborationReply, ProjectRecord } from "@vonvon/protocol";
import "../settings/settings.css";
import {useClient, useShellCapabilities} from '../client-context';
import {groupUrl, openExternalUrl} from '../url-actions';
import {useDraft, useDraftGuard} from "../settings/DraftGuard";
import {settingAnchor} from '../search';

type Props = {
  scope: { kind: "project"; agentId: AgentId; groupId: GroupId; projectName: string };
  request: CollaborationClient;
  onChanged: () => Promise<void>;
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
  return <SettingsRow title="会话方式" description={<>{conversationNote(target, current)}{otherBots && <><br />群里还有别的 bot。几个 bot 都选智能，它们才能互相 @、各自判断接不接话。</>}</>} trailing={<select aria-label="项目会话方式" value={target} disabled={disabled} onChange={(event) => onChange(conversationSchema.catch(current).parse(event.target.value))}>{conversationSchema.options.map((value) => <option key={value} value={value}>{conversationCopy[value].title}</option>)}</select>} />;
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
          : { kind: "error", message: replyError(reply) ?? "无法读取项目状态。" });
      })
      .catch((failure: unknown) => {
        if (active) setState({ kind: "error", message: failure instanceof Error ? failure.message : "无法读取项目状态。" });
      });
    return () => { active = false; };
  }, [scope.agentId, scope.groupId, scope.projectName, request]);

  const status = state.kind === "loading" ? "读取中…" : state.kind === "ready" ? (state.enabled ? "已启用" : "已停用") : "读取失败";
  return <SettingsRow title="项目状态" description={state.kind === "error" ? state.message : undefined} value={<span role="status">{status}</span>} />;
}

export function ProjectPanel({ scope, request, onChanged, children }: Props) {
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

  function acceptProject(next: ProjectRecord | undefined) {
    baseline.current = next;
    setProject(next);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void requestRef.current({ action: "project", agentId: scope.agentId, projectName: scope.projectName, groupId: scope.groupId })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "project") {
          acceptProject(reply.project);
          setConversation(modeToConversation(reply.project.kind));
          setEnabled(reply.project.enabled);
        } else setError(replyError(reply) ?? "无法读取项目。");
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "无法读取项目。");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope.agentId, scope.projectName, scope.groupId]);

  const target = { agentId: scope.agentId, projectName: scope.projectName, groupId: scope.groupId };
  async function reconciledRevision(): Promise<string | undefined> {
    const accepted = baseline.current;
    if (!accepted) return undefined;
    const reply = await requestRef.current({action: 'project', ...target});
    if (reply.kind !== 'project') {
      setError(replyError(reply) ?? '无法读取项目，请重新打开后重试。');
      return undefined;
    }
    if (!sameBinding(accepted, reply.project)) {
      setError('项目绑定已由其他位置修改。请重新打开后再操作；当前修改已保留。');
      return undefined;
    }
    return reply.project.revision;
  }
  async function run(operation: () => Promise<CollaborationReply | undefined>, success: string, warningLead?: string) {
    if (busy.current) return false;
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
      setNotice(appliedNotice(success, reply, warningLead));
      await onChanged();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败，请重试。");
      return false;
    } finally { busy.current = false; setSaving(false); }
  }

  const current = project ? modeToConversation(project.kind) : undefined;
  const changed = !!project && (conversation !== current || enabled !== project.enabled || !!folder);
  async function saveDraft() {
    if (!baseline.current) return false;
    return run(async () => {
      const expectedRevision = await reconciledRevision();
      if (!expectedRevision) return undefined;
      return requestRef.current({action: 'editProject', ...target, expectedRevision, ...(folder ? {folderToken: folder.token} : {}), conversation, enabled});
    }, '项目已更新。', '');
  }
  async function removeProject() {
    return run(async () => {
      const expectedRevision = await reconciledRevision();
      if (!expectedRevision) return undefined;
      return requestRef.current({action: 'removeProject', ...target, expectedRevision});
    }, '项目绑定已解除，目录已保留。');
  }
  function discard() {
    setFolder(undefined);
    setConversation(project ? modeToConversation(project.kind) : 'threads');
    setEnabled(project?.enabled ?? true);
  }
  useDraft(changed, {title: '项目管理', save: saveDraft, discard});

  return <>
    <SettingsGroup id={settingAnchor('群绑定')} label="项目运行" footer="修改目录或会话方式会影响此后开始的任务。已有工作目录保留。">
      {loading && <SettingsRow title="正在读取项目" />}
      {project && <>
        <SettingsRow title="飞书群" value={project.name} trailing={<Button size="sm" onClick={() => void openExternalUrl(groupUrl(scope.groupId), 'group', shell).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "无法打开飞书群。"))}>在飞书打开</Button>} />
        <SettingsRow title="工作目录" description={folder?.displayPath ?? project.cwd} trailing={<Button size="sm" disabled={saving} onClick={() => void pickDirectory().then((choice) => { if (choice) setFolder(choice); }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "目录选择失败。"))}>更换目录</Button>} />
        <ConversationRow otherBots={otherBots} target={conversation} current={modeToConversation(project.kind)} disabled={saving} onChange={setConversation} />
        <SettingsRow title="项目状态" trailing={<select aria-label="项目状态" value={enabled ? "enabled" : "disabled"} disabled={saving} onChange={(event) => setEnabled(event.target.value === "enabled")}><option value="enabled">启用</option><option value="disabled">停用</option></select>} />
        <div className="settings-edit-actions"><Button size="sm" disabled={!changed || saving} onClick={() => { setConversation(modeToConversation(project.kind)); setEnabled(project.enabled); setFolder(undefined); }}>放弃修改</Button><Button size="sm" variant="primary" loading={saving} disabled={!changed} onClick={() => void saveDraft()}>保存项目</Button></div>
      </>}
    </SettingsGroup>
    {!removed && children}
    {project && !removed && <SettingsGroup id={settingAnchor('解除项目绑定')} className="membership-settings-danger" label="解除项目绑定" footer="只移除 Vonvon 的项目绑定。工作目录和其中的文件不会删除。">
      <SettingsRow title="解除绑定" description="此操作会结束 Bot 与此项目群的关联。" trailing={!deleteArmed ? <Button size="sm" variant="danger" disabled={saving} onClick={() => setDeleteArmed(true)}>解除绑定…</Button> : <div className="settings-inline-actions"><Button size="sm" onClick={() => setDeleteArmed(false)}>取消</Button><Button size="sm" variant="danger" loading={saving} onClick={() => {setDeleteArmed(false); guard.navigate(() => {void removeProject();});}}>确认解除</Button></div>} />
    </SettingsGroup>}
    {error && <InlineNotice title="项目操作未完成" tone="danger">{error}</InlineNotice>}
    {notice && <InlineNotice title="项目已更新">{notice}</InlineNotice>}
  </>;
}

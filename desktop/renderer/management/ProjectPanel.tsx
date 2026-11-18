import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, InlineNotice } from "../reference/components/ui";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import type { AgentId, FolderChoice, GroupId } from "../../shared/bridge";
import type { CollaborationClient, CollaborationReply, ProjectRecord } from "../../shared/collaboration";
import "../settings/settings.css";
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

async function chooseDirectory(): Promise<FolderChoice | null> {
  const result = await window.bridge.run({ type: "chooseFolder" });
  if (result.kind === "folderChosen") return result.folder;
  if (result.kind === "cancelled") return null;
  throw new Error(result.kind === "refused" ? result.message : "无法选择目录，请重试。");
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
  const guard = useDraftGuard();
  const requestRef = useRef(request);
  requestRef.current = request;
  const baseline = useRef<ProjectRecord | undefined>(undefined);
  const busy = useRef(false);
  const [folder, setFolder] = useState<FolderChoice>();
  const [conversation, setConversation] = useState<"shared" | "threads">("threads");
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
          setConversation(reply.project.kind === "multi" ? "threads" : "shared");
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
  async function run(operation: () => Promise<CollaborationReply | undefined>, success: string) {
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const reply = await operation();
      if (!reply) return false;
      if (reply.kind === "refused") { setError(reply.message); return false; }
      if (reply.kind !== "applied") { setError("Bridge 返回了意外结果，请刷新后重试。"); return false; }
      if (reply.project) {
        acceptProject(reply.project);
        setFolder(undefined);
      } else {
        setRemoved(true);
        acceptProject(undefined);
        setDeleteArmed(false);
      }
      setNotice(reply.warning ? `${success} 飞书群后续操作未完成：${reply.warning}` : reply.message || success);
      await onChanged();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败，请重试。");
      return false;
    } finally { busy.current = false; setSaving(false); }
  }

  const changed = !!project && (conversation !== (project.kind === "multi" ? "threads" : "shared") || enabled !== project.enabled || !!folder);
  async function saveDraft() {
    if (!baseline.current) return false;
    return run(async () => {
      const expectedRevision = await reconciledRevision();
      if (!expectedRevision) return undefined;
      return requestRef.current({action: 'editProject', ...target, expectedRevision, ...(folder ? {folderToken: folder.token} : {}), conversation, enabled});
    }, '项目已更新。');
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
    setConversation(project?.kind === 'single' ? 'shared' : 'threads');
    setEnabled(project?.enabled ?? true);
  }
  useDraft(changed, {title: '项目管理', save: saveDraft, discard});

  return <>
    <SettingsGroup id={settingAnchor('群绑定')} label="项目运行" footer="修改目录或会话方式会影响此后开始的任务。已有工作目录保留。">
      {loading && <SettingsRow title="正在读取项目" />}
      {project && <>
        <SettingsRow title="飞书群" value={project.name} trailing={<Button size="sm" onClick={() => void request({ action: "openGroup", ...target }).then((reply) => { if (reply.kind === "refused") setError(reply.message); }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "无法打开飞书群。"))}>在飞书打开</Button>} />
        <SettingsRow title="工作目录" description={folder?.displayPath ?? project.cwd} trailing={<Button size="sm" disabled={saving} onClick={() => void chooseDirectory().then((choice) => { if (choice) setFolder(choice); }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "目录选择失败。"))}>更换目录</Button>} />
        <SettingsRow title="会话方式" trailing={<select aria-label="项目会话方式" value={conversation} disabled={saving} onChange={(event) => setConversation(event.target.value === "shared" ? "shared" : "threads")}><option value="threads">每个话题独立会话</option><option value="shared">整群共享会话</option></select>} />
        <SettingsRow title="项目状态" trailing={<select aria-label="项目状态" value={enabled ? "enabled" : "disabled"} disabled={saving} onChange={(event) => setEnabled(event.target.value === "enabled")}><option value="enabled">启用</option><option value="disabled">停用</option></select>} />
        <div className="settings-edit-actions"><Button size="sm" disabled={!changed || saving} onClick={() => { setConversation(project.kind === "multi" ? "threads" : "shared"); setEnabled(project.enabled); setFolder(undefined); }}>放弃修改</Button><Button size="sm" variant="primary" loading={saving} disabled={!changed} onClick={() => void saveDraft()}>保存项目</Button></div>
      </>}
    </SettingsGroup>
    {!removed && children}
    {project && !removed && <SettingsGroup id={settingAnchor('解除项目绑定')} className="membership-settings-danger" label="解除项目绑定" footer="只移除 Bridge 的项目绑定。工作目录和其中的文件不会删除。">
      <SettingsRow title="解除绑定" description="此操作会结束 Agent 与此项目群的关联。" trailing={!deleteArmed ? <Button size="sm" variant="danger" disabled={saving} onClick={() => setDeleteArmed(true)}>解除绑定…</Button> : <div className="settings-inline-actions"><Button size="sm" onClick={() => setDeleteArmed(false)}>取消</Button><Button size="sm" variant="danger" loading={saving} onClick={() => {setDeleteArmed(false); guard.navigate(() => {void removeProject();});}}>确认解除</Button></div>} />
    </SettingsGroup>}
    {error && <InlineNotice title="项目操作未完成" tone="danger">{error}</InlineNotice>}
    {notice && <InlineNotice title="项目已更新">{notice}</InlineNotice>}
  </>;
}

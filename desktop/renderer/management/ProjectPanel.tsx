import { useEffect, useRef, useState } from "react";
import { Button, InlineNotice } from "../reference/components/ui";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import type { AgentId, FolderChoice, GroupId } from "../../shared/bridge";
import type { CollaborationClient, CollaborationReply, ProjectRecord } from "../../shared/collaboration";
import "../settings/settings.css";
import {useDraft} from "../settings/DraftGuard";

type Props = {
  scope: { kind: "agent"; agentId: AgentId } | { kind: "project"; agentId: AgentId; groupId: GroupId; projectName: string };
  request: CollaborationClient;
  onChanged: () => Promise<void>;
};

async function chooseDirectory(): Promise<FolderChoice | null> {
  const result = await window.bridge.run({ type: "chooseFolder" });
  if (result.kind === "folderChosen") return result.folder;
  if (result.kind === "cancelled") return null;
  throw new Error(result.kind === "refused" ? result.message : "无法选择目录，请重试。");
}

function replyError(reply: CollaborationReply): string | undefined {
  return reply.kind === "refused" ? reply.message : undefined;
}

export function ProjectPanel({ scope, request, onChanged }: Props) {
  const requestRef = useRef(request);
  requestRef.current = request;
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<FolderChoice>();
  const [useExisting, setUseExisting] = useState(false);
  const [conversation, setConversation] = useState<"shared" | "threads">("threads");
  const [tool, setTool] = useState<"codex" | "claude">("codex");
  const [enabled, setEnabled] = useState(true);
  const [project, setProject] = useState<ProjectRecord>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (scope.kind !== "project") return;
    let active = true;
    setLoading(true);
    setError("");
    void requestRef.current({ action: "project", agentId: scope.agentId, projectName: scope.projectName, groupId: scope.groupId })
      .then((reply) => {
        if (!active) return;
        if (reply.kind === "project") {
          setProject(reply.project);
          setConversation(reply.project.kind === "multi" ? "threads" : "shared");
          setEnabled(reply.project.enabled);
        } else setError(replyError(reply) ?? "无法读取项目。");
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "无法读取项目。");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope.kind, scope.agentId, scope.kind === "project" ? scope.projectName : "", scope.kind === "project" ? scope.groupId : ""]);

  async function run(operation: () => Promise<CollaborationReply>, success: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const reply = await operation();
      if (reply.kind === "refused") { setError(reply.message); return false; }
      if (reply.kind !== "applied") { setError("Bridge 返回了意外结果，请刷新后重试。"); return false; }
      if (reply.project) {
        setProject(reply.project);
        setFolder(undefined);
        if (scope.kind === "agent") {setName(""); setUseExisting(false); setTool("codex"); setConversation("threads");}
      } else if (scope.kind === "project") {
        setProject(undefined);
        setDeleteArmed(false);
      }
      setNotice(reply.warning ? `${success} 飞书群后续操作未完成：${reply.warning}` : reply.message || success);
      await onChanged();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "操作失败，请重试。");
      return false;
    } finally { setSaving(false); }
  }

  const changed = scope.kind === 'agent'
    ? Boolean(name || folder || useExisting || conversation !== 'threads' || tool !== 'codex')
    : !!project && (conversation !== (project.kind === "multi" ? "threads" : "shared") || enabled !== project.enabled || !!folder);
  async function saveDraft() {
    if (saving) return false;
    if (scope.kind === 'agent') {
      if (!name.trim() || (useExisting && !folder)) {setError('请填写项目名称并选择工作目录。'); return false;}
      return run(() => request({action: 'createProject', agentId: scope.agentId, name: name.trim(), folder: useExisting && folder ? {kind: 'existing', folderToken: folder.token} : {kind: 'default'}, tool, conversation}), '项目群已创建。');
    }
    if (!project) return false;
    return run(() => request({action: 'editProject', agentId: scope.agentId, projectName: scope.projectName, groupId: scope.groupId, expectedRevision: project.revision, ...(folder ? {folderToken: folder.token} : {}), conversation, enabled}), '项目已更新。');
  }
  function discard() {
    setName(''); setFolder(undefined); setUseExisting(false); setTool('codex');
    setConversation(scope.kind === 'project' && project?.kind === 'single' ? 'shared' : 'threads');
    setEnabled(project?.enabled ?? true);
  }
  useDraft(changed, {title: scope.kind === 'agent' ? '新建项目群' : '项目管理', save: saveDraft, discard});

  if (scope.kind === "agent") return (
    <SettingsGroup label="新建项目群" footer="创建后，Agent 会加入新群并绑定项目。空白项目使用 Agent 设置中的新项目默认目录。">
      <SettingsRow title="项目名称" trailing={<input aria-label="项目名称" className="settings-field" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />} />
      <SettingsRow title="会话方式" trailing={<select aria-label="会话方式" value={conversation} onChange={(event) => setConversation(event.target.value === "shared" ? "shared" : "threads")}><option value="threads">每个话题独立会话</option><option value="shared">整群共享会话</option></select>} />
      <SettingsRow title="执行工具" trailing={<select aria-label="执行工具" value={tool} onChange={(event) => setTool(event.target.value === "claude" ? "claude" : "codex")}><option value="codex">Codex</option><option value="claude">Claude</option></select>} />
      <SettingsRow title="工作目录" description={useExisting ? folder?.displayPath ?? "请选择现有目录" : "在默认项目根目录创建空白目录"} trailing={<div className="settings-inline-actions"><select aria-label="目录来源" value={useExisting ? "existing" : "default"} onChange={(event) => { setUseExisting(event.target.value === "existing"); setFolder(undefined); }}><option value="default">新建空白项目</option><option value="existing">使用现有目录</option></select>{useExisting && <Button size="sm" onClick={() => void chooseDirectory().then((choice) => { if (choice) setFolder(choice); }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "目录选择失败。"))}>选择目录</Button>}</div>} />
      <div className="settings-edit-actions"><Button variant="primary" size="sm" loading={saving} disabled={!name.trim() || (useExisting && !folder)} onClick={() => void saveDraft()}>创建项目群</Button></div>
      {error && <InlineNotice title="创建失败" tone="danger">{error}</InlineNotice>}
      {notice && <InlineNotice title="项目已创建">{notice}</InlineNotice>}
    </SettingsGroup>
  );

  const target = { agentId: scope.agentId, projectName: scope.projectName, groupId: scope.groupId };
  return <>
    <SettingsGroup label="项目管理" footer="修改目录或会话方式会影响此后开始的任务。已有工作目录保留。">
      {loading && <SettingsRow title="正在读取项目" />}
      {project && <>
        <SettingsRow title="飞书群" value={project.name} trailing={<Button size="sm" onClick={() => void request({ action: "openGroup", ...target }).then((reply) => { if (reply.kind === "refused") setError(reply.message); })}>在飞书打开</Button>} />
        <SettingsRow title="工作目录" description={folder?.displayPath ?? project.cwd} trailing={<Button size="sm" disabled={saving} onClick={() => void chooseDirectory().then((choice) => { if (choice) setFolder(choice); }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "目录选择失败。"))}>更换目录</Button>} />
        <SettingsRow title="会话方式" trailing={<select aria-label="项目会话方式" value={conversation} disabled={saving} onChange={(event) => setConversation(event.target.value === "shared" ? "shared" : "threads")}><option value="threads">每个话题独立会话</option><option value="shared">整群共享会话</option></select>} />
        <SettingsRow title="项目状态" trailing={<select aria-label="项目状态" value={enabled ? "enabled" : "disabled"} disabled={saving} onChange={(event) => setEnabled(event.target.value === "enabled")}><option value="enabled">启用</option><option value="disabled">停用</option></select>} />
        <div className="settings-edit-actions"><Button size="sm" disabled={!changed || saving} onClick={() => { setConversation(project.kind === "multi" ? "threads" : "shared"); setEnabled(project.enabled); setFolder(undefined); }}>放弃修改</Button><Button size="sm" variant="primary" loading={saving} disabled={!changed} onClick={() => void saveDraft()}>保存项目</Button></div>
      </>}
    </SettingsGroup>
    {project && <SettingsGroup label="解除项目绑定" footer="只移除 Bridge 的项目绑定。工作目录和其中的文件不会删除。">
      <SettingsRow title="解除绑定" description="此操作会结束 Agent 与此项目群的关联。" trailing={!deleteArmed ? <Button size="sm" variant="danger" disabled={saving} onClick={() => setDeleteArmed(true)}>解除绑定…</Button> : <div className="settings-inline-actions"><Button size="sm" onClick={() => setDeleteArmed(false)}>取消</Button><Button size="sm" variant="danger" loading={saving} onClick={() => void run(() => request({ action: "removeProject", ...target, expectedRevision: project.revision }), "项目绑定已解除，目录已保留。")}>确认解除</Button></div>} />
    </SettingsGroup>}
    {error && <InlineNotice title="项目操作未完成" tone="danger">{error}</InlineNotice>}
    {notice && <InlineNotice title="项目已更新">{notice}</InlineNotice>}
  </>;
}

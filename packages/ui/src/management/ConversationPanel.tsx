import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, InlineNotice } from "../reference/components/ui";
import { SettingsGroup, SettingsRow } from "../reference/components/system-settings";
import {settingAnchor} from '../search';
import type { AgentId, Conversation, GroupId } from "@vonvon/protocol";
import type { CollaborationClient, CollaborationReply } from "@vonvon/protocol";
import "../settings/settings.css";
import {useShellCapabilities} from '../client-context';
import {groupUrl, openExternalUrl} from '../url-actions';
import {SettingChoices} from '../settings/SettingChoices';

type Props = {
  agentId: AgentId;
  projectName: string;
  groupId: GroupId;
  /** 单会话 and 智能 have one main-area session, so both can clear it. */
  conversation: Conversation;
  request: CollaborationClient;
};
type History = Extract<CollaborationReply, { kind: "history" }>;
type Context = Extract<CollaborationReply, { kind: "context" }>;

export function ConversationPanel({ agentId, projectName, groupId, conversation, request }: Props) {
  const shell = useShellCapabilities();
  const requestRef = useRef(request);
  requestRef.current = request;
  const target = useMemo(() => ({ agentId, projectName, groupId }), [agentId, projectName, groupId]);
  const [history, setHistory] = useState<History>();
  const [selected, setSelected] = useState("");
  const [context, setContext] = useState<Context>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "bound" | "resumable">("all");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const reply = await requestRef.current({ action: "history", ...target });
    if (reply.kind === "history") {
      setHistory(reply);
      setSelected((current) => current && reply.sessions.some((item) => item.threadId === current && !item.detached) ? current : reply.sessions.find((item) => !item.detached)?.threadId ?? "");
      setError("");
    } else setError(reply.kind === "refused" ? reply.message : "无法读取会话历史。");
  }, [target]);

  useEffect(() => {
    let active = true;
    void requestRef.current({ action: "history", ...target }).then((reply) => {
      if (!active) return;
      if (reply.kind === "history") {
        setHistory(reply);
        setSelected(reply.sessions.find((item) => !item.detached)?.threadId ?? "");
      } else setError(reply.kind === "refused" ? reply.message : "无法读取会话历史。");
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "无法读取会话历史。"); });
    return () => { active = false; };
  }, [target]);

  useEffect(() => {
    if (!selected) { setContext(undefined); return; }
    let active = true;
    void requestRef.current({ action: "context", ...target, threadId: selected }).then((reply) => {
      if (!active) return;
      if (reply.kind === "context" && reply.threadId === selected) setContext(reply);
      else if (reply.kind === "refused") setError(reply.message);
    }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "无法读取会话状态。"); });
    return () => { active = false; };
  }, [selected, target]);

  const run = context?.threadId === selected ? context.run : null;
  useEffect(() => {
    if (!run || !selected) return;
    let active = true;
    const timer = setInterval(() => {
      void requestRef.current({ action: "context", ...target, threadId: selected }).then((reply) => {
        if (!active) return;
        if (reply.kind === "context" && reply.threadId === selected) setContext(reply);
        else if (reply.kind === "refused") setError(reply.message);
      }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "无法读取会话状态。"); });
    }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [Boolean(run), selected, target]);

  async function execute(action: Exclude<Parameters<CollaborationClient>[0], { action: "project" | "history" | "context" | "usage" | "openGroup" | "createProject" | "editProject" | "removeProject" | "shareUsage" }>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const reply = await request(action);
      if (reply.kind === "refused") { setError(reply.message); return; }
      if (reply.kind !== "applied") { setError("daemon 返回了意外结果，请重试。"); return; }
      setNotice(reply.message || success);
      await refresh();
      if (selected) {
        const next = await request({ action: "context", ...target, threadId: selected });
        if (next.kind === "context") setContext(next);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "会话操作失败。");
    } finally { setBusy(false); }
  }

  const needle = search.trim().toLocaleLowerCase();
  const sessions = history?.sessions.filter((item) =>
    filter !== "resumable" && (!needle || `${item.summary} ${item.threadId} ${item.backend}`.toLocaleLowerCase().includes(needle)),
  ) ?? [];
  const threads = history?.threads.filter((item) =>
    filter !== "bound" && !history.sessions.some((bound) => !bound.detached && bound.sessionId === item.sessionId) &&
    (!needle || `${item.name ?? ""} ${item.preview} ${item.sessionId}`.toLocaleLowerCase().includes(needle)),
  ) ?? [];
  const current = history?.sessions.find((item) => item.threadId === selected && !item.detached);
  return <div id={settingAnchor('会话管理')}>
    {current && <SettingsGroup label="当前会话" footer="清空和压缩只作用于当前会话。">
      <SettingsRow title="会话" value={current.summary || current.threadId} />
      <SettingsRow title="上下文" value={context?.usage ? `${context.usage.used.toLocaleString()} / ${context.usage.window?.toLocaleString() ?? "未知窗口"}` : "暂无可用统计"} trailing={<Button size="sm" onClick={() => void request({ action: "context", ...target, threadId: selected }).then((reply) => { if (reply.kind === "context") setContext(reply); else if (reply.kind === "refused") setError(reply.message); })}>刷新</Button>} />
      <SettingsRow title="会话操作" description={conversation === "threads" ? "多会话支持压缩上下文；清空仅适用于主区会话。" : undefined} trailing={<div className="settings-inline-actions"><Button size="sm" disabled={busy || conversation === "threads"} onClick={() => void execute({ action: "clear", ...target, threadId: selected }, "已开始新会话。")}>清空会话</Button><Button size="sm" disabled={busy} onClick={() => void execute({ action: "compact", ...target, threadId: selected }, "上下文已压缩。")}>压缩上下文</Button></div>} />
      <SettingsRow title="自主任务目标" trailing={<div className="settings-inline-actions"><input aria-label="自主任务目标" className="settings-field" value={objective} maxLength={4000} onChange={(event) => setObjective(event.target.value)} placeholder="输入目标" /><Button size="sm" disabled={busy || !objective.trim()} onClick={() => void execute({ action: "startGoal", ...target, threadId: selected, objective: objective.trim() }, "目标任务已开始。")}>开始</Button></div>} />
      {run && <>
        <SettingsRow title="正在运行" value={run.goal ? "自主目标" : "当前任务"} trailing={<div className="settings-inline-actions"><Button size="sm" variant="danger" disabled={busy || !run.canStop} onClick={() => void execute({ action: "stop", ...target, threadId: selected, runId: run.id }, "已请求停止任务。")}>停止</Button><Button size="sm" disabled={busy || !run.canEndGoal} onClick={() => void execute({ action: "endGoal", ...target, threadId: selected, runId: run.id }, "已结束目标。")}>结束目标</Button></div>} />
        {run.subagents?.map((subagent) => <SettingsRow key={subagent.id} title={`${subagent.name}：${Array.from(subagent.task).slice(0, 40).join("")}`} value={{ running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止" }[subagent.status]} trailing={subagent.status === "running" && subagent.stoppable ? <Button size="sm" disabled={busy} onClick={() => void execute({ action: "stopSubagent", ...target, threadId: selected, runId: run.id, subagentId: subagent.id }, "已请求停止子 agent。")}>停止</Button> : undefined} />)}
        <SettingsRow title="完成时提醒" value={run.reminderRequested ? "已开启" : "未开启"} trailing={<Button size="sm" disabled={busy || !run.canRemind} onClick={() => void execute({ action: "reminder", ...target, threadId: selected, runId: run.id, requested: !run.reminderRequested }, run.reminderRequested ? "已关闭提醒。" : "已开启提醒。")}>{run.reminderRequested ? "关闭提醒" : "开启提醒"}</Button>} />
      </>}
    </SettingsGroup>}
    <SettingsGroup label="历史会话" action={<Button size="sm" disabled={busy} onClick={() => void refresh()}>刷新</Button>} footer="可以在飞书打开已绑定的话题。可恢复的旧会话会重新绑定到此项目。">
      <SettingsRow title="搜索" trailing={<input aria-label="搜索历史会话" className="settings-field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="标题、摘要或会话 ID" />} />
      <SettingsRow title="筛选" trailing={<SettingChoices label="筛选历史会话" value={filter} disabled={false} onChange={setFilter} choices={[{value: 'all', label: '全部'}, {value: 'bound', label: '已绑定'}, {value: 'resumable', label: '可恢复'}]}/>} />
      {sessions.map((item) => <SettingsRow key={item.threadId} title={item.summary || "未命名会话"} description={`${new Date(item.updatedAt).toLocaleString()} · ${item.backend} · ${item.cwd}${item.detached ? " · 已归档" : ""}`} trailing={<Button size="sm" onClick={() => void openExternalUrl(groupUrl(groupId, item.threadId), 'group', shell).catch(error => setError(error instanceof Error ? error.message : '无法打开飞书群。'))}>在飞书打开</Button>} />)}
      {history?.threadsError && <InlineNotice title="旧会话暂不可读取" tone="warning">{history.threadsError}</InlineNotice>}
      {threads.map((item) => <SettingsRow key={item.sessionId} title={item.name || item.preview || "旧会话"} description={`${new Date(item.updatedAt * 1000).toLocaleString()} · 可恢复`} trailing={<Button size="sm" loading={busy} onClick={() => history && void execute({ action: "resume", ...target, sessionId: item.sessionId, backend: history.backend }, "已恢复会话。")}>恢复</Button>} />)}
      {!history && !error && <p className="settings-operation-message" role="status">正在读取会话…</p>}
      {history && sessions.length === 0 && threads.length === 0 && !history.threadsError && <SettingsRow title={needle || filter !== 'all' ? '没有匹配的会话' : '暂无历史会话'} description={needle || filter !== 'all' ? '试试其他关键词或筛选条件。' : undefined} />}
    </SettingsGroup>
    {error && <InlineNotice title="会话操作未完成" tone="danger">{error}</InlineNotice>}
    {notice && <InlineNotice title="会话已更新">{notice}</InlineNotice>}
  </div>;
}

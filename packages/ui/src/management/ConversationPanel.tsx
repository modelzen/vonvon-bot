import {ArrowUpRight, Bot, ChevronDown, History as HistoryIcon, MessageSquare, RefreshCw, Search, Target} from 'lucide-react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Button, IconButton, InlineNotice} from '../reference/components/ui';
import {settingAnchor} from '../search';
import {backendLabel, type AgentId, type Conversation, type GroupId, type CollaborationClient, type CollaborationReply} from '@vonvon/protocol';
import {useShellCapabilities} from '../client-context';
import {groupUrl, openExternalUrl} from '../url-actions';
import {SettingChoices} from '../settings/SettingChoices';
import '../settings/settings.css';
import './conversation-panel.css';

function shortTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
}
const fullTime = (timestamp: number) => new Date(timestamp).toLocaleString();

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
  const usage = context?.threadId === selected ? context.usage : null;
  const windowSize = usage?.window;
  const measured = usage && typeof windowSize === 'number' && Number.isFinite(windowSize) && windowSize > 0;
  const percent = measured ? Math.round((usage.used / windowSize) * 100) : undefined;
  return <div id={settingAnchor('会话管理')} className="conversation-panel">
    {current && <section className="conversation-panel-current" aria-label="当前会话">
      <div className="conversation-panel-current-body">
        <div className="conversation-panel-eyebrow"><span>当前会话</span><span title={current.backend}>{backendLabel(current.backend)}</span></div>
        <h3 title={current.summary || current.threadId}>{current.summary || current.threadId}</h3>
        <div className="conversation-panel-context">
          <div className="conversation-panel-context-value">
            <span>上下文</span>
            <strong>{usage ? usage.used.toLocaleString() : '暂无可用统计'}</strong>
            {usage && <span>{measured ? `/ ${windowSize.toLocaleString()}` : '· 窗口未知'}</span>}
            {percent !== undefined && <small>{percent}%</small>}
            <IconButton size="sm" variant="ghost" label="刷新" title="刷新会话上下文" onClick={() => void request({ action: "context", ...target, threadId: selected }).then((reply) => { if (reply.kind === "context") setContext(reply); else if (reply.kind === "refused") setError(reply.message); })}><RefreshCw size={14} strokeWidth={1.7} aria-hidden="true"/></IconButton>
          </div>
          {measured && <progress aria-label="上下文使用量" value={usage.used} max={windowSize}/>}
        </div>
        <div className="conversation-panel-session-actions">
          <Button size="sm" disabled={busy} onClick={() => void execute({ action: "compact", ...target, threadId: selected }, "上下文已压缩。")}>压缩上下文</Button>
          <Button size="sm" variant="ghost" disabled={busy || conversation === "threads"} onClick={() => void execute({ action: "clear", ...target, threadId: selected }, "已开始新会话。")}>清空会话</Button>
        </div>
        <p className="conversation-panel-note">{conversation === "threads" ? "多会话支持压缩上下文；清空仅适用于主区会话。" : "清空和压缩只作用于当前会话。"}</p>
      </div>
      <details className="conversation-panel-goal">
        <summary><Target size={14} strokeWidth={1.7} aria-hidden="true"/><span>自主任务目标</span><ChevronDown size={13} aria-hidden="true"/></summary>
        <div><input aria-label="自主任务目标" value={objective} maxLength={4000} onChange={event => setObjective(event.target.value)} placeholder="输入目标"/><Button size="sm" disabled={busy || !objective.trim()} onClick={() => void execute({ action: "startGoal", ...target, threadId: selected, objective: objective.trim() }, "目标任务已开始。")}>开始</Button></div>
      </details>
      {run && <section className="conversation-panel-run" aria-label="正在运行">
        <div className="conversation-panel-run-heading">
          <strong role="status"><span className="conversation-panel-running-dot" aria-hidden="true"/>{run.goal ? '自主目标运行中' : '当前任务运行中'}</strong>
          <div className="conversation-panel-run-actions">
            <Button size="sm" variant="danger" disabled={busy || !run.canStop} onClick={() => void execute({ action: "stop", ...target, threadId: selected, runId: run.id }, "已请求停止任务。")}>停止</Button>
            <Button size="sm" disabled={busy || !run.canEndGoal} onClick={() => void execute({ action: "endGoal", ...target, threadId: selected, runId: run.id }, "已结束目标。")}>结束目标</Button>
          </div>
        </div>
        {run.subagents?.length ? <div className="conversation-panel-subagents">
          {run.subagents.map(subagent => <div className="conversation-panel-subagent" key={subagent.id}>
            <Bot size={15} strokeWidth={1.7} aria-hidden="true"/>
            <div><strong>{subagent.name}</strong><span title={subagent.task}>{Array.from(subagent.task).slice(0, 40).join('')}</span></div>
            <small data-status={subagent.status}>{{running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止'}[subagent.status]}</small>
            {subagent.status === 'running' && subagent.stoppable && <Button size="sm" aria-label={`停止子 agent ${subagent.name}`} disabled={busy} onClick={() => void execute({ action: "stopSubagent", ...target, threadId: selected, runId: run.id, subagentId: subagent.id }, "已请求停止子 agent。")}>停止</Button>}
          </div>)}
        </div> : null}
        <div className="conversation-panel-reminder"><span>完成时提醒<small>{run.reminderRequested ? '已开启' : '未开启'}</small></span><Button size="sm" variant="ghost" disabled={busy || !run.canRemind} onClick={() => void execute({ action: "reminder", ...target, threadId: selected, runId: run.id, requested: !run.reminderRequested }, run.reminderRequested ? "已关闭提醒。" : "已开启提醒。")}>{run.reminderRequested ? '关闭提醒' : '开启提醒'}</Button></div>
      </section>}
    </section>}
    <section className="conversation-panel-history" aria-label="历史会话">
      <header><h3>历史会话</h3><IconButton size="sm" variant="ghost" label="刷新" title="刷新历史会话" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton></header>
      <div className="conversation-panel-toolbar">
        <label className="conversation-panel-search"><Search size={15} strokeWidth={1.7} aria-hidden="true"/><input aria-label="搜索历史会话" value={search} onChange={event => setSearch(event.target.value)} placeholder="标题、摘要或会话 ID"/></label>
        <SettingChoices label="筛选历史会话" value={filter} disabled={false} onChange={setFilter} choices={[{value: 'all', label: '全部'}, {value: 'bound', label: '已绑定'}, {value: 'resumable', label: '可恢复'}]}/>
      </div>
      <div className="conversation-panel-list">
        {sessions.map(item => <article className="conversation-panel-history-row" key={item.threadId}>
          <details className="conversation-panel-session-detail">
            <summary title={item.cwd} aria-label={`查看${item.summary || '未命名会话'}的详情`}>
              <MessageSquare size={17} strokeWidth={1.6} aria-hidden="true"/>
              <span className="conversation-panel-history-copy"><strong title={item.summary || '未命名会话'}>{item.summary || '未命名会话'}</strong><span><time title={fullTime(item.updatedAt)}>{shortTime(item.updatedAt)}</time><span title={item.backend}>{backendLabel(item.backend)}</span>{item.detached && <span>已归档</span>}</span></span>
              <ChevronDown className="conversation-panel-detail-chevron" size={12} aria-hidden="true"/>
            </summary>
            <dl><dt>会话 ID</dt><dd>{item.threadId}</dd><dt>Provider 会话</dt><dd>{item.sessionId}</dd><dt>后端</dt><dd>{item.backend}</dd><dt>目录</dt><dd>{item.cwd}</dd><dt>创建于</dt><dd>{fullTime(item.createdAt)}</dd><dt>更新于</dt><dd>{fullTime(item.updatedAt)}</dd></dl>
          </details>
          <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(groupUrl(groupId, item.threadId), 'group', shell).catch(error => setError(error instanceof Error ? error.message : '无法打开飞书群。'))}>在飞书打开<ArrowUpRight size={12} aria-hidden="true"/></Button>
        </article>)}
        {history?.threadsError && <InlineNotice title="旧会话暂不可读取" tone="warning">{history.threadsError}</InlineNotice>}
        {threads.map(item => <article className="conversation-panel-history-row" key={item.sessionId}>
          <details className="conversation-panel-session-detail">
            <summary aria-label={`查看${item.name || item.preview || '旧会话'}的详情`}>
              <HistoryIcon size={17} strokeWidth={1.6} aria-hidden="true"/>
              <span className="conversation-panel-history-copy"><strong title={item.name || item.preview || '旧会话'}>{item.name || item.preview || '旧会话'}</strong><span><time title={fullTime(item.updatedAt * 1000)}>{shortTime(item.updatedAt * 1000)}</time><span title={history?.backend}>{backendLabel(history?.backend ?? '')}</span><span>可恢复</span></span></span>
              <ChevronDown className="conversation-panel-detail-chevron" size={12} aria-hidden="true"/>
            </summary>
            <dl><dt>会话 ID</dt><dd>{item.sessionId}</dd><dt>后端</dt><dd>{history?.backend}</dd>{item.preview && <><dt>摘要</dt><dd>{item.preview}</dd></>}<dt>创建于</dt><dd>{fullTime(item.createdAt * 1000)}</dd><dt>更新于</dt><dd>{fullTime(item.updatedAt * 1000)}</dd></dl>
          </details>
          <Button size="sm" loading={busy} onClick={() => history && void execute({ action: "resume", ...target, sessionId: item.sessionId, backend: history.backend }, "已恢复会话。")}>恢复</Button>
        </article>)}
        {!history && !error && <p className="conversation-panel-empty" role="status">正在读取会话…</p>}
        {history && sessions.length === 0 && threads.length === 0 && !history.threadsError && <div className="conversation-panel-empty"><MessageSquare size={21} strokeWidth={1.5} aria-hidden="true"/><strong>{needle || filter !== 'all' ? '没有匹配的会话' : '暂无历史会话'}</strong>{(needle || filter !== 'all') && <span>试试其他关键词或筛选条件。</span>}</div>}
      </div>
      <p className="conversation-panel-note">可以在飞书打开已绑定的话题。可恢复的旧会话会重新绑定到此项目。</p>
    </section>
    {error && <InlineNotice title="会话操作未完成" tone="danger">{error}</InlineNotice>}
    {notice && <InlineNotice title="会话已更新">{notice}</InlineNotice>}
  </div>;
}

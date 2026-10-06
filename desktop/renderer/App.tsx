import {PendingGroupToasts} from './PendingGroupToasts';
import {JoinGroupDialog} from './JoinGroupDialog';
import {usePendingGroups} from './pending-groups';
import type {PendingGroup} from '../shared/bridge';
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  MessageSquare,
  Monitor,
  Plus,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { AppShell } from "./LocalShell";
import { AgentAvatar } from './AgentAvatar';
import { GroupAvatar } from './GroupAvatar';
import {
  SettingsGroup,
  SettingsRow,
} from "./reference/components/system-settings";
import {
  Button,
  FormField,
  IconButton,
  InlineNotice,
  StatusBadge,
  Toggle,
} from "./reference/components/ui";
import { ConfirmDialog,Dialog } from "./reference/components/ui/Dialog";
import {
  type AgentId,
  type Command,
  type CommandResult,
  type DesktopSnapshot,
  type Job,
  type JobId,
  type Membership,
} from "../shared/bridge";
import type { CollaborationView, Page } from "./collaboration-model";
import {SettingsPanel,membershipSettingsTarget} from "./settings/SettingsPanel";
import {DraftGuardProvider, useDraftGuard} from './settings/DraftGuard';
import {searchEntries, settingAnchor, type Destination, type SearchEntry, type Selection} from './search';
import {initialRoute, openMembership, routeBack, routeDetail, routeFromSearch, routeSelection, routeView, type AgentPane, type CollaborationRoute, type MembershipPane} from './collaboration-navigation';
import {SearchDialog} from './SearchDialog';
import {flushSync} from 'react-dom';
import {ProjectPanel, ProjectStatus} from './management/ProjectPanel';
import {ConversationPanel} from './management/ConversationPanel';
import {ShareUsagePanel, UsagePanel} from './management/UsagePanel';
import {EnvironmentPanel} from './management/EnvironmentPanel';
import {MachinePanel} from './management/MachinePanel';
import {LogPanel} from './management/LogPanel';
import {UpdatePanel} from './management/UpdatePanel';

type Modal =
  | { kind: "register"; jobId: JobId; refresh?: boolean }
  | { kind: "join"; agentId: AgentId; group?: PendingGroup }
  | { kind: "collaboration"; membership: Membership }
  | { kind: "shareUsage" }
  | { kind: "deleteAgent"; agentId: AgentId; name: string }
  | null;

const backendName = (backend: string) =>
  backend === "codex-appserver"
    ? "Codex"
    : backend === "claude-agent"
      ? "Claude"
      : `${backend}（暂不支持修改）`;
const connectedLabel = (connection: string) =>
  connection === "connected"
    ? "已连接"
    : connection === "disconnected"
      ? "未连接"
      : connection === "connecting"
        ? "连接中"
        : connection === "reconnecting"
          ? "重连中"
          : "连接状态未知";
const agentListStatus = (agent: DesktopSnapshot["agents"][number]): { label: string; tone: "warning" | "neutral" | "success" } => {
  if (agent.readError) return { label: "读取失败", tone: "warning" };
  if (!agent.enabled && agent.running)
    return { label: "尚未停止", tone: "warning" };
  if (agent.activation === "restartRequired")
    return { label: "待生效", tone: "warning" };
  if (!agent.enabled) return { label: "已停用", tone: "neutral" };
  return {
    label: connectedLabel(agent.connection),
    tone: agent.connection === "connected" ? "success" : "neutral",
  };
};
const isActive = (job: Job) =>
  !["succeeded", "failed", "cancelled"].includes(job.phase);

function DetailTabs({selected, onSelect, first, second}: {selected: 'overview' | 'settings'; onSelect: (next: 'overview' | 'settings') => void; first: string; second: string}) {
  return <nav className="collaboration-detail-tabs" aria-label="详情视图">
    <button type="button" aria-current={selected === 'overview' ? 'page' : undefined} className={selected === 'overview' ? 'is-selected' : ''} onClick={() => onSelect('overview')}>{first}</button>
    <button type="button" aria-current={selected === 'settings' ? 'page' : undefined} className={selected === 'settings' ? 'is-selected' : ''} onClick={() => onSelect('settings')}>{second}</button>
  </nav>;
}

export function App() {
  return <DraftGuardProvider><DesktopApp /></DraftGuardProvider>;
}
function DesktopApp() {
  const {navigate} = useDraftGuard();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<Destination>();
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [route, setRoute] = useState<CollaborationRoute>(initialRoute);
  const [page, setPage] = useState<Page>("collaboration");
  const view = routeView(route);
  const selection = routeSelection(route);
  const detail = routeDetail(route);
  const [modal, setModal] = useState<Modal>(null);
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const modalGeneration = useRef(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const pendingGroups = usePendingGroups(snapshot);
  const [attachedNotice, setAttachedNotice] = useState(true);
  useEffect(() => window.bridge.onQuitRequested(() => navigate(() => void window.bridge.run({type: 'quit'}))), [navigate]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  useEffect(() => {
    if (!searchTarget) return;
    function focus() {
      const section = searchTarget?.section && document.getElementById(settingAnchor(searchTarget.section));
      if (!section) {
        if ((searchTarget?.section === 'CLI 转发' || searchTarget?.section === 'CLI 通知设置') &&
          document.querySelector('[data-search-title="通知状态"]')) {
          const selector = document.querySelector<HTMLSelectElement>('select[aria-label="通知 Agent"]');
          if (selector) {
            selector.scrollIntoView({block: 'center'});
            selector.focus({preventScroll: true});
            setNotice({message: searchTarget?.guide ?? '请先选择通知 Agent。', error: false});
            setSearchTarget(undefined);
            return true;
          }
        }
        return false;
      }
      if ((searchTarget.selection?.kind === 'agent' && searchTarget.detail?.kind === 'agent-settings') || searchTarget.detail?.kind === 'membership-settings') {
        let ancestor: HTMLElement | null = section;
        while (ancestor) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
          ancestor = ancestor.parentElement;
        }
      }
      const rows = Array.from(section.querySelectorAll<HTMLElement>('[data-search-title]'));
      const row = searchTarget?.field ? rows.find(element => element.dataset.searchTitle === searchTarget.field) : undefined;
      const controls = Array.from(section.querySelectorAll<HTMLElement>('button, input, select, textarea, label, dt'));
      const control = searchTarget?.field ? controls.find(element => element.getAttribute('aria-label') === searchTarget.field || element.textContent?.trim() === searchTarget.field) : undefined;
      if (searchTarget?.field && !row && !control) return false;
      const candidate = row ?? control;
      if (candidate?.closest('details:not([open]), [hidden]')) return false;
      const target = candidate && !candidate.closest('[hidden]') ? candidate.querySelector<HTMLElement>('input, select, textarea, button') ?? candidate : section;
      target.scrollIntoView({block: 'center'});
      if (!target.matches('input, select, textarea, button')) target.tabIndex = -1;
      target.focus({preventScroll: true});
      if (searchTarget.guide && !searchTarget.reveal?.endsWith('-tool')) setNotice({message: searchTarget.guide, error: false});
      setSearchTarget(undefined);
      return true;
    }
    if (focus()) return;
    const observer = new MutationObserver(() => {if (focus()) observer.disconnect();});
    observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open']});
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      setNotice({message: searchTarget.guide ?? '这项设置当前不可用。请检查页面状态或重新读取。', error: false});
      setSearchTarget(undefined);
    }, 3500);
    return () => {observer.disconnect(); window.clearTimeout(timeout);};
  }, [searchTarget, page, selection]);
  useEffect(
    () =>
      window.bridge.watch((next) => {
        setSnapshot(next);
        document.documentElement.dataset.desktopPlatform =
          next.application.platform;
      }),
    [],
  );
  async function run(
    command: Command,
    isCurrent: () => boolean = () => true,
  ): Promise<CommandResult> {
    setPending((count) => count + 1);
    setNotice(undefined);
    try {
      const result = await window.bridge.run(command);
      if (
        isCurrent() &&
        (result.kind === "refused" || result.kind === "outcomeUnknown")
      )
        setNotice({ message: result.message, error: true });
      if (isCurrent() && result.kind === "activationPending")
        setNotice({ message: result.message, error: false });
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "应用未能完成操作。";
      if (isCurrent()) setNotice({ message, error: true });
      return { kind: "refused", code: "ipc-failed", message };
    } finally {
      setPending((count) => count - 1);
    }
  }
  function select(next: Selection) {
    if (!snapshot) return;
    navigate(() => {
      setRoute(current => next.kind === 'overview'
        ? {kind: 'list', view: routeView(current)}
        : next.kind === 'agent'
          ? {kind: 'agent', id: next.id, pane: {kind: 'groups'}}
          : next.kind === 'group'
            ? {kind: 'group', id: next.id}
            : openMembership(current, next.id, snapshot));
      setPage("collaboration");
      setNotice(undefined);
    });
  }
  function changeRoute(next: (current: CollaborationRoute) => CollaborationRoute) {
    navigate(() => {
      setRoute(next);
      setPage('collaboration');
      setNotice(undefined);
    });
  }
  function agentPane(pane: AgentPane) {
    changeRoute(current => current.kind === 'agent' ? {...current, pane} : current);
  }
  function membershipPane(pane: MembershipPane) {
    changeRoute(current => current.kind === 'membership' ? {...current, pane} : current);
  }
  function openList(next: CollaborationView) {
    navigate(() => {
      setRoute({kind: 'list', view: next});
      setPage('collaboration');
      setNotice(undefined);
    });
  }
  function openPage(next: Page) { navigate(() => setPage(next)); }
  function openSearchResult(entry: SearchEntry) {
    if (!snapshot) return;
    flushSync(() => setSearchOpen(false));
    navigate(() => {
      setPage(entry.destination.page);
      const target = routeFromSearch(entry.destination, snapshot);
      if (target) setRoute(target.route);
      setSearchTarget(target?.missing ? undefined : entry.destination.section ? entry.destination : undefined);
      setNotice(target?.missing ? {message: target.missing, error: false} : undefined);
    });
  }
  async function register(agentId?: AgentId) {
    const result = await run(agentId ? {type: "refreshAgentCredentials", agentId} : { type: "registerAgent" });
    if (result.kind === "started")
      setModal({ kind: "register", jobId: result.jobId, refresh: Boolean(agentId) });
  }
  function openJoin(agentId: AgentId, group?: PendingGroup) {
    navigate(() => setModal({kind: 'join', agentId, group}));
  }
  async function closeModal() {
    const generation = ++modalGeneration.current;
    if (modal?.kind === "register")
      await run({ type: "cancelJob", jobId: modal.jobId });
    if (generation === modalGeneration.current) setModal(null);
  }
  if (!snapshot)
    return (
      <div className="desktop-loading" role="status">
        正在打开 Vonvon Bot…
      </div>
    );
  const member =
    selection.kind === "membership"
      ? snapshot.memberships.find((item) => item.id === selection.id)
      : undefined;
  const agent =
    selection.kind === "agent"
      ? snapshot.agents.find((item) => item.id === selection.id)
      : member
        ? snapshot.agents.find((item) => item.id === member.agentId)
        : undefined;
  const group =
    selection.kind === "group"
      ? snapshot.groups.find((item) => item.id === selection.id)
      : member
        ? snapshot.groups.find((item) => item.id === member.groupId)
        : undefined;
  const titles: Record<Page, string> = {
    collaboration: member
      ? `${group?.name ?? '飞书群'} · ${agent?.name ?? 'Agent'}`
      : (agent?.name ?? group?.name ?? (view === "agents" ? "Agent" : "群聊")),
    environment: "本机环境",
    usage: "用量",
    coffee: "咖啡一下",
    application: "应用与启动",
    diagnostics: "状态与诊断",
  };
  const host = snapshot.host;
  const ready = host.kind === "connected";
  const registration =
    modal?.kind === "register"
      ? snapshot.jobs.find((job) => job.id === modal.jobId)
      : undefined;
  const parentLabel = route.kind === 'membership'
    ? route.parent.kind === 'agent'
      ? snapshot.agents.find(item => item.id === route.parent.id)?.name ?? 'Agent'
      : snapshot.groups.find(item => item.id === route.parent.id)?.name ?? '群聊'
    : routeView(route) === 'agents' ? 'Agent 列表' : '群聊列表';
  function membershipRows(
    members: Membership[],
    perspective: CollaborationView,
  ) {
    return members.map((m) => {
      const a = snapshot?.agents.find((item) => item.id === m.agentId);
      const g = snapshot?.groups.find((item) => item.id === m.groupId);
      if (!a || !g) return null;
      return (
        <button
          className="settings-entity-row"
          key={m.id}
          onClick={() => select({ kind: "membership", id: m.id })}
        >
          {perspective === 'agents'
            ? <GroupAvatar group={g} />
            : <AgentAvatar agent={a} />}
          <span className="settings-entity-row__copy">
            <strong>{perspective === "agents" ? g.name : a.name}</strong>
            <small>
              {backendName(m.backend)} ·{" "}
              {m.conversation === "threads" ? "按话题独立会话" : "整群连续会话"}
              {' '}· 查看群内协作
            </small>
          </span>
          <span className="settings-entity-row__value">
            {m.stale
              ? "状态过期"
              : agentListStatus(a).label}
          </span>
          <ChevronRight size={15} />
        </button>
      );
    });
  }
  const feedback = notice && (
    <InlineNotice
      title={notice.error ? "操作未完成" : "操作提示"}
      tone={notice.error ? "warning" : "info"}
      actions={
        <IconButton label="关闭提示" onClick={() => setNotice(undefined)}>
          <X size={14} />
        </IconButton>
      }
    >
      {notice.message}
    </InlineNotice>
  );
  return (
    <>
      <AppShell
        page={page}
        view={view}
        title={titles[page]}
        onNavigate={openPage}
        onSearch={() => setSearchOpen(true)}
        onOpenList={openList}
        backLabel={`返回 ${parentLabel}`}
        onBack={
          page === "collaboration" && route.kind !== 'list'
            ? () => changeRoute(routeBack)
            : undefined
        }
      >
        <div className="page-stack">
          {page === 'collaboration' && route.kind !== 'list' && <nav className="collaboration-breadcrumb" aria-label="当前位置">
            <button type="button" onClick={() => openList(view)}>{view === 'agents' ? 'Agent' : '群聊'}</button>
            <ChevronRight size={12} aria-hidden="true" />
            {route.kind === 'membership' && <>
              <button type="button" onClick={() => changeRoute(routeBack)}>{parentLabel}</button>
              <ChevronRight size={12} aria-hidden="true" />
            </>}
            <span aria-current="page">{route.kind === 'membership' ? route.parent.kind === 'agent' ? group?.name ?? '飞书群' : agent?.name ?? 'Agent' : agent?.name ?? group?.name ?? '内容已变化'}</span>
          </nav>}
          {pendingGroups.map(page => {
            const owner = snapshot.agents.find(item => item.id === page.agentId);
            if (!owner || (!page.groups.length && page.problem?.kind !== 'failed')) return null;
            return <div key={page.agentId} className="page-stack">
              {page.problem?.kind === 'failed' && <InlineNotice title={`${owner.name} 的绑定通知读取失败`} tone="warning">{page.problem.message}</InlineNotice>}
              {page.groups.map(group => <InlineNotice key={group.chatId} title={`${owner.name} 已加入 ${group.name}`} actions={<Button onClick={() => openJoin(owner.id, group)}>继续绑定</Button>}>尚未绑定工作目录，可以继续完成设置。</InlineNotice>)}
            </div>;
          })}
          {feedback}
          {!ready && (
            <InlineNotice
              title={
                host.kind === "starting" ? "正在连接 Bridge" : "Bridge 尚未就绪"
              }
              tone="warning"
            >
              {host.kind === "blocked" || host.kind === "disconnected"
                ? host.message
                : "正在读取本机运行状态。"}
            </InlineNotice>
          )}
          {snapshot.stale && ready && (
            <InlineNotice
              title="状态可能已过期"
              tone="warning"
              actions={
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run({ type: "refresh" })}
                >
                  重新读取
                </Button>
              }
            >
              保留上次成功读取的群配置。读取恢复前请勿重复绑定。
            </InlineNotice>
          )}
          {page === "collaboration" && (
            <>
              {route.kind === 'list' && host.kind === "connected" &&
                host.ownership === "attached" &&
                attachedNotice && (
                  <InlineNotice
                    title="已接续现有 Bridge"
                    actions={
                      <IconButton
                        label="关闭接续提示"
                        onClick={() => setAttachedNotice(false)}
                      >
                        <X size={14} />
                      </IconButton>
                    }
                  >
                    已有 Agent 与群配置继续保留。关闭本应用不会停止原有服务。
                  </InlineNotice>
                )}
              {route.kind === 'list' && !snapshot.agents.length && (
                <SettingsGroup
                  label="开始第一次协作"
                  footer="配置完成后，请在飞书群发送真实任务并查看回复。"
                >
                  <SettingsRow
                    icon={Wrench}
                    title="准备执行工具"
                    onClick={() => openPage("environment")}
                    value={
                      snapshot.tools.some(
                        (t) =>
                          t.authentication === "signedIn" ||
                          t.authentication === "notRequired",
                      )
                        ? "已授权"
                        : "检查安装与授权"
                    }
                  />
                  <SettingsRow
                    icon={Bot}
                    title="注册 Agent"
                    disabled={!ready || busy}
                    onClick={() => void register()}
                    value="飞书扫码授权"
                  />
                  <SettingsRow
                    icon={MessageSquare}
                    title="加入飞书群并设置工作目录"
                    description="注册后，从 Agent 页面进入。"
                  />
                </SettingsGroup>
              )}
              {selection.kind === "overview" && (
                <>
                  {view === "groups" && (
                    <div className="collaboration-page-heading">
                      <div>
                        <h2>已连接的飞书群</h2>
                        <p>同一个群可以有多个 Agent，各自保留工作目录和群内配置。</p>
                      </div>
                    </div>
                  )}
                  {view === "agents"
                    ? snapshot.agents.length > 0 && (
                        <section
                          aria-label="Agent 列表"
                          className="settings-entity-group"
                        >
                          <div className="settings-entity-group__surface">
                            {snapshot.agents.map((agent) => {
                              const status = agentListStatus(agent);
                              const groupCount = new Set(
                                snapshot.memberships
                                  .filter((member) => member.agentId === agent.id)
                                  .map((member) => member.groupId),
                              ).size;
                              return (
                                <button
                                  className="settings-entity-row collaboration-agent-list-row"
                                  key={agent.id}
                                  type="button"
                                  onClick={() =>
                                    select({ kind: "agent", id: agent.id })
                                  }
                                >
                                  <span className="collaboration-agent-list-avatar" aria-hidden="true">
                                    <AgentAvatar agent={agent} />
                                  </span>
                                  <span className="settings-entity-row__copy">
                                    <strong>{agent.name}</strong>
                                    <small title={agent.readError || undefined}>
                                      {agent.readError
                                        ? "群配置读取失败"
                                        : `飞书 · ${groupCount} 个群聊`}
                                    </small>
                                  </span>
                                  <span
                                    className={`settings-entity-row__value settings-entity-row__value--${status.tone}`}
                                  >
                                    {status.label}
                                  </span>
                                  <ChevronRight
                                    aria-hidden="true"
                                    className="settings-entity-row__chevron"
                                    size={15}
                                  />
                                </button>
                              );
                            })}
                            <button
                              className="settings-add-row"
                              type="button"
                              disabled={!ready || busy}
                              onClick={() => void register()}
                            >
                              <span aria-hidden="true" className="settings-add-row__icon">
                                <Plus size={15} />
                              </span>
                              <span>添加 Agent</span>
                            </button>
                          </div>
                        </section>
                      )
                    : snapshot.groups.map((g) => (
                        <SettingsGroup
                          key={g.id}
                          label={
                            <button
                              className="section-title-link"
                              onClick={() =>
                                select({ kind: "group", id: g.id })
                              }
                            >
                              <GroupAvatar group={g} />
                              {g.name}
                              <ChevronRight size={13} />
                            </button>
                          }
                        >
                          <div className="settings-entity-group__surface">
                            {membershipRows(
                              snapshot.memberships.filter(
                                (m) => m.groupId === g.id,
                              ),
                              "groups",
                            )}
                          </div>
                        </SettingsGroup>
                      ))}
                  {!(view === "agents"
                    ? snapshot.agents.length
                    : snapshot.groups.length) && (
                    <div className="collaboration-empty">
                      <Bot size={28} />
                      <h3>
                        {view === "agents"
                          ? "添加你的第一个 Agent"
                          : "还没有连接的飞书群"}
                      </h3>
                      <p>
                        {view === "agents"
                          ? "连接飞书机器人，再让它加入群开始协作。"
                          : "在 Agent 页面选择已加入的飞书群并绑定工作目录。"}
                      </p>
                      {view === "agents" && (
                        <Button
                          size="sm"
                          icon={<Plus size={14} />}
                          disabled={!ready || busy}
                          onClick={() => void register()}
                        >
                          添加 Agent
                        </Button>
                      )}
                    </div>
                  )}
                  {view === "groups" && (
                    <p className="collaboration-footnote">
                      只列出通过 Vonvon
                      注册的机器人。这里显示本地绑定名称，可能与飞书当前群名不同。
                    </p>
                  )}
                </>
              )}
              {selection.kind === "agent" && agent && (
                <>
                  <header className="collaboration-profile">
                    <AgentAvatar agent={agent} large />
                    <div>
                      <span className="collaboration-profile__kind">Agent</span>
                      <h2>{agent.name}</h2>
                      <p>通过飞书机器人身份参与协作</p>
                    </div>
                    <StatusBadge
                      tone={agentListStatus(agent).tone}
                    >
                      {agentListStatus(agent).label}
                    </StatusBadge>
                  </header>
                  <DetailTabs first="已加入的群聊" second="Agent 设置" selected={detail.kind === 'agent-settings' ? 'settings' : 'overview'} onSelect={next => agentPane(next === 'overview' ? {kind: 'groups'} : {kind: 'settings'})}/>
                  {detail.kind !== 'agent-settings' ? <>
                  <SettingsGroup
                    label="已加入的飞书群"
                    action={
                      <Button
                        size="sm"
                        disabled={busy || !ready || !agent.enabled}
                        onClick={() => void openJoin(agent.id)}
                      >
                        加入飞书群
                      </Button>
                    }
                  >
                    <div className="settings-entity-group__surface">
                      {membershipRows(
                        snapshot.memberships.filter(
                          (m) => m.agentId === agent.id,
                        ),
                        "agents",
                      )}
                      {!snapshot.memberships.some(
                        (m) => m.agentId === agent.id,
                      ) && (
                        <SettingsRow
                          title={agent.readError ? "群配置读取失败" : "尚未绑定飞书群"}
                        />
                      )}
                    </div>
                  </SettingsGroup>
                  </> : <div className="agent-settings-page">
                  <p className="collaboration-scope-note">这里管理 {agent.name} 的身份、运行与通知。群内工作目录和响应方式在对应飞书群中设置。</p>
                  <SettingsGroup className="agent-activation" id={settingAnchor('Agent 身份')}>
                    <SettingsRow
                      title="启用 Agent"
                      description={!agent.enabled && agent.running ? "Agent 尚未停止，仍可能回复飞书消息。请到「应用与启动」重启 Bridge。" : "更改立即生效。停用会结束此 Agent 的运行中任务。"}
                      trailing={
                        <Toggle
                          className="settings-row-switch"
                          aria-label="启用 Agent"
                          label="启用 Agent"
                          checked={agent.enabled}
                          disabled={busy || !ready}
                          onChange={(event) =>
                            void run({
                              type: "setAgentEnabled",
                              agentId: agent.id,
                              enabled: event.target.checked,
                            })
                          }
                        />
                      }
                    />
                  </SettingsGroup>
                  <SettingsGroup label="连接与权限" id={settingAnchor('连接与权限')}>
                    <SettingsRow title="应用 ID" value={<code>{agent.id}</code>} />
                    <SettingsRow title="刷新飞书凭据" description="重新授权当前 Agent，保留群绑定、会话和设置。"
                      trailing={<Button size="sm" disabled={busy || !ready} onClick={() => void register(agent.id)}>重新授权</Button>}/>
                    <SettingsRow
                      title="飞书权限与连接"
                      trailing={
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            await run({
                              type: "inspectAgent",
                              agentId: agent.id,
                            });
                            openPage("diagnostics");
                          }}
                        >
                          检查
                        </Button>
                      }
                    />
                  </SettingsGroup>
                  <SettingsPanel
                    key={`agent-${agent.id}`}
                    scope="agent"
                    target={{ kind: "agent", botId: agent.id }}
                    reveal={searchTarget?.reveal}
                  />
                  <SettingsGroup id={settingAnchor('移除 Agent')}
                    label="移除 Agent"
                    footer="删除本地注册信息、凭据、群绑定、会话记录与设置。飞书开发者平台中的应用仍保留。"
                  >
                    <SettingsRow
                      title="删除本地 Agent 数据"
                      description={
                        agent.enabled || agent.running
                          ? "请先停用 Agent，并等待它停止运行。"
                          : "此操作无法撤销。"
                      }
                      trailing={
                        <Button
                          size="sm"
                          disabled={
                            busy ||
                            host.kind !== "connected" ||
                            agent.enabled ||
                            agent.running ||
                            agent.activation !== "active"
                          }
                          onClick={() =>
                            setModal({
                              kind: "deleteAgent",
                              agentId: agent.id,
                              name: agent.name,
                            })
                          }
                        >
                          移除 Agent
                        </Button>
                      }
                    />
                  </SettingsGroup>
                  </div>}
                </>
              )}
              {selection.kind === "group" && group && (
                <>
                  <header className="collaboration-profile">
                    <GroupAvatar group={group} large />
                    <div>
                      <span className="collaboration-profile__kind">飞书群</span>
                      <h2>{group.name}</h2>
                      <p>
                        本地绑定名称 ·{" "}
                        {
                          snapshot.memberships.filter(
                            (m) => m.groupId === group.id,
                          ).length
                        }{" "}
                        个 Vonvon Agent
                      </p>
                    </div>
                  </header>
                  <SettingsGroup label="这个群中的 Agent">
                    {membershipRows(
                      snapshot.memberships.filter(
                        (m) => m.groupId === group.id,
                      ),
                      "groups",
                    )}
                  </SettingsGroup>
                  <p className="collaboration-footnote">
                    这里只展示 Vonvon
                    注册的机器人，不显示真人和其他来源的机器人。
                  </p>
                </>
              )}
              {member && agent && group && (
                <>
                  <div className={detail.kind === 'membership-settings' ? 'membership-settings-sheet' : 'membership-activity-sheet'}>
                  <header className="collaboration-profile">
                    <GroupAvatar group={group} large />
                    <div>
                      <span className="collaboration-profile__kind">群内协作</span>
                      <h2>{group.name}</h2>
                      {member.name !== group.name && <p>绑定名称：{member.name}</p>}
                    </div>
                  </header>
                  <div className="collaboration-member-context">
                    <AgentAvatar agent={agent} />
                    <span className="collaboration-member-context__copy"><strong>{agent.name}</strong><small>此 Agent 在本群内协作</small></span>
                    <button type="button" onClick={() => changeRoute(() => ({kind: 'agent', id: agent.id, pane: {kind: 'settings'}}))}>Agent 设置</button>
                    <button type="button" onClick={() => changeRoute(() => ({kind: 'group', id: group.id}))}>查看飞书群</button>
                  </div>
                  <DetailTabs first="会话与状态" second="群内设置" selected={detail.kind === 'membership-settings' ? 'settings' : 'overview'} onSelect={next => membershipPane(next === 'overview' ? {kind: 'activity'} : {kind: 'settings'})}/>
                  {detail.kind !== 'membership-settings' ? <>
                  <SettingsGroup label="群内协作">
                    <SettingsRow title="工作目录" value={<code>{member.directory}</code>}/>
                    <SettingsRow title="执行工具" value={backendName(member.backend)}/>
                    <SettingsRow title="会话方式" value={member.conversation === 'threads' ? '按话题独立会话' : '整群连续会话'}/>
                    <ProjectStatus scope={{kind: 'project', agentId: agent.id, groupId: group.id, projectName: member.name}} request={window.bridge.collaboration}/>
                    <SettingsRow title="Agent 连接" value={member.stale ? '状态过期' : agentListStatus(agent).label}/>
                  </SettingsGroup>
                  <ConversationPanel key={`sessions-${member.id}`} agentId={agent.id} groupId={group.id} projectName={member.name} conversation={member.conversation} request={window.bridge.collaboration}/>
                  <SettingsGroup label="快捷操作">
                    <SettingsRow title="飞书群" value={group.name} trailing={<Button size="sm" onClick={() => void window.bridge.collaboration({action: 'openGroup', agentId: agent.id, groupId: group.id, projectName: member.name}).then(reply => {if (reply.kind === 'refused') setNotice({message: reply.message, error: true});}).catch(error => setNotice({message: error instanceof Error ? error.message : '无法打开飞书群。', error: true}))}>在飞书打开</Button>}/>
                  </SettingsGroup>
                  <div className="desktop-actions"><Button disabled={member.stale} onClick={() => setModal({kind: 'collaboration', membership: member})}>开始一次协作</Button></div>
                  </> : <>
                  <p className="collaboration-scope-note">这里只配置 {agent.name} 在 {group.name} 中的工作目录、响应方式和权限。</p>
                  <ProjectPanel key={`manage-${member.id}`} scope={{kind: 'project', agentId: agent.id, groupId: group.id, projectName: member.name}} request={window.bridge.collaboration} onChanged={async () => {await run({type: 'refresh'});}}>
                    <SettingsGroup id={settingAnchor('历史会话')} label="历史会话"><SettingsRow title="会话与状态" trailing={<Button size="sm" onClick={() => membershipPane({kind: 'activity'})}>查看历史会话</Button>} /></SettingsGroup>
                    <SettingsPanel key={`project-${member.id}`} scope="project" target={membershipSettingsTarget(member)} />
                  </ProjectPanel>
                  </>}
                  </div>
                </>
              )}
              {((route.kind === 'agent' && !agent) || (route.kind === 'group' && !group) || (route.kind === 'membership' && (!member || !agent || !group))) && (
                <InlineNotice title="内容暂不可用">
                  {route.kind === 'membership' ? '这条群内协作或关联的 Agent、飞书群已变化。请返回上一级并刷新。' : '这个 Agent 或飞书群已变化。请返回列表并刷新。'}
                </InlineNotice>
              )}
            </>
          )}
          {page === "environment" && <><EnvironmentPanel reveal={searchTarget?.reveal} codexBusy={snapshot.jobs.some(job => (job.type === "loginCodex" || job.type === "installCodex") && isActive(job))} request={window.bridge.environment} onCodexLogin={async () => {await run({type: "startCodexLogin"});}} codexJobs={snapshot.jobs.filter(job => job.type === "loginCodex" || job.type === "installCodex").map(job => <JobPanel key={job.id} job={job} run={run} busy={busy}/>)}/></>}
          {page === "coffee" && <SettingsPanel scope="host" target={{kind: 'host'}} category="coffee" reveal={searchTarget?.reveal}/> }
          {page === "usage" && <UsagePanel request={window.bridge.collaboration} onOpenEnvironment={() => openPage('environment')} onOpenShare={() => setModal({kind: 'shareUsage'})}/>}
          {page === "application" && (
            <>
              <SettingsGroup label="这台设备">
                <SettingsRow
                  icon={Monitor}
                  title={
                    snapshot.application.platform === "macos"
                      ? "这台 Mac"
                      : "这台 Windows 电脑"
                  }
                  description="本地使用，无需产品账号。"
                  value={`v${snapshot.application.version}`}
                />
              </SettingsGroup>
              <SettingsGroup label="启动选项" id={settingAnchor('启动选项')}>
                <SettingsRow
                  title="运行状态"
                  value={
                    host.kind === "connected"
                      ? host.ownership === "owned"
                        ? "由桌面应用启动"
                        : "已接续现有服务"
                      : "尚未连接"
                  }
                />
                <SettingsRow
                  title="重启 Bridge"
                  description="重新加载已保存的 Agent 设置。"
                  trailing={
                    <Button
                      size="sm"
                      disabled={busy || host.kind !== "connected"}
                      onClick={() => void run({ type: "restartHost" })}
                    >
                      重启
                    </Button>
                  }
                />
                <SettingsRow
                  title="登录电脑时启动"
                  trailing={
                    <Toggle
                      className="settings-row-switch"
                      aria-label="登录电脑时启动"
                      label="登录电脑时启动"
                      checked={snapshot.application.loginItem}
                      disabled={busy}
                      onChange={(event) =>
                        void run({
                          type: "setLoginItem",
                          enabled: event.target.checked,
                        })
                      }
                    />
                  }
                />
              </SettingsGroup>
              <MachinePanel reveal={searchTarget?.reveal} request={window.bridge.machine} agents={snapshot.agents}/>
              <UpdatePanel request={window.bridge.machine} attached={host.kind === 'connected' && host.ownership === 'attached'}/>
              <SettingsPanel scope="host" target={{ kind: "host" }} category="execution" />
              <SettingsGroup
                label="窗口与退出"
                id={settingAnchor('窗口与退出')}
                footer="关闭窗口会留在菜单栏或托盘继续运行。退出只停止本应用启动的 Bridge。"
              >
                <SettingsRow
                  title="隐藏到托盘"
                  trailing={
                    <Button
                      size="sm"
                      onClick={() => void run({ type: "hideWindow" })}
                    >
                      隐藏窗口
                    </Button>
                  }
                />
                <SettingsRow
                  title="退出 Vonvon Bot"
                  trailing={
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => navigate(() => void run({ type: "quit" }))}
                    >
                      退出应用
                    </Button>
                  }
                />
              </SettingsGroup>
            </>
          )}
          {page === "diagnostics" && (
            <div id={settingAnchor('诊断操作')}>
              <SettingsGroup label="当前状态" id={settingAnchor('当前状态')}>
                <SettingsRow
                  title="Bridge 版本"
                  value={host.kind === "connected" ? host.version : "未知"}
                />
                <SettingsRow
                  title="已注册 Agent"
                  value={`${snapshot.agents.length} 个`}
                />
                <SettingsRow
                  title="已连接飞书群"
                  value={`${snapshot.groups.length} 个`}
                />
                <SettingsRow
                  title="最近读取"
                  value={
                    snapshot.observedAt
                      ? new Date(snapshot.observedAt).toLocaleTimeString()
                      : "尚未读取"
                  }
                />
                <SettingsRow
                  title="数据目录"
                  value={<code>{snapshot.application.dataPath}</code>}
                />
              </SettingsGroup>
              <LogPanel request={window.bridge.machine}/>
              {snapshot.diagnostics.map((diagnostic, index) => (
                <InlineNotice
                  key={`${diagnostic.title}-${index}`}
                  title={diagnostic.title}
                  tone={diagnostic.status === "ok" ? "success" : diagnostic.status === "error" ? "danger" : "warning"}
                >
                  {diagnostic.message}
                  {diagnostic.eventConfigUrl && <Button size="sm" onClick={() => {if (diagnostic.eventConfigUrl) void run({type: "openEventSettings", url: diagnostic.eventConfigUrl});}}>打开事件设置</Button>}
                </InlineNotice>
              ))}
              <Button
                disabled={busy}
                onClick={() => void run({ type: "refresh" })}
              >
                重新检查
              </Button>
            </div>
          )}
        </div>
      </AppShell>
      {searchOpen && <SearchDialog open entries={searchEntries(snapshot)} onClose={() => setSearchOpen(false)} onSelect={openSearchResult}/>}
      <PendingGroupToasts pages={pendingGroups} agents={snapshot.agents} hidden={modal !== null} onContinue={(owner, group) => openJoin(owner.id, group)} />
      {modal?.kind === 'join' && (() => {
        const owner = snapshot.agents.find(item => item.id === modal.agentId);
        return owner ? <JoinGroupDialog key={`${owner.id}:${modal.group?.chatId ?? 'new'}`} agent={owner} initialGroup={modal.group} pending={pendingGroups.find(item => item.agentId === owner.id)} onClose={() => setModal(null)} onChanged={async () => {await run({type: 'refresh'});}} /> : null;
      })()}
      <Dialog
        open={modal !== null && modal.kind !== "deleteAgent" && modal.kind !== "join"}
        onClose={() => void closeModal()}
        title={
          modal?.kind === "register"
            ? modal.refresh ? "刷新 Agent 凭据" : "注册 Agent"
            : modal?.kind === "join"
              ? "让 Agent 加入飞书群"
              : modal?.kind === "shareUsage"
                ? "分享 Codex 用量"
                : "开始一次协作"
        }
      >
        <div className="page-stack">
          {feedback}
          {modal?.kind === "register" && registration && (
            <><p>{modal.refresh ? "重新授权这个 Agent，保留原有项目、群绑定和设置。请使用此 Agent 的管理员身份完成授权。" : "连接飞书机器人身份。"}</p><JobPanel job={registration} run={run} busy={busy} /></>
          )}
          {modal?.kind === "collaboration" && (
            <>
              <p>
                请在飞书的对应群中 @ 这个
                Agent，发送下面的任务。实际回复由飞书中的 Agent 返回。
              </p>
              <SettingsGroup>
                <SettingsRow title="群绑定" value={modal.membership.name} />
                <SettingsRow
                  title="工作目录"
                  value={<code>{modal.membership.directory}</code>}
                />
              </SettingsGroup>
              <FormField label="建议任务">
                <textarea
                  readOnly
                  aria-label="建议任务"
                  value="请查看这个工作目录，说明目录内容，并告诉我下一步可以做什么。"
                />
              </FormField>
              <p className="collaboration-footnote">
                可以选中文字复制到飞书。只有在群中收到真实任务回复后，才完成第一次协作。
              </p>
            </>
          )}
          {modal?.kind === 'shareUsage' && <ShareUsagePanel memberships={snapshot.memberships} agents={snapshot.agents} groups={snapshot.groups} request={window.bridge.collaboration}/>}
        </div>
      </Dialog>
      <ConfirmDialog
        open={modal?.kind === "deleteAgent"}
        title="移除本地 Agent"
        description={
          modal?.kind === "deleteAgent"
            ? `将移除「${modal.name}」的本地注册信息、凭据、群绑定、设置和会话记录。飞书开发者平台中的应用不会删除。请确认这个 Agent 已停用并停止运行。`
            : ""
        }
        tone="danger"
        confirmLabel="删除本地数据"
        pending={busy}
        error={notice?.error ? notice.message : undefined}
        onCancel={() => void closeModal()}
        onConfirm={() => {
          if (modal?.kind !== "deleteAgent") return;
          const id = modal.agentId;
          void run({ type: "deleteAgent", agentId: id }).then((result) => {
            if (result.kind === "applied") {
              setModal(null);
              select({ kind: "overview" });
              setNotice({ message: "本地 Agent 数据已删除。", error: false });
            }
          });
        }}
      />
    </>
  );
}
function JobPanel({
  job,
  run,
  busy,
}: {
  job: Job;
  run: (command: Command) => Promise<CommandResult>;
  busy: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const expiresAt = job.phase === "qr" ? job.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const expired = expiresAt !== null && expiresAt <= now;
  return (
    <SettingsGroup
      label={
        job.type === "registerAgent"
          ? "飞书扫码注册"
          : job.type === "installCodex"
            ? "Codex 安装"
            : "Codex 授权"
      }
    >
      <div className="desktop-job" role="status">
        {job.phase === "qr" ? (
          <>
            {expired ? (
              <p>
                二维码和注册链接已过期。请取消本次操作，关闭此对话框后重新注册 Agent。
              </p>
            ) : (
              <>
                <img className="desktop-qr" src={job.image} alt="飞书注册二维码" />
                <p>
                  请用飞书扫码，或打开注册链接。有效期至{" "}
                  {new Date(job.expiresAt).toLocaleTimeString()}。
                </p>
                <FormField className="desktop-registration-url" label="完整注册链接">
                  <input aria-label="完整注册链接" readOnly value={job.url} />
                </FormField>
                <div className="desktop-actions">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run({ type: "openJobAuthorization", jobId: job.id })
                    }
                  >
                    打开链接
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run({ type: "copyJobAuthorization", jobId: job.id })
                    }
                  >
                    复制链接
                  </Button>
                </div>
              </>
            )}
          </>
        ) : job.phase === "authorizing" ? (
          <>
            <p>在官方授权页面输入此设备代码。</p>
            <code className="desktop-device-code">{job.userCode}</code>
            <Button
              disabled={busy}
              onClick={() =>
                void run({ type: "openJobAuthorization", jobId: job.id })
              }
            >
              打开官方授权页面
            </Button>
          </>
        ) : (
          <p>
            {job.phase === "succeeded" && <Check size={14} />} {job.message}
          </p>
        )}
        {isActive(job) && (
          <Button
            size="sm"
            disabled={busy || job.phase === "activating"}
            onClick={() => void run({ type: "cancelJob", jobId: job.id })}
          >
            取消本次操作
          </Button>
        )}
      </div>
    </SettingsGroup>
  );
}

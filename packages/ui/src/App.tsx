import {useClient, useShellCapabilities} from './client-context';
import {copyAuthorizationUrl, copyFeedback, groupUrl, openExternalUrl} from './url-actions';
import {uiFeatures} from './features';
import {PendingGroupToasts} from './PendingGroupToasts';
import {JoinGroupDialog} from './JoinGroupDialog';
import {usePendingGroups} from './pending-groups';
import type {PendingGroup, ProjectId} from '@vonvon/protocol';
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  ListChecks,
  MessageSquare,
  Monitor,
  Plus,
  Terminal,
  X,
} from "lucide-react";
import { AppShell } from "./LocalShell";
import { AgentAvatar } from './AgentAvatar';
import {OperationActivity} from './management/OperationActivity';
import { GroupAvatar } from './GroupAvatar';
import { GroupDirectory, type GroupDirectoryState } from './GroupDirectory';
import { ProjectDirectory, projectEntries, type ProjectDirectoryState } from './ProjectDirectory';
import { ProjectPage } from './ProjectPage';
import { deleteAgentDescription } from './project-model';
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
  conversationCopy,
  type AgentId,
  type Command,
  type CommandResult,
  type DesktopSnapshot,
  type Job,
  type Membership,
  backendLabel,
  formatTime,
} from "@vonvon/protocol";
import type { CollaborationView, Page } from "./collaboration-model";
import {SettingsPanel} from "./settings/SettingsPanel";
import {DraftGuardProvider, useDraftGuard} from './settings/DraftGuard';
import {decisionProviderSection, diagnosticsSection, searchEntries, settingAnchor, type Destination, type SearchEntry, type Selection} from './search';
import {initialRoute, openMembership, routeBack, routeDetail, routeFromSearch, routeSelection, routeView, type AgentPane, type CollaborationRoute, joinedGroupRoute} from './collaboration-navigation';
import {SearchDialog} from './SearchDialog';
import {flushSync} from 'react-dom';
import {GroupWorkspace, groupTabForSection, type GroupDesignTab} from './GroupWorkspace';
import {BotMap} from './BotMap';
import {MEMORY_SEEN_EVENT} from './MemoryMap';
import {MigrationBanner} from './MigrationBanner';
import {newTag, sumCounts, useNewCounts} from './new-counts';
import {ShareUsagePanel, UsagePanel} from './management/UsagePanel';
import {EnvironmentPanel} from './management/EnvironmentPanel';
import {ProviderManager} from './setup/ProviderSetup';
import {type SetupProvider} from './setup/provider-state';
import {WelcomeSetup} from './setup/WelcomeSetup';
import {BridgeImportPanel} from './setup/BridgeImportPanel';
import {TodayHome, SettingsHome} from './TodayHome';
import {LoginServiceRow, deviceTitle, toggleService} from './setup/service-toggle';
import {GrantStep, ScopeGrantRow, jobToCancel, withRegisteredAgent, type RegisterModal} from './setup/GrantStep';
import {MachinePanel} from './management/MachinePanel';
import {DiagnosticsPanel} from './management/DiagnosticsPanel';
import {SecretsPanel} from './management/SecretsPanel';
import {UpdatePanel} from './management/UpdatePanel';

type Modal =
  | RegisterModal
  | { kind: "join"; agentId: AgentId; group?: PendingGroup; provider?: SetupProvider; project?: ProjectId; suspended?: boolean }
  | { kind: "collaboration"; membership: Membership }
  | { kind: "shareUsage" }
  | { kind: "deleteAgent"; agentId: AgentId; name: string }
  | null;

/** u08 drops the suffix for a backend this build does not know (F50). */
const backendName = (backend: string) =>
  backendLabel(backend) === backend ? `${backend}（暂不支持修改）` : backendLabel(backend);
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
function BotDetailTabs({selected, onSelect}: {selected: AgentPane['kind']; onSelect: (pane: AgentPane) => void}) {
  return <nav className="collaboration-detail-tabs" aria-label="Bot 详情">
    {([{kind: 'groups', label: '群聊'}, {kind: 'profile', label: '记忆'}, {kind: 'settings', label: '管理 Bot'}] as const).map(pane =>
      <button key={pane.kind} type="button" aria-current={selected === pane.kind ? 'page' : undefined} className={selected === pane.kind ? 'is-selected' : ''} onClick={() => onSelect({kind: pane.kind})}>{pane.label}</button>)}
  </nav>;
}

function FeaturePage({feature}: {feature: (typeof uiFeatures)[number]}) { const Component = feature.component; return <Component/>; }

export function App() {
  return <DraftGuardProvider><DesktopApp /></DraftGuardProvider>;
}
function DesktopApp() {
  const {navigate} = useDraftGuard();
  const client = useClient();
  const shell = useShellCapabilities();
  useEffect(() => shell?.onQuitRequested?.(() => navigate(() => { void shell.quit?.(); })), [shell, navigate]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<Destination>();
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [route, setRoute] = useState<CollaborationRoute>(initialRoute);
  const [setupProvider, setSetupProvider] = useState<SetupProvider>();
  const [page, setPage] = useState<Page>("home");
  const [settingsReturn, setSettingsReturn] = useState<{page: Page; route: CollaborationRoute; label: string}>();
  const newCounts = useNewCounts(snapshot?.revision, MEMORY_SEEN_EVENT);
  const [groupDirectoryState, setGroupDirectoryState] = useState<GroupDirectoryState>({query: '', expanded: {}});
  const [projectDirectoryState, setProjectDirectoryState] = useState<ProjectDirectoryState>({query: '', expanded: {}});
  const [groupTabs, setGroupTabs] = useState<Record<string, GroupDesignTab>>({});
  const [featureId, setFeatureId] = useState<string>();
  const feature = uiFeatures.find(item => item.id === featureId && item.slot === "page");
  const view = routeView(route);
  const selection = routeSelection(route);
  const detail = routeDetail(route);
  const [modal, setModal] = useState<Modal>(null);
  const [joinedTarget, setJoinedTarget] = useState<{agentId: AgentId; chatId: string}>();
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const [pendingActivation, setPendingActivation] = useState<{agentId: AgentId; enabled: boolean} | null>(null);
  const modalGeneration = useRef(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const pendingGroups = usePendingGroups(snapshot);
  const [attachedNotice, setAttachedNotice] = useState(true);
  // The Bot's own memory entries, counted for the 移除本地 Bot confirmation; left out when it cannot be read.
  const [botMemory, setBotMemory] = useState<number>();
  const deletingAgent = modal?.kind === 'deleteAgent' ? modal.agentId : undefined;
  useEffect(() => {
    setBotMemory(undefined);
    if (!deletingAgent) return;
    let active = true;
    void client.memory({type: 'list', scope: {kind: 'bot', botId: deletingAgent}}).then(reply => {if (active && reply.kind === 'list') setBotMemory(reply.used);}).catch(() => undefined);
    return () => {active = false;};
  }, [client, deletingAgent]);
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
          const selector = document.querySelector<HTMLSelectElement>('select[aria-label="通知 Bot"]');
          if (selector) {
            selector.scrollIntoView({block: 'center'});
            selector.focus({preventScroll: true});
            setNotice({message: searchTarget?.guide ?? '请先选择通知 Bot。', error: false});
            setSearchTarget(undefined);
            return true;
          }
        }
        return false;
      }
      {
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
      client.watchSnapshots((next) => {
        setSnapshot(next);
        setModal(current => current?.kind === "register" ? withRegisteredAgent(current, next.jobs) : current);
        document.documentElement.dataset.desktopPlatform =
          next.application.platform;
      }),
    [],
  );
  useEffect(() => {
    if (!snapshot || !joinedTarget) return;
    const destination = joinedGroupRoute(snapshot, joinedTarget);
    if (!destination) return;
    setRoute(destination);
    setPage('collaboration');
    setJoinedTarget(undefined);
    setNotice(undefined);
  }, [snapshot, joinedTarget]);
  async function joined(target: {agentId: AgentId; chatId?: string}) {
    setSettingsReturn(undefined);
    setFeatureId(undefined);
    setPage('collaboration');
    setRoute({kind: 'list', view: 'groups'});
    setJoinedTarget(target.chatId ? {agentId: target.agentId, chatId: target.chatId} : undefined);
    const refreshed = await run({type: 'refresh'});
    if (refreshed.kind === 'refused' || refreshed.kind === 'outcomeUnknown') setJoinedTarget(undefined);
  }
  function configureJoinProvider(next: 'providers' | 'secrets' = 'providers', provider?: string) {
    // Keep the dialog mounted so its name, directory and conversation choice survive.
    setModal(current => current?.kind === 'join' ? {...current, suspended: true} : current);
    setSettingsReturn({page, route, label: '添加飞书群'});
    setPage(next);
    setSearchTarget(next === 'secrets' ? {page: next, section: decisionProviderSection(provider)} : undefined);
  }
  async function run(
    command: Command,
    isCurrent: () => boolean = () => true,
  ): Promise<CommandResult> {
    setPending((count) => count + 1);
    setNotice(undefined);
    try {
      const result = await client.run(command);
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
  async function setAgentEnabled(agentId: AgentId, enabled: boolean) {
    setPendingActivation({agentId, enabled});
    try { await run({type: 'setAgentEnabled', agentId, enabled}); }
    finally { setPendingActivation(null); }
  }
  async function runShell(operation: () => Promise<void>): Promise<void> {
    setPending(count => count + 1);
    setNotice(undefined);
    try { await operation(); }
    catch (error) { setNotice({message: error instanceof Error ? error.message : '桌面操作失败。', error: true}); }
    finally { setPending(count => count - 1); }
  }
  function select(next: Selection) {
    if (!snapshot) return;
    navigate(() => {
      setJoinedTarget(undefined);
      setRoute(current => next.kind === 'overview'
        ? {kind: 'list', view: routeView(current)}
        : next.kind === 'agent'
          ? {kind: 'agent', id: next.id, pane: {kind: 'groups'}}
          : next.kind === 'group'
            ? {kind: 'group', id: next.id}
          : next.kind === 'project'
            ? {kind: 'project', id: next.id, pane: {kind: 'map'}}
            : openMembership(current, next.id, snapshot));
      setPage("collaboration");
      setSettingsReturn(undefined);
      setNotice(undefined);
    });
  }
  /** Group entry points keep the group/Bot hierarchy, independent of shared projects. */
  function openGroup(groupId: string) {
    const group = snapshot?.groups.find(item => item.id === groupId);
    if (group) select({kind: 'group', id: group.id});
  }
  function changeRoute(next: (current: CollaborationRoute) => CollaborationRoute) {
    navigate(() => {
      setJoinedTarget(undefined);
      setRoute(next);
      setPage('collaboration');
      setSettingsReturn(undefined);
      setFeatureId(undefined);
      setNotice(undefined);
    });
  }
  function agentPane(pane: AgentPane) {
    changeRoute(current => current.kind === 'agent' ? {...current, pane} : current);
  }
  function openList(next: CollaborationView) {
    navigate(() => {
      setJoinedTarget(undefined);
      setModal(current => current?.kind === 'join' && current.suspended ? null : current);
      setRoute({kind: 'list', view: next});
      setPage('collaboration');
      setSettingsReturn(undefined);
      setFeatureId(undefined);
      setNotice(undefined);
    });
  }
  function openPage(next: Page) { navigate(() => { setModal(current => current?.kind === 'join' && current.suspended ? null : current); setJoinedTarget(undefined); setPage(next); setFeatureId(undefined); setSettingsReturn(undefined); }); }
  function openContextSettings(next: Page, section?: string) {
    navigate(() => {
      const selected = route.kind === 'membership' ? snapshot?.memberships.find(item => item.id === route.id) : undefined;
      const label = selected ? snapshot?.groups.find(item => item.id === selected.groupId)?.name ?? '群设置' : 'Bot 设置';
      setSettingsReturn({page, route, label}); setPage(next); setFeatureId(undefined);
      setSearchTarget(section ? {page: next, section} : undefined);
    });
  }
  function returnFromSettings() {
    if (!settingsReturn) return;
    const restore = () => {setModal(current => current?.kind === 'join' ? {...current, suspended: false} : current); setPage(settingsReturn.page); setRoute(settingsReturn.route); setSettingsReturn(undefined); setNotice(undefined);};
    // Returning to the same draft is not abandoning it.
    if (modal?.kind === 'join' && modal.suspended) restore();
    else navigate(restore);
  }
  function openSearchResult(entry: SearchEntry) {
    if (!snapshot) return;
    flushSync(() => setSearchOpen(false));
    navigate(() => {
      setJoinedTarget(undefined);
      setModal(current => current?.kind === 'join' && current.suspended ? null : current);
      setPage(entry.destination.page);
      setSettingsReturn(undefined);
      setFeatureId(undefined);
      const target = routeFromSearch(entry.destination, snapshot);
      if (target) {setRoute(target.route); if (target.route.kind === 'membership') {const memberId=target.route.id; setGroupTabs(current=>({...current,[memberId]:groupTabForSection(entry.destination.section)}));}}
      setSearchTarget(target?.missing ? undefined : entry.destination.section ? entry.destination : undefined);
      setNotice(target?.missing ? {message: target.missing, error: false} : undefined);
    });
  }
  async function register(agentId?: AgentId, provider?: SetupProvider) {
    if (!agentId && !provider && !snapshot?.agents.length) {openPage('setup'); return;}
    if (provider) {setSetupProvider(provider); setPage('setup');}
    const result = await run(agentId ? {type: "refreshAgentCredentials", agentId} : { type: "registerAgent" });
    if (result.kind === "started")
      setModal({ kind: "register", jobId: result.jobId, refresh: Boolean(agentId) });
  }
  function openJoin(agentId: AgentId, group?: PendingGroup, provider?: SetupProvider) {
    navigate(() => setModal({kind: 'join', agentId, group, provider}));
  }
  async function closeModal() {
    const generation = ++modalGeneration.current;
    const cancel = modal?.kind === "register" ? jobToCancel(modal) : undefined;
    if (cancel) await run({ type: "cancelJob", jobId: cancel });
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
  const group = selection.kind === "group" ? snapshot.groups.find(item => item.id === selection.id)
    : member ? snapshot.groups.find((item) => item.id === member.groupId) : undefined;
  const project = selection.kind === "project" ? snapshot.projects?.find((item) => item.id === selection.id) : undefined;
  const titles: Record<Page, string> = {
    home: "概览",
    settings: "设置",
    collaboration: member
      ? `${group?.name ?? '飞书群'} · ${agent?.name ?? 'Bot'}`
      : (agent?.name ?? group?.name ?? project?.name ?? (view === "agents" ? "Bot" : view === "groups" ? "群组" : "项目管理")),
    setup: "飞书连接",
    bridgeImport: "导入 Bridge",
    environment: "工具与连接",
    providers: "Provider",
    usage: "用量",
    application: "应用与启动",
    secrets: "决策模型",
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
      ? snapshot.agents.find(item => item.id === (route.parent.kind === 'agent' ? route.parent.id : undefined))?.name ?? 'Bot'
      : route.parent.kind === 'project'
        ? snapshot.projects?.find(item => item.id === (route.parent.kind === 'project' ? route.parent.id : undefined))?.name ?? '项目'
        : route.parent.kind === 'group' ? '群组列表' : '项目列表'
    : routeView(route) === 'agents' ? 'Bot 列表' : routeView(route) === 'groups' ? '群组列表' : '项目列表';
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
              {{threads:'多会话',shared:'单会话',smart:'智能'}[m.conversation]}
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
        newCounts={{bots: sumCounts(newCounts.bots), projects: sumCounts(newCounts.projects)}}
        title={feature?.label ?? titles[page]}
        firstUse={!snapshot.agents.length}
        onNavigate={openPage}
        selectedFeature={featureId}
        onFeatureNavigate={id => navigate(() => {setJoinedTarget(undefined); setModal(current => current?.kind === 'join' && current.suspended ? null : current); setFeatureId(id);})}
        onSearch={() => setSearchOpen(true)}
        onOpenList={openList}
        backLabel={`返回 ${settingsReturn?.label ?? parentLabel}`}
        onBack={
          settingsReturn ? returnFromSettings : !feature && page === "collaboration" && route.kind !== 'list'
            ? () => changeRoute(current => current.kind === 'membership' && current.parent.kind === 'group' ? {kind: 'list', view: 'groups'} : routeBack(current))
            : undefined
        }
      >
        <div className="page-stack">
          {['usage', 'application', 'diagnostics'].includes(page) && <header className="today-page-heading"><h1>{titles[page]}</h1></header>}
          {feature ? <FeaturePage feature={feature} /> : <>
          {page === 'collaboration' && route.kind !== 'list' && <nav className="collaboration-breadcrumb" aria-label="当前位置">
            <button type="button" onClick={() => openList(view)}>{view === 'agents' ? 'Bot' : view === 'groups' ? '群组' : '项目管理'}</button>
            <ChevronRight size={12} aria-hidden="true" />
            {route.kind === 'membership' && <>
              <button type="button" onClick={() => changeRoute(routeBack)}>{route.parent.kind === 'group' ? group?.name ?? '飞书群' : parentLabel}</button>
              <ChevronRight size={12} aria-hidden="true" />
            </>}
            <span aria-current="page">{route.kind === 'membership' ? route.parent.kind === 'agent' ? group?.name ?? '飞书群' : agent?.name ?? 'Bot' : agent?.name ?? group?.name ?? project?.name ?? '内容已变化'}</span>
          </nav>}
          {pendingGroups.map(page => {
            const owner = snapshot.agents.find(item => item.id === page.agentId);
            if (!owner || (!page.groups.length && page.problem?.kind !== 'failed')) return null;
            return <div key={page.agentId} className="page-stack">
              {page.problem?.kind === 'failed' && <InlineNotice title={`${owner.name} 的绑定通知读取失败`} tone="warning">{page.problem.message}</InlineNotice>}
              {page.groups.map(group => <InlineNotice key={group.chatId} title={`${owner.name} 已加入 ${group.name}`} actions={<Button onClick={() => openJoin(owner.id, group)}>继续绑定</Button>}>还没设置好：选会话方式就能用。</InlineNotice>)}
            </div>;
          })}
          {feedback}
          {!ready && (
            <InlineNotice
              title={
                host.kind === "starting" ? "正在连接 daemon" : "daemon 尚未就绪"
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
          {page === "home" && snapshot.agents.length > 0 && <TodayHome snapshot={snapshot} onAgent={id => select({kind: "agent", id})} onGroup={openGroup} onSetup={() => openPage("setup")} onRegister={() => void register()} disabled={!ready || busy}/>}
          {page === "settings" && <SettingsHome onNavigate={openPage} onFeature={id => navigate(() => setFeatureId(id))}/>}
          {page === "collaboration" && (
            <>
              {route.kind === 'list' && host.kind === "connected" &&
                host.ownership === "attached" &&
                attachedNotice && (
                  <InlineNotice
                    title="已连接现有 daemon"
                    actions={
                      <IconButton
                        label="关闭接续提示"
                        onClick={() => setAttachedNotice(false)}
                      >
                        <X size={14} />
                      </IconButton>
                    }
                  >
                    已有 Bot 与群配置继续保留。关闭本应用不会停止原有服务。
                  </InlineNotice>
                )}
              {route.kind === 'list' && !snapshot.agents.length && (
                <SettingsGroup
                  label="开始使用"
                  footer="配置完成后，请在飞书群发送真实任务并查看回复。"
                >
                  <SettingsRow
                    icon={ListChecks}
                    title="连接与设置"
                    description="后端、扫码、开权限、事件订阅、发布，一步步检测。"
                    onClick={() => openPage("setup")}
                  />
                  <SettingsRow
                    icon={Bot}
                    title="注册 Bot"
                    disabled={!ready || busy}
                    onClick={() => void register()}
                    value="飞书扫码注册"
                  />
                  <SettingsRow
                    icon={MessageSquare}
                    title="加入飞书群并设置工作目录"
                    description="注册后，从 Bot 页面进入。"
                  />
                </SettingsGroup>
              )}
              {selection.kind === "overview" && (
                <>
                  {view === 'agents' && <header className="today-page-heading today-page-heading--actions"><div><h1>Bot</h1><span>{snapshot.agents.length} 个 Bot</span></div><Button icon={<Plus size={14}/>} disabled={!ready || busy} onClick={() => void register()}>注册 Bot</Button></header>}
                  {view === "agents"
                    ? snapshot.agents.length > 0 && (
                        <section
                          aria-label="Bot 列表"
                          className="settings-entity-group"
                        >
                          <div className="settings-entity-group__surface">
                            {snapshot.agents.map((agent) => {
                              const status = agentListStatus(agent);
                              const activating = pendingActivation?.agentId === agent.id ? pendingActivation : null;
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
                                        : `飞书 · ${groupCount} 个群聊${newCounts.bots[agent.id] ? ` · ${newTag(newCounts.bots[agent.id])}` : ''}`}
                                    </small>
                                  </span>
                                  {activating ? <span className="settings-entity-row__value"><OperationActivity key={`${agent.id}:${activating.enabled}`} label={activating.enabled ? '启用中' : '停用中'} state={activating.enabled ? 'connecting' : 'working'}/></span>
                                    : status.tone !== 'success' && <span className={`settings-entity-row__value settings-entity-row__value--${status.tone}`}>{status.label}</span>}
                                  <ChevronRight
                                    aria-hidden="true"
                                    className="settings-entity-row__chevron"
                                    size={15}
                                  />
                                </button>
                              );
                            })}

                          </div>
                        </section>
                      )
                    : view === "groups" ? <><MigrationBanner snapshot={snapshot}/><GroupDirectory snapshot={snapshot} state={groupDirectoryState} onStateChange={setGroupDirectoryState} statusFor={agentListStatus}
                        onMembership={id => select({kind: 'membership', id})} onProjects={() => openList('projects')} newCounts={newCounts.projects}/></>
                    : <><MigrationBanner snapshot={snapshot}/><ProjectDirectory newCounts={newCounts.projects} snapshot={snapshot} state={projectDirectoryState} onStateChange={setProjectDirectoryState} statusFor={agentListStatus}
                        onProject={id => select({kind: 'project', id})} onMembership={id => select({kind: 'membership', id})}
                        onNewProject={ready && snapshot.agents.length ? () => snapshot.agents.length === 1 ? openJoin(snapshot.agents[0]!.id) : openList('agents') : undefined}/></>}
                  {!(view === "agents"
                    ? snapshot.agents.length
                    : view === "groups" ? snapshot.groups.length : projectEntries(snapshot).length) && (
                    <div className="collaboration-empty">
                      <Bot size={28} />
                      <h3>
                        {view === "agents"
                          ? "注册你的第一个 Bot"
                          : view === "groups" ? "还没有连接的飞书群" : "还没有项目"}
                      </h3>
                      <p>
                        {view === "agents"
                          ? "连接飞书机器人，再让它加入群开始协作。"
                          : view === "groups" ? "在 Bot 页面选择已加入的飞书群并绑定工作目录。" : "把一个飞书群连到 Bot 上，就会有一个项目。"}
                      </p>
                      {view === "agents" && (
                        <Button
                          size="sm"
                          icon={<Plus size={14} />}
                          disabled={!ready || busy}
                          onClick={() => void register()}
                        >
                          注册 Bot
                        </Button>
                      )}
                    </div>
                  )}
                </>
              )}
              {selection.kind === "agent" && agent && (
                <>
                  <header className="collaboration-profile">
                    <AgentAvatar agent={agent} large />
                    <div>
                      <span className="collaboration-profile__kind">Bot</span>
                      <h2>{agent.name}</h2>
                    </div>
                    {pendingActivation?.agentId === agent.id ? <OperationActivity key={`${agent.id}:${pendingActivation.enabled}`} label={pendingActivation.enabled ? '启用中' : '停用中'} state={pendingActivation.enabled ? 'connecting' : 'working'}/>
                      : <StatusBadge tone={agentListStatus(agent).tone}>{agentListStatus(agent).label}</StatusBadge>}
                  </header>
                  <div className="bot-detail-navigation"><BotDetailTabs selected={route.kind === 'agent' ? route.pane.kind : 'groups'} onSelect={agentPane}/></div>
                  {route.kind === 'agent' && route.pane.kind === 'profile' ? <BotMap agentId={agent.id} snapshot={snapshot} onProject={id => select({kind: 'project', id})}/> : detail.kind !== 'agent-settings' ? <>
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
                  <SettingsGroup className="agent-activation" id={settingAnchor('Bot 身份')}>
                    <SettingsRow
                      title="启用 Bot"
                      description={!agent.enabled && agent.running ? "Bot 尚未停止，仍可能回复飞书消息。请到「应用与启动」重启 daemon。" : "停用将结束此 Bot 正在运行的任务。"}
                      trailing={
                        <Toggle
                          className="settings-row-switch"
                          aria-label="启用 Bot"
                          label="启用 Bot"
                          checked={agent.enabled}
                          disabled={busy || !ready}
                          onChange={(event) => void setAgentEnabled(agent.id, event.target.checked)}
                        />
                      }
                    />
                  </SettingsGroup>
                  <SettingsGroup label="连接与权限" id={settingAnchor('连接与权限')}>
                    <SettingsRow title="应用 ID" value={<code>{agent.id}</code>} />
                    <SettingsRow title="连接与设置" description="检测权限、事件与发布状态。" onClick={() => openPage("setup")} />
                    <ScopeGrantRow key={`grant-${agent.id}`} agentId={agent.id} disabled={busy || !ready} onError={message => setNotice({message, error: true})}/>
                    <SettingsRow title="刷新飞书凭据" description="重新扫码，保留群聊、会话和设置。"
                      trailing={<Button size="sm" disabled={busy || !ready} onClick={() => void register(agent.id)}>重新扫码</Button>}/>
                    <SettingsRow title="状态与诊断" description="查看连接问题与运行日志。"
                      trailing={<Button size="sm" onClick={() => { openPage("diagnostics"); setSearchTarget({page: "diagnostics", section: diagnosticsSection(agent.id)}); }}>查看</Button>}/>
                  </SettingsGroup>
                  <SettingsPanel
                    key={`agent-${agent.id}`}
                    scope="agent"
                    target={{ kind: "agent", botId: agent.id }}
                  />
                  <SettingsGroup id={settingAnchor('移除 Bot')}
                    label="移除 Bot"
                    footer="删除本地注册信息、凭据、群绑定、会话记录与设置。飞书开发者平台中的应用仍保留。"
                  >
                    <SettingsRow
                      title="删除本地 Bot 数据"
                      description={
                        agent.enabled || agent.running
                          ? "请先停用 Bot，并等待它停止运行。"
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
                          移除 Bot
                        </Button>
                      }
                    />
                  </SettingsGroup>
                  </div>}
                </>
              )}
              {selection.kind === "group" && group && <>
                <header className="collaboration-profile"><GroupAvatar group={group} large/><div><span className="collaboration-profile__kind">飞书群</span><h2>{group.name}</h2><p>{snapshot.memberships.filter(item => item.groupId === group.id).length} 个 Bot</p></div></header>
                <SettingsGroup label="这个群中的 Bot">{membershipRows(snapshot.memberships.filter(item => item.groupId === group.id), 'groups')}</SettingsGroup>
              </>}
              {selection.kind === "project" && project && route.kind === 'project' && <ProjectPage key={project.id} project={project} snapshot={snapshot} pane={route.pane} tools={snapshot.tools}
                onPane={pane => changeRoute(current => current.kind === 'project' ? {...current, pane} : current)}
                onBotProfile={id => changeRoute(() => ({kind: 'agent', id, pane: {kind: 'profile'}}))}
                onMembership={id => select({kind: 'membership', id})}
                onChanged={async () => {await run({type: 'refresh'});}}
                onDeleted={() => openList('projects')}
                onAddGroup={(agentId, projectId) => navigate(() => setModal({kind: 'join', agentId, project: projectId}))}
                onOpenTools={() => openContextSettings('environment')} onOpenProviders={() => openContextSettings('providers')} onOpenSecrets={provider => openContextSettings('secrets', decisionProviderSection(provider))}/>}
              {member && agent && group && <GroupWorkspace key={member.id} member={member} agent={agent} group={group} snapshot={snapshot}
                revealHistory={searchTarget?.reveal === "group-history"} initialTab={searchTarget ? groupTabForSection(searchTarget.section) : groupTabs[member.id]} onTabChange={tab => setGroupTabs(current => ({...current,[member.id]:tab}))}
                onBot={next => select({kind:'membership',id:next.id})}
                onBotProfile={() => changeRoute(() => ({kind:'agent',id:agent.id,pane:{kind:'profile'}}))}
                onProject={id => select({kind: 'project', id})}
                onOpenTools={() => openContextSettings('environment')} onOpenProviders={() => openContextSettings('providers')} onOpenSecrets={provider => openContextSettings('secrets', decisionProviderSection(provider))}
                onChanged={async () => {await run({type:'refresh'});}}/>}
              {((route.kind === 'agent' && !agent) || (route.kind === 'group' && !group) || (route.kind === 'project' && !project) || (route.kind === 'membership' && (!member || !agent || !group))) && (
                <InlineNotice title="内容暂不可用">
                  {route.kind === 'membership' ? '这条群内协作或关联的 Bot、飞书群已变化。请返回上一级并刷新。' : '这个 Bot、飞书群或项目已变化。请返回列表并刷新。'}
                </InlineNotice>
              )}
            </>
          )}
          {(page === "setup" || (page === "home" && !snapshot.agents.length)) && <WelcomeSetup initialProvider={setupProvider} onProviderPrepared={setSetupProvider} onCreateBot={provider => void register(undefined, provider)} onOpenGroups={() => snapshot.agents.length === 1 ? openJoin(snapshot.agents[0]!.id, undefined, setupProvider) : openList("agents")} snapshot={snapshot} ready={ready} busy={busy} run={run} onRegister={agentId => void register(agentId)} onOpenEnvironment={() => openPage("environment")} onNotice={(message, error) => setNotice({message, error})} codexJobs={snapshot.jobs.filter(job => job.type === "loginCodex" && isActive(job)).map(job => <JobPanel key={job.id} job={job} run={run} busy={busy}/>)}/>}
          {page === "bridgeImport" && <section className="welcome-setup" aria-label="导入 Bridge"><header className="today-page-heading"><h1>导入 Bridge</h1></header><BridgeImportPanel ready={ready} busy={busy} platform={snapshot.application.platform} showUnavailable/></section>}
          {page === "providers" && <ProviderManager snapshot={snapshot} ready={ready} busy={busy} run={run} reveal={searchTarget?.reveal === 'codex' ? 'codex' : searchTarget?.reveal === 'claude' ? 'claude' : undefined}/>}
          {page === "environment" && <><EnvironmentPanel reveal={searchTarget?.reveal} codexBusy={snapshot.jobs.some(job => (job.type === "loginCodex" || job.type === "installCodex") && isActive(job))} request={client.environment} onCodexLogin={async () => {await run({type: "startCodexLogin"});}} codexJobs={snapshot.jobs.filter(job => job.type === "loginCodex" || job.type === "installCodex").map(job => <JobPanel key={job.id} job={job} run={run} busy={busy}/>)}/></>}
          {page === "usage" && <UsagePanel request={client.collaboration} onOpenEnvironment={() => openPage('environment')} onOpenShare={() => setModal({kind: 'shareUsage'})}/>}
          {page === "application" && (
            <>
              <SettingsGroup label="这台设备">
                <SettingsRow
                  icon={Monitor}
                  title={deviceTitle(snapshot.application.platform)}
                  value={`v${snapshot.application.version}`}
                />
              </SettingsGroup>
              <SettingsGroup label="启动选项" id={settingAnchor('启动选项')}>
                <SettingsRow
                  title="运行状态"
                  value={
                    host.kind === "connected"
                      ? host.ownership === "owned"
                        ? "由本机启动"
                        : "已接续现有服务"
                      : "尚未连接"
                  }
                />
                <SettingsRow
                  title="重启后台服务"
                  description="重新加载已保存的 Bot 设置。"
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
                <LoginServiceRow application={snapshot.application} busy={busy} onToggle={enabled => void runShell(async () => setNotice({message: await toggleService(enabled, client, shell), error: false}))}/>
              </SettingsGroup>
              <UpdatePanel request={client.machine} attached={host.kind === 'connected' && host.ownership === 'attached'}/>
              <details className="today-advanced-settings"><summary>高级运行设置<span>后台服务与执行程序</span><ChevronRight size={14} aria-hidden="true"/></summary><div>
                <MachinePanel reveal={searchTarget?.reveal} request={client.machine} agents={snapshot.agents} macos={snapshot.application.platform === 'macos'}/>
                <SettingsPanel scope="host" target={{ kind: "host" }} />
              </div></details>
              <SettingsGroup label="窗口与退出" id={settingAnchor('窗口与退出')} footer="关闭窗口会留在菜单栏或托盘继续运行。退出应用后，daemon 和 Bot 会继续在后台运行。">
                <SettingsRow title="隐藏到托盘" value={!shell?.hideWindow ? '桌面版提供' : undefined} trailing={<Button size="sm" disabled={!shell?.hideWindow} onClick={() => {if (shell?.hideWindow) void runShell(shell.hideWindow);}}>隐藏窗口</Button>} />
                <SettingsRow title="退出 Vonvon Bot" value={!shell?.quit ? '桌面版提供' : undefined} trailing={<Button size="sm" disabled={busy || !shell?.quit} onClick={() => {const quit = shell?.quit; if (quit) navigate(() => void runShell(quit));}}>退出应用</Button>} />
              </SettingsGroup>
            </>
          )}
          {page === "secrets" && <SecretsPanel onOpenProviders={() => openPage("providers")} onOpenApplication={() => openPage("application")}
            onOpenLogs={() => { openPage("diagnostics"); setSearchTarget({page: "diagnostics", section: "daemon 日志"}); }}/>}
          {page === "diagnostics" && <DiagnosticsPanel snapshot={snapshot} ready={ready} busy={busy} run={run}
            onOpenSetup={() => openPage("setup")} onOpenEnvironment={() => openPage("environment")} onOpenSecrets={() => openPage("secrets")}
            onNotice={(message, error) => setNotice({message, error})}/>}
          </>}
        </div>
      </AppShell>
      {searchOpen && <SearchDialog open entries={searchEntries(snapshot)} onClose={() => setSearchOpen(false)} onSelect={openSearchResult}/>}
      <PendingGroupToasts pages={pendingGroups} agents={snapshot.agents} hidden={modal !== null} onContinue={(owner, group) => openJoin(owner.id, group)} />
      {modal?.kind === 'join' && (() => {
        const owner = snapshot.agents.find(item => item.id === modal.agentId);
        return owner ? <JoinGroupDialog key={`${owner.id}:${modal.group?.chatId ?? 'new'}:${modal.project ?? ''}`} snapshot={snapshot} agent={owner} tools={snapshot.tools} initialProvider={modal.provider} initialProject={modal.project} open={!modal.suspended} onOpenProviders={() => configureJoinProvider()} onOpenDecisionModel={provider => configureJoinProvider('secrets', provider)} initialGroup={modal.group} pending={pendingGroups.find(item => item.agentId === owner.id)} onClose={() => setModal(null)} onChanged={joined} /> : null;
      })()}
      <Dialog
        open={modal !== null && modal.kind !== "deleteAgent" && modal.kind !== "join"}
        onClose={() => void closeModal()}
        title={
          modal?.kind === "register"
            ? modal.refresh ? "刷新 Bot 凭据" : "注册 Bot"
            : modal?.kind === "join"
              ? "让 Bot 加入飞书群"
              : modal?.kind === "shareUsage"
                ? "分享 Codex 用量"
                : "开始一次协作"
        }
      >
        <div className="page-stack">
          {feedback}
          {modal?.kind === "register" && modal.agentId && (
            <GrantStep key={modal.agentId} agentId={modal.agentId} onOpenChecklist={() => { setModal(null); openPage("setup"); }} onDone={() => {setModal(null); openPage("setup");}} />
          )}
          {modal?.kind === "register" && !modal.agentId && registration && (
            <><p>{modal.refresh ? "重新扫码刷新这个 Bot 的凭据，保留群绑定、会话和设置。请用这个 Bot 的管理员身份扫码。" : "用飞书扫码，随后完成权限配置。"}</p><JobPanel job={registration} run={run} busy={busy} /></>
          )}
          {modal?.kind === "collaboration" && (
            <>
              <p>
                请在飞书的对应群中 @ 这个
                Bot，发送下面的任务。实际回复由飞书中的 Bot 返回。
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
          {modal?.kind === 'shareUsage' && <ShareUsagePanel memberships={snapshot.memberships} agents={snapshot.agents} groups={snapshot.groups} request={client.collaboration}/>}
        </div>
      </Dialog>
      <ConfirmDialog
        open={modal?.kind === "deleteAgent"}
        title="移除本地 Bot"
        description={
          modal?.kind === "deleteAgent"
            ? deleteAgentDescription(modal.name, snapshot.memberships.filter(item => item.agentId === modal.agentId).length, botMemory)
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
              setNotice({ message: "本地 Bot 数据已删除。", error: false });
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
  const shell = useShellCapabilities();
  const [linkError, setLinkError] = useState("");
  const [copyNote, setCopyNote] = useState("");
  const urlInput = useRef<HTMLInputElement>(null);
  const linkFailure = (error: unknown) => setLinkError(error instanceof Error ? error.message : "链接操作失败。");
  async function copyLink(url: string) {
    setLinkError(""); setCopyNote("");
    try {
      // When the clipboard refuses, select the full link so the user can copy it by hand.
      const outcome = await copyAuthorizationUrl(url, "registration", () => { urlInput.current?.focus(); urlInput.current?.select(); });
      setCopyNote(copyFeedback(outcome));
    } catch (error) { linkFailure(error); }
  }
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
                二维码和注册链接已过期。请取消本次操作，关闭此对话框后重新注册 Bot。
              </p>
            ) : (
              <>
                <img className="desktop-qr" src={job.image} alt="飞书注册二维码" />
                <p>
                  请用飞书扫码，或打开注册链接。有效期至{" "}
                  {formatTime(job.expiresAt)}。
                </p>
                <FormField className="desktop-registration-url" label="完整注册链接">
                  <input ref={urlInput} aria-label="完整注册链接" readOnly value={job.url} />
                </FormField>
                <div className="desktop-actions">
                  <Button
                    disabled={busy}
                    onClick={() => void openExternalUrl(job.url, 'registration', shell).catch(linkFailure)}
                  >
                    打开链接
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void copyLink(job.url)}
                  >
                    复制链接
                  </Button>
                </div>
                {copyNote && <p className="settings-operation-message">{copyNote}</p>}
              </>
            )}
          </>
        ) : job.phase === "authorizing" ? (
          <>
            <p>在官方授权页面输入此设备代码。</p>
            <code className="desktop-device-code">{job.userCode}</code>
            <Button
              disabled={busy || !job.verificationUrl}
              onClick={() => { if (job.verificationUrl) void openExternalUrl(job.verificationUrl, 'authorization', shell).catch(linkFailure); }}
            >
              打开官方授权页面
            </Button>
            {!job.verificationUrl && <p>当前授权链接不可用，请重新开始授权。</p>}
          </>
        ) : (
          <p>
            {job.phase === "succeeded" && <Check size={14} />} {job.message}
          </p>
        )}
        {linkError && <p className="settings-operation-message" role="alert">{linkError}</p>}
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

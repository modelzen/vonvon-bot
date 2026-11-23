import {useActiveDevice, useClient, useDevicesState, useShellCapabilities} from './client-context';
import {DevicesPanel} from './devices/DevicesPanel';
import {DeviceSwitcher} from './devices/DeviceSwitcher';
import {DeviceStatusBanner, DeviceVersionNotice} from './devices/DeviceStatusBanner';
import {SnapshotPendingView} from './devices/DeviceConnectionView';
import {RemoteUpdateNotice} from './devices/RemoteUpdateNotice';
import {shouldMarkPlatform} from './devices/devices-presentation';
import {groupUrl} from './url-actions';
import {uiFeatures} from './features';
import {PendingGroupToasts} from './PendingGroupToasts';
import {JoinGroupDialog} from './JoinGroupDialog';
import {SelectJoinBotDialog} from './SelectJoinBotDialog';
import {GlowButton} from './GlowButton';
import {NavigationIndicator} from './NavigationIndicator';
import {usePendingGroups} from './pending-groups';
import type {MembershipId, PendingGroup, ProjectId} from '@vonvon/protocol';
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronRight,
  ListChecks,
  MessageSquare,
  Terminal,
  X,
} from "lucide-react";
import { AppShell } from "./LocalShell";
import { AgentAvatar } from './AgentAvatar';
import {OperationActivity} from './management/OperationActivity';
import { GroupAvatar } from './GroupAvatar';
import {BotGroupList} from './BotGroupList';
import {BotListRow} from './BotListRow';
import './bot-management.css';
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
import { ConfirmDialog,Dialog,hasOpenDialog } from "./reference/components/ui/Dialog";
import {
  conversationCopy,
  type AgentId,
  type Command,
  type CommandResult,
  type DesktopSnapshot,
  type Membership,
  type ScheduledTaskView,
  backendLabel,
  desktopUpdateNotice,
} from "@vonvon/protocol";
import type { CollaborationView, Page } from "./collaboration-model";
import {SettingsPanel} from "./settings/SettingsPanel";
import {DraftGuardProvider, useDraftGuard} from './settings/DraftGuard';
import {decisionProviderSection, diagnosticsSection, OPEN_SETTING_EVENT, searchEntries, settingAnchor, type Destination, type SearchEntry, type Selection} from './search';
import {agentPanes, initialRoute, openDm, openMembership, openScheduleTab, routeBack, routeDetail, routeFromSearch, routeSelection, routeView, type AgentPane, type CollaborationRoute, joinedGroupRoute} from './collaboration-navigation';
import {SearchDialog} from './SearchDialog';
import {flushSync} from 'react-dom';
import {GroupWorkspace, groupTabForSection, type GroupDesignTab} from './GroupWorkspace';
import {BotMap} from './BotMap';
import {BotSchedules} from './BotSchedules';
import {MEMORY_SEEN_EVENT} from './MemoryMap';
import {MigrationBanner} from './MigrationBanner';
import {newTag, sumCounts, useNewCounts} from './new-counts';
import {ShareUsagePanel, UsagePanel} from './management/UsagePanel';
import {EnvironmentPanel} from './management/EnvironmentPanel';
import {ProviderManager} from './setup/ProviderSetup';
import {providerNames, type SetupProvider} from './setup/provider-state';
import {WelcomeSetup} from './setup/WelcomeSetup';
import {BridgeImportPanel} from './setup/BridgeImportPanel';
import {TodayHome, SettingsHome} from './TodayHome';
import {LoginServiceRow, toggleService} from './setup/service-toggle';
import {BotConnectionSettings, jobToCancel, withRegisteredAgent, type RegisterModal} from './setup/GrantStep';
import {RegistrationDialog} from './setup/RegistrationDialog';
import {createRegistrationRetry} from './setup/registration-retry';
import {MachinePanel, quitKeepsText} from './management/MachinePanel';
import {RemoteServiceGroup, RESTART_HOST_TEXT} from './management/RemoteServiceGroup';
import {ServerUpdateCard} from './management/ServerUpdateCard';
import {whereName} from './device-copy';
import {DiagnosticsPanel} from './management/DiagnosticsPanel';
import {SecretsPanel} from './management/SecretsPanel';
import {AdministratorsPanel} from './management/AdministratorsPanel';
import {appCardFor, coreUpdatable, UpdatePanel} from './management/UpdatePanel';
import {DesktopUpdateProvider, useDesktopUpdate} from './desktop-update';
import {DesktopUpdateButton} from './DesktopUpdateButton';
import {CommunityPage} from './community/CommunityPage';
import {useCommunity} from './community/community-context';
import {AccountPanel} from './accounts/AccountPanel';
import {useAccountPage} from './accounts/account-page';

type Modal =
  | RegisterModal
  | {kind: 'selectJoinBot'}
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
function DetailTabs({selected, onSelect, first, second}: {selected: 'overview' | 'settings'; onSelect: (next: 'overview' | 'settings') => void; first: string; second: string}) {
  return <nav className="collaboration-detail-tabs" aria-label="详情视图">
    <button type="button" aria-current={selected === 'overview' ? 'page' : undefined} className={selected === 'overview' ? 'is-selected' : ''} onClick={() => onSelect('overview')}>{first}</button>
    <button type="button" aria-current={selected === 'settings' ? 'page' : undefined} className={selected === 'settings' ? 'is-selected' : ''} onClick={() => onSelect('settings')}>{second}</button>
  </nav>;
}
function BotDetailTabs({selected, onSelect}: {selected: AgentPane['kind']; onSelect: (pane: AgentPane) => void}) {
  return <nav className="collaboration-detail-tabs gooey-tabs" aria-label="Bot 详情">
    <NavigationIndicator activeIndex={agentPanes.findIndex(pane => pane.kind === selected)}/>
    {agentPanes.map(pane =>
      <button key={pane.kind} type="button" aria-current={selected === pane.kind ? 'page' : undefined} className={selected === pane.kind ? 'is-selected' : ''} onClick={() => onSelect({kind: pane.kind})}>{pane.label}</button>)}
  </nav>;
}

function FeaturePage({feature}: {feature: (typeof uiFeatures)[number]}) { const Component = feature.component; return <Component/>; }

export function App() {
  return <DraftGuardProvider><DesktopUpdateProvider><DesktopApp /></DesktopUpdateProvider></DraftGuardProvider>;
}
function DesktopApp() {
  const {navigate} = useDraftGuard();
  const client = useClient();
  const shell = useShellCapabilities();
  // The page is built again per device, so this stays what it was when the page mounted.
  const device = useActiveDevice();
  const [desktopUpdate] = useDesktopUpdate();
  const updateNotice = desktopUpdateNotice(desktopUpdate);
  const hasUpdateAction = Boolean(shell?.installDesktopUpdate && (desktopUpdate?.state === 'available' || desktopUpdate?.state === 'downloaded'));
  useEffect(() => shell?.onQuitRequested?.(() => navigate(() => {
    void shell.quit?.().catch(error => setNotice({message: error instanceof Error ? error.message : '后台服务尚未确认停止，请稍后再试。', error: true}));
  })), [shell, navigate]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<Destination>();
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const latestSnapshot = useRef<DesktopSnapshot | undefined>(undefined);
  const [route, setRoute] = useState<CollaborationRoute>(() => {
    const preview = typeof window !== 'undefined' && window.vonvonCardPreviewScope;
    return preview ? {kind:'membership', id:preview.membershipId, pane:{kind:'settings'}, parent:{kind:'group',id:preview.groupId}} : initialRoute;
  });
  const [setupProvider, setSetupProvider] = useState<SetupProvider>();
  const [setupAgentId, setSetupAgentId] = useState<AgentId>();
  const accountPage = useAccountPage();
  const community = useCommunity();
  const [currentPage, setCurrentPage] = useState<Page>(() => typeof window !== 'undefined' && window.vonvonCardPreviewScope ? 'collaboration' : 'home');
  const page = accountPage?.isOpen ? 'account' : community?.isOpen ? 'community' : currentPage;
  function setPage(next: Page) {
    if (next === 'community' && community) {accountPage?.close(); community.open();}
    else {community?.close(); if (next === 'account' && accountPage) accountPage.open(); else {accountPage?.close(); setCurrentPage(next);}}
  }
  const [externalCoreAvailable, setExternalCoreAvailable] = useState(false);
  const connectedVersion = snapshot?.host.kind === 'connected' ? snapshot.host.version : undefined;
  useEffect(() => {
    if (snapshot?.host.kind !== 'connected') {setExternalCoreAvailable(false); return;}
    if (page !== 'application' && !searchOpen) return;
    let active = true;
    setExternalCoreAvailable(false);
    void (async () => {
      try {
        const reply = await client.admin({type: 'daemonStatus'});
        if (active) setExternalCoreAvailable(reply.kind === 'daemonStatus' && coreUpdatable(reply.status.distribution?.kind));
      } catch { if (active) setExternalCoreAvailable(false); }
    })();
    return () => {active = false;};
  }, [client, page, searchOpen, snapshot?.host.kind, connectedVersion]);
  // devices 7.4: read once when 应用与启动 opens; unknown counts as quitting stops the daemon, as before.
  const devicesState = useDevicesState();
  const [quitKeepsDaemon, setQuitKeepsDaemon] = useState(false);
  useEffect(() => {
    if (page !== 'application' || !shell?.quitKeepsDaemon) {setQuitKeepsDaemon(false); return;}
    let active = true;
    void shell.quitKeepsDaemon().then(keep => {if (active) setQuitKeepsDaemon(keep);}, () => {if (active) setQuitKeepsDaemon(false);});
    return () => {active = false;};
  }, [page, shell]);
  // Task names are not in the snapshot: search asks the running Bots once each time it opens.
  const [searchSchedules, setSearchSchedules] = useState<ScheduledTaskView[]>([]);
  useEffect(() => {
    if (!searchOpen) return;
    let active = true;
    const running = latestSnapshot.current?.agents.filter(agent => agent.running) ?? [];
    void Promise.all(running.map(agent => client.schedule(agent.id, {action: 'listBot'}).then(reply => reply.kind === 'tasks' ? reply.tasks : [], () => [])))
      .then(lists => {if (active) setSearchSchedules(lists.flat());});
    return () => {active = false;};
  }, [client, searchOpen]);
  const [settingsReturn, setSettingsReturn] = useState<{page: Page; route: CollaborationRoute; label: string}>();
  const newCounts = useNewCounts(snapshot?.revision, MEMORY_SEEN_EVENT);
  const [groupDirectoryState, setGroupDirectoryState] = useState<GroupDirectoryState>({query: '', expanded: {}});
  const [projectDirectoryState, setProjectDirectoryState] = useState<ProjectDirectoryState>({query: '', expanded: {}});
  const [groupTabs, setGroupTabs] = useState<Record<string, GroupDesignTab>>(() => typeof window !== 'undefined' && window.vonvonCardPreviewScope ? {[window.vonvonCardPreviewScope.membershipId]:'response'} : {});
  const [newMemoryFocus, setNewMemoryFocus] = useState<{memberId: string; token: number}>();
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
  const registrationPending = useRef(false);
  const retryRegistrationFlow = useRef(createRegistrationRetry());
  const [registrationBusy, setRegistrationBusy] = useState(false);
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
        event.preventDefault(); if (!hasOpenDialog()) setSearchOpen(true);
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
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open) ancestor.open = true;
          ancestor = ancestor.parentElement;
        }
      }
      const rows = Array.from(section.querySelectorAll<HTMLElement>('[data-search-title]'));
      const row = searchTarget?.field ? rows.find(element => element.dataset.searchTitle === searchTarget.field) : undefined;
      const controls = Array.from(section.querySelectorAll<HTMLElement>('button, input, select, textarea, label, dt'));
      const control = searchTarget?.field ? controls.find(element => element.getAttribute('aria-label') === searchTarget.field || element.textContent?.trim() === searchTarget.field) : undefined;
      if (searchTarget?.field && !row && !control) return false;
      const candidate = row ?? control;
      // A matching field may live in a nested disclosure (for example machine runtime details).
      let disclosure = candidate?.closest('details');
      while (disclosure) {
        if (!disclosure.open) disclosure.open = true;
        disclosure = disclosure.parentElement?.closest('details') ?? null;
      }
      if (candidate?.closest('[hidden]')) return false;
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
        latestSnapshot.current = next;
        setSnapshot(next);
        setModal(current => current?.kind === "register" ? withRegisteredAgent(current, next.jobs) : current);
        // A remote device's platform would swap this computer's window chrome (devices-ui-1b 4.2).
        if (shouldMarkPlatform(device)) document.documentElement.dataset.desktopPlatform = next.application.platform;
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
      setNewMemoryFocus(undefined);
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
  function openGroupNewMemory(memberId: MembershipId) {
    if (!snapshot?.memberships.some(item => item.id === memberId)) return;
    navigate(() => {
      setGroupTabs(current => ({...current, [memberId]: 'memory'}));
      setNewMemoryFocus(current => ({memberId, token: (current?.token ?? 0) + 1}));
      setRoute(current => openMembership(current, memberId, snapshot));
      setPage('collaboration');
      setSettingsReturn(undefined);
      setFeatureId(undefined);
      setSearchTarget(undefined);
      setNotice(undefined);
    });
  }
  /** The group page of one Bot opened on its 任务 tab, from the Bot page's 任务 pane (which stays the parent). */
  function openGroupSchedule(memberId: MembershipId) {
    if (!snapshot?.memberships.some(item => item.id === memberId)) return;
    navigate(() => {
      setGroupTabs(current => openScheduleTab(current, memberId));
      setNewMemoryFocus(undefined);
      setRoute(current => openMembership(current, memberId, snapshot));
      setPage('collaboration');
      setSettingsReturn(undefined);
      setFeatureId(undefined);
      setSearchTarget(undefined);
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
  function openPage(next: Page, destination?: Destination) {
    navigate(() => {
      setModal(current => current?.kind === 'join' && current.suspended ? null : current);
      setJoinedTarget(undefined); setPage(next); setFeatureId(undefined); setSettingsReturn(undefined);
      setSetupAgentId(next === 'setup' && destination?.selection?.kind === 'agent' ? destination.selection.id : undefined);
      setSearchTarget(destination?.section ? destination : undefined);
    });
  }
  function openSetup(agentId?: AgentId) {
    openPage('setup', agentId ? {page: 'setup', selection: {kind: 'agent', id: agentId}} : undefined);
  }
  function openProviders(provider?: SetupProvider) {
    openPage('providers', provider ? {page: 'providers', reveal: provider, section: providerNames[provider]} : undefined);
  }
  // devices-ui-3: the paired toast sits outside App and asks for 设备 → 已配对的设备 this way (on 应用与启动 until 2026-11-03).
  const openSetting = useRef<(destination: Destination) => void>(() => undefined);
  openSetting.current = openDestination;
  useEffect(() => {
    const open = (event: Event) => { const detail = (event as CustomEvent<Destination | undefined>).detail; if (detail?.page) openSetting.current(detail); };
    window.addEventListener(OPEN_SETTING_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTING_EVENT, open);
  }, []);
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
  function openSearchResult(entry: SearchEntry) {flushSync(() => setSearchOpen(false)); openDestination(entry.destination);}
  function openDestination(destination: Destination) {
    if (!snapshot) {setSearchOpen(false); if (destination.page === 'collaboration') openList(destination.view ?? 'agents'); else openPage(destination.page, destination); return;}
    setSearchOpen(false);
    navigate(() => {
      setJoinedTarget(undefined);
      setModal(current => current?.kind === 'join' && current.suspended ? null : current);
      setPage(destination.page);
      setSetupAgentId(undefined);
      setSettingsReturn(undefined);
      setFeatureId(undefined);
      const target = routeFromSearch(destination, snapshot);
      if (target) {setRoute(target.route); if (target.route.kind === 'membership') {const memberId=target.route.id; setGroupTabs(current=>({...current,[memberId]:groupTabForSection(destination.section)}));}}
      setSearchTarget(target?.missing ? undefined : destination.section ? destination : undefined);
      setNotice(target?.missing ? {message: target.missing, error: false} : undefined);
    });
  }
  useEffect(() => {
    const departure = community?.departure;
    if (!departure) return;
    if (departure.deviceId !== device.id) {community.consumeDeparture(departure); return;}
    if (!snapshot) return;
    openDestination(departure.destination);
    community.consumeDeparture(departure);
  }, [community?.departure, snapshot, device.id]);
  async function register(agentId?: AgentId, provider?: SetupProvider) {
    if (!agentId && !provider && !snapshot?.agents.length) {openPage('setup'); return;}
    if (registrationPending.current) return;
    registrationPending.current = true;
    const generation = ++modalGeneration.current;
    const current = () => generation === modalGeneration.current;
    const initialAgentIds = latestSnapshot.current?.agents.map(agent => agent.id) ?? [];
    if (provider) {setSetupProvider(provider); setPage('setup');}
    try {
      const result = await run(agentId ? {type: "refreshAgentCredentials", agentId} : {type: "registerAgent"}, current);
      if (result.kind === 'started') {
        if (current()) setModal(withRegisteredAgent({kind: 'register', jobId: result.jobId, refresh: Boolean(agentId), refreshAgentId: agentId, initialAgentIds}, latestSnapshot.current?.jobs ?? []));
        else await run({type: 'cancelJob', jobId: result.jobId}, () => false);
      }
    } finally { registrationPending.current = false; }
  }
  async function retryRegistration() {
    if (modal?.kind !== 'register' || !latestSnapshot.current || registrationPending.current) return;
    registrationPending.current = true;
    setRegistrationBusy(true);
    setNotice(undefined);
    const generation = modalGeneration.current;
    const current = () => generation === modalGeneration.current;
    try {
      const result = await retryRegistrationFlow.current({modal, current,
        latest: () => latestSnapshot.current!, read: () => client.snapshot(),
        run: command => run(command, current)});
      if (!current()) return;
      if (result.kind === 'ready') {
        setNotice(undefined);
        setModal(result.modal);
      } else if (result.kind === 'blocked') setNotice({message: result.message, error: true});
    } finally { registrationPending.current = false; setRegistrationBusy(false); }
  }
  function openJoin(agentId: AgentId, group?: PendingGroup, provider?: SetupProvider) {
    navigate(() => setModal({kind: 'join', agentId, group, provider}));
  }
  async function closeModal() {
    const generation = ++modalGeneration.current;
    const cancel = modal?.kind === "register" ? jobToCancel(modal) : undefined;
    if (cancel) await run({ type: "cancelJob", jobId: cancel }, () => generation === modalGeneration.current);
    if (generation === modalGeneration.current) setModal(null);
  }
  if (page === 'community') return <><AppShell page="community" view={view} title="社区" onNavigate={openPage} onOpenList={openList}
    onSearch={() => {if (!hasOpenDialog()) setSearchOpen(true);}} updateAction={<DesktopUpdateButton/>}
    deviceSwitcher={shell?.devices ? <DeviceSwitcher onManage={() => openPage('devices')} onAccount={() => openPage('account')}/> : undefined}>
    <div className="page-stack"><CommunityPage/></div>
  </AppShell>{searchOpen && <SearchDialog open entries={searchEntries(snapshot, {externalCoreAvailable, schedules: searchSchedules, devices: Boolean(shell?.devices)})} onClose={() => setSearchOpen(false)} onSelect={openSearchResult}/>}</>;
  if (!snapshot) return <SnapshotPendingView/>;
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
    home: "此刻",
    community: "社区",
    settings: "设置",
    collaboration: route.kind === 'dm' ? `私聊 · ${agent?.name ?? 'Bot'}` : member
      ? `${group?.name ?? '飞书群'} · ${agent?.name ?? 'Bot'}`
      : (agent?.name ?? group?.name ?? project?.name ?? (view === "agents" ? "Bot" : view === "groups" ? "群组" : "项目管理")),
    setup: "飞书连接",
    administrators: "管理员",
    bridgeImport: "Bridge 导入",
    environment: "工具",
    providers: "Provider",
    usage: "用量",
    application: "应用与启动",
    secrets: "决策模型",
    diagnostics: "诊断",
    devices: "设备连接",
    account: "账号",
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
    : route.kind === 'dm' ? agent?.name ?? 'Bot'
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
        updateNotice={hasUpdateAction ? undefined : updateNotice}
        updateAction={<DesktopUpdateButton/>}
        title={feature?.label ?? titles[page]}
        firstUse={!snapshot.agents.length}
        onNavigate={openPage}
        selectedFeature={featureId}
        onFeatureNavigate={id => navigate(() => {setJoinedTarget(undefined); setModal(current => current?.kind === 'join' && current.suspended ? null : current); setFeatureId(id);})}
        onSearch={() => {if (!hasOpenDialog()) setSearchOpen(true);}}
        deviceSwitcher={shell?.devices ? <DeviceSwitcher onManage={() => openPage('devices')} onAccount={() => openPage('account')}/> : undefined}
        onOpenList={openList}
        backLabel={`返回 ${settingsReturn?.label ?? parentLabel}`}
        onBack={
          settingsReturn ? returnFromSettings : !feature && page === "collaboration" && route.kind !== 'list'
            ? () => changeRoute(current => current.kind === 'membership' && current.parent.kind === 'group' ? {kind: 'list', view: 'groups'} : routeBack(current))
            : undefined
        }
      >
        <div className="page-stack">
          {feature ? <FeaturePage feature={feature} /> : <>
          {page === 'collaboration' && route.kind !== 'list' && <nav className={`collaboration-breadcrumb${route.kind === 'membership' && view === 'groups' ? ' collaboration-breadcrumb--group-memory' : ''}`} aria-label="当前位置">
            <button type="button" onClick={() => openList(view)}>{view === 'agents' ? 'Bot' : view === 'groups' ? '群组' : '项目管理'}</button>
            <ChevronRight size={12} aria-hidden="true" />
            {route.kind === 'membership' && <>
              <button type="button" onClick={() => changeRoute(routeBack)}>{route.parent.kind === 'group' ? group?.name ?? '飞书群' : parentLabel}</button>
              <ChevronRight size={12} aria-hidden="true" />
            </>}
            {route.kind === 'dm' && <>
              <button type="button" onClick={() => changeRoute(routeBack)}>{parentLabel}</button>
              <ChevronRight size={12} aria-hidden="true" />
            </>}
            <span aria-current={route.kind === 'membership' && groupTabs[route.id] === 'memory' ? undefined : 'page'}>{route.kind === 'dm' ? '私聊' : route.kind === 'membership' ? route.parent.kind === 'agent' ? group?.name ?? '飞书群' : agent?.name ?? 'Bot' : agent?.name ?? group?.name ?? project?.name ?? '内容已变化'}</span>
            {route.kind === 'membership' && groupTabs[route.id] === 'memory' && <><ChevronRight size={12} aria-hidden="true"/><span aria-current="page">记忆</span></>}
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
          <RemoteUpdateNotice/>
          <DeviceStatusBanner/>
          <DeviceVersionNotice onUpgrade={() => openPage('application')}/>
          {!ready && (
            <InlineNotice
              title={
                host.kind === "starting" ? "正在连接 daemon" : "daemon 尚未就绪"
              }
              tone="warning"
            >
              {host.kind === "blocked" || host.kind === "disconnected"
                ? host.message
                : `正在读取${device.isRemote ? `${whereName(device)}的` : "本机"}运行状态。`}
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
          {page === "home" && snapshot.agents.length > 0 && <TodayHome snapshot={snapshot} onSetup={() => openPage("setup")} onRegister={() => void register()} onOpenUsage={() => openPage("usage")} disabled={!ready || busy}/>}
          {page === "settings" && <SettingsHome devices={Boolean(shell?.devices)} updateNotice={updateNotice} onNavigate={openPage} onFeature={id => navigate(() => setFeatureId(id))}/>}
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
                    title="添加 Bot"
                    description="飞书扫码注册"
                    trailing={<GlowButton disabled={!ready || busy} onClick={() => void register()}>添加 Bot</GlowButton>}
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
                  {view === 'agents' && <header className="today-page-heading today-page-heading--actions"><h1>Bot</h1><GlowButton disabled={!ready || busy} onClick={() => void register()}>添加 Bot</GlowButton></header>}
                  {view === "agents"
                    ? snapshot.agents.length > 0 && (
                        <section
                          aria-label="Bot 列表"
                          className="today-list-surface"
                        >
                            {snapshot.agents.map((agent) => {
                              const status = agentListStatus(agent);
                              const activating = pendingActivation?.agentId === agent.id ? pendingActivation : null;
                              const groupCount = new Set(
                                snapshot.memberships
                                  .filter((member) => member.agentId === agent.id)
                                  .map((member) => member.groupId),
                              ).size;
                              return (
                                <BotListRow key={agent.id} agent={agent} groupCount={groupCount}
                                  onSelect={() => select({kind: 'agent', id: agent.id})}
                                  newLabel={newCounts.bots[agent.id] ? newTag(newCounts.bots[agent.id]) : undefined}
                                  status={activating
                                    ? <OperationActivity key={`${agent.id}:${activating.enabled}`} label={activating.enabled ? '启用中' : '停用中'} state={activating.enabled ? 'connecting' : 'working'}/>
                                    : status.tone !== 'success' ? <span data-tone={status.tone}>{status.label}</span> : undefined}/>
                              );
                            })}
                        </section>
                      )
                    : view === "groups" ? <><MigrationBanner snapshot={snapshot}/><GroupDirectory snapshot={snapshot} state={groupDirectoryState} onStateChange={setGroupDirectoryState} statusFor={agentListStatus}
                        onMembership={id => select({kind: 'membership', id})} onNewMemory={openGroupNewMemory} newCounts={newCounts.projects}
                        onJoin={() => navigate(() => setModal({kind: 'selectJoinBot'}))} joinDisabled={!ready || busy || !snapshot.agents.some(agent => agent.enabled && !agent.readError)}/></>
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
                          : view === "groups" ? "点击「拉 Bot 入群」，选择 Bot 并连接已有飞书群。" : "把一个飞书群连到 Bot 上，就会有一个项目。"}
                      </p>
                      {view === "agents" && (
                        <GlowButton
                          disabled={!ready || busy}
                          onClick={() => void register()}
                        >
                          添加 Bot
                        </GlowButton>
                      )}
                    </div>
                  )}
                </>
              )}
              {selection.kind === "agent" && route.kind !== 'dm' && agent && (
                <>
                  <div className="bot-detail-header">
                  <header className="collaboration-profile">
                    <AgentAvatar agent={agent} large />
                    <div className="bot-detail-identity">
                      <div className="bot-detail-name-status">
                        <h2>{agent.name}</h2>
                        {pendingActivation?.agentId === agent.id ? <OperationActivity key={`${agent.id}:${pendingActivation.enabled}`} label={pendingActivation.enabled ? '启用中' : '停用中'} state={pendingActivation.enabled ? 'connecting' : 'working'}/>
                        : <span className="bot-detail-connection-status" data-tone={agentListStatus(agent).tone} role="status"><i aria-hidden="true"/>{agentListStatus(agent).label}</span>}
                      </div>
                    </div>
                  </header>
                  <div className="bot-detail-navigation"><BotDetailTabs selected={route.kind === 'agent' ? route.pane.kind : 'groups'} onSelect={agentPane}/></div>
                  </div>
                  {route.kind === 'agent' && route.pane.kind === 'profile' ? <BotMap agentId={agent.id} snapshot={snapshot} onProject={id => select({kind: 'project', id})}/>
                  : route.kind === 'agent' && route.pane.kind === 'schedule' ? <BotSchedules key={agent.id} agentId={agent.id} snapshot={snapshot} onOpen={openGroupSchedule} onOpenDm={() => changeRoute(() => openDm(agent.id, 'schedule', {kind: 'schedule'}))}/> : detail.kind !== 'agent-settings' ? <>
                  <BotGroupList
                    snapshot={snapshot}
                    agent={agent}
                    busy={busy || !ready}
                    status={agentListStatus(agent)}
                    onJoin={() => void openJoin(agent.id)}
                    onMembership={id => select({kind: 'membership', id})}
                    onDm={() => changeRoute(() => openDm(agent.id))}
                    dmNew={newCounts.dm[agent.id]}
                  />
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
                  <BotConnectionSettings key={`connection-${agent.id}`} agent={agent} disabled={busy || !ready}
                    onError={message => setNotice({message, error: true})}
                    onSetup={() => openSetup(agent.id)}
                    onRefreshCredentials={() => void register(agent.id)}
                    onDiagnostics={() => { openPage("diagnostics"); setSearchTarget({page: "diagnostics", section: diagnosticsSection(agent.id)}); }}/>
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
                revealHistory={searchTarget?.reveal === "group-history"} initialTab={searchTarget ? groupTabForSection(searchTarget.section) : groupTabs[member.id]} focusNew={newMemoryFocus?.memberId === member.id ? newMemoryFocus.token : undefined} newMemoryCount={member.projectId ? newCounts.projects[member.projectId] : undefined} onTabChange={tab => {setGroupTabs(current => ({...current,[member.id]:tab})); setNewMemoryFocus(undefined);}}
                onBot={next => select({kind:'membership',id:next.id})}
                onBotProfile={() => changeRoute(() => ({kind:'agent',id:agent.id,pane:{kind:'profile'}}))}
                onProject={id => select({kind: 'project', id})}
                onOpenTools={() => openContextSettings('environment')} onOpenProviders={() => openContextSettings('providers')} onOpenSecrets={provider => openContextSettings('secrets', decisionProviderSection(provider))}
                onChanged={async () => {await run({type:'refresh'});}}/>}
              {route.kind === 'dm' && agent?.dm && <GroupWorkspace key={agent.dm.id} dmMode member={agent.dm} agent={agent} group={{id: agent.dm.groupId, name: agent.dm.name}} snapshot={snapshot}
                initialTab={route.tab} newMemoryCount={newCounts.dm[agent.id]} onTabChange={tab => changeRoute(current => current.kind === 'dm' ? {...current, tab} : current)}
                onBot={() => undefined}
                onBotProfile={() => changeRoute(() => ({kind:'agent',id:agent.id,pane:{kind:'profile'}}))}
                onOpenTools={() => openContextSettings('environment')} onOpenProviders={() => openContextSettings('providers')} onOpenSecrets={provider => openContextSettings('secrets', decisionProviderSection(provider))}
                onChanged={async () => {await run({type:'refresh'});}}/>}
              {((route.kind === 'agent' && !agent) || (route.kind === 'dm' && !agent?.dm) || (route.kind === 'group' && !group) || (route.kind === 'project' && !project) || (route.kind === 'membership' && (!member || !agent || !group))) && (
                <InlineNotice title="内容暂不可用">
                  {route.kind === 'membership' ? '这条群内协作或关联的 Bot、飞书群已变化。请返回上一级并刷新。' : '这个 Bot、飞书群或项目已变化。请返回列表并刷新。'}
                </InlineNotice>
              )}
            </>
          )}
          {(page === "setup" || (page === "home" && !snapshot.agents.length)) && <WelcomeSetup key={setupAgentId ?? "global"} initialAgentId={setupAgentId} initialProvider={setupProvider} onProviderPrepared={setSetupProvider} onCreateBot={provider => void register(undefined, provider)} onOpenGroups={() => snapshot.agents.length === 1 ? openJoin(snapshot.agents[0]!.id, undefined, setupProvider) : openList("agents")} snapshot={snapshot} ready={ready} busy={busy} run={run} onRegister={agentId => void register(agentId)} onOpenProviders={openProviders} onNotice={(message, error) => setNotice({message, error})}/>}
          {page === "administrators" && <AdministratorsPanel agents={snapshot.agents} onOpenDm={agent => changeRoute(() => openDm(agent.id, 'response'))}/>}
          {page === "bridgeImport" && <section className="welcome-setup" aria-label="Bridge 导入"><header className="today-page-heading"><h1>Bridge 导入</h1></header><BridgeImportPanel ready={ready} busy={busy} platform={snapshot.application.platform} showUnavailable/></section>}
          {page === "providers" && <ProviderManager snapshot={snapshot} ready={ready} busy={busy} run={run} reveal={searchTarget?.reveal === 'codex' ? 'codex' : searchTarget?.reveal === 'claude' ? 'claude' : undefined}/>}
          {page === "environment" && <><EnvironmentPanel reveal={searchTarget?.reveal} request={client.environment}/></>}
          {page === "usage" && <UsagePanel request={client.collaboration} onOpenProviders={() => openProviders('codex')} onOpenShare={() => setModal({kind: 'shareUsage'})}/>}
          {page === "application" && (
            <div className="application-page">
              <header className="application-heading today-page-heading"><h1>应用与启动</h1></header>
              <UpdatePanel request={client.machine} externalCoreAvailable={device.isRemote ? false : externalCoreAvailable}
                attached={host.kind === 'connected' && host.ownership === 'attached'}
                {...appCardFor(device, snapshot.application, devicesState?.client.version)}
                server={device.isRemote ? <ServerUpdateCard variant="remote" request={client.machine} where={device}/> : undefined}
                advancedSettings={<>
                  <MachinePanel reveal={searchTarget?.reveal} request={client.machine} agents={snapshot.agents} macos={snapshot.application.platform === 'macos'}
                    {...device.isRemote ? {remote: device, onRestart: () => void run({type: 'restartHost'})} : {quitKeepsDaemon}}/>
                  <SettingsPanel scope="host" target={{kind: 'host'}}/>
                </>}>
                {device.isRemote ? <RemoteServiceGroup application={snapshot.application} where={device} busy={busy || host.kind !== 'connected'}
                  onRestart={() => void run({type: 'restartHost'})}
                  onToggle={enabled => void runShell(async () => setNotice({message: await toggleService(enabled, client, shell), error: false}))}/>
                : <SettingsGroup label="启动选项" id={settingAnchor('启动选项')} footer={<>{snapshot.application.platform === 'macos' ? '关闭窗口会隐藏 Dock 图标，Bot 继续运行；可从状态栏恢复窗口。' : '关闭桌面窗口后应用留在系统托盘，Bot 继续运行。'}{quitKeepsDaemon ? quitKeepsText : '选择退出会停止后台和所有 Bot。'}</>}>
                  <SettingsRow title="后台运行"
                    description={host.kind === 'connected'
                      ? `${host.ownership === 'owned' ? '由本机启动' : '已接续现有服务'} · ${RESTART_HOST_TEXT}`
                      : '尚未连接'}
                    trailing={<Button size="sm" disabled={busy || host.kind !== 'connected'} onClick={() => void run({type: 'restartHost'})}>重启后台</Button>}/>
                  <LoginServiceRow application={snapshot.application} busy={busy} onToggle={enabled => void runShell(async () => setNotice({message: await toggleService(enabled, client, shell), error: false}))}/>
                </SettingsGroup>}
              </UpdatePanel>
            </div>
          )}
          {/* 设备: the desktop's list, then 允许别的设备连接 of the device shown (the web page has only that) */}
          {page === "devices" && <DevicesPanel/>}
          {page === "account" && <AccountPanel/>}
          {page === "secrets" && <SecretsPanel onOpenProviders={() => openPage("providers")} onOpenApplication={() => openPage("application")}
            onOpenLogs={() => { openPage("diagnostics"); setSearchTarget({page: "diagnostics", section: "daemon 日志"}); }}/>}
          {page === "diagnostics" && <DiagnosticsPanel snapshot={snapshot} ready={ready} busy={busy} run={run}
            onOpenSetup={openSetup} onOpenProviders={openProviders} onOpenSecrets={() => openPage("secrets")}
            onNotice={(message, error) => setNotice({message, error})}/>}
          </>}
        </div>
      </AppShell>
      {searchOpen && <SearchDialog open entries={searchEntries(snapshot, {externalCoreAvailable, schedules: searchSchedules, devices: Boolean(shell?.devices)})} onClose={() => setSearchOpen(false)} onSelect={openSearchResult}/>}
      <PendingGroupToasts pages={pendingGroups} agents={snapshot.agents} hidden={modal !== null} onContinue={(owner, group) => openJoin(owner.id, group)} />
      {modal?.kind === 'selectJoinBot' && <SelectJoinBotDialog snapshot={snapshot} onSelect={id => openJoin(id)} onClose={() => setModal(null)}/>}
      {modal?.kind === 'join' && (() => {
        const owner = snapshot.agents.find(item => item.id === modal.agentId);
        return owner ? <JoinGroupDialog key={`${owner.id}:${modal.group?.chatId ?? 'new'}:${modal.project ?? ''}`} snapshot={snapshot} agent={owner} tools={snapshot.tools} initialProvider={modal.provider} open={!modal.suspended} onOpenProviders={() => configureJoinProvider()} onOpenDecisionModel={provider => configureJoinProvider('secrets', provider)} initialGroup={modal.group} pending={pendingGroups.find(item => item.agentId === owner.id)} onClose={() => setModal(null)} onChanged={joined} /> : null;
      })()}
      {modal?.kind === 'register' && <RegistrationDialog modal={modal} job={registration} busy={busy || registrationBusy} feedback={feedback}
        onClose={() => void closeModal()} onRetry={() => void retryRegistration()}
        onChecklist={agentId => {++modalGeneration.current; setModal(null); openSetup(agentId);}}/>}
      <Dialog
        open={modal !== null && modal.kind !== "deleteAgent" && modal.kind !== "join" && modal.kind !== 'selectJoinBot' && modal.kind !== 'register'}
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

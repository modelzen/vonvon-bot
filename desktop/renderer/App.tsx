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
  toolSchema,
  conversationSchema,
  type AgentId,
  type Command,
  type CommandResult,
  type DesktopSnapshot,
  type FolderChoice,
  type GroupId,
  type Job,
  type JobId,
  type Membership,
} from "../shared/bridge";
import type { CollaborationView, Page } from "./collaboration-model";
import {SettingsPanel,membershipSettingsTarget} from "./settings/SettingsPanel";
import {DraftGuardProvider, useDraftGuard} from './settings/DraftGuard';
import {searchEntries, settingAnchor, type SearchEntry, type Selection} from './search';
import {SearchDialog} from './SearchDialog';
import {ProjectPanel} from './management/ProjectPanel';
import {ConversationPanel} from './management/ConversationPanel';
import {UsagePanel} from './management/UsagePanel';
import {EnvironmentPanel} from './management/EnvironmentPanel';
import {MachinePanel} from './management/MachinePanel';
import {LogPanel} from './management/LogPanel';
import {UpdatePanel} from './management/UpdatePanel';

type Modal =
  | { kind: "register"; jobId: JobId; refresh?: boolean }
  | { kind: "join"; agentId: AgentId }
  | { kind: "collaboration"; membership: Membership }
  | { kind: "deleteAgent"; agentId: AgentId; name: string }
  | null;
type GroupsResult = Extract<CommandResult, { kind: "groups" }>;
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
const isActive = (job: Job) =>
  !["succeeded", "failed", "cancelled"].includes(job.phase);

export function App() {
  return <DraftGuardProvider><DesktopApp /></DraftGuardProvider>;
}
function DesktopApp() {
  const {navigate} = useDraftGuard();
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusSection, setFocusSection] = useState<string>();
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [view, setView] = useState<CollaborationView>("agents");
  const [page, setPage] = useState<Page>("collaboration");
  const [selection, setSelection] = useState<Selection>({ kind: "overview" });
  const [modal, setModal] = useState<Modal>(null);
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const modalGeneration = useRef(0);
  const groupRequest = useRef(0);
  const [notice, setNotice] = useState<{ message: string; error: boolean }>();
  const [groups, setGroups] = useState<GroupsResult>({
    kind: "groups",
    groups: [],
  });
  const [chosenGroup, setChosenGroup] = useState<GroupId>();
  const [folder, setFolder] = useState<FolderChoice>();
  const [projectName, setProjectName] = useState("");
  const [tool, setTool] = useState<"codex" | "claude">("codex");
  const [conversation, setConversation] = useState<"threads" | "shared">(
    "threads",
  );
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
    if (!focusSection) return;
    function focus() {
      const section = document.getElementById(settingAnchor(focusSection!));
      if (!section) return false;
      section.scrollIntoView({block: 'start'});
      section.tabIndex = -1;
      section.focus({preventScroll: true});
      setFocusSection(undefined);
      return true;
    }
    if (focus()) return;
    const observer = new MutationObserver(() => {if (focus()) observer.disconnect();});
    observer.observe(document.getElementById('main-content') ?? document.body, {childList: true, subtree: true});
    return () => observer.disconnect();
  }, [focusSection, page, selection]);
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
    navigate(() => {
      setSelection(next);
      setPage("collaboration");
      setNotice(undefined);
    });
  }
  function openList(next: CollaborationView) {
    navigate(() => {
      setView(next);
      setSelection({kind: 'overview'});
      setPage('collaboration');
      setNotice(undefined);
    });
  }
  function openPage(next: Page) { navigate(() => setPage(next)); }
  function openSearchResult(entry: SearchEntry) {
    setSearchOpen(false);
    navigate(() => {
      setPage(entry.destination.page);
      if (entry.destination.view) setView(entry.destination.view);
      if (entry.destination.selection) setSelection(entry.destination.selection);
      setFocusSection(entry.destination.section);
      setNotice(undefined);
    });
  }
  async function register(agentId?: AgentId) {
    const result = await run(agentId ? {type: "refreshAgentCredentials", agentId} : { type: "registerAgent" });
    if (result.kind === "started")
      setModal({ kind: "register", jobId: result.jobId, refresh: Boolean(agentId) });
  }
  async function loadGroups(agentId: AgentId, cursor?: string) {
    const generation = modalGeneration.current;
    const request = ++groupRequest.current;
    const isCurrent = () =>
      generation === modalGeneration.current &&
      request === groupRequest.current;
    const result = await run(
      { type: "listJoinedGroups", agentId, ...(cursor ? { cursor } : {}) },
      isCurrent,
    );
    if (isCurrent() && result.kind === "groups")
      setGroups((previous) =>
        cursor
          ? {
              ...result,
              groups: [
                ...previous.groups,
                ...result.groups.filter(
                  (group) =>
                    !previous.groups.some(
                      (existing) => existing.id === group.id,
                    ),
                ),
              ],
            }
          : result,
      );
  }
  async function openJoin(agentId: AgentId) {
    modalGeneration.current++;
    setGroups({ kind: "groups", groups: [] });
    setFolder(undefined);
    setChosenGroup(undefined);
    setProjectName("");
    setModal({ kind: "join", agentId });
    await loadGroups(agentId);
  }
  async function closeModal() {
    const generation = ++modalGeneration.current;
    if (modal?.kind === "register")
      await run({ type: "cancelJob", jobId: modal.jobId });
    if (generation === modalGeneration.current) setModal(null);
  }
  async function chooseFolder() {
    const generation = modalGeneration.current;
    const isCurrent = () => generation === modalGeneration.current;
    const result = await run({ type: "chooseFolder" }, isCurrent);
    if (isCurrent() && result.kind === "folderChosen") setFolder(result.folder);
  }
  async function bind() {
    if (modal?.kind !== "join" || !chosenGroup || !folder) return;
    const generation = modalGeneration.current;
    const result = await run({
      type: "bindGroup",
      agentId: modal.agentId,
      groupId: chosenGroup,
      projectName,
      folderToken: folder.token,
      tool,
      conversation,
    });
    if (generation === modalGeneration.current && result.kind === "applied") {
      modalGeneration.current++;
      setModal(null);
      setNotice({ message: "工作目录已绑定，内核已确认保存。", error: false });
    }
  }
  if (!snapshot)
    return (
      <div className="desktop-loading" role="status">
        正在打开 Vonvon Bridge…
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
      ? `${agent?.name ?? ""} · ${group?.name ?? ""}`
      : (agent?.name ?? group?.name ?? (view === "agents" ? "Agent" : "群聊")),
    environment: "本机环境",
    application: "应用与启动",
    diagnostics: "状态与诊断",
  };
  const host = snapshot.host;
  const ready = host.kind === "connected";
  const registration =
    modal?.kind === "register"
      ? snapshot.jobs.find((job) => job.id === modal.jobId)
      : undefined;
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
            ? <span className="collaboration-avatar group"><MessageSquare size={16} /></span>
            : <AgentAvatar agent={a} />}
          <span className="settings-entity-row__copy">
            <strong>{perspective === "agents" ? g.name : a.name}</strong>
            <small>
              {backendName(m.backend)} ·{" "}
              {m.conversation === "threads" ? "按话题独立会话" : "整群连续会话"}
            </small>
          </span>
          <span className="settings-entity-row__value">
            {m.stale
              ? "状态过期"
              : a.activation === "restartRequired"
                ? "等待重启"
                : connectedLabel(a.connection)}
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
        onBack={
          page === "collaboration" && selection.kind !== "overview"
            ? () => select({ kind: "overview" })
            : undefined
        }
      >
        <div className="page-stack">
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
              {host.kind === "connected" &&
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
              {!snapshot.agents.length && (
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
                  <div className="collaboration-page-heading">
                    <div>
                      <h2>
                        {view === "agents" ? "你的 Agent" : "已连接的飞书群"}
                      </h2>
                      <p>
                        {view === "agents"
                          ? "每个 Agent 使用独立的飞书机器人身份，在已加入的群里协作。"
                          : "同一个群可以有多个 Agent，各自保留工作目录和群内配置。"}
                      </p>
                    </div>
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
                  {view === "agents"
                    ? snapshot.agents.map((a) => (
                        <SettingsGroup
                          key={a.id}
                          label={
                            <button
                              className="section-title-link"
                              onClick={() =>
                                select({ kind: "agent", id: a.id })
                              }
                            >
                              <AgentAvatar agent={a} />
                              {a.name}
                              <ChevronRight size={13} />
                            </button>
                          }
                          action={
                            <Button
                              size="sm"
                              disabled={busy || !ready || !a.enabled}
                              onClick={() => void openJoin(a.id)}
                            >
                              加入飞书群
                            </Button>
                          }
                          footer={
                            a.readError ??
                            (a.activation === "restartRequired"
                              ? "配置已保存，等待原有 Bridge 重启。"
                              : connectedLabel(a.connection))
                          }
                        >
                          <div className="settings-entity-group__surface">
                            {membershipRows(
                              snapshot.memberships.filter(
                                (m) => m.agentId === a.id,
                              ),
                              "agents",
                            )}
                            {!snapshot.memberships.some(
                              (m) => m.agentId === a.id,
                            ) && (
                              <SettingsRow
                                title={
                                  a.readError
                                    ? "群配置读取失败"
                                    : "尚未绑定飞书群"
                                }
                                onClick={() => void openJoin(a.id)}
                              />
                            )}
                          </div>
                        </SettingsGroup>
                      ))
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
                      <h2>{agent.name}</h2>
                      <p>通过飞书机器人身份参与协作</p>
                    </div>
                    <StatusBadge
                      tone={
                        agent.connection === "connected" ? "success" : "neutral"
                      }
                    >
                      {connectedLabel(agent.connection)}
                    </StatusBadge>
                  </header>
                  <SettingsGroup label="Agent 身份">
                    <SettingsRow
                      title="应用 ID"
                      value={<code>{agent.id}</code>}
                    />
                    <SettingsRow
                      title="启用 Agent"
                      description="更改后需要重新启动当前 Bridge。"
                      trailing={
                        <Toggle
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
                  <ProjectPanel key={`create-${agent.id}`} scope={{kind: 'agent', agentId: agent.id}} request={window.bridge.collaboration} onChanged={async () => {await run({type: 'refresh'});}}/>
                  <UsagePanel key={`agent-usage-${agent.id}`} agentId={agent.id} request={window.bridge.collaboration}/>
                  <SettingsPanel
                    key={`agent-${agent.id}`}
                    target={{ kind: "agent", botId: agent.id }}
                  />
                  <SettingsGroup
                    label="已绑定的飞书群"
                    action={
                      <Button
                        size="sm"
                        disabled={busy || !agent.enabled}
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
                      ) && <SettingsRow title="尚未绑定飞书群" />}
                    </div>
                  </SettingsGroup>
                  <SettingsGroup
                    label="移除 Agent"
                    footer="删除本地注册信息、凭据、群绑定、会话记录与设置。飞书开发者平台中的应用仍保留。"
                  >
                    <SettingsRow
                      title="删除本地 Agent 数据"
                      description={
                        agent.enabled || agent.connection !== "disconnected"
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
                            agent.connection !== "disconnected" ||
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
                </>
              )}
              {selection.kind === "group" && group && (
                <>
                  <header className="collaboration-profile">
                    <span className="collaboration-avatar group large">
                      <MessageSquare size={24} />
                    </span>
                    <div>
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
                  <SettingsGroup label="Vonvon 注册的机器人">
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
                  <header className="collaboration-profile">
                    <AgentAvatar agent={agent} large />
                    <div>
                      <h2>{agent.name}</h2>
                      <p>在 {group.name} 中的配置</p>
                    </div>
                  </header>
                  <div className="collaboration-context-links">
                    <button
                      onClick={() => select({ kind: "agent", id: agent.id })}
                    >
                      查看 Agent
                    </button>
                    <button
                      onClick={() => select({ kind: "group", id: group.id })}
                    >
                      查看飞书群
                    </button>
                  </div>
                  <ProjectPanel key={`manage-${member.id}`} scope={{kind: 'project', agentId: agent.id, groupId: group.id, projectName: member.name}} request={window.bridge.collaboration} onChanged={async () => {await run({type: 'refresh'});}} />
                  <ConversationPanel key={`sessions-${member.id}`} agentId={agent.id} groupId={group.id} projectName={member.name} conversation={member.conversation} request={window.bridge.collaboration}/>
                  <UsagePanel key={`usage-${member.id}`} agentId={agent.id} project={{groupId: group.id, projectName: member.name}} request={window.bridge.collaboration}/>
                  <SettingsPanel
                    key={`project-${member.id}`}
                    target={membershipSettingsTarget(member)}
                  />
                  <div className="desktop-actions">
                    <Button
                      disabled={member.stale}
                      onClick={() =>
                        setModal({ kind: "collaboration", membership: member })
                      }
                    >
                      开始一次协作
                    </Button>
                  </div>
                </>
              )}
              {selection.kind !== "overview" && !member && !agent && !group && (
                <InlineNotice title="内容暂不可用">
                  这个项目可能已经变更。请返回列表并刷新。
                </InlineNotice>
              )}
            </>
          )}
          {page === "environment" && <EnvironmentPanel codexBusy={snapshot.jobs.some(job => (job.type === "loginCodex" || job.type === "installCodex") && isActive(job))} request={window.bridge.environment} onCodexLogin={async () => {await run({type: "startCodexLogin"});}} codexJobs={snapshot.jobs.filter(job => job.type === "loginCodex" || job.type === "installCodex").map(job => <JobPanel key={job.id} job={job} run={run} busy={busy}/>)}/>}
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
              <SettingsGroup label="Bridge 运行">
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
              <MachinePanel request={window.bridge.machine} agents={snapshot.agents}/>
              <UpdatePanel request={window.bridge.machine} attached={host.kind === 'connected' && host.ownership === 'attached'}/>
              <SettingsPanel target={{ kind: "host" }} />
              <SettingsGroup
                label="窗口与退出"
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
                  title="退出 Vonvon Bridge"
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
            <>
              <SettingsGroup label="当前状态">
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
            </>
          )}
        </div>
      </AppShell>
      <SearchDialog open={searchOpen} entries={searchEntries(snapshot)} onClose={() => setSearchOpen(false)} onSelect={openSearchResult}/>
      <Dialog
        open={modal !== null && modal.kind !== "deleteAgent"}
        onClose={() => void closeModal()}
        title={
          modal?.kind === "register"
            ? modal.refresh ? "刷新 Agent 凭据" : "注册 Agent"
            : modal?.kind === "join"
              ? "让 Agent 加入飞书群"
              : "开始一次协作"
        }
      >
        <div className="page-stack">
          {feedback}
          {modal?.kind === "register" && registration && (
            <><p>{modal.refresh ? "重新授权这个 Agent，保留原有项目、群绑定和设置。请使用此 Agent 的管理员身份完成授权。" : "连接飞书机器人身份。"}</p><JobPanel job={registration} run={run} busy={busy} /></>
          )}
          {modal?.kind === "join" && (
            <>
              <p>先在飞书群中添加这个 Agent 的机器人，再刷新已加入的群列表。</p>
              <FormField label="飞书群">
                <select
                  aria-label="选择飞书群"
                  value={chosenGroup ?? ""}
                  onChange={(event) => {
                    const selected = groups.groups.find(
                      (group) => group.id === event.target.value,
                    );
                    setChosenGroup(selected?.id);
                    setProjectName(selected?.name ?? "");
                  }}
                >
                  <option value="">请选择已加入的群</option>
                  {groups.groups.map((group) => (
                    <option
                      key={group.id}
                      value={group.id}
                      disabled={group.bound}
                    >
                      {group.name}
                      {group.bound ? "（已绑定）" : ""}
                    </option>
                  ))}
                </select>
              </FormField>
              <div className="desktop-actions">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void loadGroups(modal.agentId)}
                >
                  刷新群列表
                </Button>
                {groups.nextCursor && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void loadGroups(modal.agentId, groups.nextCursor)
                    }
                  >
                    加载更多
                  </Button>
                )}
              </div>
              {!groups.groups.length && !busy && (
                <p>没有可显示的群。请先确认 Agent 已在飞书群中，并已启用。</p>
              )}
              <FormField label="本地绑定名称">
                <input
                  aria-label="本地绑定名称"
                  maxLength={100}
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </FormField>
              <SettingsGroup>
                <SettingsRow
                  title="工作目录"
                  value={folder?.displayPath ?? "未选择"}
                  trailing={
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void chooseFolder()}
                    >
                      选择文件夹
                    </Button>
                  }
                />
                <SettingsRow
                  title="执行工具"
                  trailing={
                    <select
                      aria-label="执行工具"
                      value={tool}
                      onChange={(event) =>
                        setTool(toolSchema.parse(event.target.value))
                      }
                    >
                      <option value="codex">Codex</option>
                      <option value="claude">Claude</option>
                    </select>
                  }
                />
                <SettingsRow
                  title="会话方式"
                  trailing={
                    <select
                      aria-label="会话方式"
                      value={conversation}
                      onChange={(event) =>
                        setConversation(
                          conversationSchema.parse(event.target.value),
                        )
                      }
                    >
                      <option value="threads">按话题独立会话</option>
                      <option value="shared">整群连续会话</option>
                    </select>
                  }
                />
              </SettingsGroup>
              <Button
                variant="primary"
                disabled={
                  busy || !chosenGroup || !folder || !projectName.trim()
                }
                onClick={() => void bind()}
              >
                绑定工作目录并发送欢迎卡片
              </Button>
            </>
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

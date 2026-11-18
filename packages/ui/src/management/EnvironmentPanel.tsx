import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button, IconButton, StatusBadge } from "../reference/components/ui";
import { ConfirmDialog, Dialog } from "../reference/components/ui/Dialog";
import { useDraft } from "../settings/DraftGuard";
import { presentTool, profileTokenLabel, toolNames } from "./environmentPresentation";
import type {
  BackendEntry, EnvironmentOperation, EnvironmentProfile, EnvironmentReply,
  EnvironmentRequest, EnvironmentTool, EnvironmentToolState, ToolInstallOperation,
} from "@vonvon/protocol";
import "./environment.css";
import {SettingChoices} from "../settings/SettingChoices";
import {McpPanel} from "./McpPanel";
import {settingAnchor, type SearchReveal} from '../search';
import {useActiveDevice, useShellCapabilities} from '../client-context';
import {CHECK_CONFIG, CONFIG_STATE, onDeviceText, placeOf, remoteToolsNote, whereName} from '../device-copy';
import {openExternalUrl} from '../url-actions';
import {OperationActivity} from './OperationActivity';

type BackendLogin = Extract<EnvironmentReply, { kind: "backendLogin" }>;

type Props = { request: (request: EnvironmentRequest) => Promise<EnvironmentReply>; reveal?: SearchReveal };
type Intent = { kind: "install" | "update" | "disable"; tool: EnvironmentTool };
function visibleInstall(operation: ToolInstallOperation | null, current: ToolInstallOperation | null): ToolInstallOperation | null {
  if (!operation) return null;
  if (operation.kind === "running") return operation.tool === "lark-cli" ? operation : null;
  return current?.id === operation.id ? operation : null;
}
export function EnvironmentPanel({ request, reveal }: Props) {
  const shell = useShellCapabilities();
  const where = useActiveDevice();
  const [mcpRefresh, setMcpRefresh] = useState(0);
  const [tools, setTools] = useState<EnvironmentToolState[]>([]);
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [backends, setBackends] = useState<BackendEntry[]>([]);
  const [auth, setAuth] = useState<Partial<Record<EnvironmentTool, Extract<EnvironmentReply, { kind: "auth" }>>>>({});
  const [logins, setLogins] = useState<Record<string, BackendLogin>>({});
  const [operation, setOperation] = useState<EnvironmentOperation | null>(null);
  const [toolInstall, setToolInstall] = useState<ToolInstallOperation | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [backendDisable, setBackendDisable] = useState<BackendEntry | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [brand, setBrand] = useState<"feishu" | "lark">("feishu");
  const [useProfile, setUseProfile] = useState(false);
  const [profileMode, setProfileMode] = useState<"add" | "create" | null>(null);
  const [qr, setQr] = useState("");
  useEffect(() => {
    if (reveal === 'profile-manager' || reveal === 'profile-add' || reveal === 'profile-create') {
      setProfilesOpen(true);
      if (reveal === 'profile-add') setProfileMode('add');
      if (reveal === 'profile-create') setProfileMode('create');
    }
  }, [reveal]);

  const refresh = useCallback(async () => {
    const replies = await Promise.allSettled([
      request({ type: "scan" }), request({ type: "profileList" }),
      request({ type: "backendCatalog" }), request({ type: "profileInitStatus" }),
      request({ type: "toolInstallStatus" }),
    ]);
    setMcpRefresh(value => value + 1);
    for (const result of replies) {
      if (result.status === "rejected") { setNotice("暂时无法读取本机环境，请重试。"); continue; }
      const reply = result.value;
      if (reply.kind === "tools") setTools(reply.tools);
      if (reply.kind === "profiles") setProfiles(reply.profiles);
      if (reply.kind === "backends") setBackends(reply.entries);
      if (reply.kind === "operation") setOperation(reply.operation?.kind === "running" && reply.operation.purpose.kind === "login" && reply.operation.purpose.tool !== "lark-cli" ? null : reply.operation);
      if (reply.kind === "toolInstall") {
        setToolInstall(current => visibleInstall(reply.operation, current));
        if (reply.operation?.kind === "running" && reply.operation.tool === "lark-cli") setProgressOpen(true);
      }
      if (reply.kind === "refused" && reply.code === "tool-missing") setProfiles([]);
      if (reply.kind === "refused" && reply.code !== "tool-missing") setNotice(reply.message);
    }
  }, [request]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const results = await Promise.allSettled([request({ type: "toolInstallStatus" }), request({ type: "profileInitStatus" })]);
      if (!live) return;
      for (const result of results) {
        if (result.status !== "fulfilled") { setNotice("暂时无法读取操作状态，请重新检测。"); continue; }
        if (result.value.kind === "toolInstall") {
          const next = result.value.operation;
          setToolInstall(current => visibleInstall(next, current));
        }
        if (result.value.kind === "operation") setOperation(result.value.operation?.kind === "running" && result.value.operation.purpose.kind === "login" && result.value.operation.purpose.tool !== "lark-cli" ? null : result.value.operation);
      }
      timer = setTimeout(() => void poll(), 1000);
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { live = false; clearTimeout(timer); };
  }, [request]);
  useEffect(() => {
    if (toolInstall?.kind !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [toolInstall?.kind]);
  useEffect(() => {
    if (!toolInstall || toolInstall.kind === "running") return;
    void refresh();
  }, [toolInstall?.id, toolInstall?.kind]);
  useEffect(() => {
    if (!operation || operation.kind === "running") return;
    void refresh();
  }, [operation?.id, operation?.kind]);
  useEffect(() => {
    const installed = tools.filter((tool) => tool.tool === "lark-cli" && tool.installation !== "missing");
    if (!installed.length) return;
    let live = true;
    void Promise.allSettled(installed.map((tool) => request({ type: "authStatus", tool: tool.tool }))).then((results) => {
      if (!live) return;
      const next: Partial<Record<EnvironmentTool, Extract<EnvironmentReply, { kind: "auth" }>>> = {};
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.kind === "auth") next[result.value.tool] = result.value;
        else if (result.status === "rejected" || result.value.kind === "refused") setNotice("暂时无法检查工具授权，请重新检测。");
      }
      setAuth(next);
    });
    return () => { live = false; };
  }, [tools, request]);
  const loginRequests = useRef<Record<string, number>>({});
  const checkLogin = useCallback(async (id: string, refresh: boolean) => {
    const sequence = (loginRequests.current[id] ?? 0) + 1;
    loginRequests.current[id] = sequence;
    // Only the latest request for a backend may set its line.
    const settle = (reply: BackendLogin) => { if (loginRequests.current[id] === sequence) setLogins((current) => ({ ...current, [id]: reply })); };
    if (refresh) setLogins((current) => { const next = { ...current }; delete next[id]; return next; });
    try {
      const reply = await request({ type: "backendLogin", id, refresh });
      if (reply.kind === "backendLogin") settle(reply);
    } catch { settle({ kind: "backendLogin", id, state: "unknown", message: `暂时无法检查配置，稍后再点“${CHECK_CONFIG}”。` }); }
  }, [request]);
  useEffect(() => {
    for (const backend of backends) if (backend.id !== "claude-agent" && backend.id !== "codex-appserver" && backend.depState === "installed") void checkLogin(backend.id, false);
  }, [backends, checkLogin]);
  useEffect(() => {
    if (operation?.kind !== "running" || !operation.url) { setQr(""); return; }
    let live = true;
    void QRCode.toDataURL(operation.url, { margin: 1, width: 190 }).then((image) => { if (live) setQr(image); }).catch(() => { if (live) setQr(""); });
    return () => { live = false; };
  }, [operation?.kind === "running" ? operation.id : undefined, operation?.kind === "running" ? operation.url : undefined]);

  async function act(next: EnvironmentRequest): Promise<boolean> {
    setBusy(true);
    setNotice(next.type === "backendInstall" ? next.update ? "正在更新…" : "正在安装…" : next.type === "backendUninstall" ? "正在卸载…" : "");
    try {
      const reply = await request(next);
      if (reply.kind === "refused" || reply.kind === "applied") setNotice(reply.message);
      if (reply.kind === "profiles") setProfiles(reply.profiles);
      if (reply.kind === "operation") setOperation(reply.operation);
      if (reply.kind === "toolInstall") setToolInstall(reply.operation);
      if (["install", "update", "uninstall", "backendInstall", "backendUninstall", "profileAdd", "profileUse"].includes(next.type)) await refresh();
      return reply.kind !== "refused";
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败。"); return false; }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!intent) return;
    const next: EnvironmentRequest = intent.kind === "disable"
      ? { type: "uninstall", tool: intent.tool }
      : { type: intent.kind, tool: intent.tool };
    const choice = intent;
    setIntent(null);
    if (choice.kind !== "disable") { setToolInstall(null); setProgressOpen(true); setNow(Date.now()); }
    const succeeded = await act(next);
    if (!succeeded) setProgressOpen(false);
  }
  async function cancelInstall(id: string) {
    setCancelling(true);
    try {
      const reply = await request({ type: "cancelInstall", operationId: id });
      if (reply.kind === "toolInstall") setToolInstall(reply.operation);
      if (reply.kind === "refused") setNotice(reply.message);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法取消安装。"); }
    finally { setCancelling(false); }
  }
  async function checkAuth(tool: EnvironmentTool) {
    try {
      const reply = await request({ type: "authStatus", tool });
      if (reply.kind === "auth") setAuth((previous) => ({ ...previous, [tool]: reply }));
      else if (reply.kind === "refused") setNotice(reply.message);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法检查授权。"); }
  }
  function discardProfile() { setName(""); setAppId(""); setAppSecret(""); setBrand("feishu"); setUseProfile(false); }
  async function saveProfile() {
    if (busy || !name.trim() || !appId.trim() || !appSecret) return false;
    const saved = await act({ type: "profileAdd", name: name.trim(), appId: appId.trim(), appSecret, brand, use: useProfile });
    if (saved) { discardProfile(); setProfileMode(null); }
    return saved;
  }
  useDraft(Boolean(name || appId || appSecret || useProfile || brand !== "feishu"), { title: "飞书 CLI 账号配置", save: saveProfile, discard: discardProfile });
  const running = toolInstall?.kind === "running" ? toolInstall : null;
  const activeProfile = profiles.find((profile) => profile.effective) ?? profiles.find((profile) => profile.active);
  const otherBackends = backends.filter(backend => backend.id !== "codex-appserver" && backend.id !== "claude-agent");

  async function checkBackendVersion(backend: BackendEntry) {
    try {
      const reply = await request({ type: "backendVersion", id: backend.id });
      // Claude Agent SDK 锁定版本，回来的 latest 是 Vonvon Bot 验证过的版本，不是 npm 上的最新版。
      const target = backend.id === "claude-agent" ? "验证过的版本" : "最新";
      if (reply.kind === "backendVersion") setNotice(reply.latest ? `已安装 ${reply.installed ?? "未知"}，${target} ${reply.latest}` : "暂时无法查询最新版本。");
      else if (reply.kind === "refused") setNotice(reply.message);
    } catch { setNotice("暂时无法查询最新版本。"); }
  }
  const backendActions = {
    busy,
    onInstall: (backend: BackendEntry, update: boolean) => void act({ type: "backendInstall", id: backend.id, update }),
    onCheckVersion: (backend: BackendEntry) => void checkBackendVersion(backend),
    onUninstall: setBackendDisable,
  };

  return <section className="environment-panel" aria-label={where.isRemote ? `${whereName(where)}的工具` : "工具"} id={settingAnchor('工具与连接')}>
    <header className="environment-lead today-page-heading">
      <h1>工具</h1>
      <IconButton label="重新检测" title={where.isRemote ? `重新检测${whereName(where)}的工具` : "重新检测本机工具"} disabled={busy} onClick={() => void refresh()}><RefreshCw size={15}/></IconButton>
    </header>
    {where.isRemote && <p className="environment-notice" role="note">{remoteToolsNote(where)}</p>}
    {notice && <p className="environment-notice" role="status">{onDeviceText(where, notice)}</p>}
    {running && !progressOpen && <div className="environment-notice" role="status">{toolNames[running.tool]} 正在{running.update ? "更新" : "安装"}。<Button size="sm" onClick={() => setProgressOpen(true)}>返回进度</Button></div>}
    <div className="environment-groups">
      <DependencyGroup title={where.isRemote ? `${whereName(where)}上的工具` : "本机工具"} description="读写飞书文档、消息等内容。">
        {tools.filter((tool) => tool.tool === "lark-cli").map((tool) => <ToolRow key={tool.tool} reveal={reveal === 'lark-tool'} tool={tool} auth={auth[tool.tool]} profiles={profiles} busy={busy || Boolean(running)} running={running?.tool === tool.tool} onIntent={setIntent} onCheckAuth={checkAuth} onLogin={() => void act({ type: "startLogin", tool: tool.tool })} onProgress={() => setProgressOpen(true)} onManageProfiles={() => setProfilesOpen(true)} />)}
      </DependencyGroup>
      {otherBackends.length > 0 && <DependencyGroup title="其他 Provider">
        {otherBackends.map((backend) => <BackendRow key={backend.id} backend={backend} actions={backendActions} login={logins[backend.id]} onCheckLogin={() => void checkLogin(backend.id, true)} />)}
      </DependencyGroup>}
      <McpPanel refreshKey={mcpRefresh}/>
    </div>
    {!tools.length && <p className="environment-empty" role="status">{where.isRemote ? `正在检测${whereName(where)}上的工具…` : "正在检测本机工具…"}</p>}
    {operation && <section className="environment-login-operation" role="status">
      <strong>{operation.kind === "running" ? operation.purpose.kind === "login" ? `${toolNames[operation.purpose.tool]} 等待授权` : "等待创建应用" : operation.message}</strong>
      {operation.kind === "running" && <div className="environment-verification">
        {operation.url && <><Button size="sm" onClick={() => { if (operation.url) void openExternalUrl(operation.url, 'verification', shell).catch(error => setNotice(error instanceof Error ? error.message : '无法打开验证链接。')); }}>前往授权</Button><input readOnly aria-label="授权链接" value={operation.url} />{qr && <img src={qr} alt="授权二维码" width={190} height={190} />}</>}
        <Button size="sm" onClick={() => void act({ type: operation.purpose.kind === "login" ? "cancelLogin" : "profileInitCancel", operationId: operation.id })}>取消</Button>
      </div>}
    </section>}
    <Dialog open={progressOpen} onClose={() => setProgressOpen(false)} title="安装进度" description="关闭后会在后台继续。" size="sm">
      {!toolInstall && <div className="environment-progress" role="status"><strong>正在准备…</strong><Button onClick={() => setProgressOpen(false)}>后台继续</Button></div>}
      {toolInstall && <div className="environment-progress" role="status">
        <strong className="environment-progress-title">{toolInstall.kind === "running" ? <OperationActivity key={toolInstall.id} state="working" label={`${toolNames[toolInstall.tool]} 正在${toolInstall.update ? "更新" : "安装"}`}/> : toolInstall.message}</strong>
        {toolInstall.kind === "running" && <><p>已运行 {Math.max(0, Math.floor((now - toolInstall.startedAt) / 1000))} 秒</p><Button disabled={cancelling} onClick={() => void cancelInstall(toolInstall.id)}>{cancelling ? "正在取消" : "取消任务"}</Button></>}
        <Button onClick={() => setProgressOpen(false)}>{toolInstall.kind === "running" ? "后台继续" : "完成"}</Button>
      </div>}
    </Dialog>
    <ConfirmDialog open={Boolean(backendDisable)} title={backendDisable ? `卸载 ${backendDisable.displayName}` : "卸载"} description="仅卸载由 Vonvon 管理的组件。" confirmLabel="卸载" tone="danger" onCancel={() => setBackendDisable(null)} onConfirm={() => { const selected = backendDisable; setBackendDisable(null); if (selected) void act({ type: "backendUninstall", id: selected.id }); }} />
    <ConfirmDialog open={Boolean(intent)} title={intent ? `${intent.kind === "disable" ? "停用" : intent.kind === "update" ? "更新" : "安装"} ${toolNames[intent.tool]}` : "确认操作"} description={intent?.kind === "disable" ? "只停用 Vonvon 托管副本。其他已安装的工具不会被删除。" : intent?.kind === "update" ? `Vonvon 将在${placeOf(where)}安装并验证新版本，然后切换到托管副本。` : `Vonvon 会在${placeOf(where)}安装并验证托管副本。`} confirmLabel={intent?.kind === "disable" ? "停用托管副本" : intent?.kind === "update" ? "开始更新" : "开始安装"} tone={intent?.kind === "disable" ? "danger" : "primary"} onCancel={() => setIntent(null)} onConfirm={() => void confirm()} />
    <Dialog open={profilesOpen} onClose={() => setProfilesOpen(false)} size="md" title="管理飞书 CLI" description="选择飞书工具使用的应用与账号。">
      <div className="environment-profiles" id={settingAnchor('飞书 CLI 账号配置')}>
        {notice && <p className="environment-notice" role="status">{notice}</p>}
        <p>当前生效：{activeProfile ? `${activeProfile.name} · ${activeProfile.appId}${activeProfile.effectiveSource ? ` · ${profileSourceLabel(activeProfile.effectiveSource)}` : ""}` : "尚未确认"}</p>
        {profiles.map((profile) => <div className="environment-profile" key={profile.name}>
          <div><strong>{profile.name}</strong><span>{profile.brand === "feishu" ? "飞书" : "Lark"} · {profile.appId} · {profile.user ?? "用户未知"} · {profileTokenLabel(profile.tokenStatus)}</span></div>
          <div>{profile.effective && <StatusBadge tone="success">生效中</StatusBadge>}{profile.active && <StatusBadge tone="info">已选择</StatusBadge>}{!profile.active && <Button size="sm" disabled={busy} onClick={() => void act({ type: "profileUse", name: profile.name })}>设为当前</Button>}</div>
        </div>)}
        {!profiles.length && <p>尚未添加账号配置。</p>}
        <div className="environment-profile-choice"><Button size="sm" onClick={() => setProfileMode(profileMode === "add" ? null : "add")}>添加已有应用</Button><Button size="sm" onClick={() => setProfileMode(profileMode === "create" ? null : "create")}>创建新应用</Button></div>
        {profileMode && <form className="environment-form" onSubmit={(event) => { event.preventDefault(); if (profileMode === "add") void saveProfile(); else void act({ type: "profileInit", name: name.trim() }).then((started) => { if (started) { setName(""); setProfileMode(null); setProfilesOpen(false); } }); }}>
          <label data-search-title="账号配置名称">账号配置名称<input value={name} maxLength={128} required onChange={(event) => setName(event.target.value)} /></label>
          {profileMode === "add" && <><label data-search-title="App ID">App ID<input value={appId} maxLength={256} required onChange={(event) => setAppId(event.target.value)} /></label><label data-search-title="App Secret">App Secret<input type="password" value={appSecret} maxLength={512} required onChange={(event) => setAppSecret(event.target.value)} /></label><div className="environment-form-field" data-search-title="平台"><span>平台</span><SettingChoices segmented label="平台" value={brand} onChange={setBrand} choices={[{value: "feishu", label: "飞书"}, {value: "lark", label: "Lark"}]}/></div><label data-search-title="添加后设为当前" className="environment-checkbox"><input type="checkbox" checked={useProfile} onChange={(event) => setUseProfile(event.target.checked)} />添加后设为当前</label></>}
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || (profileMode === "add" && (!appId.trim() || !appSecret))}>{profileMode === "add" ? "添加账号配置" : "创建并授权"}</Button>
        </form>}
      </div>
    </Dialog>
  </section>;
}

function DependencyGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="environment-dependency"><header><h3>{title}</h3>{description && <p>{description}</p>}</header><div className="environment-tool-list">{children}</div></section>;
}

type BackendActionsProps = {
  busy: boolean;
  onInstall: (backend: BackendEntry, update: boolean) => void;
  onCheckVersion: (backend: BackendEntry) => void;
  onUninstall: (backend: BackendEntry) => void;
};

function BackendActions({ backend, actions }: { backend: BackendEntry; actions: BackendActionsProps }) {
  return <div className="environment-actions">
    {backend.installable && <Button size="sm" disabled={actions.busy} onClick={() => actions.onInstall(backend, false)}>安装</Button>}
    {backend.installedVersion && backend.depKind === "npm-ondemand" && <Button size="sm" disabled={actions.busy} onClick={() => actions.onCheckVersion(backend)}>检查版本</Button>}
    {backend.installedVersion && backend.depKind === "npm-ondemand" && <Button size="sm" disabled={actions.busy} onClick={() => actions.onInstall(backend, true)}>更新</Button>}
    {backend.canUninstall && <Button size="sm" disabled={actions.busy} onClick={() => actions.onUninstall(backend)}>卸载</Button>}
  </div>;
}

const loginLabels: Record<BackendLogin["state"], string> = CONFIG_STATE;
const loginTones: Record<BackendLogin["state"], "success" | "warning" | "neutral"> = { signedIn: "success", signedOut: "warning", notRequired: "success", unknown: "neutral" };

function BackendRow({ backend, actions, login, onCheckLogin }: { backend: BackendEntry; actions: BackendActionsProps; login?: BackendLogin; onCheckLogin: () => void }) {
  const sdk = backend.id === "claude-agent" && backend.depKind === "npm-ondemand";
  const state = backendStateLabel(backend.depState);
  const checksLogin = sdk && backend.depState === "installed";
  return <article className="environment-backend" aria-label={`${sdk ? "Claude Agent SDK" : backend.displayName} 后端`}>
    <div>
      <strong>{sdk ? "Claude Agent SDK" : backend.displayName}</strong>
      <span>{state}{state === "状态未知" ? `（${backend.depState}）` : ""}{(backend.installedVersion ?? backend.version) && ` · ${backend.installedVersion ?? backend.version}`}</span>
      {sdk && <small>Claude 运行组件，需单独安装。</small>}
      {checksLogin && <details className="environment-login-details"><summary>Claude 配置：{login ? <StatusBadge tone={loginTones[login.state]}>{loginLabels[login.state]}</StatusBadge> : "正在检查…"}</summary><small>{login?.message}</small>{backend.hint && login?.state !== "signedIn" && <small>{backend.hint}</small>}</details>}
      {!checksLogin && backend.hint && <small>{backend.hint}</small>}
    </div>
    <div className="environment-actions">
      {checksLogin && <Button size="sm" disabled={actions.busy || !login} onClick={onCheckLogin}>{CHECK_CONFIG}</Button>}
      <BackendActions backend={backend} actions={actions} />
    </div>
  </article>;
}

function ToolRow({ tool, auth, hostBackend, backendActions, profiles, busy, running, onIntent, onCheckAuth, onLogin, onProgress, onManageProfiles, reveal }: {
  tool: EnvironmentToolState;
  auth?: Extract<EnvironmentReply, { kind: "auth" }>;
  hostBackend?: BackendEntry;
  backendActions?: BackendActionsProps;
  profiles: EnvironmentProfile[];
  busy: boolean;
  running: boolean;
  onIntent: (intent: Intent) => void;
  onCheckAuth: (tool: EnvironmentTool) => void;
  onLogin: () => void;
  onProgress: () => void;
  onManageProfiles?: () => void;
  reveal?: boolean;
}) {
  const where = useActiveDevice();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {if (reveal) setExpanded(true);}, [reveal]);
  const profile = profiles.find((item) => item.effective) ?? profiles.find((item) => item.active);
  const presentation = presentTool(tool, auth, tool.tool === "lark-cli" ? profile : undefined);
  const hostWarning = hostBackend && hostBackend.depState !== "ready" && hostBackend.depState !== "installed";
  const detailsId = `environment-details-${tool.tool}`;
  function primary() {
    if (running) { onProgress(); return; }
    if (presentation.action === "login") { onLogin(); return; }
    if (presentation.action === "install" || presentation.action === "update") onIntent({ kind: presentation.action, tool: tool.tool });
  }
  return <article className="environment-tool" id={settingAnchor(toolNames[tool.tool])} aria-label={`${toolNames[tool.tool]} ${where.isRemote ? `${whereName(where)}上的环境` : "本机环境"}`}>
    <div className="environment-tool-summary">
      <button type="button" className="environment-disclosure" aria-controls={detailsId} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <picture className="environment-brand">
          <img src={tool.tool === "codex" ? "./agent-icons/terminal.png" : tool.tool === "claude" ? "./agent-icons/code.png" : "./agent-icons/chat.png"} alt="" />
        </picture>
        <span className="environment-tool-copy"><strong>{toolNames[tool.tool]}</strong><small>{tool.compatibility?.status === 'tooOld' ? presentation.summary : `${tool.tool === 'lark-cli' ? '' : '命令行 · '}${tool.version ? `v${tool.version}` : tool.installation === 'missing' ? '未安装' : '版本未知'}`}</small>{hostWarning && <small className="environment-host-warning">后端：{backendStateLabel(hostBackend.depState)}{hostBackend.hint ? ` · ${hostBackend.hint}` : ""}</small>}</span>
        <StatusBadge tone={presentation.tone}>{presentation.status}</StatusBadge><ChevronDown className={expanded ? "environment-chevron environment-chevron-open" : "environment-chevron"} size={15} />
      </button>
      <div className="environment-primary">
        {running && <span className="environment-running">进行中</span>}
        {(running || presentation.action !== "none") && <Button size="sm" variant={presentation.action === "login" ? "primary" : "secondary"} disabled={busy && !running} onClick={primary}>{running ? "查看进度" : presentation.action === "install" ? "安装" : presentation.action === "update" ? tool.latestVersion ? `更新至 ${tool.latestVersion}` : "更新" : tool.tool === "lark-cli" && (profile?.tokenStatus === "needs_refresh" || profile?.tokenStatus === "expired") ? "刷新凭据" : "登录飞书"}</Button>}
        {onManageProfiles && tool.installation !== "missing" && <Button size="sm" aria-label="管理飞书 CLI" onClick={onManageProfiles}>管理账号</Button>}
      </div>
    </div>
    <div className="environment-details" id={detailsId} hidden={!expanded}>
      <dl><div><dt>安装来源</dt><dd>{tool.installation === "managed" ? "Vonvon 托管" : tool.installation === "external" ? "现有安装" : "未安装"}</dd></div><div><dt>安装位置</dt><dd>{tool.executable ? <code>{tool.executable}</code> : "暂无"}</dd></div><div><dt>当前版本</dt><dd>{tool.version ?? "未知"}</dd></div><div><dt>托管版本</dt><dd>{tool.managedVersion ?? "无"}</dd></div><div><dt>最新版本</dt><dd>{tool.latestVersion ?? "未取得"}</dd></div>{tool.compatibility && <><div><dt>最低版本</dt><dd>{tool.compatibility.minimum}</dd></div><div><dt>验证过的版本</dt><dd>{tool.compatibility.verified}</dd></div></>}<div><dt>授权状态</dt><dd>{auth?.message ?? "尚未确认"}</dd></div>{tool.tool === "lark-cli" && <div><dt>当前账号配置</dt><dd>{profile ? `${profile.name}${profile.effectiveSource ? ` · ${profileSourceLabel(profile.effectiveSource)}` : ""}` : "尚未确认"}</dd></div>}{hostBackend && <><div><dt>后端状态</dt><dd>{backendStateLabel(hostBackend.depState)}{backendStateLabel(hostBackend.depState) === "状态未知" ? `（${hostBackend.depState}）` : ""}</dd></div><div><dt>后端版本</dt><dd>{hostBackend.installedVersion ?? hostBackend.version ?? "未知"}</dd></div>{hostBackend.hint && <div className="environment-host-detail"><dt>后端说明</dt><dd>{hostBackend.hint}</dd></div>}</>}</dl>
      <div className="environment-secondary"><Button size="sm" disabled={busy || tool.installation === "missing"} onClick={() => onCheckAuth(tool.tool)}>检查授权</Button>{tool.installation !== "missing" && presentation.action !== "login" && <Button size="sm" disabled={busy} onClick={onLogin}>重新登录飞书</Button>}{tool.installation === "external" && <Button size="sm" disabled={busy} onClick={() => onIntent({ kind: "update", tool: tool.tool })}>安装托管副本</Button>}{tool.installation === "managed" && presentation.action !== "update" && <Button size="sm" disabled={busy} onClick={() => onIntent({ kind: "update", tool: tool.tool })}>重新安装最新版</Button>}{tool.canUninstall && <Button size="sm" disabled={busy} onClick={() => onIntent({ kind: "disable", tool: tool.tool })}>停用托管副本</Button>}</div>
      {hostBackend && backendActions && <BackendActions backend={hostBackend} actions={backendActions} />}
    </div>
  </article>;
}

function backendStateLabel(state: string): string {
  const labels: Record<string, string> = {
    installed: "已安装", "not-installed": "未安装", "external-missing": "外部依赖缺失", missing: "未安装", ready: "可用", unavailable: "不可用",
    error: "检测失败", unsupported: "不支持", available: "可安装",
  };
  return labels[state] ?? "状态未知";
}

function profileSourceLabel(source: string): string {
  if (source === "active" || source === "config") return "默认账号配置";
  if (source === "environment") return "环境变量";
  return "生效来源未知";
}

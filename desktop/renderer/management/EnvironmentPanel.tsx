import { useCallback, useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button, StatusBadge } from "../reference/components/ui";
import { ConfirmDialog, Dialog } from "../reference/components/ui/Dialog";
import { SettingsGroup } from "../reference/components/system-settings";
import { useDraft } from "../settings/DraftGuard";
import { presentTool, profileTokenLabel, toolNames } from "./environmentPresentation";
import type {
  BackendEntry, EnvironmentOperation, EnvironmentProfile, EnvironmentReply,
  EnvironmentRequest, EnvironmentTool, EnvironmentToolState, ToolInstallOperation,
} from "../../shared/environment";
import "./environment.css";

type Props = { request: (request: EnvironmentRequest) => Promise<EnvironmentReply>; onCodexLogin: () => Promise<void>; codexJobs: ReactNode; codexBusy: boolean };
type Intent = { kind: "install" | "update" | "disable"; tool: EnvironmentTool };
const order: EnvironmentTool[] = ["codex", "claude", "lark-cli"];

export function EnvironmentPanel({ request, onCodexLogin, codexJobs, codexBusy }: Props) {
  const [tools, setTools] = useState<EnvironmentToolState[]>([]);
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [backends, setBackends] = useState<BackendEntry[]>([]);
  const [auth, setAuth] = useState<Partial<Record<EnvironmentTool, Extract<EnvironmentReply, { kind: "auth" }>>>>({});
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

  const refresh = useCallback(async () => {
    const replies = await Promise.allSettled([
      request({ type: "scan" }), request({ type: "profileList" }),
      request({ type: "backendCatalog" }), request({ type: "profileInitStatus" }),
      request({ type: "toolInstallStatus" }),
    ]);
    for (const result of replies) {
      if (result.status === "rejected") { setNotice("暂时无法读取本机环境，请重试。"); continue; }
      const reply = result.value;
      if (reply.kind === "tools") setTools(reply.tools);
      if (reply.kind === "profiles") setProfiles(reply.profiles);
      if (reply.kind === "backends") setBackends(reply.entries);
      if (reply.kind === "operation") setOperation(reply.operation);
      if (reply.kind === "toolInstall") {
        setToolInstall(reply.operation);
        if (reply.operation?.kind === "running") setProgressOpen(true);
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
        if (result.value.kind === "toolInstall") setToolInstall(result.value.operation);
        if (result.value.kind === "operation") setOperation(result.value.operation);
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
    const installed = tools.filter((tool) => tool.installation !== "missing");
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
  useEffect(() => {
    if (operation?.kind !== "running" || !operation.url) { setQr(""); return; }
    let live = true;
    void QRCode.toDataURL(operation.url, { margin: 1, width: 190 }).then((image) => { if (live) setQr(image); }).catch(() => { if (live) setQr(""); });
    return () => { live = false; };
  }, [operation?.kind === "running" ? operation.id : undefined, operation?.kind === "running" ? operation.url : undefined]);

  async function act(next: EnvironmentRequest): Promise<boolean> {
    setBusy(true);
    setNotice(next.type === "backendInstall" ? next.update ? "正在更新后端，请稍候。" : "正在安装后端，请稍候。" : next.type === "backendUninstall" ? "正在卸载后端，请稍候。" : "");
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
  useDraft(Boolean(name || appId || appSecret || useProfile || brand !== "feishu"), { title: "飞书 CLI Profile", save: saveProfile, discard: discardProfile });
  const running = toolInstall?.kind === "running" ? toolInstall : null;
  const activeProfile = profiles.find((profile) => profile.effective) ?? profiles.find((profile) => profile.active);

  return <section className="environment-panel" aria-label="本机环境">
    <header className="environment-lead">
      <p>工具与飞书 CLI Profile 属于这台设备。Agent 和群配置在 Bridge 中单独管理。</p>
      <Button size="sm" icon={<RefreshCw size={15} />} disabled={busy} onClick={() => void refresh()}>重新检测</Button>
    </header>
    {notice && <p className="environment-notice" role="status">{notice}</p>}
    {running && !progressOpen && <div className="environment-notice" role="status">{toolNames[running.tool]} 正在{running.update ? "更新" : "安装"}。<Button size="sm" onClick={() => setProgressOpen(true)}>返回进度</Button></div>}
    <div className="environment-groups">
      <DependencyGroup title="Agent" badge="必需" description="Codex 或 Claude 至少需要一个可用，项目任务会在这台电脑的工作目录中执行。">
        {order.slice(0, 2).map((kind) => tools.find((item) => item.tool === kind)).filter((item): item is EnvironmentToolState => Boolean(item)).map((tool) => <ToolRow key={tool.tool} tool={tool} auth={auth[tool.tool]} profiles={profiles} busy={busy || Boolean(running) || (tool.tool === "codex" && codexBusy)} running={running?.tool === tool.tool} onIntent={setIntent} onCheckAuth={checkAuth} onLogin={() => { if (tool.tool === "codex") void onCodexLogin(); else void act({ type: "startLogin", tool: tool.tool }); }} onProgress={() => setProgressOpen(true)} />)}
      </DependencyGroup>
      <DependencyGroup title="飞书 CLI" badge="强烈推荐" description="让 Agent 处理云文档与群聊任务。安装后设置 Profile 并完成登录。">
        {tools.filter((tool) => tool.tool === "lark-cli").map((tool) => <ToolRow key={tool.tool} tool={tool} auth={auth[tool.tool]} profiles={profiles} busy={busy || Boolean(running)} running={running?.tool === tool.tool} onIntent={setIntent} onCheckAuth={checkAuth} onLogin={() => void act({ type: "startLogin", tool: tool.tool })} onProgress={() => setProgressOpen(true)} onManageProfiles={() => setProfilesOpen(true)} />)}
      </DependencyGroup>
    </div>
    {!tools.length && <p className="environment-empty">正在检测本机工具…</p>}
    {codexJobs}
    <SettingsGroup label="执行后端">
      <p className="environment-group-note">执行后端依赖与 Claude Code CLI 是不同的软件。只有 Bridge 托管的后端可卸载。</p>
      {backends.map((backend) => <div key={backend.id} className="environment-backend">
        <div><strong>{backend.displayName}</strong><span>{backendStateLabel(backend.depState)} · {backend.installedVersion ?? backend.version ?? "版本未知"}</span>{backend.hint && <small>{backend.hint}</small>}</div>
        <div className="environment-actions">
          {backend.installable && <Button size="sm" disabled={busy} onClick={() => void act({ type: "backendInstall", id: backend.id, update: false })}>安装</Button>}
          {backend.installedVersion && backend.depKind === "npm-ondemand" && <Button size="sm" disabled={busy} onClick={() => void request({ type: "backendVersion", id: backend.id }).then((reply) => { if (reply.kind === "backendVersion") setNotice(reply.latest ? `已安装 ${reply.installed ?? "未知"}，最新 ${reply.latest}` : "暂时无法查询最新版本。"); else if (reply.kind === "refused") setNotice(reply.message); }).catch(() => setNotice("暂时无法查询最新版本。"))}>检查版本</Button>}
          {backend.installedVersion && backend.depKind === "npm-ondemand" && <Button size="sm" disabled={busy} onClick={() => void act({ type: "backendInstall", id: backend.id, update: true })}>更新</Button>}
          {backend.canUninstall && <Button size="sm" disabled={busy} onClick={() => setBackendDisable(backend)}>卸载</Button>}
        </div>
      </div>)}
    </SettingsGroup>
    {operation && <section className="environment-login-operation" role="status">
      <strong>{operation.kind === "running" ? operation.purpose.kind === "login" ? `${toolNames[operation.purpose.tool]} 等待授权` : "等待创建应用" : operation.message}</strong>
      {operation.kind === "running" && <div className="environment-verification">
        {operation.url && <><Button size="sm" onClick={() => void act({ type: "openVerification", operationId: operation.id })}>打开官方验证链接</Button><input readOnly aria-label="授权链接" value={operation.url} />{qr && <img src={qr} alt="授权二维码" width={190} height={190} />}</>}
        <Button size="sm" onClick={() => void act({ type: operation.purpose.kind === "login" ? "cancelLogin" : "profileInitCancel", operationId: operation.id })}>取消</Button>
      </div>}
    </section>}
    <Dialog open={progressOpen} onClose={() => setProgressOpen(false)} title="本机工具进度" description="关闭窗口后，任务仍会在后台继续。" size="sm">
      {!toolInstall && <div className="environment-progress" role="status"><strong>正在启动本机工具任务…</strong><Button onClick={() => setProgressOpen(false)}>后台继续</Button></div>}
      {toolInstall && <div className="environment-progress" role="status">
        <strong>{toolInstall.kind === "running" ? `${toolNames[toolInstall.tool]} 正在${toolInstall.update ? "更新" : "安装"}` : toolInstall.message}</strong>
        {toolInstall.kind === "running" && <><p>已运行 {Math.max(0, Math.floor((now - toolInstall.startedAt) / 1000))} 秒</p><Button disabled={cancelling} onClick={() => void cancelInstall(toolInstall.id)}>{cancelling ? "正在取消" : "取消任务"}</Button></>}
        <Button onClick={() => setProgressOpen(false)}>{toolInstall.kind === "running" ? "后台继续" : "完成"}</Button>
      </div>}
    </Dialog>
    <ConfirmDialog open={Boolean(backendDisable)} title={backendDisable ? `卸载 ${backendDisable.displayName}` : "卸载后端"} description="仅卸载 Bridge 托管的后端依赖。" confirmLabel="卸载后端" tone="danger" onCancel={() => setBackendDisable(null)} onConfirm={() => { const selected = backendDisable; setBackendDisable(null); if (selected) void act({ type: "backendUninstall", id: selected.id }); }} />
    <ConfirmDialog open={Boolean(intent)} title={intent ? `${intent.kind === "disable" ? "停用" : intent.kind === "update" ? "更新" : "安装"} ${toolNames[intent.tool]}` : "确认操作"} description={intent?.kind === "disable" ? "只停用 Bridge 托管副本。其他已安装的工具不会被删除。" : intent?.kind === "update" ? "Bridge 将安装并验证新版本，然后切换到托管副本。" : "Bridge 将在本机安装并验证托管副本。"} confirmLabel={intent?.kind === "disable" ? "停用托管副本" : intent?.kind === "update" ? "开始更新" : "开始安装"} tone={intent?.kind === "disable" ? "danger" : "primary"} onCancel={() => setIntent(null)} onConfirm={() => void confirm()} />
    <Dialog open={profilesOpen} onClose={() => setProfilesOpen(false)} size="md" title="管理飞书 CLI" description="添加应用、切换 Profile，并查看当前生效的身份。">
      <div className="environment-profiles">
        {notice && <p className="environment-notice" role="status">{notice}</p>}
        <p>当前生效：{activeProfile ? `${activeProfile.name} · ${activeProfile.appId}${activeProfile.effectiveSource ? ` · ${profileSourceLabel(activeProfile.effectiveSource)}` : ""}` : "尚未确认"}</p>
        {profiles.map((profile) => <div className="environment-profile" key={profile.name}>
          <div><strong>{profile.name}</strong><span>{profile.brand === "feishu" ? "飞书" : "Lark"} · {profile.appId} · {profile.user ?? "用户未知"} · {profileTokenLabel(profile.tokenStatus)}</span></div>
          <div>{profile.effective && <StatusBadge tone="success">生效中</StatusBadge>}{profile.active && <StatusBadge tone="info">已选择</StatusBadge>}{!profile.active && <Button size="sm" disabled={busy} onClick={() => void act({ type: "profileUse", name: profile.name })}>设为当前</Button>}</div>
        </div>)}
        {!profiles.length && <p>还没有 Profile，请先添加或创建应用。</p>}
        <div className="environment-profile-choice"><Button size="sm" onClick={() => setProfileMode(profileMode === "add" ? null : "add")}>添加已有应用</Button><Button size="sm" onClick={() => setProfileMode(profileMode === "create" ? null : "create")}>创建新应用</Button></div>
        {profileMode && <form className="environment-form" onSubmit={(event) => { event.preventDefault(); if (profileMode === "add") void saveProfile(); else void act({ type: "profileInit", name: name.trim() }).then((started) => { if (started) { setName(""); setProfileMode(null); setProfilesOpen(false); } }); }}>
          <label>Profile 名称<input value={name} maxLength={128} required onChange={(event) => setName(event.target.value)} /></label>
          {profileMode === "add" && <><label>App ID<input value={appId} maxLength={256} required onChange={(event) => setAppId(event.target.value)} /></label><label>App Secret<input type="password" value={appSecret} maxLength={512} required onChange={(event) => setAppSecret(event.target.value)} /></label><label>平台<select value={brand} onChange={(event) => setBrand(event.target.value === "lark" ? "lark" : "feishu")}><option value="feishu">飞书</option><option value="lark">Lark</option></select></label><label className="environment-checkbox"><input type="checkbox" checked={useProfile} onChange={(event) => setUseProfile(event.target.checked)} />添加后设为当前</label></>}
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || (profileMode === "add" && (!appId.trim() || !appSecret))}>{profileMode === "add" ? "添加 Profile" : "创建并授权"}</Button>
        </form>}
      </div>
    </Dialog>
  </section>;
}

function DependencyGroup({ title, badge, description, children }: { title: string; badge: string; description: string; children: ReactNode }) {
  return <section className="environment-dependency"><header><div><h3>{title}</h3><span>{badge}</span></div><p>{description}</p></header><div className="environment-tool-list">{children}</div></section>;
}

function ToolRow({ tool, auth, profiles, busy, running, onIntent, onCheckAuth, onLogin, onProgress, onManageProfiles }: {
  tool: EnvironmentToolState;
  auth?: Extract<EnvironmentReply, { kind: "auth" }>;
  profiles: EnvironmentProfile[];
  busy: boolean;
  running: boolean;
  onIntent: (intent: Intent) => void;
  onCheckAuth: (tool: EnvironmentTool) => void;
  onLogin: () => void;
  onProgress: () => void;
  onManageProfiles?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const profile = profiles.find((item) => item.effective) ?? profiles.find((item) => item.active);
  const presentation = presentTool(tool, auth, tool.tool === "lark-cli" ? profile : undefined);
  const detailsId = `environment-details-${tool.tool}`;
  function primary() {
    if (running) { onProgress(); return; }
    if (presentation.action === "login") { onLogin(); return; }
    if (presentation.action === "install" || presentation.action === "update") onIntent({ kind: presentation.action, tool: tool.tool });
  }
  return <article className="environment-tool" aria-label={`${toolNames[tool.tool]} 本机环境`}>
    <div className="environment-tool-summary">
      <button type="button" className="environment-disclosure" aria-controls={detailsId} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <picture className="environment-brand">
          {tool.tool === "codex" && <source media="(prefers-color-scheme: dark)" srcSet="./agent-icons/codex-dark.png" />}
          <img src={tool.tool === "codex" ? "./agent-icons/codex-light.png" : tool.tool === "claude" ? "./agent-icons/claude-code.svg" : "./agent-icons/feishu.png"} alt="" />
        </picture>
        <span className="environment-tool-copy"><strong>{toolNames[tool.tool]}</strong><small>{presentation.summary}</small></span>
        <StatusBadge tone={running ? "info" : presentation.tone}>{running ? "进行中" : presentation.status}</StatusBadge><ChevronDown className={expanded ? "environment-chevron environment-chevron-open" : "environment-chevron"} size={15} />
      </button>
      <div className="environment-primary">
        {(running || presentation.action !== "none") && <Button size="sm" variant={presentation.action === "login" ? "primary" : "secondary"} disabled={busy && !running} onClick={primary}>{running ? "查看进度" : presentation.action === "install" ? "安装" : presentation.action === "update" ? "更新" : tool.tool === "lark-cli" && (profile?.tokenStatus === "needs_refresh" || profile?.tokenStatus === "expired") ? "刷新凭据" : "登录"}</Button>}
        {onManageProfiles && tool.installation !== "missing" && <Button size="sm" aria-label="管理飞书 CLI" onClick={onManageProfiles}>管理…</Button>}
      </div>
    </div>
    <div className="environment-details" id={detailsId} hidden={!expanded}>
      <dl><div><dt>安装来源</dt><dd>{tool.installation === "managed" ? "Bridge 托管" : tool.installation === "external" ? "现有安装" : "未安装"}</dd></div><div><dt>安装位置</dt><dd>{tool.executable ? <code>{tool.executable}</code> : "暂无"}</dd></div><div><dt>当前版本</dt><dd>{tool.version ?? "未知"}</dd></div><div><dt>托管版本</dt><dd>{tool.managedVersion ?? "无"}</dd></div><div><dt>最新版本</dt><dd>{tool.latestVersion ?? "未取得"}</dd></div><div><dt>授权状态</dt><dd>{auth?.message ?? "尚未确认"}</dd></div>{tool.tool === "lark-cli" && <div><dt>当前 Profile</dt><dd>{profile ? `${profile.name}${profile.effectiveSource ? ` · ${profileSourceLabel(profile.effectiveSource)}` : ""}` : "尚未确认"}</dd></div>}</dl>
      <div className="environment-secondary"><Button size="sm" disabled={busy || tool.installation === "missing"} onClick={() => onCheckAuth(tool.tool)}>检查授权</Button>{tool.installation !== "missing" && presentation.action !== "login" && <Button size="sm" disabled={busy} onClick={onLogin}>重新登录</Button>}{tool.installation === "external" && <Button size="sm" disabled={busy} onClick={() => onIntent({ kind: "update", tool: tool.tool })}>安装托管副本</Button>}{tool.installation === "managed" && presentation.action !== "update" && <Button size="sm" disabled={busy} onClick={() => onIntent({ kind: "update", tool: tool.tool })}>重新安装最新版</Button>}{tool.canUninstall && <Button size="sm" disabled={busy} onClick={() => onIntent({ kind: "disable", tool: tool.tool })}>停用托管副本</Button>}</div>
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
  if (source === "active" || source === "config") return "默认 Profile";
  if (source === "environment") return "环境变量";
  return "生效来源未知";
}

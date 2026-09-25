import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { Button } from "../reference/components/ui";
import { SettingsGroup } from "../reference/components/system-settings";
import "./environment.css";
import {useDraft} from "../settings/DraftGuard";
import type {
  BackendEntry,
  EnvironmentOperation,
  ToolInstallOperation,
  EnvironmentProfile,
  EnvironmentReply,
  EnvironmentRequest,
  EnvironmentTool,
  EnvironmentToolState,
} from "../../shared/environment";

type Props = { request: (request: EnvironmentRequest) => Promise<EnvironmentReply>; onCodexLogin: () => Promise<void>; codexJobs: ReactNode; codexBusy: boolean };
const labels: Record<EnvironmentTool, string> = {
  codex: "Codex CLI",
  claude: "Claude Code CLI",
  "lark-cli": "飞书 CLI",
};

export function EnvironmentPanel({ request, onCodexLogin, codexJobs, codexBusy }: Props) {
  const [tools, setTools] = useState<EnvironmentToolState[]>([]);
  const [profiles, setProfiles] = useState<EnvironmentProfile[]>([]);
  const [backends, setBackends] = useState<BackendEntry[]>([]);
  const [operation, setOperation] = useState<EnvironmentOperation | null>(null);
  const [toolInstall, setToolInstall] = useState<ToolInstallOperation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [brand, setBrand] = useState<"feishu" | "lark">("feishu");
  const [useProfile, setUseProfile] = useState(false);
  const [qr, setQr] = useState("");

  async function refresh() {
    const [toolReply, profileReply, backendReply, operationReply] = await Promise.all([request({ type: "scan" }), request({ type: "profileList" }), request({ type: "backendCatalog" }), request({ type: "profileInitStatus" })]);
    if (toolReply.kind === "tools") setTools(toolReply.tools);
    if (profileReply.kind === "profiles") setProfiles(profileReply.profiles);
    else if (profileReply.kind === "refused" && profileReply.code !== "tool-missing") setNotice(profileReply.message);
    if (backendReply.kind === "backends") setBackends(backendReply.entries);
    if (operationReply.kind === "operation") setOperation(operationReply.operation);
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const reply = await request({type: 'toolInstallStatus'});
        if (active && reply.kind === 'toolInstall') setToolInstall(reply.operation);
      } catch {if (active) setNotice('暂时无法读取安装进度，正在重试。');}
      if (active) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => {active = false; clearTimeout(timer);};
  }, [request]);
  useEffect(() => {
    if (toolInstall && toolInstall.kind !== 'running') void refresh();
  }, [toolInstall?.id, toolInstall?.kind]);
  async function cancelInstall(id: string) {
    setCancelling(true);
    try {
      const reply = await request({type: 'cancelInstall', operationId: id});
      if (reply.kind === 'toolInstall') setToolInstall(reply.operation);
      if (reply.kind === 'refused') setNotice(reply.message);
    } catch (error) {setNotice(error instanceof Error ? error.message : '无法取消安装。');}
    finally {setCancelling(false);}
  }
  useEffect(() => {
    if (operation?.kind !== "running") return;
    const timer = setInterval(() => {
      void request({ type: "profileInitStatus" }).then((reply) => {
        if (reply.kind === "operation") setOperation(reply.operation);
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [operation?.kind, operation?.id, request]);
  useEffect(() => {
    if (operation?.kind !== "running" || !operation.url) { setQr(""); return; }
    let live = true;
    void QRCode.toDataURL(operation.url, { margin: 1, width: 210 }).then((image) => { if (live) setQr(image); });
    return () => { live = false; };
  }, [operation?.kind, operation?.kind === "running" ? operation.url : undefined]);

  async function act(next: EnvironmentRequest) {
    setBusy(true);
    const actionName = next.type === 'install' || next.type === 'backendInstall' ? '安装' : next.type === 'update' ? '更新' : next.type === 'uninstall' || next.type === 'backendUninstall' ? '卸载' : '处理';
    setNotice(`正在${actionName}，请稍候。`);
    try {
      const reply = await request(next);
      if (reply.kind === "refused" || reply.kind === "applied") setNotice(reply.message);
      if (reply.kind === "profiles") setProfiles(reply.profiles);
      if (reply.kind === "operation") setOperation(reply.operation);
      if (["install", "update", "uninstall", "backendInstall", "backendUninstall", "profileAdd", "profileUse"].includes(next.type)) await refresh();
      return reply.kind !== "refused";
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败。"); return false; }
    finally { setBusy(false); }
  }

  function discardProfile() {setName(''); setAppId(''); setAppSecret(''); setBrand('feishu'); setUseProfile(false);}
  async function saveProfile() {
    if (busy || !name.trim() || !appId.trim() || !appSecret) return false;
    const saved = await act({type: 'profileAdd', name: name.trim(), appId: appId.trim(), appSecret, brand, use: useProfile});
    if (saved) discardProfile();
    return saved;
  }
  useDraft(Boolean(name || appId || appSecret || useProfile || brand !== 'feishu'), {title: '飞书 CLI Profile', save: saveProfile, discard: discardProfile});
  return <div className="environment-panel">
    <h2>本机环境</h2>
    <p>工具与飞书 CLI Profile 属于这台设备。Agent 和群配置在 Bridge 中单独管理。</p>
    {notice && <p role="status">{notice}</p>}
    <Button type="button" disabled={busy} onClick={() => void refresh()}>重新检测</Button>
    <SettingsGroup label="执行工具">
      {tools.map((tool) => <ToolRow key={tool.tool} tool={tool} busy={busy || toolInstall?.kind === 'running' || (tool.tool === "codex" && codexBusy)} act={act} request={request} onCodexLogin={onCodexLogin} />)}
    </SettingsGroup>
    {toolInstall && <div role="status" className="environment-operation">
      <p>{toolInstall.kind === 'running' ? `${labels[toolInstall.tool]} 正在${toolInstall.update ? '更新' : '安装'}` : toolInstall.message}</p>
      {toolInstall.kind === 'running' && <Button disabled={cancelling} onClick={() => void cancelInstall(toolInstall.id)}>{cancelling ? '正在取消' : '取消安装'}</Button>}
    </div>}
    {codexJobs}
    <SettingsGroup label="执行后端">
      <p>后端依赖与 Claude Code CLI 是不同的软件。只有由 Bridge 托管的后端可卸载。</p>
      {backends.map((backend) => <div key={backend.id} className="environment-row">
        <strong>{backend.displayName}</strong>
        <span>{backend.depState} · {backend.version ?? backend.installedVersion ?? "版本未知"}</span>
        {backend.hint && <span>{backend.hint}</span>}
        {backend.installable && <Button type="button" disabled={busy} onClick={() => void act({ type: "backendInstall", id: backend.id, update: false })}>安装</Button>}
        {backend.installedVersion && backend.depKind === "npm-ondemand" && <Button type="button" disabled={busy} onClick={() => void request({ type: "backendVersion", id: backend.id }).then((reply) => { if (reply.kind === "backendVersion") setNotice(reply.latest ? `已安装 ${reply.installed ?? "未知"}，最新 ${reply.latest}` : "暂时无法查询最新版本。"); })}>检查版本</Button>}
        {backend.installedVersion && backend.depKind === "npm-ondemand" && <Button type="button" disabled={busy} onClick={() => void act({ type: "backendInstall", id: backend.id, update: true })}>更新</Button>}
        {backend.canUninstall && <Button type="button" disabled={busy} onClick={() => void act({ type: "backendUninstall", id: backend.id })}>卸载</Button>}
      </div>)}
    </SettingsGroup>
    {operation && <div role="status" className="environment-operation">
      <p>{operation.kind === "running" ? operation.purpose.kind === "login" ? `${labels[operation.purpose.tool]} 等待授权` : "等待创建应用" : operation.message}</p>
      {operation.kind === "running" && <>
        {operation.url && <><Button type="button" onClick={() => void act({ type: "openVerification", operationId: operation.id })}>打开授权链接</Button><input readOnly aria-label="授权链接" value={operation.url} />{qr && <img src={qr} alt="授权二维码" width={210} height={210} />}</>}
        <Button type="button" onClick={() => void act({ type: operation.purpose.kind === "login" ? "cancelLogin" : "profileInitCancel", operationId: operation.id })}>取消</Button>
      </>}
      {operation.kind === "succeeded" && <Button type="button" onClick={() => void refresh()}>重新检测</Button>}
    </div>}
    <SettingsGroup label="飞书 CLI Profile">
      <p>切换 Profile 会影响飞书 CLI 的登录和 API 调用，不会改变已注册 Agent。</p>
      {profiles.map((profile) => <div key={profile.name} className="environment-row">
        <strong>{profile.name}{profile.effective ? " · 生效中" : profile.active ? " · 默认" : ""}</strong>
        <span>{profile.brand} · {profile.appId} · {profile.user ?? "未登录"} · {profile.tokenStatus ?? "状态未知"}</span>
        {!profile.active && <Button type="button" disabled={busy} onClick={() => void act({ type: "profileUse", name: profile.name })}>设为当前</Button>}
      </div>)}
      <h4>添加已有应用</h4>
      <div className="environment-form">
        <label>名称<input value={name} maxLength={128} onChange={(event) => setName(event.target.value)} /></label>
        <label>App ID<input value={appId} maxLength={256} onChange={(event) => setAppId(event.target.value)} /></label>
        <label>App Secret<input type="password" value={appSecret} maxLength={512} onChange={(event) => setAppSecret(event.target.value)} /></label>
        <label>平台<select value={brand} onChange={(event) => setBrand(event.target.value === "lark" ? "lark" : "feishu")}><option value="feishu">飞书</option><option value="lark">Lark</option></select></label>
        <label><input type="checkbox" checked={useProfile} onChange={(event) => setUseProfile(event.target.checked)} />添加后设为当前</label>
        <Button type="button" disabled={busy || !name.trim() || !appId.trim() || !appSecret} onClick={() => void saveProfile()}>添加 Profile</Button>
      </div>
      <h4>创建新应用 Profile</h4>
      <Button type="button" disabled={busy || !name.trim() || operation?.kind === "running"} onClick={() => void act({ type: "profileInit", name: name.trim() })}>创建并授权</Button>
    </SettingsGroup>
  </div>;
}

function ToolRow({ tool, busy, act, request, onCodexLogin }: {
  tool: EnvironmentToolState;
  busy: boolean;
  act: (next: EnvironmentRequest) => Promise<boolean>;
  request: Props["request"];
  onCodexLogin: Props["onCodexLogin"];
}) {
  const [auth, setAuth] = useState<Extract<EnvironmentReply, { kind: "auth" }> | null>(null);
  async function checkAuth() {
    const reply = await request({ type: "authStatus", tool: tool.tool });
    if (reply.kind === "auth") setAuth(reply);
  }
  useEffect(() => {
    if (tool.installation === "missing") { setAuth(null); return; }
    let live = true;
    void request({ type: "authStatus", tool: tool.tool }).then(reply => { if (live && reply.kind === "auth") setAuth(reply); });
    return () => { live = false; };
  }, [tool, request, busy]);
  return <div className="environment-row">
    <strong>{labels[tool.tool]}</strong>
    <span>{tool.installation === "missing" ? "未安装" : tool.installation === "managed" ? "Vonvon Bridge 托管" : "现有安装"} · {tool.version ?? "版本未知"}</span>
    {tool.latestVersion && <span>最新 {tool.latestVersion}</span>}
    {tool.installation === "missing" && <Button type="button" disabled={busy} onClick={() => void act({ type: "install", tool: tool.tool })}>安装</Button>}
    {tool.installation !== "missing" && <Button type="button" disabled={busy} onClick={() => void checkAuth()}>检查授权</Button>}
    {auth && <span>{auth.message}</span>}
    {tool.installation !== "missing" && auth?.state === "signedOut" && <Button type="button" disabled={busy} onClick={() => {if (tool.tool === "codex") void onCodexLogin(); else void act({ type: "startLogin", tool: tool.tool });}}>授权</Button>}
    {tool.installation === "external" && <Button type="button" disabled={busy} onClick={() => void act({ type: "update", tool: tool.tool })}>安装新版托管副本</Button>}
    {tool.installation === "managed" && <Button type="button" disabled={busy} onClick={() => void act({ type: "update", tool: tool.tool })}>更新</Button>}
    {tool.canUninstall && <Button type="button" disabled={busy} onClick={() => void act({ type: "uninstall", tool: tool.tool })}>卸载托管副本</Button>}
  </div>;
}

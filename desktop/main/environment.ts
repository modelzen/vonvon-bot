import { z } from "zod";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import {
  backendEntrySchema,
  environmentProfileSchema,
  type EnvironmentOperation,
  type EnvironmentReply,
  type EnvironmentRequest,
  type EnvironmentTool,
  type EnvironmentToolState,
} from "../shared/environment";

const tools = {
  codex: { executable: "codex", package: "@openai/codex" },
  claude: { executable: "claude", package: "@anthropic-ai/claude-code" },
  "lark-cli": { executable: "lark-cli", package: "@larksuite/cli" },
} satisfies Record<EnvironmentTool, { executable: string; package: string }>;
const kinds: EnvironmentTool[] = ["codex", "claude", "lark-cli"];
const allowedHosts = new Set([
  "accounts.feishu.cn", "accounts.larksuite.com", "open.feishu.cn",
  "open.larksuite.com", "auth.openai.com", "chatgpt.com",
  "claude.ai", "console.anthropic.com", "platform.claude.com",
]);
const outputLimit = 64 * 1024;

export type EnvironmentServiceOptions = {
  home: string;
  getDataRoot: () => string;
  resolveCodex: () => string | null;
  nodePath: string;
  npmPath?: string;
  path?: string;
  spawnProcess?: typeof spawn;
  fetchLatest?: (name: string) => Promise<string | null>;
  hostRequest?: (path: string, init?: RequestInit) => Promise<Response>;
  openExternal?: (url: string) => Promise<void>;
};

type ActiveOperation = {
  snapshot: EnvironmentOperation;
  child: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  output: string;
};

export class EnvironmentService {
  private readonly home: string;
  private readonly getDataRoot: () => string;
  private readonly resolveCodex: () => string | null;
  private readonly nodePath: string;
  private readonly npmPath?: string;
  private readonly searchPath: string;
  private readonly spawnProcess: typeof spawn;
  private readonly fetchLatest: (name: string) => Promise<string | null>;
  private readonly hostRequest?: (path: string, init?: RequestInit) => Promise<Response>;
  private readonly openExternal?: (url: string) => Promise<void>;
  private active?: ActiveOperation;
  private lastOperation: EnvironmentOperation | null = null;
  private mutation = false;

  constructor(options: EnvironmentServiceOptions) {
    if (!isAbsolute(options.home) || !isAbsolute(options.nodePath)) throw new Error("Absolute home and Node paths required.");
    this.home = options.home;
    this.getDataRoot = options.getDataRoot;
    this.resolveCodex = options.resolveCodex;
    this.nodePath = options.nodePath;
    this.npmPath = options.npmPath;
    this.searchPath = options.path ?? process.env.PATH ?? "";
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.fetchLatest = options.fetchLatest ?? latestVersion;
    this.hostRequest = options.hostRequest;
    this.openExternal = options.openExternal;
  }

  async run(request: EnvironmentRequest): Promise<EnvironmentReply> {
    try {
      switch (request.type) {
        case "scan": return { kind: "tools", tools: await Promise.all(kinds.map((tool) => this.inspect(tool))) };
        case "backendCatalog": return await this.backendCatalog();
        case "backendVersion": return await this.backendVersion(request.id);
        case "backendInstall": return await this.backendInstall(request.id, request.update);
        case "backendUninstall": return await this.backendUninstall(request.id);
        case "install": return await this.install(request.tool, false);
        case "update": return await this.install(request.tool, true);
        case "uninstall": return await this.uninstall(request.tool);
        case "authStatus": return await this.authStatus(request.tool);
        case "startLogin": return await this.startLogin(request.tool);
        case "loginStatus": return { kind: "operation", operation: this.lastOperation };
        case "openVerification": return await this.openVerification(request.operationId);
        case "cancelLogin": return this.cancel(request.operationId);
        case "profileList": return await this.profileList();
        case "profileUse": return await this.profileUse(request.name);
        case "profileAdd": return await this.profileAdd(request);
        case "profileInit": return await this.profileInit(request.name);
        case "profileInitStatus": return { kind: "operation", operation: this.lastOperation };
        case "profileInitCancel": return this.cancel(request.operationId);
        default: {
          const exhaustive: never = request;
          return exhaustive;
        }
      }
    } catch {
      return { kind: "refused", code: "environment-failed", message: "本机环境操作失败，请重试。" };
    }
  }

  private managedRoot(): string { return join(this.getDataRoot(), "managed-tools"); }
  private managedExecutable(tool: EnvironmentTool): string {
    return join(this.managedRoot(), "bin", process.platform === "win32" ? `${tools[tool].executable}.cmd` : tools[tool].executable);
  }

  private async resolveTool(tool: EnvironmentTool): Promise<{ executable: string; ownership: "managed" | "external" } | null> {
    const managed = this.managedExecutable(tool);
    if (tool === "codex") {
      const selected = this.resolveCodex();
      return selected ? { executable: selected, ownership: selected === managed ? "managed" : "external" } : null;
    }
    if (await executable(managed)) return { executable: managed, ownership: "managed" };
    const candidates = [dirname(this.nodePath), ...this.searchPath.split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    for (const directory of candidates) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(directory, tools[tool].executable);
      if (await executable(candidate)) return { executable: candidate, ownership: "external" };
    }
    return null;
  }

  private async inspect(tool: EnvironmentTool): Promise<EnvironmentToolState> {
    const resolved = await this.resolveTool(tool);
    const managedVersion = await this.managedVersion(tool);
    const result = resolved ? await this.command(resolved.executable, ["--version"], 5_000).catch(() => null) : null;
    const version = result?.exitCode === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null : null;
    const latest = await this.fetchLatest(tools[tool].package).catch(() => null);
    return {
      tool,
      installation: resolved?.ownership ?? "missing",
      executable: resolved?.executable ?? null,
      version,
      managedVersion,
      latestVersion: latest,
      updateAvailable: version && latest ? version !== latest : null,
      canUninstall: Boolean(managedVersion),
    };
  }

  private async managedVersion(tool: EnvironmentTool): Promise<string | null> {
    const file = join(this.managedRoot(), "lib", "node_modules", tools[tool].package, "package.json");
    try {
      const body: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof body !== "object" || body === null || !("name" in body) || !("version" in body)) return null;
      return body.name === tools[tool].package && typeof body.version === "string" && /^\d+\.\d+\.\d+/.test(body.version) ? body.version : null;
    } catch { return null; }
  }

  private async backendCatalog(): Promise<EnvironmentReply> {
    if (!this.hostRequest) return refused("host-unavailable", "Bridge 服务未连接。");
    const response = await this.hostRequest("/api/backends");
    if (!response.ok) return refused("backend-catalog-failed", "无法读取后端列表。");
    const payload: unknown = await response.json();
    const catalog = backendEntrySchema.array().max(64);
    if (typeof payload !== "object" || payload === null || !("entries" in payload)) return refused("invalid-catalog", "后端列表格式不正确。");
    const parsed = catalog.safeParse(payload.entries);
    return parsed.success ? { kind: "backends", entries: parsed.data } : refused("invalid-catalog", "后端列表格式不正确。");
  }

  private async backendEntry(id: string) {
    const catalog = await this.backendCatalog();
    return catalog.kind === "backends" ? catalog.entries.find((entry) => entry.id === id) : undefined;
  }

  private async backendVersion(id: string): Promise<EnvironmentReply> {
    if (!this.hostRequest || !await this.backendEntry(id)) return refused("backend-unavailable", "找不到这个后端。");
    const response = await this.hostRequest(`/api/backends/${id}/version`);
    if (!response.ok) return refused("version-failed", "无法检查后端版本。");
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("installed" in payload) || !("latest" in payload) || !("hasUpdate" in payload)) return refused("invalid-version", "版本信息格式不正确。");
    const installed = payload.installed;
    const latest = payload.latest;
    if ((installed !== null && typeof installed !== "string") || (latest !== null && typeof latest !== "string") || typeof payload.hasUpdate !== "boolean") return refused("invalid-version", "版本信息格式不正确。");
    return { kind: "backendVersion", id, installed, latest, hasUpdate: payload.hasUpdate };
  }

  private async backendInstall(id: string, update: boolean): Promise<EnvironmentReply> {
    if (!this.hostRequest) return refused("host-unavailable", "Bridge 服务未连接。");
    const entry = await this.backendEntry(id);
    if (!entry || entry.depKind !== "npm-ondemand" || (!update && !entry.installable) || (update && !entry.installedVersion)) return refused("backend-not-managed", "这个后端不能由 Bridge 安装或更新。");
    const endpoint = `/api/backends/${id}/${update ? "update" : "install"}`;
    const response = await this.hostRequest(endpoint, { method: "POST", signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) return refused("backend-install-failed", "后端安装未能启动。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let received = 0;
    let terminal: EnvironmentReply | null = null;
    try {
      while (received < 256 * 1024 && !terminal) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: unknown;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }
          if (typeof event !== "object" || event === null || !("type" in event)) continue;
          if (event.type === "done") terminal = { kind: "applied", message: `${entry.displayName} 已${update ? "更新" : "安装"}。` };
          if (event.type === "error") terminal = refused("backend-install-failed", "后端安装失败，请检查本机日志。");
        }
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return terminal ?? refused("backend-install-incomplete", "安装连接中断，请重新检查后端状态。");
  }

  private async backendUninstall(id: string): Promise<EnvironmentReply> {
    if (!this.hostRequest) return refused("host-unavailable", "Bridge 服务未连接。");
    const entry = await this.backendEntry(id);
    if (!entry?.canUninstall) return refused("backend-not-managed", "这个后端不是 Bridge 托管安装，不能卸载。");
    const response = await this.hostRequest(`/api/backends/${id}`, { method: "DELETE" });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || typeof payload !== "object" || payload === null || !("ok" in payload) || payload.ok !== true) return refused("backend-uninstall-failed", "后端卸载失败。");
    return { kind: "applied", message: `${entry.displayName} 已卸载。` };
  }

  private async install(tool: EnvironmentTool, update: boolean): Promise<EnvironmentReply> {
    if (this.mutation || this.active) return refused("busy", "另一个本机环境操作正在进行。");
    const npm = await this.resolveNpm();
    if (!npm) return refused("npm-missing", "未找到 npm，无法安装工具。");
    this.mutation = true;
    try {
      await mkdir(this.managedRoot(), { recursive: true });
      const result = await this.command(npm, ["install", "--global", "--prefix", this.managedRoot(), `${tools[tool].package}@latest`, "--no-audit", "--no-fund"], 10 * 60_000);
      if (result.exitCode !== 0) return refused("install-failed", "工具安装失败，请检查网络连接或 npm 配置。");
      const after = await this.inspect(tool);
      if (after.installation !== "managed" || !after.version) return refused("install-incomplete", "安装命令已结束，但 Bridge 尚未选用托管工具。请检查 CODEX_BIN 等显式配置。");
      return { kind: "applied", message: `${tools[tool].executable} ${after.version} 已${update ? "更新" : "安装"}。` };
    } finally { this.mutation = false; }
  }

  private async uninstall(tool: EnvironmentTool): Promise<EnvironmentReply> {
    if (this.mutation || this.active) return refused("busy", "另一个本机环境操作正在进行。");
    if (!await this.managedVersion(tool)) return refused("external-install", "此工具不是 Vonvon Bridge 托管的副本，不能卸载。");
    const npm = await this.resolveNpm();
    if (!npm) return refused("npm-missing", "未找到 npm，无法卸载工具。");
    this.mutation = true;
    try {
      const result = await this.command(npm, ["uninstall", "--global", "--prefix", this.managedRoot(), tools[tool].package], 10 * 60_000);
      if (result.exitCode !== 0 || await this.managedVersion(tool)) return refused("uninstall-failed", "未能移除托管工具。");
      return { kind: "applied", message: "已移除 Vonvon Bridge 托管的工具，其他安装不受影响。" };
    } finally { this.mutation = false; }
  }

  private async authStatus(tool: EnvironmentTool): Promise<EnvironmentReply> {
    const resolved = await this.resolveTool(tool);
    if (!resolved) return { kind: "auth", tool, state: "unknown", message: "尚未安装。" };
    const args = tool === "codex" ? ["login", "status"] : tool === "claude" ? ["auth", "status"] : ["auth", "status", "--json"];
    const result = await this.command(resolved.executable, args, 12_000).catch(() => null);
    if (!result) return { kind: "auth", tool, state: "unknown", message: "无法检查授权。" };
    const state = authenticationState(tool, result);
    const signedIn = state === "signedIn";
    if (state === "unknown") return { kind: "auth", tool, state, message: "无法确认授权状态，请重新检测。" };
    return { kind: "auth", tool, state: signedIn ? "signedIn" : "signedOut", message: signedIn ? "已授权" : "尚未授权" };
  }

  private async startLogin(tool: EnvironmentTool): Promise<EnvironmentReply> {
    const resolved = await this.resolveTool(tool);
    if (!resolved) return refused("tool-missing", "请先安装工具。");
    const args = tool === "codex" ? ["login", "--device-auth"] : tool === "claude" ? ["auth", "login"] : ["auth", "login", "--recommend", "--json"];
    return this.startOperation(resolved.executable, args, { kind: "login", tool }, 5 * 60_000);
  }

  private async profileList(): Promise<EnvironmentReply> {
    const resolved = await this.resolveTool("lark-cli");
    if (!resolved) return refused("tool-missing", "请先安装飞书 CLI。");
    const result = await this.command(resolved.executable, ["profile", "list"], 10_000);
    if (result.exitCode !== 0) return refused("profile-list-failed", "无法读取飞书 CLI Profile。");
    const parsed: unknown = JSON.parse(result.stdout);
    const profiles = environmentProfileSchema.array().max(128).parse(parsed);
    return { kind: "profiles", profiles };
  }

  private async profileUse(name: string): Promise<EnvironmentReply> {
    if (this.mutation || this.active) return refused("busy", "另一个本机环境操作正在进行。");
    const resolved = await this.resolveTool("lark-cli");
    if (!resolved) return refused("tool-missing", "请先安装飞书 CLI。");
    this.mutation = true;
    try {
      const result = await this.command(resolved.executable, ["profile", "use", name], 10_000);
      if (result.exitCode !== 0) return refused("profile-use-failed", "切换 Profile 失败。");
      return await this.profileList();
    } finally { this.mutation = false; }
  }

  private async profileAdd(request: Extract<EnvironmentRequest, { type: "profileAdd" }>): Promise<EnvironmentReply> {
    if (this.mutation || this.active) return refused("busy", "另一个本机环境操作正在进行。");
    const resolved = await this.resolveTool("lark-cli");
    if (!resolved) return refused("tool-missing", "请先安装飞书 CLI。");
    this.mutation = true;
    try {
      const args = ["profile", "add", "--name", request.name, "--app-id", request.appId, "--brand", request.brand, "--app-secret-stdin", ...(request.use ? ["--use"] : [])];
      const result = await this.command(resolved.executable, args, 10_000, request.appSecret);
      if (result.exitCode !== 0) return refused("profile-add-failed", "添加 Profile 失败，请检查应用信息。");
      return await this.profileList();
    } finally { this.mutation = false; }
  }

  private async profileInit(name: string): Promise<EnvironmentReply> {
    const resolved = await this.resolveTool("lark-cli");
    if (!resolved) return refused("tool-missing", "请先安装飞书 CLI。");
    return this.startOperation(resolved.executable, ["config", "init", "--new", "--name", name], { kind: "profileInit" }, 10 * 60_000);
  }

  private startOperation(executablePath: string, args: string[], purpose: Extract<EnvironmentOperation, { kind: "running" }>["purpose"], timeoutMs: number): EnvironmentReply {
    if (this.active || this.mutation) return refused("busy", "另一个本机环境操作正在进行。");
    const id = randomUUID();
    const snapshot: EnvironmentOperation = { kind: "running", id, purpose, startedAt: Date.now() };
    let child: ChildProcess;
    try { child = this.spawnProcess(executablePath, args, { env: this.environment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch { return refused("launch-failed", "无法启动授权或创建流程。"); }
    const timer = setTimeout(() => this.finishOperation(id, "timedOut", "操作超时。", true), timeoutMs);
    this.active = { snapshot, child, timer, output: "" };
    this.lastOperation = snapshot;
    const consume = (chunk: Buffer | string) => {
      const current = this.active;
      if (!current || current.snapshot.id !== id) return;
      current.output = (current.output + chunk.toString()).slice(-outputLimit);
      const url = verificationUrl(current.output);
      if (url && current.snapshot.kind === "running") {
        current.snapshot = { ...current.snapshot, url };
        this.lastOperation = current.snapshot;
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", () => this.finishOperation(id, "failed", "无法启动授权或创建流程。", false));
    child.once("close", (exitCode) => this.finishOperation(id, exitCode === 0 ? "succeeded" : "failed", exitCode === 0 ? "操作已完成。" : "操作未完成，请重试。", false));
    return { kind: "operation", operation: snapshot };
  }

  private finishOperation(id: string, kind: "succeeded" | "failed" | "cancelled" | "timedOut", message: string, kill: boolean): void {
    const current = this.active;
    if (!current || current.snapshot.id !== id) return;
    clearTimeout(current.timer);
    if (kill) current.child.kill("SIGTERM");
    current.output = "";
    this.active = undefined;
    this.lastOperation = { kind, id, message };
  }

  private cancel(id: string): EnvironmentReply {
    if (!this.active || this.active.snapshot.id !== id) return refused("not-running", "操作已结束。");
    this.finishOperation(id, "cancelled", "已取消。", true);
    return { kind: "operation", operation: this.lastOperation };
  }

  private async openVerification(id: string): Promise<EnvironmentReply> {
    const current = this.active?.snapshot;
    if (!current || current.kind !== "running" || current.id !== id || !current.url || !this.openExternal) return refused("verification-unavailable", "授权链接尚未准备好。");
    await this.openExternal(current.url);
    return { kind: "applied", message: "已在浏览器打开授权链接。" };
  }

  private async resolveNpm(): Promise<string | null> {
    const candidates = [this.npmPath, join(dirname(this.nodePath), process.platform === "win32" ? "npm.cmd" : "npm"), ...this.searchPath.split(delimiter).filter(isAbsolute).map((directory) => join(directory, process.platform === "win32" ? "npm.cmd" : "npm"))];
    for (const candidate of candidates) if (candidate && await executable(candidate)) return candidate;
    return null;
  }

  private environment(): NodeJS.ProcessEnv {
    return { HOME: this.home, USERPROFILE: this.home, PATH: [dirname(this.nodePath), join(this.managedRoot(), "bin"), this.searchPath, "/usr/bin", "/bin"].join(delimiter), LANG: "en_US.UTF-8", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1" };
  }

  private command(executablePath: string, args: string[], timeoutMs: number, secret?: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(executablePath, args, { env: this.environment(), stdio: [secret === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;
      const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new Error("操作超时。")); }, timeoutMs);
      const finish = (error?: Error, exitCode?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ exitCode: exitCode ?? null, stdout, stderr });
      };
      const collect = (chunk: Buffer | string, retain: boolean) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > outputLimit) { child.kill("SIGTERM"); finish(new Error("工具输出超过限制。")); return; }
        if (retain) stdout += chunk.toString();
        else stderr += chunk.toString();
      };
      child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, true));
      child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, false));
      child.once("error", () => finish(new Error("无法启动本机工具。")));
      child.once("close", (code) => finish(undefined, code));
      if (secret !== undefined) child.stdin?.end(`${secret}\n`);
    });
  }
}

async function executable(path: string): Promise<boolean> {
  try { await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return Boolean(await realpath(path)); }
  catch { return false; }
}

function refused(code: string, message: string): EnvironmentReply { return { kind: "refused", code, message }; }

function verificationUrl(output: string): string | undefined {
  const values = output.match(/https:\/\/[^\s"'<>]+/g) ?? [];
  for (const value of values) {
    try {
      const url = new URL(value.replace(/[),.;]+$/, ""));
      if (url.protocol === "https:" && !url.username && !url.password && !url.port && allowedHosts.has(url.hostname)) return url.toString();
    } catch {}
  }
  return undefined;
}

async function latestVersion(name: string): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(4_000) });
  if (!response.ok || Number(response.headers.get("content-length") ?? "0") > 128 * 1024) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 128 * 1024) return null;
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof body !== "object" || body === null || !("name" in body) || !("version" in body)) return null;
  return body.name === name && typeof body.version === "string" && /^\d+\.\d+\.\d+/.test(body.version) ? body.version : null;
}

function authenticationState(tool: EnvironmentTool, result: { exitCode: number | null; stdout: string; stderr: string }): "signedIn" | "signedOut" | "unknown" {
  if (tool === "codex") {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/not logged in|not authenticated|未登录|未授权/i.test(output)) return "signedOut";
    return result.exitCode === 0 && /logged in|authenticated|已登录|已授权/i.test(output) ? "signedIn" : "unknown";
  }
  let json: unknown;
  try { json = JSON.parse(result.stdout); } catch { return "unknown"; }
  if (tool === "claude") {
    const parsed = z.object({ loggedIn: z.boolean() }).safeParse(json);
    return parsed.success ? parsed.data.loggedIn ? "signedIn" : "signedOut" : "unknown";
  }
  const identity = z.object({ available: z.boolean() });
  const parsed = z.object({ defaultAs: z.enum(["user", "bot"]), identities: z.object({ user: identity, bot: identity }) }).safeParse(json);
  return parsed.success ? parsed.data.identities[parsed.data.defaultAs].available ? "signedIn" : "signedOut" : "unknown";
}

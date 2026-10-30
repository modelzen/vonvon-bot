import { z } from "zod";
import { homedir } from "node:os";
import { McpService } from "./mcp";
import type { McpRequest, McpReply } from "@vonvon/protocol";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, win32 } from "node:path";
import { spawnProcess } from "../platform/spawn";
import { CODEX_MIN_VERSION, CODEX_VERIFIED_VERSION, classifyCodexVersion, compareCodexVersions } from "../agent/codex-appserver/version";
import { managedCodexBin } from "../agent/codex-appserver/managed-install";
import { codexSource } from './codex-source';
import { bundledNpmCli } from '../platform/npm';
import {
  environmentProfileSchema,
  type EnvironmentOperation,
  type EnvironmentReply,
  type EnvironmentRequest,
  type EnvironmentTool,
  type EnvironmentToolState,
  type ToolInstallOperation,
} from "@vonvon/protocol";

const tools = {
  codex: { executable: "codex", package: "@openai/codex" },
  claude: { executable: "claude", package: "@anthropic-ai/claude-code" },
  "lark-cli": { executable: "lark-cli", package: "@larksuite/cli" },
} satisfies Record<EnvironmentTool, { executable: string; package: string }>;
const kinds: EnvironmentTool[] = ["codex", "claude", "lark-cli"];
const allowedHosts = new Set(["accounts.feishu.cn", "accounts.larksuite.com", "open.feishu.cn", "open.larksuite.com", "auth.openai.com", "chatgpt.com", "claude.ai", "console.anthropic.com", "platform.claude.com"]);
const outputLimit = 64 * 1024;
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ManagedSelection =
  | { kind: "absent" | "disabled" | "invalid" }
  | { kind: "active"; executable: string; version: string };

export type EnvironmentServiceOptions = {
  home: string;
  getDataRoot: () => string;
  resolveCodex: () => string | null | Promise<string | null>;
  nodePath: string;
  npmPath?: string;
  path?: string;
  spawnProcess?: typeof spawnProcess;
  fetchLatest?: (name: string) => Promise<string | null>;
  installSignal?: AbortSignal;
  requireTrustedNpm?: boolean;
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
  private readonly resolveCodex: () => string | null | Promise<string | null>;
  private readonly nodePath: string;
  private readonly npmPath?: string;
  private readonly searchPath: string;
  private readonly spawnProcess: typeof spawnProcess;
  private readonly fetchLatest: (name: string) => Promise<string | null>;
  private readonly installSignal?: AbortSignal;
  private readonly requireTrustedNpm: boolean;
  private active?: ActiveOperation;
  private lastOperation: EnvironmentOperation | null = null;
  private mutation = false;
  private toolInstall: ToolInstallOperation | null = null;
  private installAbort?: AbortController;
  private installCompletion?: Promise<EnvironmentReply>;
  private closing = false;
  private closePromise?: Promise<void>;
  /** Each launched tool process, with a promise that settles when its pipes close. */
  private readonly children = new Map<ChildProcess, Promise<void>>();
  private readonly requests = new Set<Promise<unknown>>();
  private mcpService?: McpService;

  constructor(options: EnvironmentServiceOptions) {
    if (!isAbsolute(options.home) || !isAbsolute(options.nodePath)) throw new Error("Absolute home and Node paths required.");
    this.home = options.home;
    this.getDataRoot = options.getDataRoot;
    this.resolveCodex = options.resolveCodex;
    this.nodePath = options.nodePath;
    this.npmPath = options.npmPath;
    this.searchPath = options.path ?? process.env.PATH ?? "";
    this.spawnProcess = options.spawnProcess ?? spawnProcess;
    this.fetchLatest = options.fetchLatest ?? latestVersion;
    this.installSignal = options.installSignal;
    this.requireTrustedNpm = options.requireTrustedNpm ?? false;
  }

  run(request: EnvironmentRequest): Promise<EnvironmentReply> {
    if (this.closing) return Promise.resolve(refused("environment-closed", "本机环境正在退出。"));
    const pending = this.execute(request);
    this.requests.add(pending);
    void pending.then(() => this.requests.delete(pending), () => this.requests.delete(pending));
    return pending;
  }

  mcp(request: McpRequest): Promise<McpReply> {
    if (this.closing) return Promise.resolve({ type: 'mcp', provider: request.provider, status: 'unavailable', configPath: '', revision: '', entries: [], cliAvailable: false, message: '本机环境正在退出。' });
    // An explicitly isolated home must not inherit the owner's provider directories.
    const env = { ...this.environment(), ...(this.home === homedir() ? {
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
    } : {}) };
    this.mcpService ??= new McpService({ home: this.home, env,
      resolveTool: async provider => (await this.resolveTool(provider))?.executable ?? null,
      command: (executable, args) => this.command(executable, args, 20_000, undefined, undefined, { ...env, PATH: this.environment(executable).PATH }),
    });
    const pending = this.mcpService.run(request);
    this.requests.add(pending);
    void pending.then(() => this.requests.delete(pending), () => this.requests.delete(pending));
    return pending;
  }

  close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= this.drain();
    return this.closePromise;
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.requests]);
    await Promise.all([...this.children.values()]);
    for (const child of this.children.keys()) {
      while (this.groupAlive(child)) await new Promise(resolve => setTimeout(resolve, 50));
      this.children.delete(child);
    }
  }

  private launch(executablePath: string, args: string[], secret?: string, env?: NodeJS.ProcessEnv): ChildProcess {
    if (this.closing) throw new Error("本机环境正在退出。");
    const child = this.spawnProcess(executablePath, args, {
      env: env ?? this.environment(executablePath), stdio: [secret === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true,
    });
    const closed = new Promise<void>((resolve) => child.once("close", resolve));
    this.children.set(child, closed);
    void closed.then(() => {
      try { if (!this.groupAlive(child)) this.children.delete(child); }
      catch {}
    });
    return child;
  }

  private groupAlive(child: ChildProcess): boolean {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    const closed = this.children.get(child);
    if (!closed) return;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (this.groupAlive(child)) {
        const pid = child.pid;
        if (!pid) throw new Error("无法确认本机工具进程编号。");
        try { process.kill(-pid, signal); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      const deadline = Date.now() + 2_000;
      while (this.groupAlive(child) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      if (!this.groupAlive(child)) {
        await within(closed, 2_000);
        this.children.delete(child);
        return;
      }
    }
    throw new Error("无法确认本机工具进程已退出。");
  }

  private async execute(request: EnvironmentRequest): Promise<EnvironmentReply> {
    try {
      switch (request.type) {
        case "scan": return { kind: "tools", tools: await Promise.all(kinds.map((tool) => this.inspect(tool))) };
        case "install": return await this.install(request.tool, false);
        case "update": return await this.install(request.tool, true);
        case "toolInstallStatus": return { kind: "toolInstall", operation: this.toolInstall };
        case "cancelInstall": return await this.cancelInstall(request.operationId);
        case "uninstall": return await this.uninstall(request.tool);
        case "authStatus": return await this.authStatus(request.tool);
        case "startLogin": return await this.startLogin(request.tool);
        case "loginStatus": return { kind: "operation", operation: this.lastOperation };
        case "cancelLogin": return await this.cancel(request.operationId);
        case "profileList": return await this.profileList();
        case "profileUse": return await this.profileUse(request.name);
        case "profileAdd": return await this.profileAdd(request);
        case "profileInit": return await this.profileInit(request.name);
        case "profileInitStatus": return { kind: "operation", operation: this.lastOperation };
        case "profileInitCancel": return await this.cancel(request.operationId);
        default: return refused("unsupported", "此操作不可用。");
      }
    } catch {
      return { kind: "refused", code: "environment-failed", message: "本机环境操作失败，请重试。" };
    }
  }

  private managedRoot(): string { return join(this.getDataRoot(), "managed-tools"); }
  private legacyManagedExecutable(tool: EnvironmentTool): string {
    return join(this.managedRoot(), "bin", process.platform === "win32" ? `${tools[tool].executable}.cmd` : tools[tool].executable);
  }

  private managedToolRoot(tool: EnvironmentTool): string { return join(this.managedRoot(), tool); }
  private managedPointer(tool: EnvironmentTool): string { return join(this.managedToolRoot(tool), "current.json"); }
  private releaseExecutable(prefix: string, tool: EnvironmentTool): string {
    const name = tools[tool].executable;
    return process.platform === "win32" ? join(prefix, `${name}.cmd`) : join(prefix, "bin", name);
  }

  private async managedSelection(tool: EnvironmentTool): Promise<ManagedSelection> {
    let data: unknown;
    try { data = JSON.parse(await readFile(this.managedPointer(tool), "utf8")); }
    catch (error) { return error instanceof Error && "code" in error && error.code === "ENOENT" ? { kind: "absent" } : { kind: "invalid" }; }
    if (typeof data !== "object" || data === null || !("schemaVersion" in data) || data.schemaVersion !== 1 || !("tool" in data) || data.tool !== tool || !("state" in data)) return { kind: "invalid" };
    if (data.state === "disabled") return { kind: "disabled" };
    if (data.state !== "active" || !("generation" in data) || typeof data.generation !== "string" || !generationPattern.test(data.generation) || !("version" in data) || typeof data.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version)) return { kind: "invalid" };
    const bin = this.releaseExecutable(join(this.managedToolRoot(tool), "releases", data.generation), tool);
    return await executable(bin) ? { kind: "active", executable: bin, version: data.version } : { kind: "invalid" };
  }

  private async publishManaged(tool: EnvironmentTool, selection: { schemaVersion: 1; tool: EnvironmentTool; state: "active"; generation: string; version: string } | { schemaVersion: 1; tool: EnvironmentTool; state: "disabled" }): Promise<void> {
    await this.writeManagedPointer(tool, JSON.stringify(selection));
  }

  private async writeManagedPointer(tool: EnvironmentTool, body: string): Promise<void> {
    const root = this.managedToolRoot(tool);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = join(root, `current-${randomUUID()}.json`);
    try {
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.managedPointer(tool));
    } finally { await rm(temporary, { force: true }); }
  }

  private async resolveTool(tool: EnvironmentTool): Promise<{ executable: string; ownership: "managed" | "external" } | null> {
    const selection = await this.managedSelection(tool);
    const managed = selection.kind === "active" ? selection.executable : this.legacyManagedExecutable(tool);
    if (tool === "codex") {
      const selected = await this.resolveCodex();
      const legacy = selection.kind === 'absent' ? managedCodexBin(join(this.getDataRoot(), 'codex-cli')) : null;
      return selected ? { executable: selected, ownership: !process.env.CODEX_BIN && (selected === managed || selected === legacy) && selection.kind !== "disabled" && selection.kind !== "invalid" ? "managed" : "external" } : null;
    }
    if (selection.kind === "active") return { executable: managed, ownership: "managed" };
    if (selection.kind === "absent" && await executable(managed)) return { executable: managed, ownership: "managed" };
    const candidates = [dirname(this.nodePath), ...this.searchPath.split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    // Finder/launchd do not load shell initialization. Reuse native and nvm Claude
    // installations after explicit PATH entries, scoped to this service's home.
    if (tool === "claude" && process.platform !== "win32") {
      candidates.push(join(this.home, ".local", "bin"));
      const nvm = join(this.home, ".nvm", "versions", "node");
      const versions = await readdir(nvm).catch(() => [] as string[]);
      candidates.push(...versions.filter(version => /^v\d+\.\d+\.\d+$/.test(version))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map(version => join(nvm, version, "bin")));
    }
    const suffixes = process.platform === "win32" ? ["", ".com", ".exe", ".bat", ".cmd"] : [""];
    for (const directory of candidates) {
      if (!isAbsolute(directory)) continue;
      for (const suffix of suffixes) {
        const candidate = join(directory, `${tools[tool].executable}${suffix}`);
        if (await executable(candidate)) return { executable: candidate, ownership: "external" };
      }
    }
    return null;
  }

  private async inspect(tool: EnvironmentTool): Promise<EnvironmentToolState> {
    const resolved = await this.resolveTool(tool);
    const managedVersion = await this.managedVersion(tool);
    const result = resolved ? await this.command(resolved.executable, ["--version"], 5_000).catch(() => null) : null;
    const version = result?.exitCode === 0 ? result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null : null;
    const compatibility = tool === "codex" && resolved ? { status: classifyCodexVersion(version), minimum: CODEX_MIN_VERSION, verified: CODEX_VERIFIED_VERSION } : undefined;
    const latest = await this.fetchLatest(tools[tool].package).catch(() => null);
    return {
      tool,
      installation: resolved?.ownership ?? "missing",
      executable: resolved?.executable ?? null,
      version,
      managedVersion,
      latestVersion: latest,
      updateAvailable: version && latest ? (tool === 'codex' ? compareCodexVersions(latest, version) > 0 : version !== latest) : null,
      canUninstall: Boolean(managedVersion),
      ...(tool === "claude" && resolved ? { runtimeStatus: result ? (result.exitCode === 0 ? "ready" as const : "failed" as const) : "unknown" as const } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(tool === 'codex' && resolved ? codexSource(resolved.executable, resolved.ownership === 'managed') : {}),
    };
  }

  private async managedVersion(tool: EnvironmentTool): Promise<string | null> {
    const selection = await this.managedSelection(tool);
    if (selection.kind === "active") return selection.version;
    if (selection.kind !== "absent") return null;
    if (tool === 'codex' && managedCodexBin(join(this.getDataRoot(), 'codex-cli'))) {
      try {
        const pointer = JSON.parse(await readFile(join(this.getDataRoot(), 'codex-cli', 'current.json'), 'utf8')) as {version?: unknown};
        if (typeof pointer.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pointer.version)) return pointer.version;
      } catch { /* inspect the other legacy layout */ }
    }
    const file = join(this.managedRoot(), "lib", "node_modules", tools[tool].package, "package.json");
    try {
      const body: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof body !== "object" || body === null || !("name" in body) || !("version" in body)) return null;
      return body.name === tools[tool].package && typeof body.version === "string" && /^\d+\.\d+\.\d+/.test(body.version) ? body.version : null;
    } catch { return null; }
  }

  private install(tool: EnvironmentTool, update: boolean): Promise<EnvironmentReply> {
    if (this.mutation || this.active) return Promise.resolve(refused("busy", "另一个本机环境操作正在进行。"));
    this.mutation = true;
    const id = randomUUID();
    const abort = new AbortController();
    const cancel = () => abort.abort(this.installSignal?.reason);
    this.installSignal?.addEventListener('abort', cancel, {once: true});
    if (this.installSignal?.aborted) cancel();
    this.toolInstall = { kind: "running", id, tool, update, startedAt: Date.now() };
    this.installAbort = abort;
    const pending = this.performInstall(tool, update, abort.signal).then((reply) => {
      this.toolInstall = { kind: reply.kind === "applied" ? "succeeded" : abort.signal.aborted ? "cancelled" : "failed", id, message: reply.kind === "applied" || reply.kind === "refused" ? reply.message : "安装已结束。" };
      return reply;
    }).catch(() => {
      const message = abort.signal.aborted ? "已取消安装，原工具仍可使用。" : "工具安装失败，原工具仍可使用。";
      this.toolInstall = { kind: abort.signal.aborted ? "cancelled" : "failed", id, message };
      return refused(abort.signal.aborted ? "install-cancelled" : "install-failed", message);
    }).finally(() => {
      this.installSignal?.removeEventListener('abort', cancel);
      this.mutation = false;
      this.installAbort = undefined;
      this.installCompletion = undefined;
    });
    this.installCompletion = pending;
    return pending;
  }

  private async cancelInstall(id: string): Promise<EnvironmentReply> {
    if (this.toolInstall?.kind !== "running" || this.toolInstall.id !== id || !this.installAbort || !this.installCompletion) return refused("not-running", "安装操作已结束。");
    this.installAbort.abort();
    await this.installCompletion;
    return { kind: "toolInstall", operation: this.toolInstall };
  }

  private async performInstall(tool: EnvironmentTool, update: boolean, signal: AbortSignal): Promise<EnvironmentReply> {
    const release = join(this.managedToolRoot(tool), "releases", randomUUID());
    let exposed = false;
    try {
      signal.throwIfAborted();
      if (tool === "codex" && process.env.CODEX_BIN) return refused("explicit-codex", "当前使用显式 CODEX_BIN，请先移除此覆盖再安装托管 Codex。");
      const npm = await this.resolveNpm();
      if (!npm) return refused("npm-missing", "未找到 npm，无法安装托管副本。托管副本要用本机的 Node.js 和 npm 来装和运行；Codex 也可以装 Codex.app 或用 Homebrew 安装。");
      signal.throwIfAborted();
      await mkdir(release, { recursive: true, mode: 0o700 });
      // npm 11.19+ skips a global install's own postinstall unless the package is allowed;
      // lark-cli and Claude Code both have one. Older npm ignores the flag with a warning.
      const result = await this.command(npm, ["install", "--global", "--prefix", release, `${tools[tool].package}@latest`, `--allow-scripts=${tools[tool].package}`, "--no-audit", "--no-fund"], 10 * 60_000, undefined, signal);
      if (result.exitCode !== 0) return refused("install-failed", "工具安装失败，请检查网络连接或 npm 配置。");
      signal.throwIfAborted();
      const file = join(release, process.platform === "win32" ? "node_modules" : join("lib", "node_modules"), tools[tool].package, "package.json");
      const manifest: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof manifest !== "object" || manifest === null || !("name" in manifest) || manifest.name !== tools[tool].package || !("version" in manifest) || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) return refused("install-incomplete", "新版本的安装信息无效，旧版本仍可使用。");
      const bin = this.releaseExecutable(release, tool);
      if (!await executable(bin)) return refused("install-incomplete", "新版本的可执行文件缺失，旧版本仍可使用。");
      const physicalRoot = await realpath(release);
      const physical = await realpath(bin);
      const relativePath = relative(physicalRoot, physical);
      if (relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) return refused("install-incomplete", "新版本的可执行文件超出安装目录，旧版本仍可使用。");
      const verified = await this.command(bin, ["--version"], 20_000, undefined, signal);
      if (verified.exitCode !== 0 || !new RegExp(`(?:^|[^\\d])${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\d])`).test(`${verified.stdout}\n${verified.stderr}`)) return refused("install-incomplete", "新版本未通过运行校验，旧版本仍可使用。");
      if (this.closing) return refused("environment-closed", "本机环境正在退出。");
      signal.throwIfAborted();
      const previousPointer = await readFile(this.managedPointer(tool), "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      signal.throwIfAborted();
      await this.publishManaged(tool, { schemaVersion: 1, tool, state: "active", generation: basename(release), version: manifest.version });
      exposed = true;
      let selected = false;
      try {
        const after = await this.resolveTool(tool);
        selected = !signal.aborted && after?.ownership === "managed" && after.executable === bin;
        // Automatic discovery may prefer a newer external install. Keep the verified
        // managed release as a fallback without claiming that it replaced that CLI.
        if (!signal.aborted && !selected && tool === 'codex' && after?.ownership === 'external' && !process.env.CODEX_BIN) {
          const probe = await this.command(after.executable, ['--version'], 5_000, undefined, signal);
          const activeVersion = probe.exitCode === 0 ? probe.stdout.match(/^codex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1] : undefined;
          selected = Boolean(activeVersion && compareCodexVersions(activeVersion, manifest.version) >= 0);
        }
      } finally {
        if (!selected) {
          if (previousPointer === null) await rm(this.managedPointer(tool), { force: true });
          else await this.writeManagedPointer(tool, previousPointer);
        }
      }
      if (!selected) return refused("install-not-selected", "当前 Vonvon Bot 未选用新版本，已保留原有工具；请检查 CODEX_BIN 等显式配置。");
      return { kind: "applied", message: `${tools[tool].executable} ${manifest.version} 已${update ? "更新" : "安装"}。${tool === 'codex' ? '新会话会使用检测到的版本，正在执行的任务继续运行。' : ''}` };
    } finally {
      if (!exposed && this.children.size === 0) await rm(release, { recursive: true, force: true });
    }
  }

  private async uninstall(tool: EnvironmentTool): Promise<EnvironmentReply> {
    if (this.mutation || this.active) return refused("busy", "另一个本机环境操作正在进行。");
    this.mutation = true;
    try {
      if (!await this.managedVersion(tool)) return refused("external-install", "此工具不是 Vonvon Bot 托管的副本，不能卸载。");
      await this.publishManaged(tool, { schemaVersion: 1, tool, state: "disabled" });
      return { kind: "applied", message: "已停用 Vonvon Bot 托管的工具，其他安装不受影响。" };
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
    if (tool === "codex" || tool === "claude") return refused("provider-configuration-required", tool === "codex"
      ? "请先在 Codex App 或 Codex CLI 中完成登录或自定义模型配置，再回到 Vonvon 检测。"
      : "请先在 Claude Code 中完成登录或自定义 API、模型配置，再回到 Vonvon 检测。");
    const resolved = await this.resolveTool(tool);
    if (!resolved) return refused("tool-missing", "请先安装工具。");
    const args = ["auth", "login", "--recommend", "--json"];
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
    this.mutation = true;
    try {
      const resolved = await this.resolveTool("lark-cli");
      if (!resolved) return refused("tool-missing", "请先安装飞书 CLI。");
      const result = await this.command(resolved.executable, ["profile", "use", name], 10_000);
      if (result.exitCode !== 0) return refused("profile-use-failed", "切换 Profile 失败。");
      return await this.profileList();
    } finally { this.mutation = false; }
  }

  private async profileAdd(request: Extract<EnvironmentRequest, { type: "profileAdd" }>): Promise<EnvironmentReply> {
    if (this.mutation || this.active) return refused("busy", "另一个本机环境操作正在进行。");
    this.mutation = true;
    try {
      const resolved = await this.resolveTool("lark-cli");
      if (!resolved) return refused("tool-missing", "请先安装飞书 CLI。");
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
    try { child = this.launch(executablePath, args); }
    catch { return refused("launch-failed", "无法启动授权或创建流程。"); }
    const timer = setTimeout(() => { void this.stopOperation(id, "timedOut", "操作超时。").catch(() => undefined); }, timeoutMs);
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
    child.once("error", () => this.finishOperation(id, "failed", "无法启动授权或创建流程。"));
    child.once("close", (exitCode) => this.finishOperation(id, exitCode === 0 ? "succeeded" : "failed", exitCode === 0 ? "操作已完成。" : "操作未完成，请重试。"));
    return { kind: "operation", operation: snapshot };
  }

  private finishOperation(id: string, kind: "succeeded" | "failed" | "cancelled" | "timedOut", message: string): void {
    const current = this.active;
    if (!current || current.snapshot.id !== id) return;
    clearTimeout(current.timer);
    current.output = "";
    this.active = undefined;
    this.lastOperation = { kind, id, message };
  }

  private async stopOperation(id: string, kind: "cancelled" | "timedOut", message: string): Promise<void> {
    const current = this.active;
    if (!current || current.snapshot.id !== id) return;
    clearTimeout(current.timer);
    this.mutation = true;
    try {
      await this.terminate(current.child);
      this.finishOperation(id, kind, message);
      this.lastOperation = { kind, id, message };
    } finally { this.mutation = false; }
  }

  private async cancel(id: string): Promise<EnvironmentReply> {
    if (!this.active || this.active.snapshot.id !== id) return refused("not-running", "操作已结束。");
    await this.stopOperation(id, "cancelled", "已取消。");
    return { kind: "operation", operation: this.lastOperation };
  }

  private async resolveNpm(): Promise<string | null> {
    const trusted = !this.npmPath ? bundledNpmCli() : undefined;
    if (trusted) return trusted;
    if (this.requireTrustedNpm) return null;
    const candidates = [this.npmPath, join(dirname(this.nodePath), process.platform === "win32" ? "npm.cmd" : "npm"), ...this.searchPath.split(delimiter).filter(isAbsolute).map((directory) => join(directory, process.platform === "win32" ? "npm.cmd" : "npm"))];
    for (const candidate of candidates) if (candidate && await executable(candidate)) return candidate;
    return null;
  }

  /** `executablePath`'s own directory goes last on PATH: an nvm-installed tool's
   * `#!/usr/bin/env node` launcher needs the `node` next to it. */
  private environment(executablePath?: string): NodeJS.ProcessEnv {
    return {
      ...(process.platform === "win32" ? { ComSpec: process.env.ComSpec ?? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") } : {}),
      HOME: this.home, USERPROFILE: this.home,
      PATH: [dirname(this.nodePath), this.searchPath, "/usr/bin", "/bin", ...(executablePath && isAbsolute(executablePath) ? [dirname(executablePath)] : [])].join(delimiter),
      LANG: "en_US.UTF-8", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    };
  }

  private command(executablePath: string, args: string[], timeoutMs: number, secret?: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const trustedNpm = executablePath === bundledNpmCli();
      const child = trustedNpm
        ? this.launch(this.nodePath, [executablePath, ...args], secret, {...(env ?? this.environment()), ELECTRON_RUN_AS_NODE: '1', npm_config_update_notifier: 'false'})
        : this.launch(executablePath, args, secret, env);
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;
      let stoppingError: Error | undefined;
      const stop = (error: Error) => {
        if (stoppingError || settled) return;
        stoppingError = error;
        void this.terminate(child).then(() => finish(error), () => finish(new Error("无法停止本机工具。")));
      };
      const onAbort = () => stop(new Error("已取消安装。"));
      const timer = setTimeout(() => stop(new Error("操作超时。")), timeoutMs);
      const finish = (error?: Error, exitCode?: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve({ exitCode: exitCode ?? null, stdout, stderr });
      };
      const collect = (chunk: Buffer | string, retain: boolean) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > outputLimit) { stop(new Error("工具输出超过限制。")); return; }
        if (retain) stdout += chunk.toString();
        else stderr += chunk.toString();
      };
      child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, true));
      child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, false));
      child.once("error", () => finish(new Error("无法启动本机工具。")));
      child.once("close", (code) => {if (!stoppingError) finish(undefined, code);});
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
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

async function within<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("本机工具仍有操作尚未退出。")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

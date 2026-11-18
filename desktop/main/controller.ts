import {pendingGroupsSchema} from "../shared/bridge";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import QRCode from "qrcode";
import {
  agentIdSchema,
  groupIdSchema,
  jobIdSchema,
  type AgentId,
  type Command,
  type CommandResult,
  type DesktopSnapshot,
  type Job,
  type JobId,
  type ToolState,
  type Diagnostic,
} from "../shared/bridge";
import {
  acquireHost,
  type HostHandle,
  type HostModule,
  type HostRuntime,
} from "./host";
import {
  CoreError,
  messageOf,
  projectState,
  readJson,
  stateSchema,
} from "./projection";
import { authorizationUrl, registrationUrl } from "./capabilities";
import {
  agentViewSchema, projectViewSchema, sessionViewSchema, hostViewSchema,
  modelCatalogSchema, settingsReplySchema,
  settingsRequestSchema,
  type ParsedSettingsRequest, type SettingsReply, type SettingsScope,
} from "../shared/settings";

const setupSchema = z.object({
  installation: z.enum(["missing", "installed", "unknown"]),
  authentication: z.enum(["signedOut", "signedIn", "notRequired", "unknown"]),
  version: z.string().nullable(),
  message: z.string().optional(),
});
const jobBase = { id: jobIdSchema, type: z.enum(["install", "login"]) };
const toolJobSchema = z.discriminatedUnion("state", [
  z.object({
    ...jobBase,
    state: z.literal("authorizing"),
    message: z.string().optional(),
    userCode: z.string().min(1).max(100),
    verificationUrl: z.string().url(),
  }),
  ...(["running", "succeeded", "failed", "cancelled"] as const).map((state) =>
    z.object({
      ...jobBase,
      state: z.literal(state),
      message: z.string().optional(),
    }),
  ),
]);
const catalogSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      depState: z.enum(["installed", "not-installed", "external-missing"]),
      version: z.string().nullable().optional(),
    }),
  ),
});
const groupPageSchema = z.object({
  groups: z.array(
    z.object({ chatId: groupIdSchema, name: z.string(), bound: z.boolean() }),
  ),
  nextCursor: z.string().optional(),
});
const terminal = (job: Job) =>
  job.phase === "succeeded" ||
  job.phase === "failed" ||
  job.phase === "cancelled";
const unknownCodex: ToolState = {
  tool: "codex",
  installation: "unknown",
  authentication: "unknown",
  version: null,
};
const unknownClaude: ToolState = {
  tool: "claude",
  installation: "unknown",
  authentication: "unknown",
  version: null,
  message: "现有 Claude 配置可继续使用，授权状态在实际任务中确认。",
};

type Operation = { abort: AbortController; finished: Promise<void> } & (
  | { kind: "tool"; type: "installCodex" | "loginCodex" }
  | {
      kind: "registration";
      confirmEnd: (cancelRequested?: boolean) => Promise<void>;
      reconcile: () => Promise<void>;
    }
);

export class DesktopController {
  private host: HostHandle | undefined;
  private snapshot: DesktopSnapshot;
  private readonly listeners = new Set<(snapshot: DesktopSnapshot) => void>();
  private readonly pendingActivation = new Set<string>();
  private readonly authorizations = new Map<JobId, string>();
  private readonly operations = new Map<JobId, Operation>();
  private generation = 0;
  private lane: Promise<unknown> = Promise.resolve();
  private poll: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  private lifecycle: "open" | "closing" | "closed" = "open";
  private quitting: Promise<void> | undefined;
  private paused = false;
  constructor(
    private readonly module: HostModule,
    private readonly runtime: HostRuntime,
    application: DesktopSnapshot["application"],
  ) {
    this.snapshot = {
      revision: 0,
      observedAt: 0,
      stale: false,
      host: { kind: "starting" },
      agents: [],
      groups: [],
      memberships: [],
      tools: [unknownCodex, unknownClaude],
      jobs: [],
      diagnostics: [],
      application,
    };
  }
  current(): DesktopSnapshot {
    return this.snapshot;
  }
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(update: Partial<DesktopSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      revision: this.snapshot.revision + 1,
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lane.then(operation, operation);
    this.lane = next.catch(() => undefined);
    return next;
  }
  start(bot?: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.lifecycle !== "open" || this.host) return;
      this.paused = false;
      await this.connect(bot);
    });
  }
  currentHost(): HostHandle | undefined { return this.host; }
  requestManagement(path: string, init: RequestInit = {}): Promise<Response> {
    return this.enqueue(async () => {
      if (this.lifecycle !== 'open') throw new CoreError('closing', '应用正在退出。');
      return this.connected().request(path, {...init, signal: init.signal ?? AbortSignal.timeout(60_000)});
    });
  }
  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.snapshot.jobs.some(job => !terminal(job))) throw new CoreError('operation-active', '请先完成或取消安装、登录及注册操作。');
      this.generation++;
      await this.host?.close();
      if (this.poll) clearInterval(this.poll);
      this.poll = undefined;
      this.host = undefined;
      this.paused = true;
      this.publish({host: {kind: 'disconnected', message: 'Bridge 已停止，可到应用与启动页重新启动。'}, stale: true});
    });
  }
  private async connect(bot?: string): Promise<void> {
    try {
      const host = await acquireHost(this.module, {...this.runtime, ...(bot ? {bot} : {})});
      if (host.kind === "blocked") {
        if (this.lifecycle === "open")
          this.publish({
            host: { kind: "blocked", message: host.message },
            stale: true,
          });
        return;
      }
      this.host = host;
      if (this.lifecycle !== "open") return;
      this.publish({
        host: {
          kind: "connected",
          ownership: host.ownership,
          version: "正在读取",
        },
      });
      await this.refresh();
      if (this.lifecycle === "open") await this.diagnose();
      if (this.lifecycle === "open")
        this.poll = setInterval(() => {
          if (!this.refreshing && this.lifecycle === "open")
            void this.refresh();
        }, 8000);
    } catch (error) {
      if (this.lifecycle === "open")
        this.publish({
          host: { kind: "disconnected", message: messageOf(error) },
          stale: true,
        });
    }
  }
  private connected(): HostHandle {
    if (!this.host) throw new CoreError("not-connected", "Bridge 尚未连接。");
    return this.host;
  }
  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    return readJson(
      await this.connected().request(path, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(20_000),
      }),
    );
  }
  private settingsPath(scope: SettingsScope): string {
    switch (scope.kind) {
      case "host":
        return "/api/settings/host";
      case "agent":
        return `/api/bots/${encodeURIComponent(scope.botId)}/settings`;
      case "project":
        return `/api/project/${encodeURIComponent(scope.projectName)}/settings?bot=${encodeURIComponent(scope.botId)}`;
      case "session":
        return `/api/bots/${encodeURIComponent(scope.botId)}/sessions/${encodeURIComponent(scope.threadId)}/settings`;
    }
  }
  private async settingsJson(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.connected().request(path, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    if (body.length > 4_000_000)
      throw new CoreError("invalid-response", "设置响应过大。");
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new CoreError("invalid-response", "设置响应无法解析。");
    }
    if (response.status === 404 || response.status === 501) {
      const missing = z
        .object({
          kind: z.literal("rejected"),
          fields: z.array(z.object({ message: z.string() })),
        })
        .safeParse(data);
      if (missing.success)
        throw new CoreError(
          "missing-settings",
          missing.data.fields.map((field) => field.message).join("；"),
        );
      throw new CoreError(
        "unsupported-host",
        "当前 Bridge 版本不支持桌面设置，请更新后重试。",
      );
    }
    if (response.status >= 500 && response.status !== 503)
      throw new CoreError(
        "host-error",
        "Bridge 暂时无法处理设置，请稍后重试。",
      );
    return data;
  }
  async settings(request: ParsedSettingsRequest): Promise<SettingsReply> {
    if (
      request.type === "save" &&
      request.edit.scope.kind === "host" &&
      request.edit.section === "execution" &&
      z.object({ codexBin: z.string() }).safeParse(request.edit.patch).success
    )
      return {
        kind: "refused",
        code: "file-picker-required",
        message: "请使用本机文件选择器指定 Codex 可执行文件。",
      };
    return this.settingsInternal(request);
  }
  async saveExecutable(path: string, revision: string): Promise<SettingsReply> {
    const request = settingsRequestSchema.parse({
      type: "save",
      edit: {
        scope: { kind: "host" },
        section: "execution",
        revision,
        patch: { codexBin: path },
      },
    });
    return this.settingsInternal(request);
  }
  private async settingsInternal(
    request: ParsedSettingsRequest,
  ): Promise<SettingsReply> {
    try {
      if (this.lifecycle !== "open")
        throw new CoreError("closing", "应用正在退出。");
      if (request.type === "read") {
        const raw = await this.settingsJson(this.settingsPath(request.scope));
        const unavailable = z
          .object({
            kind: z.literal("unavailable"),
            reason: z.object({
              kind: z.literal("readonly"),
              message: z.string(),
            }),
          })
          .safeParse(raw);
        if (unavailable.success)
          throw new CoreError(
            "settings-unavailable",
            unavailable.data.reason.message,
          );
        const view =
          request.scope.kind === "agent"
            ? agentViewSchema.parse(raw)
            : request.scope.kind === "project"
              ? projectViewSchema.parse(raw)
              : request.scope.kind === "session"
                ? sessionViewSchema.parse(raw)
                : hostViewSchema.parse(raw);
        if (JSON.stringify(view.scope) !== JSON.stringify(request.scope))
          throw new CoreError("scope-mismatch", "设置响应与当前选择不匹配。");
        return { kind: "view", view };
      }
      if (request.type === "models") {
        const { botId, backend, purpose } = request.query;
        const query = new URLSearchParams({ backend, purpose });
        const catalog = modelCatalogSchema.parse(
          await this.settingsJson(
            `/api/bots/${encodeURIComponent(botId)}/models?${query}`,
          ),
        );
        if (catalog.backend !== backend)
          throw new CoreError(
            "scope-mismatch",
            "模型列表与当前执行工具不匹配。",
          );
        return { kind: "models", catalog };
      }
      if (request.type === "sessions") {
        const path = `/api/project/${encodeURIComponent(request.projectName)}/sessions?bot=${encodeURIComponent(request.botId)}`;
        const raw = await this.settingsJson(path);
        return settingsReplySchema.parse({
          kind: "sessions",
          ...z.object({ sessions: z.unknown() }).parse(raw),
        });
      }
      if (
        request.type === "chooseExecutable" ||
        request.type === "saveExecutable"
      )
        throw new CoreError("native-command", "请选择应用窗口提供的文件。");
      return await this.enqueue(async () => {
        const path =
          request.type === "save"
            ? this.settingsPath(request.edit.scope)
            : request.action.kind !== 'setHostCliRoute' && request.action.kind !== 'repairHostCliHooks'
              ? `/api/bots/${encodeURIComponent(request.action.botId)}/settings/actions`
              : '/api/settings/host/actions';
        const body =
          request.type === "save"
            ? request.edit.scope.kind === "agent"
              ? { revision: request.edit.revision, patch: request.edit.patch }
              : {
                  section: request.edit.section,
                  revision: request.edit.revision,
                  patch: request.edit.patch,
                }
            : request.action;
        const raw = await this.settingsJson(
          request.type === "save" && request.edit.scope.kind === "agent"
            ? `${path}/${encodeURIComponent(request.edit.section)}`
            : path,
          {
            method: request.type === "save" ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const reply = settingsReplySchema.parse(
          request.type === "save"
            ? { kind: "saved", result: raw }
            : { kind: "acted", result: raw },
        );
        if (request.type === "save" && reply.kind === "saved") {
          const result = reply.result;
          const section =
            result.kind === "saved"
              ? result.section
              : result.kind === "conflict"
                ? result.current
                : undefined;
          if (
            section &&
            (section.section !== request.edit.section ||
              JSON.stringify(section.scope) !==
                JSON.stringify(request.edit.scope))
          )
            throw new CoreError(
              "scope-mismatch",
              "保存结果与当前设置范围不匹配。",
            );
        }
        if (request.type === "act" && reply.kind === "acted") {
          const result = reply.result;
          const view =
            result.kind === "saved" ||
            result.kind === "conflict" ||
            result.kind === "diverged"
              ? result.view
              : undefined;
          if (
            view &&
            (request.action.kind !== 'setHostCliRoute' && request.action.kind !== 'repairHostCliHooks'
              ? view.scope.kind === 'host' || view.scope.botId !== request.action.botId ||
                ("projectName" in request.action
                  ? view.scope.kind !== "project" || view.scope.projectName !== request.action.projectName
                  : view.scope.kind !== "agent")
              : view.scope.kind !== 'host')
          )
            throw new CoreError(
              "scope-mismatch",
              "操作结果与当前 Bot 或群不匹配。",
            );
        }
        return reply;
      });
    } catch (error) {
      return {
        kind: "refused",
        code:
          error instanceof CoreError
            ? error.code
            : error instanceof z.ZodError
              ? "invalid-response"
              : "settings-failed",
        message:
          error instanceof z.ZodError
            ? "Bridge 设置响应与支持的协议不一致。"
            : messageOf(error),
      };
    }
  }
  async refresh(duringClose = false): Promise<void> {
    if (this.lifecycle !== "open" && !duringClose) return;
    const generation = this.generation;
    this.refreshing = true;
    try {
      const state = stateSchema.parse(await this.json("/api/state"));
      if (
        generation !== this.generation ||
        (this.lifecycle !== "open" && !duringClose)
      )
        return;
      this.publish({
        ...projectState(state, this.snapshot, this.pendingActivation),
        observedAt: Date.now(),
        host: {
          kind: "connected",
          ownership: this.connected().ownership,
          version: state.version,
        },
      });
      const results = await Promise.allSettled([
        this.json("/api/tools/codex/setup"),
        this.json("/api/backends"),
      ]);
      if (
        generation !== this.generation ||
        (this.lifecycle !== "open" && !duringClose)
      )
        return;
      const codex = results[0];
      const parsed =
        codex.status === "fulfilled"
          ? setupSchema.safeParse(codex.value)
          : undefined;
      const codexTool: ToolState = parsed?.success
        ? { tool: "codex", ...parsed.data }
        : {
            ...unknownCodex,
            message:
              codex.status === "rejected"
                ? messageOf(codex.reason)
                : "内核工具状态无法解析。",
          };
      const catalog =
        results[1].status === "fulfilled"
          ? catalogSchema.safeParse(results[1].value)
          : undefined;
      const claude = catalog?.success
        ? catalog.data.entries.find((entry) => entry.id === "claude-agent")
        : undefined;
      const claudeTool: ToolState = {
        ...unknownClaude,
        installation:
          claude?.depState === "installed"
            ? "installed"
            : claude
              ? "missing"
              : "unknown",
        version: claude?.version ?? null,
      };
      this.publish({ tools: [codexTool, claudeTool] });
    } catch (error) {
      if (
        generation === this.generation &&
        (this.lifecycle === "open" || duringClose)
      )
        this.publish({
          stale: true,
          diagnostics: [
            {
              title: "读取状态失败",
              message: messageOf(error),
              status: "error",
            },
          ],
          memberships: this.snapshot.memberships.map((member) => ({
            ...member,
            stale: true,
          })),
        });
    } finally {
      this.refreshing = false;
    }
  }
  private job(job: Job): void {
    if (
      !(job.type === "loginCodex" && job.phase === "authorizing") &&
      !(job.type === "registerAgent" && job.phase === "qr")
    )
      this.authorizations.delete(job.id);
    const jobs = this.snapshot.jobs.filter((current) => current.id !== job.id);
    jobs.push(job);
    while (jobs.length > 24) {
      const index = jobs.findIndex(terminal);
      if (index < 0) break;
      jobs.splice(index, 1);
    }
    this.publish({ jobs });
  }
  private async activate(agentId?: AgentId): Promise<CommandResult> {
    if (agentId) this.pendingActivation.add(agentId);
    const host = this.connected();
    if (host.ownership === "attached") {
      await this.refresh(true);
      return {
        kind: "activationPending",
        message:
          "配置已保存。请到「应用与启动」重启 Bridge，使更改生效。",
      };
    }
    try {
      await host.restart();
      this.generation++;
      this.pendingActivation.clear();
      await this.refresh(true);
      return { kind: "applied", revision: this.snapshot.revision };
    } catch (error) {
      this.publish({
        stale: true,
        diagnostics: [
          { title: "配置等待启用", message: messageOf(error), status: "error" },
        ],
      });
      return {
        kind: "activationPending",
        message: `配置已保存，但重启未完成。${messageOf(error)}`,
      };
    }
  }
  private async restartAttached(): Promise<CommandResult> {
    const host = this.connected();
    const daemon = z.object({
      installed: z.boolean(), running: z.boolean(), supported: z.boolean(),
      selfHosted: z.boolean(), pid: z.number().optional(),
    }).parse(await this.json("/api/daemon"));
    if (!daemon.installed || !daemon.running || !daemon.supported || daemon.selfHosted || daemon.pid !== host.pid)
      throw new CoreError("external-owner", "当前服务不是此安装的系统后台服务，请在启动它的应用中重启。");
    if (this.snapshot.jobs.some(job => !terminal(job)))
      throw new CoreError("operation-active", "请先完成或取消安装、登录及注册操作，再重启 Bridge。");
    await this.json("/api/daemon/restart", { method: "POST" });
    this.generation++;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    await host.close();
    this.host = undefined;
    this.publish({ stale: true, host: { kind: "starting" } });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && this.lifecycle === "open") {
      const next = await this.module.inspectHost(this.runtime.home);
      if (next.kind === "attached" && next.pid !== host.pid) {
        await this.connect();
        if (this.snapshot.host.kind === "connected" && !this.snapshot.stale) {
          this.pendingActivation.clear();
          await this.refresh();
          return { kind: "applied", revision: this.snapshot.revision };
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    this.publish({ stale: true, host: { kind: "disconnected", message: "重启请求已发出，尚未连接到新服务。请重新检查。" } });
    return { kind: "activationPending", message: "重启请求已发出，尚未连接到新服务。请重新检查。" };
  }
  private async write(
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<unknown> {
    this.generation++;
    try {
      return await this.json(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      this.generation++;
    }
  }
  private async setAgentEnabled(agentId: AgentId, enabled: boolean): Promise<CommandResult> {
    const response = z.object({
      activation: z.enum(["applied", "restartRequired"]).optional(),
    }).parse(await this.write(`/api/bots/${encodeURIComponent(agentId)}`, { enabled }, "PATCH")
      .finally(() => this.refresh(true)));
    if (response.activation !== "applied") {
      const result = await this.activate(agentId);
      if (result.kind === "activationPending" && !enabled)
        return { kind: "activationPending", message: "停用配置已保存，但 Bot 尚未停止，仍可能回复飞书消息。请到「应用与启动」重启 Bridge，使停用生效。" };
      if (result.kind !== "applied") return result;
    }
    this.pendingActivation.delete(agentId);
    await this.refresh(true);
    const agent = this.snapshot.agents.find(candidate => candidate.id === agentId);
    if (this.snapshot.stale || !agent || agent.enabled !== enabled || agent.running !== enabled) {
      return {
        kind: "activationPending",
        message: enabled ? "尚未确认 Bot 已启动，请重新检查状态。" : "Bot 尚未停止，仍可能回复飞书消息。请重新检查状态。",
      };
    }
    return { kind: "applied", revision: this.snapshot.revision };
  }
  async run(
    command: Command,
    resolveFolder: (
      token: Extract<Command, { type: "bindGroup" }>["folderToken"],
    ) => Promise<string>,
  ): Promise<CommandResult> {
    if (this.lifecycle !== "open")
      return { kind: "refused", code: "closing", message: "应用正在退出。" };
    if (command.type === "cancelJob") return this.cancel(command.jobId);
    return this.enqueue(async () => {
      if (this.lifecycle !== "open")
        return { kind: "refused", code: "closing", message: "应用正在退出。" };
      try {
        switch (command.type) {
          case "refresh":
            if (!this.host && this.paused) return {kind: 'applied', revision: this.snapshot.revision};
            if (!this.host) await this.connect();
            else await this.refresh();
            await this.diagnose();
            return { kind: "applied", revision: this.snapshot.revision };
          case "restartHost":
            if (this.connected().ownership === "attached")
              return await this.restartAttached();
            return await this.activate();
          case "listPendingGroups": {
            const response = await this.connected().request(`/api/bots/${encodeURIComponent(command.agentId)}/pending-groups`, {signal: AbortSignal.timeout(20_000)});
            if (response.status === 404 || response.status === 501)
              return {kind: "refused", code: "unsupported", message: "当前 Bridge 版本不支持绑定通知，请更新后台或查找已经加入的群。"};
            const page = pendingGroupsSchema.parse(await readJson(response));
            return {kind: "pendingGroups", groups: page.groups};
          }
          case "listJoinedGroups": {
            const page = groupPageSchema.parse(
              await this.json(
                `/api/bots/${encodeURIComponent(command.agentId)}/joined-groups${command.cursor ? `?cursor=${encodeURIComponent(command.cursor)}` : ""}`,
              ),
            );
            return {
              kind: "groups",
              groups: page.groups.map((group) => ({
                id: group.chatId,
                name: group.name,
                bound: group.bound,
              })),
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
          }
          case "bindGroup": {
            const directory = await resolveFolder(command.folderToken);
            await this.write(
              `/api/bots/${encodeURIComponent(command.agentId)}/bind-group`,
              {
                chatId: command.groupId,
                projectName: command.projectName,
                directory,
                backend:
                  command.tool === "codex" ? "codex-appserver" : "claude-agent",
                kind: command.conversation === "threads" ? "multi" : "single",
              },
            );
            await this.refresh();
            return { kind: "applied", revision: this.snapshot.revision };
          }
          case "setResponse":
          case "setPermission": {
            const state = stateSchema.parse(await this.json("/api/state"));
            const current = projectState(
              state,
              this.snapshot,
              this.pendingActivation,
            ).memberships.find(
              (member) => member.id === command.membershipId && !member.stale,
            );
            if (!current)
              throw new CoreError(
                "missing-binding",
                "群配置已更改或无法读取，请刷新后重试。",
              );
            const action =
              command.type === "setResponse" ? "no-mention" : "permission";
            await this.write(
              `/api/project/${encodeURIComponent(current.name)}/${action}?bot=${encodeURIComponent(current.agentId)}`,
              command.type === "setResponse"
                ? { on: command.response === "all" }
                : {
                    mode: command.administrator,
                    guestMode: command.member,
                    network: command.network,
                  },
            );
            await this.refresh();
            return { kind: "applied", revision: this.snapshot.revision };
          }
          case "setAgentEnabled":
            return await this.setAgentEnabled(command.agentId, command.enabled);
          case "deleteAgent": {
            const state = stateSchema.parse(await this.json("/api/state"));
            const target = state.bots.find(
              (bot) => bot.appId === command.agentId,
            );
            if (!target)
              throw new CoreError(
                "missing-agent",
                "Bot 已不存在，请刷新列表。",
              );
            if (target.active || target.running)
              throw new CoreError(
                "agent-active",
                "请先停用 Bot 并让它停止运行，再删除本地数据。",
              );
            this.generation++;
            try {
              await this.json(
                `/api/bots/${encodeURIComponent(command.agentId)}`,
                { method: "DELETE" },
              );
            } finally {
              this.generation++;
            }
            await this.refresh();
            return { kind: "applied", revision: this.snapshot.revision };
          }
          case "registerAgent":
            return await this.register();
          case "refreshAgentCredentials":
            return await this.register(command.agentId);
          case "installCodex":
            return await this.startTool("install");
          case "startCodexLogin":
            return await this.startTool("login");
          case "inspectAgent":
            await this.inspectAgent(command.agentId);
            return { kind: "applied", revision: this.snapshot.revision };
          case "chooseFolder":
          case "openEventSettings":
          case "openJobAuthorization":
          case "copyJobAuthorization":
          case "setLoginItem":
          case "quit":
          case "hideWindow":
            throw new CoreError(
              "native-command",
              "此操作必须通过应用窗口执行。",
            );
          default: {
            const exhaustive: never = command;
            return exhaustive;
          }
        }
      } catch (error) {
        if (error instanceof CoreError)
          return { kind: "refused", code: error.code, message: error.message };
        if (error instanceof z.ZodError)
          return {
            kind: "refused",
            code: "invalid-response",
            message: "内核响应与支持的协议不一致，请刷新状态。",
          };
        await this.refresh();
        return {
          kind: "outcomeUnknown",
          message: `无法确认操作结果，请检查最新状态后重试。${messageOf(error)}`,
        };
      }
    });
  }
  private async startTool(type: "install" | "login"): Promise<CommandResult> {
    const started = z
      .object({ id: jobIdSchema })
      .parse(await this.json(`/api/tools/codex/${type}`, { method: "POST" }));
    const id = started.id;
    const abort = new AbortController();
    const jobType = type === "install" ? "installCodex" : "loginCodex";
    this.job({
      id,
      type: jobType,
      phase: "running",
      message:
        type === "install" ? "正在安装 Codex。" : "正在启动 Codex 授权。",
    });
    const finished = this.pollTool(id, jobType, abort.signal).finally(() => {
      if (this.snapshot.jobs.some((job) => job.id === id && terminal(job)))
        this.operations.delete(id);
    });
    this.operations.set(id, { abort, finished, kind: "tool", type: jobType });
    return { kind: "started", jobId: id };
  }
  private async readToolJob(
    id: JobId,
    type: "installCodex" | "loginCodex",
    signal?: AbortSignal,
  ) {
    const value = toolJobSchema.parse(
      await this.json(`/api/tools/codex/jobs/${encodeURIComponent(id)}`, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      }),
    );
    if (
      value.id !== id ||
      (value.type === "install" ? "installCodex" : "loginCodex") !== type
    )
      throw new CoreError("job-mismatch", "内核返回了其他操作的状态。");
    return value;
  }
  private async pollTool(
    id: JobId,
    type: "installCodex" | "loginCodex",
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const value = await this.readToolJob(id, type, signal);
        if (signal.aborted) return;
        if (value.state === "authorizing") {
          if (type !== "loginCodex")
            throw new CoreError("job-mismatch", "安装操作不能请求账号授权。");
          this.authorizations.set(id, authorizationUrl(value.verificationUrl));
          this.job({
            id,
            type,
            phase: "authorizing",
            userCode: value.userCode,
          });
        } else {
          this.authorizations.delete(id);
          this.job({
            id,
            type,
            phase: value.state,
            message:
              value.message ??
              (value.state === "running"
                ? "操作进行中。"
                : value.state === "succeeded"
                  ? "内核已确认操作完成。"
                  : value.state === "cancelled"
                    ? "操作已取消。"
                    : "操作失败。"),
          });
        }
        if (value.state !== "running" && value.state !== "authorizing") {
          await this.refresh();
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        this.authorizations.delete(id);
        this.job({
          id,
          type,
          phase: "unresolved",
          message: `暂时无法确认操作状态，正在重新读取。${messageOf(error)}`,
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 1200);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  private async register(target?: AgentId): Promise<CommandResult> {
    if (
      this.snapshot.jobs.some(
        (job) => job.type === "registerAgent" && !terminal(job),
      )
    )
      throw new CoreError("registration-running", "已有扫码注册正在进行。");
    const before = stateSchema.parse(await this.json("/api/state"));
    if (target && !before.bots.some(bot => bot.appId === target))
      throw new CoreError("missing-agent", "Bot 已不存在，请刷新列表。");
    const registered = new Set(before.bots.map((bot) => bot.appId));
    const id = jobIdSchema.parse(randomUUID());
    const abort = new AbortController();
    const committed = new Set<AgentId>();
    let failure: unknown;
    let requestRejected = false;
    let reconciled = false;
    let cancellationRequested = false;
    let confirmedEnd: Promise<void> | undefined;
    let sessionId: string | undefined;
    let resolveSession: (value: string | undefined) => void = () => undefined;
    const sessionReady = new Promise<string | undefined>((resolve) => {
      resolveSession = resolve;
    });
    const recordSession = (value: string) => {
      const parsed = z.string().uuid().parse(value);
      if (sessionId && sessionId !== parsed)
        throw new CoreError(
          "session-mismatch",
          "注册连接返回了不同的会话身份。",
        );
      sessionId = parsed;
      resolveSession(parsed);
    };
    const confirmEnd = (cancelRequested = false): Promise<void> => {
      cancellationRequested ||= cancelRequested;
      this.authorizations.delete(id);
      if (committed.size || requestRejected) return Promise.resolve();
      if (confirmedEnd) return confirmedEnd;
      confirmedEnd = (async () => {
        const session = await new Promise<string | undefined>(
          (resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new CoreError(
                    "session-unknown",
                    "尚未取得本次注册会话，无法确认取消。",
                  ),
                ),
              20_000,
            );
            sessionReady.then(
              (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              (error) => {
                clearTimeout(timer);
                reject(error);
              },
            );
          },
        );
        if (!session)
          throw new CoreError(
            "session-unknown",
            "内核没有提供本次注册会话，无法确认取消。",
          );
        const response = await this.connected().request(
          `/api/bots/register-qr?sessionId=${encodeURIComponent(session)}`,
          { method: "DELETE", signal: AbortSignal.timeout(20_000) },
        );
        if (response.status !== 204) {
          if (!response.ok) await readJson(response);
          throw new CoreError(
            "cancellation-unconfirmed",
            "内核尚未确认本次注册已结束。",
          );
        }
        abort.abort();
      })().catch((error) => {
        confirmedEnd = undefined;
        throw error;
      });
      return confirmedEnd;
    };
    let reconciliation: Promise<void> | undefined;
    const reconcile = (): Promise<void> => {
      if (reconciled) return Promise.resolve();
      if (reconciliation) return reconciliation;
      reconciliation = (async () => {
        try {
          if (requestRejected) {
            this.job({
              id,
              type: "registerAgent",
              phase: "failed",
              message: messageOf(failure),
            });
            reconciled = true;
            return;
          }
          this.generation++;
          const state = stateSchema.parse(await this.json("/api/state"));
          if (target && !committed.has(target)) {
            if (!sessionId) throw new CoreError("session-unknown", "无法确认凭据刷新会话。");
            const outcome = z.discriminatedUnion("state", [
              z.object({state: z.literal("running")}),
              z.object({state: z.literal("succeeded"), appId: agentIdSchema}),
              z.object({state: z.literal("failed"), code: z.string().optional(), message: z.string().max(1024)}),
              z.object({state: z.literal("cancelled")}),
            ]).parse(await this.json(`/api/bots/register-qr?sessionId=${encodeURIComponent(sessionId)}`));
            if (outcome.state === "running") throw new CoreError("refresh-running", "凭据刷新尚未结束。");
            if (outcome.state === "succeeded") {
              if (outcome.appId !== target) throw new CoreError("identity-mismatch", "刷新结果与所选 Bot 不一致。");
              committed.add(target);
            } else if (outcome.state === "failed") failure = new Error(outcome.message);
          } else if (!target) {
            for (const bot of state.bots)
              if (!registered.has(bot.appId)) committed.add(bot.appId);
          }
          this.publish({
            ...projectState(state, this.snapshot, this.pendingActivation),
            observedAt: Date.now(),
          });
          if (committed.size) {
            for (const appId of committed)
              if (!target || state.bots.some(bot => bot.appId === appId && bot.active)) this.pendingActivation.add(appId);
            this.job({
              id,
              type: "registerAgent",
              phase: "activating",
              message: target ? "飞书凭据已保存，正在确认生效状态。" : "飞书身份已保存，正在启用。",
            });
            const result = await this.enqueue(async () => {
              if (!target) {
                let result: CommandResult = { kind: "applied", revision: this.snapshot.revision };
                for (const appId of committed) {
                  const activation = await this.setAgentEnabled(appId, true);
                  if (activation.kind !== "applied") result = activation;
                }
                return result;
              }
              if (target && !state.bots.some(bot => bot.appId === target && bot.active))
                return {kind: "applied", revision: this.snapshot.revision} as const;
              return this.activate();
            });
            await this.refresh(true);
            this.job({
              id,
              type: "registerAgent",
              phase: "succeeded",
              message:
                result.kind === "activationPending"
                  ? result.message
                  : target ? "Bot 凭据已刷新，原有设置和群绑定已保留。" : "Bot 已注册并启用。请检查飞书权限后加入群。",
            });
          } else {
            this.job({
              id,
              type: "registerAgent",
              phase: cancellationRequested ? "cancelled" : "failed",
              message: cancellationRequested
                ? target ? "已取消凭据刷新，凭据未更改。" : "已关闭本次注册请求，未发现新保存的身份。"
                : messageOf(
                    failure ?? new Error("注册连接已结束，尚未收到保存确认。"),
                  ),
            });
          }
          reconciled = true;
        } catch (error) {
          this.job({
            id,
            type: "registerAgent",
            phase: "unresolved",
            message: `注册结果尚未确认，请重新检查后退出。${messageOf(error)}`,
          });
        }
      })().finally(() => {
        reconciliation = undefined;
      });
      return reconciliation;
    };
    this.job({
      id,
      type: "registerAgent",
      phase: "running",
      message: target ? "正在向飞书请求凭据刷新二维码。" : "正在向飞书请求注册二维码。",
    });
    const finished = this.readRegistration(
      id,
      abort.signal,
      committed,
      recordSession,
      () => cancellationRequested,
      target,
    )
      .catch((error) => {
        failure = error;
        requestRejected =
          error instanceof CoreError && error.code === "registration-refused";
      })
      .finally(() => {
        resolveSession(undefined);
        this.job({
          id,
          type: "registerAgent",
          phase: "running",
          message: "注册连接已结束，正在确认结果。",
        });
      })
      .then(async () => {
        await confirmEnd();
        await reconcile();
      })
      .catch((error) =>
        this.job({
          id,
          type: "registerAgent",
          phase: "unresolved",
          message: `注册结果尚未确认，请重试取消。${messageOf(error)}`,
        }),
      )
      .finally(() => {
        if (reconciled) this.operations.delete(id);
      });
    this.operations.set(id, {
      abort,
      finished,
      kind: "registration",
      confirmEnd,
      reconcile,
    });
    return { kind: "started", jobId: id };
  }
  private async readRegistration(
    id: JobId,
    signal: AbortSignal,
    committed: Set<AgentId>,
    recordSession: (value: string) => void,
    isCancelling: () => boolean,
    target?: AgentId,
  ): Promise<void> {
    const response = await this.connected().request(
      target ? `/api/bots/${encodeURIComponent(target)}/refresh-qr/stream` : "/api/bots/register-qr/stream",
      { signal },
    );
    if (!response.ok) {
      try {
        await readJson(response);
      } catch (error) {
        throw new CoreError("registration-refused", messageOf(error));
      }
      throw new CoreError("registration-refused", "内核拒绝了注册请求。");
    }
    const session = response.headers.get("X-Registration-Session-Id");
    if (session) recordSession(session);
    if (!response.body)
      throw new CoreError("empty-stream", "飞书注册连接没有返回数据。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder
          .decode(chunk.value, { stream: true })
          .replace(/\r\n/g, "\n");
        if (buffer.length > 1_000_000)
          throw new CoreError("invalid-stream", "注册数据超出支持的大小。");
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const event = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
          const name = event
            .split("\n")
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const text = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!text) continue;
          const payload: unknown = JSON.parse(text);
          if (name === "done") {
            const appId = z.object({ appId: agentIdSchema }).parse(payload).appId;
            if (target && appId !== target) throw new CoreError("identity-mismatch", "刷新结果与所选 Bot 不一致。");
            committed.add(appId);
            return;
          }
          if (!signal.aborted && name === "qr") {
            const qr = z
              .object({
                qrUrl: z.string().url().max(8192),
                expireIn: z.number().positive(),
                sessionId: z.string(),
              })
              .parse(payload);
            recordSession(qr.sessionId);
            const url = registrationUrl(qr.qrUrl);
            const image = await QRCode.toDataURL(url, {
              width: 256,
              margin: 2,
            });
            if (!signal.aborted && !isCancelling()) {
              this.authorizations.set(id, url);
              this.job({
                id,
                type: "registerAgent",
                phase: "qr",
                image,
                url,
                expiresAt: Date.now() + qr.expireIn * 1000,
              });
            }
          } else if (!signal.aborted && name === "error") {
            throw new CoreError(
              "registration-failed",
              z.object({ message: z.string() }).parse(payload).message,
            );
          }
        }
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
  async cancel(id: JobId): Promise<CommandResult> {
    const operation = this.operations.get(id);
    const job = this.snapshot.jobs.find((job) => job.id === id);
    if (!operation || !job) return { kind: "cancelled" };
    try {
      if (operation.kind === "tool") {
        if (!terminal(job)) {
          await this.json(`/api/tools/codex/jobs/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          const current = await this.readToolJob(id, operation.type);
          if (current.state === "running" || current.state === "authorizing")
            throw new CoreError(
              "cancellation-pending",
              "内核尚未确认取消，请稍后重试。",
            );
          operation.abort.abort();
          await operation.finished;
          this.job({
            id,
            type: job.type,
            phase: current.state,
            message: current.message ?? "内核已确认操作结束。",
          });
        } else await operation.finished;
      } else {
        if (job.phase !== "activating" && !terminal(job)) {
          this.job({
            id,
            type: "registerAgent",
            phase: "running",
            message: "正在结束本次注册并确认结果。",
          });
          await operation.confirmEnd(true);
        }
        await operation.finished;
        if (
          this.snapshot.jobs.some(
            (item) => item.id === id && item.phase === "unresolved",
          )
        )
          await operation.reconcile();
        const latest = this.snapshot.jobs.find((item) => item.id === id);
        if (!latest || !terminal(latest))
          throw new CoreError(
            "registration-unresolved",
            "尚未确认注册结果，请重新检查后退出。",
          );
      }
      this.operations.delete(id);
      this.authorizations.delete(id);
      const latest = this.snapshot.jobs.find((item) => item.id === id);
      return latest?.phase === "succeeded"
        ? { kind: "applied", revision: this.snapshot.revision }
        : { kind: "cancelled" };
    } catch (error) {
      this.job({
        id,
        type: job.type,
        phase: "unresolved",
        message: `尚未确认操作结束。${messageOf(error)}`,
      });
      return {
        kind: "refused",
        code: "cancel-failed",
        message: messageOf(error),
      };
    }
  }
  authorization(id: JobId): string {
    const job = this.snapshot.jobs.find((job) => job.id === id);
    if (
      job?.type === "registerAgent" &&
      job.phase === "qr" &&
      job.expiresAt <= Date.now()
    ) {
      this.authorizations.delete(id);
      throw new CoreError(
        "authorization-expired",
        "二维码和注册链接已过期，请取消本次操作后重新注册。",
      );
    }
    const url = this.authorizations.get(id);
    if (url && job?.type === "registerAgent" && job.phase === "qr")
      return registrationUrl(url);
    if (url && job?.type === "loginCodex" && job.phase === "authorizing")
      return authorizationUrl(url);
    this.authorizations.delete(id);
    throw new CoreError("no-authorization", "这个操作没有等待浏览器授权。");
  }
  setLoginItem(enabled: boolean): void {
    this.publish({
      application: { ...this.snapshot.application, loginItem: enabled },
    });
  }
  showFailure(title: string, error: unknown): void {
    this.publish({
      diagnostics: [
        ...this.snapshot.diagnostics,
        { title, message: messageOf(error), status: "error" },
      ],
    });
  }
  private async inspectAgent(id: AgentId): Promise<void> {
    const value = z
      .object({
        eventConfigUrl: z.string().optional(),
        credentials: z.object({
          ok: z.boolean(),
          reason: z.string().optional(),
        }),
        connection: z.object({
          running: z.boolean(),
          connection: z.string().optional(),
        }),
        scopes: z.object({ missingRequired: z.array(z.string()).optional() }),
      })
      .parse(
        await this.json(`/api/bots/${encodeURIComponent(id)}/setup-status`),
      );
    this.publish({
      diagnostics: [
        {
          title: "飞书凭据",
          status: value.credentials.ok ? "ok" : "error",
          message:
            value.credentials.reason ??
            (value.credentials.ok ? "凭据检查通过。" : "凭据检查失败。"),
        },
        {
          title: "飞书连接",
          status:
            value.connection.connection === "connected" ? "ok" : "warning",
          message:
            value.connection.connection ??
            (value.connection.running
              ? "进程运行中，连接状态未知。"
              : "进程未运行。"),
        },
        {
          title: "飞书权限",
          eventConfigUrl: value.eventConfigUrl,
          status: value.scopes.missingRequired?.length ? "error" : value.scopes.missingRequired ? "ok" : "warning",
          message: value.scopes.missingRequired
            ? value.scopes.missingRequired.length
              ? `缺少权限：${value.scopes.missingRequired.join("、")}`
              : "必需权限检查通过。"
            : "权限检查未完成。",
        },
      ],
    });
  }
  private async diagnose(): Promise<void> {
    if (!this.host) return;
    const backend = z.object({
      name: z.string(),
      ok: z.boolean(),
      version: z.string().nullable(),
      hint: z.string().optional(),
    });
    const doctorSchema = z.object({
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
      appDir: z.string(),
      backends: z.array(backend),
    });
    const diagnosisSchema = z.object({
      backends: z.array(backend),
      eventConfigUrl: z.string().optional(),
      event: z
        .object({
          state: z.enum(["unchecked", "unpublished", "missing", "ok"]),
          reason: z.string().optional(),
          missingRequired: z.array(z.string()).optional(),
        })
        .optional(),
    });
    const results = await Promise.allSettled([
      this.json("/api/host-doctor"),
      this.json("/api/diagnosis"),
    ]);
    const diagnostics: Diagnostic[] = [];
    const doctor =
      results[0].status === "fulfilled"
        ? doctorSchema.safeParse(results[0].value)
        : undefined;
    if (doctor?.success) {
      diagnostics.push({
        title: "本机运行时",
        status: "ok",
        message: `Node ${doctor.data.node} · ${doctor.data.platform} ${doctor.data.arch}`,
      });
      this.publish({
        application: {
          ...this.snapshot.application,
          dataPath: doctor.data.appDir,
        },
      });
      for (const item of doctor.data.backends)
        diagnostics.push({
          title: item.name,
          status: item.ok ? "ok" : "warning",
          message:
            item.hint ??
            (item.ok ? `已安装 ${item.version ?? ""}` : "工具不可用。"),
        });
    } else
      diagnostics.push({
        title: "本机检查未完成",
        status: "warning",
        message:
          results[0].status === "rejected"
            ? messageOf(results[0].reason)
            : "诊断响应与支持的协议不一致。",
      });
    const diagnosis =
      results[1].status === "fulfilled"
        ? diagnosisSchema.safeParse(results[1].value)
        : undefined;
    if (diagnosis?.success) {
      const event = diagnosis.data.event;
      diagnostics.push({
        title: "飞书事件订阅",
        eventConfigUrl: diagnosis.data.eventConfigUrl,
        status: event?.state === "ok" ? "ok" : event?.state === "missing" || event?.state === "unpublished" ? "error" : "warning",
        message: !event
          ? "尚未注册 Bot。"
          : event.state === "ok"
            ? "必需事件已订阅。"
            : (event.reason ??
              (event.state === "missing"
                ? `缺少事件：${event.missingRequired?.join("、") ?? "未知"}`
                : event.state === "unpublished"
                  ? "飞书应用尚未发布。"
                  : "事件订阅尚未确认。")),
      });
    } else
      diagnostics.push({
        title: "运行诊断未完成",
        status: "warning",
        message:
          results[1].status === "rejected"
            ? messageOf(results[1].reason)
            : "诊断响应与支持的协议不一致。",
      });
    this.publish({ diagnostics });
  }
  quit(): Promise<void> {
    if (this.quitting) return this.quitting;
    if (this.lifecycle === "closed") return Promise.resolve();
    this.lifecycle = "closing";
    this.quitting = this.drainAndClose().catch((error) => {
      this.lifecycle = "open";
      this.quitting = undefined;
      this.showFailure("退出未完成", error);
      throw error;
    });
    return this.quitting;
  }
  private async drainAndClose(): Promise<void> {
    await this.lane;
    for (const id of this.operations.keys()) {
      const result = await this.cancel(id);
      if (result.kind === "refused")
        throw new CoreError(result.code, result.message);
    }
    await this.lane;
    await this.host?.close();
    if (this.poll) clearInterval(this.poll);
    this.host = undefined;
    this.lifecycle = "closed";
  }
}

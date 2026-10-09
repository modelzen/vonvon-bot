import { randomUUID } from "node:crypto";
import type { FolderToken, DesktopSnapshot } from "../shared/bridge";
import {
  collaborationReplySchema,
  collaborationRequestSchema,
  projectRecordSchema,
  type CollaborationReply,
  type CollaborationRequest,
} from "../shared/collaboration";
import type { HostHandle } from "./host";
import { CoreError, messageOf, readJson } from "./projection";
import { z } from "zod";

type Dependencies = {
  host: () => HostHandle;
  snapshot: () => DesktopSnapshot;
  resolveFolder: (token: FolderToken) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
};

const mutation = z.object({
  ok: z.literal(true),
  project: projectRecordSchema.optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  groupEffect: z.enum(["left", "transferred", "failed"]).optional(),
  warning: z.string().optional(),
  message: z.string().optional(),
});
const projectResult = z.object({ project: projectRecordSchema });
const historyResult = z.object({
  sessions: z.array(z.object({
    threadId: z.string(), chatId: z.string(), sessionId: z.string(), summary: z.string(),
    backend: z.string(), cwd: z.string(),
    createdAt: z.number(), updatedAt: z.number(), detached: z.boolean().optional(),
  })),
  threads: z.array(z.object({
    sessionId: z.string(), preview: z.string(), name: z.string().optional(),
    createdAt: z.number(), updatedAt: z.number(),
  })),
  backend: z.string(),
  threadsError: z.string().optional(),
});
const contextResult = z.object({
  threadId: z.string(),
  usage: z.object({ used: z.number(), window: z.number().nullable() }).nullable(),
  run: z.object({
    id: z.string(), goal: z.boolean(), canStop: z.boolean(),
    canEndGoal: z.boolean(), canRemind: z.boolean(), reminderRequested: z.boolean(),
  }).nullable(),
});
const shareResult = z.object({ messageId: z.string().min(1) });

const urlForGroup = (groupId: string, threadId?: string) => {
  const group = encodeURIComponent(groupId);
  const topic = threadId?.replace(/#(?:admin|guest)$/, "");
  if (topic && /^omt_[A-Za-z0-9_-]+$/.test(topic))
    return `https://applink.feishu.cn/client/thread/open?open_chat_id=${group}&open_thread_id=${encodeURIComponent(topic)}&thread_position=0`;
  return `https://applink.feishu.cn/client/chat/open?openChatId=${group}`;
};

export function createCollaborationService(deps: Dependencies) {
  const createRequests = new Map<string, string>();
  return async function collaboration(raw: CollaborationRequest): Promise<CollaborationReply> {
    const request = collaborationRequestSchema.parse(raw);
    try {
      const snapshot = deps.snapshot();
      if (snapshot.host.kind !== "connected")
        throw new CoreError("host-offline", "Bridge 服务未连接，请稍后重试。");
      if (request.action === "usage") {
        const response = await deps.host().request(
          `/api/account/codex/usage${request.force ? "?force=1" : ""}`,
          { method: "GET", signal: AbortSignal.timeout(60_000) },
        );
        return collaborationReplySchema.parse({kind: "usage", ...z.object({data: z.unknown()}).parse(await readJson(response))});
      }
      if (!snapshot.agents.some((agent) => agent.id === request.agentId && !agent.readError))
        throw new CoreError("agent-unavailable", "Bot 已变更，请刷新列表后重试。");
      if ("projectName" in request) {
        const current = snapshot.memberships.find((item) =>
          item.agentId === request.agentId && item.name === request.projectName &&
          item.groupId === request.groupId && !item.stale,
        );
        if (!current)
          throw new CoreError("stale-project", "群绑定已变更，请刷新后重试。");
      }
      if (request.action === "openGroup") {
        await deps.openExternal(urlForGroup(request.groupId, request.threadId));
        return { kind: "opened" };
      }

      const { agentId, ...rest } = request;
      let payload: Record<string, unknown> = rest;
      let createKey: string | undefined;
      if (request.action === "createProject") {
        createKey = JSON.stringify(request);
        let requestId = createRequests.get(createKey);
        if (!requestId) {
          requestId = randomUUID();
          if (createRequests.size >= 32) createRequests.delete(createRequests.keys().next().value ?? "");
          createRequests.set(createKey, requestId);
        }
        payload = {
          action: request.action,
          requestId,
          name: request.name,
          kind: request.conversation === "threads" ? "multi" : "single",
          backend: request.tool === "codex" ? "codex-appserver" : "claude-agent",
          ...(request.folder.kind === "existing"
            ? { directory: await deps.resolveFolder(request.folder.folderToken) }
            : {}),
        };
      } else if (request.action === "editProject") {
        payload = {
          action: request.action,
          projectName: request.projectName,
          chatId: request.groupId,
          expectedRevision: request.expectedRevision,
          ...(request.folderToken ? { directory: await deps.resolveFolder(request.folderToken) } : {}),
          ...(request.conversation ? { kind: request.conversation === "threads" ? "multi" : "single" } : {}),
          ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        };
      } else if ("projectName" in request) {
        payload = {
          ...rest,
          chatId: request.groupId,
        };
        delete payload.groupId;
      }

      const response = await deps.host().request(
        `/api/bots/${encodeURIComponent(agentId)}/collaboration`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(request.action === "compact" || request.action === "resume" ? 180_000 : 60_000),
        },
      );
      const rawResult = await readJson(response);
      let reply: CollaborationReply;
      switch (request.action) {
        case "project":
          reply = { kind: "project", project: projectResult.parse(rawResult).project };
          break;
        case "history":
          reply = collaborationReplySchema.parse({ kind: "history", ...historyResult.parse(rawResult) });
          break;
        case "context":
          reply = { kind: "context", ...contextResult.parse(rawResult) };
          break;
        case "shareUsage":
          reply = { kind: "applied", ...shareResult.parse(rawResult) };
          break;
        default:
          reply = { kind: "applied", ...mutation.parse(rawResult) };
      }
      if (createKey) createRequests.delete(createKey);
      return collaborationReplySchema.parse(reply);
    } catch (error) {
      return {
        kind: "refused",
        code: error instanceof CoreError ? error.code : "operation-failed",
        message: messageOf(error),
      };
    }
  };
}

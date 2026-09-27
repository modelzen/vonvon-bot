import { z } from "zod";
import { agentIdSchema, folderTokenSchema, groupIdSchema } from "./bridge";

const effort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const openIdSchema = z.string().regex(/^ou_[A-Za-z0-9_-]{1,200}$/);
const selection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z
    .object({
      kind: z.literal("explicit"),
      model: z.string().trim().min(1).max(1000),
      effort,
    })
    .strict(),
]);
const title = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      model: z.string().trim().min(1).max(1000),
      effort,
    })
    .strict(),
]);
const cli = z.object({
  agents: z.object({ claude: z.boolean(), codex: z.boolean() }),
  notifyScope: z.enum(["all", "bound_projects", "none"]),
  keepAwake: z.object({ enabled: z.boolean() }),
  approval: z.object({ enabled: z.boolean(), timeoutSeconds: z.number() }),
  taskCompletion: z.object({
    enabled: z.boolean(),
    replyEnabled: z.boolean(),
    replyTimeoutSeconds: z.number(),
  }),
  allowCache: z.object({ enabled: z.boolean(), scope: z.literal("session") }),
  presence: z.object({
    enabled: z.boolean(),
    platform: z.enum(["auto", "macos"]),
    idleThresholdSeconds: z.number(),
  }),
});
export const agentSectionSchemas = {
  cards: z.object({
    showToolCalls: z.boolean(),
    showModel: z.enum(["off", "running", "always"]),
  }),
  run: z.object({
    maxConcurrentRuns: z.number(),
    runIdleTimeoutSeconds: z.number(),
    pendingPolicy: z.enum(["steer", "queue"]),
  }),
  completion: z.object({
    mode: z.enum(["manual", "long", "failures", "always"]),
    longTaskMinutes: z.number(),
  }),
  cliBridge: cli,
  comments: z.object({ backend: z.string(), selection }),
  titles: z.object({ byBackend: z.record(title) }),
  paths: z.object({ projectsRootDir: z.string().nullable() }),
  access: z.object({ allowedChats: z.array(groupIdSchema).max(1000) }),
};
export const projectSectionSchemas = {
  permission: z.object({
    mode: z.enum(["qa", "write", "full"]),
    guestMode: z.enum(["qa", "write", "full"]),
    network: z.boolean(),
  }),
  response: z.object({ noMention: z.boolean() }),
  compact: z.object({ autoCompact: z.boolean() }),
  model: z.object({ selection }),
};
export const sessionSectionSchemas = { model: z.object({ selection }) };
export const hostSectionSchemas = {
  execution: z.object({ codexBin: z.string().nullable() }),
};

const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host") }).strict(),
  z.object({ kind: z.literal("agent"), botId: agentIdSchema }).strict(),
  z
    .object({
      kind: z.literal("project"),
      botId: agentIdSchema,
      projectName: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      botId: agentIdSchema,
      threadId: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export type SettingsScope = z.infer<typeof scope>;
const access = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("writable") }),
  z.object({
    kind: z.literal("readonly"),
    reason: z.enum(["preview", "owner-offline", "unsupported-host", "stale"]),
    message: z.string(),
  }),
]);
const effect = z.object({
  fields: z.array(z.string()),
  when: z.enum([
    "next-message",
    "next-turn",
    "task-completion",
    "new-session",
    "new-comment",
    "new-project",
    "next-hook",
    "next-presence-check",
    "restart",
    "session-rebind",
    "immediate",
  ]),
  detail: z.string(),
});
const section = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    stored: value,
    effective: value,
    revision: z.string(),
    access,
    apply: z.array(effect),
  });
const sections = <T extends Record<string, z.ZodTypeAny>>(items: T) =>
  z.object(
    Object.fromEntries(
      Object.entries(items).map(([key, value]) => [key, section(value)]),
    ) as { [K in keyof T]: ReturnType<typeof section<T[K]>> },
  );
const voice = z.object({
  enabled: z.boolean(),
  feishu: z.object({
    state: z.string(),
    message: z.string(),
    checkedAt: z.number().optional(),
    retryAt: z.number().optional(),
    issue: z.string().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
  }),
  result: z.string(),
  grantUrl: z.string(),
});
const hook = z.object({
  agent: z.enum(["claude", "codex"]),
  status: z.enum([
    "installed",
    "not_installed",
    "needs_repair",
    "conflict_agent2lark",
  ]),
  details: z.array(z.string()),
});
export const agentViewSchema = z.object({
  scope: z.object({ kind: z.literal("agent"), botId: agentIdSchema }),
  sections: sections(agentSectionSchemas),
  ownerOpenId: z.string().nullable(),
  administrators: z.object({
    openIds: z.array(z.string()),
    revision: z.string(),
  }),
  voice,
  cliRuntime: z.object({
    enabled: z.boolean(),
    running: z.boolean(),
    revision: z.string(),
    hooks: z.object({ claude: hook, codex: hook }),
    keepAwakeSupported: z.boolean(),
  }),
  commentInstructions: z.object({
    content: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("default"), text: z.string() }),
      z.object({ kind: z.literal("custom"), text: z.string() }),
    ]),
    revision: z.string(),
    maxEditLength: z.number(),
  }),
});
export const projectViewSchema = z.object({
  scope: z.object({
    kind: z.literal("project"),
    botId: agentIdSchema,
    projectName: z.string(),
  }),
  sections: sections(projectSectionSchemas),
  identity: z.object({
    chatId: z.string(),
    backend: z.string(),
    cwd: z.string(),
    kind: z.string(),
  }),
  members: z.object({ openIds: z.array(z.string()), revision: z.string() }),
});
export const sessionViewSchema = z.object({
  scope: z.object({
    kind: z.literal("session"),
    botId: agentIdSchema,
    threadId: z.string(),
  }),
  sections: sections(sessionSectionSchemas),
  identity: z.object({
    backend: z.string(),
    sessionId: z.string(),
    chatId: z.string(),
    projectName: z.string().nullable(),
  }),
});
export const hostViewSchema = z.object({
  scope: z.object({ kind: z.literal("host") }),
  sections: sections(hostSectionSchemas),
  runtime: z.object({
    codexBin: z.string().nullable(),
    fallbackCwd: z.string(),
    platform: z.string(),
    coffee: z.object({
      route: z.enum(['legacy', 'none', 'agent']),
      botId: agentIdSchema.nullable(),
      revision: z.string(),
      agents: z.array(z.object({ botId: agentIdSchema, name: z.string(), enabled: z.boolean(), hasOwner: z.boolean() })),
      hooks: z.object({ claude: hook, codex: hook }),
    }).optional(),
  }),
});
export const settingsViewSchema = z.union([
  agentViewSchema,
  projectViewSchema,
  sessionViewSchema,
  hostViewSchema,
]);
export type AgentSettingsView = z.infer<typeof agentViewSchema>;
export type ProjectSettingsView = z.infer<typeof projectViewSchema>;
export type SessionSettingsView = z.infer<typeof sessionViewSchema>;
export type HostSettingsView = z.infer<typeof hostViewSchema>;
export type SettingsView =
  | AgentSettingsView
  | ProjectSettingsView
  | SessionSettingsView
  | HostSettingsView;
export type ModelSelection = z.infer<typeof selection>;
export type TitlePolicy = z.infer<typeof title>;

const editablePatches: Record<
  SettingsScope["kind"],
  Record<string, z.ZodTypeAny>
> = {
  agent: Object.fromEntries(
    Object.entries(agentSectionSchemas).map(([key, value]) => [
      key,
      value.partial().strict(),
    ]),
  ),
  project: Object.fromEntries(
    Object.entries(projectSectionSchemas).map(([key, value]) => [
      key,
      value.partial().strict(),
    ]),
  ),
  session: { model: sessionSectionSchemas.model.partial().strict() },
  host: { execution: hostSectionSchemas.execution.partial().strict() },
};
export const editSchema = z
  .object({
    scope,
    section: z.string(),
    revision: z.string().min(1),
    patch: z.unknown(),
  })
  .strict()
  .superRefine((edit, ctx) => {
    const patch = editablePatches[edit.scope.kind][edit.section];
    if (!patch || !patch.safeParse(edit.patch).success)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unsupported settings patch",
      });
  });
export type SettingsEdit =
  | {
      [K in keyof typeof agentSectionSchemas]: {
        scope: Extract<SettingsScope, { kind: "agent" }>;
        section: K;
        revision: string;
        patch: Partial<z.infer<(typeof agentSectionSchemas)[K]>>;
      };
    }[keyof typeof agentSectionSchemas]
  | {
      [K in keyof typeof projectSectionSchemas]: {
        scope: Extract<SettingsScope, { kind: "project" }>;
        section: K;
        revision: string;
        patch: Partial<z.infer<(typeof projectSectionSchemas)[K]>>;
      };
    }[keyof typeof projectSectionSchemas]
  | {
      scope: Extract<SettingsScope, { kind: "session" }>;
      section: "model";
      revision: string;
      patch: Partial<z.infer<typeof sessionSectionSchemas.model>>;
    }
  | {
      scope: Extract<SettingsScope, { kind: "host" }>;
      section: "execution";
      revision: string;
      patch: Partial<z.infer<typeof hostSectionSchemas.execution>>;
    };
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal('setHostCliRoute'), botId: agentIdSchema.nullable(), revision: z.string() }).strict(),
  z.object({ kind: z.literal('repairHostCliHooks'), agents: z.array(z.enum(['claude', 'codex'])).min(1).max(2) }).strict(),
  z
    .object({
      kind: z.literal("setCliBridgeEnabled"),
      botId: agentIdSchema,
      enabled: z.boolean(),
      revision: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal("repairCliHooks"), botId: agentIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("voice"),
      botId: agentIdSchema,
      action: z
        .object({
          action: z.enum(["enable", "test", "disable", "refreshPermission"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("adminMember"),
      botId: agentIdSchema,
      openId: openIdSchema,
      membership: z.enum(["present", "absent"]),
      revision: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("projectMember"),
      botId: agentIdSchema,
      projectName: z.string().trim().min(1).max(1000),
      openId: openIdSchema,
      membership: z.enum(["present", "absent"]),
      revision: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("projectAudience"),
      botId: agentIdSchema,
      projectName: z.string().trim().min(1).max(1000),
      audience: z.literal("all"),
      revision: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commentInstructions"),
      botId: agentIdSchema,
      revision: z.string(),
      content: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("default") }).strict(),
        z
          .object({
            kind: z.literal("custom"),
            text: z.string().min(1).max(30000),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type SettingsAction = z.infer<typeof actionSchema>;
export const modelQuerySchema = z
  .object({
    botId: agentIdSchema,
    backend: z.string().trim().min(1).max(1000),
    purpose: z.enum(["project", "session", "comments", "titles"]),
  })
  .strict();
export type ModelQuery = z.infer<typeof modelQuerySchema>;
export const modelCatalogSchema = z.object({
  backend: z.string(),
  state: z.enum(["ready", "fallback", "unavailable"]),
  source: z.literal("backend-provided"),
  observedAt: z.string(),
  error: z.string().optional(),
  titleEfforts: z.array(effort),
  models: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      supportedEfforts: z.array(effort),
      defaultEffort: effort,
      isDefault: z.boolean(),
      hidden: z.boolean(),
    }),
  ),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export const settingsRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), scope }).strict(),
  z.object({ type: z.literal("save"), edit: editSchema }).strict(),
  z.object({ type: z.literal("act"), action: actionSchema }).strict(),
  z.object({ type: z.literal("models"), query: modelQuerySchema }).strict(),
  z
    .object({
      type: z.literal("sessions"),
      botId: agentIdSchema,
      projectName: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z.object({ type: z.literal("chooseExecutable") }).strict(),
  z
    .object({
      type: z.literal("saveExecutable"),
      token: folderTokenSchema,
      revision: z.string().min(1),
    })
    .strict(),
]);
export type ParsedSettingsRequest = z.infer<typeof settingsRequestSchema>;
export type SettingsRequest =
  | { type: "read"; scope: SettingsScope }
  | { type: "save"; edit: z.infer<typeof editSchema> }
  | { type: "act"; action: SettingsAction }
  | { type: "models"; query: ModelQuery }
  | {
      type: "sessions";
      botId: z.infer<typeof agentIdSchema>;
      projectName: string;
    }
  | { type: "chooseExecutable" }
  | { type: "saveExecutable"; token: string; revision: string };
const sectionView = z.object({
  scope,
  section: z.string(),
  value: section(z.unknown()),
});
const saveSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("saved"),
    section: sectionView,
    effects: z.array(effect),
  }),
  z.object({ kind: z.literal("conflict"), current: sectionView }),
  z.object({
    kind: z.literal("rejected"),
    fields: z.array(z.object({ field: z.string(), message: z.string() })),
  }),
  z.object({ kind: z.literal("unavailable"), reason: access }),
]);
const actionResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("saved"),
    view: z.union([agentViewSchema, projectViewSchema, hostViewSchema]),
    effects: z.array(effect),
    warnings: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("conflict"),
    view: z.union([agentViewSchema, projectViewSchema, hostViewSchema]),
  }),
  z.object({
    kind: z.literal("rejected"),
    fields: z.array(z.object({ field: z.string(), message: z.string() })),
  }),
  z.object({ kind: z.literal("unavailable"), reason: access }),
  z.object({
    kind: z.literal("diverged"),
    view: agentViewSchema,
    message: z.string(),
  }),
]);
export const settingsReplySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("view"),
    view: z.union([
      agentViewSchema,
      projectViewSchema,
      sessionViewSchema,
      hostViewSchema,
    ]),
  }),
  z.object({ kind: z.literal("saved"), result: saveSchema }),
  z.object({ kind: z.literal("acted"), result: actionResultSchema }),
  z.object({ kind: z.literal("models"), catalog: modelCatalogSchema }),
  z.object({
    kind: z.literal("sessions"),
    sessions: z.array(
      z.object({
        threadId: z.string(),
        chatId: z.string(),
        summary: z.string(),
        backend: z.string(),
        model: z.string().optional(),
        createdAt: z.number(),
        updatedAt: z.number(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("fileChosen"),
    file: z.object({ token: z.string().uuid(), displayPath: z.string() }),
  }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({
    kind: z.literal("refused"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type SettingsReply = z.infer<typeof settingsReplySchema>;

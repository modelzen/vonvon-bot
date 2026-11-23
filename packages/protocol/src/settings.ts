import { z } from "zod";
import {cardDisplayConfigSchema} from './card-display.js';
import {completionTemplateSchema} from './completion-template.js';
import { JUDGE_PROVIDER_IDS } from './decision-providers.js';
import { agentIdSchema, groupIdSchema } from "./domain.js";

/** Provider-defined effort IDs are discovered with the model catalog. */
const effort = z.string().trim().min(1).max(1000);
export const openIdSchema = z.string().regex(/^ou_[A-Za-z0-9_-]{1,200}$/);
const selection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z
    .object({
      kind: z.literal("explicit"),
      model: z.string().trim().min(1).max(1000),
      effort,
      /** a hand-typed id, not checked against the model list (product.md 3.11) */
      custom: z.boolean().optional(),
    })
    .strict(),
]);
const speed = z.object({ tier: z.enum(["inherit", "standard", "fast", "ultrafast"]) });
const sessionSpeed = z.object({ tier: z.enum(["standard", "fast", "ultrafast"]) });
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
const globalTitle = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), backend: z.string().trim().min(1).max(1000), model: z.string().trim().min(1).max(1000), effort }).strict(),
]);
/**
 * The smart-mode judge model of a layer (s23d, product.md 3.4). `default` removes the layer: the bot
 * then judges on each backend's default small model. A group reset stores a host-default marker;
 * legacy groups without a stored marker retain their existing Bot/backend inheritance. `llm`, a language
 * model: `backend` says whose model id it is; left out, the group's backend, or the bot's default
 * backend for the bot. `decision`, a decision model: no backend, it applies to groups on every
 * backend (s23f lists and calls them).
 */
const judgeKinds = {
  default: z.object({ kind: z.literal("default") }),
  llm: z.object({
    kind: z.literal("llm"),
    backend: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(1000),
    effort: effort.optional(),
    /** a hand-typed id, not checked against the model list (product.md 3.11) */
    custom: z.boolean().optional(),
  }),
  decision: z.object({
    kind: z.literal("decision"),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(1000),
  }),
  provider: z.object({ kind: z.literal("provider"), provider: z.enum(JUDGE_PROVIDER_IDS) }),
};
const judgeSelection = z.discriminatedUnion("kind", [
  judgeKinds.default.strict(),
  judgeKinds.llm.strict(),
  judgeKinds.decision.strict(),
  judgeKinds.provider.strict(),
]);
export const judgeSectionSchema = z.object({ selection: judgeSelection });
/** The judge kinds this version knows; a view carries others as sent. */
export const JUDGE_SELECTION_KINDS: readonly string[] = Object.keys(judgeKinds);
/** In a view, a kind this client does not know (a newer daemon, v1-plan 第 5 节"旧客户端读到决策模型")
 * parses as sent, so the rest of the view still shows; a known kind with extra fields drops them. */
const judgeViewSection = z.object({
  selection: z.union([
    z.discriminatedUnion("kind", [judgeKinds.default, judgeKinds.llm, judgeKinds.decision, judgeKinds.provider]),
    z
      .object({ kind: z.string().min(1).max(100).refine((kind) => !JUDGE_SELECTION_KINDS.includes(kind)) })
      .passthrough(),
  ]),
});
/** What the judge prompt is, read only: SMART.md, the format lines vonvon adds, a sample input. */
const smartPrompt = z.object({
  source: z.enum(["default", "bot", "group"]),
  /** the file to make or edit: the group's for a group, the bot's for the bot */
  path: z.string(),
  text: z.string(),
  formatLines: z.object({ main: z.string(), mentioned: z.string().optional(), topic: z.string() }),
  inputExample: z.string(),
  /** what else the backend's model sees */
  backendNote: z.string().optional(),
  maxLength: z.number(),
  /** SMART.md exists but cannot be used: judgements fail until it is fixed */
  error: z.string().optional(),
});
export const profile = z.object({ persona: z.string().max(30000), memory: z.string().max(30000) });
/** 角色设定（记忆设计 2.3）：`SOUL.md` 的两段。读取不卡长度（旧文件可以很长），写入的上限由 daemon 查。 */
export const roleSettings = z.object({ identity: z.string().max(70000), notes: z.string().max(70000) });
export const WORK_RULES_MAX_BYTES = 1024 * 1024;
export const workRulesSchema = z.string().refine(value => new TextEncoder().encode(value).byteLength <= WORK_RULES_MAX_BYTES,
  { message: `工作规则最多 ${WORK_RULES_MAX_BYTES} UTF-8 字节` });
/** 补充职责与仅用于群执行的工作规则。 */
const projectRole = z.object({ supplement: z.string().max(30000), workRules: workRulesSchema.optional() });
const groupProfile = profile.extend({ inheritPersona: z.boolean(), inheritMemory: z.boolean() });
const modelAccess = z.object({
  backend: z.string().min(1).max(1000),
  models: z.array(z.string().trim().min(1).max(1000)).max(1000),
  efforts: z.array(effort).max(1000),
  modelEfforts: z.record(z.string(), z.array(effort).max(1000)).optional(),
  modelServiceTiers: z.record(z.string(), z.array(z.enum(['fast', 'ultrafast'])).max(2)).optional(),
  defaultModel: z.string().trim().min(1).max(1000).optional(),
  defaultEffort: effort.optional(),
});
const workspace = z.object({ primary: z.string().min(1).max(4096), directories: z.array(z.string().min(1).max(4096)).min(1).max(1000), repositories: z.array(z.string().min(1).max(4096)).max(1000) });
const smartRules = z.object({ respond: z.string().max(30000), newTopic: z.string().max(30000) });
const skills = z.object({ disabledPaths: z.array(z.string().min(1).max(4096)).max(1000) });
const presentation = z.object({ voiceEnabled: z.boolean(), showToolCalls: z.boolean(), showModel: z.enum(["off", "running", "always"]).optional(), completionMode: z.enum(["manual", "long", "failures", "always"]), longTaskMinutes: z.number().int().min(1).max(1440), completionTemplate: completionTemplateSchema.nullable().optional(), cardDisplay: cardDisplayConfigSchema.nullable().optional() });
export const agentSectionSchemas = {
  profile,
  role: roleSettings,
  run: z.object({
    maxConcurrentRuns: z.number(),
    runIdleTimeoutSeconds: z.number(),
    pendingPolicy: z.enum(["steer", "queue"]),
  }),
  completion: z.object({
    mode: z.enum(["manual", "long", "failures", "always"]),
    longTaskMinutes: z.number(),
  }),
  comments: z.object({ backend: z.string(), selection }),
  titles: z.object({ policy: globalTitle }),
  paths: z.object({ projectsRootDir: z.string().nullable() }),
  access: z.object({ allowedChats: z.array(groupIdSchema).max(1000) }),
  judge: judgeSectionSchema,
};
const tier = z.enum(["qa", "write", "full"]);
export const permissionTierSchema = z.object({
  tier, name: z.string(), summary: z.string(), native: z.string(), unavailable: z.string().optional(),
  /** A group's 完全访问 tier carries `FULL_ACCESS_WARNING` (devices 第 15 节). */
  warning: z.string().optional(),
});
export const permissionFieldSchema = z.object({
  key: z.string(), label: z.string(), native: z.string(), kind: z.enum(["choice", "switch", "domains"]),
  choices: z.array(z.object({ value: z.string(), label: z.string(), native: z.string(), hint: z.string().optional() }).strict()).optional(),
  hint: z.string().optional(),
  showWhen: z.object({ key: z.string(), in: z.array(z.union([z.string(), z.boolean()])) }).strict().optional(),
}).strict();
export const permissionOptionsSchema = z.object({
  tiers: z.array(permissionTierSchema).length(3),
  strength: z.string(),
  fields: z.array(permissionFieldSchema),
  expanded: z.object({ qa: z.record(z.string(), z.unknown()), write: z.record(z.string(), z.unknown()), full: z.record(z.string(), z.unknown()) }).strict(),
  customSummary: z.string().optional(),
  legacy: z.boolean().optional(),
  invalid: z.boolean().optional(),
});
/** What a save may set in a group's settings; the view adds the deprecated `permission.guestMode`. */
export const projectEditableSchemas = {
  profile: groupProfile, role: projectRole, modelAccess, workspace, smartRules, skills, presentation,
  permission: z.object({ mode: tier, custom: z.record(z.string(), z.unknown()).nullable() }),
  response: z.object({ noMention: z.boolean() }),
  /** A private chat's only: 智能 or 单会话. A group's is changed with the group, not here. */
  conversation: z.object({ mode: z.enum(["smart", "single"]) }),
  model: z.object({ selection }),
  speed,
  /** 运行中来了消息 for this group; stored "default" inherits the bot's `run.pendingPolicy` */
  run: z.object({ pendingPolicy: z.enum(["default", "steer", "queue"]) }),
  judge: judgeSectionSchema,
};
export const projectSectionSchemas = {
  ...projectEditableSchemas,
  permission: projectEditableSchemas.permission.extend({
    /** @deprecated since s15c always equal to `mode`, never saved; kept so clients from before s15c still parse the view */
    guestMode: tier,
    /** @deprecated s31c: networking follows the tier; this is the effect for old clients. */
    network: z.boolean(),
    options: permissionOptionsSchema,
  }),
};
export const sessionSectionSchemas = { model: z.object({ selection }), speed: sessionSpeed };
export const hostSectionSchemas = {
  execution: z.object({ codexBin: z.string().nullable() }),
  judge: z.object({ defaultProvider: z.enum(JUDGE_PROVIDER_IDS).optional(), byProvider: z.record(z.string(), z.object({ model: z.string().trim().min(1).max(1000), effort: effort.optional(), custom: z.boolean().optional(), endpoint: z.string().trim().max(2048).optional() })) }),
};

/** A session's Feishu thread id; the CLI checks `--session` with it before connecting. */
export const sessionThreadIdSchema = z.string().trim().min(1).max(1000);
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
      threadId: sessionThreadIdSchema,
    })
    .strict(),
]);
export type SettingsScope = z.infer<typeof scope>;
const access = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("writable") }),
  z.object({
    kind: z.literal("readonly"),
    /** `not-dm`: a Bot's group session reads its group's settings, which only a private chat changes (devices 5.2).
     * `dm-fixed`: a section the private chat does not have, whoever asks (dm-agent 4.2). */
    reason: z.enum(["preview", "owner-offline", "unsupported-host", "stale", "not-dm", "dm-fixed"]),
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
/** The decision models this daemon can call (s23f), and whether this machine has each one's key: what a judge model
 * picker lists. A daemon from before s23f sends none. */
const decisionModels = z
  .array(
    z.object({
      provider: z.string(),
      displayName: z.string(),
      models: z.array(z.object({ id: z.string(), displayName: z.string() })),
      /** its name in the keystore (`vonvon secrets set <keyId>`) */
      keyId: z.string(),
      keySet: z.boolean(),
      /** the keystore could not be read: keySet is false and says nothing */
      keyUnreadable: z.boolean().optional(),
      endpointConfigured: z.boolean().optional(),
    }),
  )
  .optional();
/** Someone who may be made an administrator (dm-agent 3.4): the creator, whom Feishu names, or who was turned away from a private chat. */
export const adminCandidateSchema = z.object({
  openId: openIdSchema,
  name: z.string(),
  sources: z.array(z.enum(["creator", "feishu", "refused"])),
  /** when they were last turned away; set with `refused` */
  at: z.number().optional(),
});
export type AdminCandidate = z.infer<typeof adminCandidateSchema>;
export const agentViewSchema = z.object({
  scope: z.object({ kind: z.literal("agent"), botId: agentIdSchema }),
  /** `judge`, `smartPrompt` and `judgeByBackend` came in s23d: a daemon from before sends none. */
  sections: sections(agentSectionSchemas).extend({ profile: section(profile).optional(), role: section(roleSettings).optional(), judge: section(judgeViewSection).optional() }),
  /** `role` came with the memory redesign (P3): a daemon from before sends none. */
  roleInfo: z
    .object({
      /** 身份与职责的草稿，只用飞书应用名；只在编辑器里，主人点保存才写进文件 */
      draft: z.string().optional(),
      /** SOUL.md 里有两个标题之一；没有就是旧文件，整份显示成其他说明 */
      headed: z.boolean(),
      /** 旧文件或合并来的文字超过写入上限：能打开，提示精简 */
      oversized: z.boolean(),
      /** 原来 AGENTS.md 里的内容已并到其他说明末尾，编辑器提示一次 */
      mergedNotice: z.boolean(),
      /** SOUL.md 是不是在 vonvon 之外被改过（只是告警） */
      integrity: z.enum(["ok", "untracked", "changed"]),
    })
    .optional(),
  smartPrompt: smartPrompt.optional(),
  /** per backend, what this bot's groups on it judge with: the bot has no backend of its own */
  judgeByBackend: z
    .record(
      z.object({
        model: z.string(),
        effort: effort.optional(),
        /** set for a decision model */
        provider: z.string().optional(),
        source: z.enum(["bot", "default"]),
      }),
    )
    .optional(),
  decisionModels,
  ownerOpenId: z.string().nullable(),
  administrators: z.object({
    openIds: z.array(z.string()),
    /** The name Feishu gave each person on the list; one it would not name has no entry. Absent from an older daemon. */
    names: z.record(z.string()).optional(),
    /** Who may be picked to join the list, the people on it left out. Absent from an older daemon. */
    candidates: z.array(adminCandidateSchema).optional(),
    revision: z.string(),
  }),
  voice,
  commentInstructions: z.object({
    content: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("default"), text: z.string() }),
      z.object({ kind: z.literal("custom"), text: z.string() }),
    ]),
    revision: z.string(),
    maxEditLength: z.number(),
  }),
});
/** A bounded, observed group roster; the saved response list is independent of this read. */
export const responseRosterSchema = z.object({
  state: z.enum(["complete", "partial", "unavailable"]),
  entries: z.array(z.object({ openId: z.string(), name: z.string(), kind: z.enum(["person", "bot"]) })),
  otherBots: z.boolean(),
});
export type ResponseRoster = z.infer<typeof responseRosterSchema>;

export const projectViewSchema = z.object({
  /** Distinguishes the stored host-default marker from an older absent group override. */
  judgeInheritsHostDefault: z.boolean().optional(),
  botProfile: profile.optional(),
  skillsError: z.string().optional(),
  skills: z.array(z.object({ path: z.string(), name: z.string(), description: z.string(), source: z.enum(["workspace", "user", "provider"]), enabled: z.boolean() })).optional(),
  scope: z.object({
    kind: z.literal("project"),
    botId: agentIdSchema,
    projectName: z.string(),
  }),
  /** `run` came in s21, `judge` and `smartPrompt` in s23d: a daemon from before sends none, and this view still parses. */
  sections: sections(projectSectionSchemas).extend({
    profile: section(groupProfile).optional(), role: section(projectRole).optional(), modelAccess: section(modelAccess).optional(), workspace: section(workspace).optional(), smartRules: section(smartRules).optional(), skills: section(skills).optional(), presentation: section(presentation).optional(),
    run: section(projectSectionSchemas.run).optional(),
    conversation: section(projectSectionSchemas.conversation).optional(),
    speed: section(speed).optional(),
    judge: section(judgeViewSection).optional(),
  }),
  smartPrompt: smartPrompt.optional(),
  decisionModels,
  identity: z.object({
    chatId: z.string(),
    backend: z.string(),
    cwd: z.string(),
    kind: z.string(),
    /** Set when both restricted tiers are unavailable on this host. */
    fullOnly: z.string().optional(),
  }),
  members: z.object({ openIds: z.array(z.string()), revision: z.string(), roster: responseRosterSchema.optional() }),
});
export const sessionViewSchema = z.object({
  scope: z.object({
    kind: z.literal("session"),
    botId: agentIdSchema,
    threadId: z.string(),
  }),
  sections: sections(sessionSectionSchemas).extend({ speed: section(speed).optional() }),
  identity: z.object({
    backend: z.string(),
    sessionId: z.string(),
    chatId: z.string(),
    projectName: z.string().nullable(),
  }),
});
export const hostViewSchema = z.object({
  scope: z.object({ kind: z.literal("host") }),
  sections: sections(hostSectionSchemas).partial({ judge: true }),
  runtime: z.object({
    codexBin: z.string().nullable(),
    fallbackCwd: z.string(),
    platform: z.string(),
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
export type GlobalTitlePolicy = z.infer<typeof globalTitle>;
export type JudgeSelection = z.infer<typeof judgeSelection>;
/** A view's judge selection: a known kind, or one this client does not know, as sent. */
export type JudgeSelectionView = z.infer<typeof judgeViewSection>["selection"];
/** Whether a view's judge selection is a kind this version knows. Check it before comparing `kind`:
 * the other branch's `kind: string` matches every literal, so `kind === "llm"` alone leaves the
 * fields `unknown`. A parsed view's known kind always has its fields (judgeViewSection). */
export function isKnownJudgeSelection(selection: JudgeSelectionView): selection is JudgeSelection {
  return JUDGE_SELECTION_KINDS.includes(selection.kind);
}
export type SmartPromptView = z.infer<typeof smartPrompt>;
export type DecisionModelsView = NonNullable<z.infer<typeof decisionModels>>;

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
    Object.entries(projectEditableSchemas).map(([key, value]) => [
      key,
      value.partial().strict(),
    ]),
  ),
  session: { model: sessionSectionSchemas.model.partial().strict(), speed: sessionSpeed.partial().strict() },
  host: { execution: hostSectionSchemas.execution.partial().strict(), judge: hostSectionSchemas.judge.partial().strict() },
};
// Old clients may submit one backend's title settings; the owner promotes it to
// the global policy. Views expose only the single policy used by new clients.
editablePatches.agent.titles = z.union([
  agentSectionSchemas.titles.partial().strict(),
  z.object({byBackend: z.record(title).refine(value => Object.keys(value).length === 1 && Object.keys(value).every(key => !['__proto__', 'constructor', 'prototype'].includes(key)))}).strict(),
]);
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
      [K in keyof typeof projectEditableSchemas]: {
        scope: Extract<SettingsScope, { kind: "project" }>;
        section: K;
        revision: string;
        patch: Partial<z.infer<(typeof projectEditableSchemas)[K]>>;
      };
    }[keyof typeof projectEditableSchemas]
  | {
      [K in keyof typeof sessionSectionSchemas]: {
        scope: Extract<SettingsScope, { kind: "session" }>;
        section: K;
        revision: string;
        patch: Partial<z.infer<(typeof sessionSectionSchemas)[K]>>;
      };
    }[keyof typeof sessionSectionSchemas]
  | {
      scope: Extract<SettingsScope, { kind: "host" }>;
      section: "execution";
      revision: string;
      patch: Partial<z.infer<typeof hostSectionSchemas.execution>>;
    }
  | {
      scope: Extract<SettingsScope, { kind: "host" }>;
      section: "judge";
      revision: string;
      patch: Partial<z.infer<typeof hostSectionSchemas.judge>>;
    };
export const actionSchema = z.discriminatedUnion("kind", [
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
    refresh: z.boolean().optional(),
    botId: agentIdSchema,
    backend: z.string().trim().min(1).max(1000),
    purpose: z.enum(["project", "session", "comments", "titles", "judge"]),
    threadId: z.string().trim().min(1).max(1000).optional(),
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
      serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).optional(),
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
    };
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
    /** Shown with the saved notice, as when a group turns 完全访问. */
    warnings: z.array(z.string()).optional(),
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
    view: z.union([agentViewSchema, projectViewSchema]),
    effects: z.array(effect),
    warnings: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("conflict"),
    view: z.union([agentViewSchema, projectViewSchema]),
  }),
  z.object({
    kind: z.literal("rejected"),
    fields: z.array(z.object({ field: z.string(), message: z.string() })),
  }),
  z.object({ kind: z.literal("unavailable"), reason: access }),
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

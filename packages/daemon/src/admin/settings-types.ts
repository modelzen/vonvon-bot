import type { BotProfile, GroupProfile, ProjectModelAccess, ProjectWorkspace, ProjectSmartRules, ProjectSkills, ProjectPresentation } from '../project/registry';
import type { ModelInfo, PermissionMode, ReasoningEffort } from '../agent/types';
import type { NativeField, TierInfo } from '../agent/permission';
import type { PendingPolicy, ResolvedCompletionReminderConfig } from '../config/schema';
import type { VoiceAction, VoiceView } from '../voice/types';
import type { JudgeModels, JudgeProvider } from '../judge/global-models';
export type SettingsScope = {
  kind: 'host';
} | {
  kind: 'agent';
  botId: string;
} | {
  kind: 'project';
  botId: string;
  projectName: string;
} | {
  kind: 'session';
  botId: string;
  threadId: string;
};
export type BotSettingsScope = Exclude<SettingsScope, {
  kind: 'host';
}>;
export type ModelSelection = {
  kind: 'default';
} | {
  kind: 'explicit';
  model: string;
  effort: ReasoningEffort;
  /** a hand-typed id, not checked against the model list (product.md 3.11) */
  custom?: boolean;
};
export type SpeedSetting = { tier: 'inherit' | 'standard' | 'fast' | 'ultrafast' };
export type SessionSpeedSetting = { tier: 'standard' | 'fast' | 'ultrafast' };
/** The judge model of a layer; group `default` follows the host while Bot `default` removes its override. */
export type JudgeSelection = {
  kind: 'default';
} | {
  kind: 'llm';
  backend?: string;
  model: string;
  effort?: ReasoningEffort;
  custom?: boolean;
} | {
  kind: 'decision';
  provider: string;
  model: string;
} | {
  kind: 'provider';
  provider: JudgeProvider;
};
/** What a view shows: a known kind, or a stored kind this version does not know, as stored (never saved). */
export type JudgeSelectionView = JudgeSelection | {
  kind: string;
  [key: string]: unknown;
};
/** The decision models a daemon calls and whether each key is filled in (s23f); see the protocol's decisionModels. */
export type DecisionModelsView = Array<{
  provider: string;
  displayName: string;
  models: Array<{ id: string; displayName: string }>;
  keyId: string;
  keySet: boolean;
  /** the keystore could not be read, so whether the key is in is not known (keySet false) */
  keyUnreadable?: boolean;
  /** Only custom services need a machine-wide request endpoint in addition to a key. */
  endpointConfigured?: boolean;
}>;
export interface SmartPromptView {
  source: 'default' | 'bot' | 'group';
  path: string;
  text: string;
  formatLines: { main: string; topic: string; mentioned?: string };
  inputExample: string;
  backendNote?: string;
  maxLength: number;
  error?: string;
}
export type TitlePolicy = {
  enabled: false;
} | {
  enabled: true;
  model: string;
  effort: ReasoningEffort;
};
export type GlobalTitlePolicy = { enabled: false } | (Extract<TitlePolicy, { enabled: true }> & { backend: string });
export interface AgentSections {
  profile: BotProfile;
  /** 角色设定：SOUL.md 的身份与职责、其他说明（记忆设计 2.3） */
  role: { identity: string; notes: string };
  run: {
    maxConcurrentRuns: number;
    runIdleTimeoutSeconds: number;
    pendingPolicy: PendingPolicy;
  };
  completion: Pick<ResolvedCompletionReminderConfig, 'mode' | 'longTaskMinutes'>;
  comments: {
    backend: string;
    selection: ModelSelection;
  };
  titles: {
    policy: GlobalTitlePolicy;
  };
  paths: {
    projectsRootDir: string | null;
  };
  access: {
    allowedChats: string[];
  };
  judge: {
    selection: JudgeSelectionView;
  };
}
export interface ProjectSections {
  profile: GroupProfile;
  /** 补充职责：绑定行的 `supplement`（P4a 之前和 `profile.persona` 双写） */
  role: { supplement: string; workRules?: string };
  modelAccess: ProjectModelAccess;
  workspace: ProjectWorkspace;
  smartRules: ProjectSmartRules;
  skills: ProjectSkills;
  presentation: ProjectPresentation;
  permission: {
    mode: PermissionMode;
    custom: Record<string, unknown> | null;
    /** @deprecated since s15c always equal to `mode`, never saved; kept so clients from before s15c still parse the view */
    guestMode: PermissionMode;
    network: boolean;
    options: {
      tiers: TierInfo[];
      strength: string;
      fields: NativeField[];
      expanded: Record<PermissionMode, Record<string, unknown>>;
      customSummary?: string;
      legacy?: boolean;
      invalid?: boolean;
    };
  };
  response: {
    noMention: boolean;
  };
  /** A private chat's only: 智能 or 单会话. A group's is changed with the group, not here. */
  conversation: { mode: 'smart' | 'single' };
  model: {
    selection: ModelSelection;
  };
  speed: SpeedSetting;
  /** 运行中来了消息: 'default' (stored only) inherits the bot's; effective is what runs. */
  run: {
    pendingPolicy: 'default' | PendingPolicy;
  };
  judge: {
    selection: JudgeSelectionView;
  };
}
export interface SessionSections {
  model: {
    selection: ModelSelection;
  };
  speed: SessionSpeedSetting;
}
export interface HostSections {
  execution: {
    codexBin: string | null;
  };
  judge: JudgeModels;
}
export type SettingsAccess = {
  kind: 'writable';
} | {
  kind: 'readonly';
  reason: 'preview' | 'owner-offline' | 'unsupported-host' | 'stale' | 'dm-fixed';
  message: string;
};
export interface ApplyEffect {
  fields: string[];
  when: 'next-message' | 'next-turn' | 'task-completion' | 'new-session' | 'new-comment' | 'new-project' | 'restart' | 'session-rebind' | 'immediate';
  detail: string;
}
export interface SettingsSection<T> {
  stored: T;
  effective: T;
  revision: string;
  access: SettingsAccess;
  apply: ApplyEffect[];
}
type Sections<M> = {
  [K in keyof M]: SettingsSection<M[K]>;
};
/** Someone who may be made an administrator (dm-agent 3.4). */
export interface AdminCandidate {
  openId: string;
  name: string;
  sources: ('creator' | 'feishu' | 'refused')[];
  /** when they were last turned away; set with `refused` */
  at?: number;
}
export interface AgentSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'agent';
  }>;
  sections: Sections<Omit<AgentSections, 'profile' | 'role'>> & Partial<Sections<Pick<AgentSections, 'profile' | 'role'>>>;
  roleInfo?: { draft?: string; headed: boolean; oversized: boolean; mergedNotice: boolean; integrity: 'ok' | 'untracked' | 'changed' };
  ownerOpenId: string | null;
  administrators: {
    openIds: string[];
    /** the name Feishu gave each person on the list; one it would not name has no entry */
    names?: Record<string, string>;
    /** who may be picked to join the list, the people on it left out */
    candidates?: AdminCandidate[];
    revision: string;
  };
  voice: VoiceView;
  commentInstructions: {
    content: {
      kind: 'default';
      text: string;
    } | {
      kind: 'custom';
      text: string;
    };
    revision: string;
    maxEditLength: number;
  };
  smartPrompt?: SmartPromptView;
  /** per backend, what this bot's groups on it judge with */
  judgeByBackend?: Record<string, {
    model: string;
    effort?: ReasoningEffort;
    provider?: string;
    source: 'bot' | 'default';
  }>;
  decisionModels?: DecisionModelsView;
}
export interface ProjectSettingsView {
  judgeInheritsHostDefault?: boolean;
  scope: Extract<SettingsScope, {
    kind: 'project';
  }>;
  sections: Sections<Omit<ProjectSections, 'profile' | 'role' | 'modelAccess' | 'workspace' | 'smartRules' | 'skills' | 'presentation' | 'speed' | 'conversation'>> & Partial<Sections<Pick<ProjectSections, 'profile' | 'role' | 'modelAccess' | 'workspace' | 'smartRules' | 'skills' | 'presentation' | 'speed' | 'conversation'>>>;
  botProfile?: BotProfile;
  skillsError?: string;
  skills?: Array<{ path: string; name: string; description: string; source: 'workspace' | 'user' | 'provider'; enabled: boolean }>;
  identity: {
    chatId: string;
    backend: string;
    cwd: string;
    kind: string;
    /** Set when this host runs the backend only in 完全访问: the reason (AgentBackend.fullAccessOnly). */
    fullOnly?: string;
  };
  members: {
    roster?: import("@vonvon/protocol").ResponseRoster;
    openIds: string[];
    revision: string;
  };
  smartPrompt?: SmartPromptView;
  decisionModels?: DecisionModelsView;
}
export interface SessionSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'session';
  }>;
  sections: Sections<Omit<SessionSections, 'speed'>> & Partial<Sections<Pick<SessionSections, 'speed'>>>;
  identity: {
    backend: string;
    sessionId: string;
    chatId: string;
    projectName: string | null;
  };
}
export interface HostSettingsView {
  scope: {
    kind: 'host';
  };
  sections: Sections<HostSections>;
  runtime: {
    codexBin: string | null;
    fallbackCwd: string;
    platform: string;
  };
}
export type SettingsView = AgentSettingsView | ProjectSettingsView | SessionSettingsView | HostSettingsView;
type SectionEdit<S, M> = {
  [K in keyof M]: {
    scope: S;
    section: K;
    revision: string;
    patch: Partial<M[K]>;
  };
}[keyof M];
/** What a save may set in a group's settings: the view's `permission.guestMode` is output only. */
type ProjectEdits = Omit<ProjectSections, 'permission'> & { permission: Pick<ProjectSections['permission'], 'mode' | 'custom'> };
type AgentEdits = Omit<AgentSections, 'titles'> & { titles: { policy: GlobalTitlePolicy; byBackend?: Record<string, TitlePolicy> } };
export type BotSettingsEdit = SectionEdit<AgentSettingsView['scope'], AgentEdits> | SectionEdit<ProjectSettingsView['scope'], ProjectEdits> | SectionEdit<SessionSettingsView['scope'], SessionSections>;
export type SettingsEdit = BotSettingsEdit | SectionEdit<HostSettingsView['scope'], HostSections>;
type SectionView<S, M> = {
  [K in keyof M]: {
    scope: S;
    section: K;
    value: SettingsSection<M[K]>;
  };
}[keyof M];
export type SettingsSectionView = SectionView<AgentSettingsView['scope'], AgentSections> | SectionView<ProjectSettingsView['scope'], ProjectSections> | SectionView<SessionSettingsView['scope'], SessionSections> | SectionView<HostSettingsView['scope'], HostSections>;
export interface SettingsFieldError {
  field: string;
  message: string;
}
export type SettingsSave = {
  kind: 'saved';
  section: SettingsSectionView;
  effects: ApplyEffect[];
  /** 给群选了完全访问时带 `FULL_ACCESS_WARNING`（devices 第 15 节）。 */
  warnings?: string[];
} | {
  kind: 'conflict';
  current: SettingsSectionView;
} | {
  kind: 'rejected';
  fields: SettingsFieldError[];
} | {
  kind: 'unavailable';
  reason: SettingsAccess;
};
export type SettingsAction = {
  kind: 'voice';
  botId: string;
  action: VoiceAction;
} | {
  kind: 'adminMember';
  botId: string;
  openId: string;
  membership: 'present' | 'absent';
  revision: string;
} | {
  kind: 'projectMember';
  botId: string;
  projectName: string;
  openId: string;
  membership: 'present' | 'absent';
  revision: string;
} | {
  kind: 'projectAudience';
  botId: string;
  projectName: string;
  audience: 'all';
  revision: string;
} | {
  kind: 'commentInstructions';
  botId: string;
  revision: string;
  content: {
    kind: 'custom';
    text: string;
  } | {
    kind: 'default';
  };
};
export type SettingsActionResult = {
  kind: 'saved';
  view: AgentSettingsView | ProjectSettingsView;
  effects: ApplyEffect[];
  warnings: string[];
} | {
  kind: 'conflict';
  view: AgentSettingsView | ProjectSettingsView;
} | {
  kind: 'rejected';
  fields: SettingsFieldError[];
} | {
  kind: 'unavailable';
  reason: SettingsAccess;
};
export interface ModelQuery {
  refresh?: boolean;
  botId: string;
  backend: string;
  purpose: 'project' | 'session' | 'comments' | 'titles' | 'judge';
  threadId?: string;
}
export interface ModelCatalog {
  backend: string;
  models: ModelInfo[];
  state: 'ready' | 'fallback' | 'unavailable';
  source: 'backend-provided';
  observedAt: string;
  error?: string;
  titleEfforts: ReasoningEffort[];
}
export interface SettingsCommitOptions { beforeCommit?: () => void; notAfter?: number }
export interface HostSettings {
  read(scope: SettingsScope): Promise<SettingsView>;
  save(edit: SettingsEdit, options?: SettingsCommitOptions): Promise<SettingsSave>;
  models(query: ModelQuery): Promise<ModelCatalog>;
  act(action: SettingsAction): Promise<SettingsActionResult>;
}

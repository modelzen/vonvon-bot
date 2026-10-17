import type { ModelInfo, PermissionMode, ReasoningEffort } from '../agent/types';
import type { ModelDisplayMode, PendingPolicy, ResolvedCompletionReminderConfig } from '../config/schema';
import type { VoiceAction, VoiceView } from '../voice/types';
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
export type TitlePolicy = {
  enabled: false;
} | {
  enabled: true;
  model: string;
  effort: ReasoningEffort;
};
export interface AgentSections {
  cards: {
    showToolCalls: boolean;
    showModel: ModelDisplayMode;
  };
  run: {
    maxConcurrentRuns: number;
    runIdleTimeoutSeconds: number;
    pendingPolicy: PendingPolicy;
  };
  completion: ResolvedCompletionReminderConfig;
  comments: {
    backend: string;
    selection: ModelSelection;
  };
  titles: {
    byBackend: Record<string, TitlePolicy>;
  };
  paths: {
    projectsRootDir: string | null;
  };
  access: {
    allowedChats: string[];
  };
}
export interface ProjectSections {
  permission: {
    mode: PermissionMode;
    /** @deprecated since s15c always equal to `mode`, never saved; kept so clients from before s15c still parse the view */
    guestMode: PermissionMode;
    network: boolean;
  };
  response: {
    noMention: boolean;
  };
  model: {
    selection: ModelSelection;
  };
  /** 运行中来了消息: 'default' (stored only) inherits the bot's; effective is what runs. */
  run: {
    pendingPolicy: 'default' | PendingPolicy;
  };
}
export interface SessionSections {
  model: {
    selection: ModelSelection;
  };
}
export interface HostSections {
  execution: {
    codexBin: string | null;
  };
}
export type SettingsAccess = {
  kind: 'writable';
} | {
  kind: 'readonly';
  reason: 'preview' | 'owner-offline' | 'unsupported-host' | 'stale';
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
export interface AgentSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'agent';
  }>;
  sections: Sections<AgentSections>;
  ownerOpenId: string | null;
  administrators: {
    openIds: string[];
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
}
export interface ProjectSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'project';
  }>;
  sections: Sections<ProjectSections>;
  identity: {
    chatId: string;
    backend: string;
    cwd: string;
    kind: string;
    /** Set when this host runs the backend only in 完全访问: the reason (AgentBackend.fullAccessOnly). */
    fullOnly?: string;
  };
  members: {
    openIds: string[];
    revision: string;
  };
}
export interface SessionSettingsView {
  scope: Extract<SettingsScope, {
    kind: 'session';
  }>;
  sections: Sections<SessionSections>;
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
type ProjectEdits = Omit<ProjectSections, 'permission'> & { permission: Omit<ProjectSections['permission'], 'guestMode'> };
export type BotSettingsEdit = SectionEdit<AgentSettingsView['scope'], AgentSections> | SectionEdit<ProjectSettingsView['scope'], ProjectEdits> | SectionEdit<SessionSettingsView['scope'], SessionSections>;
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
  botId: string;
  backend: string;
  purpose: 'project' | 'session' | 'comments' | 'titles';
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
export interface HostSettings {
  read(scope: SettingsScope): Promise<SettingsView>;
  save(edit: SettingsEdit): Promise<SettingsSave>;
  models(query: ModelQuery): Promise<ModelCatalog>;
  act(action: SettingsAction): Promise<SettingsActionResult>;
}

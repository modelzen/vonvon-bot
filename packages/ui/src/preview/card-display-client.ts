import type {VonvonClient} from '@vonvon/client/browser';
import {
  agentIdSchema,
  groupIdSchema,
  membershipIdSchema,
  type DesktopSnapshot,
  type ProjectSettingsView,
} from '@vonvon/protocol';

/** Local UI acceptance data. No daemon, Feishu connection, or configuration writes. */
const BOT_ID = agentIdSchema.parse('cli_card_display_preview');
export const CARD_PREVIEW_GROUP_ID = groupIdSchema.parse('oc_card_display_preview');
export const CARD_PREVIEW_MEMBERSHIP_ID = membershipIdSchema.parse('card-display-preview');
const PROJECT_NAME = '卡片样式验收';
const PREVIEW_MESSAGE = '此预览不修改实际设置';

const section = <T,>(stored: T) => ({
  stored,
  effective: stored,
  revision: 'preview-1',
  access: {kind: 'writable' as const},
  apply: [],
});

const projectView: ProjectSettingsView = {
  scope: {kind: 'project', botId: BOT_ID, projectName: PROJECT_NAME},
  identity: {chatId: CARD_PREVIEW_GROUP_ID, backend: 'codex-appserver', cwd: '/预览/卡片样式验收', kind: 'multi'},
  sections: {
    permission: section({
      mode: 'write', custom: null, guestMode: 'write', network: true,
      options: {
        fields: [], expanded: {qa: {}, write: {}, full: {}},
        tiers: [
          {tier: 'qa', name: '只读', summary: '查看工作区。', native: '只读'},
          {tier: 'write', name: '工作区可写', summary: '可在工作区内编辑。', native: '工作区可写'},
          {tier: 'full', name: '完全访问', summary: '完整访问。', native: '完全访问'},
        ],
        strength: '示例权限，仅用于界面验收。',
      },
    }),
    response: section({noMention: false}),
    model: section({selection: {kind: 'default'}}),
    presentation: section({voiceEnabled: false, showToolCalls: true, showModel: 'running', completionMode: 'manual', longTaskMinutes: 5}),
    run: section({pendingPolicy: 'default'}),
  },
  members: {openIds: [], revision: 'preview-1'},
};

const snapshot: DesktopSnapshot = {
  revision: 1,
  observedAt: Date.now(),
  stale: false,
  host: {kind: 'connected', ownership: 'owned', version: '界面预览'},
  agents: [{id: BOT_ID, name: '预览 Bot', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: CARD_PREVIEW_GROUP_ID, name: PROJECT_NAME}],
  memberships: [{
    id: CARD_PREVIEW_MEMBERSHIP_ID,
    agentId: BOT_ID,
    groupId: CARD_PREVIEW_GROUP_ID,
    name: PROJECT_NAME,
    directory: '/预览/卡片样式验收',
    backend: 'codex-appserver',
    conversation: 'threads',
    response: 'mention',
    permission: {administrator: 'write', member: 'write', network: true},
    enabled: true,
    stale: false,
  }],
  tools: [],
  jobs: [],
  application: {platform: 'macos', version: '界面预览', loginItem: false, dataPath: '/预览'},
};

const noEvents = () => () => {};
const unavailable = () => Promise.reject(new Error(PREVIEW_MESSAGE));

/** Give the real App a single, explicitly fictional Bot and group for UI review. */
export function createCardDisplayPreviewClient(): VonvonClient {
  return {
    snapshot: async () => snapshot,
    watchSnapshots(listener) { listener(snapshot); return () => {}; },
    run: async command => command.type === 'listPendingGroups'
      ? {kind: 'pendingGroups', groups: []}
      : {kind: 'refused', code: 'preview', message: PREVIEW_MESSAGE},
    settings: async request => request.type === 'read' && request.scope.kind === 'project'
      && request.scope.botId === BOT_ID && request.scope.projectName === PROJECT_NAME
      ? {kind: 'view', view: projectView}
      : {kind: 'refused', code: 'preview', message: PREVIEW_MESSAGE},
    collaboration: async request => request.action === 'project' && request.agentId === BOT_ID
      && request.groupId === CARD_PREVIEW_GROUP_ID && request.projectName === PROJECT_NAME
      ? {kind: 'project', project: {
        name: PROJECT_NAME, chatId: CARD_PREVIEW_GROUP_ID, cwd: '/预览/卡片样式验收',
        kind: 'multi', backend: 'codex-appserver', enabled: true, revision: 'preview-1',
      }}
      : {kind: 'refused', code: 'preview', message: PREVIEW_MESSAGE},
    environment: async request => request.type === 'backendCatalog'
      ? {kind: 'backends', entries: []}
      : {kind: 'refused', code: 'preview', message: PREVIEW_MESSAGE},
    admin: async request => request.type === 'judgeUsage'
      ? {kind: 'judgeUsage', days: [], unreadBots: 0}
      : {kind: 'refused', code: 'preview', message: PREVIEW_MESSAGE},
    memory: async request => request.type === 'newCounts'
      ? {kind: 'newCounts', projects: {}, bots: {}, dm: {}}
      : {kind: 'refused', reason: 'not-allowed', message: PREVIEW_MESSAGE},
    device: async () => ({kind: 'refused', code: 'preview', message: PREVIEW_MESSAGE}),
    schedule: async () => ({kind: 'refused', reason: 'not-found', message: PREVIEW_MESSAGE}),
    machine: unavailable,
    directory: unavailable,
    library: unavailable,
    contextPreview: unavailable,
    recipeInstall: unavailable,
    onLog: noEvents,
    onBackendInstall: noEvents,
    onDevice: noEvents,
    onDesktopUpdateRequest: noEvents,
    onError: noEvents,
    close: async () => {},
  };
}

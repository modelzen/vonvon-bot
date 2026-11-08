import type {Agent, DesktopSnapshot, Group, Membership} from '@vonvon/protocol';
import type {JudgeUsageView} from './management/JudgeUsage';
import {maskText} from './masked-text';
import type {Usage} from './management/usage-data';
import {nowDecisions, type NowDecision} from './now-activity';
import type {NowProvider} from './NowUsage';

/** now-share N5a: what the 此刻 share card is drawn from, built in the main window and passed as it is to the desktop's
 * offscreen window, which never talks to a daemon. Masking happens here: a masked name never leaves the main window. */
export const SHARE_MODEL_VERSION = 1;
/** The footer's code; the site counts the visits a share brings. */
export const SHARE_QR_URL = 'https://vonvon.cc/?utm_source=share';
const DAY = 86_400_000;

export type ShareProviderId = 'codex-appserver' | 'claude-agent';
export type ShareUsageId = ShareProviderId | 'jev';
export const SHARE_USAGE: readonly {id: ShareUsageId; name: string; icon: string; round?: boolean}[] = [
  {id: 'codex-appserver', name: 'Codex', icon: './agent-icons/codex-light.png'},
  {id: 'claude-agent', name: 'Claude Code', icon: './agent-icons/claude-code.svg'},
  {id: 'jev', name: 'Jev', icon: './agent-icons/typesafe.png', round: true},
];
/** The share dialog's switches. `usage` is in SHARE_USAGE's order. */
export type ShareOptions = {
  badges: boolean; usage: ShareUsageId[]; habits: boolean; quota: boolean; activity: boolean;
  maskGroups: boolean; maskPeople: boolean;
};
export type ShareUsage = {kind: 'provider'; id: ShareProviderId; name: string; data: Usage} | {kind: 'jev'; view: JudgeUsageView; asOf?: number};
export type ShareMembership = Pick<Membership, 'agentId' | 'groupId' | 'conversation' | 'enabled' | 'stale'>;
export type ShareModel = {
  version: typeof SHARE_MODEL_VERSION;
  /** 2026.11.08, this computer's day when it was built */
  date: string;
  team: {bots: number; groups: number};
  badges: boolean;
  /** The badge's own fields only; always sent, the Jev panel's Bot column shows their avatars too. */
  bots: Agent[]; groups: Group[]; memberships: ShareMembership[]; attentionModel?: DesktopSnapshot['attentionModel'];
  usage: ShareUsage[];
  sections: {habits: boolean; quota: boolean};
  /** Only when 群动态 is on: the latest three replies. */
  activity?: NowDecision[];
  masked: {groups: boolean; people: boolean};
  qrUrl: string;
};
export type ShareSource = {
  snapshot: DesktopSnapshot; providers: readonly NowProvider[];
  jev?: {view: JudgeUsageView; asOf?: number}; now: number;
};

/** This computer's calendar days as the usage panels date them, today last. */
function lastDays(count: number, now: number): string[] {
  const today = new Date(now), day = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Array.from({length: count}, (_, index) => new Date(day - (count - 1 - index) * DAY).toISOString().slice(0, 10));
}
/** Tokens or messages on any of the last seven days. */
export function recentlyUsed(data: Usage, now: number): boolean {
  const since = lastDays(7, now)[0]!;
  return data.profile.dailyBuckets.some(bucket => bucket.date >= since && (bucket.tokens > 0 || (bucket.messages ?? 0) > 0));
}
export const shareable = (provider: NowProvider | undefined): provider is NowProvider & {data: Usage} => !!provider?.data;

/** Owner 2026-11-08: badges on; every Provider used in the last seven days, Jev not; the rest off; both masks on. */
export function defaultShareOptions(providers: readonly NowProvider[], now: number): ShareOptions {
  const usage = SHARE_USAGE.flatMap(({id}) => {
    const provider = providers.find(item => item.id === id);
    return shareable(provider) && recentlyUsed(provider.data, now) ? [id] : [];
  });
  return {badges: true, usage, habits: false, quota: false, activity: false, maskGroups: true, maskPeople: true};
}

function shareBot(agent: Agent, maskPeople: boolean): Agent {
  const attention = agent.diagnostics?.attention;
  return {
    id: agent.id, name: agent.name, avatarDataUrl: agent.avatarDataUrl, enabled: agent.enabled, running: agent.running,
    connection: agent.connection, activation: agent.activation, badgeNumber: agent.badgeNumber, registeredAt: agent.registeredAt,
    ownerName: agent.ownerName && (maskPeople ? maskText(agent.ownerName) : agent.ownerName),
    // The badge says 配置读取失败; the error itself may name paths.
    readError: agent.readError && '配置读取失败',
    // Only the group attention the badge's back reads; not-replied records and activities stay home.
    diagnostics: attention && {notReplied: [], deniedScopes: [], attention},
  };
}

export function buildShareModel({snapshot, providers, jev, now}: ShareSource, options: ShareOptions): ShareModel {
  const name = (text: string) => options.maskGroups ? maskText(text) : text;
  const agents = new Set<string>(snapshot.agents.map(agent => agent.id));
  const seen = new Set<string>();
  const memberships = snapshot.memberships.filter(member => {
    const key = `${member.agentId}:${member.groupId}`;
    if (!agents.has(member.agentId) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const groups = [...new Set(memberships.map(member => member.groupId as string))].map(id => {
    const group = snapshot.groups.find(item => item.id === id), binding = memberships.find(member => member.groupId === id)!;
    return {id: binding.groupId, name: name(group?.name ?? binding.name), avatarDataUrl: group?.avatarDataUrl ?? binding.avatarDataUrl};
  });
  const usage = SHARE_USAGE.flatMap(({id}): ShareUsage[] => {
    if (!options.usage.includes(id)) return [];
    if (id === 'jev') return jev ? [{kind: 'jev', view: jev.view, asOf: jev.asOf}] : [];
    const provider = providers.find(item => item.id === id);
    if (!shareable(provider)) return [];
    const {displayName} = provider.data.profile;
    const data = options.maskPeople && displayName ? {...provider.data, profile: {...provider.data.profile, displayName: maskText(displayName)}} : provider.data;
    return [{kind: 'provider', id, name: provider.name, data}];
  });
  const today = new Date(now);
  return {
    version: SHARE_MODEL_VERSION,
    date: `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`,
    team: {bots: snapshot.agents.length, groups: groups.length},
    badges: options.badges,
    bots: snapshot.agents.map(agent => shareBot(agent, options.maskPeople)),
    groups,
    memberships: memberships.map(({agentId, groupId, conversation, enabled, stale}) => ({agentId, groupId, conversation, enabled, stale})),
    attentionModel: snapshot.attentionModel,
    usage,
    sections: {habits: options.habits, quota: options.quota},
    activity: options.activity ? nowDecisions(snapshot).filter(entry => entry.decision !== 'skip').slice(0, 3).map(entry => ({...entry, group: name(entry.group)})) : undefined,
    masked: {groups: options.maskGroups, people: options.maskPeople},
    qrUrl: SHARE_QR_URL,
  };
}

/** The offscreen page gets the model through the desktop as it was built; anything else is not drawn. */
export function shareModelFrom(value: unknown): ShareModel | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const model = value as Partial<ShareModel>;
  return model.version === SHARE_MODEL_VERSION && Array.isArray(model.bots) && Array.isArray(model.groups) && Array.isArray(model.memberships)
    && Array.isArray(model.usage) && typeof model.date === 'string' && typeof model.qrUrl === 'string' ? model as ShareModel : undefined;
}

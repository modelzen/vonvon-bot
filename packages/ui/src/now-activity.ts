import type {BotDecision, DesktopSnapshot} from '@vonvon/protocol';

export type NowDecision = BotDecision & {key: string; bot: string; group: string};
export const decisionLabels: Record<BotDecision['decision'], string> = {
  skip: '不接话', main: '在群内回复', reply: '在话题中回复', topic: '开新话题回复',
};

/** Trigger facts, never a generated explanation of the model's reasoning. */
export function decisionTrigger(entry: BotDecision): string {
  if (entry.trigger === 'glance') return entry.messageCount === undefined ? '查看新消息' : `查看新消息 · ${entry.messageCount} 条`;
  return {mention: '收到 @ 提及', 'bot-mention': '被其他 Bot 提及', quote: '收到引用回复', name: '被叫到名字', focus: '跟进当前讨论'}[entry.trigger];
}

/** Drop records whose Bot/group binding has since been removed. */
export function nowDecisions(snapshot: DesktopSnapshot): NowDecision[] {
  const memberships = new Set(snapshot.memberships.map(member => `${member.agentId}:${member.groupId}`));
  const groups = new Map(snapshot.groups.map(group => [group.id as string, group.name]));
  return snapshot.agents.flatMap(bot => (bot.diagnostics?.decisions ?? [])
    .filter(entry => memberships.has(`${bot.id}:${entry.groupId}`))
    .map(entry => ({...entry, key: `${bot.id}:${entry.id}`, bot: bot.name, group: groups.get(entry.groupId) ?? '群聊'})))
    .sort((a, b) => b.decidedAt - a.decidedAt || a.key.localeCompare(b.key))
    .slice(0, 30);
}

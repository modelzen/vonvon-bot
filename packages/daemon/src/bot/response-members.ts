import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { ResponseRoster } from '@vonvon/protocol';
import type { BotRoster } from './bot-roster';
import { withDeadline } from './names';

/** One bounded page per source. Failure never edits the saved response list. */
export async function readResponseRoster(channel: LarkChannel, roster: BotRoster, chatId: string): Promise<ResponseRoster> {
  const [people, bots] = await Promise.all([
    Promise.resolve().then(() => withDeadline(channel.rawClient.im.v1.chatMembers.get({
      path: { chat_id: chatId }, params: { member_id_type: 'open_id', page_size: 100 },
    }), 3_000, 'response-members')).catch(() => undefined),
    roster.load(chatId).then(() => roster.selection(chatId), () => undefined),
  ]);
  const entries = new Map<string, ResponseRoster['entries'][number]>();
  for (const [openId, bot] of bots?.bots ?? []) {
    entries.set(openId, { openId, name: bot.name || '未命名 Bot', kind: 'bot' });
  }
  const peopleOk = people?.code === 0 && Array.isArray(people.data?.items);
  if (peopleOk) for (const member of people.data?.items ?? []) {
    if (member.member_id && !entries.has(member.member_id)) {
      entries.set(member.member_id, { openId: member.member_id, name: member.name || '未命名成员', kind: 'person' });
    }
  }
  return {
    state: peopleOk && bots ? (!people.data?.has_more && bots.complete ? 'complete' : 'partial') : peopleOk || bots ? 'partial' : 'unavailable',
    entries: [...entries.values()],
    otherBots: Boolean(bots && [...bots.bots.keys()].some(id => id !== channel.botIdentity?.openId)),
  };
}

export function responseMemberLabel(member: ResponseRoster['entries'][number]): string {
  return `${member.name}${member.kind === 'bot' ? ' · Bot' : ''} · …${member.openId.slice(-6)}`;
}

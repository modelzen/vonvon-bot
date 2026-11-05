import {useEffect, useState} from 'react';
import type {AgentId, MemoryReply} from '@vonvon/protocol';
import {useClient} from './client-context';
import {newTag} from './new-counts';

export type DmPerson = Extract<MemoryReply, {kind: 'dmPeople'}>['people'][number];

/** A name when the Bot heard one, else the tail of the id: an open_id in full says nothing on a page. */
export const dmPersonLabel = (person: Pick<DmPerson, 'openId' | 'name'>): string => person.name ?? `…${person.openId.slice(-6)}`;

/** One person on the 记忆 tab. Someone taken off the list stays, with their memory (dm-agent 5), and the row says so. */
export function dmPersonRow(person: DmPerson): {title: string; meta: string} {
  return {title: dmPersonLabel(person), meta: [`${person.used} 条`, newTag(person.fresh), person.admin === false ? '已不是管理员' : ''].filter(Boolean).join(' · ')};
}

/** Whose private chat a new task can post to: an admin who has one. Someone no longer an admin would be paused at once. */
export function dmChats(people: readonly DmPerson[]): {value: string; label: string}[] {
  return people.flatMap(person => person.chatId && person.admin !== false ? [{value: person.chatId, label: dmPersonLabel(person)}] : []);
}

/** Who has a private chat with this Bot, read when opened and each time `refreshEvent` fires on `window`. `botId` undefined reads nothing. */
export function useDmPeople(botId: AgentId | string | undefined, refreshEvent?: string): {people?: DmPerson[]; error: string} {
  const client = useClient();
  const [state, setState] = useState<{people?: DmPerson[]; error: string}>({error: ''});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!refreshEvent) return;
    const listener = () => setTick(value => value + 1);
    window.addEventListener(refreshEvent, listener);
    return () => window.removeEventListener(refreshEvent, listener);
  }, [refreshEvent]);
  useEffect(() => {
    if (botId === undefined) return;
    let live = true;
    client.memory({type: 'dmPeople', botId}).then(reply => {
      if (!live) return;
      if (reply.kind === 'dmPeople') setState({people: reply.people, error: ''});
      else setState(current => ({...current, error: '读不到私聊的人。'}));
    }, (failure: unknown) => {if (live) setState(current => ({...current, error: failure instanceof Error && failure.message ? failure.message : '读不到私聊的人。'}));});
    return () => {live = false;};
  }, [client, botId, tick]);
  return state;
}

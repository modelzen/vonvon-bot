import {useState} from 'react';
import type {Agent} from '@vonvon/protocol';
import {DmContextPanel} from './ContextPanel';
import {dmPersonLabel, dmPersonRow, useDmPeople, type DmPerson} from './dm-people';
import {MEMORY_SEEN_EVENT, MemoryMap, type MemoryTargets} from './MemoryMap';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {Button, InlineNotice} from './reference/components/ui';

const NO_TARGETS: MemoryTargets = {botName: () => '这个 Bot', groupName: () => '私聊'};

/** The people rows of the 记忆 tab; the map of whoever is open comes under them. */
export function DmPeopleList({people, selected, onSelect}: {people: readonly DmPerson[]; selected?: string; onSelect: (openId: string) => void}) {
  if (!people.length) return <SettingsRow title="还没有人和这个 Bot 私聊过"/>;
  return <>{people.map(person => {
    const {title, meta} = dmPersonRow(person);
    return <SettingsRow key={person.openId} title={selected === person.openId ? <strong>{title}</strong> : title} description={meta} onClick={() => onSelect(person.openId)}/>;
  })}</>;
}

/**
 * A private chat's 记忆 tab (dm-agent 5): each person's memory on its own, for whoever talked to the Bot, admin now or not.
 * One person opens at once; of several, opening one is what marks theirs as read. A way to the Bot's memory, and no project's.
 */
export function DmMemory({agent, revision, onBotProfile}: {agent: Agent; revision?: number; onBotProfile: () => void}) {
  const {people, error} = useDmPeople(agent.id, MEMORY_SEEN_EVENT);
  const [selected, setSelected] = useState<string>();
  const only = people?.length === 1 ? people[0]?.openId : undefined;
  const person = people?.find(item => item.openId === (selected ?? only));
  return <div className="dm-memory">
    {error && <InlineNotice title="读取未完成" tone="warning">{error}</InlineNotice>}
    <SettingsGroup label="和谁私聊过" action={<Button size="sm" onClick={onBotProfile}>Bot 记忆</Button>}
      footer="每个人的记忆分开放，只在和 TA 的私聊里用。不再是管理员后，记忆还留着。">
      {people ? <DmPeopleList people={people} selected={person?.openId} onSelect={setSelected}/> : !error && <SettingsRow title="正在读取…"/>}
    </SettingsGroup>
    {person && <MemoryMap key={person.openId} scope={{kind: 'dm', botId: agent.id, openId: person.openId}} rootLabel={dmPersonLabel(person)} mode="direct" memoryLabel="私聊记忆" targets={NO_TARGETS}/>}
    {person && <details className="gd-disclosure"><summary>模型看到什么</summary>
      <DmContextPanel key={person.openId} agentId={agent.id} openId={person.openId} title={`${agent.name} · ${dmPersonLabel(person)}`} revision={revision}/>
    </details>}
  </div>;
}

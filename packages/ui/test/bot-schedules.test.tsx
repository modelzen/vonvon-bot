import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {agentIdSchema, groupIdSchema, membershipIdSchema, type DesktopSnapshot} from '@vonvon/protocol';
import {BotScheduleGroups, scheduleGroups} from '../src/BotSchedules';
import {openMembership, routeBack, type CollaborationRoute} from '../src/collaboration-navigation';
import {listOf} from '../src/schedule-model';
import {scheduleTask, tasksReply} from './schedule-fixture';

const agentId = agentIdSchema.parse('cli_schedule');
const [first, second] = [groupIdSchema.parse('oc_first'), groupIdSchema.parse('oc_second')];
const [firstMember, secondMember] = [membershipIdSchema.parse('first'), membershipIdSchema.parse('second')];
const snapshot = {
  agents: [{id: agentId, name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: first, name: '研发群'}, {id: second, name: '运营群'}],
  memberships: [[firstMember, first], [secondMember, second]].map(([id, groupId]) => ({id, agentId, groupId, name: String(id), directory: '/tmp/x', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false})),
} as unknown as DesktopSnapshot;
const tasks = [
  scheduleTask({id: 'st_1', chatId: first, name: '日报'}), scheduleTask({id: 'st_2', chatId: second, name: '周报'}),
  scheduleTask({id: 'st_3', chatId: first, name: '巡检'}), scheduleTask({id: 'st_4', chatId: second, name: '月报'}),
];
type Element = ReactElement<Record<string, any>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.trailing)] : [];

it('groups the Bot\'s four tasks of two groups under their group names', () => {
  expect(scheduleGroups(tasks, agentId, snapshot).map(group => [group.name, group.memberId, group.tasks.map(task => task.name)]))
    .toEqual([['研发群', firstMember, ['日报', '巡检']], ['运营群', secondMember, ['周报', '月报']]]);
  const html = renderToStaticMarkup(<BotScheduleGroups list={listOf(tasksReply(tasks))} agentId={agentId} snapshot={snapshot} onOpen={() => {}} onDelete={() => {}}/>);
  expect(html.indexOf('研发群')).toBeLessThan(html.indexOf('巡检'));
  expect(html).not.toContain('新建');
});

it('opens the group\'s 任务 tab from a row, and Back returns to the Bot\'s 任务 pane', () => {
  const onOpen = vi.fn();
  const rows = nodes(BotScheduleGroups({list: listOf(tasksReply(tasks)), agentId, snapshot, onOpen, onDelete: () => {}})).filter(node => node.props.onClick);
  rows.find(node => node.props.title === '周报')!.props.onClick();
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(secondMember);
  const pane: CollaborationRoute = {kind: 'agent', id: agentId, pane: {kind: 'schedule'}};
  const opened = openMembership(pane, secondMember, snapshot);
  expect(opened).toEqual({kind: 'membership', id: secondMember, pane: {kind: 'settings'}, parent: pane});
  expect(routeBack(opened)).toEqual(pane);
});

it('lists an unbound group as 已解绑的群, whose rows delete instead of opening', () => {
  const gone = scheduleTask({id: 'st_gone', chatId: 'oc_gone', name: '旧群日报', state: 'paused', pausedReason: 'unavailable', nextRunAt: undefined});
  const onDelete = vi.fn();
  const all = nodes(BotScheduleGroups({list: listOf(tasksReply([gone])), agentId, snapshot, onOpen: () => {}, onDelete}));
  expect(all.find(node => node.props.label)?.props.label).toBe('已解绑的群');
  const row = all.find(node => node.props.title === '旧群日报')!;
  expect(row.props.onClick).toBeUndefined();
  nodes(row.props.trailing).find(node => node.props.children === '删除')!.props.onClick();
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(gone);
  expect(renderToStaticMarkup(<BotScheduleGroups list={listOf(tasksReply([gone]))} agentId={agentId} snapshot={snapshot} onOpen={() => {}} onDelete={() => {}}/>)).toContain('已暂停：群已解绑');
  expect(scheduleGroups([{...gone, chatId: first}], agentIdSchema.parse('cli_other'), snapshot)[0]).toMatchObject({name: '研发群（已解绑）', memberId: undefined});
});

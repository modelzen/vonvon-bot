import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {agentIdSchema, type DesktopSnapshot, type ScheduleRunRecord} from '@vonvon/protocol';
import {BotScheduleGroups} from '../src/BotSchedules';
import {scheduleDraft, scheduleRequest} from '../src/ScheduleForm';
import {ScheduleTaskList} from '../src/ScheduleTab';
import {ScheduleRuns} from '../src/ScheduleRuns';
import {listOf, scheduleFooter, scheduleNotRunning, scheduleRunLink, scheduleState, shownZone, type ScheduleList} from '../src/schedule-model';
import {groupUrl} from '../src/url-actions';
import {scheduleNow, scheduleTask, tasksReply} from './schedule-fixture';

const render = (list: ScheduleList, notices: Record<string, string> = {}, expanded?: string) => renderToStaticMarkup(
  <ScheduleTaskList list={list} deviceTitle="这台 Mac" expanded={expanded} notices={notices} onCreate={() => {}} onAction={() => {}}/>).replaceAll('&quot;', '"');
const run = (index: number, patch: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord =>
  ({runId: `run_${index}`, slot: scheduleNow - index * 60_000, trigger: 'schedule', status: 'done', durationMs: 65_000, ...patch});

it('names the five states, and an active task 已启用 rather than 运行中', () => {
  const tasks = [
    scheduleTask(), scheduleTask({state: 'paused', pausedReason: 'manual'}), scheduleTask({state: 'paused', pausedReason: 'failures'}),
    scheduleTask({state: 'paused', pausedReason: 'unavailable'}), scheduleTask({state: 'finished'}),
  ].map((task, index) => ({...task, id: `st_${index}`, ...(task.state === 'active' ? {} : {nextRunAt: undefined})}));
  expect(tasks.map(scheduleState)).toEqual(['已启用', '已暂停：手动', '已暂停：连续失败', '已暂停：群已解绑', '已结束']);
  const html = render(listOf(tasksReply(tasks)));
  for (const state of tasks.map(scheduleState)) expect(html).toContain(state);
  expect(html).not.toContain('运行中');
  expect(html).toContain('每天 09:00 · 下次 11月2日 09:00 · 已启用');
  expect(html.match(/>恢复</g)).toHaveLength(3);
  expect(html.match(/>暂停</g)).toHaveLength(1);
});

it('gives an 已结束 task 编辑, 立即运行 and 删除 but no 恢复, which would do nothing', () => {
  const html = render(listOf(tasksReply([scheduleTask({state: 'finished', spec: {kind: 'once', at: scheduleNow - 60_000}, nextRunAt: undefined})])));
  expect(html).toContain('已结束');
  for (const button of ['编辑', '立即运行', '删除']) expect(html).toContain(`>${button}<`);
  expect(html).not.toContain('>恢复<');
  expect(html).not.toContain('>暂停<');
});

it('shows a task whose zone this browser does not know in the daemon\'s zone, names it, and keeps the form from saving the unknown one', () => {
  const at = Date.UTC(2026, 10, 2, 1, 0);
  const mars = scheduleTask({spec: {kind: 'once', at}, timeZone: 'Mars/Olympus', describe: '11月2日 09:00 一次', nextRunAt: at,
    recent: [run(0)], lastResult: {at: scheduleNow, status: 'done', excerpt: '好了'}});
  const html = render(listOf(tasksReply([mars])), {}, mars.id);
  expect(html).toContain('下次 11月2日 09:00（Asia/Shanghai） · 已启用 · 上次 完成 12:00<');
  expect(html).toContain('<td>12:00</td>');
  const snapshot = {groups: [], memberships: []} as unknown as DesktopSnapshot;
  expect(renderToStaticMarkup(<BotScheduleGroups list={listOf(tasksReply([mars]))} agentId={agentIdSchema.parse(mars.botId)} snapshot={snapshot} onOpen={() => {}} onDelete={() => {}}/>))
    .toContain('下次 11月2日 09:00（Asia/Shanghai）');
  expect(renderToStaticMarkup(<ScheduleRuns task={mars} hostZone="Asia/Tokyo" now={scheduleNow}/>)).toContain('<td>13:00</td>');
  expect(shownZone('Mars/Olympus', 'Venus/Maat')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const draft = scheduleDraft(mars, 'Asia/Shanghai');
  expect(draft).toMatchObject({when: 'once', at: '2026-11-02T09:00', timeZone: 'Mars/Olympus'});
  const context = {chatId: mars.chatId, now: scheduleNow, task: mars, initial: draft};
  expect(scheduleRequest(draft, context)).toEqual({error: '不认识这个时区：Mars/Olympus'});
  expect(scheduleRequest({...draft, timeZone: 'Asia/Shanghai'}, context)).toMatchObject({patch: {spec: {kind: 'once', at}, timeZone: 'Asia/Shanghai'}});
});

it('names the zone it had to use after 上次 when a task has no next run, active or paused, and once over its runs', () => {
  const mars = scheduleTask({timeZone: 'Mars/Olympus', nextRunAt: undefined, recent: [run(0)], lastResult: {at: scheduleNow, status: 'done', excerpt: '好了'}});
  for (const task of [mars, scheduleTask({...mars, state: 'paused', pausedReason: 'manual'})]) {
    expect(render(listOf(tasksReply([task])))).toContain(`每天 09:00 · ${scheduleState(task)} · 上次 完成 12:00（Asia/Shanghai）`);
  }
  const runs = renderToStaticMarkup(<ScheduleRuns task={mars} hostZone="Asia/Shanghai" now={scheduleNow}/>);
  expect(runs).toContain('<th scope="col">时间（Asia/Shanghai）</th>');
  expect(runs.match(/Asia\/Shanghai/g)).toHaveLength(1);
  const tokyo = {...mars, timeZone: 'Asia/Tokyo'};
  expect(render(listOf(tasksReply([tokyo])))).toContain('已启用 · 上次 完成 13:00<');
  expect(renderToStaticMarkup(<ScheduleRuns task={tokyo} hostZone="Asia/Shanghai" now={scheduleNow}/>)).toContain('<th scope="col">时间</th>');
});

it('names the task\'s zone after the next time only when the daemon\'s computer is elsewhere', () => {
  const tokyo = scheduleTask({timeZone: 'Asia/Tokyo', nextRunAt: Date.UTC(2026, 10, 2, 0, 0), lastResult: {at: Date.UTC(2026, 10, 1, 0, 0), status: 'failed', excerpt: '失败：超时'}});
  expect(render(listOf(tasksReply([tokyo])))).toContain('下次 11月2日 09:00（Asia/Tokyo） · 已启用 · 上次 失败 09:00');
  expect(render(listOf(tasksReply([tokyo], 'Asia/Tokyo')))).not.toContain('（Asia/Tokyo）');
});

it('shows the empty sentence with 新建, the footer word for word, and a refused write under its row', () => {
  const empty = render(listOf(tasksReply([])));
  expect(empty).toContain('这个群还没有任务');
  expect(empty).toContain('新建');
  expect(scheduleFooter('这台 Mac')).toBe('这台 Mac关机、睡眠，或 Vonvon 没在运行时，任务不会运行。错过的只补最近一次（7 天内），更早的记为"错过"。');
  expect(empty).toContain(scheduleFooter('这台 Mac'));
  const task = scheduleTask();
  const refused = render(listOf(tasksReply([task])), {[task.id]: scheduleNotRunning});
  expect(refused).toContain('日报');
  expect(refused).toContain(scheduleNotRunning);
});

it('replaces the page with the bot-not-running sentence, with no empty state and no 新建', () => {
  const list = listOf({kind: 'refused', reason: 'bot-not-running', message: '别的字'});
  expect(list).toEqual({kind: 'refused', message: 'Bot 没在运行，任务暂时看不到；启动后再来。'});
  const html = render(list);
  expect(html).toContain(scheduleNotRunning);
  expect(html).not.toContain('新建');
  expect(html).not.toContain('这个群还没有任务');
});

it('opens a run in Feishu by the daemon\'s link, else its topic, and only through the allowed hosts', () => {
  const link = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_schedule&position=12';
  expect(scheduleRunLink(run(0, {link}), 'oc_schedule')).toBe(link);
  expect(scheduleRunLink(run(0, {topicId: 'omt_topic'}), 'oc_schedule')).toBe(groupUrl('oc_schedule', 'omt_topic'));
  expect(scheduleRunLink(run(0), 'oc_schedule')).toBeNull();
  expect(scheduleRunLink(run(0, {link: 'https://evil.example/client/chat/open'}), 'oc_schedule')).toBeNull();
});

it('lists the last 20 runs newest first with time, status, duration and the Feishu links there are', () => {
  const recent = Array.from({length: 20}, (_, index) => run(19 - index, index % 2 ? {} : {topicId: `omt_${index}`}));
  recent[19] = run(0, {status: 'missed', count: 3, durationMs: undefined});
  const html = renderToStaticMarkup(<ScheduleRuns task={scheduleTask({recent, counts: {runs: 12, missed: 5, skipped: 2, consecutiveFailures: 0}, lastResult: {at: scheduleNow, status: 'done', excerpt: '今天合入 3 个 PR'}})} hostZone="Asia/Shanghai" now={scheduleNow}/>);
  expect(html.match(/<tr>/g)).toHaveLength(21);
  expect(html.match(/在飞书打开/g)).toHaveLength(10);
  expect(html).toContain('共运行 12 次 · 错过 5 次 · 跳过 2 次');
  expect(html).toContain('1 分 5 秒');
  expect(html.indexOf('错过 3 次')).toBeLessThan(html.indexOf('完成'));
  expect(html).toContain('今天合入 3 个 PR');
});

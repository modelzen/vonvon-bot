import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {badgeUrl} from '../src/BadgeContact';
import {agentIdSchema, desktopSnapshotSchema, membershipSchema, type Agent, type BotActivity, type GroupAttention, type Membership} from '@vonvon/protocol';
import {NowBotList, nowBotActivities} from '../src/NowBotList';
import {badgeTenure} from '../src/badge-content';
import {nowAttentionSummary, nowGroupAttention} from '../src/now-attention';

const now = new Date('2026-10-26T06:00:00Z').getTime();
const bot: Agent = {id: agentIdSchema.parse('cli_now'), name: 'Vonvon', enabled: true, running: true, connection: 'connected', activation: 'active'};
const member = membershipSchema.parse({id: '["cli_now","oc_now"]', agentId: bot.id, groupId: 'oc_now', name: '设计讨论', directory: '/tmp/now', backend: 'codex-appserver', conversation: 'smart', response: 'mention', permission: {administrator: 'full', member: 'full', network: false}, stale: false, enabled: true});
const state = (fields: Partial<GroupAttention> = {}): GroupAttention => ({groupId: member.groupId, group: {score: 50, intervalMs: 180_000, updatedAt: now}, main: {mode: 'watch', intervalMs: 180_000}, focusedTopics: 0, watchedTopics: 0, ...fields});
const withAttention = (attention: GroupAttention[] | undefined): Agent => ({...bot, diagnostics: {notReplied: [], deniedScopes: [], ...(attention === undefined ? {} : {attention})}});
const read = (fields: Partial<GroupAttention> = {}) => nowGroupAttention(withAttention([state(fields)]), member, true, false, now);
const activity = (fields: Partial<BotActivity> = {}): BotActivity => ({id: 'af563d24-6dce-4af7-a418-258d2eaf6325', groupId: member.groupId, phase: 'thinking', startedAt: now - 1000, updatedAt: now, ...fields});
const acting = (...activities: BotActivity[]): Agent => ({...withAttention([state()]), diagnostics: {notReplied: [], deniedScopes: [], attention: [state()], activities}});
const snapshot = (agent: Agent, memberships: Membership[] = [member]) => desktopSnapshotSchema.parse({
  attentionModel: 'group', revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [agent], groups: [{id: member.groupId, name: member.name}], memberships, tools: [], jobs: [],
  application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/tmp/now'},
});
const badgeActions = {onChangeNumber: async () => undefined, disabled: false, connected: true};
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(now);});
afterEach(() => {vi.useRealTimers();});

it.each([[100, 5_000, 4], [75, 60_000, 3], [50, 180_000, 2], [25, 300_000, 1], [10, 300_000, 0.4]] as const)('maps group score %i to its own meter level', (score, intervalMs, level) => {
  const reading = read({group: {score, intervalMs, updatedAt: now}});
  expect(reading).toMatchObject({score, level, showMeter: true});
  expect(reading.label).toBe(score === 100 ? '专注中' : score === 10 ? '低度留意' : '留意中');
});

it('uses the same group score regardless of main or topic legacy fields', () => {
  const reading = read({group: {score: 10, intervalMs: 300_000, updatedAt: now}, main: {mode: 'focus', intervalMs: 60_000}, focusedTopics: 2});
  expect(reading).toMatchObject({label: '低度留意', tone: 'idle', level: 0.4});
  expect(reading.description).toContain('约 20 秒');
  expect(read({main: undefined, focusedTopics: 2})).toMatchObject({score: 50, tone: 'watch', level: 2});
});

it('does not invent group attention from a legacy-only daemon record', () => {
  expect(read({group: undefined, main: {mode: 'focus', intervalMs: 60_000}, focusedTopics: 99})).toMatchObject({label: '待更新', tone: 'unknown'});
  expect(read({group: undefined}).score).toBeUndefined();
});

it('distinguishes an empty valid snapshot from missing diagnostics', () => {
  expect(nowGroupAttention(withAttention([]), member, true, false, now, true)).toMatchObject({label: '低度留意', level: 0.4, tone: 'idle'});
  expect(nowGroupAttention(withAttention(undefined), member, true, false, now)).toMatchObject({label: '待更新', tone: 'unknown'});
  expect(nowGroupAttention(bot, member, true, false, now).level).toBeUndefined();
  const wrong = {...member, agentId: agentIdSchema.parse('cli_other')};
  expect(nowGroupAttention(withAttention([state()]), wrong, true, false, now).tone).toBe('unknown');
});

it.each([
  {label: 'host disconnect', connected: false},
  {label: 'old snapshot', stale: true},
  {label: 'bot stopped', agent: {running: false}},
  {label: 'bot disabled', agent: {enabled: false}},
  {label: 'bot disconnected', agent: {connection: 'disconnected'}},
  {label: 'bot read failure', agent: {readError: 'unreadable'}},
  {label: 'member stale', membership: {stale: true}},
  {label: 'member disabled', membership: {enabled: false}},
  {label: 'member activation unknown', membership: {enabled: undefined}},
])('does not show cached attention for $label', ({agent, membership, connected = true, stale = false}) => {
  const reading = nowGroupAttention({...withAttention([state({main: {mode: 'focus', intervalMs: 60_000}})]), ...agent}, {...member, ...membership}, connected, stale, now);
  expect(reading.tone).toBe('unknown');
  expect(reading.level).toBeUndefined();
  expect(reading.label).not.toBe('专注中');
});

it.each(['no-glance', 'named-only'] as const)('keeps the real score visible while the %s budget pauses judgement', kind => {
  const reading = read({group: {score: 75, intervalMs: 60_000, updatedAt: now}, budget: {kind, until: now + 1000}});
  expect(reading).toMatchObject({score: 75, level: 3, tone: 'paused'});
  expect(reading.budgetNote).toContain(kind === 'named-only' ? '仅真人 @' : '批量查看暂缓');
});

it.each(['no-glance', 'named-only'] as const)('does not infer recovery from the expired %s budget', kind => {
  const reading = read({focusedTopics: 1, budget: {kind, until: now}});
  expect(reading).toMatchObject({label: '待更新', tone: 'unknown'});
  expect(reading.level).toBeUndefined();
});

it.each([['threads', '独立话题'], ['shared', '连续交谈']] as const)('shows %s communication without a meter', (conversation, label) => {
  expect(nowGroupAttention(bot, {...member, conversation}, true, false, now)).toMatchObject({label, showMeter: false, tone: 'mode'});
});

it('counts groups once and uses compact, factual attention summaries', () => {
  expect(nowAttentionSummary([read({group: {score: 100, intervalMs: 5_000, updatedAt: now}}), read()], 2)).toBe('专注 1 · 留意 1');
  expect(nowAttentionSummary([read({budget: {kind: 'no-glance', until: now + 1}})], 1)).toBe('1 个群');
});

it('expires activity locally and excludes disabled, stale and unrelated memberships', () => {
  const agent = acting(activity({id: 'expired', updatedAt: now - 60_000}), activity({id: 'other', groupId: 'oc_other'}), activity({id: 'fresh'}));
  expect(nowBotActivities(agent, [member], true, now).map(item => item.id)).toEqual(['fresh']);
  for (const membership of [{...member, enabled: false}, {...member, stale: true}, {...member, agentId: agentIdSchema.parse('cli_other')}]) {
    expect(nowBotActivities(agent, [membership], true, now)).toEqual([]);
  }
  for (const state of [{...agent, enabled: false}, {...agent, running: false}, {...agent, connection: 'disconnected'}, {...agent, readError: 'failed'}]) {
    expect(nowBotActivities(state, [member], true, now)).toEqual([]);
  }
  expect(nowBotActivities(agent, [member], false, now)).toEqual([]);
});

it('keeps a long-running tool live through heartbeats without making it the newest action', () => {
  const older = activity({id: 'older', phase: 'tool', updatedAt: now - 120_000, observedAt: now});
  const newer = activity({id: 'newer', updatedAt: now - 5000, observedAt: now - 1000});
  expect(nowBotActivities(acting(older, newer), [member], true, now).map(item => item.id)).toEqual(['newer', 'older']);
  expect(nowBotActivities(acting(older), [member], true, now + 60_000)).toEqual([]);
});

it('counts each bound group once on both sides of the badge', () => {
  const html = renderToStaticMarkup(<NowBotList snapshot={snapshot(acting(activity({phase: 'tool', toolKind: 'search'})), [member, member])} {...badgeActions}/>);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('Vonvon 所在群，可上下滚动');
  expect(html).toContain('href="https://applink.feishu.cn/client/bot/open?appId=cli_now"');
  expect(html).toContain('放大 Vonvon 的飞书二维码');
  expect(html).toContain('已加入 1 个群');
  expect(html.match(/<summary>/g)).toHaveLength(1);
  expect(html).toContain('设计讨论');
  expect(html).toContain('aria-label="设计讨论：群注意力 50 / 100，留意中"');
  expect(html).not.toContain('持续更新');
  expect(html).not.toContain('当前间隔');
  expect(html).not.toContain('role="slider"');
});

it('uses connection state rather than tool activity and labels the registered owner', () => {
  const render = (agent: Agent, stale = false) => renderToStaticMarkup(<NowBotList snapshot={{...snapshot({...agent, ownerName: '小王', registeredAt:now-86_400_000*10, badgeNumber:'000421'}), stale}}
    {...badgeActions}/>);
  const html = render(acting(activity()));
  const [front, back] = html.split('class="badge-face badge-back"');
  expect(front).toContain('已连接，已加入 1 个群，在职第 11 天');
  expect(front).toContain('No. 000421');
  expect(front).not.toContain('小王');
  expect(back).toContain('直属上级');
  expect(back).toContain('小王');
  expect(render({...acting(),enabled:false})).toContain('已停用，已加入 1 个群，在职第 11 天');
  expect(render(bot,true)).toContain('待更新');
  expect(render(bot)).not.toContain('组织回复');
});
it('counts the joining date and turns over at local midnight without waiting 24 hours',()=>{
  const before=new Date(2026,9,24,23,59,59).getTime(),after=new Date(2026,9,25,0,0,0).getTime();
  expect(badgeTenure(before,before)).toBe(1);
  expect(badgeTenure(before,after)).toBe(2);
  expect(badgeTenure(after,before)).toBeUndefined();
  expect(badgeTenure(undefined,after)).toBeUndefined();
});
it('leaves the private chat off the badge: only bound groups are listed and counted', () => {
  const dm = membershipSchema.parse({...member, id: '["cli_now","oc_dm_cli_now"]', groupId: 'oc_dm_cli_now', name: '私聊'});
  const html = renderToStaticMarkup(<NowBotList snapshot={snapshot({...bot, dm})} {...badgeActions}/>);
  expect(html).toContain('设计讨论');
  expect(html).not.toContain('私聊');
});

it('hangs each badge from its own lanyard, with no shared rail', () => {
  const html = renderToStaticMarkup(<NowBotList snapshot={snapshot(bot)} {...badgeActions}/>);
  expect(html).toContain('<div class="badge-board">');
  expect(html).not.toContain('data-lanyard');
  expect(html).not.toContain('badge-cable');
  // The printed ribbon is decoration: kept out of the accessibility tree.
  expect(html).toContain('<span class="badge-lanyard" aria-hidden="true">');
  expect(html.match(/class="badge-strand"/g)).toHaveLength(2);
  // Left strand teal in front, printed black behind; the right one the other way
  // round. Together the two prints read "Vonvon More than a bot".
  expect(html).toContain('<span class="badge-strand"><i></i><i class="badge-print"><b>More than a bot</b></i></span>');
  expect(html).toContain('<span class="badge-strand"><i class="badge-print"><b>Vonvon\u2002<span>More than a bot</span></b></i><i></i></span>');
});

it('opens a Lark Bot in Lark', () => {
  expect(badgeUrl('cli_now', 'lark')).toContain('applink.larksuite.com');
  expect(badgeUrl('cli_now')).toContain('applink.feishu.cn');
});

it('keeps every distinct group available directly on the back, including when the list overflows',()=>{
  const groups=Array.from({length:12},(_,i)=>membershipSchema.parse({...member,groupId:'oc_design_'+i,name:'设计讨论 '+i}));
  const render=(members:Membership[])=>renderToStaticMarkup(<NowBotList snapshot={snapshot(bot,members)} {...badgeActions}/>);
  const html=render(groups);
  expect(html).toContain('已加入 12 个群');
  expect(html).toContain('设计讨论 11');
  expect(html.match(/<summary>/g)).toHaveLength(12);
  expect(render([])).toContain('暂无已绑定的群');
});

it('never counts or lists a group that has no binding to this Bot', () => {
  const snap = snapshot(bot);
  snap.groups.push({id:'oc_unbound', name:'只在飞书加入的群'});
  const html = renderToStaticMarkup(<NowBotList snapshot={snap} {...badgeActions}/>);
  expect(html).toContain('已加入 1 个群');
  expect(html).toContain(member.name);
  expect(html).not.toContain('只在飞书加入的群');
  expect(html.match(/<summary>/g)).toHaveLength(1);
});

it('distinguishes unavailable data from zero bindings and a known disconnected state', () => {
  const render = (agent: Agent, members: Membership[]) =>
    renderToStaticMarkup(<NowBotList snapshot={snapshot(agent, members)} {...badgeActions}/>);
  expect(render({...bot, readError:'unreadable'}, [])).toContain('群数待更新');
  expect(render(bot, [{...member, stale:true}])).toContain('上次记录 1 个群');
  expect(render({...bot, connection:'unknown'}, [])).toContain('待更新，已加入 0 个群');
  expect(render({...bot, connection:'connecting'}, [])).toContain('连接中，已加入 0 个群');
});

it('labels a stopped connection on a disabled bot as disabled, and reuses communication copy', () => {
  expect(nowGroupAttention({...bot, enabled: false, connection: 'stopped'}, member, false, false, now).label).toBe('已停用');
  expect(nowGroupAttention(bot, {...member, conversation: 'threads'}, true, false, now).description).toContain('主区 @ Bot 开启新话题');
});

it('keeps an old daemon empty array unknown until the group model is advertised in the snapshot', () => {
  expect(nowGroupAttention(withAttention([]), member, true, false, now)).toMatchObject({tone: 'unknown', label: '待更新'});
  expect(nowGroupAttention(withAttention([]), member, true, false, now, true)).toMatchObject({score: 10, label: '低度留意'});
});

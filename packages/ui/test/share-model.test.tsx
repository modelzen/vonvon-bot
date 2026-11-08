import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {agentIdSchema, groupIdSchema, membershipSchema, type Agent, type BotDecision, type DesktopSnapshot} from '@vonvon/protocol';
import type {NowProvider} from '../src/NowUsage';
import type {Usage} from '../src/management/usage-data';
import type {JudgeUsageView} from '../src/management/JudgeUsage';
import {ShareCard} from '../src/ShareCard';
import {maskText} from '../src/masked-text';
import {buildShareModel, defaultShareOptions, recentlyUsed, SHARE_QR_URL, shareModelFrom, type ShareOptions} from '../src/share-model';

const now = new Date(2026, 10, 8, 12).getTime();
const agentId = agentIdSchema.parse('cli_share');
const groupId = groupIdSchema.parse('oc_share');
const member = membershipSchema.parse({id: 'share', agentId, groupId, name: '晴豆产品群', directory: '/test', backend: 'codex-appserver', conversation: 'smart', response: 'mention', permission: {administrator: 'full', member: 'full', network: false}, stale: false, enabled: true});
const decision = (id: string, kind: BotDecision['decision'], decidedAt: number): BotDecision => ({id, groupId, place: 'main', decision: kind, trigger: 'mention', decidedAt, messageAt: decidedAt - 10, messageCount: 1});
const bot: Agent = {
  id: agentId, name: 'Vonvon', enabled: true, running: true, connection: 'connected', activation: 'active', badgeNumber: 1,
  ownerName: '阿杰', readError: '/Users/someone/.vonvon-bot/agents/cli_share.json unreadable', tenant: 'tenant_key',
  diagnostics: {notReplied: [{messageId: 'om_1', groupId, reason: 'secret 原因', at: now}] as never, deniedScopes: ['im:message'], attention: [{groupId, group: {score: 50, intervalMs: 180_000, updatedAt: now}, focusedTopics: 0, watchedTopics: 0}],
    decisions: [decision('a', 'reply', 5), decision('b', 'skip', 6), decision('c', 'topic', 4), decision('d', 'reply', 3), decision('e', 'reply', 2)]},
};
const snapshot: DesktopSnapshot = {
  attentionModel: 'group', revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [bot], groups: [{id: groupId, name: '晴豆产品群'}], memberships: [member, {...member}], tools: [], jobs: [],
  application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/test'},
};
const usage = (date: string, displayName?: string): Usage => ({profile: {displayName, topInvocations: [], dailyBuckets: [{date, tokens: 100}], statsAsOf: date}, usage: {main: {}, extras: [], fetchedAt: 1}} as unknown as Usage);
const providers: NowProvider[] = [
  {id: 'claude-agent', name: 'Claude Code', account: {kind: 'subscription'}, data: usage('2026-11-01', '林夏')},
  {id: 'codex-appserver', name: 'Codex', account: {kind: 'subscription'}, data: usage('2026-11-02', '林夏')},
];
const jev = {view: {kind: 'judgeUsage', days: [{date: '2026-11-08', total: 3, sources: [], bots: [{agentId, agentName: 'Vonvon', count: 3}]}], unreadBots: 0} satisfies JudgeUsageView, asOf: now};
const options = (fields: Partial<ShareOptions> = {}): ShareOptions => ({...defaultShareOptions(providers, now), ...fields});
const build = (fields: Partial<ShareOptions> = {}) => buildShareModel({snapshot, providers, jev, now}, options(fields));

it('defaults to the badges and the Providers used in the last seven days, both masks on', () => {
  expect(recentlyUsed(providers[1]!.data!, now)).toBe(true);
  expect(recentlyUsed(providers[0]!.data!, now)).toBe(false);
  expect(defaultShareOptions(providers, now)).toEqual({badges: true, usage: ['codex-appserver'], habits: false, quota: false, activity: false, maskGroups: true, maskPeople: true});
  expect(defaultShareOptions([{...providers[1]!, data: undefined}], now).usage).toEqual([]);
});

it('masks group and people names when the model is built, so they never reach the card', () => {
  const model = build({activity: true, usage: ['codex-appserver', 'claude-agent', 'jev']});
  const text = JSON.stringify(model);
  for (const name of ['晴豆产品群', '阿杰', '林夏']) expect(text).not.toContain(name);
  expect(model.groups).toEqual([{id: groupId, name: maskText('晴豆产品群')}]);
  expect(maskText('晴豆产品群')).toHaveLength(5);
  expect(model.bots[0]!.ownerName).toBe(maskText('阿杰'));
  expect(model.activity!.every(entry => entry.group === maskText('晴豆产品群'))).toBe(true);
  expect(model.masked).toEqual({groups: true, people: true});
});

it('masks each kind of name by its own switch', () => {
  const groupsOnly = build({maskPeople: false, usage: ['codex-appserver']});
  expect(groupsOnly.bots[0]!.ownerName).toBe('阿杰');
  expect(JSON.stringify(groupsOnly.usage)).toContain('林夏');
  expect(groupsOnly.groups[0]!.name).not.toBe('晴豆产品群');
  const peopleOnly = build({maskGroups: false, activity: true});
  expect(peopleOnly.groups[0]!.name).toBe('晴豆产品群');
  expect(peopleOnly.activity![0]!.group).toBe('晴豆产品群');
  expect(peopleOnly.bots[0]!.ownerName).not.toBe('阿杰');
});

it('keeps only what the badge shows of a Bot and drops what was not chosen', () => {
  const model = build();
  expect(model.bots[0]).toMatchObject({name: 'Vonvon', badgeNumber: 1, readError: '配置读取失败', diagnostics: {notReplied: [], deniedScopes: []}});
  expect(model.bots[0]!.diagnostics!.attention).toHaveLength(1);
  expect(model.bots[0]!.diagnostics!.decisions).toBeUndefined();
  expect(JSON.stringify(model)).not.toContain('/Users/someone');
  expect(JSON.stringify(model)).not.toContain('secret');
  expect(model.memberships).toHaveLength(1);
  expect(model.team).toEqual({bots: 1, groups: 1});
  expect(model.activity).toBeUndefined();
  expect(model.usage.map(item => item.kind === 'jev' ? 'jev' : item.id)).toEqual(['codex-appserver']);
  expect(model).toMatchObject({version: 1, date: '2026.11.08', badges: true, sections: {habits: false, quota: false}, qrUrl: SHARE_QR_URL});
  expect(SHARE_QR_URL).toBe('https://vonvon.cc/?utm_source=share');
});

it('takes usage in a fixed order, Jev only once read, and the three latest replies for 群动态', () => {
  const model = build({usage: ['jev', 'claude-agent', 'codex-appserver'], activity: true, habits: true, quota: true});
  expect(model.usage.map(item => item.kind === 'jev' ? 'jev' : item.id)).toEqual(['codex-appserver', 'claude-agent', 'jev']);
  expect(model.sections).toEqual({habits: true, quota: true});
  expect(model.activity!.map(entry => entry.id)).toEqual(['a', 'c', 'd']);
  expect(buildShareModel({snapshot, providers, now}, options({usage: ['jev']})).usage).toEqual([]);
});

it('passes the model on only in the shape it was built', () => {
  const model = build();
  expect(shareModelFrom(JSON.parse(JSON.stringify(model)))).toEqual(JSON.parse(JSON.stringify(model)));
  expect(shareModelFrom({...model, version: 2})).toBeUndefined();
  expect(shareModelFrom({...model, bots: 'x'})).toBeUndefined();
  expect(shareModelFrom(null)).toBeUndefined();
});

it('draws masked names as mosaic and gives the badge backs no way to reach the Bot', () => {
  const html = renderToStaticMarkup(<ShareCard model={build({activity: true})}/>);
  expect(html).toContain('我的 AI 团队');
  expect(html).toContain('1 位 AI 同事 · 在 1 个飞书群上班');
  expect(html).toContain('data-masked="true"');
  expect(html).not.toContain('晴豆产品群');
  expect(html).not.toContain('阿杰');
  expect(html).not.toContain('去飞书找我');
  expect(html).not.toContain('badge-code');
  expect(html).toContain('Vonvon Bot 官网二维码');
  expect(html).toContain('Codex 用量');
  expect(html).toContain('群动态');
  const shown = renderToStaticMarkup(<ShareCard model={build({maskGroups: false, maskPeople: false, badges: false})}/>);
  expect(shown).not.toContain('data-masked');
  expect(shown).not.toContain('now-bot-list');
});

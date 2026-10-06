import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {agentIdSchema, groupIdSchema, membershipIdSchema, type DesktopSnapshot} from '../desktop/shared/bridge';
import {findEntries, searchEntries, settingAnchor} from '../desktop/renderer/search';

const agentId = agentIdSchema.parse('cli_searchagent');
const groupId = groupIdSchema.parse('oc_searchgroup');
const membershipId = membershipIdSchema.parse('searchmember');
const snapshot: DesktopSnapshot = {
  revision: 1, observedAt: Date.now(), stale: false,
  host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
  agents: [{id: agentId, name: '研发助手', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: groupId, name: '研发群'}],
  memberships: [{id: membershipId, agentId, groupId, name: '研发项目', directory: '/tmp/research', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false}],
  tools: [], jobs: [], diagnostics: [],
  application: {platform: 'macos', version: '0.7.0', loginItem: false, dataPath: '/tmp/test'},
};
const entries = searchEntries(snapshot);

test('every literal configuration row label in the current desktop UI is indexed', () => {
  const source = [
    'desktop/renderer/settings/SettingsPanel.tsx',
    'desktop/renderer/management/MachinePanel.tsx',
    'desktop/renderer/management/UpdatePanel.tsx',
    'desktop/renderer/management/ProjectPanel.tsx',
    'desktop/renderer/management/ConversationPanel.tsx',
    'desktop/renderer/App.tsx',
  ].map(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
  const labels = [...source.matchAll(/<SettingsRow\s+(?:[^>]*?\s)?title="([^"]+)"/gs)].map(match => match[1]!);
  const transient = new Set(['正在读取当前设置…', '正在读取项目', '没有匹配的会话']);
  const missing = [...new Set(labels)].filter(label => !transient.has(label) && !entries.some(entry => entry.title === label || entry.aliases.includes(label)));
  assert.deepEqual(missing, []);
});

test('rare field, aliases, and multi-term scope queries resolve to their real category', () => {
  const timeout = findEntries(entries, '审批超时')[0];
  assert.equal(timeout?.title, '审批超时（秒）');
  assert.equal(timeout?.destination.reveal, 'cli-advanced');
  assert.equal(timeout?.destination.page, 'coffee');
  assert.equal(timeout?.destination.section, '通知偏好');
  const scope = findEntries(entries, '在场检测平台')[0];
  assert.equal(scope?.destination.page, 'coffee');
  assert.equal(findEntries(entries, '清空白名单')[0]?.destination.detail?.kind, 'membership-settings');
  assert.equal(findEntries(entries, 'App Secret')[0]?.destination.reveal, 'profile-add');
  assert.equal(findEntries(entries, '修复命令行工具')[0]?.destination.section, '命令行工具');
});

test('coffee and Hook settings are indexed once globally, including without Agents', () => {
  const empty = searchEntries({...snapshot, agents: []});
  for (const title of ['咖啡一下', '本机 Hook', '接力设置', '通知偏好']) {
    const matches = empty.filter(entry => entry.title === title);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.destination.page, 'coffee');
  }
  assert.equal(findEntries(empty, 'Codex Hook')[0]?.destination.section, '本机 Hook');
  assert.equal(findEntries(empty, '咖啡一下 Codex Hook')[0]?.destination.section, '本机 Hook');
  assert.equal(findEntries(empty, '咖啡一下 审批')[0]?.destination.section, '通知偏好');
  assert.equal(findEntries(entries, '启用咖啡一下').length, 1);
  assert.equal(entries.some(entry => entry.destination.detail?.kind === 'agent-settings' && entry.title === 'CLI 协作'), false);
});

test('usage sharing has one global result even without a group binding', () => {
  for (const state of [snapshot, {...snapshot, memberships: [], groups: []}]) {
    const matches = searchEntries(state).filter(entry => entry.title === '分享 Codex 用量');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.destination.page, 'usage');
    assert.equal(matches[0]?.destination.section, '分享 Codex 用量');
    assert.equal(matches[0]?.destination.selection, undefined);
    assert.equal(findEntries(searchEntries(state), '分享 Codex 用量')[0]?.id, 'usage-share');
  }
});

test('results are complete, ranked, uniquely identified, and have valid destinations', () => {
  const many: DesktopSnapshot = {...snapshot, agents: Array.from({length: 70}, (_, index) => ({...snapshot.agents[0]!, id: agentIdSchema.parse(`cli_search${index}`), name: `Agent ${index}`}))};
  const catalog = searchEntries(many);
  const matches = findEntries(catalog, '最大并发任务');
  assert.equal(matches.length, 70);
  assert.equal(matches[0]?.title, '最大并发任务');
  assert.equal(new Set(catalog.map(entry => entry.id)).size, catalog.length);
  assert.ok(catalog.every(entry => !entry.destination.section || settingAnchor(entry.destination.section).startsWith('setting-')));
  assert.equal(findEntries(entries, '')[0]?.id, 'agents');
});

test('conditional settings lead to parent controls with clear prerequisites', () => {
  const threshold = findEntries(entries, '长任务阈值')[0];
  assert.equal(threshold?.destination.section, '任务结束提醒');
  assert.match(threshold?.destination.guide ?? '', /提醒方式/);
  const topic = findEntries(entries, '本话题模型')[0];
  assert.equal(topic?.destination.field, '选择话题');
  assert.match(topic?.destination.guide ?? '', /选择话题/);
});


test('tool search destinations use the same section names as the rendered tool cards', () => {
  for (const [query, section, reveal] of [
    ['安装位置 Codex', 'Codex CLI', 'codex-tool'],
    ['安装位置 Claude', 'Claude Code CLI', 'claude-tool'],
    ['安装位置 飞书 CLI', '飞书 CLI', 'lark-tool'],
  ]) {
    const result = findEntries(entries, query!)[0];
    assert.equal(result?.destination.section, section);
    assert.equal(result?.destination.field, '安装位置');
    assert.equal(result?.destination.reveal, reveal);
    assert.equal(result?.destination.guide, undefined);
  }
});

import {expect, it, vi} from 'vitest';
import {desktopSnapshotSchema, type AgentId, type MemoryItem} from '@vonvon/protocol';
import {currentInheritedDetail, inheritedBots, inheritedMemories, inheritedNodes, readInheritedContent, type InheritedContent} from '../src/inherited-content';
import type {MapNode} from '../src/MindMap';
import type {MemoryList} from '../src/memory-model';

const botId = 'cli_a' as AgentId;
const item = (id: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id, scope: {kind: 'bot', botId}, text: `记忆 ${id}`, branch: '合作方式', state: 'active', trust: 'trusted',
  source: {via: 'ui', botId, actorRole: 'desktop'}, createdAt: 1, updatedAt: 1, revision: 1, ...extra,
});
const memory = (items: MemoryItem[], verified = true): MemoryList => ({kind: 'list', items, branches: [{name: '合作方式', fixed: true, createdAt: 0, createdBy: 'system'}], used: items.filter(item => item.state === 'active').length, limit: 50, verified, problems: []});
const roleReply = (id = botId) => ({kind: 'view', view: {scope: {kind: 'agent', botId: id}, administrators: {}, sections: {role: {stored: {identity: '发版与排障助手。', notes: '先写结论。'}}}, roleInfo: {draft: '未保存的草稿', integrity: 'changed'}}});
const snapshot = desktopSnapshotSchema.parse({
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '1'},
  agents: [{id: 'cli_a', name: '小支', enabled: true, running: true, connection: 'connected', activation: 'active'}, {id: 'cli_b', name: '小发', enabled: true, running: true, connection: 'connected', activation: 'active'}],
  groups: [{id: 'oc_pay', name: '支付组'}, {id: 'oc_release', name: '发布群'}],
  projects: [{id: 'prj_00000001', name: '支付项目', revision: 1, directory: '/w', bindings: [{agentId: 'cli_a', groupId: 'oc_pay'}, {agentId: 'cli_a', groupId: 'oc_release'}, {agentId: 'cli_b', groupId: 'oc_pay'}]}],
  memberships: [], tools: [], jobs: [], application: {platform: 'macos', version: '1', loginItem: false, dataPath: '/t'},
});
const flatten = (node: MapNode): MapNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const actions = () => ({inspect: vi.fn(), isOpen: (_id: string, initial: boolean) => initial, toggle: vi.fn()});

it('shows each project Bot once and only the selected Bot in a group view', () => {
  const project = snapshot.projects![0]!;
  expect(inheritedBots(project, snapshot).map(bot => bot.id)).toEqual(['cli_a', 'cli_b']);
  expect(inheritedBots(project, snapshot, botId, snapshot.groups[0]!.id)).toEqual([{id: botId, name: '小支'}]);
  expect(inheritedBots(project, snapshot, 'cli_b' as AgentId, snapshot.groups[1]!.id)).toEqual([]);
  expect(inheritedBots({...project, bindings: []}, snapshot)).toEqual([]);
});

it('reads persisted agent role and Bot memory without reading a draft or issuing any write', async () => {
  const client = {settings: vi.fn().mockResolvedValue(roleReply()), memory: vi.fn().mockResolvedValue(memory([item('a')]))};
  const content = await readInheritedContent(client as never, botId);
  expect(client.settings.mock.calls).toEqual([[{type: 'read', scope: {kind: 'agent', botId}}]]);
  expect(client.memory.mock.calls).toEqual([[{type: 'list', scope: {kind: 'bot', botId}}]]);
  expect(content.role.value).toEqual({identity: '发版与排障助手。', notes: '先写结论。', changed: true});
  expect(JSON.stringify(content)).not.toContain('未保存的草稿');
});

it('retains readable memory when role reading fails, and readable role when memory reading fails', async () => {
  const roleFailed = await readInheritedContent({settings: vi.fn().mockRejectedValue(new Error('角色暂不可用')), memory: vi.fn().mockResolvedValue(memory([item('a')]))} as never, botId);
  expect(roleFailed.role.error).toBe('角色暂不可用');
  expect(roleFailed.memory.value?.items[0]?.id).toBe('a');
  const memoryFailed = await readInheritedContent({settings: vi.fn().mockResolvedValue(roleReply()), memory: vi.fn().mockRejectedValue(new Error('记忆暂不可用'))} as never, botId);
  expect(memoryFailed.role.value?.notes).toBe('先写结论。');
  expect(memoryFailed.memory.error).toBe('记忆暂不可用');
  const labels = flatten(inheritedNodes({id: botId, name: '小支'}, memoryFailed, actions())).map(node => node.label);
  expect(labels).toContain('记忆暂不可用');
  expect(labels).toContain('其他说明：先写结论。');
});

it('rejects a mismatched role reply instead of displaying another Bot role', async () => {
  const content = await readInheritedContent({settings: vi.fn().mockResolvedValue(roleReply('cli_b' as AgentId)), memory: vi.fn().mockResolvedValue(memory([]))} as never, botId);
  expect(content.role.value).toBeUndefined();
  expect(content.role.error).toBeDefined();
  expect(content.memory.value).toBeDefined();
});

it('matches work-session inheritance: active trusted verified entries only; archived entries stay out', () => {
  const entries = [item('trusted'), item('untrusted', {trust: 'untrusted'}), item('archived', {state: 'archived'})];
  expect(inheritedMemories(memory(entries))).toMatchObject({included: [{id: 'trusted'}], excluded: [{id: 'untrusted'}]});
  expect(inheritedMemories(memory(entries, false))).toMatchObject({included: [], excluded: [{id: 'trusted'}, {id: 'untrusted'}]});
});

it('keeps all inherited nodes readonly while letting a leaf reveal its full text and source', () => {
  const callbacks = actions();
  const content: InheritedContent = {role: {value: {identity: '助手', notes: '说明'.repeat(60), changed: false}}, memory: {value: memory([item('a')])}};
  const tree = inheritedNodes({id: botId, name: '小支'}, content, callbacks);
  expect(tree).toMatchObject({label: '来自 小支', meta: '只读'});
  for (const node of flatten(tree)) {
    expect(node.menu).toBeUndefined(); expect(node.drag).toBeUndefined(); expect(node.drop).toBeUndefined();
  }
  flatten(tree).find(node => node.id.endsWith(':role:notes'))!.onClick!();
  expect(callbacks.inspect).toHaveBeenLastCalledWith(expect.objectContaining({title: '其他说明', text: '说明'.repeat(60)}));
  flatten(tree).find(node => node.id.endsWith(':item:a'))!.onClick!();
  expect(callbacks.inspect).toHaveBeenLastCalledWith(expect.objectContaining({text: '记忆 a', item: expect.objectContaining({id: 'a'})}));
});

it('marks excluded Bot memory with its reason and keeps that branch folded', () => {
  const callbacks = actions();
  const content: InheritedContent = {role: {error: '无角色'}, memory: {value: memory([item('a'), item('u', {trust: 'untrusted'}), item('old', {state: 'archived'})], false)}};
  const nodes = flatten(inheritedNodes({id: botId, name: '小支'}, content, callbacks));
  expect(nodes.find(node => node.id.endsWith(':excluded'))).toMatchObject({label: '暂未带入', meta: '2', open: false});
  expect(nodes.some(node => node.id.endsWith(':old'))).toBe(false);
  nodes.find(node => node.id.endsWith(':excluded:a'))!.onClick!();
  expect(callbacks.inspect).toHaveBeenLastCalledWith(expect.objectContaining({note: expect.stringContaining('确认前不会带入任务')}));
  nodes.find(node => node.id.endsWith(':excluded:u'))!.onClick!();
  expect(callbacks.inspect).toHaveBeenLastCalledWith(expect.objectContaining({note: expect.stringContaining('尚未确认，不会带入任务')}));
});

it('limits long branches to eight visible leaves and offers an explicit expansion', () => {
  const callbacks = actions();
  const content: InheritedContent = {role: {error: '无角色'}, memory: {value: memory(Array.from({length: 10}, (_, index) => item(String(index))))}};
  const nodes = flatten(inheritedNodes({id: botId, name: '小支'}, content, callbacks));
  expect(nodes.filter(node => node.id.includes(':item:'))).toHaveLength(8);
  nodes.find(node => node.label === '还有 2 条')!.onClick!();
  expect(callbacks.toggle).toHaveBeenCalledWith('inherited:cli_a:branch:合作方式:more');
});

it('refreshes an open inherited detail and stops showing it after archival or read failure', () => {
  const selected = {id: 'inherited:cli_a:item:a', bot: {id: botId, name: '小支'}, title: '合作方式', text: '旧文字', item: item('a')};
  const refreshed: InheritedContent = {role: {error: '无角色'}, memory: {value: memory([item('a', {text: '新文字'})], false)}};
  expect(currentInheritedDetail(selected, refreshed)).toMatchObject({text: '新文字', note: expect.stringContaining('确认前不会带入任务')});
  expect(currentInheritedDetail(selected, {...refreshed, memory: {value: memory([item('a', {state: 'archived'})])}})).toBeUndefined();
  expect(currentInheritedDetail(selected, {...refreshed, memory: {error: '暂不可用'}})).toBeUndefined();
});

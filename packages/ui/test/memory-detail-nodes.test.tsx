import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {MemoryItem, MemoryRequest} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import {ClientProvider} from '../src/client-context';
import {MindMap, type MapNode} from '../src/MindMap';
import {typedBranchMove, useMemoryDetailNodes, type MemoryDetailNodeOptions} from '../src/memory-detail-nodes';

const scope = {kind: 'project', projectId: 'prj_00000001'} as const;
const item: MemoryItem = {
  id: 'p_1:x', scope, text: '周四发版', branch: '决定', state: 'active', trust: 'untrusted', revision: 4,
  source: {via: 'tool', botId: 'cli_a', actorRole: 'member', chatId: 'oc_secret', messageId: 'om_secret'},
  createdAt: 1_000, updatedAt: 1_000,
};
const views = [
  {name: '决定', fixed: true, items: [item], pending: 1},
  {name: '其他', fixed: true, items: [], pending: 0},
  {name: '发版', fixed: false, items: [], pending: 0},
];
const targets = {bots: [{id: 'cli_a', name: '小支'}, {id: 'cli_b', name: '小乙'}], projects: [], botName: () => '小支', groupName: () => '支付群'};
const client = {memory: async () => ({kind: 'events', events: []})} as VonvonClient;

function capture(over: Partial<MemoryDetailNodeOptions>) {
  const act = vi.fn(async (_request: MemoryRequest, _done?: string) => true);
  const closeAction = vi.fn();
  let output!: ReturnType<typeof useMemoryDetailNodes>;
  const props: MemoryDetailNodeOptions = {scope, views, targets, projectFor: () => undefined, act, closeAction, closeDetails: vi.fn(), busy: false, ...over};
  const Probe = () => {output = useMemoryDetailNodes(props); return createElement(MindMap, {root: {id: 'root', kind: 'root', label: '记忆', children: [...output.actionNodes, ...output.detailNodes]}, label: '记忆导图'});};
  const html = renderToStaticMarkup(createElement(ClientProvider, {client, children: createElement(Probe)}));
  return {output, html, act, closeAction};
}
const find = (nodes: MapNode[], id: string): MapNode | undefined => nodes.flatMap(function walk(entry): MapNode[] {return [entry, ...(entry.children ?? []).flatMap(walk)];}).find(entry => entry.id === id);

describe('memory detail and action map nodes', () => {
  it('offers category merge targets as clickable child nodes, preserving the RPC request', async () => {
    const view = capture({action: {kind: 'merge', branch: '发版'}});
    expect(view.html).toContain('合并「发版」到');
    expect(view.html).not.toContain('<dialog');
    find(view.output.actionNodes, 'memory-action:merge:决定')?.onClick?.();
    await vi.waitFor(() => expect(view.act).toHaveBeenCalledWith({type: 'branchMerge', scope, from: '发版', into: '决定'}, '已合并。'));
    expect(view.closeAction).toHaveBeenCalled();
    expect(capture({action: {kind: 'merge', branch: '决定'}}).output.actionNodes[0]?.children?.some(entry => entry.id === 'memory-action:merge:发版')).toBe(false);
  });

  it('moves to an existing category and to a selected Bot with the seen item revision', async () => {
    const moved = capture({action: {kind: 'move-branch', item}});
    find(moved.output.actionNodes, 'memory-action:branch:发版')?.onClick?.();
    await vi.waitFor(() => expect(moved.act).toHaveBeenCalledWith({type: 'edit', scope, itemId: item.id, revision: 4, branch: '发版'}, '已移到「发版」。'));
    const promoted = capture({action: {kind: 'to-bot', item}});
    find(promoted.output.actionNodes, 'memory-action:bot:cli_b')?.onClick?.();
    await vi.waitFor(() => expect(promoted.act).toHaveBeenCalledWith({type: 'promote', scope, itemId: item.id, revision: 4, botId: 'cli_b'}, '已移到 Bot 记忆。'));
  });

  it('accepts a typed existing category name and protects capacity only for a new category', () => {
    expect(typedBranchMove(scope, item, views, ' 发版 ')).toEqual({request: {type: 'edit', scope, itemId: item.id, revision: 4, branch: '发版'}, target: '发版'});
    expect(typedBranchMove(scope, item, views, '决定')).toEqual({problem: '这条记忆已经在这个分类。'});
    expect(typedBranchMove(scope, item, views, '新分类')).toEqual({request: {type: 'edit', scope, itemId: item.id, revision: 4, branch: '新分类'}, target: '新分类'});
    const full = [...views, ...Array.from({length: 9}, (_, at) => ({name: `自定义${at}`, fixed: false, items: [], pending: 0}))];
    expect(typedBranchMove(scope, item, full, '发版')).toMatchObject({target: '发版'});
    expect(typedBranchMove(scope, item, full, '再加一支')).toEqual({problem: '分类已满 12 支，放不下新分类。'});
  });

  it('keeps trust and permanent deletion behind explanation and confirmation nodes', async () => {
    const trust = capture({action: {kind: 'trust', item}});
    expect(trust.html).toContain('决策模型');
    find(trust.output.actionNodes, 'memory-action:trust-confirm')?.onClick?.();
    await vi.waitFor(() => expect(trust.act).toHaveBeenCalledWith({type: 'confirm', scope, itemId: item.id, revision: 4}, '已点成可信。'));
    const purge = capture({action: {kind: 'purge', item}});
    expect(purge.html).toContain('不能恢复，也不能撤销');
    find(purge.output.actionNodes, 'memory-action:purge-confirm')?.onClick?.();
    await vi.waitFor(() => expect(purge.act).toHaveBeenCalledWith({type: 'purge', scope, itemId: item.id}, '已彻底删除。'));
    expect(find(purge.output.actionNodes, 'memory-action:cancel')?.onClick).toBeTypeOf('function');
    expect(find(capture({action: {kind: 'purge', item}, busy: true}).output.actionNodes, 'memory-action:cancel')?.onClick).toBeUndefined();
  });

  it('places source and history under the selected memory, without exposing raw message ids', () => {
    const detail = capture({detailItem: item});
    expect(detail.html).toContain('详情与历史');
    expect(detail.html).toContain('支付群');
    expect(detail.html).toContain('正在读取历史');
    expect(detail.html).not.toMatch(/om_secret|oc_secret|<aside|<dialog/);
    expect(find(detail.output.detailNodes, 'memory-detail:close')?.onClick).toBeTypeOf('function');
  });
});

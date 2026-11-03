import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';
import type {CoreUpdateStatus, MachineReply, MachineRequest} from '@vonvon/protocol';

// Codex review 246-1: the remote card is mounted again when the page is left and opened again, or when another client
// already started the update; each mount read only checkCoreUpdate, so the progress was gone and 更新「X」 could be pressed.
// This harness keeps React's rules for effects: one runs again only when its deps change, and its cleanup runs first.
type Slot = {deps?: unknown[]; cleanup?: unknown};
const h = vi.hoisted(() => ({state: [] as unknown[], at: 0, effects: [] as Slot[], effectAt: 0, pending: [] as Array<() => void>}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const at = h.at++; if (!(at in h.state)) h.state[at] = initial; return [h.state[at], (next: unknown) => {h.state[at] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[at]) : next;}];},
  useEffect: (effect: () => unknown, deps?: unknown[]) => {
    const at = h.effectAt++;
    const old = h.effects[at];
    if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, index) => Object.is(value, old.deps![index]))) return;
    h.pending.push(() => {if (typeof old?.cleanup === 'function') old.cleanup(); h.effects[at] = {deps, cleanup: effect()};});
  },
}));
import {RpcError} from '@vonvon/client/browser';
import {coreStatusLine, ServerUpdateCard} from '../src/management/ServerUpdateCard';

type Node = {type: unknown; props: Record<string, any>};
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes)
  : isValidElement<Record<string, any>>(node) ? [node as Node, ...nodes(node.props.children), ...nodes(node.props.trailing)] : [];
const where = {isRemote: true, name: '验收设备 1', version: '0.9.0'};
const UPDATE = '更新「验收设备 1」';

/** The remote device: its server's update record, which any client's update writes and every client reads. */
function device(initial: CoreUpdateStatus | null) {
  const server = {status: initial};
  const request = vi.fn(async (operation: MachineRequest): Promise<MachineReply> => {
    if (operation.type === 'checkCoreUpdate') return {type: 'coreUpdate', distribution: {kind: 'standalone', cliPath: '/srv/vonvon/bin/vonvon'}, current: '0.9.0', latest: '0.9.1', hasUpdate: true, dev: false};
    if (operation.type === 'applyCoreUpdate') { server.status = {phase: 'installing', detail: 'downloading', from: '0.9.0', to: '0.9.1', at: 10, progress: {transferred: 0, total: 100}}; return {type: 'done', message: '开始更新'}; }
    if (operation.type === 'coreUpdateStatus') return {type: 'coreUpdateStatus', status: server.status};
    throw new Error(`unexpected ${operation.type}`);
  });
  return {server, request, polls: () => request.mock.calls.filter(([operation]) => operation.type === 'coreUpdateStatus').length};
}
const settle = () => vi.advanceTimersByTimeAsync(0);
/** One mounted card: `render` is React rendering it again after a state change, `unmount` leaving the page. */
async function mount(request: ReturnType<typeof device>['request']) {
  h.state = []; h.effects = []; h.pending = [];
  const render = () => {h.at = 0; h.effectAt = 0; const tree = ServerUpdateCard({request, variant: 'remote', where}); for (const run of h.pending.splice(0)) run(); return tree;};
  render();
  await settle();
  const view = () => {
    const all = nodes(render());
    const update = all.find(node => [node.props.children].flat().join('') === UPDATE);
    const progress = all.find(node => node.type === 'progress');
    const lines = all.filter(node => node.props.role === 'status').map(node => [node.props.children].flat().join(''));
    const notes = all.filter(node => node.props.role === 'note').map(node => [node.props.children].flat().join(''));
    return {update, progress: progress?.props.value as number | undefined, lines, notes};
  };
  const unmount = () => {for (const slot of h.effects) if (typeof slot?.cleanup === 'function') slot.cleanup(); h.effects = [];};
  return {view, unmount};
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('follows an update every second in the card that started it, until it ends', async () => {
  const remote = device(null);
  const card = await mount(remote.request);
  await card.view().update!.props.onClick();
  await settle();
  expect(card.view().update?.props.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(card.view().lines).toContain('下载中 0% · 0.9.0 → 0.9.1');
  remote.server.status = {phase: 'done', ok: true, from: '0.9.0', to: '0.9.1', at: 20};
  await vi.advanceTimersByTimeAsync(1000);
  expect(card.view().lines).toContain(coreStatusLine(remote.server.status));
  // the opening read, then one a second: the second answer ended it and following stopped
  expect(remote.polls()).toBe(3);
  await vi.advanceTimersByTimeAsync(3000);
  expect(remote.polls()).toBe(3);
  card.unmount();
});

it('follows an update again after the page is left and opened again, until it ends', async () => {
  const remote = device(null);
  const first = await mount(remote.request);
  await first.view().update!.props.onClick();
  await settle();
  first.view();
  remote.server.status = {...remote.server.status!, progress: {transferred: 40, total: 100}};
  await vi.advanceTimersByTimeAsync(1000);
  expect(first.view().progress).toBe(40);
  first.unmount();
  const polled = remote.polls();
  await vi.advanceTimersByTimeAsync(3000);
  expect(remote.polls()).toBe(polled);

  // opened again: the update is read at once, its progress shown and the button kept off
  const second = await mount(remote.request);
  let shown = second.view();
  expect(shown.progress).toBe(40);
  expect(shown.lines).toContain('下载中 40% · 0.9.0 → 0.9.1');
  expect(shown.update?.props.disabled).toBe(true);
  remote.server.status = {...remote.server.status!, detail: 'downloading', progress: {transferred: 90, total: 100}};
  await vi.advanceTimersByTimeAsync(1000);
  expect(second.view().progress).toBe(90);
  remote.server.status = {phase: 'done', ok: true, from: '0.9.0', to: '0.9.1', at: 20};
  await vi.advanceTimersByTimeAsync(1000);
  shown = second.view();
  expect(shown.lines).toContain('更新完成 · 0.9.0 → 0.9.1');
  expect(shown.progress).toBeUndefined();
  expect(shown.update?.props.disabled).toBe(false);
  const ended = remote.polls();
  await vi.advanceTimersByTimeAsync(3000);
  expect(remote.polls()).toBe(ended);
  second.unmount();
});

it('follows an update another client started, and shows why it went back', async () => {
  const remote = device({phase: 'installing', detail: 'verifying', from: '0.9.0', to: '0.9.1', at: 5});
  const card = await mount(remote.request);
  let shown = card.view();
  expect(shown.lines).toContain('校验中 · 0.9.0 → 0.9.1');
  expect(shown.update?.props.disabled).toBe(true);
  remote.server.status = {phase: 'restarting', ok: true, from: '0.9.0', to: '0.9.1', at: 6};
  await vi.advanceTimersByTimeAsync(1000);
  expect(card.view().lines).toContain('正在重启 · 0.9.0 → 0.9.1');
  remote.server.status = {phase: 'error', ok: false, from: '0.9.0', to: '0.9.1', previous: '0.9.0', rolledBack: true, message: '新版本 0.9.1 没有起来，已切回 0.9.0', at: 7};
  await vi.advanceTimersByTimeAsync(1000);
  shown = card.view();
  expect(shown.lines).toContain('更新失败：新版本 0.9.1 没有起来，已切回 0.9.0 · 0.9.0 → 0.9.1');
  expect(shown.update?.props.disabled).toBe(false);
  card.unmount();
});

it('shows how an update that ended before the card opened went, without following it', async () => {
  const done = device({phase: 'done', ok: true, from: '0.9.0', to: '0.9.1', at: 3});
  const card = await mount(done.request);
  expect(card.view().lines).toContain('更新完成 · 0.9.0 → 0.9.1');
  expect(card.view().update?.props.disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(done.polls()).toBe(1);
  card.unmount();
  // A rollback its message does not mention says where it went back to, as `vonvon update` does.
  const failed = device({phase: 'error', ok: false, from: '0.9.0', to: '0.9.1', previous: '0.9.0', rolledBack: true, message: '新版本没有起来', at: 4});
  const again = await mount(failed.request);
  expect(again.view().lines).toContain('更新失败：新版本没有起来（已切回 0.9.0） · 0.9.0 → 0.9.1');
  again.unmount();
});

it('shows nothing of an update when the device has no record', async () => {
  const fresh = device(null);
  const card = await mount(fresh.request);
  expect(card.view().lines).toEqual([]);
  expect(card.view().update?.props.disabled).toBe(false);
  card.unmount();
});

// D3 (Codex review 248): a device that is updating drains, answers DRAIN_KINDS (the update's progress among them) and
// `draining` to the rest without closing. A card opened then, as after the desktop reconnects, follows the update; its
// check refused with `draining` is neither "不支持远程更新" nor an error line.
it('follows the update of a draining device it opens on, quietly past the refused check', async () => {
  const remote = device({phase: 'installing', detail: 'downloading', from: '0.9.0', to: '0.9.1', at: 5, progress: {transferred: 30, total: 100}});
  remote.request.mockImplementation(async (operation: MachineRequest): Promise<MachineReply> => {
    if (operation.type === 'coreUpdateStatus') return {type: 'coreUpdateStatus', status: remote.server.status};
    throw new RpcError('draining', 'daemon 正在停止或重启（比如在升级），这个请求没有处理。等它重新启动后再试。');
  });
  const card = await mount(remote.request);
  let shown = card.view();
  expect(shown.progress).toBe(30);
  expect(shown.lines).toEqual(['下载中 30% · 0.9.0 → 0.9.1']);
  expect(shown.notes).toEqual([]);
  remote.server.status = {phase: 'done', ok: true, from: '0.9.0', to: '0.9.1', at: 20};
  await vi.advanceTimersByTimeAsync(1000);
  shown = card.view();
  expect(shown.lines).toEqual(['更新完成 · 0.9.0 → 0.9.1']);
  card.unmount();
});

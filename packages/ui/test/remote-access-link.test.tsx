import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';
import type {DeviceReply, DeviceRequest, DeviceStatus} from '@vonvon/protocol';

// Codex 审查 267-2、269-1 (修之前必败): a connection link names the address and port it was made on. Once that address is
// replaced or closed, here or from another client (the 10-second read), the link can no longer connect: the panel drops
// it and says to make a new one, and no button makes a link while no address listens. The real RemoteAccessPanel, its
// hooks driven by hand as in server-update-card-lifecycle.test.tsx (no DOM in these tests): an effect runs again only
// when its deps change, its cleanup first.
type Slot = {deps?: unknown[]; cleanup?: unknown};
const h = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Slot[], pending: [] as Array<() => void>,
  si: 0, ri: 0, mi: 0, ei: 0, intervals: new Map<number, {run: () => void; ms: number}>(), next: 0,
  client: undefined as unknown,
}));
vi.mock('react', async original => {
  const same = (deps: unknown[] | undefined, old: unknown[] | undefined) => Boolean(old && deps && deps.length === old.length && deps.every((value, at) => Object.is(value, old[at])));
  const memo = (factory: () => unknown, deps?: unknown[]) => {const i = h.mi++; const old = h.memos[i]; if (old && same(deps, old.deps)) return old.value; const value = factory(); h.memos[i] = {value, deps}; return value;};
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
    useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
    useMemo: memo, useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps), useId: () => 'id',
    useEffect: (effect: () => unknown, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old && same(deps, old.deps)) return; h.pending.push(() => {if (typeof old?.cleanup === 'function') old.cleanup(); h.effects[i] = {deps, cleanup: effect()};});},
  };
});
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(),
  useClient: () => h.client, useActiveDevice: () => ({id: 'local', isRemote: false, name: '这台电脑', mode: 'full', capabilities: []})}));

import {RemoteAccessPanel, RemoteAccessView} from '../src/settings/RemoteAccessPanel';
import {InlineNotice} from '../src/reference/components/ui';

type Node = {type: unknown; props: Record<string, any>};
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes)
  : isValidElement<Record<string, any>>(node) ? [node as Node, ...['children', 'trailing', 'description', 'action', 'footer', 'dialog'].flatMap(key => nodes(node.props[key]))] : [];
const words = (node: Node): string => [node.props.children].flat().filter(each => typeof each === 'string').join('');

const TAILSCALE = '100.64.0.10';
const LAN = '192.168.1.9';
/** The device: its open address and port, which this panel's clicks and another client's change alike. */
function device() {
  const server = {open: TAILSCALE as string | undefined, port: 7767};
  const status = (): DeviceStatus => ({
    device: {id: 'd', name: '办公室 Mac', publicKey: 'k'}, clients: {total: 0, active: 0},
    remote: {port: server.port, addresses: server.open ? [{host: server.open, kind: server.open === LAN ? 'lan' : 'tailscale', enabledAt: 1, state: 'listening'}] : [],
      candidates: [{host: TAILSCALE, kind: 'tailscale', iface: 'tailscale0', tool: 'Tailscale'}, {host: LAN, kind: 'lan', iface: 'eth0'}]},
  });
  const request = vi.fn(async (operation: DeviceRequest): Promise<DeviceReply> => {
    switch (operation.type) {
      case 'status': return {kind: 'deviceStatus', status: status()};
      case 'clients': return {kind: 'clients', generation: 1, clients: []};
      case 'pair': return {kind: 'pairingLink', link: `vonvon://pair#made-up-${server.open}-${server.port}`, inviteId: 'inv_0000000000000000', expiresAt: Date.now() + 600_000};
      case 'enable': server.open = operation.host; return {kind: 'deviceStatus', status: status()};
      case 'disable': server.open = undefined; return {kind: 'deviceStatus', status: status()};
      default: throw new Error(`unexpected ${operation.type}`);
    }
  });
  return {server, request, pairs: () => request.mock.calls.filter(([operation]) => operation.type === 'pair').length};
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function mount(request: ReturnType<typeof device>['request']) {
  h.client = {device: request, onDevice: () => () => {}};
  const render = () => {
    h.si = h.ri = h.mi = h.ei = 0;
    const panel = RemoteAccessPanel() as unknown as {props: Parameters<typeof RemoteAccessView>[0]};
    for (const run of h.pending.splice(0)) run();
    return panel;
  };
  /** Rendered until nothing changes: an effect's state change renders again, as React does. */
  const settle = async () => { for (let i = 0; i < 5; i++) { render(); await flush(); } return render(); };
  await settle();
  const view = async () => {
    const all = nodes(RemoteAccessView((await settle()).props));
    const button = (label: string) => all.find(node => words(node) === label);
    return {
      all,
      link: all.find(node => node.type === 'input' && node.props['aria-label'] === '连接链接')?.props.value as string | undefined,
      button, radio: (host: string) => all.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === host),
      text: all.map(node => typeof node.props.description === 'string' ? node.props.description : '').join(' '),
    };
  };
  /** Every 10 seconds while the page shows. */
  const poll = async () => { for (const each of h.intervals.values()) if (each.ms === 10_000) each.run(); await flush(); };
  return {view, poll};
}
beforeEach(() => {
  h.state = []; h.refs = []; h.memos = []; h.effects = []; h.pending = []; h.intervals.clear();
  vi.stubGlobal('window', {setInterval: (run: () => void, ms: number) => {h.intervals.set(++h.next, {run, ms}); return h.next;}, clearInterval: (id: number) => {h.intervals.delete(id);}});
  vi.stubGlobal('document', {visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}});
});

it('drops the link made on the old address once this panel switches to another', async () => {
  const remote = device();
  const panel = await mount(remote.request);
  (await panel.view()).button('生成连接链接')!.props.onClick();
  await flush();
  expect((await panel.view()).link).toBe(`vonvon://pair#made-up-${TAILSCALE}-7767`);
  (await panel.view()).radio(LAN)!.props.onChange();
  (await panel.view()).button('换成这个地址')!.props.onClick();
  await flush();
  const after = await panel.view();
  expect(remote.server.open).toBe(LAN);
  expect(after.link).toBeUndefined();
  expect(after.button('复制')).toBeUndefined();
  expect(after.text).toContain('地址变了，刚才那条链接用不了了，再生成一个。');
  expect(after.button('生成连接链接')?.props.disabled).toBe(false);
  after.button('生成连接链接')!.props.onClick();
  await flush();
  expect((await panel.view()).link).toBe(`vonvon://pair#made-up-${LAN}-7767`);
});

it('drops the link once remote connections are closed, and makes no new one until an address listens', async () => {
  const remote = device();
  const panel = await mount(remote.request);
  (await panel.view()).button('生成连接链接')!.props.onClick();
  await flush();
  expect((await panel.view()).link).toBeDefined();
  (await panel.view()).button('关闭远程连接')!.props.onClick();
  await flush();
  const after = await panel.view();
  expect(remote.server.open).toBeUndefined();
  expect(after.link).toBeUndefined();
  expect(after.button('再生成一个')).toBeUndefined();
  expect(after.button('生成连接链接')?.props.disabled).toBe(true);
  expect(after.text).toContain('先在上面选一个地址并开启。');
  expect(remote.pairs()).toBe(1);
});

it('drops the link when the 10-second read finds the address or port changed from another client', async () => {
  const remote = device();
  const panel = await mount(remote.request);
  (await panel.view()).button('生成连接链接')!.props.onClick();
  await flush();
  // another client ran `vonvon remote port 7768`
  remote.server.port = 7768;
  await panel.poll();
  let after = await panel.view();
  expect(after.link).toBeUndefined();
  expect(after.text).toContain('地址变了，刚才那条链接用不了了，再生成一个。');
  after.button('生成连接链接')!.props.onClick();
  await flush();
  expect((await panel.view()).link).toBe(`vonvon://pair#made-up-${TAILSCALE}-7768`);
  // and then switched the address
  remote.server.open = LAN;
  await panel.poll();
  after = await panel.view();
  expect(after.link).toBeUndefined();
  // a read that finds nothing changed keeps it
  after.button('生成连接链接')!.props.onClick();
  await flush();
  await panel.poll();
  expect((await panel.view()).link).toBe(`vonvon://pair#made-up-${LAN}-7768`);
});

// 0.9.0 设备 UI 打磨: 复制 is confirmed beside the button for a moment, not by a notice; the other notices stay until the
// next action, as before.
const notices = (all: Node[]) => all.filter(node => node.type === InlineNotice)
  .map(node => nodes(node.props.children).find(child => typeof child.props.text === 'string')?.props.text as string);
const copiedShown = (all: Node[]) => all.some(node => words(node) === '已复制');
it('says 已复制 beside 复制 for two seconds, without a notice; a failed copy says so and stays', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  try {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', {clipboard: {writeText}});
    const panel = await mount(device().request);
    (await panel.view()).button('生成连接链接')!.props.onClick();
    await flush();
    (await panel.view()).button('复制')!.props.onClick();
    await flush();
    let after = await panel.view();
    expect(writeText).toHaveBeenCalledWith(`vonvon://pair#made-up-${TAILSCALE}-7767`);
    expect(copiedShown(after.all)).toBe(true);
    expect(notices(after.all)).toEqual([]);
    vi.advanceTimersByTime(1_900);
    expect(copiedShown((await panel.view()).all)).toBe(true);
    vi.advanceTimersByTime(200);
    after = await panel.view();
    expect(copiedShown(after.all)).toBe(false);
    expect(after.button('复制')).toBeDefined();
    writeText.mockRejectedValueOnce(new Error('denied'));
    after.button('复制')!.props.onClick();
    await flush();
    vi.advanceTimersByTime(10_000);
    after = await panel.view();
    expect(copiedShown(after.all)).toBe(false);
    expect(notices(after.all)).toEqual(['没能复制，请选中链接手动复制。']);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('keeps a notice that something was done until the next action', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  try {
    const remote = device();
    const panel = await mount(remote.request);
    (await panel.view()).button('关闭远程连接')!.props.onClick();
    await flush();
    vi.advanceTimersByTime(60_000);
    const after = await panel.view();
    expect(remote.server.open).toBeUndefined();
    expect(notices(after.all)).toContain('已关闭远程连接，别的设备暂时连不上了。');
  } finally {
    vi.useRealTimers();
  }
});

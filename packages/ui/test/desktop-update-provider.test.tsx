import {beforeEach, expect, it, vi} from 'vitest';
import type {DesktopUpdate} from '@vonvon/protocol';
import {DesktopUpdateProvider, useDesktopUpdateOperation, type useDesktopUpdate} from '../src/desktop-update';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Effect[], pending: [] as Array<() => void>, si: 0, ei: 0, ri: 0,
  shell: undefined as undefined | {onDesktopUpdate?: (listener: (update: unknown) => void) => () => void},
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = initial; return [h.state[i], (next: unknown) => {h.state[i] = next;}];},
  useMemo: (factory: () => unknown) => factory(),
  useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const i = h.ei++; const old = h.effects[i];
    if (old?.deps && deps && deps.every((value, n) => Object.is(value, old.deps![n]))) return;
    h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});
  },
}));
vi.mock('../src/client-context', () => ({useShellCapabilities: () => h.shell}));

const found: DesktopUpdate = {state: 'available', current: '0.7.0', latest: '0.7.1', message: 'x'};
function render() {
  h.si = h.ei = h.ri = 0;
  const element = DesktopUpdateProvider({children: null}) as unknown as {props: {value: ReturnType<typeof useDesktopUpdate>}};
  for (const effect of h.pending.splice(0)) effect();
  return element.props.value;
}
beforeEach(() => { h.state = []; h.refs = []; h.effects = []; h.pending = []; h.shell = undefined; });

it('holds what the shell reports, and lets the settings page store a manual result in the same place', () => {
  let listener: (update: unknown) => void = () => {};
  const off = vi.fn();
  h.shell = {onDesktopUpdate: next => { listener = next; return off; }};
  expect(render()[0]).toBeUndefined();
  listener(found);
  expect(render()[0]).toEqual(found);
  const manual: DesktopUpdate = {...found, state: 'downloaded'};
  render()[1](manual);
  expect(render()[0]).toEqual(manual);
});

it('subscribes once, unsubscribes when the shell goes away, and copes with a shell that has no updates', () => {
  const off = vi.fn();
  const subscribe = vi.fn(() => off);
  h.shell = {onDesktopUpdate: subscribe};
  render(); render();
  expect(subscribe).toHaveBeenCalledOnce();
  h.shell = undefined;
  expect(render()[0]).toBeUndefined();
  expect(off).toHaveBeenCalledOnce();
});

it('shares a download across entry points and blocks rapid duplicate clicks until it completes', async () => {
  let finish!: (update: DesktopUpdate) => void;
  const download = vi.fn(() => new Promise<DesktopUpdate>(resolve => {finish = resolve;}));
  const toolbar = render()[2]!;
  const pending = toolbar.run(download, 'downloading');
  await toolbar.run(download, 'downloading');
  const settings = render()[2]!;
  expect(settings.phase).toBe('downloading');
  await settings.run(download, 'downloading');
  expect(download).toHaveBeenCalledOnce();
  finish({...found, state: 'downloaded'});
  await pending;
  expect(render()[0]?.state).toBe('downloaded');
  expect(render()[2]!.phase).toBeUndefined();
});

it('retains a failed download for retry and shares its error with settings', async () => {
  render()[1](found);
  await render()[2]!.run(async () => {throw new Error('网络断开');}, 'downloading');
  expect(render()[0]).toEqual(found);
  expect(render()[2]).toMatchObject({error: '网络断开', phase: undefined});
  await render()[2]!.run(async () => ({...found, state: 'downloaded'}), 'downloading');
  expect(render()[2]!.error).toBeUndefined();
  expect(render()[0]?.state).toBe('downloaded');
});

it('serializes installation and permits retry if the shell replies without exiting', async () => {
  const downloaded: DesktopUpdate = {...found, state: 'downloaded'};
  render()[1](downloaded);
  await render()[2]!.run(async () => {throw new Error('无法重启');}, 'installing');
  expect(render()[2]!.phase).toBeUndefined();
  expect(render()[2]!.error).toBe('无法重启');
  let finish!: (update: DesktopUpdate) => void;
  const install = vi.fn(() => new Promise<DesktopUpdate>(resolve => {finish = resolve;}));
  const pending = render()[2]!.run(install, 'installing');
  expect(render()[2]!.phase).toBe('installing');
  await render()[2]!.run(install, 'installing');
  expect(install).toHaveBeenCalledOnce();
  finish(downloaded);
  await pending;
  expect(render()[2]!.phase).toBeUndefined();
  expect(render()[2]!.error).toBeUndefined();
});

it('writes to the caller\'s local store when the update panel has no shared provider', async () => {
  const setUpdate = vi.fn();
  h.si = h.ri = 0;
  const operation = useDesktopUpdateOperation([undefined, setUpdate]);
  await operation.run(async () => found, 'checking');
  expect(setUpdate).toHaveBeenCalledWith(found);
});

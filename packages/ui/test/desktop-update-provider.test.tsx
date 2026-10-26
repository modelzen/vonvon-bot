import {beforeEach, expect, it, vi} from 'vitest';
import type {DesktopUpdate} from '@vonvon/protocol';
import {DesktopUpdateProvider} from '../src/desktop-update';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({
  state: [] as unknown[], effects: [] as Effect[], pending: [] as Array<() => void>, si: 0, ei: 0,
  shell: undefined as undefined | {onDesktopUpdate?: (listener: (update: unknown) => void) => () => void},
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = initial; return [h.state[i], (next: unknown) => {h.state[i] = next;}];},
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const i = h.ei++; const old = h.effects[i];
    if (old?.deps && deps && deps.every((value, n) => Object.is(value, old.deps![n]))) return;
    h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});
  },
}));
vi.mock('../src/client-context', () => ({useShellCapabilities: () => h.shell}));

const found: DesktopUpdate = {state: 'available', current: '0.7.0', latest: '0.7.1', message: 'x'};
function render() {
  h.si = h.ei = 0;
  const element = DesktopUpdateProvider({children: null}) as unknown as {props: {value: readonly [DesktopUpdate | undefined, (update: DesktopUpdate) => void]}};
  for (const effect of h.pending.splice(0)) effect();
  return element.props.value;
}
beforeEach(() => { h.state = []; h.effects = []; h.pending = []; h.shell = undefined; });

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

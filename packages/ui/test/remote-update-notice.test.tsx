import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';

const hooks = vi.hoisted(() => ({state: [] as unknown[], index: 0, effects: [] as Array<() => unknown>}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const at = hooks.index++; if (!(at in hooks.state)) hooks.state[at] = initial; return [hooks.state[at], (next: unknown) => {hooks.state[at] = next;}];},
  useEffect: (effect: () => unknown) => {hooks.effects.push(effect);},
}));
const shell = vi.hoisted(() => ({current: undefined as undefined | {onRemoteUpdate?: (listener: (text: string | undefined) => void) => () => void}}));
vi.mock('../src/client-context', () => ({useShellCapabilities: () => shell.current}));
import {RemoteUpdateNotice, RemoteUpdateNoticeView} from '../src/devices/RemoteUpdateNotice';

// devices-ui-4: while another device updates this computer, the window says who and that the restart interrupts the
// conversations. main 必败: there was no such line.
const render = () => { hooks.index = 0; hooks.effects = []; return RemoteUpdateNotice() as {props: {text?: string}}; };

it('shows the line the desktop app sends, and takes it away when it is gone', () => {
  hooks.state = [];
  let listener: ((text: string | undefined) => void) | undefined;
  const off = vi.fn();
  shell.current = {onRemoteUpdate: vi.fn(next => { listener = next; return off; })};
  expect(render().props.text).toBeUndefined();
  const cleanups = hooks.effects.map(effect => effect());
  listener?.('「笔记本」正在更新这台电脑上的 Vonvon Bot。下载好后会直接重启，正在进行的对话会被中断。');
  const text = render().props.text;
  expect(text).toContain('正在进行的对话会被中断');
  const html = renderToStaticMarkup(<RemoteUpdateNoticeView text={text}/>);
  expect(html).toContain('正在远程更新这台电脑');
  expect(html).toContain('「笔记本」正在更新这台电脑上的 Vonvon Bot。');
  listener?.(undefined);
  expect(renderToStaticMarkup(<RemoteUpdateNoticeView text={render().props.text}/>)).toBe('');
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  expect(off).toHaveBeenCalledOnce();
});

it('shows nothing in a browser, which has no desktop app', () => {
  hooks.state = [];
  shell.current = undefined;
  expect(render().props.text).toBeUndefined();
  for (const effect of hooks.effects) expect(effect()).toBeUndefined();
  expect(renderToStaticMarkup(<RemoteUpdateNoticeView text={undefined}/>)).toBe('');
});

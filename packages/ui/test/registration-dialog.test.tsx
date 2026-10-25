import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {AgentId, Job, JobId} from '@vonvon/protocol';
import {RegistrationDialog, RegistrationScan} from '../src/setup/RegistrationDialog';

const hooks = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as {current: unknown}[], effects: [] as {deps?: unknown[]; cleanup?: () => void}[],
  si: 0, ri: 0, ei: 0, openExternal: vi.fn(async (_url: string) => {}),
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = hooks.si++; if (!(i in hooks.state)) hooks.state[i] = initial; return [hooks.state[i], (next: any) => {hooks.state[i] = typeof next === 'function' ? next(hooks.state[i]) : next;}];},
  useRef: (initial: unknown) => hooks.refs[hooks.ri++] ??= {current: initial},
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const i = hooks.ei++, old = hooks.effects[i];
    if (deps && old?.deps && deps.every((d, j) => Object.is(d, old.deps![j]))) return;
    old?.cleanup?.(); const cleanup = effect(); hooks.effects[i] = {deps, ...(typeof cleanup === 'function' ? {cleanup} : {})};
  },
}));
vi.mock('../src/client-context', () => ({useShellCapabilities: () => ({openExternal: hooks.openExternal})}));
type Element = ReactElement<Record<string, any>>;
function nodes(value: ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(value)) return [];
  return [value, ...nodes(value.props.children), ...nodes(value.props.footer)];
}
function text(value: ReactNode): string {
  if (Array.isArray(value)) return value.map(text).join('');
  return isValidElement<Record<string, any>>(value) ? text(value.props.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
const jobId = 'job_registration' as JobId;
const url = 'https://accounts.feishu.cn/register?demo=1';
const qr = (): Job => ({id: jobId, type: 'registerAgent', phase: 'qr', image: 'data:image/png;base64,AA', url, expiresAt: Date.now() + 1000});
const onRetry = vi.fn();
function scan(job: Job | undefined, busy = false) {
  hooks.si = hooks.ri = hooks.ei = 0;
  const tree = RegistrationScan({job, refresh: false, busy, onRetry});
  const all = nodes(tree);
  return {tree, all, button: (label: string) => all.find(node => node.props.onClick && text(node) === label)!};
}
async function settle() {for (let i = 0; i < 6; i++) await Promise.resolve();}
beforeEach(() => {hooks.state = []; hooks.refs = []; hooks.effects = []; vi.clearAllMocks(); hooks.openExternal.mockResolvedValue(); vi.useFakeTimers();});
afterEach(() => {hooks.effects.forEach(effect => effect.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals();});

it('switches an expired QR to a same-dialog retry, and removes its open/copy links', async () => {
  const job = qr();
  expect(scan(job).button('打开链接')).toBeDefined();
  await vi.advanceTimersByTimeAsync(1000);
  const expired = scan(job);
  expect(text(expired.tree)).toContain('二维码已过期');
  expect(expired.button('打开链接')).toBeUndefined();
  expired.button('重新获取二维码').props.onClick();
  expect(onRetry).toHaveBeenCalledOnce();
  expect(scan(job, true).button('重新获取二维码').props.disabled).toBe(true);
});

it('opens official URLs and keeps the QR on a shell failure', async () => {
  hooks.openExternal.mockRejectedValueOnce(new Error('浏览器无法打开'));
  const job = qr(); scan(job).button('打开链接').props.onClick(); await settle();
  const next = scan(job);
  expect(hooks.openExternal).toHaveBeenCalledWith(url);
  expect(next.all.some(node => node.type === 'img')).toBe(true);
  expect(next.all.find(node => node.props.role === 'alert')?.props.children).toBe('浏览器无法打开');
});

it('expands and selects the complete URL when clipboard access fails', async () => {
  vi.stubGlobal('navigator', {clipboard: {writeText: vi.fn(async () => {throw new Error('denied');})}, platform: 'MacIntel'});
  const job = qr(), ui = scan(job);
  const disclosure = {open: false}, input = {focus: vi.fn(), select: vi.fn()};
  ui.all.find(node => node.type === 'details')!.props.ref.current = disclosure;
  ui.all.find(node => node.type === 'input')!.props.ref.current = input;
  ui.button('复制链接').props.onClick(); await settle();
  expect(disclosure.open).toBe(true); expect(input.focus).toHaveBeenCalledOnce(); expect(input.select).toHaveBeenCalledOnce();
  expect(text(scan(job).tree)).toContain('已选中链接，按 ⌘C 复制');
});

it('keeps the checklist available before grants finish, and separates later configuration from navigation', () => {
  const onClose = vi.fn(), onChecklist = vi.fn();
  function render(busy = false, job?: Job) {
    hooks.si = hooks.ri = hooks.ei = 0;
    const tree = RegistrationDialog({modal: {kind: 'register', jobId, agentId: 'cli_registered' as AgentId}, job, busy, onClose, onRetry, onChecklist});
    return {tree, all: nodes(tree)};
  }
  const ui = render();
  const next = ui.all.find(node => text(node) === '检查连接' && node.props.onClick)!;
  expect(next.props.variant).toBe('secondary'); expect(next.props.disabled).not.toBe(true);
  next.props.onClick(); expect(onChecklist).toHaveBeenCalledOnce();
  ui.all.find(node => text(node) === '稍后配置' && node.props.onClick)!.props.onClick();
  expect(onClose).toHaveBeenCalledOnce();
  ui.all.find(node => node.props.onReadyChange)!.props.onReadyChange(true);
  expect(render().all.find(node => text(node) === '检查连接' && node.props.onClick)!.props.variant).toBe('primary');
  expect(render(true).tree.props.onClose).toBeUndefined();
  expect(render(false, {id: jobId, type: 'registerAgent', phase: 'activating', message: '正在保存'}).tree.props.onClose).toBeUndefined();
});

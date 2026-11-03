import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DesktopUpdate} from '@vonvon/protocol';
import {DesktopUpdateButton} from '../src/DesktopUpdateButton';
import {AppShell} from '../src/LocalShell';

const h = vi.hoisted(() => ({
  update: undefined as DesktopUpdate | undefined,
  phase: undefined as string | undefined, error: undefined as string | undefined,
  install: vi.fn(), run: vi.fn(), navigate: vi.fn(), supported: true,
}));
vi.mock('../src/client-context', () => ({useShellCapabilities: () => h.supported ? {installDesktopUpdate: h.install} : undefined}));
vi.mock('../src/desktop-update', () => ({
  useDesktopUpdate: () => [h.update],
  useDesktopUpdateOperation: () => ({phase: h.phase, error: h.error, run: h.run}),
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: h.navigate})}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const action = () => nodes(DesktopUpdateButton()).find(node => node.props.onClick)!;
beforeEach(() => {
  vi.clearAllMocks(); h.phase = h.error = undefined; h.supported = true;
  h.update = {state: 'available', current: '0.7.7', latest: '0.7.8', message: ''};
});

it('downloads immediately without leaving the page, then waits for a separate guarded install click', () => {
  expect(action().props['aria-label']).toBe('下载更新');
  action().props.onClick();
  expect(h.run).toHaveBeenCalledWith(h.install, 'downloading');
  expect(h.navigate).not.toHaveBeenCalled();
  h.run.mockClear(); h.update!.state = 'downloaded';
  expect(action().props['aria-label']).toBe('重启升级');
  action().props.onClick();
  expect(h.run).not.toHaveBeenCalled();
  h.navigate.mock.calls[0]![0]();
  expect(h.run).toHaveBeenCalledWith(h.install, 'installing');
});

it('displays a disabled activity state, and offers an accessible retry after failure', () => {
  h.phase = 'downloading';
  expect(action().props).toMatchObject({disabled: true, 'aria-busy': true, 'aria-label': '正在下载更新'});
  h.phase = undefined; h.error = '下载失败，请检查网络';
  expect(action().props).toMatchObject({'aria-label': '重试下载', disabled: false});
  expect(action().props.title).toContain(h.error);
  expect(renderToStaticMarkup(DesktopUpdateButton())).toContain('role="status"');
  h.update!.state = 'downloaded'; h.phase = 'installing';
  expect(action().props).toMatchObject({disabled: true, 'aria-busy': true, 'aria-label': '正在重启升级'});
});

it('shows progress reported by the updater and keeps installation separate from download completion', () => {
  h.phase = 'downloading';
  h.update!.downloadProgress = {percent: 42.9, transferred: 429, total: 1000};
  expect(action().props).toMatchObject({disabled: true, 'aria-label': '正在下载更新，42%'});
  expect(renderToStaticMarkup(DesktopUpdateButton())).toContain('下载 42%');
  h.update!.downloadProgress.percent = 100;
  expect(action().props['aria-label']).toBe('正在下载更新，100%');
  h.phase = undefined; h.update!.state = 'downloaded';
  expect(action().props['aria-label']).toBe('重启升级');
  // owner 2026-11-02: the second step says it interrupts the conversations in progress, and asks nothing more.
  expect(renderToStaticMarkup(DesktopUpdateButton())).toContain('重启升级');
  expect(action().props.title).toContain('正在进行的对话会被中断');
  expect(h.run).not.toHaveBeenCalled();
});

it.each(['current', 'unavailable', 'install-pending'] as const)('stays quiet for %s and web-only clients', state => {
  h.update!.state = state;
  expect(DesktopUpdateButton()).toBeNull();
  h.update!.state = 'available'; h.supported = false;
  expect(DesktopUpdateButton()).toBeNull();
});

it.each(['home', 'collaboration', 'settings'] as const)('keeps the small action in the toolbar on %s', page => {
  const html = renderToStaticMarkup(<AppShell page={page} view="agents" title="页面" updateAction={<DesktopUpdateButton/>}
    onNavigate={() => {}} onOpenList={() => {}}><p>页面内容</p></AppShell>);
  expect(html.indexOf('下载更新')).toBeLessThan(html.indexOf('</header>'));
  expect(html).toContain('页面内容');
  expect(html).not.toContain('role="dialog"');
});

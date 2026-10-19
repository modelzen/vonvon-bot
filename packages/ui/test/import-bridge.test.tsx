import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {ImportFirstRunStep, ImportPage, importComplete, type ImportPreview} from '../src/import/ImportPage';

const preview: ImportPreview = {bots: [{
  id: 'app-1', name: '工作 Bot', tenant: 'feishu',
  groups: [{id: 'chat-1', name: '项目群'}],
  sessions: [{id: 'thread-1', groupId: 'chat-1'}],
}]};

it('lists inspected bots, groups, and sessions before confirmation', () => {
  const html = renderToStaticMarkup(<ImportPage view={{kind: 'ready', preview}} onConfirm={() => {}} />);
  expect(html).toContain('工作 Bot');
  expect(html).toContain('项目群');
  expect(html).toContain('thread-1');
  expect(html).toContain('确认导入');
  expect(html).not.toContain('所有 Bot 已连接');
});

it('keeps confirmation disabled without a real execution action or imported bots', () => {
  const noAction = renderToStaticMarkup(<ImportPage view={{kind: 'ready', preview}} />);
  const empty = renderToStaticMarkup(<ImportPage view={{kind: 'ready', preview: {bots: []}}} onConfirm={() => {}} />);
  expect(noAction).toMatch(/disabled=""[^>]*><span>确认导入/);
  expect(empty).toMatch(/disabled=""[^>]*><span>确认导入/);
});

it('never reports completion for empty, partial, or unverified results', () => {
  const cases = [
    {kind: 'result', bots: [], bridgeDisabled: true},
    {kind: 'result', bots: [{id: 'app-1', name: '工作 Bot', connected: false}], bridgeDisabled: true},
    {kind: 'result', bots: [{id: 'app-1', name: '工作 Bot', connected: true}], bridgeDisabled: false},
  ] as const;
  for (const view of cases) {
    expect(importComplete(view)).toBe(false);
    expect(renderToStaticMarkup(<ImportPage view={view} />)).not.toContain('所有 Bot 已连接');
  }
  const complete = {kind: 'result', bots: [{id: 'app-1', name: '工作 Bot', connected: true}], bridgeDisabled: true} as const;
  expect(importComplete(complete)).toBe(true);
  expect(renderToStaticMarkup(<ImportPage view={complete} />)).toContain('所有 Bot 已连接');
});

it('shows unavailable, loading, failed, and cancelled states without a success claim', () => {
  for (const view of [{kind: 'unavailable'}, {kind: 'loading'}, {kind: 'failed', message: '连接失败'}, {kind: 'cancelled'}] as const) {
    const html = renderToStaticMarkup(<ImportPage view={view} />);
    expect(html).not.toContain('所有 Bot 已连接');
    expect(html).toMatch(/disabled=""[^>]*><span>确认导入/);
  }
  expect(renderToStaticMarkup(<ImportFirstRunStep onOpen={() => {}} />)).toContain('无需登录 Vonvon 账号');
});

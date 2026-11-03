import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {LinkPreview} from '@vonvon/protocol';
import {addDialogReducer, AddDeviceStage, EMPTY_ADD_DIALOG, type AddDialogState, type StageActions} from '../src/devices/AddDeviceDialog';
import {A, B, rowA} from './devices-fixture';

// devices-ui-1b 第 5 节 add-device-dialog. main 必败: there was no way to add a device.
const now = Date.now();
const preview: Extract<LinkPreview, {ok: true}> = {ok: true, deviceId: A, name: '机房', expiresAt: now + 8 * 60_000, repair: false,
  routes: [{host: '100.64.0.10', port: 7767, kind: 'tailscale'}, {host: '192.0.2.10', port: 7767, kind: 'lan'}]};
const actions: StageActions = {input: vi.fn(), rename: vi.fn(), add: vi.fn(), cancel: vi.fn(), reset: vi.fn(), close: vi.fn(), switchTo: vi.fn()};
const stage = (state: AddDialogState, extra: Partial<Parameters<typeof AddDeviceStage>[0]> = {}) =>
  renderToStaticMarkup(<AddDeviceStage state={state} now={now} actions={actions} {...extra}/>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

it('goes from the pasted link to a failure that asks for a new link, and back to an empty box', () => {
  const link = 'vonvon://pair#example';
  let state = addDialogReducer(EMPTY_ADD_DIALOG, {type: 'input', link});
  expect(addDialogReducer(state, {type: 'inspected', link: 'vonvon://pair#older', preview})).toBe(state);
  state = addDialogReducer(state, {type: 'inspected', link, preview});
  expect(state).toMatchObject({stage: 'confirm', name: '机房', link});
  state = addDialogReducer(state, {type: 'start', name: '机房'});
  expect(state.stage).toBe('adding');
  state = addDialogReducer(state, {type: 'result', result: {kind: 'failed', code: 'link_used', attempts: []}});
  expect(state).toMatchObject({stage: 'failed', code: 'link_used'});
  const failed = stage(state);
  expect(failed).toContain('粘贴新链接');
  expect(failed).toContain('vonvon clients ls');
  expect(failed).not.toContain('再试一次');
  state = addDialogReducer(state, {type: 'reset'});
  expect(state).toEqual({stage: 'paste', link: '', name: ''});
  expect(stage(state)).not.toContain('vonvon://pair#example');
});

it('offers another try with the same link for other failures', () => {
  const html = stage({stage: 'failed', link: 'x', name: '机房', preview, code: 'unreachable',
    attempts: [{route: preview.routes[0]!, code: 'unreachable'}]});
  expect(html).toContain('再试一次');
  expect(html).toContain('关闭');
  expect(html).toContain('tailscale ping 100.64.0.10');
});

it('shows each address with its kind, and stops at the link expiry', () => {
  const html = stage({stage: 'confirm', link: 'x', name: '机房', preview});
  // the device's card names it; each address with its kind
  expect(html).toContain('device-add__preview');
  expect(html).toContain('机房');
  expect(text(html)).toContain('Tailscale（推荐） 100.64.0.10:7767');
  expect(text(html)).toContain('局域网 192.0.2.10:7767');
  expect(html).toContain('还剩 8 分钟');
  expect(html).not.toMatch(/disabled=""[^>]*><span>连接并添加/);
  const expired = stage({stage: 'confirm', link: 'x', name: '机房', preview: {...preview, expiresAt: now - 1}});
  expect(expired).toMatch(/disabled=""[^>]*><span>连接并添加/);
  expect(expired).toContain('这条链接已经过期');
  expect(stage({stage: 'confirm', link: 'x', name: '', preview})).toContain('名字要 1 到 40 个字。');
});

it('says when a repair link belongs to another device', () => {
  const html = stage({stage: 'confirm', link: 'x', name: '家里', preview: {...preview, deviceId: B, name: '家里'}}, {repairOf: rowA});
  expect(html).toContain('这条链接是「家里」的，不是「机房」的。');
  expect(html).not.toMatch(/disabled=""[^>]*><span>连接并添加/);
});

it('reports progress, and what came of it', () => {
  expect(stage({stage: 'adding', link: 'x', name: '机房'}, {adding: {stage: 'connecting', route: preview.routes[0]}})).toContain('正在连接 100.64.0.10:7767…');
  expect(stage({stage: 'adding', link: 'x', name: '机房'}, {adding: {stage: 'pairing'}})).toContain('正在配对…');
  expect(stage({stage: 'adding', link: 'x', name: '机房'}, {adding: {stage: 'checking'}})).toContain('正在核对版本…');
  const added = stage({stage: 'done', result: {kind: 'added', deviceId: A, name: '机房', repaired: false}});
  expect(added).toContain('已添加「机房」。');
  expect(added).toContain('切换到「机房」');
  expect(stage({stage: 'done', result: {kind: 'updated', deviceId: A, name: '机房'}})).toContain('已按新链接更新了它的地址');
  const again = stage({stage: 'paste', link: 'x', name: '机房', problem: {ok: false, code: 'already_added', deviceId: A, name: '机房'}});
  expect(again).toContain('「机房」已经在设备列表里了。');
  expect(again).toContain('切换到「机房」');
});

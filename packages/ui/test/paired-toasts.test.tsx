import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DeviceEventPayload} from '@vonvon/protocol';
import {pairedToasts, PairedToastsView} from '../src/devices/PairedToasts';

// devices-ui-3 第 5 节 paired-toasts. main 必败: there was no toast.
const paired = (clientId: string, name: string, change: DeviceEventPayload['change'] = 'client-paired'): DeviceEventPayload =>
  ({change, clientId, name, clientKind: 'desktop', address: '100.64.0.10:52144', invitedBy: 'local'});

it('shows a pairing once per client, the newest two, and no revocation', () => {
  const events = [paired('a', 'A'), paired('b', 'B'), paired('a', 'A'), paired('c', 'C', 'client-revoked'), paired('d', 'D')];
  expect(pairedToasts(events, new Set()).map(event => event.clientId)).toEqual(['d', 'a']);
  expect(pairedToasts(events, new Set(['d'])).map(event => event.clientId)).toEqual(['a', 'b']);
  expect(pairedToasts([paired('c', 'C', 'client-revoked')], new Set())).toEqual([]);
});
it('gives 查看 only while this computer is shown', () => {
  const shown = [paired('a', '工作笔记本')];
  const local = renderToStaticMarkup(<PairedToastsView shown={shown} local onClose={vi.fn()}/>);
  expect(local).toContain('新设备「工作笔记本」（桌面端，来自 100.64.0.10）已经配对');
  expect(local).toContain('查看');
  expect(local).toContain('关闭「工作笔记本」的配对提示');
  const away = renderToStaticMarkup(<PairedToastsView shown={shown} local={false} onClose={vi.fn()}/>);
  expect(away).toContain('已经配对');
  // shown over any device: it names this computer, never 本机 (a remote page does not say 本机)
  expect(away).toContain('有新设备配对到这台电脑');
  expect(away).not.toContain('本机');
  expect(away).not.toContain('查看');
  expect(renderToStaticMarkup(<PairedToastsView shown={[]} local onClose={vi.fn()}/>)).toBe('');
});

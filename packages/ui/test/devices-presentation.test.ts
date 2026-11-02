import {expect, it, vi} from 'vitest';
import type {LinkPreviewCode, MachineRequestHandler} from '@vonvon/protocol';
import {
  addBlockedReason, bannerCopy, cannotUpgradeRemotely, compareVersions, copy, failureCopy, linkPreviewCopy, maintenanceRequest, platformLabel,
  registryNotices, relativeTime, removeCopy, routeHint, routeHints, routeKindLabel, rowView, statusLabel, statusTone, versionNotice,
} from '../src/devices/devices-presentation';
import {rowA, rowB} from './devices-fixture';

// devices-ui-1b 第 5 节 devices-presentation. main 必败: there was no devices page.
const X = '「X」';
const now = new Date(2026, 10, 2, 12, 0, 0).getTime();
const tailscale = {host: '100.64.0.10', port: 7767, kind: 'tailscale'} as const;

it('names each status, and when it was last seen', () => {
  const labels = {online: '在线', connecting: '正在连接', reconnecting: '重连中', offline: '连不上', maintenance: '版本不一致', revoked: '已撤销', 'needs-pairing': '需要重新配对'} as const;
  for (const [status, label] of Object.entries(labels)) expect(statusLabel({status: status as keyof typeof labels}, now)).toBe(label);
  expect(statusLabel({status: 'unknown', lastConnectedAt: now - 5 * 60_000}, now)).toBe('上次在线 5 分钟前');
  expect(statusLabel({status: 'unknown'}, now)).toBe('还没连过');
  expect([statusTone('online'), statusTone('reconnecting'), statusTone('maintenance'), statusTone('needs-pairing'), statusTone('unknown')]).toEqual(['green', 'yellow', 'orange', 'red', 'gray']);
});

it('says how long ago, not a time of day', () => {
  expect(relativeTime(now - 30_000, now)).toBe('刚刚');
  expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
  expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 天前');
  const tenDays = new Date(now - 10 * 86_400_000);
  expect(relativeTime(tenDays.getTime(), now)).toBe(`${tenDays.getMonth() + 1}月${tenDays.getDate()}日`);
  expect(relativeTime(new Date(2025, 4, 6).getTime(), now)).toBe('2025年5月6日');
  expect(relativeTime(now + 90_000, now)).toBe('刚刚');
});

it('names the system only when the device said one', () => {
  expect(['macos', 'windows', 'linux', 'unsupported', undefined].map(platformLabel)).toEqual(['macOS', 'Windows', 'Linux', '', '']);
  expect(rowView({...rowA, platform: 'unsupported'}, now).detail).toEqual(['v0.9.1']);
  expect(rowView({...rowB, platform: undefined}, now).detail).toEqual(['v0.9.0']);
  expect(rowView({id: 'local', name: '这台电脑', current: true, status: 'online', platform: 'macos', routes: []}, now, 'Clay 的 Mac')).toMatchObject({title: '这台电脑', detail: ['Clay 的 Mac', 'macOS'], repair: false});
});

it('gives a hint per kind of address', () => {
  expect(routeHint(tailscale, 'unreachable', X)).toContain('`tailscale ping 100.64.0.10`');
  expect(routeHint({...tailscale, host: '192.0.2.10', kind: 'lan'}, 'timeout', X)).toContain('同一个局域网');
  expect(routeHint({...tailscale, kind: 'cgnat'}, 'timeout', X)).toContain('运营商');
  expect(routeHint({host: '198.51.100.7', port: 17767, kind: 'public'}, 'timeout', X)).toContain('17767');
  // A1: a network tool's address (ZeroTier, 蒲公英…). main 必败: no such kind
  expect(routeHint({...tailscale, host: '10.147.17.5', kind: 'overlay'}, 'timeout', X)).toContain('同一个组网');
  expect(routeKindLabel('overlay')).toBe('组网');
  expect(routeHint(tailscale, 'forbidden', X)).toContain('重新生成连接链接');
  expect(routeHint(tailscale, 'refused', X)).toMatch(/看看。那台设备上的 Vonvon Bot 可能没在运行/);
  expect(routeHint(tailscale, 'device_identity_changed', X)).toContain('100.64.0.10:7767 上的 Vonvon Bot 不是「X」');
  expect(routeHints([{route: tailscale, code: 'timeout'}, {route: {...tailscale, kind: 'lan'}, code: 'timeout'}], X)).toHaveLength(2);
});

const failureCodes = ['client_revoked', 'revoked', 'device_identity_changed', 'identity_changed', 'unknown_client', 'key_unreadable', 'remote_disabled', 'rate_limited',
  'handshake_failed', 'protocol_mismatch', 'refused', 'unreachable', 'timeout', 'closed', 'forbidden', 'link_used', 'pairing_failed', 'link_expired', 'busy', 'aborted',
  'registry_write_failed', 'pairing_interrupted', 'already_added', 'something_new'];
const previewCodes: LinkPreviewCode[] = ['invalid_link', 'link_expired', 'own_link', 'already_added', 'no_secure_storage', 'registry_newer', 'registry_unreadable', 'too_many'];

it('says why it failed, naming the device', () => {
  for (const code of failureCodes) {
    const text = failureCopy(code, X);
    expect(text).not.toBe('');
    if (!['busy', 'aborted', 'registry_write_failed'].includes(code)) expect(text, code).toContain(X);
  }
  expect(failureCopy('link_used', X)).toContain('`vonvon clients ls`');
  // A1: one address, so a 4006 may be a move: the new link only updates it, and there is no --tailscale
  expect(failureCopy('remote_disabled', X)).toMatch(/换了地址.*粘到"添加设备"里，只会更新地址，不用重新配对/);
  expect(failureCopy('remote_disabled', X)).not.toContain('--tailscale');
  expect(failureCopy('client_revoked', X)).toBe('「X」已取消这台电脑的访问。要再连，请在那台设备上重新生成连接链接。');
  expect(failureCopy('something_new', X)).toBe('没能连上「X」（something_new）。');
  expect(failureCopy('invalid_link', X)).toBe(linkPreviewCopy('invalid_link', X));
});

it('compares versions and says which side is behind', () => {
  const base = {clientVersion: '0.9.1', clientProtocol: 2, name: X};
  const serverOld = versionNotice({...base, serverVersion: '0.9.0', serverProtocol: 2, capabilities: ['device', 'update.standalone']});
  expect(serverOld).toMatchObject({side: 'server', blocking: false, action: 'upgrade-server'});
  expect(serverOld?.text).toBe('「X」的服务端是 0.9.0，这台电脑是 0.9.1。可以继续用；建议升级服务端。');
  expect(versionNotice({...base, serverVersion: '0.9.0', serverProtocol: 2, capabilities: ['device']})?.action).toBeUndefined();
  expect(versionNotice({...base, serverVersion: '0.9.2', serverProtocol: 2, capabilities: ['device']})).toMatchObject({side: 'client', blocking: false, action: 'update-client'});
  expect(versionNotice({...base, serverVersion: '0.9.2', serverProtocol: 2, capabilities: []})?.text).toContain('先更新这台电脑');
  const blocked = versionNotice({serverVersion: '0.9.0', serverProtocol: 2, clientVersion: '0.10.0', clientProtocol: 3, capabilities: ['device'], name: X});
  expect(blocked).toMatchObject({side: 'server', blocking: true});
  expect(blocked?.text).toContain('两边不能一起工作');
  expect(versionNotice({...base, serverVersion: '0.9.0', serverProtocol: 3, capabilities: ['device']})).toMatchObject({side: 'client', blocking: true});
  const v1 = versionNotice({...base, serverVersion: '0.7.4', serverProtocol: 1, name: X});
  expect(v1).toMatchObject({side: 'server', blocking: true});
  expect(v1?.action).toBeUndefined();
  expect(v1?.text).toBe('「X」上的 Vonvon Bot（0.7.4）不支持远程管理，请在那台设备上升级一次。');
  expect(versionNotice({...base, serverVersion: '0.9.1', serverProtocol: 2, capabilities: ['device']})).toBeNull();
  expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
  expect(compareVersions('0.9.0-beta.1', '0.9.0')).toBe(-1);
  expect(compareVersions('0.9.0', '0.9.0')).toBe(0);
});

it('says why the list cannot be changed', () => {
  expect(registryNotices({registry: 'recovered', secureStorage: true})).toEqual([copy.recovered]);
  expect(registryNotices({registry: 'ok', secureStorage: false})).toEqual([linkPreviewCopy('no_secure_storage', '')]);
  expect(addBlockedReason({registry: 'recovered', secureStorage: true})).toBeUndefined();
  expect(addBlockedReason({registry: 'unreadable', secureStorage: true})).toContain('读不了设备列表文件');
});

it('says the connection is back or why it is gone', () => {
  const reconnecting = {id: rowA.id, phase: 'reconnecting', mode: 'full', attempt: 3, retryAt: now + 4_000,
    failure: {code: 'timeout', attempts: [{route: tailscale, code: 'timeout'}], at: now}} as const;
  expect(bannerCopy(reconnecting, X, now)).toMatchObject({text: '和「X」的连接断了，正在重连（4 秒后再试）。', retry: true});
  expect(bannerCopy(reconnecting, X, now)?.hints[0]).toContain('tailscale ping');
  expect(bannerCopy({...reconnecting, attempt: 1}, X, now)?.hints).toEqual([]);
  expect(bannerCopy({...reconnecting, expected: 'stop'}, X, now)?.text).toContain('后台服务已停止');
  expect(bannerCopy({id: rowA.id, phase: 'ready', attempt: 0, notice: {kind: 'restarted', at: 5}}, X, now)).toMatchObject({text: '「X」重启过了，已重新连上。', noticeAt: 5});
  expect(bannerCopy({id: rowA.id, phase: 'ready', attempt: 0}, X, now)).toBeUndefined();
});

it('never says 服务器 or sends anyone to log in', () => {
  const names = [X, '这台电脑'];
  const texts = [
    ...Object.values(copy), ...names.flatMap(name => [...failureCodes.map(code => failureCopy(code, name)), ...previewCodes.map(code => linkPreviewCopy(code, name)),
      removeCopy.title(name), removeCopy.body(name, true), removeCopy.body(name, false), removeCopy.kept(name), cannotUpgradeRemotely(name),
      ...(['tailscale', 'overlay', 'lan', 'cgnat', 'public'] as const).flatMap(kind => ['refused', 'forbidden', 'device_identity_changed'].map(code => routeHint({...tailscale, kind}, code, name)))]),
    ...registryNotices({registry: 'recovered', secureStorage: false}),
  ];
  for (const text of texts) expect(text).not.toMatch(/服务器|登录 Codex|登录 Claude|不代你登录/);
});

it('lets only upgrades through while the versions cannot work together', async () => {
  const machine = vi.fn<MachineRequestHandler>(async () => ({type: 'done', message: 'ok'}));
  const request = maintenanceRequest(machine);
  await expect(request({type: 'status'})).rejects.toThrow(copy.maintenanceOnly);
  expect(machine).not.toHaveBeenCalled();
  await request({type: 'checkCoreUpdate'});
  expect(machine).toHaveBeenCalledWith({type: 'checkCoreUpdate'});
});

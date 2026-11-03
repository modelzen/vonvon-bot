import {expect, it} from 'vitest';
import type {ClientRecord, DeviceStatus} from '@vonvon/protocol';
import * as words from '../src/settings/remote-access-presentation';
import {
  addressRows, cascadeCount, confirmedRequest, defaultPick, disableStep, enableErrorText, enableStep, hostOf, invitedByText, isRecent, kindLabel,
  linkBlocked, linkCountdown, linkUsable, liveClients, pairedToastText, panelTitle, portHint, readErrorText, riskFromReply, stateText,
} from '../src/settings/remote-access-presentation';

// devices-ui-3 第 5 节 remote-access-presentation. main 必败: there was no 允许别的设备连接.
const local = {isRemote: false, name: '这台电脑'};
const remote = {isRemote: true, name: '机房 Linux'};
const status = (remote: Partial<DeviceStatus['remote']>, extra: Partial<DeviceStatus> = {}): DeviceStatus => ({
  device: {id: 'd', name: '办公室 Mac', publicKey: 'k'}, remote: {port: 7767, addresses: [], ...remote}, clients: {total: 0, active: 0}, ...extra,
});
const candidates: NonNullable<DeviceStatus['remote']['candidates']> = [
  {host: '100.64.0.10', kind: 'tailscale', iface: 'utun4', tool: 'Tailscale'}, {host: 'fd7a:115c:a1e0::7', kind: 'tailscale', iface: 'utun4', tool: 'Tailscale'},
  {host: '10.147.17.5', kind: 'overlay', iface: 'feth2', tool: 'ZeroTier'}, {host: '192.168.1.9', kind: 'lan', iface: 'en0'},
  {host: '100.70.0.3', kind: 'cgnat', iface: 'pdp_ip0'}, {host: '203.0.113.9', kind: 'public', iface: 'en9'},
];

it('lists the candidates in their order, marks the open one and the one the caller came in on', () => {
  const rows = addressRows(status({candidates, addresses: [{host: '192.168.1.9', kind: 'lan', enabledAt: 1, state: 'listening'}]}, {via: '192.168.1.9'}));
  expect(rows.map(row => [row.host, row.enabled, row.current, row.recommended])).toEqual([
    ['100.64.0.10', false, false, true], ['fd7a:115c:a1e0::7', false, false, false], ['10.147.17.5', false, false, false],
    ['192.168.1.9', true, true, false], ['100.70.0.3', false, false, false], ['203.0.113.9', false, false, false],
  ]);
  // the words `vonvon remote candidates` uses (A1)
  expect(rows.map(kindLabel)).toEqual(['Tailscale（推荐）', 'Tailscale', '组网 · ZeroTier', '局域网', '运营商地址（要确认）', '公网（要确认）']);
  expect(stateText(rows[3]!)).toBe('监听中');
  expect(defaultPick(rows)).toBe('192.168.1.9');
  expect(defaultPick(rows.map(row => ({...row, enabled: false})))).toBe('100.64.0.10');
});
it('keeps an open address no interface has now, first and waiting; recommends the first one needing no confirmation without Tailscale', () => {
  const rows = addressRows(status({candidates: candidates.slice(3), addresses: [{host: '100.64.0.10', kind: 'tailscale', enabledAt: 1, state: 'waiting'}]}));
  expect(rows[0]).toMatchObject({host: '100.64.0.10', enabled: true, missing: true, state: 'waiting'});
  expect(stateText(rows[0]!)).toBe('等地址出现：这台设备现在没有 100.64.0.10');
  expect(rows.find(row => row.recommended)?.host).toBe('192.168.1.9');
  expect(addressRows(status({candidates: candidates.slice(4)})).some(row => row.recommended)).toBe(false);
  const failed = addressRows(status({candidates: candidates.slice(3, 4), addresses: [{host: '192.168.1.9', kind: 'lan', enabledAt: 1, state: 'failed', detail: 'EACCES'}]}));
  expect(stateText(failed[0]!)).toBe('开不了：EACCES');
});
// fixes-0-9-0: main 必败, a taken port showed only 等地址出现 and dropped the daemon's detail.
it('says the port is taken, in the daemon\'s words, while the address is there', () => {
  const busy = '端口 7767 被占用，每 15 秒重试；可用 `vonvon remote port <n>` 换端口';
  const rows = addressRows(status({candidates: candidates.slice(3), addresses: [{host: '192.168.1.9', kind: 'lan', enabledAt: 1, state: 'waiting', detail: busy}]}));
  expect(rows[0]).toMatchObject({host: '192.168.1.9', enabled: true, missing: false});
  expect(stateText(rows[0]!)).toBe(busy);
  expect(stateText({...rows[0]!, detail: '等待地址 192.168.1.9 出现'})).toBe('等待地址 192.168.1.9 出现');
  const bare = addressRows(status({candidates: candidates.slice(3), addresses: [{host: '192.168.1.9', kind: 'lan', enabledAt: 1, state: 'waiting'}]}));
  expect(stateText(bare[0]!)).toBe('等地址出现');
});
it('asks about the risk for CGNAT and public, about switching when others may be on the old one, and nothing else', () => {
  const rows = addressRows(status({candidates, addresses: [{host: '192.168.1.9', kind: 'lan', enabledAt: 1, state: 'listening'}]}));
  expect(enableStep(rows, '100.70.0.3', local, 0)).toEqual({confirm: {kind: 'risk', host: '100.70.0.3', text: expect.stringMatching(/^100\.70\.0\.3 不在 Tailscale.*CGNAT.*勾选「我了解风险」后再开启。$/)}});
  const risky = enableStep(rows, '203.0.113.9', local, 2);
  expect(risky).toMatchObject({confirm: {kind: 'risk', text: expect.stringMatching(/^这是公网地址。/), also: expect.stringContaining('已配对的 2 台设备要换到新地址')}});
  expect(enableStep(rows, '100.64.0.10', local, 0)).toEqual({request: {type: 'enable', host: '100.64.0.10'}});
  expect(enableStep(rows, '100.64.0.10', local, 3)).toEqual({confirm: {kind: 'switch', host: '100.64.0.10',
    text: '换成 100.64.0.10 后，192.168.1.9 不再接受连接，经它连着的设备会马上断开。已配对的 3 台设备要换到新地址：在下面生成连接链接，粘到那台电脑的 Vonvon Bot → 设置 → 设备 → 添加，只会更新地址，不用重新配对。'}});
  // ticked or not
  if (!('confirm' in risky)) throw new Error('no confirmation');
  expect(confirmedRequest(risky.confirm, false)).toBeUndefined();
  expect(confirmedRequest(risky.confirm, true)).toEqual({type: 'enable', host: '203.0.113.9', allowPublic: true});
});
it('says this computer goes away when the caller replaces or closes the address it came in on', () => {
  const rows = addressRows(status({candidates, addresses: [{host: '100.64.0.10', kind: 'tailscale', enabledAt: 1, state: 'listening'}]}, {via: '100.64.0.10'}));
  expect(enableStep(rows, '192.168.1.9', remote, 0)).toEqual({confirm: {kind: 'switch', host: '192.168.1.9',
    text: '你现在就是通过 100.64.0.10 连着「机房 Linux」的。换成 192.168.1.9 后这台电脑会马上断开，要在「机房 Linux」上生成新链接、粘到"添加设备"里更新地址。'}});
  const open = rows.find(row => row.enabled)!;
  expect(disableStep(open, remote)).toEqual({confirm: {kind: 'disable', host: '100.64.0.10', text: '你现在就是通过这个地址连着「机房 Linux」的。关掉后这台电脑会马上断开，要到那台设备上重新开启。'}});
  expect(disableStep({...open, current: false}, local)).toEqual({request: {type: 'disable', host: '100.64.0.10'}});
});
it('greys the link until an address listens, and counts down', () => {
  expect(linkBlocked([])).toBe('先在上面选一个地址并开启。');
  const rows = addressRows(status({candidates, addresses: [{host: '100.64.0.10', kind: 'tailscale', enabledAt: 1, state: 'waiting'}]}));
  expect(linkBlocked(rows)).toBe('地址还没在监听，等它变成「监听中」再生成。');
  expect(linkBlocked(rows.map(row => row.enabled ? {...row, state: 'listening'} : row))).toBeUndefined();
  expect(linkCountdown(1_000 + 552_000, 1_000)).toBe('还剩 9 分 12 秒');
  expect(linkCountdown(1_000, 1_000)).toBe('已过期');
});
// Codex 审查 267-2、269-1: a link connects to the address and port it was made on.
it('keeps a link usable only while its address is the open one, listening, on its port', () => {
  const rows = (host: string | undefined, state: 'listening' | 'waiting' = 'listening') => addressRows(status({candidates, addresses: host ? [{host, kind: 'tailscale', enabledAt: 1, state}] : []}));
  const made = {host: '100.64.0.10', port: 7767};
  expect(linkUsable(made, rows('100.64.0.10'), 7767)).toBe(true);
  expect(linkUsable(made, rows('192.168.1.9'), 7767)).toBe(false);
  expect(linkUsable(made, rows(undefined), 7767)).toBe(false);
  expect(linkUsable(made, rows('100.64.0.10', 'waiting'), 7767)).toBe(false);
  expect(linkUsable(made, rows('100.64.0.10'), 7768)).toBe(false);
});
it('counts the clients a cascade revokes, down the line through revoked ones, the revoked ones not', () => {
  const at = (id: string, invitedBy: string, revokedAt?: number): ClientRecord => ({id, name: id, publicKey: 'k', clientKind: 'desktop', createdAt: 0, lastSeenAt: 0, lastAddress: '192.0.2.1:1', pairedVia: 'invite', invitedBy, ...(revokedAt ? {revokedAt} : {})});
  const all = [at('A', 'local'), at('B', 'A'), at('C', 'B'), at('D', 'A', 5), at('E', 'D')];
  expect(cascadeCount(all, 'A')).toBe(3);
  expect(cascadeCount(all.slice(0, 4), 'A')).toBe(2);
  expect(cascadeCount(all, 'C')).toBe(0);
  expect(liveClients({kind: 'clients', generation: 1, clients: [{...at('A', 'local'), lastSeenAt: 1}, {...at('B', 'A'), lastSeenAt: 2}, at('D', 'A', 5)]}).map(each => each.id)).toEqual(['B', 'A']);
  expect(invitedByText(at('A', 'local'), all, local)).toBe('在本机生成的链接');
  expect(invitedByText(at('A', 'local'), all, remote)).toBe('在「机房 Linux」上生成的链接');
  expect(invitedByText(at('B', 'A'), all, local)).toBe('由「A」带进来');
  expect(invitedByText(at('X', 'gone'), all, local)).toBe('由一台已删除的设备带进来');
});
it('marks a client paired within 24 hours as new', () => {
  const now = 100 * 3_600_000;
  expect(isRecent({createdAt: now - 23 * 3_600_000}, now)).toBe(true);
  expect(isRecent({createdAt: now - 25 * 3_600_000}, now)).toBe(false);
});
it('says a pairing as devices 第 15 节 does, about this computer', () => {
  expect(pairedToastText({name: '工作笔记本', clientKind: 'desktop', address: '100.64.0.10:52144'}))
    .toBe('新设备「工作笔记本」（桌面端，来自 100.64.0.10）已经配对，可以管理这台电脑的 Vonvon Bot。不是你操作的？到「允许别的设备连接」撤销。');
  expect(pairedToastText({name: 'ci', clientKind: 'cli'})).toBe('新设备「ci」（命令行）已经配对，可以管理这台电脑的 Vonvon Bot。不是你操作的？到「允许别的设备连接」撤销。');
  expect(hostOf('[fd7a:115c:a1e0::7]:443')).toBe('fd7a:115c:a1e0::7');
});
it('names the device: 本机 on this computer, 「X」 on a remote one', () => {
  expect(panelTitle(local)).toBe('允许别的设备连接本机');
  expect(panelTitle(remote)).toBe('允许别的设备连接「机房 Linux」');
  expect(portHint(remote)).toBe('要改端口，在「机房 Linux」的终端运行 `vonvon remote port <端口>`；改完已配对的设备要粘一次新链接。');
  expect(portHint({...remote, name: '办公室 Windows', platform: 'windows'})).toBe('Windows 上这一版改不了端口；端口被别的程序占着时，关掉那个程序后会自己开始。');
  // 0.9.0 Windows 验收 322: 取消 on Windows's firewall question left 监听中 with nothing getting in, and no word of it. main 必败
  expect(portHint({...local, platform: 'windows'})).toBe('开启后 Windows 可能会问是否允许 Vonvon Bot 访问网络，点「允许」。'
    + '点过「取消」的话别的设备连不上：到 Windows 安全中心 → 防火墙和网络保护 → 高级设置 → 入站规则，删掉名为 Vonvon Bot 的「阻止」规则（要管理员权限），再在这里关掉、重新开启，Windows 会再问一次。'
    + 'Windows 上这一版改不了端口；端口被别的程序占着时，关掉那个程序后会自己开始。');
  expect(portHint({...local, platform: 'macos'})).not.toContain('防火墙');
  expect(readErrorText('unsupported', 'x', remote)).toBe('「机房 Linux」上的 Vonvon Bot 太旧，不支持这里的设置。');
  expect(riskFromReply('100.70.0.3 不在 Tailscale…（CGNAT），开启后同一运营商的其他用户也可能连到这台设备。确定要开启请加 `--allow-public`。')).toBe('100.70.0.3 不在 Tailscale…（CGNAT），开启后同一运营商的其他用户也可能连到这台设备。勾选「我了解风险」后再开启。');
  expect(enableErrorText('internal', '磁盘满了')).toBe('开不了：磁盘满了');
});
it('never says 服务器, 主人, systemd or linger', () => {
  const said = JSON.stringify(Object.values(words).map(value => typeof value === 'function' ? value.toString() : value));
  for (const word of ['服务器', '主人', 'systemd', 'linger']) expect(said).not.toContain(word);
});

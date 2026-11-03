import type { NetworkInterfaceInfo } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { Interfaces } from '../src/remote/address';
import { candidateContext, candidateLabel, createCandidates, defaultCandidate, listCandidates } from '../src/remote/candidates';

// A1: the addresses `remote candidates` and `remote enable` offer, from injected interfaces only. main 必败: no list.
const nic = (address: string, internal = false): NetworkInterfaceInfo => (address.includes(':')
  ? { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:00:00:00:00:01', internal, cidr: `${address}/64`, scopeid: 0 }
  : { address, netmask: '255.255.255.0', family: 'IPv4', mac: '02:00:00:00:00:01', internal, cidr: `${address}/24` });
const none = { installed: false, ips: [] };
/** A Mac with Tailscale on utun4, ZeroTier, Wi-Fi, a proxy's TUN, Docker and a VM bridge, a self-assigned card, a CGNAT
 * cellular address and a public one. */
const mac: Interfaces = {
  lo0: [nic('127.0.0.1', true), nic('::1', true)],
  en0: [nic('192.168.1.23'), nic('fe80::1'), nic('2001:db8::5')],
  utun4: [nic('100.101.7.12'), nic('fd7a:115c:a1e0::7')],
  feth2: [nic('10.147.17.5')],
  utun7: [nic('198.18.0.1')],
  bridge100: [nic('192.168.64.1')],
  docker0: [nic('172.17.0.1')],
  en5: [nic('169.254.3.4')],
  pdp_ip0: [nic('100.70.0.3')],
  en9: [nic('203.0.113.9')],
};
const ts = { installed: true, ips: ['100.101.7.12', 'fd7a:115c:a1e0::7'] };

it('lists Tailscale first, then the other network tools, the LAN, CGNAT and public, leaving bridges and proxies out', () => {
  const list = listCandidates({ interfaces: mac, tailscale: ts });
  expect(list).toEqual([
    { host: '100.101.7.12', kind: 'tailscale', iface: 'utun4', tool: 'Tailscale' },
    { host: 'fd7a:115c:a1e0::7', kind: 'tailscale', iface: 'utun4', tool: 'Tailscale' },
    { host: '10.147.17.5', kind: 'overlay', iface: 'feth2', tool: 'ZeroTier' },
    { host: '192.168.1.23', kind: 'lan', iface: 'en0' },
    { host: '100.70.0.3', kind: 'cgnat', iface: 'pdp_ip0' },
    { host: '203.0.113.9', kind: 'public', iface: 'en9' },
  ]);
  expect(defaultCandidate(list)).toMatchObject({ host: '100.101.7.12' });
  expect(list.map((candidate, at) => candidateLabel(candidate, at === 0))).toEqual([
    'Tailscale（推荐）· 100.101.7.12', 'Tailscale · fd7a:115c:a1e0::7', '组网 · ZeroTier · 10.147.17.5', '局域网 · 192.168.1.23',
    '运营商地址 · 100.70.0.3（要确认）', '公网 · 203.0.113.9（要确认）',
  ]);
});
it('lists the left-out ones last with --all, saying why', () => {
  const hidden = listCandidates({ interfaces: mac, tailscale: ts }, { all: true }).filter(candidate => candidate.hidden);
  expect(hidden).toEqual([
    { host: '192.168.64.1', kind: 'lan', iface: 'bridge100', hidden: 'bridge' },
    { host: '172.17.0.1', kind: 'lan', iface: 'docker0', hidden: 'bridge' },
    { host: '169.254.3.4', kind: 'lan', iface: 'en5', hidden: 'self-assigned' },
    // 198.18/15 would otherwise read as a public address; on a tunnel it is a network tool's, still left out
    { host: '198.18.0.1', kind: 'public', iface: 'utun7', hidden: 'proxy' },
  ]);
  expect(hidden.map(candidate => candidateLabel(candidate))).toEqual([
    '虚拟网桥 · 192.168.64.1（一般用不上）', '虚拟网桥 · 172.17.0.1（一般用不上）', '自动分配的地址 · 169.254.3.4（一般用不上）', '代理软件的虚拟地址 · 198.18.0.1（一般用不上）',
  ]);
});
it('leaves out the Windows bridges for WSL and Hyper-V, and keeps an external switch that carries the LAN', () => {
  const windows: Interfaces = {
    'vEthernet (WSL (Hyper-V firewall))': [nic('172.28.48.1')], 'vEthernet (Default Switch)': [nic('172.20.0.1')],
    'vEthernet (外部网络)': [nic('192.168.1.40')], 'VMware Network Adapter VMnet8': [nic('192.168.200.1')], 'VirtualBox Host-Only Network': [nic('192.168.56.1')],
    Tailscale: [nic('100.64.0.10')], 'ZeroTier One [8056c2e21c000001]': [nic('10.147.18.2')],
  };
  expect(listCandidates({ interfaces: windows, tailscale: none }).map(candidate => [candidate.host, candidate.kind])).toEqual([
    ['100.64.0.10', 'tailscale'], ['10.147.18.2', 'overlay'], ['192.168.1.40', 'lan'],
  ]);
});
it('offers the first address that needs no confirmation when there is no Tailscale, and none when every one does', () => {
  const lanOnly = listCandidates({ interfaces: { eth0: [nic('203.0.113.9')], wlan0: [nic('192.168.1.23')] }, tailscale: none });
  expect(lanOnly.map(candidate => candidate.host)).toEqual(['192.168.1.23', '203.0.113.9']);
  expect(defaultCandidate(lanOnly)).toMatchObject({ host: '192.168.1.23' });
  expect(defaultCandidate(listCandidates({ interfaces: { eth0: [nic('203.0.113.9')] }, tailscale: none }))).toBeUndefined();
  expect(listCandidates({ interfaces: { lo: [nic('127.0.0.1', true)] }, tailscale: none })).toEqual([]);
});
it('runs `tailscale ip` only when a 100.64/10 address could be Tailscale\'s and no card name says so', async () => {
  const tailscale = vi.fn(async () => ts);
  await candidateContext({ interfaces: () => ({ tailscale0: [nic('100.101.7.12')], eth0: [nic('192.168.1.23')] }), tailscale });
  expect(tailscale).not.toHaveBeenCalled();
  const ctx = await candidateContext({ interfaces: () => ({ utun4: [nic('100.101.7.12')] }), tailscale });
  expect(tailscale).toHaveBeenCalledOnce();
  expect(ctx.tailscale).toEqual(ts);
});

// devices-ui-3 4.2: device.status keeps the list 30 seconds, on the object, without the hidden ones. main 必败: no createCandidates
it('keeps the list 30 seconds on its own object, and reads again after clear', async () => {
  let now = 0;
  const interfaces = vi.fn(() => mac);
  const kept = createCandidates({ interfaces, tailscale: async () => ts, now: () => now });
  const first = await kept.list();
  expect(first.map(candidate => candidate.host)).toEqual(['100.101.7.12', 'fd7a:115c:a1e0::7', '10.147.17.5', '192.168.1.23', '100.70.0.3', '203.0.113.9']);
  now = 29_999;
  await kept.list();
  expect(interfaces).toHaveBeenCalledOnce();
  kept.clear();
  await kept.list();
  expect(interfaces).toHaveBeenCalledTimes(2);
  now = 60_000;
  await kept.list();
  expect(interfaces).toHaveBeenCalledTimes(3);
  const other = vi.fn(() => ({ eth0: [nic('192.168.1.9')] }));
  expect((await createCandidates({ interfaces: other, tailscale: async () => none, now: () => now }).list()).map(candidate => candidate.host)).toEqual(['192.168.1.9']);
  expect(interfaces).toHaveBeenCalledTimes(3);
});
it('puts a Windows Tailscale adapter first, as 允许别的设备连接 shows it', async () => {
  const windows = createCandidates({ interfaces: () => ({ Tailscale: [nic('100.64.0.10')], Ethernet: [nic('192.168.1.9')] }), tailscale: async () => ({ installed: true, ips: ['100.64.0.10'] }) });
  expect((await windows.list())[0]).toEqual({ host: '100.64.0.10', kind: 'tailscale', iface: 'Tailscale', tool: 'Tailscale' });
});

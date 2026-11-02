import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { canonicalHost, classifyAddress, hostHeader, networkIdentity, pickTailscaleAddress, resolveEnable, type Interfaces } from '../src/remote/address';

const nic = (address: string, mac = '02:00:00:00:00:01'): NetworkInterfaceInfo => (address.includes(':')
  ? { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac, internal: false, cidr: `${address}/64`, scopeid: 0 }
  : { address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr: `${address}/24` });
const on = (name: string, ...addresses: string[]): Interfaces => ({ [name]: addresses.map(address => nic(address)) });
const none = { installed: false, ips: [] };

// D3 第 5 节 / devices 4.2: main 必败, there was no classification.
describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'], ['::1', 'loopback'], ['0.0.0.0', 'public'], ['::', 'public'],
    ['10.1.2.3', 'lan'], ['172.16.0.9', 'lan'], ['172.31.255.1', 'lan'], ['192.168.1.9', 'lan'], ['169.254.1.1', 'lan'], ['fd00::1', 'lan'], ['fe80::1', 'lan'],
    ['172.32.0.1', 'public'], ['8.8.8.8', 'public'], ['fd7a:115c:a1e0::1', 'tailscale'],
    ['example.com', 'invalid'], ['192.168.1', 'invalid'],
  ])('%s is %s', (host, kind) => { expect(classifyAddress(host, { interfaces: {}, tailscale: none })).toBe(kind); });
  it('takes a 100.64/10 address for Tailscale only by its interface name or by tailscale ip', () => {
    const host = '100.100.1.1';
    expect(classifyAddress(host, { interfaces: on('tailscale0', host), tailscale: none })).toBe('tailscale');
    expect(classifyAddress(host, { interfaces: on('eth0', host), tailscale: { installed: true, ips: ['100.100.9.9'] } })).toBe('cgnat');
    expect(classifyAddress(host, { interfaces: on('utun3', host), tailscale: { installed: true, ips: [host] } })).toBe('tailscale');
    // Windows names its adapter Tailscale; tailscale.exe may not be on PATH
    expect(classifyAddress(host, { interfaces: on('Tailscale', host), tailscale: none })).toBe('tailscale');
    expect(classifyAddress(host, { interfaces: on('Ethernet', host), tailscale: { installed: true, ips: [host] } })).toBe('tailscale');
    expect(classifyAddress(host, { interfaces: {}, tailscale: none })).toBe('cgnat');
  });
});
it('writes the Host header a client sends, IPv6 in brackets, and one form of an IPv6 address', () => {
  expect(hostHeader('192.168.1.9', 7767)).toBe('192.168.1.9:7767');
  expect(hostHeader('fd00::1', 7767)).toBe('[fd00::1]:7767');
  expect(canonicalHost('FD00:0:0::1')).toBe('fd00::1');
  expect(canonicalHost(' 10.0.0.1 ')).toBe('10.0.0.1');
});
it('picks the Tailscale IPv4 on an interface, not one only the command lists', () => {
  const interfaces = { ...on('eth0', '100.70.0.1'), ...on('tailscale0', 'fd7a:115c:a1e0::5', '100.101.2.3') };
  expect(pickTailscaleAddress({ interfaces, tailscale: { installed: true, ips: ['100.101.2.3', 'fd7a:115c:a1e0::5'] } })).toBe('100.101.2.3');
  expect(pickTailscaleAddress({ interfaces: on('eth0', '100.70.0.1'), tailscale: { installed: true, ips: ['100.99.0.1'] } })).toBeUndefined();
});
it("reads the LAN's default gateway MAC on Linux, and nothing elsewhere or without one", async () => {
  const files: Record<string, string> = {
    '/proc/net/route': 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
      + 'wlan0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n'
      + 'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n',
    '/proc/net/arp': 'IP address       HW type     Flags       HW address            Mask     Device\n'
      + '192.168.1.1      0x1         0x2         AA:BB:CC:DD:EE:FF     *        wlan0\n',
  };
  const read = async (file: string) => files[file] ?? '';
  expect(await networkIdentity('wlan0', 'linux', read)).toBe('gw:aa:bb:cc:dd:ee:ff');
  expect(await networkIdentity('eth1', 'linux', read)).toBeUndefined();
  expect(await networkIdentity('wlan0', 'darwin', read)).toBeUndefined();
  expect(await networkIdentity('wlan0', 'linux', async () => { throw new Error('no /proc'); })).toBeUndefined();
});
it('refuses what enable must not open, with the design texts, and records a LAN address with its network', async () => {
  const deps = {
    interfaces: () => ({ ...on('eth0', '192.168.1.9', '100.70.1.1') }), tailscale: async () => none,
    networkIdentity: async (iface: string) => iface === 'eth0' ? 'gw:aa:bb:cc:dd:ee:ff' : undefined, now: () => 5,
  };
  const refused = (request: object) => resolveEnable(request, deps).then(() => undefined, (error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
  expect(await refused({ tailscale: true })).toMatchObject({ code: 'tailscale_unavailable', message: expect.stringContaining('tailscale ip -4') });
  expect(await refused({ host: 'example.com' })).toEqual({ code: 'invalid_request', message: '只接受 IP 地址，不接受主机名。' });
  expect(await refused({ host: '127.0.0.1' })).toEqual({ code: 'invalid_request', message: '回环地址不用开启，本机客户端一直能连。' });
  expect(await refused({ host: '100.70.1.1' })).toMatchObject({ code: 'confirm_required', message: expect.stringMatching(/^100\.70\.1\.1 不在 Tailscale 的网卡上.*CGNAT/) });
  expect(await refused({ host: '203.0.113.5' })).toMatchObject({ code: 'confirm_required', message: expect.stringContaining('这是公网地址') });
  // Codex review 232-1 / 234-1: a wildcard is no address another computer can dial, and the Host it sends would never
  // match it; refused, confirmed or not, before anything is written
  for (const [typed, host] of [['0.0.0.0', '0.0.0.0'], ['::', '::'], ['0:0::0', '::']] as const) {
    for (const allowPublic of [false, true]) {
      expect(await refused({ host: typed, allowPublic })).toEqual({ code: 'invalid_request', message: `不能开启 ${host}：它代表这台设备的所有地址，别的设备拿它连不上。改用 \`vonvon remote enable --tailscale\`（推荐）或 \`vonvon remote enable <这台设备的 IP>\`。` });
    }
  }
  // Codex review 234-2: a link-local IPv6, its zone or not, gives a link no client can build a URL from
  for (const [typed, host] of [['fe80::1', 'fe80::1'], ['fe80::1%eth0', 'fe80::1%eth0'], ['FE80::ABCD', 'fe80::abcd'], ['febf::1', 'febf::1']] as const) {
    expect(await refused({ host: typed, allowPublic: true })).toEqual({ code: 'invalid_request', message: `不能开启 ${host}：现在还不支持链路本地的 IPv6 地址（fe80:: 开头）。改用 \`vonvon remote enable --tailscale\`（推荐）或 \`vonvon remote enable <这台设备的局域网 IP>\`。` });
  }
  expect(await refused({})).toMatchObject({ code: 'invalid_request' });
  expect(await resolveEnable({ host: '203.0.113.5', allowPublic: true }, deps)).toEqual({ host: '203.0.113.5', enabledAt: 5, kind: 'public' });
  expect(await resolveEnable({ host: '192.168.1.9' }, deps)).toEqual({ host: '192.168.1.9', enabledAt: 5, kind: 'lan', iface: 'eth0', network: 'gw:aa:bb:cc:dd:ee:ff' });
  // not on this machine yet: opened, to wait for it, with no network to check
  expect(await resolveEnable({ host: '10.255.255.254' }, deps)).toEqual({ host: '10.255.255.254', enabledAt: 5, kind: 'lan' });
});

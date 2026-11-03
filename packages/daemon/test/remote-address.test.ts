import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { canonicalHost, classifyAddress, hostHeader, networkIdentity, overlayOf, resolveEnable, type Interfaces } from '../src/remote/address';

const nic = (address: string, mac = '02:00:00:00:00:01'): NetworkInterfaceInfo => (address.includes(':')
  ? { address, netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac, internal: false, cidr: `${address}/64`, scopeid: 0 }
  : { address, netmask: '255.255.255.0', family: 'IPv4', mac, internal: false, cidr: `${address}/24` });
const on = (name: string, ...addresses: string[]): Interfaces => ({ [name]: addresses.map(address => nic(address)) });
const none = { installed: false, ips: [] };
const PICK = '在终端里运行 `vonvon remote enable` 选一个这台设备的地址，或者 `vonvon remote candidates` 看有哪些。';

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
// A1: main 必败, every virtual network's private address was "lan" and a NetBird 100.x was CGNAT.
describe('a network tool\'s address (overlay)', () => {
  it.each([
    ['ztc3q6qbhk', 'ZeroTier'], ['feth2', 'ZeroTier'], ['ZeroTier One [8056c2e21c000001]', 'ZeroTier'], ['wt0', 'NetBird'], ['et_0', 'EasyTier'],
    ['oray_vnc', '蒲公英'], ['ham0', 'Hamachi'], ['Hamachi', 'Hamachi'], ['wg0', 'WireGuard'],
  ])('knows %s as %s', (iface, tool) => { expect(overlayOf(iface)).toEqual({ tool }); });
  it('takes a plain tunnel for a network tool with no name, and not a LAN card or a bridge', () => {
    for (const iface of ['utun3', 'tun0', 'tap1']) expect(overlayOf(iface), iface).toEqual({});
    for (const iface of ['en0', 'eth0', 'wlan0', 'Wi-Fi', 'docker0', 'tailscale0', 'utun', 'tunnel', undefined]) expect(overlayOf(iface), String(iface)).toBeUndefined();
  });
  it('makes a private address on a tool\'s card overlay, a CGNAT one only on a named tool\'s card, and a public one never', () => {
    const kind = (host: string, iface: string) => classifyAddress(host, { interfaces: on(iface, host), tailscale: none });
    expect(kind('10.147.17.5', 'ztc3q6qbhk')).toBe('overlay');
    expect(kind('172.22.0.9', 'feth2')).toBe('overlay');
    expect(kind('10.126.126.2', 'utun5')).toBe('overlay');
    expect(kind('10.147.17.5', 'eth0')).toBe('lan');
    // NetBird hands out 100.64/10; a plain tunnel with such an address is still asked about
    expect(kind('100.92.4.7', 'wt0')).toBe('overlay');
    expect(kind('100.92.4.7', 'utun4')).toBe('cgnat');
    expect(kind('100.92.4.7', 'eth0')).toBe('cgnat');
    // a VPN may put a reachable public IP on its tunnel
    expect(kind('25.1.2.3', 'ham0')).toBe('public');
    // Tailscale's own card stays Tailscale
    expect(classifyAddress('100.101.2.3', { interfaces: on('utun4', '100.101.2.3'), tailscale: { installed: true, ips: ['100.101.2.3'] } })).toBe('tailscale');
  });
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
  const refused = (request: { host: string; allowPublic?: boolean }) => resolveEnable(request, deps).then(() => undefined, (error: { code: string; message: string }) => ({ code: error.code, message: error.message }));
  expect(await refused({ host: 'example.com' })).toEqual({ code: 'invalid_request', message: '只接受 IP 地址，不接受主机名。' });
  expect(await refused({ host: '127.0.0.1' })).toEqual({ code: 'invalid_request', message: '回环地址不用开启，本机客户端一直能连。' });
  expect(await refused({ host: '100.70.1.1' })).toMatchObject({ code: 'confirm_required', message: expect.stringMatching(/^100\.70\.1\.1 不在 Tailscale 或别的组网工具的网卡上.*CGNAT.*--allow-public/) });
  expect(await refused({ host: '203.0.113.5' })).toMatchObject({ code: 'confirm_required', message: expect.stringContaining('这是公网地址') });
  // Codex review 232-1 / 234-1: a wildcard is no address another computer can dial, and the Host it sends would never
  // match it; refused, confirmed or not, before anything is written
  for (const [typed, host] of [['0.0.0.0', '0.0.0.0'], ['::', '::'], ['0:0::0', '::']] as const) {
    for (const allowPublic of [false, true]) {
      expect(await refused({ host: typed, allowPublic })).toEqual({ code: 'invalid_request', message: `不能开启 ${host}：它代表这台设备的所有地址，别的设备拿它连不上。${PICK}` });
    }
  }
  // Codex review 234-2: a link-local IPv6, its zone or not, gives a link no client can build a URL from
  for (const [typed, host] of [['fe80::1', 'fe80::1'], ['fe80::1%eth0', 'fe80::1%eth0'], ['FE80::ABCD', 'fe80::abcd'], ['febf::1', 'febf::1']] as const) {
    expect(await refused({ host: typed, allowPublic: true })).toEqual({ code: 'invalid_request', message: `不能开启 ${host}：现在还不支持链路本地的 IPv6 地址（fe80:: 开头）。${PICK}` });
  }
  expect(await resolveEnable({ host: '203.0.113.5', allowPublic: true }, deps)).toEqual({ host: '203.0.113.5', enabledAt: 5, kind: 'public' });
  expect(await resolveEnable({ host: '192.168.1.9' }, deps)).toEqual({ host: '192.168.1.9', enabledAt: 5, kind: 'lan', iface: 'eth0', network: 'gw:aa:bb:cc:dd:ee:ff' });
  // not on this machine yet: opened, to wait for it, with no network to check
  expect(await resolveEnable({ host: '10.255.255.254' }, deps)).toEqual({ host: '10.255.255.254', enabledAt: 5, kind: 'lan' });
  // A1: a network tool's address needs no confirmation and records no network (remote-listeners checks its card)
  const overlay = { ...deps, interfaces: () => ({ ...on('wt0', '100.92.4.7'), ...on('ztc3q6qbhk', '10.147.17.5') }) };
  expect(await resolveEnable({ host: '100.92.4.7' }, overlay)).toEqual({ host: '100.92.4.7', enabledAt: 5, kind: 'overlay' });
  expect(await resolveEnable({ host: '10.147.17.5' }, overlay)).toEqual({ host: '10.147.17.5', enabledAt: 5, kind: 'overlay' });
});

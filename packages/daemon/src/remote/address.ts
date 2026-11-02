import { readFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import type { AddressKind } from '@vonvon/protocol';
import { RpcError } from '../server/errors';
import type { RemoteAddress } from './config';

export type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;
export interface TailscaleInfo { installed: boolean; ips: string[] }
export interface AddressContext { interfaces: Interfaces; tailscale: TailscaleInfo }

const subnets = (list: Array<[string, number, 'ipv4' | 'ipv6']>): BlockList => {
  const block = new BlockList();
  for (const [network, prefix, family] of list) block.addSubnet(network, prefix, family);
  return block;
};
const LOOPBACK = subnets([['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']]);
const LAN = subnets([
  ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['169.254.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
]);
const CGNAT = subnets([['100.64.0.0', 10, 'ipv4']]);
const TAILSCALE_V6 = subnets([['fd7a:115c:a1e0::', 48, 'ipv6']]);
const family = (host: string): 'ipv4' | 'ipv6' => isIP(host) === 6 ? 'ipv6' : 'ipv4';
/** A link-local IPv6 may carry its zone (`fe80::1%eth0`): the ranges are about the address. */
const bare = (host: string): string => host.split('%')[0] ?? host;
const inRange = (list: BlockList, host: string): boolean => list.check(bare(host), family(host));
export const inCgnatRange = (host: string): boolean => isIP(host) === 4 && inRange(CGNAT, host);

/** A literal IP as the listeners and the link carry it: IPv6 in its short lower-case form, so `FD00:0::1` and `fd00::1`
 * are one address (the Host header a client sends is compared with it). Anything else comes back as it was. */
export function canonicalHost(host: string): string {
  const trimmed = host.trim();
  if (isIP(trimmed) !== 6 || trimmed.includes('%')) return trimmed;
  try { return new URL(`http://[${trimmed}]/`).hostname.slice(1, -1); } catch { return trimmed; }
}
const sameAddress = (a: string, b: string): boolean => bare(a).toLowerCase() === bare(b).toLowerCase();

/** devices 4.2 and D3 4.3: the Tailscale range always counts; a 100.64/10 address only when `tailscale ip` lists it (macOS's
 * utun*, Windows) or it sits on an interface whose name starts with `tailscale`, any case (Linux's tailscale0, Windows'
 * Tailscale, when there is no command). Any other 100.64/10 address is CGNAT. */
export function isTailscale(host: string, iface: string | undefined, ts: TailscaleInfo): boolean {
  if (isIP(host) === 6) return inRange(TAILSCALE_V6, host);
  if (!inCgnatRange(host)) return false;
  return ts.ips.some(ip => sameAddress(ip, host)) || /^tailscale/i.test(iface ?? '');
}
export function interfaceFor(host: string, interfaces: Interfaces): { name: string; mac: string } | undefined {
  for (const [name, entries] of Object.entries(interfaces)) {
    const found = entries?.find(entry => sameAddress(entry.address, host));
    if (found) return { name, mac: found.mac };
  }
  return undefined;
}
/** Whether this address is on one of the machine's interfaces now; the wildcard addresses always are. */
export function hasAddress(host: string, interfaces: Interfaces): boolean {
  return host === '0.0.0.0' || host === '::' || interfaceFor(host, interfaces) !== undefined;
}

/** devices 4.2, in this order: not a literal IP, loopback, the wildcards (public), Tailscale, LAN, CGNAT, public. */
export function classifyAddress(host: string, ctx: AddressContext): AddressKind | 'invalid' {
  if (isIP(host) === 0) return 'invalid';
  if (inRange(LOOPBACK, host)) return 'loopback';
  if (host === '0.0.0.0' || host === '::') return 'public';
  if (isTailscale(host, interfaceFor(host, ctx.interfaces)?.name, ctx.tailscale)) return 'tailscale';
  if (inRange(LAN, host)) return 'lan';
  if (inCgnatRange(host)) return 'cgnat';
  return 'public';
}
/** The Host header a client sends to this address: IPv6 in brackets. */
export const hostHeader = (host: string, port: number): string => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
/** CGNAT and public addresses face strangers: they get the global handshake limit too (devices 4.3). */
export const exposure = (kind: AddressKind): 'private' | 'exposed' => kind === 'cgnat' || kind === 'public' ? 'exposed' : 'private';
/** `tailscale ip` is asked only for a 100.64/10 address that no interface name already shows to be Tailscale's. */
export async function classify(host: string, deps: { interfaces: () => Interfaces; tailscale: () => Promise<TailscaleInfo> }): Promise<AddressKind | 'invalid'> {
  const interfaces = deps.interfaces();
  const ask = inCgnatRange(host) && !/^tailscale/i.test(interfaceFor(host, interfaces)?.name ?? '');
  return classifyAddress(host, { interfaces, tailscale: ask ? await deps.tailscale() : { installed: false, ips: [] } });
}
/** `remote enable --tailscale`: the first IPv4 on this machine's interfaces that is Tailscale's (devices 4.2: what
 * `tailscale ip` says, checked against the interfaces). */
export function pickTailscaleAddress(ctx: AddressContext): string | undefined {
  for (const [name, entries] of Object.entries(ctx.interfaces)) {
    const found = entries?.find(entry => entry.family === 'IPv4' && isTailscale(entry.address, name, ctx.tailscale));
    if (found) return found.address;
  }
  return undefined;
}

const RTF_GATEWAY = 0x2;
/** `/proc/net/route` writes an IPv4 address as 8 hex digits, least significant byte first. */
const routeIp = (hex: string): string => [6, 4, 2, 0].map(at => parseInt(hex.slice(at, at + 2), 16)).join('.');
/** devices 4.2: the network a LAN address was opened on, as its default gateway's MAC (`gw:<mac>`). Linux only, from
 * `/proc/net/route` and `/proc/net/arp`; undefined elsewhere, or with no default route on that interface or no ARP entry
 * for its gateway ("拿不到就只记网卡名"). */
export async function networkIdentity(ifaceName: string, platform: NodeJS.Platform = process.platform, read = (file: string) => readFile(file, 'utf8')): Promise<string | undefined> {
  if (platform !== 'linux') return undefined;
  try {
    const routes = (await read('/proc/net/route')).split('\n').slice(1).map(line => line.trim().split(/\s+/));
    const route = routes.find(([iface, destination, gateway, flags]) => iface === ifaceName && destination === '00000000' && gateway !== undefined
      && /^[0-9A-Fa-f]{8}$/.test(gateway) && (parseInt(flags ?? '0', 16) & RTF_GATEWAY) !== 0);
    if (!route?.[2]) return undefined;
    const gateway = routeIp(route[2]);
    const arp = (await read('/proc/net/arp')).split('\n').slice(1).map(line => line.trim().split(/\s+/));
    const entry = arp.find(([ip, , flags, mac, , device]) => ip === gateway && device === ifaceName && flags !== '0x0' && mac !== undefined && mac !== '00:00:00:00:00:00');
    return entry?.[3] ? `gw:${entry[3].toLowerCase()}` : undefined;
  } catch { return undefined; }
}

// devices 第 15 节
export const TAILSCALE_HINT = '推荐用 Tailscale 这类安全网络把两台设备连起来：两边都装上并登录同一个账号，然后用 `tailscale ip -4` 看到的 100.x 地址运行 `vonvon remote enable`。不用 Tailscale 也可以：局域网内用这台设备的局域网地址。';
export const cgnatWarning = (host: string): string => `${host} 不在 Tailscale 的网卡上，可能是运营商分配的地址（CGNAT），开启后同一运营商的其他用户也可能连到这台设备。确定要开启请加 \`--allow-public\`。`;
export const PUBLIC_WARNING = '这是公网地址。开启后互联网上任何人都能尝试连接这台设备；虽然只有配对过的客户端能连上、内容加密，但你的服务端会直接暴露在扫描和攻击之下。建议改用 Tailscale 或局域网地址。确定要开启请加 `--allow-public`（桌面端：勾选"我了解风险"）。';
export const NOT_AN_IP = '只接受 IP 地址，不接受主机名。';
export const LOOPBACK_REFUSED = '回环地址不用开启，本机客户端一直能连。';
export const ONE_TARGET = '给一个 IP 地址，或者用 --tailscale，二选一。';

export interface EnableDeps {
  interfaces: () => Interfaces;
  tailscale: () => Promise<TailscaleInfo>;
  /** Overrides the classification (the tests and the probe treat a loopback alias as a LAN address). */
  classify?: (host: string) => Promise<AddressKind | 'invalid'>;
  networkIdentity: (iface: string) => Promise<string | undefined>;
  now?: () => number;
}
/** `device.enable` and `vonvon remote enable` with no daemon (D3 4.7): the address to write, or the refusal. A LAN address
 * records its interface and network; the others are not checked against a network. */
export async function resolveEnable(request: { host?: string; tailscale?: boolean; allowPublic?: boolean }, deps: EnableDeps): Promise<RemoteAddress> {
  const now = deps.now ?? Date.now;
  if ((request.host === undefined) === (request.tailscale !== true)) throw new RpcError('invalid_request', ONE_TARGET);
  if (request.tailscale) {
    const host = pickTailscaleAddress({ interfaces: deps.interfaces(), tailscale: await deps.tailscale() });
    if (!host) throw new RpcError('tailscale_unavailable', TAILSCALE_HINT);
    return { host, enabledAt: now(), kind: 'tailscale' };
  }
  const host = canonicalHost(request.host ?? '');
  const kind = await (deps.classify ?? (value => classify(value, deps)))(host);
  if (kind === 'invalid') throw new RpcError('invalid_request', NOT_AN_IP);
  if (kind === 'loopback') throw new RpcError('invalid_request', LOOPBACK_REFUSED);
  if (kind === 'cgnat' && !request.allowPublic) throw new RpcError('confirm_required', cgnatWarning(host));
  if (kind === 'public' && !request.allowPublic) throw new RpcError('confirm_required', PUBLIC_WARNING);
  if (kind !== 'lan') return { host, enabledAt: now(), kind };
  const iface = interfaceFor(host, deps.interfaces())?.name;
  const network = iface === undefined ? undefined : await deps.networkIdentity(iface);
  return { host, enabledAt: now(), kind, ...(iface === undefined ? {} : { iface }), ...(network === undefined ? {} : { network }) };
}

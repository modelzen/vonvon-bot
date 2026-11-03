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
const LINK_LOCAL_V6 = subnets([['fe80::', 10, 'ipv6']]);
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

/**
 * A1: the virtual interface another network tool than Tailscale makes, by its name; `tool` when the name says which
 * one. ZeroTier: `zt…` (Linux), `feth…` (macOS), `ZeroTier One […]` (Windows); NetBird `wt0`; EasyTier `et_0`
 * (Windows; elsewhere a plain tun); 蒲公英 `oray…`/`pgy…` (not checked on a machine); Hamachi `ham0`/`Hamachi`;
 * WireGuard `wg…`. A plain `tun0`, `utun3` or `tap0` is a VPN or a network tool too, with no name to give.
 */
const OVERLAY_TOOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(zt|feth\d)|^zerotier/i, 'ZeroTier'], [/^wt\d+$/i, 'NetBird'], [/^et_\d+$/i, 'EasyTier'], [/^(oray|pgy)/i, '蒲公英'],
  [/^ham\d+$|^hamachi/i, 'Hamachi'], [/^wg/i, 'WireGuard'],
];
const PLAIN_TUNNEL = /^(u?tun|tap)\d+$/i;
export function overlayOf(iface: string | undefined): { tool?: string } | undefined {
  if (!iface) return undefined;
  const named = OVERLAY_TOOLS.find(([pattern]) => pattern.test(iface));
  if (named) return { tool: named[1] };
  return PLAIN_TUNNEL.test(iface) ? {} : undefined;
}

/** devices 4.2, in this order: not a literal IP, loopback, the wildcards (public), Tailscale, LAN, CGNAT, public. A1: a
 * LAN address on a network tool's interface is `overlay`; a CGNAT one too, only when the interface names the tool (a
 * plain tunnel with a 100.64/10 address stays CGNAT, confirmed). A public address stays public on any interface: a VPN
 * may put a public IP on its tunnel, which strangers reach. */
export function classifyAddress(host: string, ctx: AddressContext): AddressKind | 'invalid' {
  if (isIP(host) === 0) return 'invalid';
  if (inRange(LOOPBACK, host)) return 'loopback';
  if (host === '0.0.0.0' || host === '::') return 'public';
  const iface = interfaceFor(host, ctx.interfaces)?.name;
  if (isTailscale(host, iface, ctx.tailscale)) return 'tailscale';
  const overlay = overlayOf(iface);
  if (inRange(LAN, host)) return overlay ? 'overlay' : 'lan';
  if (inCgnatRange(host)) return overlay?.tool ? 'overlay' : 'cgnat';
  return 'public';
}
/** The Host header a client sends to this address: IPv6 in brackets. */
export const hostHeader = (host: string, port: number): string => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
/** CGNAT and public addresses face strangers: they get the global handshake limit too (devices 4.3). */
export const exposure = (kind: AddressKind): 'private' | 'exposed' => kind === 'cgnat' || kind === 'public' ? 'exposed' : 'private';
/** These two face strangers, and are opened only with `--allow-public` or the desktop's risk confirmation. */
export const needsConfirmation = (kind: AddressKind): boolean => exposure(kind) === 'exposed';
/** `tailscale ip` is asked only for a 100.64/10 address that no interface name already shows to be Tailscale's. */
export async function classify(host: string, deps: { interfaces: () => Interfaces; tailscale: () => Promise<TailscaleInfo> }): Promise<AddressKind | 'invalid'> {
  const interfaces = deps.interfaces();
  const ask = inCgnatRange(host) && !/^tailscale/i.test(interfaceFor(host, interfaces)?.name ?? '');
  return classifyAddress(host, { interfaces, tailscale: ask ? await deps.tailscale() : { installed: false, ips: [] } });
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

// devices 第 15 节; A1: no --tailscale, one address picked from the ones `vonvon remote enable` lists
export const TAILSCALE_HINT = '推荐用 Tailscale 这类组网工具把两台设备连起来：两边都装上、登录同一个账号，再运行 `vonvon remote enable` 选它的地址。不用组网工具也可以：两台在同一个局域网里时，选局域网地址。';
export const ALLOW_PUBLIC = '确定要开启请加 `--allow-public`。';
export const cgnatRisk = (host: string): string => `${host} 不在 Tailscale 或别的组网工具的网卡上，可能是运营商分配的地址（CGNAT），开启后同一运营商的其他用户也可能连到这台设备。`;
export const cgnatWarning = (host: string): string => `${cgnatRisk(host)}${ALLOW_PUBLIC}`;
export const PUBLIC_RISK = '这是公网地址。开启后互联网上任何人都能尝试连接这台设备；虽然只有配对过的客户端能连上、内容加密，但你的服务端会直接暴露在扫描和攻击之下。建议改用 Tailscale 或局域网地址。';
export const PUBLIC_WARNING = `${PUBLIC_RISK}确定要开启请加 \`--allow-public\`（桌面端：勾选"我了解风险"）。`;
export const NOT_AN_IP = '只接受 IP 地址，不接受主机名。';
export const LOOPBACK_REFUSED = '回环地址不用开启，本机客户端一直能连。';
const PICK_ONE = '在终端里运行 `vonvon remote enable` 选一个这台设备的地址，或者 `vonvon remote candidates` 看有哪些。';
// D3 plan 11.16 (Codex review 232-1, 234-1, 234-2): no wildcard and no link-local IPv6 address in this batch
export const wildcardRefused = (host: string): string => `不能开启 ${host}：它代表这台设备的所有地址，别的设备拿它连不上。${PICK_ONE}`;
export const linkLocalRefused = (host: string): string => `不能开启 ${host}：现在还不支持链路本地的 IPv6 地址（fe80:: 开头）。${PICK_ONE}`;

export interface EnableDeps {
  interfaces: () => Interfaces;
  tailscale: () => Promise<TailscaleInfo>;
  /** Overrides the classification (the tests and the probe treat a loopback alias as a LAN address). */
  classify?: (host: string) => Promise<AddressKind | 'invalid'>;
  networkIdentity: (iface: string) => Promise<string | undefined>;
  now?: () => number;
}
/** `device.enable` and `vonvon remote enable` with no daemon (D3 4.7): the address to write, or the refusal. A LAN address
 * records its interface and network; the others are not checked against a network (an overlay one only stays on a
 * network tool's interface, remote-listeners). */
export async function resolveEnable(request: { host: string; allowPublic?: boolean }, deps: EnableDeps): Promise<RemoteAddress> {
  const now = deps.now ?? Date.now;
  const host = canonicalHost(request.host);
  // Neither is an address another computer can dial: a wildcard is every address (the link would carry it, and the Host a
  // client sends never matches it); a link-local one needs the client's own zone, which no link or URL here can carry.
  if (host === '0.0.0.0' || host === '::') throw new RpcError('invalid_request', wildcardRefused(host));
  if (isIP(host) === 6 && inRange(LINK_LOCAL_V6, host)) throw new RpcError('invalid_request', linkLocalRefused(host));
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

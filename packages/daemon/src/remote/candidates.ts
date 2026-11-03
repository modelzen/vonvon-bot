import { BlockList, isIP } from 'node:net';
import type { AddressKind } from '@vonvon/protocol';
import { classifyAddress, inCgnatRange, needsConfirmation, overlayOf, type AddressContext, type Interfaces, type TailscaleInfo } from './address';

/**
 * A1: the addresses another device could reach this one on, for `vonvon remote candidates`, the list `vonvon remote
 * enable` asks from in a terminal, and the desktop's 允许别的设备连接 (devices-ui-3: `createCandidates` keeps them a
 * while). Only this machine's interfaces are read; nothing listens.
 */
export type CandidateKind = Exclude<AddressKind, 'loopback'>;
/** Left out unless asked for (`--all`): a virtual bridge for containers or VMs, a proxy's fake IP, a self-assigned address. */
export type HiddenReason = 'bridge' | 'proxy' | 'self-assigned';
export interface Candidate {
  host: string; kind: CandidateKind; iface: string;
  /** The network tool, when the interface names it: Tailscale, ZeroTier, … */
  tool?: string;
  hidden?: HiddenReason;
}

/** Orca's list (`pairing-address-auto-selection.ts`) and the ones of the same kind: Docker, libvirt, VMware, VirtualBox,
 * container veths, LXC/LXD/Incus, Podman, CNI; macOS's Internet sharing and VM NAT bridges (bridge100 and up; bridge0
 * is the Thunderbolt one); Windows' Hyper-V Default Switch, WSL and Docker. An external Hyper-V switch
 * (`vEthernet (<name>)`) carries the real LAN, so only those three are left out (and `veth` must not catch it). */
const BRIDGE = /^(docker|br-|virbr|vmnet|vboxnet|veth(?!ernet)|lxcbr|lxdbr|incusbr|podman|cni|flannel|bridge1\d\d$)|^vEthernet \((Default Switch|WSL|DockerNAT)|^VMware Network Adapter|^VirtualBox Host-Only/i;
const block = (network: string, prefix: number): BlockList => { const list = new BlockList(); list.addSubnet(network, prefix, 'ipv4'); return list; };
/** Clash, mihomo and sing-box hand out fake IPs from 198.18.0.0/15 on their TUN interface. */
const FAKE_IP = block('198.18.0.0', 15);
const SELF_ASSIGNED = block('169.254.0.0', 16);

const RANK: Record<CandidateKind, number> = { tailscale: 0, overlay: 1, lan: 2, cgnat: 3, public: 4 };
function hiddenReason(host: string, iface: string): HiddenReason | undefined {
  if (isIP(host) === 4 && FAKE_IP.check(host, 'ipv4')) return 'proxy';
  if (isIP(host) === 4 && SELF_ASSIGNED.check(host, 'ipv4')) return 'self-assigned';
  return BRIDGE.test(iface) ? 'bridge' : undefined;
}

/**
 * Every non-internal IPv4 address, and an IPv6 one only in Tailscale's range (a LAN's IPv6 addresses come and go),
 * classified as `remote enable` does. Tailscale first, then the other network tools, the LAN, CGNAT and public; IPv4
 * before IPv6, then by interface name. The hidden ones come last, and only with `all`.
 */
export function listCandidates(ctx: AddressContext, options: { all?: boolean } = {}): Candidate[] {
  const seen = new Set<string>();
  const found: Candidate[] = [];
  for (const [iface, entries] of Object.entries(ctx.interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || seen.has(entry.address)) continue;
      const kind = classifyAddress(entry.address, ctx);
      if (kind === 'invalid' || kind === 'loopback') continue;
      if (isIP(entry.address) === 6 && kind !== 'tailscale') continue;
      seen.add(entry.address);
      const hidden = hiddenReason(entry.address, iface);
      if (hidden && !options.all) continue;
      const tool = kind === 'tailscale' ? 'Tailscale' : kind === 'overlay' ? overlayOf(iface)?.tool : undefined;
      found.push({ host: entry.address, kind, iface, ...(tool ? { tool } : {}), ...(hidden ? { hidden } : {}) });
    }
  }
  const order = (candidate: Candidate): number[] => [candidate.hidden ? 1 : 0, RANK[candidate.kind], isIP(candidate.host) === 6 ? 1 : 0];
  return found.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    const at = x.findIndex((value, index) => value !== y[index]);
    if (at >= 0) return (x[at] ?? 0) - (y[at] ?? 0);
    return a.iface.localeCompare(b.iface) || a.host.localeCompare(b.host);
  });
}

/** `tailscale ip` is run only when an address could be Tailscale's and no interface name says so (macOS's utun, a
 * renamed adapter); a Linux server with tailscale0, or none in 100.64/10, runs nothing. */
export async function candidateContext(deps: { interfaces: () => Interfaces; tailscale: () => Promise<TailscaleInfo> }): Promise<AddressContext> {
  const interfaces = deps.interfaces();
  const ask = Object.entries(interfaces).some(([iface, entries]) => !/^tailscale/i.test(iface) && (entries ?? []).some(entry => !entry.internal && inCgnatRange(entry.address)));
  return { interfaces, tailscale: ask ? await deps.tailscale() : { installed: false, ips: [] } };
}

/** The one a terminal offers first: Tailscale's IPv4, else the first one that needs no confirmation. */
export function defaultCandidate(candidates: readonly Candidate[]): Candidate | undefined {
  const shown = candidates.filter(candidate => !candidate.hidden);
  return shown.find(candidate => candidate.kind === 'tailscale') ?? shown.find(candidate => !needsConfirmation(candidate.kind));
}

const KIND_LABEL: Record<CandidateKind, string> = { tailscale: 'Tailscale', overlay: '组网', lan: '局域网', cgnat: '运营商地址', public: '公网' };
const HIDDEN_LABEL: Record<HiddenReason, string> = { bridge: '虚拟网桥', proxy: '代理软件的虚拟地址', 'self-assigned': '自动分配的地址' };
/** As a person reads it: "Tailscale（推荐）· 100.x", "组网 · ZeroTier · 10.x", "局域网 · 192.168.x", "公网 · x（要确认）". */
export function candidateLabel(candidate: Candidate, recommended = false): string {
  if (candidate.hidden) return `${HIDDEN_LABEL[candidate.hidden]} · ${candidate.host}（一般用不上）`;
  if (candidate.kind === 'tailscale') return `Tailscale${recommended ? '（推荐）' : ' '}· ${candidate.host}`;
  const tool = candidate.kind === 'overlay' && candidate.tool ? ` · ${candidate.tool}` : '';
  return `${KIND_LABEL[candidate.kind]}${tool} · ${candidate.host}${needsConfirmation(candidate.kind) ? '（要确认）' : ''}`;
}

/** devices-ui-3 4.2: the list `device.status` carries, kept 30 seconds (the panel reads every 10, and `tailscale ip` may
 * take up to 5). Kept on the object `createCandidates` makes, not in this module, so two daemons in one test process do
 * not share it; `clear` after an address is opened or closed, and for the panel's 刷新. The hidden ones are left out. */
export interface Candidates { list(): Promise<Candidate[]>; clear(): void }
export const CANDIDATES_TTL_MS = 30_000;
export function createCandidates(deps: { interfaces: () => Interfaces; tailscale: () => Promise<TailscaleInfo>; now?: () => number }): Candidates {
  const now = deps.now ?? Date.now;
  let kept: { at: number; list: Promise<Candidate[]> } | undefined;
  return {
    list() {
      if (kept && now() - kept.at < CANDIDATES_TTL_MS) return kept.list;
      const list = candidateContext(deps).then(ctx => listCandidates(ctx));
      const entry = { at: now(), list };
      kept = entry;
      // One that failed is not kept: the next read tries again.
      list.catch(() => { if (kept === entry) kept = undefined; });
      return list;
    },
    clear() { kept = undefined; },
  };
}

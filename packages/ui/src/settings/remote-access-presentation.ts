import type {AddressCandidate, ClientRecord, DeviceEventPayload, DeviceReply, DeviceRequest, DeviceStatus} from '@vonvon/protocol';
import type {ActiveDevice} from '../client-context';
import {onDeviceText, whereName} from '../device-copy';

/**
 * devices-ui-3 4.3: every word of 允许别的设备连接 and of the paired toast, and what each click asks of the device. The
 * address words are `vonvon remote candidates`' (A1, `D/remote/candidates.ts` `candidateLabel`); a page of this computer
 * says 本机, a remote one 「X」 (devices-ui-2). The caller's own row and the toast say 这台电脑: they are about the computer in
 * front of the user whichever device is shown, and a remote page never says 本机 (product 3.14).
 */
type Where = Pick<ActiveDevice, 'isRemote' | 'name' | 'platform'>;
type Kind = AddressCandidate['kind'];
type Opened = DeviceStatus['remote']['addresses'][number];
export type ClientsReply = Extract<DeviceReply, {kind: 'clients'}>;

export const SECTION = '允许别的设备连接';
export const PAIRED_TOAST_TITLE = '有新设备配对到这台电脑';
export const PAIRED_SECTION = '已配对的设备';
/** The link's own group, with its own search anchor (Codex 审查 269-2). */
export const LINK_SECTION = '连接链接';
export const panelTitle = (where: Where): string => `${SECTION}${where.isRemote ? whereName(where) : '本机'}`;
export const KIND_LABEL: Record<Kind, string> = {tailscale: 'Tailscale', overlay: '组网', lan: '局域网', cgnat: '运营商地址', public: '公网'};
export const STATE_LABEL: Record<Opened['state'], string> = {listening: '监听中', waiting: '等地址出现', 'needs-confirmation': '网络变了，要确认', disabled: '已关闭', failed: '开不了'};
export const needsRiskConfirm = (kind: string): boolean => kind === 'cgnat' || kind === 'public';

export interface AddressRow {
  host: string; kind: Kind; iface?: string; tool?: string;
  /** The one address that is open (A1: one at a time), and what its listener does. */
  enabled: boolean; state?: Opened['state']; detail?: string;
  /** The caller came in on it: closing or replacing it cuts this computer off. */
  current: boolean;
  /** What a terminal offers first: Tailscale's IPv4, else the first that needs no confirmation. */
  recommended: boolean;
  /** Open, but no interface has it now. */
  missing: boolean;
}
const isIpv6 = (host: string): boolean => host.includes(':');
/** The candidates in their order (Tailscale first); the open one is marked, and listed first when no interface has it now. */
export function addressRows(status: DeviceStatus): AddressRow[] {
  const candidates = status.remote.candidates ?? [];
  const recommended = candidates.find(entry => entry.kind === 'tailscale' && !isIpv6(entry.host)) ?? candidates.find(entry => !needsRiskConfirm(entry.kind));
  const opened = status.remote.addresses[0];
  const row = (entry: {host: string; kind: Kind; iface?: string; tool?: string}, missing: boolean): AddressRow => {
    const open = opened?.host === entry.host ? opened : undefined;
    return {
      host: entry.host, kind: entry.kind, ...(entry.iface ? {iface: entry.iface} : {}), ...(entry.tool ? {tool: entry.tool} : {}),
      enabled: Boolean(open), ...(open ? {state: open.state} : {}), ...(open?.detail ? {detail: open.detail} : {}),
      current: status.via !== undefined && status.via === entry.host, recommended: entry === recommended, missing,
    };
  };
  const rows = candidates.map(entry => row(entry, false));
  if (opened && opened.kind !== 'loopback' && !candidates.some(entry => entry.host === opened.host)) rows.unshift(row({host: opened.host, kind: opened.kind}, true));
  return rows;
}
/** "Tailscale（推荐）", "组网 · ZeroTier", "局域网", "公网（要确认）". */
export function kindLabel(row: Pick<AddressRow, 'kind' | 'tool' | 'recommended'>): string {
  const tool = row.kind === 'overlay' && row.tool ? ` · ${row.tool}` : '';
  return `${KIND_LABEL[row.kind]}${tool}${row.recommended ? '（推荐）' : ''}${needsRiskConfirm(row.kind) ? '（要确认）' : ''}`;
}
export function stateText(row: AddressRow): string | undefined {
  if (!row.state) return undefined;
  if (row.state === 'waiting') {
    if (row.missing) return `等地址出现：这台设备现在没有 ${row.host}`;
    // A taken port waits too (D3 4.5): its detail says so and how to change the port, where the label alone hid it.
    return row.detail ?? STATE_LABEL.waiting;
  }
  return row.detail && row.state !== 'listening' ? `${STATE_LABEL[row.state]}：${row.detail}` : STATE_LABEL[row.state];
}
/** The one picked when the panel opens or the list changes: the open one, else the recommended, else the first. */
export function defaultPick(rows: readonly AddressRow[]): string | undefined {
  return (rows.find(row => row.enabled) ?? rows.find(row => row.recommended) ?? rows[0])?.host;
}

const ACCEPT = '勾选「我了解风险」后再开启。';
// devices 第 15 节"100.x 但不是 Tailscale"、"公网地址警告" (the daemon's `cgnatRisk` and `PUBLIC_RISK`), the desktop's half
const PUBLIC_RISK = '这是公网地址。开启后互联网上任何人都能尝试连接这台设备；虽然只有配对过的客户端能连上、内容加密，但你的服务端会直接暴露在扫描和攻击之下。建议改用 Tailscale 或局域网地址。';
export function riskText(row: Pick<AddressRow, 'host' | 'kind'>): string {
  if (row.kind === 'cgnat') return `${row.host} 不在 Tailscale 或别的组网工具的网卡上，可能是运营商分配的地址（CGNAT），开启后同一运营商的其他用户也可能连到这台设备。${ACCEPT}`;
  return `${PUBLIC_RISK}${ACCEPT}`;
}
/** A `confirm_required` from the device (its interfaces changed between two reads): its words, without the command's flag. */
export const riskFromReply = (message: string): string => `${message.replace(/确定要开启请加.*$/s, '').trim()}${ACCEPT}`;
export function enableErrorText(code: string, message: string): string {
  return code === 'confirm_required' || code === 'invalid_request' ? message : `开不了：${message}`;
}

/** devices 第 15 节"关掉当前连着的地址". */
export const disableCurrentText = (where: Where): string =>
  `你现在就是通过这个地址连着${whereName(where)}的。关掉后这台电脑会马上断开，要到那台设备上重新开启。`;
/** A1 4.5: another address replaces the open one; the paired devices follow by pasting a new link. */
export function switchText(where: Where, from: AddressRow, to: string, paired: number): string {
  if (from.current) return `你现在就是通过 ${from.host} 连着${whereName(where)}的。换成 ${to} 后这台电脑会马上断开，要在${whereName(where)}上生成新链接、粘到"添加设备"里更新地址。`;
  const follow = paired ? `已配对的 ${paired} 台设备要换到新地址：在下面生成连接链接，粘到那台电脑的 Vonvon Bot → 设置 → 设备 → 添加，只会更新地址，不用重新配对。` : '';
  return `换成 ${to} 后，${from.host} 不再接受连接，经它连着的设备会马上断开。${follow}`;
}
/** 0.9.0 Windows 验收 322: the first 开启 makes Windows ask about its firewall. 取消 leaves block rules that only deleting
 * undoes (they win over allow rules), while this still says 监听中. Said on that computer only, where the question shows. */
export const WINDOWS_FIREWALL = '开启后 Windows 可能会问是否允许 Vonvon Bot 访问网络，点「允许」。点过「取消」的话别的设备连不上：到 Windows 安全中心 → 防火墙和网络保护 → 高级设置 → 入站规则，删掉名为 Vonvon Bot 的「阻止」规则（要管理员权限），再在这里关掉、重新开启，Windows 会再问一次。';
/** Windows has no `vonvon` command (the desktop registers it on macOS only): its port stays as it is. */
export const portHint = (where: Where): string => where.platform === 'windows'
  ? `${where.isRemote ? '' : WINDOWS_FIREWALL}${onDeviceText(where, 'Windows 上这一版改不了端口；端口被别的程序占着时，关掉那个程序后会自己开始。')}`
  : onDeviceText(where, '要改端口，在终端运行 `vonvon remote port <端口>`；改完已配对的设备要粘一次新链接。');
export const NO_ADDRESS = '这台设备现在没有别的设备能连过来的地址。';
export const LINK_HELP = '把这条链接粘到另一台电脑的 Vonvon Bot → 设置 → 设备 → 添加。10 分钟内有效，只能用一次，别发给别人。';
export const LINK_EXPIRED = '链接过期了，再生成一个。';
/** Codex 审查 267-2、269-1: the address or port the link was made on changed, or it stopped listening. */
export const LINK_MOVED = '地址变了，刚才那条链接用不了了，再生成一个。';
/** A link carries the address and port it was made on: it connects while that address is the open one, listening, on
 * that port. Read again from the device (an operation's reply, 刷新, the 10-second read), whoever changed it. */
export function linkUsable(made: {host: string; port: number}, rows: readonly AddressRow[], port: number | undefined): boolean {
  const open = rows.find(row => row.enabled);
  return open?.host === made.host && open.state === 'listening' && port === made.port;
}
/** Why 生成连接链接 (and 再生成一个) is grey, or nothing. */
export function linkBlocked(rows: readonly AddressRow[]): string | undefined {
  const open = rows.find(row => row.enabled);
  if (!open) return '先在上面选一个地址并开启。';
  return open.state === 'listening' ? undefined : '地址还没在监听，等它变成「监听中」再生成。';
}
export function linkCountdown(expiresAt: number, now: number): string {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (left <= 0) return '已过期';
  return `还剩 ${Math.floor(left / 60)} 分 ${left % 60} 秒`;
}

/** What one click asks: a confirmation first, or the request now. */
export type Confirm =
  | {kind: 'risk'; host: string; text: string; also?: string}
  | {kind: 'switch'; host: string; text: string}
  | {kind: 'disable'; host: string; text: string}
  | {kind: 'revoke'; clientId: string; name: string; downstream: number};
export type Step = {confirm: Confirm} | {request: DeviceRequest};
/** 开启 or 换成这个地址 on `picked`: a CGNAT or public address asks about the risk; replacing an address another device
 * may be on, or the one this computer came in on, says what follows. */
export function enableStep(rows: readonly AddressRow[], picked: string, where: Where, paired: number): Step {
  const row = rows.find(each => each.host === picked);
  const open = rows.find(each => each.enabled);
  const also = open && open.host !== picked && (open.current || paired > 0) ? switchText(where, open, picked, paired) : undefined;
  if (row && needsRiskConfirm(row.kind)) return {confirm: {kind: 'risk', host: picked, text: riskText(row), ...(also ? {also} : {})}};
  if (also) return {confirm: {kind: 'switch', host: picked, text: also}};
  return {request: {type: 'enable', host: picked}};
}
/** 关闭远程连接: the address this computer came in on asks first. */
export function disableStep(row: AddressRow, where: Where): Step {
  return row.current ? {confirm: {kind: 'disable', host: row.host, text: disableCurrentText(where)}} : {request: {type: 'disable', host: row.host}};
}
/** The request a confirmation sends; a risk one only once 我了解风险 is ticked. */
export function confirmedRequest(confirm: Confirm, ticked: boolean): DeviceRequest | undefined {
  switch (confirm.kind) {
    case 'risk': return ticked ? {type: 'enable', host: confirm.host, allowPublic: true} : undefined;
    case 'switch': return {type: 'enable', host: confirm.host};
    case 'disable': return {type: 'disable', host: confirm.host};
    case 'revoke': return {type: 'revokeClient', clientId: confirm.clientId, cascade: ticked};
  }
}

export const CLIENT_KIND_LABEL: Record<string, string> = {desktop: '桌面端', cli: '命令行', web: '网页端'};
/** Not revoked, the latest seen first. */
export function liveClients(reply: ClientsReply): ClientRecord[] {
  return reply.clients.filter(client => client.revokedAt === undefined).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
export const isRecent = (client: Pick<ClientRecord, 'createdAt'>, now: number): boolean => now - client.createdAt < 24 * 3_600_000;
/** `ip:port` or `[ip]:port` as the daemon records it: the address only. */
export const hostOf = (address: string): string => address.match(/^\[(.+)\]:\d+$/)?.[1] ?? address.match(/^([^:]+):\d+$/)?.[1] ?? address;
export function invitedByText(client: Pick<ClientRecord, 'invitedBy'>, all: readonly ClientRecord[], where: Where): string {
  if (client.invitedBy === 'local') return where.isRemote ? `在${whereName(where)}上生成的链接` : '在本机生成的链接';
  const by = all.find(each => each.id === client.invitedBy);
  return by ? `由「${by.name}」带进来` : '由一台已删除的设备带进来';
}
/** What `revokeClient` with `cascade` revokes besides this one: down the `invitedBy` line, as the daemon walks it (through
 * revoked ones too), counting the ones not revoked yet. */
export function cascadeCount(all: readonly ClientRecord[], clientId: string): number {
  const seen = new Set([clientId]);
  let count = 0;
  for (let queue = [clientId], id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const child of all.filter(each => each.invitedBy === id && !seen.has(each.id))) {
      seen.add(child.id);
      if (child.revokedAt === undefined) count++;
      queue.push(child.id);
    }
  }
  return count;
}
/** devices 第 15 节"撤销确认". */
export const revokeConfirmText = (name: string): string => `取消「${name}」的访问？它会立刻断开，要再连得重新配对。`;
export const SELF_TAG = '这台电脑';
/** Only on a remote device's block, which is on 设备 under this computer's list since owner 2026-11-03: it is right above. */
export const selfText = (where: Where): string => `这是你现在用的这台电脑。要断开，在上面的设备列表里删掉${whereName(where)}。`;
/** devices 第 15 节"新客户端配对成功"; the toast is always about this computer, whichever device is shown. */
export function pairedToastText(event: Pick<DeviceEventPayload, 'name' | 'clientKind' | 'address'>): string {
  const kind = CLIENT_KIND_LABEL[event.clientKind] ?? '客户端';
  const from = event.address ? `，来自 ${hostOf(event.address)}` : '';
  return `新设备「${event.name}」（${kind}${from}）已经配对，可以管理这台电脑的 Vonvon Bot。不是你操作的？到「${SECTION}」撤销。`;
}
/** A read that failed: an old server says so, anything else as it came. */
export function readErrorText(code: string | undefined, message: string, where: Where): string {
  return code === 'unsupported' ? `${where.isRemote ? `${whereName(where)}上的` : '本机的'} Vonvon Bot 太旧，不支持这里的设置。` : message;
}

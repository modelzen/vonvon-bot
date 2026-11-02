import {
  MAINTENANCE_KINDS, type ActiveDeviceState, type DeviceRoute, type DeviceRow, type DeviceRowStatus, type DevicesState,
  type LinkPreviewCode, type MachineRequestHandler, type RouteFailure,
} from '@vonvon/protocol';
import type {ActiveDevice} from '../client-context';

/** devices-ui-1b 4.9: every word the devices pages show. `name` is always `deviceCopyName`'s: 「名字」 or 这台电脑. */
export const copy = {
  panelIntro: '一次看一台。切换后，整个界面都换成那台设备上的 Vonvon Bot。',
  pasteHelp: '在要连接的设备上运行 `vonvon pair`，或者在那台电脑的 Vonvon Bot → 设置 → 应用与启动 →「允许别的设备连接」里点「生成连接链接」。链接 10 分钟内有效，只能用一次。',
  invalidName: '名字要 1 到 40 个字。',
  maintenanceOnly: '版本不一致时只能做升级',
  recovered: '设备列表文件损坏了，已另存一份并重新开始。之前加过的设备要重新添加。',
  tailscaleAdvice: '推荐用 Tailscale 把两台设备连起来：两台都装上 Tailscale、登录同一个账号，就能用 100.x 开头的地址直接连，不用开端口，也不经过公网。没有 Tailscale 也可以：两台在同一个局域网里时，用局域网地址。',
  tailscaleDownload: '下载 Tailscale',
} as const;
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';

/** 4.1: the window chrome follows this computer's row, whichever device is shown. */
export const desktopPlatformMark = (state?: DevicesState): string | undefined => state?.devices[0]?.platform;
export const shouldMarkPlatform = (device: Pick<ActiveDevice, 'isRemote'>): boolean => !device.isRemote;

export function relativeTime(at: number, now: number): string {
  const diff = now - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(at);
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}年${day}`;
}

const STATUS_LABELS: Record<Exclude<DeviceRowStatus, 'unknown'>, string> = {
  online: '在线', connecting: '正在连接', reconnecting: '重连中', offline: '连不上', maintenance: '版本不一致', revoked: '已撤销', 'needs-pairing': '需要重新配对',
};
export function statusLabel(row: Pick<DeviceRow, 'status' | 'lastConnectedAt'>, now: number): string {
  if (row.status !== 'unknown') return STATUS_LABELS[row.status];
  return row.lastConnectedAt === undefined ? '还没连过' : `上次在线 ${relativeTime(row.lastConnectedAt, now)}`;
}
export type StatusTone = 'green' | 'yellow' | 'orange' | 'red' | 'gray';
export function statusTone(status: DeviceRowStatus): StatusTone {
  if (status === 'online') return 'green';
  if (status === 'connecting' || status === 'reconnecting') return 'yellow';
  if (status === 'maintenance') return 'orange';
  return status === 'unknown' ? 'gray' : 'red';
}
export function platformLabel(platform?: string): string {
  return ({macos: 'macOS', windows: 'Windows', linux: 'Linux'} as Record<string, string>)[platform ?? ''] ?? '';
}
export function routeKindLabel(kind: DeviceRoute['kind']): string {
  return {tailscale: 'Tailscale（推荐）', lan: '局域网', cgnat: '运营商地址', public: '公网'}[kind];
}
export type RowView = {title: string; detail: string[]; status: string; tone: StatusTone; repair: boolean};
export function rowView(row: DeviceRow, now: number, localName?: string): RowView {
  const local = row.id === 'local';
  const detail = [...(local && localName ? [localName] : []), platformLabel(row.platform), row.version ? `v${row.version}` : ''].filter(Boolean);
  return {
    title: local ? '这台电脑' : row.name, detail, status: statusLabel(row, now), tone: statusTone(row.status),
    repair: !local && (row.status === 'revoked' || row.status === 'needs-pairing'),
  };
}

const at = (route: Pick<DeviceRoute, 'host' | 'port'>) => `${route.host}:${route.port}`;
export function routeHint(route: DeviceRoute, code: string, name: string): string {
  if (code === 'forbidden') return `${name}在 ${at(route)} 上没有开放连接，它可能换了地址。在那台设备上重新生成连接链接，粘到"添加设备"里，会自动更新地址。`;
  if (code === 'device_identity_changed') return `${at(route)} 上的 Vonvon Bot 不是${name}，可能是同一个网络里别的电脑换到了这个地址。会接着试别的地址；都不行就在${name}上重新生成连接链接，粘到"添加设备"里更新地址。`;
  const base = {
    tailscale: `连不上${name}（${route.host}）。两台设备都登录了同一个 Tailscale 账号吗？在这台电脑上运行 \`tailscale ping ${route.host}\` 看看。`,
    lan: `连不上${name}（${route.host}）。两台设备在同一个局域网里吗？那台设备开着吗？`,
    cgnat: `连不上${name}（${route.host}）。这是运营商分配的地址，一般从外面连不进去，建议两台都装上 Tailscale。`,
    public: `连不上${name}（${route.host}）。那台设备的防火墙放行了 ${route.port} 端口吗？`,
  }[route.kind];
  return code === 'refused' ? `${base}那台设备上的 Vonvon Bot 可能没在运行，或者没有允许别的设备连接。` : base;
}
export const routeHints = (attempts: readonly RouteFailure[], name: string): string[] => attempts.map(entry => routeHint(entry.route, entry.code, name));

const PREVIEW_CODES = new Set<string>(['invalid_link', 'link_expired', 'own_link', 'already_added', 'no_secure_storage', 'registry_newer', 'registry_unreadable', 'too_many']);
export function linkPreviewCopy(code: LinkPreviewCode, name: string): string {
  switch (code) {
    case 'invalid_link': return '这不是 Vonvon Bot 的连接链接。链接以 `vonvon://pair#` 开头：在要连接的电脑的 Vonvon Bot → 设置 → 应用与启动 →「允许别的设备连接」里点「生成连接链接」；Linux 主机上运行 `vonvon pair`。';
    case 'link_expired': return `这条链接已经过期（10 分钟内有效）。在${name}上重新生成一条。`;
    case 'own_link': return '这是这台电脑自己的链接，不用添加。把它粘到另一台电脑的 Vonvon Bot 里。';
    case 'already_added': return `${name}已经在设备列表里了。`;
    case 'no_secure_storage': return '这台电脑的系统钥匙串现在用不了，没法安全地保存连接密钥，暂时不能添加设备，也不能重新配对。';
    case 'registry_newer': return '设备列表是更新版本的 Vonvon Bot 写的，这个版本只能看、不能改。先更新这台电脑上的应用。';
    case 'registry_unreadable': return '读不了设备列表文件，暂时不能添加设备。看一下 Vonvon Bot 的数据目录权限。';
    case 'too_many': return '最多加 32 台设备。先删掉不用的。';
  }
}
/** Network failures: the sentence is followed by a hint per address tried. */
const NETWORK_CODES = new Set(['refused', 'unreachable', 'timeout', 'closed', 'forbidden']);
export function failureCopy(code: string, name: string): string {
  if (PREVIEW_CODES.has(code)) return linkPreviewCopy(code as LinkPreviewCode, name);
  if (NETWORK_CODES.has(code)) return `连不上${name}。`;
  switch (code) {
    case 'client_revoked': case 'revoked': return `${name}已取消这台电脑的访问。要再连，请在那台设备上重新生成连接链接。`;
    case 'device_identity_changed': case 'identity_changed': return `${name}的身份和配对时不一样了（可能重装过，或换了数据目录）。为安全起见已断开。确认是你自己的设备后，重新配对。`;
    case 'unknown_client': return `${name}不认识这台电脑了，那台设备上的配对记录可能被清掉了。在那台设备上生成新链接，重新配对。`;
    case 'key_unreadable': return `读不出连接${name}用的密钥：系统钥匙串拒绝了，或者应用换过签名。可以再试一次；还不行就重新配对。`;
    case 'remote_disabled': return `${name}关闭了远程连接。在那台设备上重新开启（\`vonvon remote enable --tailscale\`，或在「允许别的设备连接」里勾选）后，这里会自动连上。`;
    case 'rate_limited': return `${name}暂时拒绝了这台电脑：短时间内连得太多次。1 分钟后会自动再试。`;
    case 'handshake_failed': return `和${name}建立加密连接失败。会自动再试；一直失败的话，在那台设备上重新生成链接、重新配对。`;
    case 'protocol_mismatch': return `${name}和这台电脑的版本不能一起工作。`;
    case 'link_used': case 'pairing_failed': return `这条链接已经被用掉了。如果不是你用的，请马上到${name}上撤销它：在那台设备的「允许别的设备连接」里，或者运行 \`vonvon clients ls\` 查看最近配对的设备、\`vonvon clients revoke <id>\` 撤销。然后生成一条新链接。`;
    case 'busy': return '正在添加另一台设备，等它完成。';
    case 'aborted': return '已取消。';
    case 'registry_write_failed': return '没能保存设备列表，这次没有添加。再试一次。';
    case 'pairing_interrupted': return `连接在配对中途断了。在${name}的「允许别的设备连接」里看一下有没有这台电脑：有就直接重试，没有就生成新链接。`;
    default: return `没能连上${name}（${code}）。`;
  }
}
/** Codes after which only pairing again helps; `key_unreadable` may also be tried again. */
export const REPAIR_CODES = new Set(['client_revoked', 'revoked', 'device_identity_changed', 'identity_changed', 'unknown_client', 'key_unreadable']);

export function registryNotices(state: Pick<DevicesState, 'registry' | 'secureStorage'>): string[] {
  return [
    ...(state.registry === 'recovered' ? [copy.recovered] : []),
    ...(state.registry === 'newer' ? [linkPreviewCopy('registry_newer', '')] : []),
    ...(state.registry === 'unreadable' ? [linkPreviewCopy('registry_unreadable', '')] : []),
    ...(state.secureStorage ? [] : [linkPreviewCopy('no_secure_storage', '')]),
  ];
}
/** Why "添加设备" is greyed out, if it is. */
export function addBlockedReason(state: Pick<DevicesState, 'registry' | 'secureStorage'>): string | undefined {
  if (!state.secureStorage) return linkPreviewCopy('no_secure_storage', '');
  if (state.registry === 'newer' || state.registry === 'unreadable') return linkPreviewCopy(state.registry === 'newer' ? 'registry_newer' : 'registry_unreadable', '');
  return undefined;
}

export const removeCopy = {
  title: (name: string) => `从列表里删除${name}？`,
  body: (name: string, revokes: boolean) => revokes ? `会同时让${name}取消这台电脑的访问。` : `这台电脑会忘掉连接它的密钥。${name}上还留着这台电脑的配对记录，可以在那边撤销。`,
  kept: (name: string) => `已从列表里删除${name}。它上面还留着这台电脑的配对记录，到那台设备的「允许别的设备连接」里撤销，或运行 \`vonvon clients revoke\`。`,
};

export type BannerCopy = {text: string; retry: boolean; hints: string[]; noticeAt?: number};
export function bannerCopy(active: ActiveDeviceState, name: string, now: number): BannerCopy | undefined {
  if (active.phase === 'reconnecting') {
    const hints = active.attempt >= 3 && active.failure ? routeHints(active.failure.attempts, name) : [];
    if (active.expected === 'restart') return {text: `${name}正在重启，好了会自动连上。`, retry: true, hints: []};
    if (active.expected === 'stop') return {text: `${name}的后台服务已停止，只能在那台设备上重新启动。启动后这里会自动连上。`, retry: true, hints: []};
    if (active.disabledAt !== undefined) return {text: failureCopy('remote_disabled', name), retry: true, hints: []};
    const seconds = active.retryAt === undefined ? 0 : Math.ceil((active.retryAt - now) / 1000);
    return {text: seconds > 0 ? `和${name}的连接断了，正在重连（${seconds} 秒后再试）。` : `和${name}的连接断了，正在重连。`, retry: true, hints};
  }
  if (active.phase !== 'ready' || !active.notice) return undefined;
  const text = active.notice.kind === 'restarted' ? `${name}重启过了，已重新连上。` : `${name}已更新到 ${active.notice.to ?? ''}。`;
  return {text, retry: false, hints: [], noticeAt: active.notice.at};
}

/** `x.y.z` by number; a `-pre` release sorts before the same number. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => { const [core = '', pre] = value.split('-', 2); return {parts: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre}; };
  const left = parse(a), right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const diff = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}
const UPDATE_CAPABILITIES = ['update.standalone', 'update.npm', 'update.bundled'];
export type VersionNotice = {text: string; side: 'server' | 'client'; blocking: boolean; action?: 'upgrade-server' | 'update-client'};
export function versionNotice(input: {serverVersion: string; serverProtocol: number; clientVersion: string; clientProtocol: number; capabilities?: readonly string[]; name: string}): VersionNotice | null {
  const {serverVersion: a, clientVersion: b, name, capabilities} = input;
  if (!capabilities) return {text: `${name}上的 Vonvon Bot（${a}）不支持远程管理，请在那台设备上升级一次。`, side: 'server', blocking: true};
  const blocking = input.serverProtocol !== input.clientProtocol;
  const order = blocking ? Math.sign(input.serverProtocol - input.clientProtocol) : compareVersions(a, b);
  if (order === 0) return null;
  if (order > 0) return {
    text: blocking ? `这台电脑的 Vonvon Bot（${b}）比${name}（${a}）旧，两边不能一起工作。先更新这台电脑上的应用。` : `这台电脑的 Vonvon Bot（${b}）比${name}（${a}）旧。建议先更新这台电脑上的应用。`,
    side: 'client', blocking, action: 'update-client',
  };
  return {
    text: blocking ? `${name}的服务端是 ${a}，这台电脑是 ${b}，两边不能一起工作。升级服务端后才能继续管理。` : `${name}的服务端是 ${a}，这台电脑是 ${b}。可以继续用；建议升级服务端。`,
    side: 'server', blocking, ...(capabilities.some(item => UPDATE_CAPABILITIES.includes(item)) ? {action: 'upgrade-server' as const} : {}),
  };
}
export const cannotUpgradeRemotely = (name: string) => `${name}上的这个版本还不能从这里升级，请在那台设备上升级 Vonvon Bot。`;
/** Only the requests a connection of another protocol may make; the rest are refused here and never sent. */
export function maintenanceRequest(machine: MachineRequestHandler): MachineRequestHandler {
  const allowed = new Set<string>(MAINTENANCE_KINDS);
  return request => allowed.has(`machine.${request.type}`) ? machine(request) : Promise.reject(new Error(copy.maintenanceOnly));
}

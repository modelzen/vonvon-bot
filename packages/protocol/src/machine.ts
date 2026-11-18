import {z} from 'zod';
import {agentIdStringSchema, distributionSchema, lingerStateSchema, serviceStateSchema} from './domain.js';
import {mcpRequestSchema, mcpReplySchema} from './mcp.js';
import {bridgeImportReplySchema} from './bridge-import.js';

/**
 * U4: what the desktop shell declares in `admin.negotiate` on its loopback connection, so the daemon may ask it to update
 * the app it came with. Lower case only: negotiate's capability names are `/^[a-z][a-z0-9.-]{0,63}$/`.
 */
export const DESKTOP_SELF_UPDATE_CAPABILITY = 'desktop.self-update';
/** What the shell's updater says (DesktopUpdate's states), and the steps of an update it runs for the daemon. */
export const DESKTOP_UPDATE_REPORT_STATES = ['available', 'current', 'unavailable', 'install-pending', 'downloading', 'downloaded', 'restarting', 'error'] as const;
export type DesktopUpdateReportState = typeof DESKTOP_UPDATE_REPORT_STATES[number];
export const machineRequestSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('mcp'), request:mcpRequestSchema}),
  z.object({type:z.literal('bridgeImport'), action:z.enum(['detect','preflight','start','status','rollback']), acceptedChanges:z.literal(true).optional()}),
  z.object({type:z.literal('status')}),
  z.object({type:z.literal('service'), action:z.enum(['install','start','stop','uninstall'])}),
  /** Remembers that the user chose a detached daemon over the login-time service, so the checklist stops asking. */
  z.object({type:z.literal('setServiceSkipped'), skipped:z.boolean()}),
  z.object({type:z.literal('startHost'), bot:agentIdStringSchema.optional()}),
  /** `reason: 'update'`: a desktop update stops the server (owner 2026-11-02), and the cards of the cut-short turns say so. */
  z.object({type:z.literal('stopHost'), reason:z.literal('update').optional()}),
  z.object({type:z.literal('logs')}),
  /** `fresh: false` answers with the standalone server's last daily check instead of reading the manifest again. */
  z.object({type:z.literal('checkCoreUpdate'), fresh:z.boolean().optional()}),
  /** Standalone only: `version` with `allowDowngrade` goes back to a release still kept on this machine. */
  z.object({type:z.literal('applyCoreUpdate'), version:z.string().regex(/^\d+\.\d+\.\d+$/).optional(), allowDowngrade:z.boolean().optional()}),
  z.object({type:z.literal('coreUpdateStatus')}),
  /**
   * devices 7.5 (U4): the desktop shell on the server's own computer reports on the update it runs for the daemon, as
   * the answer to a `desktopUpdateRequest` event. Only that shell's loopback connection may send it.
   */
  z.object({type:z.literal('desktopUpdateReport'), requestId:z.string().regex(/^dur_[0-9a-f]{16}$/), state:z.enum(DESKTOP_UPDATE_REPORT_STATES),
    latest:z.string().max(64).optional(), message:z.string().max(1024),
    progress:z.object({transferred:z.number().nonnegative(),total:z.number().nonnegative()}).strict().optional()}).strict(),
]);
export type MachineRequest = z.infer<typeof machineRequestSchema>;
export type DesktopUpdateReport = Extract<MachineRequest, {type: 'desktopUpdateReport'}>;
export const serviceStatusSchema = z.object({platformName:z.string(),installed:z.boolean(),running:z.boolean(),servicePath:z.string(),stdoutPath:z.string(),stderrPath:z.string(),pid:z.string().optional(),lastExit:z.string().optional(),state:serviceStateSchema.optional(),detail:z.string().optional(),name:z.string().optional(),linger:z.object({state:lingerStateSchema,detail:z.string().optional()}).optional(),hint:z.string().optional()});
/**
 * `update-status.json` (server-3 C3). `phase` and `detail` parse as open strings: a phase a client does not know is
 * still "in progress". `previous` is the release a standalone update switched away from, `rolledBack` that it went back.
 * `via: 'desktop'`: the desktop app on the server's computer runs the update (U4).
 */
export const coreUpdateStatusSchema = z.object({phase:z.string(),ok:z.boolean().optional(),message:z.string().optional(),from:z.string().optional(),to:z.string().optional(),at:z.number(),
  previous:z.string().optional(),progress:z.object({transferred:z.number().nonnegative(),total:z.number().nonnegative()}).optional(),detail:z.string().optional(),rolledBack:z.boolean().optional(),
  via:z.string().optional()}).nullable();
export type CoreUpdateStatus = NonNullable<z.infer<typeof coreUpdateStatusSchema>>;
const CORE_UPDATE_DETAIL: Record<string, string> = {
  checking: '正在检查更新', downloading: '下载中', verifying: '校验中', unpacking: '解包中', switching: '切换中',
  draining: '正在中断进行中的对话', waiting: '等新版本启动', 'rolled-back': '已切回旧版',
  'desktop-checking': '正在检查桌面端更新', 'desktop-downloading': '正在下载桌面端更新',
  'desktop-downloaded': '下载好了，正在重启（会中断正在进行的对话）',
};
const CORE_UPDATE_PHASE: Record<string, string> = { installing: '正在安装', restarting: '正在重启', done: '更新完成', error: '更新失败' };
/** One line for an update's progress, the same on the page and in `vonvon update`; an unknown phase is "进行中". */
export function coreUpdateStatusText(status: CoreUpdateStatus): string {
  const ended = status.phase === 'done' || status.phase === 'error';
  const step = (!ended && status.detail && CORE_UPDATE_DETAIL[status.detail]) || CORE_UPDATE_PHASE[status.phase] || '进行中';
  const percent = status.progress && status.progress.total > 0 ? ` ${Math.floor(status.progress.transferred / status.progress.total * 100)}%` : '';
  return `${step}${percent}${status.message ? `：${status.message}` : ''}`;
}
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export const desktopUpdateSchema = z.object({state:z.enum(['current','available','unavailable','downloaded','install-pending']),current:z.string(),latest:z.string().optional(),message:z.string(),releaseNotes:z.string().max(4096).optional(),downloadProgress:z.object({percent:z.number().finite().min(0).max(100),transferred:z.number().finite().nonnegative(),total:z.number().finite().nonnegative()}).optional()});
export type DesktopUpdate = z.infer<typeof desktopUpdateSchema>;
/**
 * 设置入口、设置首页和菜单栏用的"有更新"提示。有新版本可装（可下载或已下载）写版本号；
 * 上次安装没生效也要标出来，否则用户不进"应用与启动"就不知道自己卡在旧版本。其余状态不打扰。
 */
export function desktopUpdateNotice(update: DesktopUpdate | undefined): string | undefined {
  if (!update) return undefined;
  if (update.state === 'available' || update.state === 'downloaded') return update.latest ? `有新版本 ${update.latest}` : '有新版本';
  return update.state === 'install-pending' ? '上次更新没装上' : undefined;
}
export const machineReplySchema = z.discriminatedUnion('type', [
  mcpReplySchema,
  bridgeImportReplySchema,
  z.object({type:z.literal('status'),service:serviceStatusSchema,host:z.object({ownership:z.enum(['owned','attached']),pid:z.number()}).nullable(),temporaryAgent:z.string().optional(),cli:z.union([z.object({kind:z.literal('ready'),bin:z.string(),message:z.string()}),z.object({kind:z.literal('error'),message:z.string()})])}),
  z.object({type:z.literal('done'),message:z.string()}),
  z.object({type:z.literal('logs'),text:z.string()}),
  /** U4, a server the desktop app carries: `desktopShell`, whether that app is open on its computer now; `message`, what
   * its updater said when it cannot update (an unsigned build, no answer), or why this one is updated there only. */
  z.object({type:z.literal('coreUpdate'),distribution:distributionSchema,current:z.string(),latest:z.string().nullable(),hasUpdate:z.boolean(),dev:z.boolean(),channel:z.string().optional(),refused:z.string().optional(),
    desktopShell:z.boolean().optional(),message:z.string().optional()}),
  z.object({type:z.literal('coreUpdateStatus'),status:coreUpdateStatusSchema}),
]);
export type MachineReply = z.infer<typeof machineReplySchema>;
export type MachineRequestHandler = (request:MachineRequest)=>Promise<MachineReply>;

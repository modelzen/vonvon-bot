import { badArgs, CommandError } from '../command-error';
import { connectLocalDaemon, print, withDaemon, type Io } from '../daemon-client';
import { paths } from '../../config/paths';
import { inBotSession, SESSION_BOT_ENV, SESSION_SCOPE_ENV } from '../../config/session-env';
import { verifyPidLockOwner } from '../../server/owner-verification';
import { readRunningPidLock } from '../../server/pid-lock';
import { extractTemplate, inspectTemplate, packTemplate, PackRedactionError, stageTemplate } from '../../template/ops';

const NOT_DM_MESSAGE = '群聊和云文档评论会话不能运行配方命令。请私聊我或在终端里操作。';
const OWNER_CRED_MESSAGE = '无法核验主人身份凭据，已拒绝在当前会话运行配方命令。请私聊我或在主人终端里操作。';

/**
 * Synchronous pre-check for local terminal and DM (`p2p`) sessions.
 * Group and document-comment sessions are refused immediately.
 */
export function assertTemplateSessionAllowed(env: NodeJS.ProcessEnv = process.env, explicitScope?: string): void {
  if (explicitScope) {
    throw new CommandError('refused', NOT_DM_MESSAGE, { reason: 'not_dm' });
  }
  if (!inBotSession(env)) return;
  if (env[SESSION_SCOPE_ENV] || !env[SESSION_BOT_ENV]) {
    throw new CommandError('refused', NOT_DM_MESSAGE, { reason: 'not_dm' });
  }
}

/**
 * Cryptographically verify the caller's session/owner identity before running template CLI ops:
 * - Bot session (`VONVON_SESSION` / bridge): authenticate the session token with the running daemon
 *   via `admin.negotiate` and require `principal === 'bot-session:dm'`.
 * - Non-bot invocation: if a daemon is running for `home`, verify owner read access to `local-credential`
 *   so a sandboxed group session that unsets `VONVON_SESSION` cannot spoof a local terminal.
 *   When no daemon is running, offline local terminal usage continues to work.
 */
export async function verifyTemplateSessionAllowed(
  env: NodeJS.ProcessEnv = process.env,
  explicitScope?: string,
  home: string = paths.appDir,
): Promise<void> {
  assertTemplateSessionAllowed(env, explicitScope);

  if (inBotSession(env)) {
    await withDaemon(
      async (call) => {
        const reply = await call('核对配方会话身份', c => c.admin({ type: 'negotiate', capabilities: ['cli'] }));
        if (reply.kind !== 'negotiated' || reply.principal !== 'bot-session:dm') {
          throw new CommandError('refused', NOT_DM_MESSAGE, { reason: 'not_dm' });
        }
      },
      () => connectLocalDaemon(home, undefined, env),
    );
    return;
  }

  let lock;
  try {
    lock = await readRunningPidLock(home);
  } catch {
    throw new CommandError('refused', OWNER_CRED_MESSAGE, { reason: 'permission_denied' });
  }
  if (lock) {
    try {
      await verifyPidLockOwner(home, lock);
    } catch {
      throw new CommandError('refused', OWNER_CRED_MESSAGE, { reason: 'permission_denied' });
    }
  }
}

function wrapError(err: unknown): never {
  if (err instanceof CommandError) throw err;
  if (err instanceof PackRedactionError) {
    throw new CommandError('refused', err.message, { reason: 'redaction_failed' });
  }
  throw new CommandError('failed', err instanceof Error ? err.message : String(err));
}

export async function runTemplateInspect(source: string, options: { sourceUrl?: string }, io: Io): Promise<void> {
  try {
    const result = await inspectTemplate(source, { sourceUrl: options.sourceUrl });
    const lines = [
      `${result.name} (${result.id} v${result.version})`,
      `简介：${result.summary}`,
      `作者：${result.author.name}${result.author.contact ? ` · ${result.author.contact}` : ''}`,
      result.public
        ? `公开宣传：是${result.docUrl ? ` · ${result.docUrl}` : ''}`
        : '公开宣传：否（仅本地私用，不会上报社区）',
      `签名状态：${result.signatureStatus === 'valid' ? '有效' : result.signatureStatus === 'invalid' ? '无效' : '未签名'}`,
      `Skill（${result.skills.length}）：${result.skills.length ? result.skills.map(s => `${s.name}${s.setup ? ' [setup]' : ''}`).join('、') : '无'}`,
      `预置工作区文件（${result.workspaceFiles.length}）：${result.workspaceFiles.length ? result.workspaceFiles.slice(0, 10).join('、') : '无'}`,
      ...(result.group.recommendedPermission ? [`建议权限：${result.group.recommendedPermission}${result.group.permissionNote ? `（${result.group.permissionNote}）` : ''}`] : []),
      ...(result.group.schedules?.length ? [`定时任务模板（${result.group.schedules.length}）：${result.group.schedules.map(s => s.name).join('、')}`] : []),
      ...result.warnings.map(w => `提示：${w}`),
    ];
    print(io, lines, result);
  } catch (err) {
    wrapError(err);
  }
}

export async function runTemplateExtract(source: string, options: { dest?: string; sourceUrl?: string }, io: Io): Promise<void> {
  if (!options.dest?.trim()) throw badArgs('缺少必填参数 --dest <空目录>');
  try {
    const result = await extractTemplate(source, options.dest, { sourceUrl: options.sourceUrl });
    print(io, [`已安全解包 ${result.id} v${result.version}（${result.filesWritten} 个文件）到 ${result.dest}`], result);
  } catch (err) {
    wrapError(err);
  }
}

export async function runTemplateStage(
  source: string,
  options: { dest?: string; mode?: string; updateSkills?: boolean; sourceUrl?: string; telemetry?: boolean },
  io: Io,
): Promise<void> {
  if (!options.dest?.trim()) throw badArgs('缺少必填参数 --dest <群工作区目录>');
  const mode = options.mode ?? 'fresh';
  if (mode !== 'fresh' && mode !== 'merge') throw badArgs('--mode 只能是 fresh 或 merge');
  try {
    const result = await stageTemplate(source, options.dest, {
      mode,
      updateSkills: Boolean(options.updateSkills),
      sourceUrl: options.sourceUrl,
      noTelemetry: options.telemetry === false,
    });
    const lines = [
      `已铺设配方 ${result.id} v${result.version} 到 ${result.dest}（模式：${result.mode}）`,
      `写入工作区文件：${result.writtenWorkspaceFiles.length} 个`,
      `新增 Skill：${result.addedSkills.length ? result.addedSkills.join('、') : '无'}`,
      ...(result.updatedSkills.length ? [`已更新 Skill：${result.updatedSkills.join('、')}`] : []),
      ...(result.conflictingWorkspaceFiles.length ? [`冲突的工作区文件（未覆盖，待协商合并）：${result.conflictingWorkspaceFiles.join('、')}`] : []),
      ...(result.conflictingSkills.length ? [`冲突的 Skill（未覆盖，传 --update-skills 可更新）：${result.conflictingSkills.join('、')}`] : []),
    ];
    print(io, lines, result);
  } catch (err) {
    wrapError(err);
  }
}

function formatPublishLine(publish: NonNullable<Awaited<ReturnType<typeof packTemplate>>['publish']>): string {
  if (!publish.ok) {
    return `宣传名片上报未成功（本地包已生成）：${publish.error ?? '网络异常'}`;
  }
  const coverNote = publish.coverUploaded ? '，已同步飞书封面图' : '';
  const suffix = publish.url ? `：${publish.url}` : '';
  if (publish.status === 'pending_author_trust') {
    return `首次发布已提交至 Vonvon 灵感 Club（新作者首次核验中，通过后你后续的配方与更新会自动秒上${coverNote}）${suffix}`;
  }
  if (publish.status === 'updated') {
    return `已更新至 Vonvon 灵感 Club（公开宣传页已刷新${coverNote}）${suffix}`;
  }
  return `已上架至 Vonvon 灵感 Club${coverNote ? `（${coverNote.slice(1)}）` : ''}${suffix}`;
}

export async function runTemplatePack(
  dir: string,
  options: { out?: string; publish?: boolean },
  io: Io,
): Promise<void> {
  if (!options.out?.trim()) throw badArgs('缺少必填参数 --out <输出路径.vonvon.zip>');
  try {
    const result = await packTemplate(dir, options.out, { publish: Boolean(options.publish) });
    const lines = [
      `已打包配方 ${result.id} v${result.version} → ${result.out}（${result.sizeBytes} 字节，sha256: ${result.sha256.slice(0, 16)}…）`,
      `Skill：${result.skillNames.length ? result.skillNames.join('、') : '无'} · 预置文件：${result.workspaceFileCount} 个 · 公开宣传：${result.public ? '是' : '否'}`,
      ...(result.publish ? [formatPublishLine(result.publish)] : []),
    ];
    print(io, lines, result);
  } catch (err) {
    wrapError(err);
  }
}

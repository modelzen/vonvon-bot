import type { ProjectSettingsView, ScheduledTaskView } from '@vonvon/protocol';
import type { VonvonClient } from '@vonvon/client';
import { badArgs, CommandError } from '../command-error';
import {
  cliEnv, cliIsDmSession, connectLocalDaemon, pickBot, pickGroup, print, setCliContext, want, withDaemon,
  type Daemon, type DaemonConnection, type Io,
} from '../daemon-client';
import { paths } from '../../config/paths';
import { inBotSession, SESSION_BOT_ENV, SESSION_SCOPE_ENV } from '../../config/session-env';
import { verifyPidLockOwner } from '../../server/owner-verification';
import { readRunningPidLock } from '../../server/pid-lock';
import {
  draftTemplateFromDirectory, extractTemplate, inspectTemplate, packTemplate, PackRedactionError, stageTemplate,
} from '../../template/ops';
import type { TemplateSchedule } from '../../template/schema';

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
  connect?: () => Promise<VonvonClient | DaemonConnection>,
): Promise<void> {
  assertTemplateSessionAllowed(env, explicitScope);

  if (inBotSession(env)) {
    // `withDaemon` automatically performs the single allowed `admin.negotiate` handshake for bot
    // sessions and stores whether `principal === 'bot-session:dm'` in `cliIsDmSession()`.
    const prevEnv = cliEnv();
    setCliContext({ env });
    try {
      await withDaemon(
        async () => {
          if (!cliIsDmSession()) {
            throw new CommandError('refused', NOT_DM_MESSAGE, { reason: 'not_dm' });
          }
        },
        connect ?? (() => connectLocalDaemon(home, undefined, env)),
      );
    } finally {
      setCliContext({ env: prevEnv });
    }
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

function toTemplateSchedule(task: ScheduledTaskView): TemplateSchedule | undefined {
  const { spec } = task;
  let when: TemplateSchedule['when'] | undefined;
  switch (spec.kind) {
    case 'daily':
      when = { kind: 'daily', time: spec.time };
      break;
    case 'weekly': {
      // ScheduleSpec uses 0=Sun..6=Sat; TemplateSchedule uses 1=Mon..7=Sun.
      const days = [...new Set(spec.days.map(d => (d === 0 ? 7 : d)))].filter(d => d >= 1 && d <= 7).sort((a, b) => a - b);
      if (days.length > 0) when = { kind: 'weekly', days, time: spec.time };
      break;
    }
    case 'every':
      if (spec.minutes >= 5 && spec.minutes <= 1440) when = { kind: 'every', minutes: spec.minutes };
      break;
    case 'cron':
      if (spec.expr.trim().length >= 5 && spec.expr.trim().length <= 120) when = { kind: 'cron', expr: spec.expr.trim() };
      break;
    case 'once':
    default:
      return undefined;
  }
  if (!when) return undefined;
  const name = task.name.trim().slice(0, 80);
  const prompt = task.instruction.trim().slice(0, 4000);
  if (!name || !prompt) return undefined;
  return {
    name,
    when,
    prompt,
    enabledByDefault: task.state === 'active',
  };
}

function normalizePermissionTier(value: unknown): 'qa' | 'write' | 'full' | undefined {
  return value === 'qa' || value === 'write' || value === 'full' ? value : undefined;
}

export async function runTemplateDraftGroup(
  group: string,
  options: { dest?: string; bot?: string; author?: string },
  io: Io,
  daemon: Daemon = withDaemon,
): Promise<void> {
  if (!options.dest?.trim()) throw badArgs('缺少必填参数 --dest <空草稿目录>');
  try {
    const extracted = await daemon(async (call) => {
      if (inBotSession(cliEnv()) && !cliIsDmSession()) {
        throw new CommandError('refused', NOT_DM_MESSAGE, { reason: 'not_dm' });
      }
      const snapshot = await call('读取快照', c => c.snapshot());
      const bot = pickBot(snapshot.agents, options.bot);
      const membership = pickGroup(snapshot.memberships, bot, group);

      let roleSupplement: string | undefined;
      let recommendedPermission = normalizePermissionTier(membership.effectMode ?? membership.permission?.administrator);
      let disabledSkillPaths: string[] = [];
      let settingsWarning: string | undefined;

      try {
        const reply = await call(
          '读取群设置',
          c => c.settings({ type: 'read', scope: { kind: 'project', botId: bot.id, projectName: membership.name } }),
          { provider: true },
        );
        if (reply.kind === 'view' && reply.view.scope.kind === 'project') {
          const view = reply.view as ProjectSettingsView;
          const roleStored = view.sections.role?.stored?.supplement;
          if (typeof roleStored === 'string' && roleStored.trim()) roleSupplement = roleStored.trim();
          const permMode = normalizePermissionTier(view.sections.permission?.stored?.mode);
          if (permMode) recommendedPermission = permMode;
          disabledSkillPaths = [...(view.sections.skills?.stored?.disabledPaths ?? [])];
        }
      } catch (err) {
        settingsWarning = `未能读取群设置详情（已按工作区文件继续）：${err instanceof Error ? err.message : String(err)}`;
      }

      const schedules: TemplateSchedule[] = [];
      const skippedSchedules: { name: string; reason: string }[] = [];
      let scheduleWarning: string | undefined;
      try {
        const schedReply = await call('读取群定时任务', c => c.schedule(bot.id, { action: 'list', chatId: membership.groupId }));
        const tasks = want('读取群定时任务', schedReply, 'tasks').tasks;
        for (const task of tasks) {
          const converted = toTemplateSchedule(task);
          if (converted) schedules.push(converted);
          else skippedSchedules.push({ name: task.name, reason: task.spec.kind === 'once' ? '一次性任务不纳入配方模板' : '周期超出配方模板支持范围' });
        }
      } catch (err) {
        scheduleWarning = `未能读取群定时任务（已跳过）：${err instanceof Error ? err.message : String(err)}`;
      }

      return {
        botId: bot.id,
        botName: bot.name,
        groupId: membership.groupId,
        groupName: membership.name,
        sourceDir: membership.directory,
        roleSupplement,
        recommendedPermission,
        disabledSkillPaths,
        schedules,
        skippedSchedules,
        warnings: [settingsWarning, scheduleWarning].filter((w): w is string => Boolean(w)),
      };
    });

    const draft = await draftTemplateFromDirectory({
      sourceDir: extracted.sourceDir,
      destDir: options.dest,
      groupName: extracted.groupName,
      groupId: extracted.groupId,
      ...(options.author ? { authorName: options.author } : {}),
      ...(extracted.roleSupplement ? { roleSupplement: extracted.roleSupplement } : {}),
      ...(extracted.recommendedPermission ? { recommendedPermission: extracted.recommendedPermission } : {}),
      ...(extracted.schedules.length ? { schedules: extracted.schedules } : {}),
      disabledSkillPaths: extracted.disabledSkillPaths,
    });

    const result = {
      ...draft,
      groupId: extracted.groupId,
      groupName: extracted.groupName,
      botId: extracted.botId,
      skippedSchedules: extracted.skippedSchedules,
      warnings: extracted.warnings,
    };

    const lines = [
      `已从群「${extracted.groupName}」（${extracted.sourceDir}）提取配方草稿 → ${draft.dest}`,
      `配方：${draft.name} (${draft.id} v${draft.version})${draft.reusedExistingManifest ? '（已沿用群内原有 vonvon-bot.json）' : ''}`,
      `Skill（${draft.skills.length}）：${draft.skills.length ? draft.skills.map(s => s.name).join('、') : '无'}`,
      `预置工作区文件（${draft.workspaceFiles.length}）：${draft.workspaceFiles.length ? draft.workspaceFiles.slice(0, 12).join('、') : '无'}`,
      ...(draft.recommendedPermission ? [`建议权限：${draft.recommendedPermission}`] : []),
      ...(draft.roleIncluded ? ['群角色补充：已提取'] : []),
      ...(draft.scheduleCount ? [`定时任务模板：${draft.scheduleCount} 个`] : []),
      ...(draft.skippedEntries.length ? [`已跳过运行期/受限条目（${draft.skippedEntries.length}）：${draft.skippedEntries.slice(0, 8).map(e => `${e.path} (${e.reason})`).join('、')}`] : []),
      ...(draft.redactionWarnings.length ? [`脱敏提醒（打包前请清理 ${draft.redactionWarnings.length} 处）：${draft.redactionWarnings.slice(0, 5).map(w => `${w.file}:${w.line ?? '?'} ${w.message}`).join('；')}`] : []),
      ...extracted.warnings.map(w => `提示：${w}`),
    ];
    print(io, lines, result);
  } catch (err) {
    wrapError(err);
  }
}

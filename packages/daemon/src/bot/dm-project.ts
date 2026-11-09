import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { TIER_NETWORK } from '../agent/permission/types';
import { assertBotIdentity, botIdentity, ensureBotDmDirectory, ensureRegistry, loadBots, type BotEntry, type BotIdentity } from '../config/bots';
import { resolveProjectsRootDir } from '../config/directories';
import { DirectoryError } from '../config/directory-errors';
import { resolveExecution } from '../config/execution';
import { botPaths, paths } from '../config/paths';
import type { AppPreferences } from '../config/schema';
import { loadConfig } from '../config/store';
import { log } from '../core/logger';
import { assertBridgeImportReservation } from '../import/bridge/reservation';
import { addDmProject, dmChatId, dmProject, DM_PROJECT_NAME, type Project, type RegistryLocation } from '../project/registry';

/** Fixed once at creation; from then on the private chat's own, apart from the bot's default (dm-agent 4.1). */
export type DmProjectDefaults = Pick<Project, 'backend' | 'defaultModel' | 'defaultEffort' | 'defaultModelCustom' | 'modelAccess'>;

/** Upgrading local data must not start a Provider or wait for its login/model catalog. */
export function storedDmDefaults(preferences: AppPreferences | undefined): DmProjectDefaults {
  const { backend, model } = resolveExecution({ bot: preferences });
  return { backend, ...(model?.model ? { defaultModel: model.model } : {}),
    ...(model?.effort ? { defaultEffort: model.effort } : {}), ...(model?.custom ? { defaultModelCustom: true } : {}) };
}

const failures = new Map<string, string>();
const failureKey = (botId: string): string => `${paths.appDir}\0${botId}`;
export const dmPreparationError = (botId: string): string | undefined => failures.get(failureKey(botId));
function recordFailure(botId: string, error: unknown): void {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const message = error instanceof DirectoryError ? error.message
    : code === 'EACCES' || code === 'EPERM' ? '无法读取或写入私聊数据。请检查数据目录权限后重试。'
    : error instanceof SyntaxError ? '私聊数据格式有误。请在设置 → 诊断中查看日志，修复后重试。'
    : '私聊准备失败。请在设置 → 诊断中查看日志，修复后重启 Bot。';
  if (failures.get(failureKey(botId)) !== message) log.fail('project', error, { phase: 'dm-project' });
  failures.set(failureKey(botId), message);
}

/**
 * Host startup and Bot initialization share this path. Existing settings remain untouched; only a missing row
 * receives defaults. Failures keep the Bot starting, appear in its settings list, and can be retried locally.
 */
export async function ensureDmProject(input: { bot: BotIdentity; projectsRootDir: string | undefined; defaults: () => Promise<DmProjectDefaults>; target?: RegistryLocation }): Promise<Project | undefined> {
  try {
    await assertBotIdentity(input.bot);
    await assertBridgeImportReservation(paths.appDir, input.bot.appId);
    const existing = await dmProject(input.target?.file);
    if (existing) {
      // A stored private chat owns its settings and location. Do not allocate an unused default folder or list models.
      const allocation = (await loadBots()).allocations?.[input.bot.appId];
      if (allocation && existing.cwd === join(allocation.namespaceRoot, 'dm')) {
        await ensureBotDmDirectory(input.bot, resolveProjectsRootDir(input.projectsRootDir));
      } else {
        // A legacy/custom location has no managed claim. Validate it without creating anything or following links.
        if (!(await lstat(existing.cwd)).isDirectory() || await realpath(existing.cwd) !== existing.cwd) {
          throw new Error('Private chat directory changed');
        }
      }
      failures.delete(failureKey(input.bot.appId));
      return existing;
    }
    const cwd = await ensureBotDmDirectory(input.bot, resolveProjectsRootDir(input.projectsRootDir));
    const defaults = await input.defaults();
    const row = await addDmProject({ ...defaults, name: DM_PROJECT_NAME, chatId: dmChatId(input.bot.appId), cwd, blank: true, origin: 'created',presentation:{cardDisplay:null},
      kind: 'single', smart: true, noMention: true, mode: 'full', network: TIER_NETWORK.full, createdAt: Date.now(),
      dm: { people: {}, ...(!defaults.defaultModel && !defaults.modelAccess ? { useProviderDefault: true as const } : {}) } }, input.target);
    failures.delete(failureKey(input.bot.appId));
    log.info('project', 'dm-project', { cwd: row.cwd, backend: row.backend });
    return row;
  } catch (error) { recordFailure(input.bot.appId, error); return undefined; }
}

/** Explicit per-Bot files: works in the host for stopped Bots too, without switching the process's active Bot. */
export async function prepareDmProjectForBot(bot: BotEntry): Promise<Project | undefined> {
  try {
    const files = botPaths(bot.appId);
    const cfg = await loadConfig(files.configFile);
    return await ensureDmProject({ bot: botIdentity(bot), projectsRootDir: cfg.preferences?.projectsRootDir,
      defaults: async () => storedDmDefaults(cfg.preferences), target: { file: files.projectsFile, dataRoot: paths.appDir } });
  } catch (error) { recordFailure(bot.appId, error); return undefined; }
}

/** Before starting any Bot, including disabled Bots and machines without a working Provider. */
export async function prepareDmProjectsAtStartup(): Promise<void> {
  for (const bot of (await ensureRegistry()).bots) await prepareDmProjectForBot(bot);
}

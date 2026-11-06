import { TIER_NETWORK } from '../agent/permission/types';
import { ensureDurableDirectory } from '../config/bot-namespace';
import { ensureBotDmDirectory, type BotIdentity } from '../config/bots';
import { resolveProjectsRootDir } from '../config/directories';
import { log } from '../core/logger';
import { addDmProject, dmChatId, dmProject, DM_PROJECT_NAME, type Project } from '../project/registry';

/** Fixed once at creation; from then on the private chat's own, apart from the bot's default (dm-agent 4.1). */
export type DmProjectDefaults = Pick<Project, 'backend' | 'defaultModel' | 'defaultEffort' | 'defaultModelCustom' | 'modelAccess'>;

/**
 * Every start of the bot process, the one path for a new bot and an upgraded one: the private-chat row exists and so
 * does its folder. The defaults are only worked out for a row that is missing. A failure is logged and the bot starts;
 * the next start tries again.
 */
export async function ensureDmProject(input: { bot: BotIdentity; projectsRootDir: string | undefined; defaults: () => Promise<DmProjectDefaults> }): Promise<void> {
  try {
    // Through the Bot's directory record even when the row exists: a folder made behind it stops the Bot's next group.
    const cwd = await ensureBotDmDirectory(input.bot, resolveProjectsRootDir(input.projectsRootDir));
    const existing = await dmProject();
    if (existing) { await ensureDurableDirectory(existing.cwd); return; }
    const row = await addDmProject({ ...await input.defaults(), name: DM_PROJECT_NAME, chatId: dmChatId(input.bot.appId), cwd, blank: true, origin: 'created',
      kind: 'single', smart: true, noMention: true, mode: 'full', network: TIER_NETWORK.full, createdAt: Date.now(), dm: { people: {} } });
    log.info('project', 'dm-project', { cwd: row.cwd, backend: row.backend });
  } catch (error) { log.fail('project', error, { phase: 'dm-project' }); }
}

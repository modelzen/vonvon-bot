import { updateBotName, type BotIdentity } from '../config/bots';
import { log } from '../core/logger';

/**
 * The app was renamed in the Feishu developer console: the name `bot/v3/info` gives now replaces the saved display
 * name, so the desktop and web pages show it (they reread bots.json on every snapshot). Called right after the daemon
 * validated the credentials: when a bot starts, and when the web's 状态与诊断 page (检查连接) asks. No name, a blank
 * name, the same name, or a failed write changes nothing and never fails the caller.
 */
export async function syncBotName(
  scope: string, identity: BotIdentity, saved: string | undefined, reported: string | undefined,
): Promise<void> {
  // The response is only type-asserted; a non-string name must not reject the caller (getSetupStatus).
  const name = typeof reported === 'string' ? reported.trim() : undefined;
  if (!name || name === saved) return;
  try {
    if (await updateBotName(identity, name) === 'updated') {
      log.info(scope, 'bot-name-synced', { appId: identity.appId, from: saved ?? null, to: name });
    }
  } catch (error) {
    log.fail(scope, error, { phase: 'sync-bot-name', appId: identity.appId }, { console: false });
  }
}

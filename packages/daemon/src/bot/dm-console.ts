import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { isAdmin, type AppConfig } from '../config/schema';
import { buildDmMenuCard } from '../card/dm-cards';
import { sendManagedCard } from '../card/managed';
import { log, withTrace } from '../core/logger';
import { bridgeVersion } from '../core/version';

/**
 * The private chat's `/menu`. Admin-gated. Card-first: create / list / remove all
 * happen via card buttons (dm.* actions in handle-message). Everything else a
 * person writes here goes to their Agent (dm-agent 5); the console runs no session.
 */
export async function handleDmConsole(channel: LarkChannel, cfg: AppConfig, msg: NormalizedMessage): Promise<void> {
  await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
    if (!isAdmin(cfg, msg.senderId)) {
      log.info('console', 'deny', { sender: msg.senderId.slice(-6) });
      await channel
        .send(msg.chatId, { markdown: '⛔ 仅管理员可在私聊里管理项目。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    // The menu is a CardKit entity so dm.* button clicks can update it in place
    // (raw-JSON cards can't be patched — they flash and revert).
    try {
      const { messageId } = await sendManagedCard(channel, msg.chatId, buildDmMenuCard({ version: bridgeVersion() }), msg.messageId);
      log.info('console', 'menu-sent', { messageId });
    } catch (error) {
      log.fail('console', error, { cmd: 'menu-send' });
    }
  });
}

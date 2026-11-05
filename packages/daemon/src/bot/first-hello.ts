import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppPreferencesWriter } from '../admin/ops';
import { isAdmin, type AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { validateAppCredentials } from '../utils/feishu-auth';

/** A client polling the checklist asks every few seconds; a bot that cannot reach its creator yet tries this often at most. */
export const FIRST_HELLO_RETRY_MS = 60_000;

/** Fixed text, no agent: the provider may not be logged in yet (dm-agent, 第一次见面). */
export const firstHelloText = (botName: string): string => [
  `你好，我是${botName}，有事私聊找我就行。`,
  '你可以让我改在群里的表现，比如"在测试群少说话"；',
  '给我安排事情，比如"每天早上汇总一下这个群"；',
  '也可以就在这里聊，让我查东西、改文档。',
  '要和大家一起做的事，把我拉进群里更合适。',
].join('\n');

/** Who is owed the hello: only a bot registered with the mark has one, and a creator taken off the list is not told to come. */
function recipient(cfg: AppConfig): string | undefined {
  const { firstHelloPending, ownerOpenId } = cfg.preferences?.access ?? {};
  return firstHelloPending && ownerOpenId && isAdmin(cfg, ownerOpenId) ? ownerOpenId : undefined;
}

export interface FirstHelloDeps {
  cfg: AppConfig;
  appSecret: string;
  channel: Pick<LarkChannel, 'rawClient'>;
  /** The bot process's own writer: a second one would not queue behind it. */
  write: AppPreferencesWriter;
  validate?: typeof validateAppCredentials;
  now?: () => number;
}

/**
 * The bot's first private message to its creator, once. `attempt` costs nothing without the mark, never rejects, and
 * leaves the mark in place until the message went out, so any later attempt tries again. Feishu keeps a `uuid` for an
 * hour: a process that dies between sending and writing does not greet twice on its restart.
 */
export function createFirstHello(deps: FirstHelloDeps): { attempt: () => Promise<void>; stop: () => void } {
  const { cfg, channel, write } = deps;
  const { id: appId, tenant } = cfg.accounts.app;
  const validate = deps.validate ?? validateAppCredentials;
  const now = deps.now ?? Date.now;
  let running: Promise<void> | undefined;
  let lastTry = Number.NEGATIVE_INFINITY;
  let sent = false; // a failed write must not send it again
  let stopped = false;

  const send = async (openId: string): Promise<boolean> => {
    // Scopes first: a bot may be able to send long before it can read the answer.
    const status = await validate(appId, deps.appSecret, tenant);
    if (!status.ok || !status.botName || status.missingScopes?.length !== 0 || stopped) return false;
    const reply = await channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: firstHelloText(status.botName) }), uuid: `first-hello-${appId}` } });
    // Not published, or the creator is outside the app's availability: an answer with a code, not always a rejection.
    if (reply.code !== 0) { log.info('setup', 'first-hello-later', { code: reply.code }); return false; }
    return true;
  };
  const run = async (openId: string): Promise<void> => {
    try {
      if (!sent && !await send(openId)) return;
      sent = true;
      await write(preferences => { if (preferences.access) delete preferences.access.firstHelloPending; });
      log.info('setup', 'first-hello-sent', { appId });
    } catch (error) { log.info('setup', 'first-hello-later', { err: String(error) }); }
  };
  return {
    attempt: () => {
      const openId = recipient(cfg);
      if (!openId || stopped) return Promise.resolve();
      if (running) return running;
      if (now() - lastTry < FIRST_HELLO_RETRY_MS) return Promise.resolve();
      lastTry = now();
      running = run(openId).finally(() => { running = undefined; });
      return running;
    },
    stop: () => { stopped = true; },
  };
}

import {join} from 'node:path';
import type {LarkChannel, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {managedToolSelection} from '../agent/codex-appserver/managed-tools';
import {assertBotIdentity, withRegisteredBot, type BotIdentity} from '../config/bots';
import {botPaths, paths} from '../config/paths';
import {isAdmin, isChatAllowed, isUserAllowedInProject, type AppConfig} from '../config/schema';
import {getProjectByChatIdSync, mutateProjectStore} from '../project/registry';
import {configureFeedback} from './config';
import {feedbackActorFromMessage} from './events';
import {NativeFeedbackGateway} from './gateway';
import {createFeedbackHost, type FeedbackHost} from './host';
import {NativeFeedbackIm} from './im';
import {IsolatedFeedbackCli} from './lark-cli';
import {FileFeedbackStore} from './store';

export function bridgeFeedback(identity: BotIdentity, cfg: AppConfig, appSecret: string, channel: LarkChannel): FeedbackHost {
  const selected = managedToolSelection(paths.appDir, 'lark-cli');
  const registration = identity.registrationId;
  const bot = {appId: identity.appId, botId: identity.appId};
  const im = (source?: NormalizedMessage) => new NativeFeedbackIm({client: channel.rawClient, bot,
    privateRecipient: async () => {
      const actor = source?.chatType === 'p2p' && feedbackActorFromMessage(bot, source);
      return actor ? {chatType: 'p2p', actor} : undefined;
    }});
  if (process.platform === 'win32' || !registration || selected.kind !== 'active') {
    const reason = process.platform === 'win32' ? '当前 Windows 版暂不支持反馈所需的多人凭据隔离。'
      : !registration ? '当前 Bot 缺少可核对的注册代次，反馈授权暂不可用。' : '请在工具管理中启用 lark-cli 并重启 Bot，再开始反馈授权。';
    return {enabled: () => false, bind: () => undefined, onAction: async () => {}, close: async () => {},
      async onMessage(message) {
        if (!/^\/feedback(?:\s|$)/.test(message.content.trim())) return false;
        const actor = feedbackActorFromMessage(bot, message);
        if (actor) await im().reply(actor, reason);
        return true;
      }};
  }
  const {dir, projectsFile} = botPaths(identity.appId);
  const root = join(dir, 'feedback');
  const checkBot = async () => {
    await assertBotIdentity(identity);
    const now = managedToolSelection(paths.appDir, 'lark-cli');
    if (now.kind !== 'active' || now.executable !== selected.executable) throw new Error('反馈工具已变更，请重启 Bot 后重试。');
  };
  const cli = new IsolatedFeedbackCli({root: join(root, 'users'), executable: selected.executable,
    credential: async actor => {
      await checkBot();
      if (actor.appId !== identity.appId || actor.botId !== identity.appId) throw new Error('反馈 Bot 身份已变化。');
      return {appId: identity.appId, appSecret, registrationKey: registration};
    }});
  const store = new FileFeedbackStore(join(root, 'operations'));
  return createFeedbackHost({
    root, registration, bot, authorization: cli, store, gateway: new NativeFeedbackGateway(cli, store), checkBot,
    project: chatId => getProjectByChatIdSync(chatId, projectsFile),
    allowed: (project, openId) => isChatAllowed(cfg, project.chatId) && (!openId || isUserAllowedInProject(cfg, project, openId)),
    configure: async (actor, destination, binding) => {
      const admin = () => {
        if (!isAdmin(cfg, actor.openId) || !isChatAllowed(cfg, actor.chatId)) throw new Error('只有群内的 Bot 管理员可以配置。');
      };
      admin();
      await withRegisteredBot(identity.appId, async () => {
        await mutateProjectStore({file: projectsFile, dataRoot: paths.appDir}, async (_, rows) => {
          admin();
          const project = rows.find(row => row.chatId === actor.chatId && !row.dm);
          if (!project) throw new Error('本群已解绑。');
          const prior = project.feedback;
          configureFeedback(project, registration, destination, binding);
          return {changed: prior !== project.feedback, value: undefined};
        }, admin);
      }, identity);
    },
    im,
    download: async (messageId, resource) => {
      const result = await channel.rawClient.im.v1.messageResource.get({
        path: {message_id: messageId, file_key: resource.key}, params: {type: resource.type},
      });
      return result.getReadableStream();
    },
    close: () => cli.close(),
  });
}

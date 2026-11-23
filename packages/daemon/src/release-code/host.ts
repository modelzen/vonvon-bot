import { randomUUID } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { assertBotIdentity, withRegisteredBot, type BotIdentity } from '../config/bots';
import { botPaths, paths } from '../config/paths';
import { isAdmin, isChatAllowed, isUserAllowedInProject, type AppConfig } from '../config/schema';
import { getProjectByChatIdSync, mutateProjectStore, type Project } from '../project/registry';
import { feedbackActorFromMessage } from '../feedback/events';
import { NativeFeedbackIm } from '../feedback/im';
import { CodeAccessError, ReleaseCodeConnections, type ReleaseCodeTool } from './connection';

export interface CodeSource {
  openId: string;
  chatId: string;
  messageId: string;
  call(
    name: ReleaseCodeTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    check: () => void
  ): Promise<string>;
}
export interface ReleaseCodeHost {
  enabled(chatId: string): boolean;
  bind(msg: NormalizedMessage, project: Project): CodeSource | undefined;
  onMessage(msg: NormalizedMessage): Promise<boolean>;
  close(): void;
}
export function codeGroup(project: Project | undefined, registration: string | undefined) {
  const link = project?.releaseCode;
  if (
    project &&
    registration &&
    link?.binding &&
    link.revision &&
    !project.dm &&
    project.enabled !== false &&
    link.registration === registration &&
    link.binding === project.bindingIncarnation
  )
    return link;
}

export function bridgeReleaseCode(identity: BotIdentity, cfg: AppConfig, channel: LarkChannel): ReleaseCodeHost {
  const bot = { appId: identity.appId, botId: identity.appId };
  const { projectsFile } = botPaths(identity.appId);
  const project = (chatId: string) => getProjectByChatIdSync(chatId, projectsFile);
  const registration = identity.registrationId;
  const connections = new ReleaseCodeConnections();
  const im = new NativeFeedbackIm({ client: channel.rawClient, bot, privateRecipient: async () => undefined });
  const principal = (tenant: string, openId: string) => JSON.stringify([registration, bot.appId, tenant, openId]);
  const live = (chatId: string) => isChatAllowed(cfg, chatId) && codeGroup(project(chatId), registration);
  return {
    enabled: (chatId) => Boolean(live(chatId)),
    bind(msg, group) {
      const actor = feedbackActorFromMessage(bot, msg);
      const link = codeGroup(group, registration);
      if (
        !actor ||
        !link ||
        msg.chatType !== 'group' ||
        group.chatId !== msg.chatId ||
        !isUserAllowedInProject(cfg, group, actor.openId)
      )
        return;
      const key = principal(actor.tenantKey, actor.openId);
      return {
        chatId: msg.chatId,
        openId: actor.openId,
        messageId: msg.messageId,
        async call(name, args, signal, checkTurn) {
          const guard = () => {
            checkTurn();
            signal.throwIfAborted();
            const current = project(group.chatId);
            if (
              !current ||
              !isChatAllowed(cfg, current.chatId) ||
              codeGroup(current, registration)?.revision !== link.revision ||
              !isUserAllowedInProject(cfg, current, actor.openId)
            )
              throw new CodeAccessError('本群的代码查阅配置已变化。');
          };
          await assertBotIdentity(identity);
          guard();
          const result = await connections.call(key, name, args, signal, guard);
          await assertBotIdentity(identity);
          guard();
          return result;
        },
      };
    },
    async onMessage(msg) {
      const command = msg.content.trim();
      if (!/^\/feedback code(?:\s|$)/.test(command)) return false;
      const actor = feedbackActorFromMessage(bot, msg);
      if (!actor || msg.rawContentType !== 'text') return true;
      const reply = (text: string) =>
        im.reply(actor, text, () => assertBotIdentity(identity), msg.chatType === 'p2p');
      try {
        await assertBotIdentity(identity);
        if (!registration) throw new CodeAccessError('Bot 需要先完成注册。');
        const key = principal(actor.tenantKey, actor.openId);
        if (msg.chatType === 'p2p') {
          const message =
            command === '/feedback code login'
              ? await connections.begin(key)
              : command === '/feedback code ready'
                ? await connections.finish(key)
                : command === '/feedback code logout'
                  ? await connections.logout(key)
                  : '在本私聊发送 /feedback code login 登录，/feedback code ready 确认，或 /feedback code logout 断开。';
          await reply(message);
          return true;
        }
        if (command !== '/feedback code on' && command !== '/feedback code off') {
          await reply(
            '群管理员可发送 /feedback code on 或 /feedback code off。本人登录请在 Bot 私聊发送 /feedback code login。'
          );
          return true;
        }
        const group = project(actor.chatId);
        if (
          !group ||
          group.dm ||
          !isAdmin(cfg, actor.openId) ||
          !isChatAllowed(cfg, actor.chatId) ||
          !isUserAllowedInProject(cfg, group, actor.openId)
        )
          throw new CodeAccessError('请由本群的 Bot 管理员配置。');
        await withRegisteredBot(
          identity.appId,
          async () => {
            await mutateProjectStore({ file: projectsFile, dataRoot: paths.appDir }, async (_, rows) => {
              const current = rows.find((row) => row.chatId === actor.chatId && !row.dm);
              if (
                !current ||
                current.enabled === false ||
                current.createdAt !== group.createdAt ||
                current.bindingIncarnation !== group.bindingIncarnation ||
                !isAdmin(cfg, actor.openId) ||
                !isChatAllowed(cfg, actor.chatId) ||
                !isUserAllowedInProject(cfg, current, actor.openId)
              )
                throw new CodeAccessError('群绑定或权限已变化，请重新配置。');
              const before = current.releaseCode;
              if (command === '/feedback code off') delete current.releaseCode;
              else if (!codeGroup(current, registration)) {
                current.bindingIncarnation ??= randomUUID();
                current.releaseCode = {
                  binding: current.bindingIncarnation,
                  registration,
                  revision: randomUUID(),
                };
              }
              return { changed: before !== current.releaseCode, value: undefined };
            });
          },
          identity
        );
        await reply(
          command.endsWith(' on')
            ? '本群已启用发布版代码查阅。各使用者请在本人私聊发送 /feedback code login，完成后回本群新话题试查。'
            : '本群已关闭代码查阅。'
        );
      } catch (error) {
        await reply(error instanceof CodeAccessError ? error.message : '代码查阅操作未完成，请稍后再试。');
      }
      return true;
    },
    close: () => connections.close(),
  };
}

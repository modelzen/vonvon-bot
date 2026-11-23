import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {z} from 'zod';
import type {FeedbackSource} from '../agent/entry/feedback-tool';
import type {Project} from '../project/registry';
import {writeFileAtomic} from '../server/atomic-file';
import {directFeedbackAttachments, type FeedbackDownload} from './attachments';
import {FeedbackChatController, feedbackAuthorizationMessage, type FeedbackChatAuthorization, type FeedbackChatIm} from './chat';
import {configuredFeedback, feedbackInstallation, setupDestination, type GroupFeedbackConfig} from './config';
import {feedbackActorFromMessage, feedbackActionFromEvent} from './events';
import {FeedbackSubmissionService} from './service';
import type {FeedbackActor, FeedbackDestination, FeedbackGateway, FeedbackStore} from './types';

export interface FeedbackHost {
  enabled(chatId: string): boolean;
  bind(message: NormalizedMessage, project: Project): FeedbackSource | undefined;
  onMessage(message: NormalizedMessage): Promise<boolean>;
  onAction(event: CardActionEvent): Promise<void>;
  close(): Promise<void>;
}

const slotSchema = z.object({operationId: z.string().uuid(), revision: z.string().uuid(), cardMessageId: z.string().min(1).max(300).optional()}).strict();
interface Dependencies {
  bot: {appId: string; botId: string}; registration: string; root: string;
  project(chatId: string): Project | undefined;
  allowed(project: Project, openId?: string): boolean;
  configure(actor: FeedbackActor, destination: FeedbackDestination, installation: string): Promise<void>;
  checkBot(): Promise<void>;
  im(message?: NormalizedMessage): FeedbackChatIm;
  download: FeedbackDownload;
  authorization: FeedbackChatAuthorization;
  gateway: FeedbackGateway; store: FeedbackStore;
  close(): Promise<void>;
}

/** One bridge owns each registration; the actor slot survives restarts. Only
 * the current slot can confirm, including after a crash while sending a card. */
export function createFeedbackHost(deps: Dependencies): FeedbackHost {
  const service = new FeedbackSubmissionService({gateway: deps.gateway, store: deps.store});
  const lanes = new Map<string, Promise<void>>();
  const lifetime = new AbortController();
  const config = (project?: Project, openId?: string) => project && deps.allowed(project, openId)
    ? configuredFeedback(project, deps.registration) : undefined;
  const controller = (destination: FeedbackDestination, im: FeedbackChatIm) =>
    new FeedbackChatController({bot: deps.bot, destination, im, service, authorization: deps.authorization});
  const running = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  function track<T>(run: () => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted();
    const work = run();
    running.add(work);
    return work.finally(() => running.delete(work));
  }
  function serial<T>(actor: FeedbackActor, fn: (file: string) => Promise<T>): Promise<T> {
    const key = createHash('sha256').update(JSON.stringify([deps.registration, actor.tenantKey, actor.openId, actor.chatId])).digest('hex');
    const work = (lanes.get(key) ?? Promise.resolve()).then(() => fn(join(deps.root, 'reviews', key + '.json')));
    const tail = work.then(() => {}, () => {}).finally(() => {if (lanes.get(key) === tail) lanes.delete(key);});
    lanes.set(key, tail);
    return work;
  }
  async function readSlot(file: string) {
    try {return slotSchema.parse(JSON.parse(await readFile(file, 'utf8')));}
    catch (error) {if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error;}
  }
  function checkConfig(actor: FeedbackActor, expected: GroupFeedbackConfig) {
    lifetime.signal.throwIfAborted();
    if (!isDeepStrictEqual(config(deps.project(actor.chatId), actor.openId), expected)) throw new Error('反馈配方或目标已变化，请重新发起。');
  }
  return {
    enabled(chatId) {return !lifetime.signal.aborted && !!config(deps.project(chatId));},
    bind(message, project) {
      const actor = feedbackActorFromMessage(deps.bot, message);
      const saved = actor && config(project, actor.openId);
      if (lifetime.signal.aborted || !actor || !saved || message.chatType !== 'group' || project.chatId !== actor.chatId
        || !['text', 'post', 'file', 'image'].includes(message.rawContentType)) return;
      const attachments = directFeedbackAttachments(message);
      return {chatId: actor.chatId, openId: actor.openId, messageId: actor.messageId, attachments: attachments.refs,
        prepare(input, signal, checkTurn) {
          return track(() => serial(actor, async file => {
            const stop = AbortSignal.any([signal, lifetime.signal]);
            const check = async () => {
              await deps.checkBot();
              stop.throwIfAborted();
              checkTurn();
              checkConfig(actor, saved);
            };
            await check();
            const previous = await readSlot(file);
            if (previous) {
              const current = await deps.store.read(previous.operationId);
              if (current.state === 'sending' || current.state === 'uncertain') throw new Error('之前的反馈仍在核实，请在原卡片查询回执。');
            }
            return attachments.withFiles(input.attachmentRefs, deps.root, deps.download, stop, async paths => {
              await check();
              return controller(saved.destination, deps.im()).prepare(message, input.summary, paths, {
                async beforeReview(operationId) {
                  await check();
                  if (previous && (await deps.store.read(previous.operationId)).state === 'prepared')
                    await service.cancel({actor, operationId: previous.operationId});
                  await writeFileAtomic(file, JSON.stringify({operationId, revision: saved.revision}), {durable: true});
                },
                async delivered(operationId, cardMessageId) {
                  await writeFileAtomic(file, JSON.stringify({operationId, revision: saved.revision, cardMessageId}), {durable: true});
                }, check,
              });
            });
          }));
        },
      };
    },
    async onMessage(message) {
      const command = message.content.trim();
      if (!/^\/feedback(?:\s|$)/.test(command)) return false;
      if (message.rawContentType !== 'text') return true;
      const actor = feedbackActorFromMessage(deps.bot, message);
      if (!actor) return true;
      const installation = message.chatType === 'group' && command.startsWith('/feedback setup')
        ? feedbackInstallation(deps.project(actor.chatId)) : undefined;
      await track(async () => {
        const im = deps.im(message);
        try {
          await deps.checkBot();
          if (command === '/feedback authorize' || command === '/feedback authorized') {
            await feedbackAuthorizationMessage(command, message, actor, deps.authorization, im);
          } else if (message.chatType === 'group' && /^\/feedback setup(?:\s|$)/.test(command)) {
            const destination = setupDestination(command);
            if (!destination) {await im.reply(actor, '用法：/feedback setup <含 table 的飞书 Base 链接> <飞书表单分享链接>'); return;}
            if (!installation) {await im.reply(actor, '请先安装反馈配方并启用本群。'); return;}
            await deps.configure(actor, destination, installation);
            await im.reply(actor, '本群已配置反馈接收目标。成员可在本人私聊发送 /feedback authorize。');
          } else {
            const current = config(deps.project(actor.chatId), actor.openId);
            if (current) await controller(current.destination, im).onMessage(message);
            else await im.reply(actor, '请让管理员在安装反馈配方的群聊中配置接收目标。');
          }
        } catch {await im.reply(actor, '反馈操作未完成。请核对本 Bot 的配置、群配方及管理员权限。');}
      });
      return true;
    },
    async onAction(event) {
      const action = feedbackActionFromEvent(deps.bot, event);
      if (!action) return;
      const {botId, appId, tenantKey, openId, chatId} = action.confirmation;
      const actor = {botId, appId, tenantKey, openId, chatId, messageId: action.messageId};
      await track(() => serial(actor, async file => {
        const im = deps.im();
        try {
          const slot = await readSlot(file);
          const saved = config(deps.project(chatId), openId);
          if (!saved || !slot || slot.operationId !== action.confirmation.operationId || slot.revision !== saved.revision || slot.cardMessageId !== event.messageId) throw new Error('Expired');
          const operation = await deps.store.read(slot.operationId);
          if (!isDeepStrictEqual(operation.draft.destination, saved.destination)) throw new Error('Destination changed');
          const check = async () => {await deps.checkBot(); checkConfig(actor, saved);};
          await check();
          await controller(saved.destination, im).onAction(event, check);
        } catch {await im.reply(actor, '这张反馈卡片已失效或不属于你，请回到原聊天核对。');}
      }));
    },
    close() {
      if (!closing) {
        lifetime.abort();
        closing = Promise.allSettled([deps.close(), ...running]).then(([cleanup]) => {
          if (cleanup?.status === 'rejected') throw cleanup.reason;
        });
      }
      return closing;
    },
  };
}

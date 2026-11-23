import type {LarkChannel} from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import {z} from 'zod';
import type {FeedbackChatIm} from './chat.js';
import {feedbackActorSchema, type FeedbackActor} from './types.js';

type RawClient = LarkChannel['rawClient'];
type MessageApi = RawClient['im']['v1']['message'];
type ImageApi = RawClient['im']['v1']['image'];
type CardApi = RawClient['cardkit']['v1']['card'];

/** Actual SDK request types, with untrusted responses parsed at this boundary. */
export interface FeedbackImClient {
  im: {v1: {
    message: {
      get(request: Parameters<MessageApi['get']>[0]): Promise<unknown>;
      reply(request: Parameters<MessageApi['reply']>[0]): Promise<unknown>;
    };
    image: {create(request: Parameters<ImageApi['create']>[0]): Promise<unknown>};
  }};
  cardkit: {v1: {card: {create(request: Parameters<CardApi['create']>[0]): Promise<unknown>}}};
}

const privateRecipientSchema = z.object({actor: feedbackActorSchema, chatType: z.literal('p2p')}).strict();
export type FeedbackPrivateRecipient = z.infer<typeof privateRecipientSchema>;
const botSchema = feedbackActorSchema.pick({botId: true, appId: true});
const identifier = z.string().min(1).max(300);
const messageSchema = z.object({
  message_id: identifier, chat_id: identifier, deleted: z.boolean().optional(),
  sender: z.object({id: identifier, id_type: z.string(), sender_type: z.string(), tenant_key: z.string().optional()}).optional(),
});
const messagesSchema = z.object({code: z.literal(0), data: z.object({items: z.array(messageSchema)})});
const replySchema = z.object({code: z.literal(0), data: z.object({message_id: identifier, chat_id: identifier, deleted: z.boolean().optional()})});
const cardSchema = z.object({code: z.literal(0), data: z.object({card_id: identifier})});
const uploadedImageSchema = z.union([
  z.object({image_key: identifier}).strict(),
  z.object({code: z.literal(0), data: z.object({image_key: identifier})}).transform(value => value.data),
]);

export class NativeFeedbackIm implements FeedbackChatIm {
  private readonly bot: z.infer<typeof botSchema>;
  constructor(private readonly options: {
    client: FeedbackImClient;
    bot: z.infer<typeof botSchema>;
    /** Host verifies a real SDK p2p event or platform query. No account/admin binding is required. */
    privateRecipient: (actor: FeedbackActor) => Promise<FeedbackPrivateRecipient | undefined>;
  }) {
    this.bot = botSchema.parse(options.bot);
  }

  private actor(input: FeedbackActor): FeedbackActor {
    const actor = feedbackActorSchema.parse(input);
    if (actor.botId !== this.bot.botId || actor.appId !== this.bot.appId || actor.chatId.startsWith('oc_dm_')) throw new Error('Invalid actor');
    return actor;
  }

  private async verifyMessage(actor: FeedbackActor, author = false): Promise<void> {
    const result = messagesSchema.parse(await this.options.client.im.v1.message.get({
      path: {message_id: actor.messageId}, params: {user_id_type: 'open_id'},
    }));
    const matching = result.data.items.filter(item => item.message_id === actor.messageId);
    const source = matching[0];
    if (matching.length !== 1 || !source || source.chat_id !== actor.chatId || source.deleted) throw new Error('Invalid source chat');
    if (author && (!source.sender || source.sender.id !== actor.openId || source.sender.id_type !== 'open_id' || source.sender.sender_type !== 'user' ||
      (source.sender.tenant_key !== undefined && source.sender.tenant_key !== actor.tenantKey))) throw new Error('Invalid private author');
  }

  private async send(actor: FeedbackActor, msgType: 'text' | 'interactive' | 'image', content: object): Promise<string> {
    const data = {msg_type: msgType, content: JSON.stringify(content)};
    if (Buffer.byteLength(JSON.stringify(data)) > 30000) throw new Error('Message too large');
    const result = replySchema.parse(await this.options.client.im.v1.message.reply({path: {message_id: actor.messageId}, data}));
    if (result.data.chat_id !== actor.chatId || result.data.deleted || result.data.message_id === actor.messageId) throw new Error('Invalid delivery');
    return result.data.message_id;
  }

  async reply(input: FeedbackActor, text: string): Promise<void> {
    try {
      const actor = this.actor(input);
      await this.verifyMessage(actor);
      await this.send(actor, 'text', {text: z.string().min(1).parse(text)});
    } catch {throw new Error('反馈消息尚未确认送达，请稍后重试。');}
  }

  async review(input: FeedbackActor, body: Parameters<FeedbackChatIm['review']>[1], beforeSend?: () => Promise<void>): Promise<string> {
    try {
      const actor = this.actor(input);
      const data = {type: 'card_json', data: JSON.stringify(body)};
      if (Buffer.byteLength(JSON.stringify(data)) > 30000) throw new Error('Card too large');
      await this.verifyMessage(actor);
      const created = cardSchema.parse(await this.options.client.cardkit.v1.card.create({data}));
      await beforeSend?.();
      return await this.send(actor, 'interactive', {type: 'card', data: {card_id: created.data.card_id}});
    } catch {throw new Error('反馈核对卡片尚未确认送达，请稍后重试。');}
  }

  async authorization(input: FeedbackActor, verificationUrl: string, _unusedQrPath: string): Promise<void> {
    try {
      const actor = this.actor(input);
      const recipient = privateRecipientSchema.parse(await this.options.privateRecipient(actor));
      for (const field of feedbackActorSchema.keyof().options) {
        if (recipient.actor[field] !== actor[field]) throw new Error('Invalid private recipient');
      }
      await this.verifyMessage(actor, true);
      const url = new URL(z.string().max(4096).parse(verificationUrl));
      if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error('Invalid authorization URL');
      const bytes = await QRCode.toBuffer(verificationUrl);
      await this.send(actor, 'text', {text: '请用本人飞书账号打开以下链接完成授权：\n' + verificationUrl});
      const uploaded = uploadedImageSchema.parse(await this.options.client.im.v1.image.create({data: {image_type: 'message', image: bytes}}));
      await this.send(actor, 'image', {image_key: uploaded.image_key});
    } catch {throw new Error('授权入口未能在本人私聊安全展示，请稍后重试。');}
  }
}

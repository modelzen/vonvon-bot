import { isDeepStrictEqual } from 'node:util';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { CandidateCardDetails } from './draft-instruction';
import { button, card, md } from '../card/cards';

export const AUTHORING_ACTION = 'recipe.authoring';
export type CardMode = 'prepare' | 'edit' | 'confirm' | 'pending' | 'saved' | 'cancelled' | 'expired' | 'review';
const copy: Record<CardMode, string> = {
  prepare: '已在 App 选好群角色。确认后保存为私人草稿。',
  edit: '在此私聊发送 /recipe name 名称、/recipe summary 简介、/recipe overview 概览、/recipe version 版本、/recipe role 角色或 /recipe setup 步骤 JSON。',
  confirm: '有一份草稿改动等待确认。可在 App 核对完整内容。',
  pending: '已确认，正在等待 App 同步。', saved: '私人草稿已保存。可以在 App 查看或继续编辑。',
  cancelled: '已取消本次草稿操作。', expired: '这次操作已到期。若之前已经保存，请到 App 创作中心查看。',
  review: '来源或授权已经改变，请回到 App 核对。',
};
export function authoringCard(ref: string, mode: CardMode, details?: CandidateCardDetails) {
  const action = (verb: string, label: string, primary = false) => button(label, {a: AUTHORING_ACTION, ref, verb}, primary ? 'primary' : 'default');
  const elements = [md(copy[mode])];
  if (mode === 'confirm' && details) elements.push(md('将修改第 '+details.revision+' 次修订中的'+details.fields.join('、')+'。'));
  if (mode === 'prepare' || mode === 'confirm') elements.push(action('confirm', mode === 'prepare' ? '生成私人草稿' : '保存到草稿', true));
  if (['prepare','edit','confirm','pending','review'].includes(mode)) elements.push(action('cancel', '取消'));
  return card(elements, {header: {title: '配方草稿'}, forward: false});
}
export const physicalChat = (id: string): boolean => /^oc_[a-zA-Z0-9_-]{1,200}$/.test(id) && !id.startsWith('oc_dm_');

export class AuthoringIm {
  constructor(private readonly channel: LarkChannel) {}
  private async createJson(body: object): Promise<string> {
    const result = await this.channel.rawClient.cardkit.v1.card.create({
      data: {type: 'card_json', data: JSON.stringify(body)},
    });
    if (result.code !== 0 || !result.data?.card_id) throw new Error('私聊卡片创建失败。');
    return result.data.card_id;
  }
  create(ref: string, mode: CardMode, details?: CandidateCardDetails) { return this.createJson(authoringCard(ref,mode,details)); }
  sourceMenu(ref: string, count: number) {
    const elements = [md('请选择已在 App 核对的来源。点击后，Bot 会为该来源准备私人草稿。要查看群名或选择其他群，请到 App。')];
    for (let index = 0; index < count; index++) {
      elements.push(button('使用来源 '+(index+1), {a:AUTHORING_ACTION,ref,verb:'source',index}));
    }
    return this.createJson(card(elements, {header:{title:'选择配方来源'},forward:false}));
  }
  async send(chatId: string, cardId: string, uuid: string): Promise<string> {
    if (!physicalChat(chatId)) throw new Error('需要真实私聊。');
    const result = await this.channel.rawClient.im.v1.message.create({
      params: {receive_id_type: 'chat_id'},
      data: {receive_id: chatId, msg_type: 'interactive', content: JSON.stringify({type: 'card', data: {card_id: cardId}}), uuid},
    });
    const id = result.data?.message_id;
    if (result.code !== 0 || !id || (result.data?.chat_id !== chatId && !await this.matches(id, chatId, cardId))) throw new Error('尚无法核实卡片送达。');
    return id;
  }
  async matches(messageId: string, chatId: string, cardId: string): Promise<boolean> {
    const result = await this.channel.rawClient.im.v1.message.get({path: {message_id: messageId}});
    const item = result.data?.items?.find(row => row.message_id === messageId && row.chat_id === chatId && row.msg_type === 'interactive' && !row.deleted);
    if (result.code !== 0 || !item) return false;
    const converted = await this.channel.rawClient.cardkit.v1.card.idConvert({data: {message_id: messageId}});
    return converted.code === 0 && converted.data?.card_id === cardId;
  }
  async update(cardId: string, seq: number, ref: string, mode: CardMode, details?: CandidateCardDetails) {
    let code: number | undefined;
    try {
      const result = await this.channel.rawClient.cardkit.v1.card.update({path: {card_id: cardId}, data: {
        sequence: seq, uuid: 'a_' + seq + '_' + ref, card: {type: 'card_json', data: JSON.stringify(authoringCard(ref, mode, details))},
      }});
      code = result.code;
    } catch (error) {
      code = (error as {response?: {data?: {code?: number}}} | null)?.response?.data?.code;
    }
    if (code === 0) return 'updated';
    if (code === 200740 || code === 200750) return 'unavailable';
    if (code === 200770 || code === 300317) return 'conflict';
    return 'pending';
  }
  async shows(messageId: string, chatId: string, ref: string, mode: CardMode, details?: CandidateCardDetails) {
    const result = await this.channel.rawClient.im.v1.message.get({path:{message_id:messageId}, params:{card_msg_content_type:'user_card_content'}});
    const item = result.data?.items?.find(m => m.message_id === messageId && m.chat_id === chatId && m.msg_type === 'interactive' && !m.deleted);
    const content = item?.body?.content;
    return result.code === 0 && !!content && isDeepStrictEqual(JSON.parse(content),authoringCard(ref,mode,details));
  }
  async reply(chatId: string, messageId: string, text: string) {
    await this.channel.send(chatId, {text}, {replyTo: messageId}).catch(() => undefined);
  }
}

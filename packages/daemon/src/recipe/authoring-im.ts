import { isDeepStrictEqual } from 'node:util';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { CandidateCardDetails } from './draft-instruction';
import { button, card, md, type CardElement } from '../card/cards';

export const AUTHORING_ACTION = 'recipe.authoring';
export type CardMode = 'prepare' | 'richEdit' | 'edit' | 'confirm' | 'pending' | 'saved' | 'cancelled' | 'expired' | 'review';
export interface RichEditCardContext {labels:string[];example?:string}
const copy: Record<CardMode, string> = {
  richEdit:'直接回复希望如何修改本次选中的内容。候选会先显示在确认卡中，确认后才保存。',
  prepare: '已在 App 选好群角色。确认后保存为私人草稿。',
  edit: '在此私聊发送 /recipe name 名称、/recipe summary 简介、/recipe overview 概览、/recipe version 版本或 /recipe role 角色。需要运行 setup 时，请把说明写在概览中。',
  confirm: '请核对每个字段的实际新值。模型可能理解有误，确认后才保存到私人草稿。',
  pending: '已确认，正在等待 App 同步。', saved: '私人草稿已保存。可以在 App 查看或继续编辑。',
  cancelled: '已取消本次草稿操作。', expired: '这次操作已到期。若之前已经保存，请到 App 创作中心查看。',
  review: '来源或授权已经改变，请回到 App 核对。',
};
const plain = (content: string) => ({tag:'div', text:{tag:'plain_text',content}});
const action = (ref: string, verb: string, label: string, primary = false) => button(label, {a: AUTHORING_ACTION, ref, verb}, primary ? 'primary' : 'default');
const authoringBody = (elements: CardElement[]) => card(elements, {header:{title:'配方草稿'},forward:false});
export function candidateConfirmation(ref: string, details?: CandidateCardDetails) {
  if (!details) return;
  const readable=(text:string)=>text.replace(/[⟦⟧\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
    char=>char==='\n'?char:'⟦U+'+char.codePointAt(0)!.toString(16).toUpperCase().padStart(4,'0')+'⟧');
  const fields=[];
  for(const field of details.fields){
    let text=field.text;
    if(text===undefined){
      try{const value:unknown=JSON.parse(field.valueJson);if(typeof value!=='string')return;text=value;}catch{return;}
    }
    fields.push(plain(readable(field.label)+' → '+readable(text)));
  }
  const elements = [plain(details.sourceCapture?'仅保存私人草稿。完整内容在 App 核对，发布前再次确认。':copy.confirm),
    plain(details.sourceCapture?'本次保存你刚选中的本地内容快照。':'第 '+details.revision+' 次修订。请核对以下完整新值。'),
    ...fields, action(ref,'confirm','保存到草稿',true), action(ref,'cancel','取消')];
  const body = authoringBody(elements), data = JSON.stringify(body);
  // CardKit recommends 30 KB. Budget both serialized request envelopes, including JSON escapes.
  const create = {type:'card_json',data};
  const update = {sequence:Number.MAX_SAFE_INTEGER,uuid:'a_'+Number.MAX_SAFE_INTEGER+'_'+ref,card:create};
  if (Math.max(Buffer.byteLength(JSON.stringify(create)),Buffer.byteLength(JSON.stringify(update))) > 30_000) return;
  return body;
}
export function authoringCard(ref: string, mode: CardMode, details?: CandidateCardDetails, editing?:RichEditCardContext) {
  if (mode === 'confirm') return candidateConfirmation(ref,details) ?? authoringBody([
    plain('本次改动无法在卡片完整、安全地展示，不能在这里确认。请取消后发送更小的修改；名称、简介、概览和版本也可以在 App 编辑。'), action(ref,'cancel','取消'),
  ]);
  const introduction=mode==='richEdit'&&editing ? '本次可修改：'+(editing.labels.join('、')||'已选内容')+'。\n'+copy.richEdit+
    (editing.example?'\n也可以发送 '+editing.example+'。':'') : copy[mode];
  const elements = [md(introduction)];
  if (mode === 'prepare') elements.push(action(ref,'confirm','生成私人草稿',true));
  if (['prepare','edit','richEdit','pending','review'].includes(mode)) elements.push(action(ref,'cancel','取消'));
  return authoringBody(elements);
}

export const physicalChat = (id: string): boolean => /^oc_[a-zA-Z0-9_-]{1,200}$/.test(id) && !id.startsWith('oc_dm_');

export class AuthoringIm {
  constructor(private readonly channel: LarkChannel) {}
  async createJson(body: object): Promise<string> {
    const result = await this.channel.rawClient.cardkit.v1.card.create({
      data: {type: 'card_json', data: JSON.stringify(body)},
    });
    if (result.code !== 0 || !result.data?.card_id) throw new Error('私聊卡片创建失败。');
    return result.data.card_id;
  }
  create(ref: string, mode: CardMode, details?: CandidateCardDetails, editing?:RichEditCardContext) { return this.createJson(authoringCard(ref,mode,details,editing)); }
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
  async update(cardId: string, seq: number, ref: string, mode: CardMode, details?: CandidateCardDetails, editing?:RichEditCardContext) {
    return this.updateJson(cardId,seq,ref,authoringCard(ref,mode,details,editing));
  }
  async updateJson(cardId:string,seq:number,ref:string,body:object){
    let code: number | undefined;
    try {
      const result = await this.channel.rawClient.cardkit.v1.card.update({path: {card_id: cardId}, data: {
        sequence: seq, uuid: 'a_' + seq + '_' + ref, card: {type: 'card_json', data: JSON.stringify(body)},
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
  async shows(messageId: string, chatId: string, ref: string, mode: CardMode, details?: CandidateCardDetails, editing?:RichEditCardContext) {
    return this.showsJson(messageId,chatId,authoringCard(ref,mode,details,editing));
  }
  async showsJson(messageId:string,chatId:string,body:object){
    const result = await this.channel.rawClient.im.v1.message.get({path:{message_id:messageId}, params:{card_msg_content_type:'user_card_content'}});
    const item = result.data?.items?.find(m => m.message_id === messageId && m.chat_id === chatId && m.msg_type === 'interactive' && !m.deleted);
    const content = item?.body?.content;
    return result.code === 0 && !!content && isDeepStrictEqual(JSON.parse(content),body);
  }
  async reply(chatId: string, messageId: string, text: string) {
    await this.channel.send(chatId, {text}, {replyTo: messageId}).catch(() => undefined);
  }
}

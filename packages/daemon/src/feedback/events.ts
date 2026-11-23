import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {z} from 'zod';
import {feedbackActorSchema, feedbackConfirmationSchema, type FeedbackActor, type FeedbackConfirmation} from './types.js';

export const FEEDBACK_ACTION = 'feedback.submission';
const botSchema = feedbackActorSchema.pick({botId: true, appId: true});
const messageSchema = z.object({
  sender: z.object({sender_type: z.literal('user'), tenant_key: z.string().min(1), sender_id: z.object({open_id: z.string()})}),
  message: z.object({message_id: z.string(), chat_id: z.string(), chat_type: z.enum(['p2p', 'group'])}),
});
const actionSchema = z.object({
  a: z.literal(FEEDBACK_ACTION), operationId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  verb: z.enum(['confirm', 'cancel', 'reconcile']),
}).strict();
const operatorSchema = z.object({
  operator: z.object({open_id: z.string(), tenant_key: z.string().min(1)}),
  context: z.object({open_chat_id: z.string().optional(), open_message_id: z.string().optional()}).optional(),
});

/** Call only with the host's SDK event, never tool/model-supplied JSON. */
export function feedbackActorFromMessage(bot: z.infer<typeof botSchema>, message: NormalizedMessage): FeedbackActor | undefined {
  const raw = messageSchema.safeParse(message.raw).data;
  if (!raw || raw.sender.sender_id.open_id !== message.senderId || raw.message.chat_id !== message.chatId ||
      raw.message.message_id !== message.messageId || raw.message.chat_type !== message.chatType || message.chatId.startsWith('oc_dm_')) return;
  return feedbackActorSchema.safeParse({...botSchema.parse(bot), tenantKey: raw.sender.tenant_key,
    openId: message.senderId, chatId: message.chatId, messageId: message.messageId}).data;
}

export interface FeedbackTrustedAction {
  verb: z.infer<typeof actionSchema>['verb'];
  confirmation: FeedbackConfirmation;
  messageId: string;
}

/** Host dispatcher must verify the callback came from its registered Bot. */
export function feedbackActionFromEvent(bot: z.infer<typeof botSchema>, event: CardActionEvent): FeedbackTrustedAction | undefined {
  const action = actionSchema.safeParse(event.action.value).data;
  const raw = operatorSchema.safeParse(event.raw).data;
  if (!action || !raw || event.operator.openId !== raw.operator.open_id || event.chatId.startsWith('oc_dm_') ||
      !event.messageId || (raw.context?.open_chat_id && raw.context.open_chat_id !== event.chatId) ||
      (raw.context?.open_message_id && raw.context.open_message_id !== event.messageId)) return;
  const confirmation = feedbackConfirmationSchema.safeParse({...botSchema.parse(bot), tenantKey: raw.operator.tenant_key,
    openId: event.operator.openId, chatId: event.chatId, operationId: action.operationId, digest: action.digest}).data;
  return confirmation ? {verb: action.verb, confirmation, messageId: event.messageId} : undefined;
}

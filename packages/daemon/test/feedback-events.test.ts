import {randomUUID} from 'node:crypto';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {describe, expect, it} from 'vitest';
import {feedbackActionFromEvent, feedbackActorFromMessage, FEEDBACK_ACTION} from '../src/feedback/events.js';
import {feedbackReviewCard} from '../src/feedback/cards.js';
import type {FeedbackReview} from '../src/feedback/types.js';

const bot = {botId: 'bot-1', appId: 'cli_feedback'};
function message(): NormalizedMessage {
  return {messageId: 'om_source', chatId: 'oc_group', chatType: 'group', senderId: 'ou_author', senderName: '同名用户',
    content: '请提交反馈', rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: 1,
    raw: {sender: {sender_type: 'user', tenant_key: 'tenant', sender_id: {open_id: 'ou_author'}},
      message: {message_id: 'om_source', chat_id: 'oc_group', chat_type: 'group'}}};
}
function event(): CardActionEvent {
  return {messageId: 'om_card', chatId: 'oc_group', operator: {openId: 'ou_author', name: '同名用户'},
    action: {tag: 'button', value: {a: FEEDBACK_ACTION, verb: 'confirm', operationId: randomUUID(), digest: 'a'.repeat(64)}},
    raw: {operator: {open_id: 'ou_author', tenant_key: 'tenant'}, context: {open_chat_id: 'oc_group', open_message_id: 'om_card'}}};
}
describe('trusted feedback events', () => {
  it('takes identity from the actual SDK message and ignores the display name', () => {
    expect(feedbackActorFromMessage(bot, message())).toEqual({...bot, tenantKey: 'tenant', openId: 'ou_author', chatId: 'oc_group', messageId: 'om_source'});
  });
  it.each(['sender', 'chat', 'message', 'type', 'raw'])('rejects mismatched or missing SDK provenance: %s', change => {
    const msg = message();
    if (change === 'sender') msg.senderId = 'ou_other';
    if (change === 'chat') msg.chatId = 'oc_other';
    if (change === 'message') msg.messageId = 'om_other';
    if (change === 'type') msg.chatType = 'p2p';
    if (change === 'raw') msg.raw = undefined;
    expect(feedbackActorFromMessage(bot, msg)).toBeUndefined();
  });
  it('binds the actual card operator rather than a name or actor in its value', () => {
    const parsed = feedbackActionFromEvent(bot, event());
    expect(parsed?.confirmation).toMatchObject({...bot, tenantKey: 'tenant', openId: 'ou_author', chatId: 'oc_group'});
    expect(parsed?.messageId).toBe('om_card');
  });
  it.each(['operator', 'chat', 'message', 'payload-actor', 'namespace', 'synthetic-chat'])('rejects inconsistent callbacks: %s', change => {
    const evt = event();
    if (change === 'operator') evt.operator.openId = 'ou_other';
    if (change === 'chat') evt.chatId = 'oc_other';
    if (change === 'message') evt.messageId = 'om_other';
    if (change === 'payload-actor') evt.action.value = {a: FEEDBACK_ACTION, verb: 'confirm', operationId: randomUUID(), digest: 'a'.repeat(64), openId: 'ou_author'};
    if (change === 'namespace') evt.action.value = {a: 'recipe.authoring', verb: 'confirm', ref: randomUUID()};
    if (change === 'synthetic-chat') evt.chatId = 'oc_dm_synthetic';
    expect(feedbackActionFromEvent(bot, evt)).toBeUndefined();
  });
});

function review(): FeedbackReview {
  return {operationId: randomUUID(), trackingCode: 'VV-0123456789ABCDEF', digest: 'a'.repeat(64), accountName: '同名用户', title: '无法发送图片',
    summary: {kind: 'bug', title: '无法发送图片', description: '<at id=all>截图发送失败', steps: '选择图片后发送', expected: '能发送', environment: 'macOS', impact: '部分受影响', areas: ['聊天与消息']},
    attachments: [{filename: '截图.png', bytes: 100}], expiresAt: 1000};
}
describe('feedback review card', () => {
  it('shows every reviewed value and attachment, using plain text for user content', () => {
    const content = JSON.stringify(feedbackReviewCard(review()));
    for (const text of ['同名用户', 'VV-0123456789ABCDEF', '<at id=all>截图发送失败', '选择图片后发送', '截图.png', '确认提交', '取消']) expect(content).toContain(text);
    expect(content).toContain('plain_text');
    expect(content).not.toContain('"tag":"markdown"');
  });
  it('shows every populated detail in full and omits absent ones', () => {
    const data = review();
    const details = {checks: '第一行\n第二行', sourceEvidence: '0.10.1 packages/ui/src/app.ts:33 路由匹配',
      openQuestions: '另一个设备待复验', useCase: '群讨论后整理', acceptanceCriteria: '切换后保留选择'};
    const body = feedbackReviewCard({...data, summary: {...data.summary, ...details}});
    const text = JSON.stringify(body);
    for (const [index, label] of ['排查记录','源码依据','待验证问题','使用场景与现有做法','验收标准'].entries()) {
      expect(text).toContain(JSON.stringify(label + '\n' + Object.values(details)[index]));
    }
    expect(JSON.stringify(feedbackReviewCard(data))).not.toContain('待验证问题');
  });

  it('refuses confirmation if the complete reviewed content cannot fit the card', () => {
    const input = review();
    input.summary.description = '图片'.repeat(15000);
    expect(feedbackReviewCard(input)).toBeUndefined();
  });
});

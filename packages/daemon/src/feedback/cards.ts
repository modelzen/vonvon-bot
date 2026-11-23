import {button, card, type CardElement} from '../card/cards.js';
import {FEEDBACK_ACTION} from './events.js';
import type {FeedbackReview} from './types.js';

const plain = (content: string): CardElement => ({tag: 'div', text: {tag: 'plain_text', content}});
const kinds = {bug: '问题反馈', feature: '功能建议', improvement: '体验优化'};

/** A confirmation may never show a shortened version of the actual payload. */
export function feedbackReviewCard(review: FeedbackReview) {
  const summary = review.summary;
  const action = (verb: 'confirm' | 'cancel', label: string) => button(label,
    {a: FEEDBACK_ACTION, operationId: review.operationId, digest: review.digest, verb}, verb === 'confirm' ? 'primary' : 'default');
  const elements = [plain('请核对以下完整内容。确认后以你的飞书账号提交，所有能访问反馈空间的人都可以看到。'),
    plain('提交账号：' + review.accountName + '\n跟进编号：' + review.trackingCode),
    plain('标题：' + summary.title + '\n类型：' + kinds[summary.kind]),
    plain('详细说明\n' + summary.description),
    ...(summary.steps ? [plain('如何重现\n' + summary.steps)] : []),
    ...(summary.expected ? [plain('期望效果\n' + summary.expected)] : []),
    ...(summary.environment ? [plain('使用环境\n' + summary.environment)] : []),
    plain('影响程度：' + (summary.impact ?? '未说明') + '\n涉及功能：' + (summary.areas.join('、') || '未说明')),
    plain('附件：' + (review.attachments.map(file => `${file.filename}（${file.bytes} 字节）`).join('\n') || '无')),
    plain('只会提交这里列出的摘要和附件。修改内容后需要重新核对；截图请先确认已隐藏私人信息。'),
    action('confirm', '确认提交'), action('cancel', '取消')];
  const body = card(elements, {header: {title: '核对这条反馈'}, forward: false});
  const envelope = {type: 'card_json', data: JSON.stringify(body)};
  if (Buffer.byteLength(JSON.stringify(envelope)) > 28000) return;
  return body;
}

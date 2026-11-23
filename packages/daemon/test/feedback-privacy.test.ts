import {describe, expect, it} from 'vitest';
import {assertFeedbackAttachmentPrivacy, assertFeedbackTextPrivacy, FeedbackPrivacyError} from '../src/feedback/privacy.js';
import {feedbackSummarySchema} from '../src/feedback/types.js';

describe('public feedback privacy', () => {
  it('reports the field to redact without echoing private material', () => {
    for (const [field, value] of [
      ['title', '无法打开 /Users/someone/config'], ['description', '账户名：test@example.net'],
      ['checks', 'Bearer examplePrivateBearer'], ['useCase', '手机号 13900000001'],
      ['openQuestions', 'C:\\Users\\tester\\AppData'], ['sourceEvidence', '群 oc_' + 'a'.repeat(32)],
      ['acceptanceCriteria', 'refresh_token=exampleTestToken'],
    ]) {
      const report = feedbackSummarySchema.parse({kind: 'bug', title: '群消息', description: '操作现象', [field!]: value});
      expect(() => assertFeedbackTextPrivacy(report)).toThrow(FeedbackPrivacyError);
      try { assertFeedbackTextPrivacy(report); } catch (e) { expect((e as Error).message).not.toContain(value); }
    }
  });
  it('accepts public source locations and a commit ID', () => {
    const report = feedbackSummarySchema.parse({kind: 'bug', title: '群模式', description: '版本 0.10.1',
      sourceEvidence: '6405ff097b67af73e773858631ca373b707546d2 packages/daemon/src/project/registry.ts:201 绑定时按会话模式设置免 @。'});
    expect(() => assertFeedbackTextPrivacy(report, ['群设置.png'])).not.toThrow();
  });
  it('checks selected text files at chunk boundaries and credential filenames', () => {
    const b = Buffer.from(' '.repeat(16_380) + 'Bearer examplePrivateBearer');
    expect(() => assertFeedbackAttachmentPrivacy('脱敏日志.txt', b)).toThrow(FeedbackPrivacyError);
    const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('test@example.net', 'utf16le')]);
    expect(() => assertFeedbackAttachmentPrivacy('日志.txt', utf16)).toThrow(FeedbackPrivacyError);
    expect(() => assertFeedbackAttachmentPrivacy('.env.local', Buffer.from('setting'))).toThrow(FeedbackPrivacyError);
    expect(() => assertFeedbackAttachmentPrivacy('test@example.net.png', Buffer.from([0, 255]))).toThrow(FeedbackPrivacyError);
    expect(() => assertFeedbackAttachmentPrivacy('重现步骤.txt', Buffer.from('群里发起新话题'))).not.toThrow();
  });
});

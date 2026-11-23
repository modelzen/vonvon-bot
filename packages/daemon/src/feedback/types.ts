import {z} from 'zod';

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const person = {
  botId: identifier,
  appId: z.string().regex(/^cli_[a-zA-Z0-9_-]+$/),
  tenantKey: identifier,
  openId: z.string().regex(/^ou_[a-zA-Z0-9_-]+$/),
};

export const feedbackActorSchema = z.object({
  ...person,
  chatId: z.string().regex(/^oc_[a-zA-Z0-9_-]+$/),
  messageId: identifier,
}).strict();
export type FeedbackActor = z.infer<typeof feedbackActorSchema>;

export const feedbackDetailFields = [
  ['checks', '排查记录'],
  ['sourceEvidence', '源码依据'],
  ['openQuestions', '待验证问题'],
  ['useCase', '使用场景与现有做法'],
  ['acceptanceCriteria', '验收标准'],
] as const;
const detailText = z.string().trim().max(6000).optional();

export const feedbackSummarySchema = z.object({
  kind: z.enum(['bug', 'feature', 'improvement']),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(30000),
  steps: z.string().max(12000).default(''),
  expected: z.string().max(12000).default(''),
  environment: z.string().max(6000).default(''),
  impact: z.enum(['无法使用', '部分受影响', '建议改进']).nullable().default(null),
  areas: z.array(z.enum(['聊天与消息', '配方', '账号与权限', '安装与更新', '其他'])).max(5).default([]),
  checks: detailText.describe('实际排查步骤和观察到的结果。'),
  sourceEvidence: detailText.describe('正式版版本、源码相对路径:行号及其能支持的结论。请勿粘贴大段源码。'),
  openQuestions: detailText.describe('尚需确认的问题，明确哪些是推测。'),
  useCase: detailText.describe('用户的使用场景、现在的做法和遇到的不便。'),
  acceptanceCriteria: detailText.describe('改进后可观察或验证的结果。'),
}).strict();
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;

export function feedbackDetails(summary: FeedbackSummary) {
  return feedbackDetailFields.flatMap(([key, label]) => {
    const value = summary[key];
    return value ? [{label, value}] : [];
  });
}

export const feedbackFormChangedMessage = '反馈表单的排查字段已变化，请重新整理并核对新卡片。';
export const feedbackTooLongMessage = '反馈内容过长，无法在卡片中完整核对。请精简重复日志或长段源码，保留版本、文件行号、观察结果和待验证问题后再生成卡片。';

export const feedbackDestinationSchema = z.object({
  baseToken: z.string().regex(/^[a-zA-Z0-9]+$/),
  tableId: z.string().regex(/^tbl[a-zA-Z0-9]+$/),
  shareToken: z.string().regex(/^shr[a-zA-Z0-9]+$/),
}).strict();
export type FeedbackDestination = z.infer<typeof feedbackDestinationSchema>;

export const feedbackAttachmentSchema = z.object({
  filename: z.string().min(1).max(240),
  relativePath: z.string().refine(value => {
    const parts = value.split('/');
    return parts.length === 3 && parts[0] === 'attachments' && z.string().uuid().safeParse(parts[1]).success &&
      !!parts[2] && !['.', '..'].includes(parts[2]) && !/[\\\u0000:*?"<>|]/.test(parts[2]);
  }, 'Expected a private attachment path'),
  bytes: z.number().int().positive().max(20 * 1024 * 1024),
  sha256: digest,
}).strict();
export type FeedbackAttachment = z.infer<typeof feedbackAttachmentSchema>;

export const feedbackDraftSchema = z.object({
  operationId: z.string().uuid(),
  trackingCode: z.string().regex(/^VV-[A-F0-9]{16}$/),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  actor: feedbackActorSchema,
  accountName: z.string().min(1).max(300),
  destination: feedbackDestinationSchema,
  summary: feedbackSummarySchema,
  attachments: z.array(feedbackAttachmentSchema).max(6),
  digest,
}).strict();
export type FeedbackDraft = z.infer<typeof feedbackDraftSchema>;

export const feedbackReceiptSchema = z.object({
  operationId: z.string().uuid(),
  trackingCode: z.string(),
  recordId: z.string().regex(/^rec[a-zA-Z0-9]+$/),
  url: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.feishu.cn') && /^\/record\/[a-zA-Z0-9]+$/.test(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash && !url.port;
  }, 'Expected an official Feishu record link'),
  accountName: z.string(),
  submittedAt: z.number().int().nonnegative(),
}).strict();
export type FeedbackReceipt = z.infer<typeof feedbackReceiptSchema>;

export const feedbackOperationSchema = z.discriminatedUnion('state', [
  z.object({state: z.literal('prepared'), draft: feedbackDraftSchema}).strict(),
  z.object({state: z.literal('sending'), draft: feedbackDraftSchema, sentAt: z.number()}).strict(),
  z.object({state: z.literal('uncertain'), draft: feedbackDraftSchema, sentAt: z.number()}).strict(),
  z.object({state: z.literal('submitted'), draft: feedbackDraftSchema, receipt: feedbackReceiptSchema}).strict(),
  z.object({state: z.literal('cancelled'), draft: feedbackDraftSchema}).strict(),
  z.object({state: z.literal('not-submitted'), draft: feedbackDraftSchema}).strict(),
]);
export type FeedbackOperation = z.infer<typeof feedbackOperationSchema>;

export const feedbackConfirmationSchema = z.object({
  ...person,
  chatId: z.string().regex(/^oc_[a-zA-Z0-9_-]+$/),
  operationId: z.string().uuid(),
  digest,
}).strict();
export type FeedbackConfirmation = z.infer<typeof feedbackConfirmationSchema>;

export interface FeedbackUserIdentity {
  appId: string;
  openId: string;
  name: string;
}

export type FeedbackLookup =
  | {state: 'missing'}
  | {state: 'found'; recordId: string; creatorOpenId: string}
  | {state: 'conflict'};

export interface FeedbackGateway {
  user(actor: FeedbackActor): Promise<FeedbackUserIdentity>;
  validate(actor: FeedbackActor, destination: FeedbackDestination): Promise<'detail-fields' | void>;
  lookup(draft: FeedbackDraft): Promise<FeedbackLookup>;
  submit(draft: FeedbackDraft, beforeWrite?: () => Promise<void>): Promise<void>;
  recordLink(draft: FeedbackDraft, recordId: string): Promise<string>;
}

export interface FeedbackStore {
  create(operation: FeedbackOperation): Promise<void>;
  read(operationId: string): Promise<FeedbackOperation>;
  write(operation: FeedbackOperation): Promise<void>;
  exclusive<T>(operationId: string, action: () => Promise<T>): Promise<T>;
  stage(operationId: string, selectedPaths: readonly string[]): Promise<FeedbackAttachment[]>;
  verify(draft: FeedbackDraft): Promise<void>;
  directory(operationId: string): string;
}

export interface FeedbackReview {
  operationId: string;
  trackingCode: string;
  digest: string;
  accountName: string;
  title: string;
  summary: FeedbackSummary;
  attachments: Array<Pick<FeedbackAttachment, 'filename' | 'bytes'>>;
  expiresAt: number;
}

/** Proof that the form-submit process could not have started, not a guarantee about other commands. */
export class FeedbackNotDispatchedError extends Error {
  constructor() {
    super('反馈记录尚未发出，请重新整理后核对提交。');
    this.name = 'FeedbackNotDispatchedError';
  }
}

export type FeedbackSubmissionResult =
  | {state: 'not-submitted'; operationId: string; trackingCode: string}
  | {state: 'submitted'; receipt: FeedbackReceipt}
  | {state: 'uncertain'; operationId: string; trackingCode: string};

export function sameFeedbackPerson(left: FeedbackActor, right: FeedbackUserIdentity): boolean {
  return left.appId === right.appId && left.openId === right.openId;
}

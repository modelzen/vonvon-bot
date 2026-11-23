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

export const feedbackSummarySchema = z.object({
  kind: z.enum(['bug', 'feature', 'improvement']),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(30000),
  steps: z.string().max(12000).default(''),
  expected: z.string().max(12000).default(''),
  environment: z.string().max(6000).default(''),
  impact: z.enum(['无法使用', '部分受影响', '建议改进']).nullable().default(null),
  areas: z.array(z.enum(['聊天与消息', '配方', '账号与权限', '安装与更新', '其他'])).max(5).default([]),
}).strict();
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;

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
  validate(actor: FeedbackActor, destination: FeedbackDestination): Promise<void>;
  lookup(draft: FeedbackDraft): Promise<FeedbackLookup>;
  submit(draft: FeedbackDraft): Promise<void>;
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

export type FeedbackSubmissionResult =
  | {state: 'submitted'; receipt: FeedbackReceipt}
  | {state: 'uncertain'; operationId: string; trackingCode: string};

export function sameFeedbackPerson(left: FeedbackActor, right: FeedbackUserIdentity): boolean {
  return left.appId === right.appId && left.openId === right.openId;
}

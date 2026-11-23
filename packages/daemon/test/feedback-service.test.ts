import {describe, expect, it, vi} from 'vitest';
import {
  feedbackActorSchema, feedbackConfirmationSchema, feedbackSummarySchema, FeedbackNotDispatchedError,
  type FeedbackActor, type FeedbackAttachment, type FeedbackDestination, type FeedbackDraft,
  type FeedbackGateway, type FeedbackLookup, type FeedbackOperation, type FeedbackStore,
  type FeedbackUserIdentity,
} from '../src/feedback/types.js';
import {FeedbackSubmissionService} from '../src/feedback/service.js';

const actor = feedbackActorSchema.parse({
  botId: 'feedback-bot', appId: 'cli_feedback', tenantKey: 'tenant-a',
  openId: 'ou_alice', chatId: 'oc_feedback', messageId: 'om_request',
});
const destination: FeedbackDestination = {baseToken: 'baseExample', tableId: 'tblExample', shareToken: 'shrExample'};
const summary = feedbackSummarySchema.parse({kind: 'bug', title: '回复中断', description: '收到第一段后没有后续消息。'});

class MemoryStore implements FeedbackStore {
  private readonly operations = new Map<string, FeedbackOperation>();
  private queue = Promise.resolve();
  changedAttachment = false;
  stagedPaths: readonly string[] = [];
  staged: FeedbackAttachment[] = [];

  async create(operation: FeedbackOperation): Promise<void> {
    if (this.operations.has(operation.draft.operationId)) throw new Error('Operation exists');
    this.operations.set(operation.draft.operationId, structuredClone(operation));
  }
  async read(operationId: string): Promise<FeedbackOperation> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new Error('Operation missing');
    return structuredClone(operation);
  }
  async write(operation: FeedbackOperation): Promise<void> {
    this.operations.set(operation.draft.operationId, structuredClone(operation));
  }
  async exclusive<T>(_operationId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  async stage(_operationId: string, selectedPaths: readonly string[]): Promise<FeedbackAttachment[]> {
    this.stagedPaths = selectedPaths;
    return structuredClone(this.staged);
  }
  async verify(_draft: FeedbackDraft): Promise<void> {
    if (this.changedAttachment) throw new Error('Attachment changed');
  }
  directory(operationId: string): string { return `/private/feedback/${operationId}`; }
}

class Gateway implements FeedbackGateway {
  identity: FeedbackUserIdentity = {appId: actor.appId, openId: actor.openId, name: 'Clay'};
  result: FeedbackLookup = {state: 'missing'};
  submitCount = 0;
  lookupCount = 0;
  validateCount = 0;
  recordLinkCount = 0;
  createOnSubmit = true;
  loseWriteResponse = false;
  lookupUnavailable = false;
  recordUrl = 'https://my.feishu.cn/record/ExampleRecord';
  inspectSending?: (draft: FeedbackDraft) => Promise<void>;

  async user(_actor: FeedbackActor): Promise<FeedbackUserIdentity> { return this.identity; }
  async validate(_actor: FeedbackActor, _destination: FeedbackDestination): Promise<void> { this.validateCount++; }
  async lookup(_draft: FeedbackDraft): Promise<FeedbackLookup> {
    this.lookupCount++;
    if (this.lookupUnavailable && this.submitCount > 0) throw new Error('Network unavailable');
    return this.result;
  }
  async submit(draft: FeedbackDraft): Promise<void> {
    this.submitCount++;
    await this.inspectSending?.(draft);
    if (this.createOnSubmit) this.result = {state: 'found', recordId: 'recExample', creatorOpenId: actor.openId};
    if (this.loseWriteResponse) throw new Error('Connection closed after upload');
  }
  async recordLink(_draft: FeedbackDraft, _recordId: string): Promise<string> {
    this.recordLinkCount++;
    return this.recordUrl;
  }
}

function setup() {
  const store = new MemoryStore();
  const gateway = new Gateway();
  let now = 1000;
  const service = new FeedbackSubmissionService({store, gateway, now: () => now});
  const prepare = () => service.prepare({actor, destination, summary});
  const confirmation = (review: Awaited<ReturnType<typeof prepare>>) => feedbackConfirmationSchema.parse({
    botId: actor.botId, appId: actor.appId, tenantKey: actor.tenantKey,
    openId: actor.openId, chatId: actor.chatId, operationId: review.operationId, digest: review.digest,
  });
  return {store, gateway, service, prepare, confirmation, setTime: (value: number) => { now = value; }};
}

describe('FeedbackSubmissionService', () => {
  it('shows the authorized person and selected attachments, then returns a persisted native record link', async () => {
    const h = setup();
    h.store.staged = [{filename: '截图.png', relativePath: 'attachments/12345678-abcd-4abc-8abc-123456789abc/截图.png', bytes: 12, sha256: 'a'.repeat(64)}];
    const review = await h.service.prepare({actor, destination, summary, attachments: ['/selected/截图.png']});
    expect(review.accountName).toBe('Clay');
    expect(review.attachments).toEqual([{filename: '截图.png', bytes: 12}]);
    expect(JSON.stringify(review)).not.toContain('/selected');
    expect(JSON.stringify(review)).not.toContain('relativePath');
    expect(h.store.stagedPaths).toEqual(['/selected/截图.png']);
    h.gateway.inspectSending = async draft => expect((await h.store.read(draft.operationId)).state).toBe('sending');
    const result = await h.service.confirm(h.confirmation(review));
    expect(result).toMatchObject({state: 'submitted', receipt: {recordId: 'recExample', url: h.gateway.recordUrl}});
    expect(await h.store.read(review.operationId)).toMatchObject({state: 'submitted', receipt: result.state === 'submitted' ? result.receipt : undefined});
    expect(h.gateway.submitCount).toBe(1);
  });

  it.each([
    {appId: actor.appId, openId: 'ou_other', name: 'Clay'},
    {appId: 'cli_other', openId: actor.openId, name: 'Clay'},
  ])('rejects a same-named user or an identity issued for another app', async identity => {
    const h = setup();
    h.gateway.identity = identity;
    await expect(h.prepare()).rejects.toThrow('提交账号与聊天身份不一致');
    expect(h.gateway.validateCount).toBe(0);
    expect(h.gateway.submitCount).toBe(0);
  });

  it.each<keyof Pick<FeedbackActor, 'botId' | 'appId' | 'tenantKey' | 'openId' | 'chatId'>>([
    'botId', 'appId', 'tenantKey', 'openId', 'chatId',
  ])('refuses a confirmation with a different %s', async field => {
    const h = setup();
    const review = await h.prepare();
    const wrong = {...h.confirmation(review), [field]: `${actor[field]}_other`};
    await expect(h.service.confirm(wrong)).rejects.toThrow('不属于当前聊天身份');
    expect(h.gateway.submitCount).toBe(0);
  });

  it('rejects changed confirmation content and model-supplied extra approval flags', async () => {
    const h = setup();
    const review = await h.prepare();
    await expect(h.service.confirm({...h.confirmation(review), digest: 'b'.repeat(64)})).rejects.toThrow('原摘要不一致');
    await expect(h.service.confirm({...h.confirmation(review), yes: true})).rejects.toThrow();
    expect(h.gateway.submitCount).toBe(0);
  });

  it('detects stored summary tampering after review', async () => {
    const h = setup();
    const review = await h.prepare();
    const operation = await h.store.read(review.operationId);
    operation.draft.summary.description = 'Changed without another review';
    await h.store.write(operation);
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow('内容已经改变');
    expect(h.gateway.submitCount).toBe(0);
  });

  it('requires unchanged staged attachment bytes before the first send', async () => {
    const h = setup();
    const review = await h.prepare();
    h.store.changedAttachment = true;
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow('Attachment changed');
    expect((await h.store.read(review.operationId)).state).toBe('prepared');
    expect(h.gateway.submitCount).toBe(0);
  });

  it('requires the currently authorized user to still match at confirmation time', async () => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.identity = {...h.gateway.identity, openId: 'ou_other'};
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow('提交账号与聊天身份不一致');
    expect(h.gateway.submitCount).toBe(0);
  });

  it('does not send an expired review or when the clock predates it', async () => {
    const h = setup();
    const review = await h.prepare();
    h.setTime(review.expiresAt);
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow('已过期');
    h.setTime(0);
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow('已过期');
    expect(h.gateway.submitCount).toBe(0);
  });

  it('lets only the original actor cancel a draft and never publishes a cancelled draft', async () => {
    const h = setup();
    const review = await h.prepare();
    await expect(h.service.cancel({actor: {...actor, openId: 'ou_other'}, operationId: review.operationId})).rejects.toThrow('不属于');
    await h.service.cancel({actor, operationId: review.operationId});
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow('已取消');
    expect(h.gateway.submitCount).toBe(0);
  });

  it('serializes concurrent confirmations and returns the same receipt with one write', async () => {
    const h = setup();
    const review = await h.prepare();
    const results = await Promise.all([h.service.confirm(h.confirmation(review)), h.service.confirm(h.confirmation(review))]);
    expect(results[0]).toEqual(results[1]);
    expect(h.gateway.submitCount).toBe(1);
  });

  it('returns an existing matching native record without another submission', async () => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.result = {state: 'found', recordId: 'recExisting', creatorOpenId: actor.openId};
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'submitted', receipt: {recordId: 'recExisting'}});
    expect(h.gateway.submitCount).toBe(0);
  });

  it('persists a proven pre-dispatch rejection and never retries that operation after restart', async () => {
    const h = setup();
    const review = await h.prepare();
    const submit = vi.spyOn(h.gateway, 'submit').mockRejectedValue(new FeedbackNotDispatchedError());
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'not-submitted'});
    expect((await h.store.read(review.operationId)).state).toBe('not-submitted');
    const restarted = new FeedbackSubmissionService({store: h.store, gateway: h.gateway});
    expect(await restarted.confirm(h.confirmation(review))).toMatchObject({state: 'not-submitted'});
    expect(await restarted.reconcile({actor, operationId: review.operationId})).toMatchObject({state: 'not-submitted'});
    expect(submit).toHaveBeenCalledTimes(1);
    expect(h.gateway.lookupCount).toBe(1);
  });

  it('never treats a generic error with a pre-dispatch name as proof the record was not sent', async () => {
    const h = setup();
    const review = await h.prepare();
    const error = new Error('response lost');
    error.name = 'FeedbackNotDispatchedError';
    const submit = vi.spyOn(h.gateway, 'submit').mockRejectedValue(error);
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'uncertain'});
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'uncertain'});
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('finds the real record when Feishu accepted the write but its response was lost', async () => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.loseWriteResponse = true;
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'submitted', receipt: {recordId: 'recExample'}});
    expect(h.gateway.submitCount).toBe(1);
  });

  it('only queries after an unknown result, even after expiry, then saves a recovered receipt', async () => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.createOnSubmit = false;
    h.gateway.loseWriteResponse = true;
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'uncertain'});
    h.setTime(review.expiresAt + 1000);
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'uncertain'});
    h.gateway.result = {state: 'found', recordId: 'recRecovered', creatorOpenId: actor.openId};
    expect(await h.service.reconcile({actor, operationId: review.operationId})).toMatchObject({state: 'submitted', receipt: {recordId: 'recRecovered'}});
    expect(h.gateway.submitCount).toBe(1);
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'submitted'});
  });

  it('preserves uncertainty while record lookup is unavailable and never retries the write', async () => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.lookupUnavailable = true;
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'uncertain'});
    expect(await h.service.reconcile({actor, operationId: review.operationId})).toMatchObject({state: 'uncertain'});
    h.gateway.lookupUnavailable = false;
    expect(await h.service.reconcile({actor, operationId: review.operationId})).toMatchObject({state: 'submitted'});
    expect(h.gateway.submitCount).toBe(1);
  });

  it('recovers a persisted sending operation after a process interruption without sending again', async () => {
    const h = setup();
    const review = await h.prepare();
    const {draft} = await h.store.read(review.operationId);
    await h.store.write({state: 'sending', draft, sentAt: 1001});
    h.gateway.result = {state: 'found', recordId: 'recAfterRestart', creatorOpenId: actor.openId};
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'submitted', receipt: {recordId: 'recAfterRestart'}});
    expect(h.gateway.submitCount).toBe(0);
  });

  it.each<FeedbackLookup>([
    {state: 'found', recordId: 'recOther', creatorOpenId: 'ou_other'},
    {state: 'conflict'},
  ])('rejects an unsafe preexisting lookup result without a write', async result => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.result = result;
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow();
    expect(h.gateway.submitCount).toBe(0);
    expect(h.gateway.recordLinkCount).toBe(0);
  });

  it.each([
    'https://example.com/record/ExampleRecord',
    'https://my.feishu.cn.evil.test/record/ExampleRecord',
    'http://my.feishu.cn/record/ExampleRecord',
    'https://user:fake-secret@my.feishu.cn/record/ExampleRecord',
    'https://my.feishu.cn/record/ExampleRecord?token=fake',
    'https://my.feishu.cn:8443/record/ExampleRecord',
  ])('rejects unsafe record URL %s and keeps safe recovery possible', async recordUrl => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.recordUrl = recordUrl;
    await expect(h.service.confirm(h.confirmation(review))).rejects.toThrow('无法核验反馈链接');
    expect((await h.store.read(review.operationId)).state).toBe('uncertain');
    h.gateway.recordUrl = 'https://my.feishu.cn/record/ExampleRecord';
    expect(await h.service.confirm(h.confirmation(review))).toMatchObject({state: 'submitted'});
    expect(h.gateway.submitCount).toBe(1);
  });

  it('does not let a different person reconcile or cancel an operation that may already be published', async () => {
    const h = setup();
    const review = await h.prepare();
    h.gateway.createOnSubmit = false;
    await h.service.confirm(h.confirmation(review));
    await expect(h.service.reconcile({actor: {...actor, openId: 'ou_other'}, operationId: review.operationId})).rejects.toThrow('不属于');
    await expect(h.service.cancel({actor, operationId: review.operationId})).rejects.toThrow('已进入提交阶段');
    expect((await h.store.read(review.operationId)).state).toBe('uncertain');
  });

  it('does not publish a prepared operation through the receipt-query method', async () => {
    const h = setup();
    const review = await h.prepare();
    await expect(h.service.reconcile({actor, operationId: review.operationId})).rejects.toThrow('尚未在聊天中确认');
    expect(h.gateway.submitCount).toBe(0);
    expect(h.gateway.lookupCount).toBe(0);
  });
});

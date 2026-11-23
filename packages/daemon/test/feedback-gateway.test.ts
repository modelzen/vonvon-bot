import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {NativeFeedbackGateway} from '../src/feedback/gateway.js';
import {FEEDBACK_SCOPES, type FeedbackCliPort} from '../src/feedback/lark-cli.js';
import {feedbackDraftSchema, type FeedbackActor, type FeedbackDraft} from '../src/feedback/types.js';

interface FormQuestion {
  id: string;
  title: string;
  type: string;
  required: boolean;
  filter?: unknown;
  multiple?: boolean;
  options?: Array<{name: string}>;
}

function questions(): FormQuestion[] {
  return [
    {title: '反馈标题', type: 'text', required: true},
    {title: '类型', type: 'select', required: true, multiple: false, options: ['问题反馈', '功能建议', '体验优化'].map(name => ({name}))},
    ...['详细说明', '如何重现', '期望效果', '使用环境'].map(title => ({title, type: 'text', required: title === '详细说明'})),
    {title: '涉及功能', type: 'select', required: false, multiple: true, options: ['聊天与消息', '配方', '账号与权限', '安装与更新', '其他'].map(name => ({name}))},
    {title: '影响程度', type: 'select', required: false, multiple: false, options: ['无法使用', '部分受影响', '建议改进'].map(name => ({name}))},
    {title: '截图与附件', type: 'attachment', required: false},
    {title: '跟进编号', type: 'text', required: false},
  ].map((question, index) => ({...question, id: 'fldQuestion' + index}));
}

function api(data: unknown, identity = 'user'): unknown {return {ok: true, identity, data};}

const actor: FeedbackActor = {
  botId: 'bot-1', appId: 'cli_feedback', tenantKey: 'tenant-1', openId: 'ou_author', chatId: 'oc_feedback', messageId: 'message-1',
};

function draft(): FeedbackDraft {
  return feedbackDraftSchema.parse({
    operationId: randomUUID(), trackingCode: 'VV-0123456789ABCDEF', createdAt: 1000, expiresAt: 86401000,
    actor, accountName: '同名用户', destination: {baseToken: 'baseToken', tableId: 'tblFeedback', shareToken: 'shrFeedback'},
    summary: {kind: 'bug', title: '图片发送失败', description: '选择截图后无法发送。', steps: '选择图片，然后发送。', expected: '图片能发出去。', environment: 'macOS', impact: '部分受影响', areas: ['聊天与消息', '配方']},
    attachments: [{filename: '操作截图.png', relativePath: `attachments/${randomUUID()}/操作截图.png`, bytes: 9, sha256: 'a'.repeat(64)}],
    digest: 'b'.repeat(64),
  });
}

function argument(args: readonly string[], flag: string): string {
  const value = args[args.indexOf(flag) + 1];
  if (args.indexOf(flag) < 0 || value === undefined) throw new Error(`Missing ${flag}`);
  return value;
}

function manifest(recordsCount = 0) {
  return {
    manifest_version: 'v1', base_token: 'baseToken', table_id: 'tblFeedback', has_more: false, records_count: recordsCount,
    columns: {
      '创建人': {field_id: 'fldCreatedBy', field_type: 'created_by'},
      '跟进编号': {field_id: 'fldTracking', field_type: 'text'},
    },
  };
}

interface CliCall {actor: FeedbackActor; args: readonly string[]; cwd: string | undefined}

class FixtureCli implements FeedbackCliPort {
  readonly calls: CliCall[] = [];
  auth: unknown = {appId: actor.appId, verified: true, identities: {user: {status: 'ready', available: true, verified: true, scope: FEEDBACK_SCOPES.join(' '), userName: '同名用户', openId: actor.openId}}};
  form: unknown = api({base_token: 'baseToken', questions: questions()});
  fields: unknown = api({fields: [...questions().map(question => ({id: question.id, name: question.title, type: question.type})), {id: 'fldCreatedBy', name: '创建人', type: 'created_by'}]});
  submission: unknown = api({can_submit_again: true});
  links: unknown = api({record_share_links: {recActual: 'https://modelzen.feishu.cn/record/opaqueShareToken'}});
  rows: unknown[] = [];
  manifest: unknown = undefined;
  outputText: string | undefined;

  async run(callActor: FeedbackActor, args: readonly string[], cwd?: string): Promise<unknown> {
    this.calls.push({actor: callActor, args: [...args], cwd});
    if (args[0] === 'auth' && args[1] === 'status') return this.auth;
    if (args[1] === '+form-detail') return this.form;
    if (args[1] === '+field-list') return this.fields;
    if (args[1] === '+form-submit') return this.submission;
    if (args[1] === '+record-share-link-create') return this.links;
    if (args[1] === '+record-list') {
      if (!cwd) throw new Error('Lookup requires a private working directory');
      await mkdir(cwd, {recursive: true});
      await writeFile(join(cwd, argument(args, '--output')), this.outputText ?? this.rows.map(row => JSON.stringify(row)).join('\n'), {flag: args.includes('--overwrite') ? 'w' : 'wx'});
      return this.manifest ?? manifest(this.rows.length);
    }
    throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  }
}

let scratch: string;
let cli: FixtureCli;
let gateway: NativeFeedbackGateway;
let submission: FeedbackDraft;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'feedback-gateway-'));
  cli = new FixtureCli();
  gateway = new NativeFeedbackGateway(cli, {directory: operationId => join(scratch, operationId)});
  submission = draft();
});
afterEach(async () => {await rm(scratch, {recursive: true, force: true});});

describe('NativeFeedbackGateway user identity and form contract', () => {
  it('uses the verified root auth-status format rather than the display name as identity', async () => {
    await expect(gateway.user(actor)).resolves.toEqual({appId: actor.appId, openId: actor.openId, name: '同名用户'});
    expect(cli.calls).toEqual([{actor, args: ['auth', 'status', '--json', '--verify'], cwd: undefined}]);
    cli.auth = {appId: actor.appId, verified: true, identities: {user: {status: 'ready', available: true, verified: true, scope: FEEDBACK_SCOPES.join(' '), userName: '同名用户', openId: 'ou_someoneElse'}}};
    await expect(gateway.user(actor)).rejects.toThrow(/不一致/);
    cli.auth = {appId: 'cli_anotherApp', verified: true, identities: {user: {status: 'ready', available: true, verified: true, scope: FEEDBACK_SCOPES.join(' '), userName: '同名用户', openId: actor.openId}}};
    await expect(gateway.user(actor)).rejects.toThrow(/不一致/);
  });

  it.each([
    {appId: actor.appId, verified: false, identities: {user: {status: 'ready', available: true, verified: true, scope: FEEDBACK_SCOPES.join(' '), userName: '同名用户', openId: actor.openId}}},
    {appId: actor.appId, verified: true, identities: {user: {status: 'expired', userName: '同名用户', openId: actor.openId}}},
    {appId: actor.appId, verified: true, identities: {bot: {status: 'ready', openId: actor.openId}}},
  ])('rejects unverified, expired or bot-only authorization', async auth => {
    cli.auth = auth;
    await expect(gateway.user(actor)).rejects.toThrow(/本人/);
  });

  it('accepts observed form-detail text questions without options or multiple', async () => {
    await expect(gateway.validate(actor, submission.destination)).resolves.toBeUndefined();
    expect(cli.calls).toEqual([{actor, args: ['base', '+form-detail', '--share-token', 'shrFeedback', '--as', 'user'], cwd: undefined}, {actor, args: ['base', '+field-list', '--base-token', 'baseToken', '--table-id', 'tblFeedback', '--as', 'user'], cwd: undefined}]);
  });

  it.each(['complete', 'partial-form', 'partial-table', 'wrong-id', 'filtered', 'ambiguous'] as const)(
    'selects dedicated fields only for the complete writable form and table (%s)', async layout => {
      const extras: FormQuestion[] = ['排查记录', '源码依据', '待验证问题', '使用场景与现有做法', '验收标准']
        .map((title, index) => ({id: 'fldExtra' + index, title, type: 'text', required: false}));
      const items = [...questions(), ...extras];
      const fields = items.map(item => ({id: item.id, name: item.title, type: item.type}));
      if (layout === 'partial-form') items.pop();
      if (layout === 'partial-table') fields.pop();
      if (layout === 'wrong-id') fields[fields.length - 1]!.id = 'fldOther';
      if (layout === 'filtered') items[items.length - 1]!.filter = {};
      if (layout === 'ambiguous') items.push({...extras[0]!, id: 'fldDuplicate'});
      cli.form = api({base_token: 'baseToken', questions: items});
      cli.fields = api({fields: [...fields, {id: 'fldCreatedBy', name: '创建人', type: 'created_by'}]});
      expect(await gateway.validate(actor, submission.destination)).toBe(layout === 'complete' ? 'detail-fields' : undefined);
    });

  it.each([
    {ok: false, identity: 'user', data: {base_token: 'baseToken', questions: questions()}},
    api({base_token: 'baseToken', questions: questions()}, 'bot'),
    {base_token: 'baseToken', questions: questions()},
  ])('rejects failed, bot-identity or missing API envelopes', async form => {
    cli.form = form;
    await expect(gateway.validate(actor, submission.destination)).rejects.toThrow();
  });

  it('rejects a share form bound to another Base', async () => {
    cli.form = api({base_token: 'anotherBase', questions: questions()});
    await expect(gateway.validate(actor, submission.destination)).rejects.toThrow(/目标不一致/);
  });

  it('rejects a form in a different table even when every field name and type is identical', async () => {
    cli.fields = api({fields: questions().map(question => ({id: question.id + 'OtherTable', name: question.title, type: question.type}))});
    await expect(gateway.validate(actor, submission.destination)).rejects.toThrow(/目标数据表/);
  });

  it.each(['影响程度', '截图与附件', '如何重现'])('rejects a formerly optional question becoming required: %s', async title => {
    cli.form = api({base_token: 'baseToken', questions: questions().map(question => question.title === title ? {...question, required: true} : question)});
    await expect(gateway.validate(actor, submission.destination)).rejects.toThrow(/必填/);
  });

  it.each(['missing', 'wrong-type', 'filtered', 'extra-required', 'missing-kind'])('rejects a changed form: %s', async change => {
    let changed = questions();
    if (change === 'missing') changed = changed.filter(question => question.title !== '跟进编号');
    if (change === 'wrong-type') changed = changed.map(question => question.title === '截图与附件' ? {...question, type: 'text'} : question);
    if (change === 'filtered') changed = changed.map(question => question.title === '类型' ? {...question, filter: {logic: 'and'}} : question);
    if (change === 'extra-required') changed.push({id: 'fldExtra', title: '新增必填问题', type: 'text', required: true});
    if (change === 'missing-kind') changed = changed.map(question => question.title === '类型' ? {...question, options: [{name: '问题反馈'}]} : question);
    cli.form = api({base_token: 'baseToken', questions: changed});
    await expect(gateway.validate(actor, submission.destination)).rejects.toThrow(/反馈/);
  });

  it.each(['kind-multiple', 'area-single', 'missing-area', 'missing-impact'])('rejects incompatible select configuration: %s', async change => {
    const changed = questions().map(question => {
      if (change === 'kind-multiple' && question.title === '类型') return {...question, multiple: true};
      if (change === 'area-single' && question.title === '涉及功能') return {...question, multiple: false};
      if (change === 'missing-area' && question.title === '涉及功能') return {...question, options: [{name: '其他'}]};
      if (change === 'missing-impact' && question.title === '影响程度') return {...question, options: [{name: '建议改进'}]};
      return question;
    });
    cli.form = api({base_token: 'baseToken', questions: changed});
    await expect(gateway.validate(actor, submission.destination)).rejects.toThrow(/反馈/);
  });
});

describe('NativeFeedbackGateway human form submission', () => {
  it('writes the five reviewed multiline texts to their exact native field names', async () => {
    submission.summary = {...submission.summary, checks: '实际步骤\n观察结果', sourceEvidence: '0.10.1 packages/daemon/src/cli.ts:18 支持此结论',
      openQuestions: '尚未验证的条件', useCase: '现有做法', acceptanceCriteria: '可观察行为'};
    await gateway.submit(submission);
    const fields = JSON.parse(argument(cli.calls[0]!.args, '--json')).fields;
    expect(fields).toMatchObject({'详细说明': submission.summary.description, '排查记录': submission.summary.checks,
      '源码依据': submission.summary.sourceEvidence, '待验证问题': submission.summary.openQuestions,
      '使用场景与现有做法': submission.summary.useCase, '验收标准': submission.summary.acceptanceCriteria});
  });

  it('maps the reviewed fields and relative attachments without overriding creator or workflow status', async () => {
    await gateway.submit(submission);
    expect(cli.calls).toHaveLength(1);
    const call = cli.calls[0];
    if (!call) throw new Error('Missing submit call');
    expect(call.actor).toEqual(actor);
    expect(call.cwd).toBe(join(scratch, submission.operationId));
    expect(call.args.slice(0, 2)).toEqual(['base', '+form-submit']);
    expect(argument(call.args, '--share-token')).toBe('shrFeedback');
    expect(argument(call.args, '--base-token')).toBe('baseToken');
    expect(argument(call.args, '--as')).toBe('user');
    const payload: unknown = JSON.parse(argument(call.args, '--json'));
    expect(payload).toEqual({fields: {
      '反馈标题': '图片发送失败', '类型': '问题反馈', '详细说明': '选择截图后无法发送。',
      '如何重现': '选择图片，然后发送。', '期望效果': '图片能发出去。', '使用环境': 'macOS',
      '涉及功能': ['聊天与消息', '配方'], '跟进编号': submission.trackingCode, '影响程度': '部分受影响',
    }, attachments: {'截图与附件': submission.attachments.map(file => file.relativePath)}});
    expect(argument(call.args, '--json')).not.toContain(scratch);
  });

  it.each([{kind: 'feature', label: '功能建议'}, {kind: 'improvement', label: '体验优化'}])('submits $label without fabricated optional values', async ({kind, label}) => {
    const input = feedbackDraftSchema.parse({...submission, attachments: [], summary: {...submission.summary, kind, impact: null}});
    await gateway.submit(input);
    const call = cli.calls[0];
    if (!call) throw new Error('Missing submit call');
    const payload: unknown = JSON.parse(argument(call.args, '--json'));
    expect(payload).toMatchObject({fields: {'类型': label}});
    expect(payload).not.toHaveProperty('attachments');
    expect(payload).not.toHaveProperty('fields.影响程度');
    expect(payload).not.toHaveProperty('fields.创建人');
    expect(payload).not.toHaveProperty('fields.状态');
  });

  it.each([api({can_submit_again: true}, 'bot'), {ok: false, identity: 'user', data: {can_submit_again: true}}, api({})])('does not treat invalid submit receipts as success', async receipt => {
    cli.submission = receipt;
    await expect(gateway.submit(submission)).rejects.toThrow();
  });
});

function record(input: FeedbackDraft, creator = actor.openId, code = input.trackingCode, id = 'recActual'): unknown {
  return {record_id: id, '跟进编号': code, '创建人': [{id: creator}]};
}

describe('NativeFeedbackGateway tracking lookup', () => {
  it('filters by exact tracking code and creator and parses the unwrapped NDJSON manifest', async () => {
    cli.rows = [record(submission)];
    await expect(gateway.lookup(submission)).resolves.toEqual({state: 'found', recordId: 'recActual', creatorOpenId: actor.openId});
    const call = cli.calls[0];
    if (!call) throw new Error('Missing lookup call');
    expect(call.actor).toEqual(actor);
    expect(argument(call.args, '--base-token')).toBe('baseToken');
    expect(argument(call.args, '--table-id')).toBe('tblFeedback');
    expect(argument(call.args, '--limit')).toBe('2');
    expect(argument(call.args, '--format')).toBe('ndjson');
    expect(call.args).toContain('--overwrite');
    const filter: unknown = JSON.parse(argument(call.args, '--filter-json'));
    expect(filter).toEqual({logic: 'and', conditions: [['跟进编号', '==', submission.trackingCode], ['创建人', 'intersects', [{id: actor.openId}]]]});
    expect(await readFile(join(scratch, submission.operationId, 'lookup.ndjson'), 'utf8')).toContain('recActual');
  });

  it('returns missing only for an empty complete result', async () => {
    await expect(gateway.lookup(submission)).resolves.toEqual({state: 'missing'});
  });

  it('can recover into the existing export file after an earlier empty preflight lookup', async () => {
    await expect(gateway.lookup(submission)).resolves.toEqual({state: 'missing'});
    cli.rows = [record(submission)];
    await expect(gateway.lookup(submission)).resolves.toEqual({state: 'found', recordId: 'recActual', creatorOpenId: actor.openId});
    expect(cli.calls).toHaveLength(2);
    expect(await readFile(join(scratch, submission.operationId, 'lookup.ndjson'), 'utf8')).toContain('recActual');
  });

  it.each(['ordinary-user-column', 'wrong-base', 'wrong-table', 'missing-metadata', 'wrong-tracking-type'])('requires system-created-by and matching manifest metadata: %s', async change => {
    const valid = manifest(1);
    cli.rows = [record(submission)];
    if (change === 'ordinary-user-column') cli.manifest = {...valid, columns: {...valid.columns, '创建人': {field_id: 'fldPerson', field_type: 'user'}}};
    if (change === 'wrong-base') cli.manifest = {...valid, base_token: 'anotherBase'};
    if (change === 'wrong-table') cli.manifest = {...valid, table_id: 'tblAnother'};
    if (change === 'missing-metadata') cli.manifest = {manifest_version: 'v1', has_more: false, records_count: 1};
    if (change === 'wrong-tracking-type') cli.manifest = {...valid, columns: {...valid.columns, '跟进编号': {field_id: 'fldTracking', field_type: 'number'}}};
    await expect(gateway.lookup(submission)).rejects.toThrow();
  });

  it.each(['duplicate', 'more', 'wrong-owner', 'wrong-code', 'count-mismatch', 'unexpected-row'])('refuses ambiguous lookup: %s', async change => {
    cli.rows = [record(submission)];
    if (change === 'duplicate') cli.rows.push(record(submission, actor.openId, submission.trackingCode, 'recDuplicate'));
    if (change === 'more') cli.manifest = {...manifest(1), has_more: true};
    if (change === 'wrong-owner') cli.rows = [record(submission, 'ou_otherPerson')];
    if (change === 'wrong-code') cli.rows = [record(submission, actor.openId, 'VV-FFFFFFFFFFFFFFFF')];
    if (change === 'count-mismatch') cli.manifest = manifest(0);
    if (change === 'unexpected-row') {cli.rows = []; cli.manifest = manifest(1);}
    await expect(gateway.lookup(submission)).resolves.toEqual({state: 'conflict'});
  });

  it.each([
    api(manifest()),
    manifest(3),
    {...manifest(), manifest_version: 'v2'},
  ])('rejects enveloped or unbounded manifest responses', async manifest => {
    cli.manifest = manifest;
    await expect(gateway.lookup(submission)).rejects.toThrow();
  });

  it.each(['bad-json', 'oversized', 'multiple-creators', 'bad-record-id'])('rejects invalid record exports: %s', async change => {
    cli.manifest = manifest(1);
    if (change === 'bad-json') cli.outputText = '{broken json';
    if (change === 'oversized') cli.outputText = ' '.repeat(200001);
    if (change === 'multiple-creators') cli.rows = [{record_id: 'recActual', '跟进编号': submission.trackingCode, '创建人': [{id: actor.openId}, {id: 'ou_other'}]}];
    if (change === 'bad-record-id') cli.rows = [record(submission, actor.openId, submission.trackingCode, '../not-a-record')];
    await expect(gateway.lookup(submission)).rejects.toThrow();
  });
});

describe('NativeFeedbackGateway official detail links', () => {
  it('returns the exact official record share link instead of constructing one from a record ID', async () => {
    await expect(gateway.recordLink(submission, 'recActual')).resolves.toBe('https://modelzen.feishu.cn/record/opaqueShareToken');
    const call = cli.calls[0];
    if (!call) throw new Error('Missing record-link call');
    expect(call.args.slice(0, 2)).toEqual(['base', '+record-share-link-create']);
    expect(argument(call.args, '--record-id')).toBe('recActual');
    expect(argument(call.args, '--as')).toBe('user');
  });

  it.each([api({record_share_links: {}}), api({record_share_links: {recOther: 'https://modelzen.feishu.cn/record/other'}}), api({record_share_links: {recActual: 'https://modelzen.feishu.cn/record/actual'}}, 'bot')])('refuses missing, mismatched or bot-identity links', async links => {
    cli.links = links;
    await expect(gateway.recordLink(submission, 'recActual')).rejects.toThrow();
  });
});

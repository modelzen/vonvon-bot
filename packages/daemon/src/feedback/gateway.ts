import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {feedbackCliIdentity, type FeedbackCliPort} from './lark-cli.js';
import {type FeedbackActor, type FeedbackDestination, type FeedbackDraft, type FeedbackGateway, type FeedbackLookup, type FeedbackStore} from './types.js';

const resultSchema = z.object({ok: z.literal(true), identity: z.literal('user'), data: z.unknown()});
const questionSchema = z.object({id: z.string(), title: z.string(), type: z.string(), required: z.boolean(), filter: z.unknown().optional(), multiple: z.boolean().nullish(), options: z.array(z.object({name: z.string()})).nullish()});
const formSchema = z.object({base_token: z.string(), questions: z.array(questionSchema)});
const fieldsSchema = z.object({fields: z.array(z.object({id: z.string(), name: z.string(), type: z.string()}))});
const manifestSchema = z.object({
  manifest_version: z.literal('v1'), base_token: z.string(), table_id: z.string(),
  has_more: z.boolean(), records_count: z.number().int().min(0).max(2),
  columns: z.object({
    '创建人': z.object({field_id: z.string().regex(/^fld[a-zA-Z0-9]+$/), field_type: z.literal('created_by')}),
    '跟进编号': z.object({field_id: z.string().regex(/^fld[a-zA-Z0-9]+$/), field_type: z.literal('text')}),
  }),
});
const recordSchema = z.object({record_id: z.string().regex(/^rec[a-zA-Z0-9]+$/), '跟进编号': z.string(), '创建人': z.array(z.object({id: z.string()})).length(1)});
const kindLabels = {bug: '问题反馈', feature: '功能建议', improvement: '体验优化'};

function data(value: unknown): unknown {return resultSchema.parse(value).data;}

export class NativeFeedbackGateway implements FeedbackGateway {
  constructor(private readonly cli: FeedbackCliPort, private readonly store: Pick<FeedbackStore, 'directory'>) {}

  async user(actor: FeedbackActor) {
    return feedbackCliIdentity(await this.cli.run(actor, ['auth', 'status', '--json', '--verify']), actor);
  }

  async validate(actor: FeedbackActor, destination: FeedbackDestination): Promise<void> {
    const form = formSchema.parse(data(await this.cli.run(actor, ['base', '+form-detail', '--share-token', destination.shareToken, '--as', 'user'])));
    if (form.base_token !== destination.baseToken) throw new Error('反馈入口与目标不一致，请重新核对。');
    const table = fieldsSchema.parse(data(await this.cli.run(actor, ['base', '+field-list', '--base-token', destination.baseToken, '--table-id', destination.tableId, '--as', 'user'])));
    const expected = new Map([
      ['反馈标题', 'text'], ['类型', 'select'], ['详细说明', 'text'], ['如何重现', 'text'], ['期望效果', 'text'],
      ['使用环境', 'text'], ['涉及功能', 'select'], ['影响程度', 'select'], ['截图与附件', 'attachment'], ['跟进编号', 'text'],
    ]);
    for (const [title, type] of expected) {
      const question = form.questions.find(item => item.title === title);
      if (!question || question.type !== type || question.filter != null) throw new Error('反馈字段已变化，请更新反馈助手后重新核对。');
      if (!table.fields.some(field => field.id === question.id && field.name === title && field.type === type)) {
        throw new Error('反馈提交入口与目标数据表的字段不一致。');
      }
    }
    if (!table.fields.some(field => field.name === '创建人' && field.type === 'created_by')) throw new Error('反馈数据表缺少系统创建人字段。');
    const guaranteed = new Set(['反馈标题', '类型', '详细说明', '跟进编号']);
    if (form.questions.some(question => question.required && !guaranteed.has(question.title))) throw new Error('反馈可选内容已改为必填，请更新反馈助手后重新核对。');
    if (form.questions.some(question => question.required && !expected.has(question.title))) throw new Error('反馈入口增加了必填内容，请更新反馈助手。');
    const selections = [
      {title: '类型', multiple: false, options: Object.values(kindLabels)},
      {title: '涉及功能', multiple: true, options: ['聊天与消息', '配方', '账号与权限', '安装与更新', '其他']},
      {title: '影响程度', multiple: false, options: ['无法使用', '部分受影响', '建议改进']},
    ];
    for (const expected of selections) {
      const question = form.questions.find(item => item.title === expected.title);
      const options = question?.options?.map(item => item.name) ?? [];
      if (question?.multiple !== expected.multiple || expected.options.some(option => !options.includes(option))) {
        throw new Error('反馈选项与当前入口不一致，请更新反馈助手。');
      }
    }
  }

  async lookup(draft: FeedbackDraft): Promise<FeedbackLookup> {
    const cwd = this.store.directory(draft.operationId);
    const filter = {logic: 'and', conditions: [['跟进编号', '==', draft.trackingCode], ['创建人', 'intersects', [{id: draft.actor.openId}]]]};
    const manifest = manifestSchema.parse(await this.cli.run(draft.actor, [
      'base', '+record-list', '--base-token', draft.destination.baseToken, '--table-id', draft.destination.tableId,
      '--filter-json', JSON.stringify(filter), '--field-id', '跟进编号', '--field-id', '创建人',
      '--limit', '2', '--format', 'ndjson', '--output', 'lookup.ndjson', '--overwrite', '--as', 'user',
    ], cwd));
    if (manifest.base_token !== draft.destination.baseToken || manifest.table_id !== draft.destination.tableId) {
      throw new Error('反馈回执与目标数据表不一致。');
    }
    if (manifest.has_more || manifest.records_count > 1) return {state: 'conflict'};
    const path = join(cwd, 'lookup.ndjson');
    if ((await stat(path)).size > 200000) throw new Error('反馈查询回执过大。');
    const rows = (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(line => recordSchema.parse(JSON.parse(line)));
    if (rows.length !== manifest.records_count || rows.length > 1) return {state: 'conflict'};
    const record = rows[0];
    if (!record) return {state: 'missing'};
    const creator = record['创建人'][0];
    if (!creator || record['跟进编号'] !== draft.trackingCode || creator.id !== draft.actor.openId) return {state: 'conflict'};
    return {state: 'found', recordId: record.record_id, creatorOpenId: creator.id};
  }

  async submit(draft: FeedbackDraft): Promise<void> {
    const {summary} = draft;
    const payload = {
      fields: {
        '反馈标题': summary.title, '类型': kindLabels[summary.kind], '详细说明': summary.description,
        '如何重现': summary.steps, '期望效果': summary.expected, '使用环境': summary.environment,
        '涉及功能': summary.areas, '跟进编号': draft.trackingCode,
        ...(summary.impact && {'影响程度': summary.impact}),
      },
      ...(draft.attachments.length && {attachments: {'截图与附件': draft.attachments.map(file => file.relativePath)}}),
    };
    const submitted = data(await this.cli.run(draft.actor, [
      'base', '+form-submit', '--share-token', draft.destination.shareToken, '--base-token', draft.destination.baseToken,
      '--json', JSON.stringify(payload), '--as', 'user', '--yes',
    ], this.store.directory(draft.operationId)));
    z.object({can_submit_again: z.boolean()}).parse(submitted);
  }

  async recordLink(draft: FeedbackDraft, recordId: string): Promise<string> {
    const value = z.object({record_share_links: z.record(z.string(), z.string())}).parse(data(await this.cli.run(draft.actor, [
      'base', '+record-share-link-create', '--base-token', draft.destination.baseToken, '--table-id', draft.destination.tableId,
      '--record-id', recordId, '--as', 'user',
    ], this.store.directory(draft.operationId))));
    const url = value.record_share_links[recordId];
    if (!url) throw new Error('反馈已经提交，正在等待真实详情链接。');
    return url;
  }
}

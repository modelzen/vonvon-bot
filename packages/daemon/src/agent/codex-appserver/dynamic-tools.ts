import { FEISHU_API, FEISHU_DOC_EDIT, feishuToolNames, feishuToolSpecs } from '../entry/feishu-tools';
import { scheduleToolNames, scheduleToolSpecs } from '../entry/schedule-tools';
import type { SessionProfile } from '../session-profile';
import type { StartThreadOptions } from '../types';
import type { ThreadStartParams } from './protocol';

/**
 * Codex 的 dynamicTools（定时任务 T3b，总设计 9.2）：thread/start 带上 vonvon 的工具，模型调用时 app-server 发
 * `item/tool/call` 回来（server-requests.ts 的 `dynamicToolCall`），和 Claude 走同一个登记表入口。
 *
 * 这里的类型是手写的，没改 ./protocol/generated：那份生成时没带 `--experimental`，`ThreadStartParams` 没有
 * `dynamicTools`，`DynamicToolSpec` 还是旧的扁平形状；protocol/index.ts 说的 `codex:protocol:update` 脚本也不存在。
 * 形状照 0.163.0 `codex app-server generate-json-schema --experimental` 的 `NamespaceDynamicToolSpec`（namespace 和
 * 里面的工具都要 description，工具带 `type: 'function'`），0.156.1 实测也收。
 */
export interface DynamicToolNamespace {
  type: 'namespace';
  name: 'vonvon_bot';
  description: string;
  tools: { type: 'function'; name: string; description: string; inputSchema: object; deferLoading?: boolean }[];
}
export type ThreadStartWithTools = ThreadStartParams & { dynamicTools?: DynamicToolNamespace[] };

export const ASK_USER_TOOL = 'ask_user';

export const askUserToolSpec = {
  name: ASK_USER_TOOL,
  description: '在飞书里向用户发出一张可点击的交互选择卡片并等待用户提交（支持单选/多选，默认自动附带“其他（直接打字）”开放输入框和“提交选择”按钮）。需要用户做选择或补充信息时优先调用本工具，不要只在纯文本里列编号。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '卡片顶部标题（可选，1-60 字，例如“创作配方 · 选择素材来源”）' },
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: '展示给用户的 1 到 4 个问题（保持简洁）。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '稳定标识（可选，如 source、delivery）' },
            header: { type: 'string', description: '简短题目标签（1-20 字，如“素材来源”）' },
            question: { type: 'string', description: '清晰完整的提问说明' },
            multiSelect: { type: 'boolean', description: '是否允许多选（默认 false 单选）' },
            allowOther: { type: 'boolean', description: '是否附带“其他（直接打字）”开放输入框（默认 true）' },
            options: {
              type: 'array',
              description: '可点击选项列表（2-8 项）；省略时渲染纯文本输入框。无需手工添加“其他”项，allowOther=true 会自动提供开放输入框。',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: '选项名称（简洁明确）' },
                  description: { type: 'string', description: '一句话说明该选项的含义或区别（可选）' },
                },
                required: ['label'],
                additionalProperties: false,
              },
            },
          },
          required: ['header', 'question'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
} as const;

/** vonvon's tools of this session: the same definitions Claude's `vonvon_bot` MCP server lists, plus Codex's `ask_user` choice-card tool. */
export function vonvonNamespace(tools: NonNullable<SessionProfile['tools']>): DynamicToolNamespace {
  const specs = [
    ...tools.schedule ? scheduleToolSpecs() : [],
    ...tools.feishu ? feishuToolSpecs(tools) : [],
    ...tools.askUser ? [askUserToolSpec] : [],
  ];
  return { type: 'namespace', name: 'vonvon_bot', description: 'vonvon 的工具：定时任务，读飞书的内容，改飞书文档，向用户发飞书交互选择卡。',
    tools: specs.map(spec => ({ type: 'function', ...spec })) };
}

/**
 * Only thread/start carries tools (the rollout keeps them; a resume restores them from disk and ignores any it is
 * sent), and only for a profile with `tools.schedule`, `tools.feishu` or `tools.askUser` and a session with an entry to answer the calls.
 */
export function startDynamicTools(opts: Pick<StartThreadOptions, 'entry' | 'profile'>): Pick<ThreadStartWithTools, 'dynamicTools'> {
  const tools = opts.profile?.tools;
  return opts.entry && (tools?.schedule || tools?.feishu || tools?.askUser) ? { dynamicTools: [vonvonNamespace(tools)] } : {};
}

/**
 * What Codex may call back: the tools thread/start offers, nothing else the entry has (no memory tools for Codex). A
 * thread older than feishu_doc_edit simply does not have it; one whose tier dropped since is refused by the tool itself.
 */
export function offeredTool(namespace: string | null | undefined, tool: string): boolean {
  return (namespace ?? 'vonvon_bot') === 'vonvon_bot'
    && (scheduleToolNames.has(tool) || feishuToolNames.has(tool) || tool === FEISHU_DOC_EDIT || tool === FEISHU_API || tool === ASK_USER_TOOL);
}

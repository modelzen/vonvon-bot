import {z} from 'zod';
import {FEEDBACK_PREPARE} from '../entry/feedback-tool';
import {resourceToolNames} from '../entry/resource-tools';
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

/** vonvon's tools of this session: the same definitions Claude's `vonvon_bot` MCP server lists. */
export function vonvonNamespace(tools: NonNullable<SessionProfile['tools']>): DynamicToolNamespace {
  const specs = [...tools.schedule ? scheduleToolSpecs() : [], ...tools.feishu ? feishuToolSpecs(tools) : []];
  return { type: 'namespace', name: 'vonvon_bot', description: 'vonvon 的工具：定时任务，读飞书的内容，改飞书文档。',
    tools: specs.map(spec => ({ type: 'function', ...spec })) };
}

/**
 * Only thread/start carries tools (the rollout keeps them; a resume restores them from disk and ignores any it is
 * sent), and only for a profile with `tools.schedule` or `tools.feishu` and a session with an entry to answer the calls.
 */
export function startDynamicTools(opts: Pick<StartThreadOptions, 'entry' | 'profile'>): Pick<ThreadStartWithTools, 'dynamicTools'> {
  const tools = opts.profile?.tools;
  if (!opts.entry || !tools || (!tools.schedule && !tools.feishu)) return {};
  const namespace = vonvonNamespace(tools);
  if (tools.feedback || tools.feishuApi) {
    for (const spec of opts.entry.tools()) {
      const offered = (tools.feedback && spec.name === FEEDBACK_PREPARE) || (tools.feishuApi && resourceToolNames.has(spec.name));
      if (offered) namespace.tools.push({type: 'function', name: spec.name, description: spec.description, inputSchema: z.toJSONSchema(spec.input)});
    }
  }
  return { dynamicTools: [namespace] };
}

/**
 * What Codex may call back: the tools thread/start offers, nothing else the entry has (no memory tools for Codex). A
 * thread older than feishu_doc_edit simply does not have it; one whose tier dropped since is refused by the tool itself.
 */
export function offeredTool(namespace: string | null | undefined, tool: string): boolean {
  return (namespace ?? 'vonvon_bot') === 'vonvon_bot' && (tool === FEEDBACK_PREPARE || resourceToolNames.has(tool) || scheduleToolNames.has(tool) || feishuToolNames.has(tool) || tool === FEISHU_DOC_EDIT || tool === FEISHU_API);
}

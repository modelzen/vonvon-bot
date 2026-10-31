import { scheduleToolNames, scheduleToolSpecs } from '../entry/schedule-tools';
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

/** T3's schedule tools: the same definitions Claude's `vonvon_bot` MCP server lists. */
export function scheduleNamespace(): DynamicToolNamespace {
  return { type: 'namespace', name: 'vonvon_bot', description: 'vonvon 的工具：本群的定时任务。',
    tools: scheduleToolSpecs().map(spec => ({ type: 'function', ...spec })) };
}

/**
 * Only thread/start carries tools (the rollout keeps them; a resume restores them from disk and ignores any it is
 * sent), and only for a profile with `tools.schedule` and a session with an entry to answer the calls.
 */
export function startDynamicTools(opts: Pick<StartThreadOptions, 'entry' | 'profile'>): Pick<ThreadStartWithTools, 'dynamicTools'> {
  return opts.entry && opts.profile?.tools?.schedule ? { dynamicTools: [scheduleNamespace()] } : {};
}

/** What Codex may call back: the tools thread/start offers, nothing else the entry has (no memory tools for Codex). */
export function offeredTool(namespace: string | null | undefined, tool: string): boolean {
  return (namespace ?? 'vonvon_bot') === 'vonvon_bot' && scheduleToolNames.has(tool);
}

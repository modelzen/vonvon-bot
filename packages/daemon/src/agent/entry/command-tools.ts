import { z } from 'zod';
import type { JoinedGroups } from '../../admin/groups';
import { feishuGroups, type FeishuMembers } from '../../admin/structured-commands';
import type { MemoryWriter } from '../../bot/memory-writer';
import type { ScheduleCommands } from '../../admin/schedule-commands';
import type { FeishuReader } from '../../feishu-read/reader';
import { createFeishuTools } from './feishu-tools';
import { createMemoryTools } from './memory-tools';
import { createScheduleTools } from './schedule-tools';
import { sessionInfoTool, ToolRefusal, type AgentTool } from './tools';

/** A private chat's Agent changes settings through the `vonvon` command line (dm-agent 5): no settings tools here. */
export function createCommandTools(deps: {
  appId: string;
  groups(cursor?: string): Promise<JoinedGroups>;
  members(chatId: string, cursor?: string): Promise<FeishuMembers>;
  /** 给了就多注册飞书读取工具（dm-agent 第 7 节）；feishu_members 不用它，一直有 */
  feishu?: FeishuReader;
  /** 给了就多注册 memory_add / memory_update / memory_forget / memory_list（§3.3） */
  memory?: MemoryWriter;
  /** 给了就多注册 schedule_* 七个工具（定时任务总设计第 10 节） */
  schedule?: ScheduleCommands;
}): AgentTool[] {
  const denied = () => new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
  return [sessionInfoTool, {
    // s1b: a group's whitelist has its own members, not the bot's groups; a comment has neither.
    name: 'feishu_groups', class: 'read', places: ['p2p'], description: '列出当前调用方可见的本 Bot 群。',
    input: z.object({ cursor: z.string().max(2000).optional() }).strict(),
    async run(args, ctx) {
      const { cursor } = z.object({ cursor: z.string().optional() }).parse(args);
      if (!ctx.admin || ctx.place.kind !== 'p2p') throw denied();
      const result = await feishuGroups(deps, cursor);
      if (!ctx.admin || ctx.place.kind !== 'p2p') throw denied();
      return result;
    },
  }, ...createFeishuTools(deps), ...(deps.memory ? createMemoryTools(deps.memory) : []), ...(deps.schedule ? createScheduleTools({ commands: deps.schedule }) : [])];
}

import { z } from 'zod';
import { parseSettingsEdit, parseSettingsScope } from '../../admin/settings-parse';
import type { HostSettings, SettingsScope, SettingsSave } from '../../admin/settings-types';
import type { JoinedGroups } from '../../admin/groups';
import { settingsGet, settingsSet, settingsAccess, feishuGroups, type FeishuMembers } from '../../admin/structured-commands';
import type { Project } from '../../project/registry';
import type { MemoryWriter } from '../../bot/memory-writer';
import type { ScheduleCommands } from '../../admin/schedule-commands';
import type { FeishuReader } from '../../feishu-read/reader';
import type { PermissionMode } from '../types';
import { createFeishuTools } from './feishu-tools';
import { createMemoryTools } from './memory-tools';
import { createScheduleTools } from './schedule-tools';
import { sessionInfoTool, ToolRefusal, type AgentTool, type ToolContext } from './tools';

class NoWriteResult extends Error { constructor(readonly result: SettingsSave) { super('No write'); } }

export function createCommandTools(deps: {
  appId: string;
  settings: HostSettings;
  projects(): Promise<Project[]>;
  groups(cursor?: string): Promise<JoinedGroups>;
  members(chatId: string, cursor?: string): Promise<FeishuMembers>;
  /** 给了就多注册飞书读取工具（dm-agent 第 7 节）；feishu_members 不用它，一直有 */
  feishu?: FeishuReader;
  /** A group's permission tier now: feishu_doc_edit goes round the sandbox, so it checks itself (dm-agent 7.2). */
  groupTier?(chatId: string): Promise<PermissionMode | undefined>;
  /** 给了就多注册 memory_add / memory_update / memory_forget / memory_list（§3.3） */
  memory?: MemoryWriter;
  /** 给了就多注册 schedule_* 七个工具（定时任务总设计第 10 节） */
  schedule?: ScheduleCommands;
}): AgentTool[] {
  const denied = () => new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
  /** Settings are a private chat's (settings-dm-only): the owner's or an admin's own turn there, this bot's, no host part. */
  function visible(scope: SettingsScope, ctx: ToolContext) {
    if (scope.kind === 'host' || scope.botId !== deps.appId || !(ctx.admin && ctx.place.kind === 'p2p')) throw denied();
  }
  async function read(raw: unknown, ctx: ToolContext) {
    const scope = parseSettingsScope(raw);
    visible(scope, ctx);
    try {
      const { view } = await settingsGet(deps.settings, scope);
      visible(scope, ctx);
      // Agent reads expose settings sections, not administrator lists or keystore metadata.
      const refusal = ctx.writeRefusal;
      const sections = !refusal ? view.sections : Object.fromEntries(Object.entries(view.sections).map(([name, section]) => [name, { ...section, access: { kind: 'readonly', reason: refusal.reason ?? refusal.code, message: refusal.message } }]));
      return { view: { scope: view.scope, sections } };
    } catch { throw denied(); }
  }
  const scopeSchema = z.unknown().refine(raw => { try { parseSettingsScope(raw); return true; } catch { return false; } }, '无效的设置目标');
  const editSchema = z.unknown().refine(raw => { try { parseSettingsEdit(raw); return true; } catch { return false; } }, '无效的设置修改，必须带 revision');
  const scopeInput = z.object({ scope: scopeSchema }).strict();
  // settings_get and settings_access serve settings only, so like settings_set they are a private chat's: a group or a
  // comment session neither lists nor calls them (settings-dm-only).
  return [sessionInfoTool, {
    name: 'settings_get', class: 'read', places: ['p2p'], description: '读取有权查看的本 Bot 设置及版本。', input: scopeInput,
    async run(args, ctx) { return read(scopeInput.parse(args).scope, ctx); },
  }, {
    name: 'settings_access', class: 'read', places: ['p2p'], description: '检查目标设置的可见权限；无权和不存在返回相同结果。', input: scopeInput,
    async run(args, ctx) {
      try {
        const scope = parseSettingsScope(scopeInput.parse(args).scope);
        visible(scope, ctx);
        const access = await settingsAccess(deps.settings, scope);
        visible(scope, ctx);
        const refusal = ctx.writeRefusal;
        return !refusal ? access : { access: Object.fromEntries(Object.keys(access.access).map(name => [name, { kind: 'readonly', reason: refusal.reason ?? refusal.code, message: refusal.message }])) };
      }
      catch { return { access: 'unavailable' }; }
    },
  }, {
    name: 'settings_set', class: 'settings', description: '按明确读取的 revision 修改本 Bot 的既有设置；reason 留作修改说明。群的权限：选档写 permission.mode；高级设置写 permission.custom，能写哪些项看 settings_get 里 permission.options.fields，写完和某一档一样会存成那一档。返回里有 warnings 时，回复里原样告诉用户。',
    input: z.object({ edit: editSchema, reason: z.string().max(2000).optional() }).strict(),
    async run(args, ctx) {
      const { edit: raw, reason } = z.object({ edit: z.unknown(), reason: z.string().optional() }).parse(args);
      const edit = parseSettingsEdit(raw);
      visible(edit.scope, ctx);
      if (!ctx.commit) throw denied();
      let result: SettingsSave;
      try {
        result = await ctx.commit(async guard => {
          const saved = await settingsSet(deps.settings, edit, { beforeCommit: guard, notAfter: ctx.notAfter });
          if (saved.kind !== 'saved') throw new NoWriteResult(saved);
          return saved;
        });
      } catch (error) {
        if (!(error instanceof NoWriteResult)) throw error;
        result = error.result;
      }
      return { ...result, ...(reason ? { reason } : {}) };
    },
  }, {
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

import { z } from 'zod';
import { parseSettingsEdit, parseSettingsScope } from '../../admin/settings-parse';
import type { HostSettings, SettingsScope, SettingsSave } from '../../admin/settings-types';
import type { JoinedGroups } from '../../admin/groups';
import { settingsGet, settingsSet, settingsAccess, feishuGroups, feishuMembers, type FeishuMembers } from '../../admin/structured-commands';
import type { Project } from '../../project/registry';
import { sessionInfoTool, ToolRefusal, type AgentTool, type ToolContext } from './tools';

class NoWriteResult extends Error { constructor(readonly result: SettingsSave) { super('No write'); } }

export function createCommandTools(deps: {
  appId: string;
  settings: HostSettings;
  projects(): Promise<Project[]>;
  groups(cursor?: string): Promise<JoinedGroups>;
  members(chatId: string, cursor?: string): Promise<FeishuMembers>;
}): AgentTool[] {
  const denied = () => new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
  async function visible(scope: SettingsScope, ctx: ToolContext) {
    if (scope.kind === 'host' || scope.botId !== deps.appId) throw denied();
    if (ctx.admin && ctx.place.kind === 'p2p') return;
    if (scope.kind !== 'project' || ctx.place.kind !== 'group') throw denied();
    const project = (await deps.projects()).find(p => p.name === scope.projectName);
    if (!project || project.chatId !== ctx.place.chatId) throw denied();
  }
  async function read(raw: unknown, ctx: ToolContext) {
    const scope = parseSettingsScope(raw);
    await visible(scope, ctx);
    try {
      const { view } = await settingsGet(deps.settings, scope);
      await visible(scope, ctx);
      // Agent reads expose settings sections, not administrator lists or keystore metadata.
      const refusal = ctx.writeRefusal ?? (ctx.place.kind !== 'p2p' ? { code: 'refused', reason: 'not-dm', message: '设置只能在私聊里改。' } : undefined);
      const sections = !refusal ? view.sections : Object.fromEntries(Object.entries(view.sections).map(([name, section]) => [name, { ...section, access: { kind: 'readonly', reason: refusal.reason ?? refusal.code, message: refusal.message } }]));
      return { view: { scope: view.scope, sections } };
    } catch { throw denied(); }
  }
  const scopeSchema = z.unknown().refine(raw => { try { parseSettingsScope(raw); return true; } catch { return false; } }, '无效的设置目标');
  const editSchema = z.unknown().refine(raw => { try { parseSettingsEdit(raw); return true; } catch { return false; } }, '无效的设置修改，必须带 revision');
  const scopeInput = z.object({ scope: scopeSchema }).strict();
  return [sessionInfoTool, {
    name: 'settings_get', class: 'read', description: '读取有权查看的本 Bot 设置及版本。', input: scopeInput,
    async run(args, ctx) { return read(scopeInput.parse(args).scope, ctx); },
  }, {
    name: 'settings_access', class: 'read', description: '检查目标设置的可见权限；无权和不存在返回相同结果。', input: scopeInput,
    async run(args, ctx) {
      try {
        const scope = parseSettingsScope(scopeInput.parse(args).scope);
        await visible(scope, ctx);
        if (ctx.place.kind !== 'p2p') {
          const { view } = await read(scope, ctx);
          return { access: Object.fromEntries(Object.entries(view.sections).map(([name, section]) => [name, section.access])) };
        }
        const access = await settingsAccess(deps.settings, scope);
        await visible(scope, ctx);
        const refusal = ctx.writeRefusal;
        return !refusal ? access : { access: Object.fromEntries(Object.keys(access.access).map(name => [name, { kind: 'readonly', reason: refusal.reason ?? refusal.code, message: refusal.message }])) };
      }
      catch { return { access: 'unavailable' }; }
    },
  }, {
    name: 'settings_set', class: 'settings', description: '按明确读取的 revision 修改本 Bot 的既有设置；reason 留作修改说明。',
    input: z.object({ edit: editSchema, reason: z.string().max(2000).optional() }).strict(),
    async run(args, ctx) {
      const { edit: raw, reason } = z.object({ edit: z.unknown(), reason: z.string().optional() }).parse(args);
      const edit = parseSettingsEdit(raw);
      await visible(edit.scope, ctx);
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
    name: 'feishu_groups', class: 'read', description: '列出当前调用方可见的本 Bot 群。',
    input: z.object({ cursor: z.string().max(2000).optional() }).strict(),
    async run(args, ctx) {
      const { cursor } = z.object({ cursor: z.string().optional() }).parse(args);
      if (!ctx.admin || ctx.place.kind !== 'p2p') {
        const own = ctx.place.kind === 'group' ? (await deps.projects()).filter(p => p.chatId === ctx.place.chatId) : [];
        return { groups: own.map(p => ({ chatId: p.chatId, name: p.name, bound: true })) };
      }
      const result = await feishuGroups(deps, cursor);
      if (!ctx.admin || ctx.place.kind !== 'p2p') throw denied();
      return result;
    },
  }, {
    name: 'feishu_members', class: 'read', description: '查询可见群的成员，失败不会伪装成空列表。',
    input: z.object({ chatId: z.string().min(1).max(1000), cursor: z.string().max(2000).optional() }).strict(),
    async run(args, ctx) {
      const { chatId, cursor } = z.object({ chatId: z.string(), cursor: z.string().optional() }).parse(args);
      if (!(ctx.admin && ctx.place.kind === 'p2p') && (ctx.place.kind !== 'group' || chatId !== ctx.place.chatId)) throw denied();
      const result = await feishuMembers(deps, chatId, cursor);
      if (!(ctx.admin && ctx.place.kind === 'p2p') && (ctx.place.kind !== 'group' || chatId !== ctx.place.chatId)) throw denied();
      return result;
    },
  }];
}

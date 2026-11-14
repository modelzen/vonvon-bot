import { recipeRichContentSchema, type RecipeInstallReply, type RecipeInstallRequest } from '@vonvon/protocol';
import type { HostSettings } from '../admin/settings-types';
import { botPaths, paths } from '../config/paths';
import { mutateProjectStore, getProjectByChatId } from '../project/registry';
import type { ScheduleStore } from '../bot/schedule/store';
import { canonicalLocal } from './rich-source-lineage';
import { sha256 } from './manifest';
import { recipeAdmissions, recipeSlot } from './rich-admission';
export async function richSetup(
  req: Extract<RecipeInstallRequest, { type: 'richSetup' }>,
  store: ScheduleStore,
  settings: HostSettings,
  allowedActor: (id: string) => boolean,
): Promise<RecipeInstallReply> {
  const { botId, groupId, action } = req,
    loc = { file: botPaths(botId).projectsFile, dataRoot: paths.appDir };
  const release = recipeAdmissions.acquire(recipeSlot(botId, groupId));
  try {
    const row = await getProjectByChatId(groupId, loc.file),
      active = row?.richRecipe;
    if (!row || !active || row.bindingIncarnation !== active.bindingIncarnation) throw new Error('本群没有可用的配方设置');
    const token = sha256(canonicalLocal(row));
    if (action.kind !== 'read' && action.token !== token) throw new Error('群设置已改变，请重新打开');
    const tasks = store.byChat(groupId).filter((t) => store.managed?.review(t.id));
    const steps = active.resolved
      .filter((i) => i.kind === 'setup')
      .map((i) => recipeRichContentSchema.shape.setup.element.parse({ ...i.value, itemId: i.itemId, originId: i.originId }));
    let open: Extract<RecipeInstallReply, { kind: 'richSetup' }>['open'];
    if (action.kind === 'enableTask') {
      const consent = store.managed?.review(action.taskId);
      if (!tasks.some((t) => t.id === action.taskId) || !consent || !allowedActor(action.actor))
        throw new Error('请确认本群任务与当前管理员身份');
      await store.managed!.consent(action.taskId, consent, { actor: action.actor, timeZone: action.timeZone });
    } else if (action.kind !== 'read') {
      const item = steps.find((s) => s.itemId === action.stepId);
      if (!item) throw new Error('此准备步骤已改变');
      if (action.kind === 'openSettings') {
        if (item.action.kind !== 'nativeSettings') throw new Error('没有对应设置入口');
        open = item.action.entry;
      } else {
        const manual = action.kind === 'acknowledge';
        if (!manual && item.action.kind === 'manual') throw new Error('这一步需要不同的确认方式');
        if (!manual && item.action.kind === 'nativeSettings') {
          const view = await settings.read({ kind: 'project', botId, projectName: row.name });
          const sections = view.sections as Record<string, { effective: unknown }>;
          if (!sections[item.action.entry] || item.check?.trim())
            throw new Error('无法自动验证作者的文字条件，请先核对本机设置');
        }
        await mutateProjectStore(loc, async (_, rows) => {
          const current = rows.find((r) => r.chatId === groupId && !r.dm);
          if (!current?.richRecipe || sha256(canonicalLocal(current)) !== token) throw new Error('群设置已改变');
          current.richRecipe.setup[item.itemId] = {
            kind: manual ? 'acknowledged' : 'observed',
            at: Date.now(),
            contract: sha256(canonicalLocal(active.resolved.find((i) => i.itemId === item.itemId)!.value)),
          };
          return { changed: true, value: undefined };
        });
        return richSetup({ ...req, action: { kind: 'read' } }, store, settings, allowedActor);
      }
    }
    return {
      kind: 'richSetup',
      groupId,
      token,
      steps: steps.map((step) => ({ ...step, readiness: active.setup[step.itemId]?.kind ?? 'pending' })),
      tasks: store
        .byChat(groupId)
        .filter((t) => store.managed?.review(t.id))
        .map((t) => ({ id: t.id, name: t.name, state: t.state })),
      ...(open ? { open } : {}),
    };
  } finally {
    release();
  }
}

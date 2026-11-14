import {describeSpec} from '../bot/schedule/time';
import { type RecipeInstallReply, type RecipeInstallRequest } from '@vonvon/protocol';
import type { HostSettings } from '../admin/settings-types';
import { botPaths, paths } from '../config/paths';
import { getProjectByChatId } from '../project/registry';
import type { ScheduleStore } from '../bot/schedule/store';
import { canonicalLocal } from './rich-source-lineage';
import { sha256 } from './manifest';
import { recipeAdmissions, recipeSlot } from './rich-admission';

// Keep the existing wire name for installed versions; this endpoint now reviews tasks only.
export async function richSetup(
  req: Extract<RecipeInstallRequest, { type: 'richSetup' }>,
  store: ScheduleStore,
  _settings: HostSettings,
  allowedActor: (id: string) => boolean,
  defaultActor?: string,
): Promise<RecipeInstallReply> {
  const { botId, groupId, action } = req,
    loc = { file: botPaths(botId).projectsFile, dataRoot: paths.appDir };
  const release = recipeAdmissions.acquire(recipeSlot(botId, groupId));
  try {
    const row = await getProjectByChatId(groupId, loc.file), active = row?.richRecipe;
    if (!row || !active || row.bindingIncarnation !== active.bindingIncarnation) throw new Error('本群没有可用的配方设置');
    const token = sha256(canonicalLocal(row));
    if (action.kind !== 'read' && action.token !== token) throw new Error('群设置已改变，请重新打开');
    const tasks = store.byChat(groupId).filter((task) => store.managed?.review(task.id));
    if (action.kind === 'enableTask') {
      const actor = defaultActor, consent = store.managed?.review(action.taskId);
      if (!tasks.some((task) => task.id === action.taskId) || !consent || action.taskToken !== sha256(consent) || !actor || !allowedActor(actor))
        throw new Error('请确认本群任务与当前管理员身份');
      await store.managed!.consent(action.taskId, consent, { actor, timeZone: action.timeZone });
    } else if (action.kind !== 'read') {
      throw new Error('setup 是普通技能，请按配方介绍运行；不再记录准备步骤状态。');
    }
    return {
      kind: 'richSetup', groupId, token, steps: [],
      tasks: store.byChat(groupId).filter((task) => store.managed?.review(task.id)).map((task) => ({
        id: task.id, name: task.name, state: task.state, token: sha256(store.managed!.review(task.id)!), instruction: task.instruction,
        spec: structuredClone(task.spec), schedule: describeSpec(task.spec, task.timeZone, task.timeZone, Date.now()),
        timeZone: task.timeZone, placement: task.placement.kind === 'follow' ? 'follow' as const : 'newTopic' as const,
      })),
    };
  } finally { release(); }
}

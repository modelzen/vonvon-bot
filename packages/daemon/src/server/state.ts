import type { AdminService } from '../admin/service';
import { bridgeVersion } from '../core/version';

export async function readAdminState(service: Pick<AdminService, 'listBots' | 'listProjects'>) {
  const bots = await service.listBots();
  const out = [];
  let remainingAvatarBytes = 2_000_000;
  function withAvatarBudget<T extends { avatarDataUrl?: string }>(item: T): T {
    const copy = { ...item };
    if (copy.avatarDataUrl) {
      if (copy.avatarDataUrl.length > remainingAvatarBytes) delete copy.avatarDataUrl;
      else remainingAvatarBytes -= copy.avatarDataUrl.length;
    }
    return copy;
  }
  for (const bot of bots) {
    const b = withAvatarBudget(bot);
    try { out.push({ ...b, projects: (await service.listProjects(b.appId)).map(withAvatarBudget) }); }
    catch (error) { out.push({ ...b, projects: [], projectsError: error instanceof Error ? error.message : '项目读取失败' }); }
  }
  return { version: bridgeVersion(), generatedAt: Date.now(), bots: out };
}
export type AdminState = Awaited<ReturnType<typeof readAdminState>>;

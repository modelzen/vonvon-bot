import type { AdminProject, AdminService } from '../admin/service';
import { bridgeVersion } from '../core/version';

export async function readAdminState(service: Pick<AdminService, 'listBots' | 'listProjects' | 'dmRow'>) {
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
    let projects: AdminProject[] = [];
    let projectsError: string | undefined;
    try {
      projects = (await service.listProjects(b.appId)).map(withAvatarBudget);
    }
    catch (error) { projectsError = error instanceof Error && error.message ? error.message : '项目读取失败'; }
    let dm: AdminProject | undefined;
    let dmError: string | undefined;
    try { dm = await service.dmRow?.(b.appId); }
    catch (error) { dmError = error instanceof Error && error.message ? error.message : '私聊初始化失败'; }
    out.push({ ...b, projects, ...(projectsError ? { projectsError } : {}), ...(dm ? { dm } : {}), ...(dmError ? { dmError } : {}) });
  }
  return { version: bridgeVersion(), generatedAt: Date.now(), bots: out };
}
export type AdminState = Awaited<ReturnType<typeof readAdminState>>;

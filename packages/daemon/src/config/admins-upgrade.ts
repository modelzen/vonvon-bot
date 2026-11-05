import type { AppPreferencesWriter } from '../admin/ops';
import { getAppRoleSnapshot } from './app-roles';
import type { AppAccess, AppConfig } from './schema';

/** Written once done. Without it a creator taken off the list would be put back at every start. */
const ADMINS_VERSION = 2;

/**
 * dm-agent 3.2: the list deduplicated with the creator on it, or, still empty, Feishu's owner of the app. Undefined when
 * there is nothing to do: already upgraded, or nobody to put on it. No version is written for the latter, so a start that
 * can read Feishu's owner tries again; an empty list takes no one's removal to undo (one always stays).
 */
export function upgradedAccess(access: AppAccess | undefined, feishuOwner: string | undefined): AppAccess | undefined {
  if (access?.adminsVersion === ADMINS_VERSION) return undefined;
  const admins = new Set(access?.admins ?? []);
  if (access?.ownerOpenId) admins.add(access.ownerOpenId);
  if (!admins.size && feishuOwner) admins.add(feishuOwner);
  return admins.size ? { ...access, admins: [...admins], adminsVersion: ADMINS_VERSION } : undefined;
}

/** At each start of the Bot process, on the writer every other change of the list goes through. */
export async function upgradeAdmins(cfg: AppConfig, write: AppPreferencesWriter): Promise<void> {
  const feishuOwner = getAppRoleSnapshot(cfg.accounts.app.id, cfg.accounts.app.tenant)?.ownerOpenId;
  if (!upgradedAccess(cfg.preferences?.access, feishuOwner)) return;
  await write(preferences => {
    const access = upgradedAccess(preferences.access, feishuOwner);
    if (access) preferences.access = access;
  });
}

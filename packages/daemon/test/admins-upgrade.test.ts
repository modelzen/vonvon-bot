import { describe, expect, it, vi } from 'vitest';
import { upgradeAdmins, upgradedAccess } from '../src/config/admins-upgrade';
import { createAppPreferencesWriter } from '../src/admin/ops';
import * as appRoles from '../src/config/app-roles';
import { isAdmin, type AppAccess, type AppConfig } from '../src/config/schema';

/** dm-agent 3.2: what a start does to the list, on the writer every other change goes through. */
const config = (access?: AppAccess): AppConfig => ({ accounts: { app: { id: 'cli_up', secret: 'fixture', tenant: 'feishu' } }, ...(access ? { preferences: { access } } : {}) });
function start(cfg: AppConfig, feishuOwner?: string) {
  const persistConfig = vi.fn(async () => {});
  const roles = vi.spyOn(appRoles, 'getAppRoleSnapshot').mockReturnValue(feishuOwner ? { appId: 'cli_up', tenant: 'feishu', fetchedAt: 0, ownerOpenId: feishuOwner, admins: [] } : undefined);
  return { persistConfig, run: () => upgradeAdmins(cfg, createAppPreferencesWriter({ cfg, persistConfig })).finally(() => roles.mockRestore()) };
}

describe('upgrading the administrators', () => {
  it('deduplicates the list, puts the creator on it and writes the version', () => {
    expect(upgradedAccess({ ownerOpenId: 'ou_c', admins: ['ou_a', 'ou_a'], allowedChats: ['oc_1'] }, 'ou_feishu'))
      .toEqual({ ownerOpenId: 'ou_c', admins: ['ou_a', 'ou_c'], allowedChats: ['oc_1'], adminsVersion: 2 });
    expect(upgradedAccess({ ownerOpenId: 'ou_c', admins: ['ou_c'] }, undefined)).toEqual({ ownerOpenId: 'ou_c', admins: ['ou_c'], adminsVersion: 2 });
  });

  it('takes Feishu\'s owner only for a list still empty', () => {
    expect(upgradedAccess({ admins: [] }, 'ou_feishu')).toEqual({ admins: ['ou_feishu'], adminsVersion: 2 });
    expect(upgradedAccess(undefined, 'ou_feishu')).toEqual({ admins: ['ou_feishu'], adminsVersion: 2 });
    expect(upgradedAccess({ admins: ['ou_a'] }, 'ou_feishu')).toEqual({ admins: ['ou_a'], adminsVersion: 2 });
  });

  it('does not guess when there is nobody, and tries again at the next start', async () => {
    expect(upgradedAccess({ admins: [] }, undefined)).toBeUndefined();
    const cfg = config({ admins: [] });
    const first = start(cfg);
    await first.run();
    expect(first.persistConfig).not.toHaveBeenCalled();
    expect(cfg.preferences?.access).toEqual({ admins: [] });
    const second = start(cfg, 'ou_feishu');
    await second.run();
    expect(cfg.preferences?.access).toEqual({ admins: ['ou_feishu'], adminsVersion: 2 });
  });

  // The reason for the version: without it the creator comes back at every start.
  it('does not put a removed creator back at the next starts', async () => {
    const cfg = config({ ownerOpenId: 'ou_c', admins: ['ou_a'] });
    await start(cfg).run();
    expect(isAdmin(cfg, 'ou_c')).toBe(true);
    cfg.preferences!.access!.admins = ['ou_a'];
    for (let i = 0; i < 2; i++) {
      const again = start(cfg, 'ou_feishu');
      await again.run();
      expect(again.persistConfig).not.toHaveBeenCalled();
    }
    expect(cfg.preferences?.access).toEqual({ ownerOpenId: 'ou_c', admins: ['ou_a'], adminsVersion: 2 });
    expect(isAdmin(cfg, 'ou_c')).toBe(false);
  });
});

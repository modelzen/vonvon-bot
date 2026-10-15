import { describe, expect, it } from 'vitest';
import { fileClaimMode } from '../src/bot/outbound-files';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';

const cfg = (access: Record<string, unknown> = {}): AppConfig => ({
  accounts: { app: { id: 'app', secret: 'x', tenant: 'feishu' } },
  preferences: { access: { ownerOpenId: 'ou_owner', ...access } },
}) as AppConfig;
const project = (fields: Partial<Project> = {}): Project => ({
  name: 'p', chatId: 'oc_chat', cwd: '/work', blank: false, createdAt: 0, mode: 'write', ...fields,
}) as Project;
const record = { chatId: 'oc_chat', cwd: '/work', requesterOpenId: 'ou_requester' };

describe('fileClaimMode (product.md 3.12)', () => {
  it('lets any member allowed in the group claim, not only the requester', () => {
    expect(fileClaimMode(cfg(), project(), record, 'ou_someone')).toBe('write');
    expect(fileClaimMode(cfg(), project({ allowedUsers: ['ou_someone'] }), record, 'ou_someone')).toBe('write');
  });

  it('refuses members outside the group allowlist, but never an admin', () => {
    const p = project({ allowedUsers: ['ou_requester'] });
    expect(fileClaimMode(cfg(), p, record, 'ou_someone')).toBeUndefined();
    expect(fileClaimMode(cfg({ admins: ['ou_admin'] }), p, record, 'ou_admin')).toBe('write');
    expect(fileClaimMode(cfg(), p, record, 'ou_owner')).toBe('write');
  });

  it('refuses a chat outside the app allowlist, an unbound, disabled or moved project, and no clicker', () => {
    expect(fileClaimMode(cfg({ allowedChats: ['oc_other'] }), project(), record, 'ou_someone')).toBeUndefined();
    expect(fileClaimMode(cfg(), undefined, record, 'ou_someone')).toBeUndefined();
    expect(fileClaimMode(cfg(), project({ enabled: false }), record, 'ou_someone')).toBeUndefined();
    expect(fileClaimMode(cfg(), project({ cwd: '/elsewhere' }), record, 'ou_someone')).toBeUndefined();
    expect(fileClaimMode(cfg(), project(), record, '')).toBeUndefined();
  });

  it("returns the clicker's own tier", () => {
    const p = project({ mode: 'full', guestMode: 'qa' } as Partial<Project>);
    expect(fileClaimMode(cfg(), p, record, 'ou_someone')).toBe('qa');
    expect(fileClaimMode(cfg(), p, record, 'ou_owner')).toBe('full');
  });
});

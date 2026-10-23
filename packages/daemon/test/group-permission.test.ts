import { afterEach, describe, expect, it, vi } from 'vitest';
import * as catalog from '../src/agent/catalog';
import { groupPermission } from '../src/config/execution';
import { log } from '../src/core/logger';
import type { Project } from '../src/project/registry';

afterEach(() => vi.restoreAllMocks());
const CODEX = 'codex-appserver';
const CLAUDE = 'claude-agent';

describe('group permission effects', () => {
  it.each([
    ['qa', false], ['write', true], ['full', false], ['full', true], [undefined, undefined],
  ] as const)('reads the %s tier with network %s', (mode, network) => {
    const tier = mode ?? 'full';
    expect(groupPermission({ mode, network })).toEqual({ tier, effect: { mode: tier, network: tier !== 'qa' } });
  });

  it.each([
    ['qa', true, 'read-only'], ['write', false, 'workspace-write'], ['write', undefined, 'workspace-write'],
  ] as const)('keeps legacy Codex %s/network %s unchanged', (mode, network, sandbox) => {
    expect(groupPermission({ backend: CODEX, mode, network })).toEqual({
      tier: mode, custom: { sandbox, network: network ?? false }, legacy: true,
      effect: { mode, network: network ?? false },
    });
  });

  it('keeps a legacy Claude network-off write group unchanged', () => {
    expect(groupPermission({ backend: CLAUDE, mode: 'write', network: false })).toEqual({
      tier: 'write', custom: { permissionMode: 'acceptEdits', network: 'off' }, legacy: true,
      effect: { mode: 'write', network: false },
    });
  });

  it('uses validated native settings for the active backend before the stored tier and network', () => {
    const settings = Object.freeze({ permissionMode: 'default', network: 'all' });
    const custom = Object.freeze({ backend: CLAUDE, settings });
    const group = Object.freeze({ backend: CLAUDE, mode: 'full' as const, network: false, custom });
    expect(groupPermission(group)).toEqual({ tier: 'full', custom: settings, effect: { mode: 'qa', network: true } });
    expect(groupPermission(group).custom).not.toBe(settings);
    expect(group.custom).toBe(custom);
    expect(groupPermission({ mode: 'write', network: true, custom: { backend: CODEX, settings: { sandbox: 'read-only' } } }))
      .toEqual({ tier: 'write', custom: { sandbox: 'read-only', network: false }, effect: { mode: 'qa', network: false } });
  });

  it('ignores custom settings from another backend, including when modelAccess selects the backend', () => {
    const custom = { backend: CODEX, settings: { sandbox: 'read-only', network: true } };
    const expected = { tier: 'write', effect: { mode: 'write', network: true } };
    expect(groupPermission({ backend: CLAUDE, mode: 'write', network: true, custom })).toEqual(expected);
    expect(groupPermission({ backend: CODEX, modelAccess: { backend: CLAUDE, models: [], efforts: [] }, mode: 'write', network: true, custom })).toEqual(expected);
  });

  it('fails closed for invalid native settings and logs once per group across reloaded rows', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const custom = { backend: CODEX, settings: { sandbox: 'read-only', network: true, privateKey: 'private-value' } };
    const row = { chatId: 'synthetic_bad_custom', mode: 'full' as const, network: true, custom };
    const expected = { tier: 'qa', invalid: true, effect: { mode: 'qa', network: false } };
    expect(groupPermission(row)).toEqual(expected);
    expect(groupPermission({ ...row })).toEqual(expected);
    expect(warn.mock.calls).toEqual([['permission', 'custom-invalid']]);
    expect(groupPermission({ ...row, chatId: 'synthetic_other_bad_custom' })).toEqual(expected);
    expect(warn.mock.calls).toEqual([['permission', 'custom-invalid'], ['permission', 'custom-invalid']]);
    const anonymous = { mode: 'full' as const, custom };
    groupPermission(anonymous);
    groupPermission(anonymous);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it.each(['xyz', null, 7])('fails closed for corrupt tier %s without converting it to a writable custom', mode => {
    expect(groupPermission({ mode: mode as Project['mode'], network: true,
      custom: { backend: CODEX, settings: { sandbox: 'danger-full-access', network: true } } }))
      .toEqual({ tier: 'qa', effect: { mode: 'qa', network: false } });
  });

  it('preserves legacy network behavior for a provider without native custom settings', () => {
    const original = catalog.catalogById;
    vi.spyOn(catalog, 'catalogById').mockImplementation(id => id === 'synthetic-provider'
      ? { ...catalog.BACKEND_CATALOG[0]!, id } : original(id));
    expect(groupPermission({ backend: 'synthetic-provider', mode: 'write', network: false }))
      .toEqual({ tier: 'write', effect: { mode: 'write', network: false } });
  });
});

import { describe, expect, it } from 'vitest';
import { effectiveGuestMode, effectiveMode, turnTier, type Project } from '../src/project/registry';
import { sandboxParams } from '../src/agent/codex-appserver/backend';
import { AUTO_COMPACT_RETIRED, buildGroupSettingsCard, buildPermissionCard, buildProjectSettingsCard } from '../src/card/dm-cards';

describe('effectiveMode', () => {
  it('defaults missing mode to full (legacy data unaffected)', () => {
    expect(effectiveMode({})).toBe('full');
    expect(effectiveMode({ mode: undefined })).toBe('full');
  });
  it('passes explicit tiers through', () => {
    expect(effectiveMode({ mode: 'qa' })).toBe('qa');
    expect(effectiveMode({ mode: 'write' })).toBe('write');
    expect(effectiveMode({ mode: 'full' })).toBe('full');
  });
});

describe('effectiveGuestMode', () => {
  it('unset guestMode falls back to the admin tier (no split)', () => {
    expect(effectiveGuestMode({ mode: 'full' })).toBe('full');
    expect(effectiveGuestMode({ mode: 'qa' })).toBe('qa');
    expect(effectiveGuestMode({})).toBe('full'); // legacy
  });
  it('explicit guestMode wins', () => {
    expect(effectiveGuestMode({ mode: 'full', guestMode: 'qa' })).toBe('qa');
  });
});

describe('turnTier (admin vs guest per-turn tier + thread split)', () => {
  it('no guestMode → no split; both roles get the admin tier', () => {
    expect(turnTier({ mode: 'full' }, true)).toEqual({ mode: 'full', role: 'admin', split: false });
    expect(turnTier({ mode: 'full' }, false)).toEqual({ mode: 'full', role: 'guest', split: false });
  });
  it('guestMode equal to mode → still no split', () => {
    expect(turnTier({ mode: 'qa', guestMode: 'qa' }, false).split).toBe(false);
  });
  it('distinct guestMode → split; admin keeps mode, guest gets guestMode', () => {
    expect(turnTier({ mode: 'full', guestMode: 'qa' }, true)).toEqual({ mode: 'full', role: 'admin', split: true });
    expect(turnTier({ mode: 'full', guestMode: 'qa' }, false)).toEqual({ mode: 'qa', role: 'guest', split: true });
  });
});

describe('sandboxParams', () => {
  // Force a platform for one assertion, then restore — keeps these deterministic
  // regardless of the host the tests run on.
  function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  }

  it('full (and undefined) → danger-full-access, no permissions config (any platform)', () => {
    for (const plat of ['darwin', 'win32', 'linux'] as const) {
      withPlatform(plat, () => {
        expect(sandboxParams('full', false)).toEqual({ sandbox: 'danger-full-access' });
        expect(sandboxParams(undefined, true)).toEqual({ sandbox: 'danger-full-access' });
      });
    }
  });

  // qa/write read-confinement is enforceable on macOS (Seatbelt) and native
  // Windows (restricted token) — assert the profile shape on both.
  for (const plat of ['darwin', 'win32'] as const) {
    it(`${plat}: qa → read-only confined to workspace, network off`, () => {
      withPlatform(plat, () => {
        const p = sandboxParams('qa', false) as any;
        expect(p.sandbox).toBeUndefined();
        expect(p.config.default_permissions).toBe('feishu');
        const fs = p.config.permissions.feishu.filesystem;
        expect(fs[':minimal']).toBe('read');
        expect(fs[':workspace_roots']['.']).toBe('read');
        expect(p.config.permissions.feishu.network.enabled).toBe(false);
      });
    });
    it(`${plat}: write → workspace write + network honored`, () => {
      withPlatform(plat, () => {
        const p = sandboxParams('write', true) as any;
        expect(p.config.permissions.feishu.filesystem[':workspace_roots']['.']).toBe('write');
        expect(p.config.permissions.feishu.network.enabled).toBe(true);
      });
    });
  }

  it('fail-closed on Linux/WSL: qa/write throw (reads not confined there), full still works', () => {
    withPlatform('linux', () => {
      expect(() => sandboxParams('qa', false)).toThrow();
      expect(() => sandboxParams('write', false)).toThrow();
      expect(sandboxParams('full', false)).toEqual({ sandbox: 'danger-full-access' });
    });
  });
});

describe('group settings card', () => {
  // s12: auto-compaction is always on. A row stored with autoCompact:false reads
  // like any other: no toggle, no off state.
  const stored = JSON.parse('{"name":"P","kind":"multi","origin":"created","autoCompact":false}') as Project;
  it('has no auto-compact toggle, even for a project stored with it off', () => {
    for (const project of [{ name: 'P', kind: 'multi' as const, origin: 'created' as const }, stored]) {
      const json = JSON.stringify(buildGroupSettingsCard(project));
      expect(json).not.toContain('gs.autoCompact');
      expect(json).not.toContain('自动压缩');
    }
  });
  it('says the switch is gone when re-rendered after a tap on an old toggle', () => {
    expect(JSON.stringify(buildGroupSettingsCard(stored, AUTO_COMPACT_RETIRED))).toContain('自动压缩现在一直开着');
  });
});

describe('permission cards', () => {
  // The project settings card opens the 🔐 权限 form sub-card (buildPermissionCard);
  // the tier choice is a dropdown (select_static in a form), not live buttons.
  it('project settings card shows the 🔐 权限 entry + a tier summary', () => {
    const json = JSON.stringify(
      buildProjectSettingsCard({ name: 'P', cwd: '/x', kind: 'multi', origin: 'created', mode: 'full', guestMode: 'qa', network: false }),
    );
    expect(json).toContain('dm.proj.perm'); // 🔐 权限 button → opens the form
    expect(json).toContain('"n":"P"');
    expect(json).toContain('管理员'); // split summary mentions both roles
    expect(json).toContain('其他人');
  });

  it('project settings card has no auto-compact toggle (s12), even for a project stored with it off', () => {
    const stored = JSON.parse('{"name":"P","cwd":"/x","kind":"multi","origin":"created","mode":"full","autoCompact":false}') as Project;
    const json = JSON.stringify(buildProjectSettingsCard(stored));
    expect(json).not.toContain('dm.proj.autoCompact');
    expect(json).not.toContain('自动压缩');
    expect(JSON.stringify(buildProjectSettingsCard(stored, undefined, AUTO_COMPACT_RETIRED))).toContain('自动压缩现在一直开着');
  });

  it('permission form has admin + guest tier dropdowns, network, submit, and pre-selects current tiers', () => {
    const json = JSON.stringify(buildPermissionCard({ name: 'P', mode: 'full', guestMode: 'qa', network: false }));
    // two tier selects (select_static inside a form), by name
    expect(json).toContain('"name":"mode"');
    expect(json).toContain('"name":"guestMode"');
    expect(json).toContain('"name":"network"');
    expect(json).toContain('select_static');
    expect(json).toContain('"tag":"form"');
    // tiers listed + submit carries the project name
    expect(json).toContain('项目内只读');
    expect(json).toContain('完全访问');
    expect(json).toContain('dm.proj.perm.submit');
    expect(json).toContain('"n":"P"');
    // current tiers pre-selected (initial_option)
    expect(json).toContain('"initial_option":"full"'); // admin
    expect(json).toContain('"initial_option":"qa"'); // guest
  });

  it('unset guestMode pre-selects the admin tier for the guest dropdown (no split)', () => {
    const json = JSON.stringify(buildPermissionCard({ name: 'P', mode: 'qa', network: true }));
    expect(json).toContain('"initial_option":"on"'); // network
    // both dropdowns default to qa (guest falls back to admin tier)
    expect((json.match(/"initial_option":"qa"/g) ?? []).length).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { effectiveMode, type Project } from '../src/project/registry';
import { CodexAppServerBackend, sandboxParams } from '../src/agent/codex-appserver/backend';
import { CODEX_FULL_ONLY, CodexFullOnlyError } from '../src/agent/codex-appserver/full-only';
import { AUTO_COMPACT_RETIRED, buildGroupSettingsCard, buildPermissionCard, buildProjectSettingsCard, PERMISSION_CARD_VERSION } from '../src/card/dm-cards';

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

  // qa/write read-confinement is enforceable only on macOS (Seatbelt): assert the profile shape there.
  it('darwin: qa → read-only confined to workspace, network off', () => {
    withPlatform('darwin', () => {
      const p = sandboxParams('qa', false) as any;
      expect(p.sandbox).toBeUndefined();
      expect(p.config.default_permissions).toBe('feishu');
      const fs = p.config.permissions.feishu.filesystem;
      expect(fs[':minimal']).toBe('read');
      expect(fs[':workspace_roots']['.']).toBe('read');
      expect(p.config.permissions.feishu.network.enabled).toBe(false);
    });
  });
  it('darwin: write → workspace write + network honored', () => {
    withPlatform('darwin', () => {
      const p = sandboxParams('write', true) as any;
      expect(p.config.permissions.feishu.filesystem[':workspace_roots']['.']).toBe('write');
      expect(p.config.permissions.feishu.network.enabled).toBe(true);
    });
  });

  it('fail-closed elsewhere: qa/write throw CodexFullOnlyError before spawn (reads not confined), full still works', () => {
    for (const plat of ['linux', 'win32'] as const) {
      withPlatform(plat, () => {
        expect(() => sandboxParams('qa', false)).toThrow(CodexFullOnlyError);
        expect(() => sandboxParams('write', true)).toThrow(CodexFullOnlyError);
        expect(sandboxParams('full', false)).toEqual({ sandbox: 'danger-full-access' });
      });
      expect(() => sandboxParams('qa', false, plat)).toThrow('Linux 上的 Codex 只能用完全访问');
    }
  });

  it('the Codex backend says it is full-only everywhere but macOS', () => {
    const backend = new CodexAppServerBackend();
    expect(withPlatform('darwin', () => backend.fullAccessOnly())).toBeUndefined();
    for (const plat of ['linux', 'win32'] as const) expect(withPlatform(plat, () => backend.fullAccessOnly())).toBe(CODEX_FULL_ONLY);
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
  it('project settings card shows the 🔐 权限 entry + the one tier everyone uses', () => {
    const json = JSON.stringify(
      buildProjectSettingsCard({ name: 'P', cwd: '/x', kind: 'multi', origin: 'created', mode: 'qa', network: false }),
    );
    expect(json).toContain('dm.proj.perm'); // 🔐 权限 button → opens the form
    expect(json).toContain('"n":"P"');
    expect(json).toContain('当前 🔒 项目内只读　·　codex 沙箱可访问的范围，群里所有人都用这一档。');
    expect(json).not.toContain('其他人');
  });

  it('project settings card has no auto-compact toggle (s12), even for a project stored with it off', () => {
    const stored = JSON.parse('{"name":"P","cwd":"/x","kind":"multi","origin":"created","mode":"full","autoCompact":false}') as Project;
    const json = JSON.stringify(buildProjectSettingsCard(stored));
    expect(json).not.toContain('dm.proj.autoCompact');
    expect(json).not.toContain('自动压缩');
    expect(JSON.stringify(buildProjectSettingsCard(stored, undefined, AUTO_COMPACT_RETIRED))).toContain('自动压缩现在一直开着');
  });

  it('permission form has one tier dropdown, network, submit, and pre-selects the current tier', () => {
    const json = JSON.stringify(buildPermissionCard({ name: 'P', mode: 'full', network: false }));
    // one tier select (select_static inside a form), by name
    expect(json).toContain('"name":"mode"');
    expect(json).not.toContain('"name":"guestMode"');
    expect(json).not.toContain('普通用户');
    expect(json).toContain('群里所有人都用这一档');
    expect(json).toContain('"name":"network"');
    expect(json).toContain('select_static');
    expect(json).toContain('"tag":"form"');
    // tiers listed + submit carries the project name and the card's version (a card from before s15c has none)
    expect(json).toContain('项目内只读');
    expect(json).toContain('完全访问');
    expect(json).toContain('dm.proj.perm.submit');
    expect(json).toContain('"n":"P"');
    expect(json).toContain(`"v":${PERMISSION_CARD_VERSION}`);
    // current tier pre-selected (initial_option)
    expect(json).toContain('"initial_option":"full"');
  });

  it('pre-selects a stored 只读 and the network switch', () => {
    const json = JSON.stringify(buildPermissionCard({ name: 'P', mode: 'qa', network: true }));
    expect(json).toContain('"initial_option":"on"'); // network
    expect((json.match(/"initial_option":"qa"/g) ?? []).length).toBe(1);
  });

  it('a full-only backend offers only 完全访问 and says why', () => {
    const json = JSON.stringify(buildPermissionCard({ name: 'P', mode: 'qa', network: false }, CODEX_FULL_ONLY));
    expect(json).not.toContain('"value":"qa"');
    expect(json).not.toContain('"value":"write"');
    expect((json.match(/"value":"full"/g) ?? []).length).toBe(1);
    expect(json).toContain('现在是🔒 项目内只读。');
    expect(json).toContain(CODEX_FULL_ONLY);
  });

  it('a full-only backend presets only a stored 完全访问, so a save that leaves the dropdown alone keeps the stored tier', () => {
    const tiers = (p: Parameters<typeof buildPermissionCard>[0]) => {
      const form = (buildPermissionCard(p, CODEX_FULL_ONLY) as any).body.elements.find((e: any) => e.tag === 'form');
      return form.elements.filter((e: any) => e.name === 'mode' || e.name === 'guestMode')
        .map((e: any) => ({ name: e.name, initial: e.initial_option, placeholder: e.placeholder.content }));
    };
    expect(tiers({ name: 'P', mode: 'write', network: false })).toEqual([
      { name: 'mode', initial: undefined, placeholder: '现在是✏️ 项目内读写，不选就不改' },
    ]);
    expect(tiers({ name: 'P', mode: 'full', network: false })).toMatchObject([{ name: 'mode', initial: 'full' }]);
  });
});

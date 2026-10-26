import { describe, expect, it, vi } from 'vitest';
import { effectiveMode, type Project } from '../src/project/registry';
import { CodexAppServerBackend, sandboxParams } from '../src/agent/codex-appserver/backend';
import { codexFullOnlyReason, CodexFullOnlyError } from '../src/agent/codex-appserver/full-only';
import { AUTO_COMPACT_RETIRED, buildGroupSettingsCard, buildPermissionCard, buildProjectSettingsCard, PERMISSION_CARD_VERSION } from '../src/card/dm-cards';
import { permissionTable, type TableEnv } from '../src/agent/permission';

vi.mock('../src/agent/codex-appserver/locate', () => ({ resolveCodexBin: () => '/fixture/codex', cachedCodexVersion: () => undefined }));
const CODEX_FULL_ONLY = codexFullOnlyReason('codex-cli 0.162.0');

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

  // Assert the native macOS profile independently of the Linux version gate.
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
      expect(p.config.permissions.feishu.filesystem[':workspace_roots']['.']).toBe('read');
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
      expect(() => sandboxParams('qa', false, plat)).toThrow('测不出 Codex 的版本');
    }
  });

  it('the Codex backend defers the final check when the version cache is empty', () => {
    const backend = new CodexAppServerBackend();
    expect(withPlatform('darwin', () => backend.fullAccessOnly())).toBeUndefined();
    for (const plat of ['linux', 'win32'] as const) expect(withPlatform(plat, () => backend.fullAccessOnly())).toBeUndefined();
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
  const table = permissionTable('codex-appserver');
  const env: TableEnv = { platform: 'darwin' };
  const render = (p: Parameters<typeof buildPermissionCard>[0], context = env) => buildPermissionCard(p, table, context);
  // The project settings card opens the 🔐 权限 form sub-card (buildPermissionCard);
  // the tier choice is a dropdown (select_static in a form), not live buttons.
  it('project settings card shows the 🔐 权限 entry + the one tier everyone uses', () => {
    const json = JSON.stringify(
      buildProjectSettingsCard({ name: 'P', cwd: '/x', kind: 'multi', origin: 'created', mode: 'qa', network: false }),
    );
    expect(json).toContain('dm.proj.perm'); // 🔐 权限 button → opens the form
    expect(json).toContain('"n":"P"');
    expect(json).toContain('当前 只读　·　群里所有人都用这一档。');
    expect(json).not.toContain('其他人');
  });

  it('project settings card has no auto-compact toggle (s12), even for a project stored with it off', () => {
    const stored = JSON.parse('{"name":"P","cwd":"/x","kind":"multi","origin":"created","mode":"full","autoCompact":false}') as Project;
    const json = JSON.stringify(buildProjectSettingsCard(stored));
    expect(json).not.toContain('dm.proj.autoCompact');
    expect(json).not.toContain('自动压缩');
    expect(JSON.stringify(buildProjectSettingsCard(stored, undefined, AUTO_COMPACT_RETIRED))).toContain('自动压缩现在一直开着');
  });

  it('permission form has one tier dropdown, no network switch, and pre-selects the current tier', () => {
    const json = JSON.stringify(render({ name: 'P', mode: 'full', network: false }));
    // one tier select (select_static inside a form), by name
    expect(json).toContain('"name":"mode"');
    expect(json).not.toContain('"name":"guestMode"');
    expect(json).not.toContain('普通用户');
    expect(json).toContain('群里所有人都用这一档');
    expect(json).not.toContain('"name":"network"');
    expect(json).not.toContain('联网开关');
    expect(json).toContain('select_static');
    expect(json).toContain('"tag":"form"');
    // tiers listed + submit carries the project name and the card's version (a card from before s15c has none)
    expect(json).toContain('只读 — 能看工作区，不改文件，不联网。');
    expect(json).toContain('工作区可写 — 能改工作区里的文件，能联网。');
    expect(json).toContain('完全访问');
    expect(json).toContain('dm.proj.perm.submit');
    expect(json).toContain('"n":"P"');
    expect(json).toContain(`"v":${PERMISSION_CARD_VERSION}`);
    // current tier pre-selected (initial_option)
    expect(json).toContain('"initial_option":"full"');
  });

  it.each([
    { name: 'P', mode: 'qa' as const, network: true },
    { name: 'P', mode: 'full' as const, custom: { backend: 'codex-appserver', settings: { sandbox: 'read-only', network: true } } },
  ])('leaves legacy and explicit custom permissions unselected', p => {
    const json = JSON.stringify(render(p));
    expect(json).toContain('现在是自定义：沙箱模式：只读（read-only）；网络：开');
    expect(json).toContain('选一档就回到那一档；不选就不改');
    expect(json).not.toContain('initial_option');
    expect(JSON.stringify(buildProjectSettingsCard({ ...p, cwd: '/x', kind: 'multi', origin: 'created' })))
      .toContain('当前 自定义（沙箱模式：只读（read-only）；网络：开）');
  });

  it('shows corrupt custom settings as read-only and does not preselect the stored full tier', () => {
    const p = { name: 'P', mode: 'full' as const, custom: { backend: 'codex-appserver', settings: { sandbox: 'invalid' } } };
    const json = JSON.stringify(render(p));
    expect(json).toContain('高级设置读不出来，现在按只读跑。选一档重新设置。');
    expect(json).not.toContain('initial_option');
    expect(JSON.stringify(buildProjectSettingsCard({ ...p, cwd: '/x', kind: 'multi', origin: 'created' })))
      .toContain('当前 高级设置读不出来，现在按只读跑');
  });

  it('a full-only backend offers only 完全访问 and says why', () => {
    const json = JSON.stringify(render({ name: 'P', mode: 'qa', network: false }, { platform: 'linux', fullOnly: CODEX_FULL_ONLY }));
    expect(json).not.toContain('"value":"qa"');
    expect(json).not.toContain('"value":"write"');
    expect((json.match(/"value":"full"/g) ?? []).length).toBe(1);
    expect(json).toContain('现在是只读。');
    expect(json).toContain(CODEX_FULL_ONLY);
  });

  it('a full-only backend presets only a stored 完全访问, so a save that leaves the dropdown alone keeps the stored tier', () => {
    const tiers = (p: Parameters<typeof buildPermissionCard>[0]) => {
      const form = (render(p, { platform: 'linux', fullOnly: CODEX_FULL_ONLY }) as any).body.elements.find((e: any) => e.tag === 'form');
      return form.elements.filter((e: any) => e.name === 'mode' || e.name === 'guestMode')
        .map((e: any) => ({ name: e.name, initial: e.initial_option, placeholder: e.placeholder.content }));
    };
    expect(tiers({ name: 'P', mode: 'write', network: true })).toEqual([
      { name: 'mode', initial: undefined, placeholder: '现在是工作区可写，不选就不改' },
    ]);
    expect(tiers({ name: 'P', mode: 'full', network: false })).toMatchObject([{ name: 'mode', initial: 'full' }]);
  });
});

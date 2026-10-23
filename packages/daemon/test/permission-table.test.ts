import { describe, expect, it } from 'vitest';
import { permissionFieldSchema, permissionOptionsSchema } from '@vonvon/protocol';
import {
  PermissionInputError, TIER_NAMES, TIER_NETWORK, TIER_SUMMARY,
  permissionTable, tableEnv, tierInfo, unavailableTierReply,
} from '../src/agent/permission';

const mac = { platform: 'darwin' } as const;
const codex = permissionTable('codex-appserver');
const claude = permissionTable('claude-agent');
const generic = permissionTable('fixture-provider');

describe('provider 权限表', () => {
  it.each([codex, claude])('$backend 高级字段有中文名，一档展开可解析并折叠回原档', table => {
    for (const tier of ['qa', 'write', 'full'] as const) {
      expect(table.parseCustom(table.expand(tier))).toEqual(table.expand(tier));
      expect(table.matchTier(table.expand(tier))).toBe(tier);
    }
    for (const field of table.fields(mac)) {
      expect(field.label).toMatch(/[\u4e00-\u9fff]/);
      expect(table.expand('write')).toHaveProperty(field.key);
      expect(permissionFieldSchema.parse(field)).toEqual(field);
    }
  });
  it('协议拒绝高级字段和展开表里的额外结构键', () => {
    const field = claude.fields(mac)[0]!;
    expect(permissionFieldSchema.safeParse({ ...field, extra: true }).success).toBe(false);
    expect(permissionFieldSchema.safeParse({ ...field, choices: [{ ...field.choices![0], extra: true }] }).success).toBe(false);
    expect(permissionFieldSchema.safeParse({ ...field, showWhen: { key: 'network', in: ['domains'], extra: true } }).success).toBe(false);
    const value = { tiers: [...claude.tiers(mac)], strength: claude.strength(mac), fields: claude.fields(mac), expanded: { qa: claude.expand('qa'), write: claude.expand('write'), full: claude.expand('full') } };
    expect(permissionOptionsSchema.parse(value)).toEqual(value);
    expect(permissionOptionsSchema.safeParse({ ...value, expanded: { ...value.expanded, extra: {} } }).success).toBe(false);
  });
  it('Codex 的沙箱字段携带不可用原因，网络只在非完全访问时显示', () => {
    expect(codex.fields({ platform: 'linux', fullOnly: '原因' })[0]?.choices?.map(choice => choice.hint)).toEqual(['原因', '原因', TIER_SUMMARY.full]);
    expect(codex.fields(mac)[0]?.choices?.map(choice => choice.hint)).toEqual(['能看工作区，不改文件。', '能改工作区里的文件。', TIER_SUMMARY.full]);
    expect(codex.fields(mac)[1]?.showWhen).toEqual({ key: 'sandbox', in: ['read-only', 'workspace-write'] });
    expect(claude.fields(mac)[0]?.choices?.map(choice => choice.value)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
  });
  it.each([codex, claude, generic])('$backend 的档名相同、中文且不超过五字，顺序和联网固定', table => {
    expect(table.tiers(mac).map(info => info.tier)).toEqual(['qa', 'write', 'full']);
    for (const info of table.tiers(mac)) {
      expect(info.name).toBe(TIER_NAMES[info.tier]);
      expect(info.name).toMatch(/^[\u4e00-\u9fff]{1,5}$/);
      expect(info.summary).toBe(TIER_SUMMARY[info.tier]);
      expect(info.unavailable).toBeUndefined();
    }
    expect(TIER_NETWORK).toEqual({ qa: false, write: true, full: true });
  });
  it('原名和能挡到什么按 provider 展开', () => {
    expect(codex.tiers(mac).map(info => info.native)).toEqual([
      'Codex：Read Only（read-only 沙箱）',
      'Codex：Default（workspace-write），比 Codex 自带的多开了网络',
      'Codex：Full Access（danger-full-access）',
    ]);
    expect(claude.tiers(mac).map(info => info.native)).toEqual([
      'Claude：Manual（default 模式），命令在沙箱里',
      'Claude：Edit automatically（acceptEdits 模式），命令在沙箱里',
      'Claude：Bypass permissions（bypassPermissions）',
    ]);
    expect(generic.backend).toBe('fixture-provider');
    expect(generic.tiers(mac).map(info => info.native)).toEqual(['', '', '']);
    expect(codex.strength(mac)).toBe('系统沙箱管住命令的读、写和联网：工作区以外的文件读不到，也改不了。');
    expect(codex.strength({ platform: 'linux', fullOnly: '原因' })).toBe('原因');
    expect(claude.strength(mac)).toBe('命令在系统沙箱里跑，改不了工作区以外的文件；工作区以外的文件读得到，包括别的群的记忆。');
    expect(generic.strength(mac)).toBe('这个 provider 没有说明它能挡到什么程度。');
  });
  it.each([codex, claude, generic])('$backend 共用可用性规则', table => {
    expect(table.tiers({ platform: 'linux', fullOnly: '原因' }).map(info => info.unavailable)).toEqual(['原因', '原因', undefined]);
    expect(table.tiers({ ...mac, supportedModes: ['full'] }).map(info => info.unavailable)).toEqual([
      '这个 provider 没有这一档。', '这个 provider 没有这一档。', undefined,
    ]);
  });
  it('读取后端约束时保留方法的 this，tierInfo 按档查找', () => {
    const backend = { supportedModes: ['full'] as const, fullAccessOnly() { return this.supportedModes[0]; } };
    expect(tableEnv(backend, 'linux')).toEqual({ platform: 'linux', supportedModes: ['full'], fullOnly: 'full' });
    expect(tableEnv({}, 'darwin')).toEqual({ platform: 'darwin' });
    expect(tierInfo(codex, mac, 'write')).toEqual(codex.tiers(mac)[1]);
  });
});

it('Linux 原生沙箱按版本开放权限，并说明不存在配置路径的保护范围', () => {
  const supported = { platform: 'linux', codexVersion: 'codex-cli 0.163.0' } as const;
  expect(codex.tiers(supported).map(row => row.unavailable)).toEqual([undefined, undefined, undefined]);
  expect(codex.strength(supported)).toContain('工作区里原来没有的 .mcp.json、.claude/ 这类配置，能被新建。');
  for (const codexVersion of ['codex-cli 0.162.0', 'codex-cli 0.163.0-alpha.1', null]) {
    const rows = codex.tiers({ platform: 'linux', codexVersion });
    const reason = codexVersion === null ? '测不出 Codex 的版本' : '0.163.0 正式版以上';
    expect(rows[0].unavailable).toContain(reason);
    expect(rows[1].unavailable).toContain(reason);
    if (codexVersion) expect(rows[0].unavailable).toContain(codexVersion);
    expect(rows[2].unavailable).toBeUndefined();
  }
});

describe('Codex 自定义', () => {
  it('严格校验，补网络默认值，返回新对象', () => {
    const raw = { sandbox: 'read-only', network: true };
    expect(codex.parseCustom(raw)).toEqual(raw);
    expect(codex.parseCustom(raw)).not.toBe(raw);
    expect(codex.parseCustom({ sandbox: 'read-only' })).toEqual({ sandbox: 'read-only', network: false });
    for (const value of [null, [], 'read-only', {}, { ...raw, extra: true }, { sandbox: 'x' }, { sandbox: 'read-only', network: 'yes' }]) {
      expect(() => codex.parseCustom(value)).toThrow(PermissionInputError);
      expect(() => codex.parseCustom(value)).toThrow(/必须/);
    }
  });
  it.each([
    ['read-only', false, 'qa'], ['read-only', true, undefined],
    ['workspace-write', false, undefined], ['workspace-write', true, 'write'],
    ['danger-full-access', false, 'full'], ['danger-full-access', true, 'full'],
  ])('%s/%s 的等价档和执行效果', (sandbox, network, tier) => {
    const settings = { sandbox, network };
    expect(codex.matchTier(settings)).toBe(tier);
    expect(codex.effect(settings)).toEqual({ mode: sandbox === 'read-only' ? 'qa' : sandbox === 'workspace-write' ? 'write' : 'full', network: sandbox === 'danger-full-access' || network });
  });
  it('中文说明、完全访问忽略网络、旧值转换', () => {
    expect(codex.describe({ sandbox: 'read-only', network: true })).toBe('沙箱模式：只读（read-only）；网络：开');
    expect(codex.describe({ sandbox: 'workspace-write', network: false })).toBe('沙箱模式：工作区可写（workspace-write）；网络：关');
    expect(codex.describe({ sandbox: 'danger-full-access', network: false })).toBe('沙箱模式：完全访问（danger-full-access）');
    expect(codex.fromLegacy('qa', true)).toEqual({ sandbox: 'read-only', network: true });
    expect(codex.fromLegacy('write', false)).toEqual({ sandbox: 'workspace-write', network: false });
  });
});

describe('Claude 自定义', () => {
  it('严格校验，补网络默认值，返回新对象', () => {
    const raw = { permissionMode: 'default', network: 'all' };
    expect(claude.parseCustom(raw)).toEqual({ ...raw, sandbox: true, domains: [] });
    expect(claude.parseCustom(raw)).not.toBe(raw);
    expect(claude.parseCustom({ permissionMode: 'default' })).toEqual({ permissionMode: 'default', network: 'off', sandbox: true, domains: [] });
    expect(claude.parseCustom({ permissionMode: 'acceptEdits', network: 'off' })).toMatchObject({ sandbox: true, domains: [] });
    expect(claude.parseCustom({ permissionMode: 'bypassPermissions' })).toMatchObject({ sandbox: false });
    for (const value of [null, [], 'default', {}, { ...raw, extra: true }, { permissionMode: 'dontAsk' }, { permissionMode: 'default', network: true }]) {
      expect(() => claude.parseCustom(value)).toThrow(PermissionInputError);
      expect(() => claude.parseCustom(value)).toThrow(/必须/);
    }
  });
  it.each([
    ['default', 'off', 'qa'], ['default', 'all', undefined],
    ['acceptEdits', 'off', undefined], ['acceptEdits', 'all', 'write'],
    ['bypassPermissions', 'all', 'full'],
  ])('%s/%s 的等价档和执行效果', (permissionMode, network, tier) => {
    const settings = { permissionMode, network };
    expect(claude.matchTier(settings)).toBe(tier);
    expect(claude.effect(settings)).toEqual({ mode: permissionMode === 'default' ? 'qa' : permissionMode === 'acceptEdits' ? 'write' : 'full', network: permissionMode === 'bypassPermissions' || network === 'all' });
  });
  it('中文说明、完全访问忽略网络、旧值转换', () => {
    expect(claude.describe({ permissionMode: 'default', network: 'all' })).toBe('权限模式：手动确认（default）；命令沙箱：开；网络：全部');
    expect(claude.describe({ permissionMode: 'acceptEdits', network: 'off' })).toBe('权限模式：自动接受编辑（acceptEdits）；命令沙箱：开；网络：关');
    expect(claude.describe({ permissionMode: 'bypassPermissions' })).toBe('权限模式：跳过权限检查（bypassPermissions）；命令沙箱：关');
    expect(claude.fromLegacy('qa', true)).toEqual({ permissionMode: 'default', network: 'all', sandbox: true, domains: [] });
    expect(claude.fromLegacy('write', false)).toEqual({ permissionMode: 'acceptEdits', network: 'off', sandbox: true, domains: [] });
  });
  it('网站名单规范化、去重，其他网络模式清空名单，非法名单拒绝', () => {
    const raw = { permissionMode: 'default', network: 'domains', domains: [' GitHub.com ', 'github.com', '*.npmjs.org'] };
    expect(claude.parseCustom(raw)).toMatchObject({ domains: ['github.com', '*.npmjs.org'], sandbox: true });
    expect(claude.parseCustom({ ...raw, network: 'off' })).toMatchObject({ domains: [] });
    expect(() => claude.parseCustom({ ...raw, domains: [] })).toThrow('只允许这些网站时，至少写一个网站。');
    for (const domains of [['a b'], ['https://github.com'], ['localhost'], ['*.'], Array(51).fill('github.com')]) expect(() => claude.parseCustom({ ...raw, domains })).toThrow(PermissionInputError);
    expect(claude.effect(raw)).toEqual({ mode: 'qa', network: true });
    expect(claude.describe({ ...raw, permissionMode: 'plan' })).toBe('权限模式：先出方案（plan）；命令沙箱：开；网络：只允许 github.com 等 2 个网站');
  });
  it.each(['plan', 'auto'] as const)('%s 的新组合不折叠，执行效果和降级存盘分开', permissionMode => {
    for (const network of ['off', 'all', 'domains']) {
      const value = { permissionMode, sandbox: true, network, domains: ['github.com'] };
      expect(claude.matchTier(value)).toBeUndefined();
      expect(claude.effect(value)).toEqual({ mode: 'write', network: network !== 'off' });
      expect(claude.stored?.(value)).toEqual({ mode: permissionMode === 'plan' ? 'qa' : 'write', network: network !== 'domains' && network !== 'off' });
    }
    expect(claude.matchTier({ permissionMode, sandbox: false })).toBeUndefined();
  });
  it.each([true, false])('跳过权限检查的沙箱 %s 只接受不限网络和空名单', sandbox => {
    for (const network of [undefined, 'all']) {
      const value = { permissionMode: 'bypassPermissions', sandbox, network, domains: [] };
      expect(claude.parseCustom(value)).toMatchObject({ network: 'all', domains: [] });
      expect(claude.matchTier(value)).toBe(sandbox ? undefined : 'full');
      expect(claude.effect(value)).toEqual({ mode: 'full', network: true });
      expect(claude.stored?.(value)).toEqual({ mode: sandbox ? 'write' : 'full', network: true });
    }
    for (const patch of [{ network: 'off' }, { network: 'domains', domains: ['github.com'] }, { network: 'all', domains: ['github.com'] }, { domains: ['github.com'] }])
      expect(() => claude.parseCustom({ permissionMode: 'bypassPermissions', sandbox, ...patch })).toThrow('跳过权限检查时不限网络，不能设网络');
  });
});

describe('通用表和不可用档回复', () => {
  it('通用表没有自定义，不猜原生设置', () => {
    expect(() => generic.parseCustom({})).toThrow('这个 provider 没有高级设置。');
    expect(() => generic.parseCustom({})).toThrow(PermissionInputError);
    expect(generic.fromLegacy('write', false)).toBeUndefined();
    expect(generic.matchTier({})).toBeUndefined();
    expect(generic.fields(mac)).toEqual([]);
    expect(generic.expand('write')).toEqual({});
  });
  it('优先最近的更高可用档，并保留可选的 bot 参数', () => {
    const reply = unavailableTierReply('fixture-group', codex, { platform: 'linux', fullOnly: '只能选完全访问。' }, 'qa', 'fixture-bot');
    expect(reply).toBe('ℹ️ 这一轮没有开始：这个群的权限是「只读」，只能选完全访问。\n请 bot 的主人在群设置里换成「完全访问」，或者在终端运行 `vonvon settings set --bot fixture-bot --group fixture-group permission.mode=full`。');
    expect(unavailableTierReply('fixture-group', generic, { ...mac, supportedModes: ['write', 'full'] }, 'qa')).toContain('permission.mode=write');
    expect(unavailableTierReply('fixture-group', generic, { ...mac, supportedModes: ['qa', 'full'] }, 'write')).toContain('permission.mode=full');
  });
  it('没有更高档时建议最近的更低可用档，没有任何可用档时不推荐无效设置', () => {
    expect(unavailableTierReply('fixture-group', generic, { ...mac, supportedModes: ['qa', 'write'] }, 'full')).toContain('permission.mode=write');
    expect(unavailableTierReply('fixture-group', generic, { ...mac, supportedModes: [] }, 'write')).not.toContain('permission.mode=');
    expect(unavailableTierReply('fixture-group', codex, mac, 'qa')).toBe('');
  });
});

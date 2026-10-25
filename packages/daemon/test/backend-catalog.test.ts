import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKEND_CATALOG,
  catalogBackendIds,
  catalogById,
  catalogByFamily,
  CLAUDE_AGENT_SDK_VERSION,
  isInstallable,
  projectCreatableBackends,
  visibleCatalog,
} from '../src/agent/catalog';
import { backendIds, createBackend } from '../src/agent';
import {
  BackendNotInstalledError,
  isBackendDepInstalled,
  installedBackendVersion,
  loadBackendDep,
} from '../src/agent/backend-loader';
import { buildInstallCommand, stripVersion } from '../src/agent/installer';
import { paths } from '../src/config/paths';

/**
 * 棒A 地基：catalog↔REGISTRY 配对、按需加载器三路径、installer 命令构建（不真跑
 * npm）、智能默认规则、ensureAnyAgent 放行。Claude SDK 由用户选择后托管安装。
 */

describe('catalog ↔ REGISTRY 配对（防漏注册）', () => {
  it('catalogBackendIds == backendIds（两处都注册才不红）', () => {
    expect([...catalogBackendIds()].sort()).toEqual([...backendIds()].sort());
  });

  it('每条 catalog id 都能 createBackend 出一个实例（工厂存在）', () => {
    for (const entry of BACKEND_CATALOG) {
      const be = createBackend(entry.id);
      expect(be.id).toBe(entry.id);
    }
  });

  it('catalog 的 supportedModes 与 backend 实例声明一致', () => {
    for (const entry of BACKEND_CATALOG) {
      const be = createBackend(entry.id);
      expect(entry.supportedModes).toEqual(be.supportedModes);
    }
  });

  it('codex 是 external-cli（bridge 不负责装，doctor 探 PATH）', () => {
    expect(catalogById('codex-appserver')?.dep.kind).toBe('external-cli');
  });

  it('Claude SDK 是用户可选择的按需下载后端', () => {
    const entry = catalogById('claude-agent')!;
    expect(entry.dep.kind).toBe('npm-ondemand');
    expect(isInstallable(entry)).toBe(true);
    expect(entry.blurb).toContain('按需下载');
  });

  it('external-cli（codex）不可一键下载（isInstallable=false）', () => {
    expect(isInstallable(catalogById('codex-appserver')!)).toBe(false);
  });

  it('catalogByFamily 分组：codex 组 / claude 组各 1 条', () => {
    expect(catalogByFamily('codex').map((e) => e.id)).toEqual(['codex-appserver']);
    expect(catalogByFamily('claude').map((e) => e.id)).toEqual(['claude-agent']);
  });
});

describe('projectCreatableBackends —— 飞书新建/绑定卡的「可选后端」过滤（创建时选定）', () => {
  const ids = (mode: 'qa' | 'write' | 'full', inst: (e: { id: string }) => boolean) =>
    projectCreatableBackends(mode, inst).map((e) => e.id);

  it('codex 是默认基线 → 即便都「未下载」也始终可选；claude-agent 未装则不出现', () => {
    expect(ids('full', () => false)).toEqual(['codex-appserver']);
  });

  it('qa 档（外部群）→ codex + 已装的 claude-agent 都可选（两者都支持 qa 档）', () => {
    expect(ids('qa', () => true)).toEqual(['codex-appserver', 'claude-agent']);
  });

  it('任意权限档：codex 恒在；claude-agent 仅在「已装」时出现（按下载态过滤）', () => {
    for (const mode of ['qa', 'write', 'full'] as const) {
      expect(ids(mode, () => true)).toEqual(['codex-appserver', 'claude-agent']);
      expect(ids(mode, () => false)).toEqual(['codex-appserver']);
    }
  });
});

describe('可见 catalog 与注册派生（codex + claude-agent）', () => {
  it('visibleCatalog() 含 codex 与 claude-agent（Web 后端页 / 体检页 / picker 数据源）', () => {
    expect(visibleCatalog().map((e) => e.id)).toEqual(['codex-appserver', 'claude-agent']);
  });

  it('Claude Agent SDK 锁一个版本，开发依赖锁同一个（3.11）', () => {
    expect(catalogById('claude-agent')?.dep.version).toBe(CLAUDE_AGENT_SDK_VERSION);
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> };
    expect(manifest.devDependencies['@anthropic-ai/claude-agent-sdk']).toBe(CLAUDE_AGENT_SDK_VERSION);
  });

  it('catalogBackendIds 与 REGISTRY 配对不破（两条）', () => {
    expect([...catalogBackendIds()].sort()).toEqual(['claude-agent', 'codex-appserver']);
    // 工厂存在：两个 id 都能构造出实例。
    expect(createBackend('codex-appserver').id).toBe('codex-appserver');
    expect(createBackend('claude-agent').id).toBe('claude-agent');
  });

  it('createBackend 未注册 id 仍抛错（错误信息含 codex-appserver）', () => {
    expect(() => createBackend('no-such-backend')).toThrow(/未知 agent 后端/);
    expect(() => createBackend('no-such-backend')).toThrow(/codex-appserver/);
  });
});

describe('backend-loader：按需依赖加载（三路径）', () => {
  const origBackendsDir = paths.backendsDir;
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'backends-'));
    paths.backendsDir = userDir;
  });
  afterEach(() => {
    paths.backendsDir = origBackendsDir;
    rmSync(userDir, { recursive: true, force: true });
  });

  it('① bridge 自身 node_modules 命中：bare import（dev/worktree 模式，不碰用户目录）', async () => {
    // cross-spawn 是 bridge 自身 dependency，必在 worktree node_modules —— 走第①条。
    // 用户目录是空临时目录，证明根本没用到它（第①条就命中了）。
    const mod = await loadBackendDep<{ default?: unknown }>('cross-spawn');
    expect(mod).toBeDefined();
    // cross-spawn 是 CJS 函数；ESM interop 下函数挂在 default（或模块本身）。
    expect(typeof (mod.default ?? mod)).toBe('function');
    expect(isBackendDepInstalled('cross-spawn')).toBe(true);
  });

  it('版本与实际加载顺序一致，SDK exports 隐藏 package.json 时仍读出本地包版本', async () => {
    const pkg = '@anthropic-ai/claude-agent-sdk';
    const userPkg = join(userDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    mkdirSync(userPkg, { recursive: true });
    writeFileSync(join(userPkg, 'package.json'), JSON.stringify({ name: pkg, version: '99.0.0' }));
    expect(installedBackendVersion(pkg)).toBe(CLAUDE_AGENT_SDK_VERSION);
  });

  it('② 用户私装目录解析：bridge 自身没有的包，从 backendsDir 加载', async () => {
    // 在临时用户目录里造一个 bridge 自身绝无的假包，证明走第②条（createRequire 锚 backendsDir）。
    const pkgName = 'fcb-fake-ondemand-pkg';
    const pkgDir = join(userDir, 'node_modules', pkgName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0', main: 'index.mjs' }));
    writeFileSync(join(pkgDir, 'index.mjs'), 'export const marker = "from-user-dir";\n');

    expect(isBackendDepInstalled(pkgName)).toBe(true);
    const mod = await loadBackendDep<{ marker: string }>(pkgName);
    expect(mod.marker).toBe('from-user-dir');
    expect(installedBackendVersion(pkgName)).toBe('1.0.0');
  });

  it('用户目录的 exports 隐藏 package.json 时仍能读取安装版本', () => {
    const pkgName = 'fcb-fake-exports-ondemand';
    const pkgDir = join(userDir, 'node_modules', pkgName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: pkgName, version: '2.1.0', exports: './index.mjs',
    }));
    writeFileSync(join(pkgDir, 'index.mjs'), 'export const marker = "exports";\n');
    expect(isBackendDepInstalled(pkgName)).toBe(true);
    expect(installedBackendVersion(pkgName)).toBe('2.1.0');
  });

  it('用户已装包的运行错误保留原错误，不误报成可以下载的未安装', async () => {
    const pkgName = 'fcb-fake-broken-ondemand';
    const pkgDir = join(userDir, 'node_modules', pkgName);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version: '1.0.0', main: 'index.mjs' }));
    writeFileSync(join(pkgDir, 'index.mjs'), 'throw new Error("fixture failed during initialization");\n');
    expect(isBackendDepInstalled(pkgName)).toBe(true);
    await expect(loadBackendDep(pkgName)).rejects.toThrow('fixture failed during initialization');
    await expect(loadBackendDep(pkgName)).rejects.not.toBeInstanceOf(BackendNotInstalledError);
  });

  it('③ 两处都没有：抛 BackendNotInstalledError（携带包名）', async () => {
    const ghost = 'fcb-definitely-not-installed-anywhere';
    expect(isBackendDepInstalled(ghost)).toBe(false);
    expect(installedBackendVersion(ghost)).toBeNull();
    await expect(loadBackendDep(ghost)).rejects.toBeInstanceOf(BackendNotInstalledError);
    await expect(loadBackendDep(ghost)).rejects.toMatchObject({ pkg: ghost });
  });
});

describe('installer：命令构建（不真跑 npm）', () => {
  it('buildInstallCommand：npm install <pkg> --prefix backendsDir --include=optional + 关进度', () => {
    const { command, args } = buildInstallCommand('@scope/some-ondemand-pkg@0.3.175', {
      prefix: '/u/backends',
      cacheDir: '/u/npm-cache',
    });
    expect(command).toBe('npm');
    expect(args).toContain('install');
    expect(args).toContain('@scope/some-ondemand-pkg@0.3.175');
    expect(args).toContain('--include=optional');
    expect(args).toContain('--no-progress'); // 关 npm 进度条避免流里乱码
    // 用默认 --save（多后端共存靠 package.json 记账；--no-save 会 prune 掉其它后端 → 互斥）
    expect(args).not.toContain('--no-save');
    const i = args.indexOf('--prefix');
    expect(args[i + 1]).toBe('/u/backends');
    const c = args.indexOf('--cache');
    expect(args[c + 1]).toBe('/u/npm-cache');
  });

  it('buildInstallCommand：可信的 npm-cli.js 由本进程的 Node 以 Node 模式执行', () => {
    const { command, args, env } = buildInstallCommand('some-pkg@1.0.0', {
      prefix: '/u/backends', cacheDir: '/u/npm-cache',
      npm: { command: process.execPath, args: ['/r/npm/bin/npm-cli.js'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    });
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 3)).toEqual(['/r/npm/bin/npm-cli.js', 'install', 'some-pkg@1.0.0']);
    expect(env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('buildInstallCommand 默认用 paths.backendsDir / npmCacheDir', () => {
    const { args } = buildInstallCommand('some-pkg');
    expect(args[args.indexOf('--prefix') + 1]).toBe(paths.backendsDir);
    expect(args[args.indexOf('--cache') + 1]).toBe(paths.npmCacheDir);
  });

  it('stripVersion：scoped/非 scoped 都正确去版本', () => {
    expect(stripVersion('@scope/some-ondemand-pkg@0.3.175')).toBe('@scope/some-ondemand-pkg');
    expect(stripVersion('@scope/some-ondemand-pkg')).toBe('@scope/some-ondemand-pkg');
    expect(stripVersion('nanoid@5.0.0')).toBe('nanoid');
    expect(stripVersion('nanoid')).toBe('nanoid');
  });
});

describe('按需依赖装没装的两态（isBackendDepInstalled）', () => {
  it('bridge 自身依赖可解析 → true；两处都没有的幽灵包 → false', () => {
    // 已装样例用仍在的 bridge 自身依赖（cross-spawn），不耦合已删后端的包名。
    expect(isBackendDepInstalled('cross-spawn')).toBe(true);
    expect(isBackendDepInstalled('fcb-definitely-not-installed-anywhere')).toBe(false);
  });
});

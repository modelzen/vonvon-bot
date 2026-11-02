import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { codexVersion, codexVersionAsync, resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { writeNodeExecutable } from './helpers/node-executable';
import { ProviderProcessCleanupError, ProviderProcessStoppedError } from '../src/agent/owned-process';

// locate 模块级缓存（QW-9）：bin/版本只在成功时缓存、force 强制重探、同步与
// 异步版本探测共享一份缓存。版本 fixture 在各平台运行真实子进程。

const dir = mkdtempSync(join(tmpdir(), 'locate-'));

/** 每次执行都追加计数，验证缓存命中时没有启动另一个进程。 */
function fakeBin(name: string, body: string): { bin: string; runs: () => number } {
  const { bin, script } = writeNodeExecutable(dir, name,
    `require('node:fs').appendFileSync(__filename + '.count', 'run\\n');\n${body}\n`);
  return {
    bin,
    runs: () => {
      try {
        return readFileSync(`${script}.count`, 'utf8').trim().split('\n').length;
      } catch {
        return 0;
      }
    },
  };
}

/** 跑一段代码时临时替换 CODEX_BIN（resolveCodexBin 的最高优先级探测分支）。 */
function withCodexBinEnv<T>(value: string, fn: () => T): T {
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveCodexBin 缓存', () => {
  it('显式覆盖立即生效；路径消失时不得回退到其它 Codex', () => {
    const a = join(dir, 'codex-a');
    const b = join(dir, 'codex-b');
    writeFileSync(a, '');
    writeFileSync(b, '');

    expect(withCodexBinEnv(a, () => resolveCodexBin({ force: true }))).toBe(a);
    expect(withCodexBinEnv(b, () => resolveCodexBin())).toBe(b);
    // force 绕过缓存 → 看到新 CODEX_BIN
    expect(withCodexBinEnv(b, () => resolveCodexBin({ force: true }))).toBe(b);
    // 缓存的 bin 被删 → existsSync 复验失败，自动重探
    rmSync(b);
    expect(withCodexBinEnv(b, () => resolveCodexBin())).toBeNull();
    expect(withCodexBinEnv(a, () => resolveCodexBin())).toBe(a);
  });
});

describe('codexVersion / codexVersionAsync 缓存', () => {
  it('成功结果缓存且同步/异步共享；force 重新 spawn', async () => {
    const { bin, runs } = fakeBin('codex with spaces 中文', 'console.log("fake-codex 9.9.9");');

    expect(codexVersion(bin)).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(1);
    // 第二次同步：缓存命中，零 spawn
    expect(codexVersion(bin)).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(1);
    // 异步路径共享同一缓存
    expect(await codexVersionAsync(bin)).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(1);
    // force（DM 体检）重新 spawn
    expect(await codexVersionAsync(bin, { force: true })).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(2);
  });

  it('失败（非零退出）返回 null 且不缓存，下次仍重探', async () => {
    const { bin, runs } = fakeBin('codex-bad', 'process.exit(3);');

    expect(codexVersion(bin)).toBeNull();
    expect(runs()).toBe(1);
    expect(await codexVersionAsync(bin)).toBeNull();
    expect(runs()).toBe(2);
    expect(codexVersion(bin)).toBeNull();
    expect(runs()).toBe(3);
  });

  it('bin 不存在时异步返回 null 而不抛', async () => {
    expect(await codexVersionAsync(join(dir, 'no-such-codex'))).toBeNull();
  });
});

describe('codexVersionAsync 真实子进程', () => {
  it('对 node 自身返回 --version 输出（跨平台冒烟）', async () => {
    expect(await codexVersionAsync(process.execPath, { force: true })).toBe(process.version);
  });
});

describe('desktop and Agent executable selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the daemon physical root, managed copy and generation pointer with explicit override priority', async () => {
    vi.stubEnv('VONVON_HOME', undefined);
    const { mkdirSync, existsSync, realpathSync } = await import('node:fs');
    const { resolveDataRoot } = await import('../src/config/data-root');
    const home = join(realpathSync(dir), 'legacy-home');
    const root = join(home, '.vonvon-bot');
    const generation = '12345678-1234-1234-1234-123456789012';
    const generationDir = join(root, 'codex-cli', 'releases', generation, 'node_modules', '.bin');
    mkdirSync(generationDir, { recursive: true });
    const legacy = writeNodeExecutable(generationDir, 'codex', 'console.log("codex-cli 1.0.0")').bin;
    writeFileSync(join(root, 'codex-cli', 'current.json'), JSON.stringify({ generation }));
    const context = { home, dataRoot: resolveDataRoot(home).path, env: { PATH: '' } };
    expect(resolveCodexBin(context)).toBe(legacy);
    const managedDir = join(root, 'managed-tools', 'bin');
    mkdirSync(managedDir, { recursive: true });
    const managed = writeNodeExecutable(managedDir, 'codex', 'console.log("codex-cli 2.0.0")').bin;
    expect(resolveCodexBin(context)).toBe(managed);
    expect(await codexVersionAsync(managed, { force: true })).toBe('codex-cli 2.0.0');
    expect(resolveCodexBin({ ...context, env: { PATH: '', CODEX_BIN: legacy } })).toBe(legacy);
    expect(resolveCodexBin({ ...context, env: { PATH: '', CODEX_BIN: join(home, 'missing') } })).toBeNull();
    rmSync(managed);
    expect(resolveCodexBin(context)).toBe(legacy);
    expect(existsSync(join(home, '.vonvon-bridge'))).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('still detects the Codex application bundle without shell PATH', async () => {
    const { mkdirSync, existsSync } = await import('node:fs');
    const home = join(dir, 'bundle-home');
    const resourceDir = join(home, 'Applications', 'Codex.app', 'Contents', 'Resources');
    mkdirSync(resourceDir, { recursive: true });
    const local = writeNodeExecutable(resourceDir, 'codex', 'console.log("codex-cli 3.0.0")').bin;
    const global = '/Applications/Codex.app/Contents/Resources/codex';
    expect(resolveCodexBin({ home, dataRoot: join(home, '.vonvon-bridge'), env: { PATH: '' } })).toBe(existsSync(global) ? global : local);
  });

  it.skipIf(process.platform !== 'darwin')('falls back to the codex inside ChatGPT.app, after an nvm install', async () => {
    const { mkdirSync, existsSync } = await import('node:fs');
    const home = join(dir, 'chatgpt-home');
    const bundled = join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin');
    mkdirSync(bundled, { recursive: true });
    const local = writeNodeExecutable(bundled, 'codex', 'console.log("codex-cli 0.162.0-alpha.17.2")').bin;
    const globals = ['/Applications/Codex.app/Contents/Resources/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'];
    const context = { home, dataRoot: join(home, '.vonvon-bridge'), env: { PATH: '' } };
    expect(resolveCodexBin(context)).toBe(globals.find(path => existsSync(path)) ?? local);
    if (existsSync(globals[0]!)) return;
    const nvm = join(home, '.nvm', 'versions', 'node', 'v24.14.1', 'bin');
    mkdirSync(nvm, { recursive: true });
    const viaNvm = writeNodeExecutable(nvm, 'codex', 'console.log("codex-cli 0.162.1")').bin;
    expect(resolveCodexBin({ ...context, force: true })).toBe(viaNvm);
  });
});

describe('asynchronous Codex candidate refresh', () => {
  async function fixture(name: string) {
    const { mkdirSync } = await import('node:fs');
    const { delimiter } = await import('node:path');
    const home = join(dir, name);
    const root = join(home, 'data');
    const managedDir = join(root, 'managed-tools', 'bin');
    const externalDir = join(home, 'external');
    mkdirSync(managedDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
    const managed = writeNodeExecutable(managedDir, 'codex', 'console.log("codex-cli 9.1.0")').bin;
    const external = writeNodeExecutable(externalDir, 'codex', 'console.log("codex-cli 9.2.0")').bin;
    return { managed, external, externalDir, root, context: { home, dataRoot: root, env: { PATH: [externalDir, process.env.PATH ?? ''].join(delimiter) } } };
  }

  it('upgrades from legacy managed to newer external, caches without another spawn, and respects explicit override', async () => {
    const { refreshCodexResolution } = await import('../src/agent/codex-appserver/locate');
    const f = await fixture('refresh-legacy');
    expect(await refreshCodexResolution(f.context)).toBe(f.external);
    expect(resolveCodexBin(f.context)).toBe(f.external);
    expect(await refreshCodexResolution({ ...f.context, env: { ...f.context.env, CODEX_BIN: f.managed } })).toBe(f.managed);
    expect(await refreshCodexResolution({ ...f.context, env: { CODEX_BIN: join(dir, 'missing-explicit') } })).toBeNull();
    rmSync(f.external);
    expect(resolveCodexBin(f.context)).toBe(f.managed);
  });

  it('compares active managed generations and prefers stable only within the same version', async () => {
    const { refreshCodexResolution } = await import('../src/agent/codex-appserver/locate');
    const { mkdirSync } = await import('node:fs');
    const f = await fixture('refresh-active');
    const generation = '12345678-1234-1234-1234-123456789012';
    const release = join(f.root, 'managed-tools', 'codex', 'releases', generation);
    const binDir = process.platform === 'win32' ? release : join(release, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeNodeExecutable(binDir, 'codex', 'console.log("codex-cli 9.1.0")');
    writeFileSync(join(f.root, 'managed-tools', 'codex', 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'active', generation, version: '9.1.0' }));
    expect(await refreshCodexResolution(f.context)).toBe(f.external);
    writeNodeExecutable(f.externalDir, 'codex', 'console.log("codex-cli 9.1.0-alpha.1.2")');
    const active = resolveCodexBin(f.context);
    expect(await refreshCodexResolution({ ...f.context, force: true })).toBe(active);
    expect(active).not.toBe(f.external);
    writeNodeExecutable(f.externalDir, 'codex', 'console.log("codex-cli 10.0.0-alpha.1.2")');
    expect(await refreshCodexResolution({ ...f.context, force: true })).toBe(f.external);
  });

  it('coalesces concurrent forced scans and reuses a valid resolution without spawning', async () => {
    const { refreshCodexResolution } = await import('../src/agent/codex-appserver/locate');
    const f = await fixture('refresh-concurrent');
    const counter = join(f.externalDir, 'probe-count');
    writeNodeExecutable(f.externalDir, 'codex', `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n'); setTimeout(() => console.log('codex-cli 9.2.0'), 40);`);
    const selected = await Promise.all(Array.from({ length: 3 }, () => refreshCodexResolution({ ...f.context, force: true })));
    expect(selected).toEqual([f.external, f.external, f.external]);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(await refreshCodexResolution(f.context)).toBe(f.external);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('finds user local tools with an empty Finder-style PATH', async () => {
    const { refreshCodexResolution } = await import('../src/agent/codex-appserver/locate');
    const { mkdirSync } = await import('node:fs');
    const home = join(dir, 'finder-tools');
    const local = join(home, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    const bin = writeNodeExecutable(local, 'codex', 'console.log("codex-cli 9.9.0")').bin;
    expect(await refreshCodexResolution({ home, dataRoot: join(home, 'data'), env: { PATH: '' } })).toBe(bin);
  });

  it('does not accept an unrelated program that happens to print a higher semver', async () => {
    const { refreshCodexResolution } = await import('../src/agent/codex-appserver/locate');
    const f = await fixture('refresh-unrelated');
    writeNodeExecutable(f.externalDir, 'codex', 'console.log("unrelated-tool 99.0.0")');
    expect(await refreshCodexResolution(f.context)).toBe(f.managed);
  });

  it('ignores failed newer candidate and invalidates the selected fingerprint on in-place updates', async () => {
    const { refreshCodexResolution } = await import('../src/agent/codex-appserver/locate');
    const f = await fixture('refresh-failure');
    expect(await refreshCodexResolution(f.context)).toBe(f.external);
    writeNodeExecutable(f.externalDir, 'codex', 'process.exit(1)');
    expect(resolveCodexBin(f.context)).toBe(f.managed);
    expect(await refreshCodexResolution({ ...f.context, force: true })).toBe(f.managed);
  });
});

describe('bounded version probes', () => {
  it.each([ProviderProcessCleanupError, ProviderProcessStoppedError])('preserves %s from a failed version probe', async Failure => {
    const managed = await import('../src/agent/codex-appserver/managed-install');
    const failure = new Failure('fixture version cleanup failed');
    const probe = vi.spyOn(managed, 'runSetupChild').mockRejectedValueOnce(failure);
    try {
      await expect(codexVersionAsync(join(dir, Failure.name), { force: true })).rejects.toBe(failure);
    } finally { probe.mockRestore(); }
  });

  it.skipIf(process.platform !== 'win32')('allows the owned Windows supervisor to start before a slow valid version reply', async () => {
    const { bin } = fakeBin('windows-delayed-version', "setTimeout(() => console.log('codex-cli 9.2.0'), 3_200)");
    expect(await codexVersionAsync(bin, { force: true })).toBe('codex-cli 9.2.0');
  });
  it('terminates an unresponsive version process', async () => {
    const { bin } = fakeBin('hanging-version', 'setInterval(() => {}, 1000)');
    expect(await codexVersionAsync(bin, { force: true })).toBeNull();
  });
});

describe('Windows user-install discovery', () => {
  it.skipIf(process.platform !== 'win32')('finds user npm shims without npm on PATH and honors PATHEXT', async () => {
    const { mkdirSync } = await import('node:fs');
    const home = join(dir, 'windows-user');
    const appData = join(home, 'roaming');
    const npm = join(appData, 'npm');
    mkdirSync(npm, { recursive: true });
    const bin = writeNodeExecutable(npm, 'codex', 'console.log("codex-cli 9.0.0")').bin;
    const context = { home, dataRoot: join(home, 'data'), env: { PATH: '', APPDATA: appData, PATHEXT: '.EXE;.CMD' } };
    expect(resolveCodexBin(context)).toBe(bin);
    expect(resolveCodexBin({ ...context, env: { ...context.env, PATHEXT: '.EXE' } })).toBeNull();
  });
});

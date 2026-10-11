import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('registered V7 providers', () => {
  let root: string;
  let paths: typeof import('../src/config/paths').paths;
  let originalAppDir: string;
  let agent: typeof import('../src/agent');
  let catalog: typeof import('../src/agent/catalog');
  let loader: typeof import('../src/agent/backend-loader');
  let custom: typeof import('../src/agent/custom-acp-command');
  const originalSend = Object.getOwnPropertyDescriptor(process, 'send');
  beforeEach(async () => {
    Object.defineProperty(process, 'send', { configurable: true, value: undefined });
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), 'vonvon-provider-registry-'));
    ({ paths } = await import('../src/config/paths'));
    originalAppDir = paths.appDir;
    paths.appDir = root;
    agent = await import('../src/agent');
    catalog = await import('../src/agent/catalog');
    loader = await import('../src/agent/backend-loader');
    custom = await import('../src/agent/custom-acp-command');
  });
  afterEach(() => {
    if (originalSend) Object.defineProperty(process, 'send', originalSend);
    else Reflect.deleteProperty(process, 'send');
    paths.appDir = originalAppDir;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['copilot-acp', 'opencode-server', 'pi-rpc', 'custom-acp'])('constructs %s without starting an agent and limits it to full', id => {
    const backend = agent.createBackend(id);
    expect(backend.id).toBe(id);
    expect(backend.supportedModes).toEqual(['full']);
    expect(backend.capabilities).toMatchObject({ goal: true, resume: true, approvals: false });
  });

  it('keeps the unconfigured custom command unavailable with actionable diagnostics', async () => {
    const backend = agent.createBackend('custom-acp');
    expect(await backend.isAvailable()).toBe(false);
    expect(await backend.doctor()).toMatchObject({ ok: false, depState: 'external-missing', hint: '未配置自定义 ACP 命令（主机设置 › 执行）' });
    expect(await backend.listThreads(root)).toEqual([]);
    expect(await backend.readHistory(root, 'unused')).toEqual({ turns: [], totalTurns: 0 });
    await expect(backend.startThread({ cwd: root, mode: 'full' })).rejects.toThrow('未配置');
    await expect(backend.resumeThread({ cwd: root, mode: 'full', sessionId: 'unused' })).rejects.toThrow('未配置');
  });

  it('detects a configured host executable and excludes it from sandboxed tiers', async () => {
    const entry = catalog.catalogById('custom-acp');
    if (!entry) throw new Error('Missing custom ACP catalog entry');
    expect(loader.isBackendEntryInstalled(entry)).toBe(false);
    const executable = join(root, 'acp-agent');
    writeFileSync(executable, '', { mode: 0o700 });
    custom.saveCustomAcpCommand([executable, '--acp']);
    expect(loader.isBackendEntryInstalled(entry)).toBe(false);
    expect(agent.createBackend('custom-acp').id).toBe('custom-acp');
    expect(catalog.projectCreatableBackends('full', loader.isBackendEntryInstalled).map(item => item.id)).not.toContain('custom-acp');
    vi.resetModules();
    const restartedPaths = (await import('../src/config/paths')).paths;
    restartedPaths.appDir = root;
    const restartedCustom = await import('../src/agent/custom-acp-command');
    await restartedCustom.initCustomAcpCommand();
    const restartedLoader = await import('../src/agent/backend-loader');
    const restartedCatalog = await import('../src/agent/catalog');
    expect(restartedLoader.isBackendEntryInstalled(entry)).toBe(true);
    expect(restartedCatalog.projectCreatableBackends('full', restartedLoader.isBackendEntryInstalled).map(item => item.id)).toContain('custom-acp');
    for (const mode of ['qa', 'write'] as const) {
      expect(restartedCatalog.projectCreatableBackends(mode, restartedLoader.isBackendEntryInstalled).map(item => item.id)).not.toContain('custom-acp');
    }
    writeFileSync(join(root, 'custom-acp.json'), '{corrupt');
    expect(restartedLoader.isBackendEntryInstalled(entry)).toBe(true);
  });

  it('uses captured A on first registry construction after settings saved B', async () => {
    const createACPBackend = vi.fn(() => ({ id: 'custom-acp' }));
    vi.doMock('../src/agent/acp-provider', () => ({ createACPBackend }));
    try {
      vi.resetModules();
      const restartedPaths = (await import('../src/config/paths')).paths;
      restartedPaths.appDir = root;
      const authority = await import('../src/agent/custom-acp-command');
      authority.saveCustomAcpCommand(['agent-A']);
      await authority.initCustomAcpCommand();
      authority.saveCustomAcpCommand(['agent-B']);
      const registry = await import('../src/agent');
      expect(registry.createBackend('custom-acp').id).toBe('custom-acp');
      expect(createACPBackend).toHaveBeenCalledWith({ command: ['agent-A'] });
    } finally { vi.doUnmock('../src/agent/acp-provider'); }
  });
});

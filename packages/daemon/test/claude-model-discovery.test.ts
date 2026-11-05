import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo, Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as backendLoader from '../src/agent/backend-loader';
import { ClaudeAgentBackend, type ClaudeSdkFacade } from '../src/agent/claude-agent/backend';
import { discoverProviderModels } from '../src/admin/model-catalog';

const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home.path }));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'claude-model-cache-'));
  home.path = join(directory, 'home');
  mkdirSync(home.path);
  vi.stubEnv('CLAUDE_CONFIG_DIR', directory);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

const catalog = (value: string): ModelInfo[] => [{ value, displayName: value, description: '' }];
function fixture(discover: () => Promise<ModelInfo[]>) {
  const close = vi.fn();
  const query = vi.fn(() => ({ supportedModels: discover, close }) as unknown as Query);
  const loader = async () => ({ query }) as unknown as ClaudeSdkFacade;
  return { backend: new ClaudeAgentBackend(loader, () => undefined), loader, query, close };
}

describe('Claude native model catalog cache', () => {
  it('accepts first discovery when the CLI creates a global file containing only runtime state', async () => {
    const { backend } = fixture(async () => {
      writeFileSync(join(directory, '.claude.json'), JSON.stringify({ numStartups: 1, cachedGrowthBookFeaturesAt: Date.now() }));
      return catalog('first-run-model');
    });
    await backend.listModels();
    expect(backend.peekModels()?.[0]?.id).toBe('first-run-model');
  });

  it.each(['default', 'custom'] as const)('retains native discovery when the CLI rewrites its %s runtime caches', async location => {
    if (location === 'default') vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const file = join(location === 'default' ? home.path : directory, '.claude.json');
    const account = { accountUuid: 'account-a', organizationUuid: 'org-a' };
    writeFileSync(file, JSON.stringify({ oauthAccount: account, numStartups: 1 }));
    const discover = vi.fn(async () => {
      writeFileSync(file, JSON.stringify({ oauthAccount: { ...account, profileFetchedAt: Date.now() },
        numStartups: 2, cachedGrowthBookFeaturesAt: Date.now(), additionalModelOptionsAnsweredAt: Date.now() }));
      return catalog('native-account-model');
    });
    const { backend } = fixture(discover);
    vi.spyOn(backend, 'doctor').mockResolvedValue({ ok: true, version: '0.3.296' });
    expect(await discoverProviderModels('claude-agent', () => backend)).toMatchObject({ models: [{ id: 'native-account-model' }] });
    writeFileSync(file, JSON.stringify({ oauthAccount: account, numStartups: 3 }));
    expect(backend.peekModels()?.[0]?.id).toBe('native-account-model');
    await backend.listModels();
    expect(discover).toHaveBeenCalledOnce();
  });

  it.each(['default', 'custom', 'legacy'] as const)('invalidates native metadata when the %s config changes account or API key', async location => {
    if (location === 'default') vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const file = location === 'default' ? join(home.path, '.claude.json')
      : join(directory, location === 'legacy' ? '.config.json' : '.claude.json');
    const state = { oauthAccount: { accountUuid: 'a', organizationUuid: 'org' }, primaryApiKey: 'fixture-key-a' };
    writeFileSync(file, JSON.stringify(state));
    const discover = vi.fn(async () => catalog('native'));
    const { backend } = fixture(discover);
    await backend.listModels();
    for (const next of [
      { ...state, oauthAccount: { ...state.oauthAccount, accountUuid: 'b' } },
      { ...state, oauthAccount: { ...state.oauthAccount, organizationUuid: 'other-org' } },
      { ...state, primaryApiKey: 'fixture-key-b' },
    ]) {
      writeFileSync(file, JSON.stringify(next));
      expect(backend.peekModels()).toBeUndefined();
      await backend.listModels();
    }
    expect(discover).toHaveBeenCalledTimes(4);
  });

  it('rejects a discovery for an account that changes while it is running', async () => {
    const file = join(directory, '.claude.json');
    writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: 'before' } }));
    const { backend } = fixture(async () => {
      writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: 'after' } }));
      return catalog('previous-account-model');
    });
    await backend.listModels();
    expect(backend.peekModels()).toBeUndefined();
  });

  it('shares discovery and successful catalogs between backend instances and refreshes explicitly', async () => {
    let resolve!: (value: ModelInfo[]) => void;
    const discover = vi.fn(() => new Promise<ModelInfo[]>(r => { resolve = r; }));
    const { backend, loader, query, close } = fixture(discover);
    const other = new ClaudeAgentBackend(loader, () => undefined);
    const first = backend.listModels();
    const concurrent = other.listModels();
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    resolve(catalog('first'));
    expect(await first).toEqual(await concurrent);
    expect(other.peekModels()?.[0]?.id).toBe('first');
    await other.listModels();
    expect(query).toHaveBeenCalledTimes(1);
    discover.mockResolvedValue(catalog('fresh'));
    await Promise.all([backend.listModels({ refresh: true }), other.listModels({ refresh: true })]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(backend.peekModels()?.[0]?.id).toBe('fresh');
  });

  it('starts a fresh discovery after an ordinary in-flight request and combines concurrent refreshes', async () => {
    const releases: Array<(value: ModelInfo[]) => void> = [];
    const discover = vi.fn(() => new Promise<ModelInfo[]>(r => { releases.push(r); }));
    const { backend } = fixture(discover);
    const old = backend.listModels();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const fresh = backend.listModels({ refresh: true });
    const anotherClick = backend.listModels({ refresh: true });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(catalog('fresh'));
    expect(await fresh).toEqual(await anotherClick);
    releases[0]!(catalog('stale'));
    await old;
    expect(backend.peekModels()?.[0]?.id).toBe('fresh');
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('invalidates the catalog when the installed SDK version changes', async () => {
    const version = vi.spyOn(backendLoader, 'installedBackendVersion').mockReturnValue('1.0.0');
    const discover = vi.fn(async () => catalog('native'));
    const { backend } = fixture(discover);
    await backend.listModels();
    version.mockReturnValue('1.0.1');
    expect(backend.peekModels()).toBeUndefined();
    await backend.listModels();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('keeps successful metadata without periodically starting another CLI', async () => {
    vi.useFakeTimers();
    const discover = vi.fn(async () => catalog('native'));
    const { backend } = fixture(discover);
    await backend.listModels();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await backend.listModels();
    expect(discover).toHaveBeenCalledOnce();
  });

  it('invalidates peek and discovery for settings, credentials and credential environment changes', async () => {
    const discover = vi.fn(async () => catalog('native'));
    const { backend } = fixture(discover);
    await backend.listModels();
    for (const file of ['settings.json', '.credentials.json']) {
      writeFileSync(join(directory, file), '{}');
      expect(backend.peekModels()).toBeUndefined();
      await backend.listModels();
    }
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-new-account');
    expect(backend.peekModels()).toBeUndefined();
    await backend.listModels();
    expect(discover).toHaveBeenCalledTimes(4);
  });

  it('does not let an older configuration overwrite the newer catalog', async () => {
    const releases: Array<(value: ModelInfo[]) => void> = [];
    const discover = vi.fn(() => new Promise<ModelInfo[]>(r => { releases.push(r); }));
    const { backend, close } = fixture(discover);
    const old = backend.listModels();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    writeFileSync(join(directory, 'settings.json'), '{"model":"changed"}');
    const current = backend.listModels();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(catalog('current'));
    await current;
    releases[0]!(catalog('stale'));
    await old;
    expect(backend.peekModels()?.[0]?.id).toBe('current');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('keeps the new catalog when an older configuration request fails late', async () => {
    let fail!: (error: Error) => void;
    const discover = vi.fn(() => new Promise<ModelInfo[]>((_resolve, reject) => { fail = reject; }));
    const { backend } = fixture(discover);
    const old = backend.listModels();
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
    writeFileSync(join(directory, 'settings.json'), '{}');
    discover.mockResolvedValue(catalog('current'));
    await backend.listModels();
    fail(new Error('old probe failed'));
    await old;
    expect(backend.peekModels()?.[0]?.id).toBe('current');
  });

  it('drops ready evidence on refresh failure and retries instead of caching fallback', async () => {
    const discover = vi.fn(async () => catalog('native'));
    const { backend, close } = fixture(discover);
    await backend.listModels();
    discover.mockRejectedValueOnce(new Error('offline'));
    await backend.listModels({ refresh: true });
    expect(backend.peekModels()).toBeUndefined();
    expect((await backend.listModels())[0]?.id).toBe('native');
    expect(discover).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('closes a timed-out query and permits the next discovery', async () => {
    vi.useFakeTimers();
    const discover = vi.fn(() => new Promise<ModelInfo[]>(() => {}));
    const { backend, close } = fixture(discover);
    const pending = backend.listModels();
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(close).toHaveBeenCalledOnce();
    expect(backend.peekModels()).toBeUndefined();
    discover.mockResolvedValue(catalog('recovered'));
    expect((await backend.listModels())[0]?.id).toBe('recovered');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, ModelInfo } from '../src/agent/types';
import { discoverProviderModels } from '../src/admin/model-catalog';

const native: ModelInfo = { id: 'native-model', displayName: 'Native', description: '', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, hidden: false };
const fallback: ModelInfo = { ...native, id: 'static-fallback' };

describe('Bot-free provider model discovery', () => {
  it('returns models only when this provider instance discovered them natively', async () => {
    let seen: ModelInfo[] | undefined;
    const doctor = vi.fn(async () => ({ ok: true, version: '1' }));
    const listModels = vi.fn(async () => { seen = [native]; return [native]; });
    const backend = { doctor, listModels, peekModels: () => seen } as unknown as AgentBackend;
    expect(await discoverProviderModels('claude-agent', () => backend)).toEqual({ models: [native] });
    expect(doctor).toHaveBeenCalledWith({ force: true });
    expect(listModels).toHaveBeenCalledOnce();
  });

  it('rejects the static fallback returned by listModels after native discovery fails', async () => {
    const backend = { doctor: async () => ({ ok: true }), listModels: async () => [fallback], peekModels: () => undefined } as unknown as AgentBackend;
    expect(await discoverProviderModels('codex-appserver', () => backend)).toMatchObject({ models: [], message: expect.any(String) });
  });

  it('does not launch model discovery when the runtime is unavailable', async () => {
    const listModels = vi.fn();
    const backend = { doctor: async () => ({ ok: false }), listModels } as unknown as AgentBackend;
    expect(await discoverProviderModels('claude-agent', () => backend)).toMatchObject({ models: [], message: expect.any(String) });
    expect(listModels).not.toHaveBeenCalled();
  });
});

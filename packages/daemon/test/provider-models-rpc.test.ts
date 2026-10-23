import { expect, it, vi } from 'vitest';
import type { AdminService } from '../src/admin/service';
import type { DirectoryBrowser } from '../src/server/directory-browser';
import { collaborationRpc } from '../src/server/rpc/collaboration';

vi.mock('../src/admin/model-catalog', () => ({
  discoverProviderModels: vi.fn(async () => ({ models: [{ id: 'native', displayName: 'Native', description: '', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, hidden: false }] })),
}));

it('reads native Provider models without a Bot or collaboration service', async () => {
  const result = await collaborationRpc({} as AdminService, {} as DirectoryBrowser, { action: 'providerModels', backend: 'claude-agent' });
  expect(result).toMatchObject({ kind: 'read', value: { kind: 'providerModels', backend: 'claude-agent', state: 'ready', models: [{ id: 'native' }] } });
});

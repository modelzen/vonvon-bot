import { expect, it, vi } from 'vitest';
import { discoverProviderModels } from '../src/admin/model-catalog';
import { startFixture } from './server-fixture';
// @ts-expect-error -- a plain .mjs build script, no type declarations
import { verifyPackagedProvider } from '../../../scripts/windows-provider-smoke.mjs';

vi.mock('../src/admin/model-catalog', () => ({
  discoverProviderModels: vi.fn(async () => ({ models: [{ id: 'native', displayName: 'Native', description: '', supportedEfforts: ['high'], defaultEffort: 'high', isDefault: true, hidden: false }] })),
}));

// #666 review: the Windows packaging smoke said hello with protocol 1 after the server moved to 2, so the server held it
// to status, upgrade and stop and refused its first model request. Run against the real API, its requests get through.
it('the Windows packaging smoke speaks the protocol the server speaks', async () => {
  const fixture = await startFixture();
  try {
    const error: unknown = await verifyPackagedProvider(`127.0.0.1:${fixture.api.port}`, fixture.home, { callsFile: '/nonexistent' }).then(() => undefined, (e: unknown) => e);
    // The fake catalog is not the packaged fixture, so the smoke's own checks stop it later; the version gate must not.
    expect(String(error)).not.toMatch(/协议版本|protocol/i);
    expect(vi.mocked(discoverProviderModels)).toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

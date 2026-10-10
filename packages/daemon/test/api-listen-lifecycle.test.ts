import { describe, expect, it } from 'vitest';
import { fakeService, startFixture } from './server-fixture';

describe('parent API listen lifecycle', () => {
  it('releases a failed occupied-port attempt and can bind the port after its owner closes', async () => {
    const owner = await startFixture();
    const { startApi } = await import('../src/server/http');
    let replacement: Awaited<ReturnType<typeof startApi>> | undefined;
    try {
      await expect(startApi({ service: fakeService(), port: owner.api.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      await owner.api.close();
      replacement = await startApi({ service: fakeService(), port: owner.api.port });
      expect(replacement.listen).toBe(`127.0.0.1:${owner.api.port}`);
    } finally { await replacement?.close(); await owner.close(); }
  });
});

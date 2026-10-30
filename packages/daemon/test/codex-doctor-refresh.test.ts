import { beforeEach, expect, it, vi } from 'vitest';
const locate = vi.hoisted(() => ({ resolve: vi.fn(), refresh: vi.fn(), version: vi.fn() }));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  resolveCodexBin: locate.resolve,
  refreshCodexResolution: locate.refresh,
  codexVersionAsync: locate.version,
  cachedCodexVersion: () => undefined,
}));
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
beforeEach(() => {
  locate.resolve.mockReset().mockReturnValue(null);
  locate.refresh.mockReset().mockResolvedValue(null);
  locate.version.mockReset();
});
it('forced doctor awaits the candidate refresh instead of resolving the stale binary', async () => {
  locate.resolve.mockReturnValue('/stale/codex');
  expect(await new CodexAppServerBackend().doctor({ force: true })).toMatchObject({ ok: false });
  expect(locate.refresh).toHaveBeenCalledWith({ force: true });
  expect(locate.resolve).not.toHaveBeenCalled();
  expect(locate.version).not.toHaveBeenCalled();
});
it('ordinary doctor and availability checks refresh the process-local selection', async () => {
  expect(await new CodexAppServerBackend().doctor()).toMatchObject({ ok: false });
  expect(await new CodexAppServerBackend().isAvailable()).toBe(false);
  expect(locate.resolve).not.toHaveBeenCalled();
  expect(locate.refresh).toHaveBeenCalledTimes(2);
  expect(locate.refresh).toHaveBeenCalledWith(undefined);
});

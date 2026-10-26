import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_LINUX_MIN_VERSION, codexConfinesReads, codexFullOnlyReason, codexTierUnavailable } from '../src/agent/codex-appserver/full-only';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';

const locate = vi.hoisted(() => ({ version: undefined as string | null | undefined, probe: vi.fn() }));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  resolveCodexBin: () => '/fixture/codex', cachedCodexVersion: () => locate.version, codexVersionAsync: locate.probe,
}));

describe('Codex Linux permission capability', () => {
  beforeEach(() => { locate.version = undefined; locate.probe.mockReset(); });
  it.each([null, 'unknown', 'codex-cli 0.162.9', '0.163.0'])('keeps macOS support independent of version %s', version => {
    expect(codexConfinesReads('darwin', version)).toBe(true);
    expect(codexConfinesReads('win32', version)).toBe(false);
  });
  it('parses CLI version output and compares each numeric component', () => {
    for (const version of [CODEX_LINUX_MIN_VERSION, `codex-cli ${CODEX_LINUX_MIN_VERSION}`, '0.164.0', '1.0.0', '0.164.0-alpha.1', '0.163.0+build.1']) {
      expect(codexConfinesReads('linux', version)).toBe(true);
      expect(codexTierUnavailable('qa', 'linux', version)).toBeUndefined();
      expect(codexTierUnavailable('write', 'linux', version)).toBeUndefined();
    }
    for (const version of [null, 'unknown', 'codex-cli 0.162.9', '0.99.0', '0.163.0-alpha.1', 'codex-cli 0.163.0-rc.1']) expect(codexConfinesReads('linux', version)).toBe(false);
    expect(codexFullOnlyReason(null)).toContain('测不出 Codex 的版本');
  });
  it.each(['0.163.0-alpha.1', 'codex-cli 0.163.0-rc.1'])(
    'explains the stable minimum while preserving the detected prerelease: %s', version => {
      const reason = codexTierUnavailable('qa', 'linux', version);
      expect(reason).toContain(`Codex 是 ${version}`);
      expect(reason).toContain(`${CODEX_LINUX_MIN_VERSION} 正式版以上`);
    });
  it('reads only cached versions on the per-message fullAccessOnly path', () => {
    locate.version = undefined;
    expect(new CodexAppServerBackend().fullAccessOnly()).toBeUndefined();
    expect(locate.probe).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== 'linux')('keeps failed cached probes unavailable without another process on the message path', () => {
    locate.version = null;
    expect(new CodexAppServerBackend().fullAccessOnly()).toBe(codexFullOnlyReason(null));
    expect(locate.probe).not.toHaveBeenCalled();
    locate.version = undefined;
  });
  it.skipIf(process.platform !== 'linux')('rejects an old CLI before starting a native session, with an actionable reason', async () => {
    locate.probe.mockResolvedValueOnce('codex-cli 0.162.9');
    await expect(new CodexAppServerBackend().startThread({ cwd: '/fixture/workspace', mode: 'qa' }))
      .rejects.toThrow(codexFullOnlyReason('codex-cli 0.162.9'));
  });
});

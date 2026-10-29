import { describe, expect, it } from 'vitest';
import { codexConfinesReads, codexTierUnavailable } from '../src/agent/codex-appserver/full-only';
import { codexTable } from '../src/agent/permission/codex';

describe('Windows Codex permission capability', () => {
  const ready = { status: 'ready', implementation: 'mxc' } as const;
  it('does not misdiagnose a supported version as too old just because it runs on Windows', () => {
    const reason = codexTierUnavailable('qa', 'win32', 'codex-cli 0.163.0');
    expect(reason).toContain('探测');
    expect(reason).not.toContain('升级后就能选');
  });
  it('requires both a stable Windows version and a validated native implementation', () => {
    expect(codexConfinesReads('win32', 'codex-cli 0.163.0', ready)).toBe(true);
    expect(codexConfinesReads('win32', '0.164.0', ready)).toBe(true);
    for (const version of [null, 'unknown', '0.162.9', '0.163.0-rc.1', '0.164.0-alpha.1']) {
      expect(codexConfinesReads('win32', version, ready)).toBe(false);
    }
    expect(codexConfinesReads('win32', '0.163.0')).toBe(false);
  });
  it.each([
    ['notConfigured', '尚未配置'], ['updateRequired', '需要更新'],
    ['probeFailed', '探测失败'], ['unsupported', '隔离'],
  ] as const)('reports %s consistently in the table and native guard', (status, text) => {
    const capability = { status };
    const env = { platform: 'win32', codexVersion: '0.163.0', codexWindowsSandbox: capability } as const;
    const rows = codexTable.tiers(env);
    for (const tier of ['qa', 'write'] as const) {
      const reason = codexTierUnavailable(tier, 'win32', '0.163.0', capability);
      expect(reason).toContain(text);
      expect(rows.find(row => row.tier === tier)?.unavailable).toBe(reason);
    }
    expect(rows[2].unavailable).toBeUndefined();
    expect(codexTierUnavailable('full', 'win32', null, capability)).toBeUndefined();
  });
  it('opens both tiers with verified read isolation, preserves full access', () => {
    const rows = codexTable.tiers({ platform: 'win32', codexVersion: '0.163.0', codexWindowsSandbox: ready });
    expect(rows[0].unavailable).toBeUndefined();
    expect(rows[1].unavailable).toBeUndefined();
    expect(rows[2].unavailable).toBeUndefined();
  });
  it('gives distinct unknown, old and prerelease version reasons', () => {
    expect(codexTierUnavailable('qa', 'win32', null, ready)).toContain('测不出');
    expect(codexTierUnavailable('qa', 'win32', '0.162.9', ready)).toContain('Windows');
    expect(codexTierUnavailable('qa', 'win32', '0.163.0-rc.1', ready)).toContain('预发布');
  });
  it('does not claim unsupported platforms can be fixed by a Linux upgrade', () => {
    expect(codexTierUnavailable('qa', 'freebsd', '1.0.0')).toContain('平台');
    expect(codexTierUnavailable('qa', 'freebsd', '1.0.0')).not.toContain('升级');
  });
});

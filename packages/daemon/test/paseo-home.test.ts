import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePaseoHome } from '../src/agent/paseo/runtime/server/paseo-home';

afterEach(() => vi.unstubAllEnvs());

describe('provider data root', () => {
  it('uses the canonical Vonvon root instead of a Paseo override', () => {
    const ownedRoot = mkdtempSync(join(tmpdir(), 'vonvon-provider-home-'));
    vi.stubEnv('VONVON_HOME', ownedRoot);
    vi.stubEnv('PASEO_HOME', join(ownedRoot, 'unrelated-paseo'));
    expect(resolvePaseoHome()).toBe(realpathSync(ownedRoot));
    expect(resolvePaseoHome({ PASEO_HOME: '/unused-paseo' })).toBe(realpathSync(ownedRoot));
  });

  it('retains the daemon rejection of a relative data root', () => {
    vi.stubEnv('VONVON_HOME', 'relative-root');
    expect(() => resolvePaseoHome()).toThrow('VONVON_HOME must be a nonempty absolute directory path');
  });
});

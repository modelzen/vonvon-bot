import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = resolve(import.meta.dirname, '../bin/vonvon.mjs');

describe('Windows relaunch helper entry', () => {
  it('refuses relaunch without touching the request or taking a data lease and stays hidden', () => {
    const root = mkdtempSync(join(tmpdir(), 'vonvon-relaunch-cli-'));
    try {
      const data = join(root, 'data');
      const requestDir = join(root, 'request');
      mkdirSync(data); mkdirSync(requestDir);
      writeFileSync(join(data, '.access'), 'admission must not be entered');
      const env = { ...process.env, HOME: root, USERPROFILE: root, VONVON_HOME: data };
      const result = spawnSync(process.execPath, [bin, '__win-relaunch', join(requestDir, 'missing.json')], { env, encoding: 'utf8', timeout: 10_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.');
      expect(readdirSync(requestDir)).toEqual([]);
      expect(readdirSync(data)).toEqual(['.access']);
      expect(readFileSync(join(data, '.access'), 'utf8')).toBe('admission must not be entered');
      const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8', timeout: 10_000 });
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain('__win-relaunch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

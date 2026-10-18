import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireMutex, assertNoDataLeases, closeMutex, enterDataAccess } from '../src/config/data-access';

const homes: string[] = [];
const home = (): string => { const path = mkdtempSync(join(tmpdir(), 'bridge-admission-')); homes.push(path); return path; };
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('offline access admission', () => {
  it('blocks exclusive access while a data user owns a lifetime lease', async () => {
    const dir = home();
    const lease = await enterDataAccess(dir);
    try { expect(() => assertNoDataLeases(dir)).toThrow(/data is in use/); }
    finally { lease.release(); }
    expect(() => assertNoDataLeases(dir)).not.toThrow();
  });
  it('fails closed on partial durable publication', () => {
    const dir = home(); mkdirSync(join(dir, '.access'));
    writeFileSync(join(dir, '.access', 'partial.json'), '{');
    expect(() => assertNoDataLeases(dir)).toThrow();
    expect(readFileSync(join(dir, '.access', 'partial.json'), 'utf8')).toBe('{');
  });
  it('does not bypass a held coordination mutex', async () => {
    const dir = home(); const owner = await acquireMutex(dir, 'admission');
    try { await expect(acquireMutex(dir, 'admission', 30)).rejects.toThrow(/busy/); }
    finally { await closeMutex(owner); }
  });
  it('retains a lease when process liveness is unknown', () => {
    const dir = home(); mkdirSync(join(dir, '.access'));
    const file = join(dir, '.access', 'unknown.json');
    writeFileSync(file, JSON.stringify({ version: 1, pid: 424242 }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    try {
      expect(() => assertNoDataLeases(dir)).toThrow(/Cannot establish/);
      expect(readFileSync(file, 'utf8')).toContain('424242');
    } finally { kill.mockRestore(); }
  });

});

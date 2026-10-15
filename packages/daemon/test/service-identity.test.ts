import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LAUNCHD_LABEL, serviceName, serviceTarget, SYSTEMD_UNIT_NAME } from '../src/service/identity';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const home = () => { const path = mkdtempSync(join(tmpdir(), 'vonvon-identity-')); homes.push(path); mkdirSync(join(path, '.vonvon-bot')); return path; };

it('the default data root keeps the fixed names', () => {
  const h = home();
  expect(serviceName('darwin', join(h, '.vonvon-bot'), h)).toBe(LAUNCHD_LABEL);
  expect(serviceName('linux', join(h, '.vonvon-bot'), h)).toBe(SYSTEMD_UNIT_NAME);
  expect(serviceTarget({ platform: 'darwin', home: h, root: join(h, '.vonvon-bot') })).toEqual({ platform: 'darwin', label: LAUNCHD_LABEL, plistPath: join(h, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`) });
});
it('any other data root gets its own stable names, so a test install never replaces the user\'s service', () => {
  const h = home(); const other = join(h, 'isolated');
  const label = serviceName('darwin', other, h);
  expect(label).toMatch(/^com\.vonvon\.bot\.daemon\.[0-9a-f]{12}$/);
  expect(serviceName('darwin', other, h)).toBe(label);
  expect(serviceName('darwin', join(h, 'second'), h)).not.toBe(label);
  expect(serviceName('linux', other, h)).toMatch(/^vonvon-bot-[0-9a-f]{12}\.service$/);
  const target = serviceTarget({ platform: 'linux', home: h, root: other, xdgConfigHome: undefined });
  expect(target.platform === 'linux' && target.unitPath).toBe(join(h, '.config/systemd/user', serviceName('linux', other, h)));
});
it('a data root not created yet gets the name it will have once created', async () => {
  const h = home(); const linked = `${h}-link`; homes.push(linked);
  (await import('node:fs')).symlinkSync(h, linked);
  const before = serviceName('darwin', join(linked, 'later'), linked);
  mkdirSync(join(h, 'later'));
  expect(serviceName('darwin', join(linked, 'later'), linked)).toBe(before);
  expect(serviceName('darwin', join(linked, '.vonvon-bot'), h)).toBe(LAUNCHD_LABEL);
});

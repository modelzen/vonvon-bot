import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderProcessCleanupError, ProviderProcessStoppedError, OwnedProviderProcess } from '../src/agent/owned-process';
import { CodexSetupService } from '../src/agent/codex-appserver/setup';
import { resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { writeNodeExecutable } from './helpers/node-executable';

const home = mkdtempSync(join(tmpdir(), 'codex-setup-home-'));
const log = join(home, 'calls.jsonl');
const auth = join(home, '.codex');
mkdirSync(auth);
const source = `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('codex-cli 0.156.1'); process.exit(0); }
const mode = process.env.FIXTURE_MODE;
if(mode==='exit-error') process.on('SIGTERM', () => process.exit(23));
if(mode==='force-kill') process.on('SIGTERM', () => {});
const auth = path.join(process.env.CODEX_HOME, 'fixture-account');
const record = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({...value, bin: process.argv[1], home: process.env.CODEX_HOME, pid: process.pid}) + '\\n');
record({event:'start'});
const response = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(!m.id) return;
 record({method:m.method, params:m.params});
 if(m.method==='initialize') return response(m.id, {});
 if(m.method==='account/read') return response(m.id, mode==='malformed' ? {} : {account:fs.existsSync(auth) ? {type:'chatgpt', email:'fixture@example.invalid', planType:'free'} : null, requiresOpenaiAuth:mode!=='custom'});
});
`;
const fixture = writeNodeExecutable(home, 'codex fixture', source);
const services: CodexSetupService[] = [];
const service = (): CodexSetupService => { const value = new CodexSetupService(); services.push(value); return value; };
function calls(): { method?: string; bin: string; home: string; pid: number }[] { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

beforeAll(() => {
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config')); vi.stubEnv('CODEX_HOME', auth); vi.stubEnv('CODEX_BIN', fixture.bin);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(value => value.close()));
  rmSync(join(auth, 'fixture-account'), { force: true }); rmSync(log, { force: true });
  vi.stubEnv('FIXTURE_MODE', 'hold'); vi.stubEnv('CODEX_BIN', fixture.bin);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('Codex account setup uses the task executable and home', { timeout: process.platform === 'win32' ? 90_000 : 40_000 }, () => {
  it('reuses success, but an explicit refresh overlapping a cached read still reaches the native account', async () => {
    const value = service();
    expect(await value.setup()).toMatchObject({installation:'installed',authentication:'signedOut'});
    const count = calls().filter(call => call.method === 'account/read').length;
    await value.setup();
    expect(calls().filter(call => call.method === 'account/read')).toHaveLength(count);
    writeFileSync(join(auth, 'fixture-account'), 'fixture');
    const ordinary = value.setup();
    const fresh = value.setup({refresh:true});
    await ordinary;
    expect(await fresh).toMatchObject({authentication:'signedIn'});
    expect(calls().filter(call => call.method === 'account/read')).toHaveLength(count + 1);
  });
  it('distinguishes installation, signed-out, signed-in, not-required and malformed account state', async () => {
    const value = service();
    expect(await value.setup()).toMatchObject({ installation: 'installed', authentication: 'signedOut', version: 'codex-cli 0.156.1', executable: fixture.bin });
    expect(resolveCodexBin()).toBe(fixture.bin);
    writeFileSync(join(auth, 'fixture-account'), 'fixture');
    expect(await value.setup({refresh: true})).toMatchObject({ authentication: 'signedIn' });
    vi.stubEnv('FIXTURE_MODE', 'custom');
    expect(await value.setup({refresh: true})).toMatchObject({ authentication: 'notRequired' });
    vi.stubEnv('FIXTURE_MODE', 'malformed');
    expect(await value.setup({refresh: true})).toMatchObject({ authentication: 'unknown' });
    expect(calls().every(call => call.home === auth && call.bin === fixture.script)).toBe(true);
    expect(calls().filter(call => call.method === 'account/read')).toHaveLength(4);
    expect(calls().every(call => !alive(call.pid))).toBe(true);
  });

  it.skipIf(process.platform === 'win32').each(['exit-error', 'force-kill'])('retries detection after confirmed process death with %s cleanup failure', async mode => {
    vi.stubEnv('FIXTURE_MODE', mode);
    const value = new CodexSetupService();
    try {
      await expect(value.setup()).rejects.toBeInstanceOf(ProviderProcessStoppedError);
      expect(calls().some(call => call.method === 'account/read')).toBe(true);
      expect(calls().every(call => !alive(call.pid))).toBe(true);
      vi.stubEnv('FIXTURE_MODE', 'hold');
      expect(await value.setup()).toMatchObject({ installation: 'installed', authentication: 'signedOut' });
      expect(calls().every(call => !alive(call.pid))).toBe(true);
      await expect(value.close()).resolves.toBeUndefined();
    } finally {
      await value.close().catch(() => undefined);
    }
  });

  it('does not fall back when an explicit override is missing', async () => {
    vi.stubEnv('CODEX_BIN', join(home, 'missing'));
    const value = service();
    expect(await value.setup()).toMatchObject({ installation: 'unknown', authentication: 'unknown' });
    expect(resolveCodexBin()).toBeNull();
  });

  it('rejects setup reads after shutdown', async () => {
    const value = service();
    await value.close();
    expect(() => value.setup()).toThrow('退出');
  });
});

it('probe cleanup failure remains visible to later Host close', async () => {
  const close = OwnedProviderProcess.prototype.close;
  const failure = vi.spyOn(OwnedProviderProcess.prototype, 'close').mockImplementationOnce(async function (this: OwnedProviderProcess, graceMs) {
    await close.call(this, graceMs);
    throw new ProviderProcessCleanupError('fixture probe cleanup unknown');
  });
  const value = new CodexSetupService();
  try {
    await expect(value.setup()).rejects.toThrow('fixture probe cleanup unknown');
    expect(() => value.setup()).toThrow('清理未确认');
    await expect(value.close()).rejects.toThrow('清理未确认');
  } finally { failure.mockRestore(); }
});

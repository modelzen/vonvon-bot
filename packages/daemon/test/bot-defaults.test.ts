import { mkdtemp, readFile, writeFile, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'bot-defaults-test-'));
  return { paths: { appDir, configFile: join(appDir, 'active.json'), secretsGetterScript: join(appDir, 'wrapper', 'getter') } };
});

import { parseBotDefaults, resolveBotDefaults } from '../src/config/defaults';
import { buildEncryptedAccountConfig, loadConfig, saveConfig } from '../src/config/store';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';

const root = await mkdtemp(join(tmpdir(), 'bot-defaults-files-'));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(paths.appDir, { recursive: true, force: true });
});
const accounts: AppConfig['accounts'] = { app: { id: 'fixture', secret: 'fixture-secret', tenant: 'feishu' } };
async function rawFile(name: string, value: unknown): Promise<string> {
  const file = join(root, name, 'config.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
  return file;
}
function externalConfig(defaults: unknown): AppConfig {
  return JSON.parse(JSON.stringify({ accounts, preferences: { defaults } }));
}

describe('execution defaults boundary', () => {
  it('resolves missing/partial values without inventing selections or mutating input', () => {
    expect(parseBotDefaults(undefined)).toBeUndefined();
    expect(resolveBotDefaults(undefined)).toEqual({ backend: null, model: null, permission: 'write', network: true });
    const defaults = parseBotDefaults({ permission: 'qa', network: false });
    expect(resolveBotDefaults(defaults)).toEqual({ backend: null, model: null, permission: 'qa', network: false });
    expect(defaults).toEqual({ permission: 'qa', network: false });
  });

  it.each(['catalog', 'custom'])('retains %s model, effort and future backend ids', (kind) => {
    const raw = { backend: 'future-provider', model: { kind, id: 'custom/model', effort: 'ultra' }, permission: 'full', network: false };
    const parsed = parseBotDefaults(raw);
    expect(parsed).toEqual(raw);
    expect(resolveBotDefaults(parsed)).toEqual({ ...raw, network: true });
  });

  it.each([['qa', true, false], ['write', false, true], ['full', false, true]] as const)(
    'derives network from %s while accepting the old network field', (permission, network, expected) => {
      const defaults = parseBotDefaults({ permission, network });
      expect(defaults).toEqual({ permission, network });
      expect(resolveBotDefaults(defaults)).toMatchObject({ permission, network: expected });
    },
  );

  const malformed = [
    null, [], 'secret-value', { backend: '' }, { backend: '  ' }, { backend: ' padded ' }, { backend: 4 },
    { model: { kind: 'custom', id: ' padded ' } }, { model: 'model' }, { model: null }, { model: { kind: 'custom', id: '' } },
    { model: { kind: 'catalog', id: 'm', effort: 'super' } },
    { model: { kind: 'unknown', id: 'm' } }, { model: { kind: 'catalog' } },
    { model: { kind: 'custom', id: 'm', future: 'secret-value' } },
    { permission: 'admin' }, { network: 'true' }, { effort: 'high' }, { future: 'secret-value' },
  ];
  it.each(malformed.map((value, index) => ({ value, index })))('rejects malformed block $index without leaking input', ({ value }) => {
    expect(() => parseBotDefaults(value)).toThrow('preferences.defaults');
    try { parseBotDefaults(value); } catch (error) {
      expect(String(error)).not.toMatch(/secret-value|future/);
    }
  });

  it('identifies known malformed paths without exposing values or arbitrary keys', () => {
    expect(() => parseBotDefaults({ model: { kind: 'custom', id: 'm', effort: 'private-token' } }))
      .toThrow('preferences.defaults.model.effort');
    try { parseBotDefaults({ 'private-token': 'other-secret' }); } catch (error) {
      expect(String(error)).not.toMatch(/private-token|other-secret/);
    }
  });
});

describe('config persistence', () => {
  it('leaves missing files and absent defaults untouched', async () => {
    const missing = join(root, 'missing', 'config.json');
    expect(await loadConfig(missing)).toEqual({});
    await expect(stat(dirname(missing))).rejects.toMatchObject({ code: 'ENOENT' });
    const legacy = { accounts, preferences: { messageReply: 'text', oldPreference: { value: 1 } }, metadata: ['retained'] };
    const file = await rawFile('legacy', legacy);
    const before = await readFile(file, 'utf8');
    const loaded = await loadConfig(file);
    expect(loaded).toEqual(legacy);
    expect(loaded.preferences).not.toHaveProperty('defaults');
    expect(await readFile(file, 'utf8')).toBe(before);
    await saveConfig({ ...loaded, accounts }, file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(legacy);
  });

  it('preserves defaults and unknown metadata through load-edit-save', async () => {
    const defaults = { backend: 'future', model: { kind: 'custom', id: 'm', effort: 'max' }, network: false };
    const original = { accounts, preferences: { defaults, unknownPreference: ['a'] }, metadata: { unknown: true } };
    const file = await rawFile('preserved', original);
    const loaded = await loadConfig(file);
    await saveConfig({ ...loaded, accounts, preferences: { ...loaded.preferences, messageReply: 'text' } }, file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...original, preferences: { ...original.preferences, messageReply: 'text' } });
  });

  it('rejects malformed reads without rewriting the file', async () => {
    const file = await rawFile('bad-read', { accounts, preferences: { defaults: { network: 'secret-value' } } });
    const before = await readFile(file, 'utf8');
    await expect(loadConfig(file)).rejects.toThrow('preferences.defaults.network');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('does not expose malformed JSON content in errors', async () => {
    const file = await rawFile('invalid-json', {});
    await writeFile(file, '{private-token');
    await expect(loadConfig(file)).rejects.toThrow('Invalid config JSON');
    await expect(loadConfig(file)).rejects.not.toThrow('private-token');
    expect(await readFile(file, 'utf8')).toBe('{private-token');
  });

  it('validates saves before creating directories or overwriting bytes', async () => {
    const invalid = externalConfig({ network: 'secret-value' });
    const newPath = join(root, 'not-created', 'config.json');
    await expect(saveConfig(invalid, newPath)).rejects.toThrow('preferences.defaults.network');
    await expect(stat(dirname(newPath))).rejects.toMatchObject({ code: 'ENOENT' });
    const file = await rawFile('no-overwrite', { accounts });
    const before = await readFile(file, 'utf8');
    await expect(saveConfig(invalid, file)).rejects.toThrow('preferences.defaults.network');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(dirname(file))).toEqual(['config.json']);
  });

  it('snapshots queued writes and validates their serialized representation', async () => {
    const file = join(root, 'snapshot', 'config.json');
    const cfg: AppConfig = { accounts, preferences: { defaults: { network: false } } };
    const saved = saveConfig(cfg, file);
    cfg.preferences = { defaults: { network: true } };
    await saved;
    expect((await loadConfig(file)).preferences?.defaults?.network).toBe(false);
    const override = { ...cfg, toJSON: () => ({ accounts, preferences: { defaults: { permission: 'secret-value' } } }) };
    await expect(saveConfig(override, file)).rejects.toThrow('preferences.defaults.permission');
    expect((await loadConfig(file)).preferences?.defaults?.network).toBe(false);
  });

  it('retains compare-and-swap and allows later writes after conflicts', async () => {
    const file = join(root, 'cas', 'config.json');
    const initial: AppConfig = { accounts, preferences: { defaults: { permission: 'qa' } } };
    await saveConfig(initial, file);
    const next: AppConfig = { ...initial, preferences: { defaults: { permission: 'full' } } };
    await saveConfig(next, file, initial);
    await expect(saveConfig(initial, file, initial)).rejects.toThrow('配置已被其他进程修改');
    expect(await loadConfig(file)).toEqual(next);
    await saveConfig(initial, file, next);
    expect(await loadConfig(file)).toEqual(initial);
  });

  it('isolates explicit bot paths from each other and the active path', async () => {
    const activeBefore = await loadConfig();
    const a = join(root, 'bot-a', 'config.json');
    const b = join(root, 'bot-b', 'config.json');
    const cfgA: AppConfig = { accounts, preferences: { defaults: { model: { kind: 'catalog', id: 'a' }, network: false } } };
    const cfgB: AppConfig = { accounts, preferences: { defaults: { model: { kind: 'custom', id: 'b', effort: 'low' }, permission: 'full' } } };
    await Promise.all([saveConfig(cfgA, a), saveConfig(cfgB, b)]);
    expect(await loadConfig(a)).toEqual(cfgA);
    expect(await loadConfig(b)).toEqual(cfgB);
    expect(await loadConfig()).toEqual(activeBefore);
  });
});

describe('registration account construction', () => {
  it('rejects invalid supplied defaults before wrapper side effects', async () => {
    await expect(buildEncryptedAccountConfig('fixture', 'feishu', externalConfig({ permission: 'secret-value' }).preferences))
      .rejects.toThrow('preferences.defaults.permission');
    await expect(stat(dirname(paths.secretsGetterScript))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes explicit write/network-on defaults with absent selections omitted', async () => {
    const cfg = await buildEncryptedAccountConfig('fixture', 'feishu');
    expect(cfg.preferences).toEqual({ defaults: { permission: 'write', network: true } });
    const file = join(root, 'new-account', 'config.json');
    await saveConfig(cfg, file);
    expect((await loadConfig(file)).preferences).toEqual(cfg.preferences);
    expect(cfg.accounts.app.secret).toMatchObject({ source: 'exec', provider: 'bridge' });
  });

  it('writes the network effect of a supplied tier instead of the legacy network switch', async () => {
    const cfg = await buildEncryptedAccountConfig('fixture', 'feishu', { defaults: { permission: 'write', network: false } });
    expect(cfg.preferences?.defaults).toEqual({ permission: 'write', network: true });
  });

  it('retains existing preferences and supplied defaults without input mutation', async () => {
    const parsed = externalConfig({ backend: 'other', model: { kind: 'custom', id: 'm', effort: 'high' }, permission: 'qa', network: false });
    const supplied = { ...parsed.preferences, messageReply: 'text' as const, unknownPreference: { data: ['retained'] } };
    const before = structuredClone(supplied);
    const cfg = await buildEncryptedAccountConfig('fixture', 'feishu', supplied);
    expect(cfg.preferences).toEqual(before);
    expect(supplied).toEqual(before);
    expect(cfg.preferences).not.toBe(supplied);
    expect(cfg.preferences?.defaults).not.toBe(supplied.defaults);
  });

  it('initializes recovered preferences while leaving stored legacy config untouched', async () => {
    const file = await rawFile('recovered', { accounts, preferences: { messageReply: 'text' } });
    const before = await readFile(file, 'utf8');
    const loaded = await loadConfig(file);
    const cfg = await buildEncryptedAccountConfig('fixture', 'feishu', loaded.preferences);
    expect(cfg.preferences).toEqual({ messageReply: 'text', defaults: { permission: 'write', network: true } });
    expect(loaded.preferences).toEqual({ messageReply: 'text' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

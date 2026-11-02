import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCodexCatalogCache } from '../src/agent/codex-appserver/models';
import type { ModelInfo } from '../src/agent/types';

let home: string, bin: string;
const model: ModelInfo = { id: 'native-model', displayName: 'Native', description: '', hidden: false, isDefault: true, supportedEfforts: ['medium'], defaultEffort: 'medium', serviceTiers: [{id: 'fast', name: 'Fast', description: ''}] };
const value = () => ({ models: [model], expiresAt: Date.now() + 30_000 });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codex-catalog-cache-')); bin = join(home, 'codex'); writeFileSync(bin, 'fixture'); vi.stubEnv('CODEX_HOME', home); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('shares discovery and successful metadata across callers until explicit refresh', async () => {
  const discover = vi.fn(async () => value());
  const cache = createCodexCatalogCache(discover);
  await Promise.all([cache.read(bin), cache.read(bin), cache.read(bin)]);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(await cache.read(bin)).toEqual([model]);
  expect(discover).toHaveBeenCalledTimes(1);
  await cache.read(bin, true);
  expect(discover).toHaveBeenCalledTimes(2);
});

it('starts one shared forced discovery without waiting for an ordinary in-flight read', async () => {
  let finishFirst!: () => void;
  let source = 'before-refresh';
  const discover = vi.fn().mockImplementationOnce(() => {
    const captured = source;
    return new Promise<void>(resolve => { finishFirst = resolve; }).then(() => ({ ...value(), models: [{ ...model, id: captured }] }));
  }).mockImplementation(() => Promise.resolve({ ...value(), models: [{ ...model, id: source }] }));
  const cache = createCodexCatalogCache(discover);
  const ordinary = cache.read(bin).catch(error => error);
  source = 'after-refresh';
  const forced = [cache.read(bin, true), cache.read(bin, true)];
  expect((await Promise.all(forced)).map(models => models[0]?.id)).toEqual(['after-refresh', 'after-refresh']);
  finishFirst();
  expect(await ordinary).toBeInstanceOf(Error);
  expect(discover).toHaveBeenCalledTimes(2);
  expect(cache.peek(bin)?.[0]?.id).toBe('after-refresh');
});

it('can retry a failed forced discovery even while an older ordinary read is pending', async () => {
  let failFirst!: (error: Error) => void;
  const discover = vi.fn()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
    .mockRejectedValueOnce(new Error('refresh unavailable'))
    .mockResolvedValue(value());
  const cache = createCodexCatalogCache(discover);
  const ordinary = cache.read(bin).catch(error => error);
  const forced = cache.read(bin, true).catch(error => error);
  expect(await forced).toMatchObject({ message: 'refresh unavailable' });
  expect(cache.peek(bin)).toBeUndefined();
  expect(await cache.read(bin, true)).toEqual([model]);
  failFirst(new Error('ordinary unavailable'));
  expect(await ordinary).toBeInstanceOf(Error);
  expect(cache.peek(bin)).toEqual([model]);
  expect(discover).toHaveBeenCalledTimes(3);
});

it('does not let late old-identity or ordinary flights overwrite the forced new identity', async () => {
  let finishOld!: (catalog: ReturnType<typeof value>) => void;
  let finishNew!: (catalog: ReturnType<typeof value>) => void;
  const discover = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }))
    .mockResolvedValue({ ...value(), models: [{ ...model, id: 'forced-new' }] });
  const cache = createCodexCatalogCache(discover);
  const old = cache.read(bin).catch(error => error);
  writeFileSync(join(home, 'config.toml'), 'new identity');
  const newOrdinary = cache.read(bin).catch(error => error);
  const forced = cache.read(bin, true);
  expect((await forced)[0]?.id).toBe('forced-new');
  finishOld({ ...value(), models: [{ ...model, id: 'old' }] });
  expect(await old).toBeInstanceOf(Error);
  finishNew({ ...value(), models: [{ ...model, id: 'ordinary-new' }] });
  expect(await newOrdinary).toBeInstanceOf(Error);
  expect(cache.peek(bin)?.[0]?.id).toBe('forced-new');
  expect(discover).toHaveBeenCalledTimes(3);
});

it('keeps native model identities after evidence expiry but drops unconfirmed speed tiers without launching a process', async () => {
  vi.useFakeTimers();
  const discover = vi.fn(async () => value());
  const cache = createCodexCatalogCache(discover);
  await cache.read(bin);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(await cache.read(bin)).toEqual([expect.objectContaining({ id: model.id })]);
  expect(cache.peek(bin)?.[0]).not.toHaveProperty('serviceTiers');
  expect(discover).toHaveBeenCalledTimes(1);
});

it.each(['config.toml', 'auth.json', 'requirements.toml', 'models_cache.json'])('invalidates metadata when %s changes', async file => {
  const discover = vi.fn(async () => value());
  const cache = createCodexCatalogCache(discover);
  await cache.read(bin);
  writeFileSync(join(home, file), 'changed');
  expect(cache.peek(bin)).toBeUndefined();
  await cache.read(bin);
  expect(discover).toHaveBeenCalledTimes(2);
});

it('invalidates when an unchanged custom catalog path is replaced', async () => {
  const file = join(home, 'catalog.json'); writeFileSync(file, 'original');
  const discover = vi.fn(async () => ({ ...value(), catalogPath: file }));
  const cache = createCodexCatalogCache(discover);
  await cache.read(bin);
  writeFileSync(file, 'different catalog bytes');
  expect(cache.peek(bin)).toBeUndefined();
  await cache.read(bin);
  expect(discover).toHaveBeenCalledTimes(2);
});

it('does not expose an old ready catalog after a failed explicit refresh and allows retry', async () => {
  const discover = vi.fn(async () => value());
  const cache = createCodexCatalogCache(discover);
  await cache.read(bin);
  discover.mockRejectedValueOnce(new Error('offline'));
  await expect(cache.read(bin, true)).rejects.toThrow('offline');
  expect(cache.peek(bin)).toBeUndefined();
  expect(await cache.read(bin)).toEqual([model]);
});

it('a late old-identity discovery cannot replace the new identity', async () => {
  let finish!: (catalog: ReturnType<typeof value>) => void;
  const discover = vi.fn(async () => value()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const cache = createCodexCatalogCache(discover);
  const old = cache.read(bin).catch(error => error);
  writeFileSync(join(home, 'config.toml'), 'new identity');
  await cache.read(bin);
  finish({ models: [{ ...model, id: 'old' }], expiresAt: Date.now() + 30_000 });
  expect(await old).toBeInstanceOf(Error);
  expect(cache.peek(bin)?.[0]?.id).toBe('native-model');
});

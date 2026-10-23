import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { judgeModelsFile, readJudgeModels, resolveProviderChoiceSync, writeJudgeModels } from '../src/judge/global-models';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('hot reads an atomic global override and rejects corrupt explicit settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'judge-models-')); roots.push(root);
  expect(resolveProviderChoiceSync('typesafe', root)).toEqual({ model: 'jev-latest' });
  await writeJudgeModels({ byProvider: { 'claude-agent': { model: 'one', effort: 'low', custom: true } } }, root);
  expect(resolveProviderChoiceSync('claude-agent', root)).toEqual({ model: 'one', effort: 'low', custom: true });
  await writeJudgeModels({ byProvider: { 'claude-agent': { model: 'two', effort: 'high' } } }, root);
  expect(resolveProviderChoiceSync('claude-agent', root)).toEqual({ model: 'two', effort: 'high' });
  expect(JSON.parse(await readFile(judgeModelsFile(root), 'utf8')).version).toBe(1);
  await writeFile(judgeModelsFile(root), '{"version":1,"byProvider":{"claude-agent":{"model":"bad id"}}}');
  await expect(readJudgeModels(root)).rejects.toThrow('无效');
  expect(() => resolveProviderChoiceSync('claude-agent', root)).toThrow('无效');
});

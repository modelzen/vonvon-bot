import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getClaudeModelsWithSettings } from '../src/agent/providers/claude/models';

const created: string[] = [];
afterEach(async () => { await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('Claude model catalog without a query turn', () => {
  it('includes configured model IDs from a local settings file', async () => {
    const root = await mkdtemp(join(process.env.VONVON_HOME ?? tmpdir(), 'vonvon-claude-catalog-'));
    created.push(root);
    await writeFile(join(root, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'custom-catalog-model' } }));
    const logger = { debug: () => {} };
    const models = await getClaudeModelsWithSettings(logger, root);
    expect(models.some((model) => model.id === 'custom-catalog-model')).toBe(true);
  });
});

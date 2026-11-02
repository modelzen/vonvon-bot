import { expect, it } from 'vitest';
import { collaborationReplySchema, collaborationRequestSchema } from '../src/collaboration';
import { modelCatalogSchema, projectEditableSchemas } from '../src/settings';

it('allows Bot-free native Provider model discovery and rejects unrelated fields', () => {
  expect(collaborationRequestSchema.parse({ action: 'providerModels', backend: 'claude-agent' })).toEqual({ action: 'providerModels', backend: 'claude-agent' });
  expect(collaborationRequestSchema.safeParse({ action: 'providerModels', backend: 'claude-agent', agentId: 'cli_fake' }).success).toBe(false);
  expect(collaborationReplySchema.parse({ kind: 'providerModels', backend: 'claude-agent', state: 'unavailable', models: [], message: 'No native catalog' })).toMatchObject({ state: 'unavailable', models: [] });
});

it('preserves provider-defined effort IDs in model access and catalog payloads', () => {
  const efforts = ['future-adaptive', ...Array.from({ length: 9 }, (_, i) => `native-${i}`)];
  const access = { backend: 'codex-appserver', models: ['native'], efforts,
    modelEfforts: { native: efforts }, modelServiceTiers: { native: ['fast'] },
    defaultModel: 'native', defaultEffort: 'future-adaptive' };
  expect(projectEditableSchemas.modelAccess.parse(access)).toEqual(access);
  const catalog = { backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: '', titleEfforts: efforts,
    models: [{ id: 'native', displayName: 'Native', description: '', supportedEfforts: efforts,
      defaultEffort: 'future-adaptive', isDefault: true, hidden: false }] };
  expect(modelCatalogSchema.parse(catalog).models[0]?.supportedEfforts).toEqual(efforts);
  expect(projectEditableSchemas.modelAccess.safeParse({ ...access, defaultEffort: ' ' }).success).toBe(false);
  expect(modelCatalogSchema.safeParse({ ...catalog, models: [{ ...catalog.models[0], defaultEffort: 'x'.repeat(1001) }] }).success).toBe(false);
});

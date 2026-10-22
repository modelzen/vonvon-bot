import { expect, it } from 'vitest';
import { collaborationReplySchema, collaborationRequestSchema } from '../src/collaboration';

it('allows Bot-free native Provider model discovery and rejects unrelated fields', () => {
  expect(collaborationRequestSchema.parse({ action: 'providerModels', backend: 'claude-agent' })).toEqual({ action: 'providerModels', backend: 'claude-agent' });
  expect(collaborationRequestSchema.safeParse({ action: 'providerModels', backend: 'claude-agent', agentId: 'cli_fake' }).success).toBe(false);
  expect(collaborationReplySchema.parse({ kind: 'providerModels', backend: 'claude-agent', state: 'unavailable', models: [], message: 'No native catalog' })).toMatchObject({ state: 'unavailable', models: [] });
});

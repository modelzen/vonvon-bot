import { randomUUID } from 'node:crypto';
import type { RichRecipeState } from '../../src/recipe/rich-state';

export function legacyWorkRules(...texts: string[]): RichRecipeState {
  return {
    pointer: {
      format: 'recipe-generation-1', installationId: randomUUID(), generationId: randomUUID(), selection: 'effective',
      rootIdentity: 'fixture', resolvedSha256: '1'.repeat(64),
      release: { format: 'rich-v2', recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(),
        revision: 1, access: 'direct', contentSha256: '2'.repeat(64), logicalBytes: 100 },
    },
    bindingIncarnation: 'binding',
    resolved: texts.map(text => ({ kind: 'rules', itemId: randomUUID(), originId: randomUUID(), value: { purpose: 'work', text } })),
    sources: {}, choices: {}, setup: {}, installedAt: 1, receipt: 'fixture',
  };
}

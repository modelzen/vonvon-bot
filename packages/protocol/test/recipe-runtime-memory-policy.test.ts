import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { recipeInstallRequestSchema, canonicalizeRichRecipeContent } from '../src/index.js';
import { richRuntimeRequests } from './fixtures/recipe-runtime-pre-memory-policy.js';

const botId = 'cli_policy', groupId = 'oc_policy', operationId = randomUUID();
const legacyRequest = z.discriminatedUnion('type', richRuntimeRequests);
const raw: unknown = JSON.parse(readFileSync(new URL('./fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8'));
const doc = canonicalizeRichRecipeContent(raw);
const sha = 'a'.repeat(64);
const prepare = {
  type: 'richPrepare', botId, groupId, canonical: doc.canonical, parts: {},
  preview: {
    accountId: randomUUID(),
    release: { format: 'rich-v2', recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(),
      revision: 1, access: 'direct', logicalBytes: doc.logicalBytes, contentSha256: sha },
    manifest: { objectId: randomUUID(), kind: 'manifest', sha256: sha,
      bytes: doc.canonicalUTF8.length, mediaType: 'application/json' },
  },
};

it.each([prepare, { type: 'richIssuing', botId, operationId }, { type: 'richCommit', botId, operationId }])(
  'accepts optional exclude policy only on $type and makes old targets reject it', request => {
    expect(recipeInstallRequestSchema.parse(request)).toEqual(request);
    expect(legacyRequest.parse(request)).toEqual(request);
    const guarded = { ...request, memoryPolicy: 'exclude' };
    expect(recipeInstallRequestSchema.parse(guarded)).toEqual(guarded);
    expect(legacyRequest.safeParse(guarded).success).toBe(false);
    for (const memoryPolicy of ['include', 'keep', '', null, true, {}])
      expect(recipeInstallRequestSchema.safeParse({ ...request, memoryPolicy }).success).toBe(false);
    expect(recipeInstallRequestSchema.safeParse({ ...guarded, otherPolicy: 'exclude' }).success).toBe(false);
  },
);

it.each(['richStatus', 'richCancel', 'richReconcile'])('keeps %s compatible without widening its strict schema', type => {
  const request = { type, botId, operationId };
  expect(recipeInstallRequestSchema.parse(request)).toEqual(legacyRequest.parse(request));
  expect(recipeInstallRequestSchema.safeParse({ ...request, memoryPolicy: 'exclude' }).success).toBe(false);
});

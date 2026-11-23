import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {expect, it} from 'vitest';
import {canonicalizeRichRecipeContent, recipeRichDraftSchema, type RecipeRichDraft} from '@vonvon/protocol';
import {communityRequest} from '../../desktop/src/community-api';
import {MetadataJournal} from '../../desktop/src/community-metadata-journal';
import type {NativeAccount} from '../../desktop/src/account-session';

const accountId = '44444444-4444-4444-8444-444444444444';
const draftId = '55555555-5555-4555-8555-555555555555';
function richDraft(revision: number, name = '原始内容'): RecipeRichDraft {
  const content = JSON.parse(readFileSync(resolve(process.cwd(), '../protocol/test/fixtures/recipe-rich-v2.content.json'), 'utf8'));
  content.parts = []; content.memories = []; delete content.finalLogo;
  content.public.name.value = name;
  const doc = canonicalizeRichRecipeContent(content);
  return recipeRichDraftSchema.parse({format: 'rich-v2', draftId, recipeId: null, revision, sourceIntentId: '019a8000-0000-7000-8000-000000000001', public: {...Object.fromEntries(Object.entries(doc.content.public).map(([field, item]) => [field, item.value])), access: 'direct'}, rich: {content: doc.content, texts: {}, canonical: Buffer.from(doc.canonicalUTF8).toString('base64url')}});
}
const hash = (draft: RecipeRichDraft) => createHash('sha256').update(Buffer.from(draft.rich.canonical, 'base64url')).digest('hex');

it.each([2, 3])('preserves pending Main metadata on ordinary reads and recovers only verified r%i across journal restarts', async finalRevision => {
  const dir = mkdtempSync(resolve(tmpdir(), 'vonvon-metadata-recovery-'));
  const correct = richDraft(2, '已确认内容'), requestId = '019a8000-0000-7000-8000-000000000099';
  const receipt = {requestId, draftId, revision: 2, manifestSha256: hash(correct)};
  const journal = new MetadataJournal(dir), key = journal.key(accountId, draftId);
  const pending = {request: {type: 'saveRichDraftMetadata' as const, accountId, requestId, draftId, revision: 1, baseManifestSha256: hash(richDraft(1)), public: correct.public, logo: {kind: 'keep' as const}}};
  journal.write(key, pending);
  let current: RecipeRichDraft | undefined = richDraft(1);
  const status = {kind: 'signedIn', accountId, displayName: '作者', provider: 'github', persistence: 'memory'} as const;
  const calls: Array<{path: string; method: string}> = [];
  const account: NativeAccount = {
    status: () => status, onStatus: () => () => {}, login: async () => status, logout: async () => status, cancelLogin: async () => status, dispose: async () => {},
    async request(_id, path, init) {
      calls.push({path, method: init?.method ?? 'GET'});
      if (path.endsWith('/metadata')) return Response.json({status: 'committed', receipt});
      if (!current) throw new Error('offline');
      const bytes = Buffer.from(current.rich.canonical, 'base64url');
      if (path.endsWith('/objects/' + requestId)) return new Response(bytes);
      if (path !== '/v2/drafts/' + draftId) throw new Error('Unexpected ' + path);
      return Response.json({format: 'rich-v2', draftId, recipeId: null, revision: current.revision, access: current.public.access, sourceIntentId: current.sourceIntentId, manifest: {kind: 'manifest', objectId: requestId, bytes: bytes.length, sha256: hash(current), mediaType: 'application/json'}, logicalBytes: bytes.length, retainedCandidateBytes: 0, sourceManifest: null});
    },
  };
  const recover = () => communityRequest(account, {type: 'recoverRichDraftMetadata', accountId, draftId}, new MetadataJournal(dir));
  try {
    expect((await communityRequest(account, {type: 'draft', accountId, draftId}, new MetadataJournal(dir))).revision).toBe(1);
    expect(journal.read(key)).toEqual(pending);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.some(call => call.path.endsWith('/metadata'))).toBe(false);
    current = undefined;
    expect(await recover()).toEqual({status: 'committed', receipt});
    for (const stale of [richDraft(1), richDraft(2, '错误内容')]) {
      current = stale;
      expect(await recover()).toEqual({status: 'committed', receipt});
      expect(journal.read(key)?.receipt).toEqual(receipt);
    }
    current = finalRevision === 2 ? correct : richDraft(3, '后续修订');
    expect(await recover()).toMatchObject({status: 'committed', receipt, draft: {revision: finalRevision}});
    expect(journal.read(key)).toBeUndefined();
    expect(calls.filter(call => call.method !== 'GET')).toEqual([{path: '/v2/drafts/' + draftId + '/metadata', method: 'PATCH'}]);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

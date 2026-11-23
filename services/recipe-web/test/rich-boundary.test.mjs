import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {richDetail} from '../dist/rich-detail.mjs';

const golden = JSON.parse(await readFile(new URL('../../../packages/protocol/test/fixtures/recipe-rich-v2.golden.json', import.meta.url), 'utf8'));
const content = JSON.parse(golden.canonical), bytes = Buffer.from(golden.canonical);
const recipeId = '11111111-1111-4111-8111-111111111111', versionId = '22222222-2222-4222-8222-222222222222', authorId = '33333333-3333-4333-8333-333333333333';
const raw = {
  recipeId, versionId, revision: 1, format: 'rich-v2', state: 'listed', visibility: 'full',
  public: {...Object.fromEntries(Object.entries(content.public).map(([key, item]) => [key, item.value])), access: 'direct'},
  creator: {authorId, displayName: '合成作者'}, hasDisplayLogo: false, owned: false, acquired: false,
  manifest: {objectId: '44444444-4444-4444-8444-444444444444', kind: 'manifest', sha256: golden.sha256, bytes: bytes.length, mediaType: 'application/json'},
  release: {format: 'rich-v2', recipeId, versionId, authorId, revision: 1, access: 'direct', contentSha256: golden.sha256, logicalBytes: golden.logicalBytes},
};

test('rich read boundary refuses wrong versions, scope, creator and non-contract storage fields before any member request', async () => {
  const malformed = [
    {...raw, versionId: authorId},
    {...raw, visibility: 'intro'},
    {...raw, public: {...raw.public, access: 'coded'}},
    {...raw, creator: {...raw.creator, authorId: versionId}},
    {...raw, StorageURL: 'http://127.0.0.1/private'},
  ];
  for (const data of malformed) {
    let reads = 0;
    await assert.rejects(richDetail(data, recipeId, versionId, () => {reads++; return bytes;}));
    assert.equal(reads, 0);
  }
});

test('rich read boundary verifies exact manifest and text bytes against release membership', async () => {
  const corrupt = Buffer.from(bytes); corrupt[0] ^= 1;
  await assert.rejects(richDetail(raw, recipeId, versionId, async () => corrupt), /Invalid rich recipe response/);
  const paths = [];
  await assert.rejects(richDetail(raw, recipeId, versionId, async path => {
    paths.push(path); return path.endsWith(raw.manifest.objectId) ? bytes : Buffer.from('xxxx');
  }), /Invalid rich recipe response/);
  assert.deepEqual(paths, ['/v2/versions/' + versionId + '/objects/' + raw.manifest.objectId, '/v2/versions/' + versionId + '/objects/' + content.parts[0].objectId]);
});

test('coded intro never reads members and rejects unnormalized display images', async () => {
  const {release, manifest, ...data} = raw;
  const intro = {...data, public: {...raw.public, access: 'coded'}, visibility: 'intro'};
  const result = await richDetail(intro, recipeId, versionId, () => assert.fail('intro must not read members'));
  assert.equal(result.rich, undefined); assert.equal(result.logo, undefined);
  await assert.rejects(richDetail({...intro, hasDisplayLogo: true}, recipeId, versionId, async path => {
    assert.equal(path, '/v2/versions/' + versionId + '/display-logo');
    return Buffer.from('<svg onload="alert(1)"></svg>');
  }), /invalid_logo/);
});

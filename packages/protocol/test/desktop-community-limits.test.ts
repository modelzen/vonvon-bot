import {describe, expect, it} from 'vitest';
import {communityRequestSchema, communityResponseSchemas, recipeConfigSchema, recipePublicSchema, publicDisplayNameSchema} from '../src/desktop-community.js';
import {checkDraft, queryParams} from '../../../services/recipe-api/src/input.mjs';

const recipeId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const meta = {name: '示例', summary: '简介', overview: '', version: '1', access: 'direct' as const};
const apiAccepts = (action: () => unknown) => {try {action(); return true;} catch {return false;}};
const config = {role: ''};
describe('native and API text contract parity', () => {
  it.each([['name', 60], ['summary', 240], ['version', 40]] as const)('uses Unicode code points for %s in stored catalog data and draft input', (field, limit) => {
    for (const character of ['中', '🦉']) for (const length of [limit - 1, limit, limit + 1]) {
      const value = {...meta, [field]: character.repeat(length)};
      const expected = length <= limit;
      expect(recipePublicSchema.safeParse(value).success, `${field}/${character}/${length}`).toBe(expected);
      expect(apiAccepts(() => checkDraft({public: value, config}, true))).toBe(expected);
      expect(communityResponseSchemas.catalog.safeParse({hero: {recipeId, versionId, revision: 1, public: value}, items: [], nextCursor: null}).success).toBe(expected);
    }
  });
  it('uses Unicode code points for setup titles and search terms', () => {
    for (const length of [79, 80, 81]) {
      const value = {role: '', setup: {steps: [{kind: 'config', title: '🦉'.repeat(length), instructions: '', required: false}]}};
      expect(recipeConfigSchema.safeParse(value).success).toBe(length <= 80);
      expect(apiAccepts(() => checkDraft({public: meta, config: value}, true))).toBe(length <= 80);
    }
    for (const length of [119, 120, 121]) {
      const query = '🦉'.repeat(length);
      expect(communityRequestSchema.safeParse({type: 'catalog', query}).success).toBe(length <= 120);
      expect(apiAccepts(() => queryParams(new URL('https://example.test/?q=' + encodeURIComponent(query)), ['q']))).toBe(length <= 120);
    }
  });
  it.each([['overview', 32768], ['role', 16384], ['instructions', 2048], ['check', 512]] as const)('matches the API UTF-8 byte boundary for %s', (field, limit) => {
    for (const character of ['中', '🦉']) for (const delta of [-1, 0, 1]) {
      const bytes = new TextEncoder().encode(character).length;
      const value = character.repeat(Math.floor((limit + delta) / bytes)) + 'a'.repeat((limit + delta) % bytes);
      const pub = {...meta, ...(field === 'overview' ? {overview: value} : {})};
      const cfg = {role: field === 'role' ? value : '', setup: {steps: [{kind: 'config', title: '', instructions: field === 'instructions' ? value : '', required: false, ...(field === 'check' ? {check: value} : {})}]}};
      const expected = delta <= 0;
      expect(recipePublicSchema.safeParse(pub).success && recipeConfigSchema.safeParse(cfg).success, `${field}/${character}/${delta}`).toBe(expected);
      expect(apiAccepts(() => checkDraft({public: pub, config: cfg}, true))).toBe(expected);
    }
  });
  it('rejects malformed surrogate text as the API does', () => {
    for (const value of ['\ud800', '\udfff', 'a\0b']) {
      expect(recipePublicSchema.safeParse({...meta, name: value}).success).toBe(false);
      expect(() => checkDraft({public: {...meta, name: value}, config}, true)).toThrow();
    }
  });
});

it('accepts current batch states without disclosing plaintext for redeemed or disabled codes, while reveal remains available-only', () => {
  const available = {codeId: recipeId, status: 'available', code: 'A'.repeat(32)};
  const redeemed = {codeId: versionId, status: 'redeemed'};
  const disabled = {codeId: recipeId, status: 'disabled'};
  expect(communityResponseSchemas.issueCodes.parse({items: [available, redeemed, disabled]})).toEqual({items: [available, redeemed, disabled]});
  for (const item of [redeemed, disabled]) {
    expect(communityResponseSchemas.issueCodes.safeParse({items: [{...item, code: 'A'.repeat(32)}]}).success).toBe(false);
    expect(communityResponseSchemas.revealCode.safeParse(item).success).toBe(false);
  }
  expect(communityResponseSchemas.revealCode.parse(available)).toEqual(available);
});

it('validates normalized account nicknames by Unicode code points', () => {
  expect(publicDisplayNameSchema.parse('  作者  ')).toBe('作者');
  expect(publicDisplayNameSchema.parse('🦉'.repeat(60))).toBe('🦉'.repeat(60));
  for (const displayName of ['', ' ', 'a@b', 'a\nb', 'a\u007fb', '\ud800', '🦉'.repeat(61)]) {
    expect(publicDisplayNameSchema.safeParse(displayName).success).toBe(false);
  }
  expect(communityRequestSchema.safeParse({type: 'profile'}).success).toBe(false);
  expect(communityRequestSchema.safeParse({type: 'saveProfile', accountId: recipeId, requestId: versionId, displayName: '作者', privateName: 'OAuth 姓名'}).success).toBe(false);
});

it('canonicalizes compatibility and whitespace forms while keeping Chinese and emoji nicknames', () => {
  expect(publicDisplayNameSchema.parse('　Ｆｏｏ　　昵称  👩‍💻  ')).toBe('Foo 昵称 👩‍💻');
  for (const name of ['a\u200bb','a\u202eb','a\ufeffb','a\u00adb','＠name','\u200d','\ufe0f','\u115f','\u1160','\u3164','\uffa0','a\u3164b','a\u{1bca0}b'])
    expect(publicDisplayNameSchema.safeParse(name).success).toBe(false);
  expect(publicDisplayNameSchema.parse('é')).toBe(publicDisplayNameSchema.parse('e\u0301'));
});

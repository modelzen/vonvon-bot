import { describe, expect, it } from 'vitest';
import { draftPreviewLocatorSchema, draftPreviewNavigationSchema } from '../src/recipe-preview.js';
const draftId = '8d85af21-e80d-4665-a6b8-ccf162dc1923';
describe('draft preview navigation contract', () => {
  it('contains only a draft locator, never publication authority', () => {
    expect(draftPreviewLocatorSchema.parse({draftId, revision: 3})).toEqual({draftId, revision: 3});
    for (const extra of [{accountId: draftId}, {approval: true}, {publish: true}, {token: 'secret'}]) {
      expect(draftPreviewLocatorSchema.safeParse({draftId, revision: 3, ...extra}).success).toBe(false);
    }
    for (const revision of [undefined, 0, -1, 1.2, '2', Number.MAX_SAFE_INTEGER + 1]) {
      expect(draftPreviewLocatorSchema.safeParse({draftId, revision}).success).toBe(false);
    }
    expect(draftPreviewNavigationSchema.safeParse({draftId, revision: 1, navigationId: draftId}).success).toBe(true);
  });
});

import {recipeLibraryGroupsSchema, recipeLibraryVersionsSchema, type RecipeLibraryScope} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import {boundedJson} from './community-response.js';

export function communityLibrary(account: NativeAccount, accountId: string, check: () => void) {
  async function read(scope: RecipeLibraryScope, cursor?: string, recipeId?: string) {
    const query = new URLSearchParams({scope});
    if (cursor) query.set('cursor', cursor);
    const path = '/v2/me/recipe-groups' + (recipeId ? `/${recipeId}/versions` : '') + '?' + query;
    try {
      check();
      const response = await account.request(accountId, path, {method: 'GET'}, check);
      check();
      if (!response.ok) {await response.body?.cancel(); throw new Error('个人配方库读取失败，请重试。');}
      const value = await boundedJson(response, 2 * 1024 * 1024, check);
      check();
      return value;
    } catch (error) {check(); throw error;}
  }
  return {
    async groups(scope: RecipeLibraryScope, cursor?: string) {return recipeLibraryGroupsSchema.parse(await read(scope, cursor));},
    async versions(recipeId: string, scope: RecipeLibraryScope, cursor?: string) {
      const page = recipeLibraryVersionsSchema.parse(await read(scope, cursor, recipeId));
      if (page.items.some(item => item.recipeId !== recipeId)) throw new Error('个人配方库版本不匹配，请重新读取。');
      return page;
    },
  };
}

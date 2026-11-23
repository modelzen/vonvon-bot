import { pathToFileURL } from 'node:url';
import { createReleaseCodeAuth } from './release-code-oauth.mjs';
import { createWebServer } from './web-server.mjs';

export function createRecipeWeb(env = process.env) {
  return createWebServer(env, { createReleaseCodeAuth });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.RECIPE_WEB_PORT || 49151);
  createRecipeWeb().listen(port, '127.0.0.1', () => console.log('Recipe web listening on 127.0.0.1:' + port));
}

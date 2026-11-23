import { DurableObject, env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import pg from 'pg';
import { createVerifier } from './auth.mjs';
import { createRecipeExecutor, verifyRecipeDatabaseRole } from './database.mjs';
import { createRecipeRequestHandler } from './http.mjs';
import { createPublicationReader } from './publication-preview.mjs';
import { normalizeWorkerAvatar } from './worker-avatar.mjs';
import { workerProofMaterials } from './worker-proof-material.mjs';

let issuer;
let verifier;
const handleRecipeRequest = createRecipeRequestHandler({
  admitRich: env.RECIPE_RICH_WRITES === '1',
  publicationRead: createPublicationReader(undefined, (url, options) => {
    const { pathname } = new URL(url);
    return env.RECIPE_BROKER.fetch(`https://recipe-service.internal${pathname}`, options);
  }),
  verify(token) {
    if (issuer !== env.RECIPE_AUTH_ISSUER || !verifier) {
      verifier = createVerifier(env.RECIPE_AUTH_ISSUER);
      issuer = env.RECIPE_AUTH_ISSUER;
    }
    return verifier(token);
  },
  execute(identity, operation, args) {
    const database = {
      waitingCount: 0,
      async connect() {
        const client = new pg.Client({
          connectionString: env.RECIPE_DATABASE.connectionString,
          connectionTimeoutMillis: 8_000,
          query_timeout: 8_000,
        });
        const release = () => client.end().catch(() => {});
        try {
          await client.connect();
          await verifyRecipeDatabaseRole(client);
        } catch (error) {
          await release();
          throw error;
        }
        return { query: client.query.bind(client), release };
      },
    };
    return createRecipeExecutor(database, env.RECIPE_CODE_KEY, workerProofMaterials)(identity, operation, args);
  },
  normalizeAvatar: bytes => normalizeWorkerAvatar(env.RECIPE_IMAGES, bytes),
});
const handler = httpServerHandler(createServer(handleRecipeRequest));
const accountWrite = /^\/(?:api\/)?v2\/me\/account-profile(?:\/initialize)?$/;

export class RecipeApiRuntime extends DurableObject {
  fetch(request) {
    return handler.fetch(request);
  }
}

export default {
  fetch(request, bindings) {
    const { pathname } = new URL(request.url);
    if (!/^\/(?:api\/)?v[12]\//.test(pathname)) {
      return Response.json({ error: { code: 'not_found' } }, {
        status: 404,
        headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    if (bindings.RECIPE_ACCOUNT_WRITES_ONLY === '1' && request.method !== 'GET' &&
        !accountWrite.test(pathname)) {
      return Response.json({ error: { code: 'rich_writes_disabled' } }, {
        status: 503,
        headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    return bindings.RECIPE_API_RUNTIME.getByName('api').fetch(new Request(request, { redirect: 'manual' }));
  },
};

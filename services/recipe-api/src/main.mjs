import { pathToFileURL } from 'node:url';
import { createVerifier } from './auth.mjs';
import { openDatabase } from './database.mjs';
import { createRecipeServer } from './http.mjs';
import {createPublicationReader} from './publication-preview.mjs';

export async function startRecipeService(env = process.env, dependencies = {}) {
  const publicationRead=dependencies.publicationRead??createPublicationReader(env.RECIPE_BROKER_ORIGIN);
  const verify = createVerifier(env.RECIPE_AUTH_ISSUER);
  const port = Number(env.PORT ?? 4317);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  const db = await openDatabase(env.RECIPE_DATABASE_URL, env.RECIPE_CODE_KEY, env.RECIPE_AUTH_ISSUER);
  const server = createRecipeServer({ verify, execute: db.execute, admitRich:env.RECIPE_RICH_WRITES==="1", publicationRead });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (err) {
    await db.close();
    throw err;
  }
  const close = async () => {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await db.close();
  };
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { server, close } = await startRecipeService();
    console.info('Recipe API listening on 127.0.0.1:' + server.address().port);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      close().catch(() => { process.exitCode = 1; });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    // Configuration errors and connection strings can contain database credentials.
    console.error('Recipe API failed to start. Check issuer, database role, code key and port.');
    process.exitCode = 1;
  }
}

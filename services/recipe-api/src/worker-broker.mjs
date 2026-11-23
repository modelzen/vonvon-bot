import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import pg from 'pg';
import { createVerifier, loopback } from './auth.mjs';
import { ApiError } from './errors.mjs';
import { createObjectStore } from './object-store.mjs';
import { createPrivateStorage } from './object-storage.mjs';
import { createRichBrokerRequestHandler } from './rich-broker.mjs';
import { normalizeWorkerAvatar, verifyWorkerNormalizedLogo } from './worker-avatar.mjs';

const readObject = /^\/v2\/(?:drafts|versions)\/[\da-f-]{36}\/objects\/[\da-f-]{36}$/i;
const readLogo = /^\/v2\/versions\/[\da-f-]{36}\/display-logo$/i;
const readInstall = /^\/v2\/operations\/[\da-f-]{36}\/objects\/[\da-f-]{36}$/i;
const writeMember = /^\/v2\/objects\/[\da-f-]{36}\/members\/(?:0|[1-9]\d?)$/i;
const readCalls = new Set(['display_logo', 'read_descriptor', 'install_descriptor', 'storage_absent']);
const responseHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

function directConnectionOptions(bindings) {
  const url = new URL(bindings.RECIPE_VERIFIER_DATABASE_URL);
  const local = loopback(url.hostname) && bindings.RECIPE_BROKER_LOCAL === '1';
  if (!local && !(url.hostname.endsWith('.pooler.supabase.com') || /^db\.[a-z]+\.supabase\.co$/.test(url.hostname))) {
    throw new Error('invalid_object_broker_database_origin');
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.username || !url.password ||
      url.pathname !== '/postgres' || url.hash ||
      (!local && (url.port && url.port !== '5432')) ||
      [...url.searchParams].some(([key,value]) => key !== 'sslmode' || value !== 'verify-full') ||
      url.searchParams.getAll('sslmode').length > 1) {
    throw new Error('invalid_object_broker_database_configuration');
  }
  url.search = '';
  return {
    connectionString: url.href,
    ssl: !local && { rejectUnauthorized: true },
    connectionTimeoutMillis: 8_000,
    query_timeout: 8_000,
  };
}

function requestStore(bindings) {
  const readOnly = bindings.RECIPE_BROKER_READ_ONLY === '1';
  let client;
  let opening;
  async function connect() {
    if (!opening) {
      const options = readOnly ? {
        connectionString: bindings.RECIPE_BROKER_DATABASE.connectionString,
        connectionTimeoutMillis: 8_000,
        query_timeout: 8_000,
      } : directConnectionOptions(bindings);
      client = new pg.Client(options);
      // An idle connection can fail while the broker is waiting on Storage.
      // Individual queries still reject, and the connection is released below.
      client.on('error', () => {});
      opening = client.connect();
    }
    await opening;
    return { query: client.query.bind(client), release() {} };
  }
  const pool = { waitingCount: 0, connect, async query(...args) { return (await connect()).query(...args); } };
  let checkedStore;
  function store() { return checkedStore ??= createObjectStore(pool); }
  return {
    // One checked client serves this invocation, including absence checks made
    // while a member lock is held. Each metadata transaction still commits separately.
    async call(verb, ...args) {
      if (readOnly && !readCalls.has(verb)) throw new ApiError(503, 'rich_writes_disabled');
      return (await store()).call(verb, ...args);
    },
    async withMember(...args) {
      if (readOnly) throw new ApiError(503, 'rich_writes_disabled');
      return (await store()).withMember(...args);
    },
    async close() { await client?.end().catch(() => {}); },
  };
}

let issuer;
let verifier;
function verify(token) {
  if (issuer !== env.RECIPE_AUTH_ISSUER || !verifier) {
    verifier = createVerifier(env.RECIPE_AUTH_ISSUER);
    issuer = env.RECIPE_AUTH_ISSUER;
  }
  return verifier(token);
}

const handler = httpServerHandler(createServer(async (req, res) => {
  const store = requestStore(env);
  try {
    const storage = createPrivateStorage({
      origin: env.RECIPE_STORAGE_ORIGIN,
      bucket: 'recipe-private',
      apiKey: env.RECIPE_STORAGE_API_KEY,
      bearer: env.RECIPE_STORAGE_BEARER,
      verifyAbsent: (bucket, key) => store.call('storage_absent', bucket, key),
    });
    return await createRichBrokerRequestHandler({
      verify, store, storage, admit: env.RECIPE_BROKER_READ_ONLY !== '1' && env.RECIPE_RICH_WRITES === '1',
      normalizeLogo: bytes => normalizeWorkerAvatar(env.RECIPE_IMAGES, bytes),
      verifyNormalizedLogo: bytes => verifyWorkerNormalizedLogo(env.RECIPE_IMAGES, bytes),
    })(req, res);
  } catch {
    res.writeHead(503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify({ error: { code: 'object_broker_unavailable' } }));
  } finally {
    await store.close();
  }
}));

export default {
  fetch(request, bindings, ctx) {
    const { pathname, search } = new URL(request.url);
    const path = pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
    const upload = request.method === 'PUT' && writeMember.test(path);
    const allowed = (request.method === 'GET' && (readObject.test(path) || readLogo.test(path))) ||
      (request.method === 'POST' && readInstall.test(path)) || upload;
    if (bindings.RECIPE_BROKER_ENABLED !== '1' || search || !allowed) {
      return Response.json({ error: { code: 'not_found' } }, {
        status: 404,
        headers: responseHeaders,
      });
    }
    if (upload && bindings.RECIPE_BROKER_READ_ONLY === '1') {
      return Response.json({ error: { code: 'rich_writes_disabled' } }, {
        status: 503,
        headers: responseHeaders,
      });
    }
    return handler.fetch(request, bindings, ctx);
  },
};

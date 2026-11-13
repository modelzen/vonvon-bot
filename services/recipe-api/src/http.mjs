import { createServer } from 'node:http';
import { accountFromRequest } from './auth.mjs';
import { ApiError, badInput } from './errors.mjs';
import { bodyJson, checkDraft, expectedRevision, objectKeys, queryParams, requestKey, uuid } from './input.mjs';
import { codeAttempts } from './limiter.mjs';

const endpoints = [
  ['GET', '/community/recipes', 'catalog', true],
  ['GET', '/recipes/:r/versions/:v', 'versionDetail', true],
  ['GET', '/me/drafts', 'listDrafts'],
  ['GET', '/me/recipes', 'library'],
  ['GET', '/me/publications', 'publications'],
  ['GET', '/drafts/:d', 'getDraft'],
  ['POST', '/drafts', 'createDraft'],
  ['PATCH', '/drafts/:d', 'editDraft'],
  ['DELETE', '/drafts/:d', 'deleteDraft'],
  ['POST', '/drafts/:d/publish', 'publishDraft'],
  ['POST', '/versions/:v/acquire', 'direct'],
  ['POST', '/versions/:v/redeem', 'redeem'],
  ['POST', '/versions/:v/codes', 'issueCodes'],
  ['GET', '/versions/:v/codes', 'listCodes'],
  ['POST', '/codes/:c/disable', 'disableCode'],
  ['POST', '/codes/:c/reveal', 'revealCode'],
].map(([method, path, action, isPublic = false]) => ({
  method, action, isPublic, regex: new RegExp('^(?:/api)?/v1' + path.replace(/:[rvdc]/g, '([^/]+)') + '$'),
}));

function identify(req, url) {
  const candidates = endpoints.filter(e => e.regex.test(url.pathname));
  if (!candidates.length) throw new ApiError(404, 'not_found');
  const endpoint = candidates.find(e => e.method === req.method);
  if (!endpoint) throw new ApiError(405, 'method_not_allowed');
  return { ...endpoint, ids: endpoint.regex.exec(url.pathname).slice(1).map(uuid) };
}

async function inputFor(req, url, {action, ids}) {
  const { q, cursor } = queryParams(url, action === 'catalog' ? ['q','cursor'] : ['listCodes','library'].includes(action) ? ['cursor'] : []);
  if (req.method === 'GET') {
    if (action === 'catalog') return [action, [q, cursor]];
    if (action === 'listCodes' || action === 'library') return [action, [...ids, cursor]];
    return [action, ids];
  }
  const key = requestKey(req);
  const body = await bodyJson(req);
  if (action === 'createDraft' || action === 'editDraft') {
    const isNew = action === 'createDraft';
    checkDraft(body, isNew);
    return ['saveDraft', [isNew ? key : ids[0], isNew ? 0 : expectedRevision(req),
      body.public, body.config, key, body.recipeId ?? null, body.sourceVersionId ?? null]];
  }
  if (action === 'issueCodes') {
    objectKeys(body, ['count']);
    if (!Number.isInteger(body.count) || body.count < 1 || body.count > 100) throw badInput();
    return [action, [...ids, body.count, key]];
  }
  if (action === 'redeem') {
    objectKeys(body, ['code']);
    if (typeof body.code !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(body.code)) throw badInput();
    return ['acquire', [...ids, body.code, key]];
  }
  objectKeys(body, []);
  if (action === 'direct') return ['acquire', [...ids, null, key]];
  if (action === 'deleteDraft' || action === 'publishDraft') return [action, [...ids, expectedRevision(req), key]];
  return [action, ids];
}

export function createRecipeServer({ verify, execute, attempts = codeAttempts() }) {
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000 },
    async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      let finishAttempt;
      try {
        if (!req.url.startsWith('/') || req.url.startsWith('//')) throw badInput();
        const url = new URL(req.url, 'http://localhost');
        const route = identify(req, url);
        const account = await accountFromRequest(req, route.isPublic, verify);
        const [operation, args] = await inputFor(req, url, route);
        if (route.action === 'redeem') finishAttempt = attempts.begin(account);
        const result = await execute(account, operation, args);
        const response = JSON.stringify(result);
        finishAttempt?.(false);
        finishAttempt = undefined;
        res.end(response);
      } catch (err) {
        finishAttempt?.(err.code === 'invalid_code');
        const problem = err instanceof ApiError ? err : new ApiError(500, 'internal_error');
        if (problem.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        if (problem.status === 413 || !req.complete) res.setHeader('Connection', 'close');
        if (problem.retryAfter) res.setHeader('Retry-After', problem.retryAfter);
        res.writeHead(problem.status);
        res.end(JSON.stringify({ error: { code: problem.code, field: problem.field } }));
      }
    });
  server.keepAliveTimeout = 5_000;
  return server;
}

import { ApiError, badInput, UUID } from './errors.mjs';
import { credentialField } from './credential-shapes.mjs';

const BODY_LIMIT = 448 * 1024; // Includes JSON escape sequences for the allowed UTF-8 text.
export const uuid = value => {
  if (typeof value !== 'string' || !UUID.test(value)) throw badInput();
  return value.toLowerCase();
};

export function objectKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(k => !Object.hasOwn(value,k)) ||
      Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw badInput();
}

function safeString(value) {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
}

function checkSetup(setup) {
  objectKeys(setup, ['steps']);
  if (!Array.isArray(setup.steps) || setup.steps.length < 1 || setup.steps.length > 8) throw badInput();
  for (const step of setup.steps) {
    objectKeys(step, ['kind', 'title', 'instructions', 'required'], ['check']);
    if (!['config', 'tool', 'context'].includes(step.kind) || typeof step.required !== 'boolean' ||
        !safeString(step.title) || [...step.title].length > 80 ||
        !safeString(step.instructions) || Buffer.byteLength(step.instructions) > 2048 ||
        (Object.hasOwn(step, 'check') && (!safeString(step.check) || Buffer.byteLength(step.check) > 512))) {
      throw badInput();
    }
  }
}

export function checkDraft(body, isNew) {
  objectKeys(body, ['public', 'config'], isNew ? ['recipeId', 'sourceVersionId'] : []);
  const {public: meta, config} = body;
  objectKeys(meta, ['name', 'summary', 'overview', 'version', 'access']);
  objectKeys(config, ['role'], ['setup']);
  if (Object.hasOwn(config, 'setup')) checkSetup(config.setup);
  for (const [field, max] of [['name', 60], ['summary', 240], ['version', 40]]) {
    if (!safeString(meta[field]) || [...meta[field]].length > max) throw badInput();
  }
  if (!['direct','coded'].includes(meta.access) ||
      !safeString(meta.overview) || Buffer.byteLength(meta.overview) > 32 * 1024 ||
      !safeString(config.role) || Buffer.byteLength(config.role) > 16 * 1024) throw badInput();
  const sensitive = credentialField(body);
  if (sensitive) {
    const problem = new ApiError(422, 'credential_detected');
    problem.field = sensitive;
    throw problem;
  }
  const hasRecipe = Object.hasOwn(body, 'recipeId');
  if (hasRecipe !== Object.hasOwn(body, 'sourceVersionId')) throw badInput();
  if (hasRecipe) {
    uuid(body.recipeId);
    uuid(body.sourceVersionId);
  }
}

export function requestKey(req, acquisition = false) {
  const values = req.headersDistinct['idempotency-key'];
  if (values?.length !== 1 || !(UUID.test(values[0]) || acquisition && /^a2\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(values[0]))) throw new ApiError(400, 'invalid_request_id');
  return values[0].toLowerCase();
}

export function expectedRevision(req) {
  const values = req.headersDistinct['if-match'];
  if (!values) throw new ApiError(428, 'revision_required');
  const match = values.length === 1 && /^"([1-9]\d{0,9})"$/.exec(values[0]);
  if (!match || Number(match[1]) > 2147483647) throw new ApiError(400, 'invalid_revision');
  return Number(match[1]);
}

export function queryParams(url, allowed) {
  const params = url.searchParams;
  for (const name of params.keys()) {
    if (!allowed.includes(name) || params.getAll(name).length !== 1) throw badInput();
  }
  const q = params.get('q');
  if (q !== null && (!safeString(q) || [...q].length > 120)) throw badInput();
  const cursor = params.get('cursor');
  return { q, cursor: cursor === null ? null : uuid(cursor) };
}

export async function bodyJson(req, limit = BODY_LIMIT) {
  const contentType = req.headers['content-type'];
  if (contentType && !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType)) {
    throw new ApiError(415, 'unsupported_media_type');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new ApiError(415, 'unsupported_media_type');
  }
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new ApiError(413, 'payload_too_large');
  const chunks = [];
  let length = 0;
  // Node's default async iterator destroys the socket on early return; allow the 413 response through.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) throw new ApiError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  if (!length) return {};
  if (!contentType) throw new ApiError(415, 'unsupported_media_type');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks,length)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw badInput();
    return value;
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}

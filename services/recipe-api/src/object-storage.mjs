import { ApiError, UUID } from './errors.mjs';

export async function boundedObjectBytes(stream, limit, signal) {
  if (stream instanceof Uint8Array) {
    if (stream.byteLength > limit) throw new ApiError(413, 'object_too_large');
    return Buffer.from(stream);
  }
  if (!(stream instanceof ReadableStream)) throw new ApiError(422, 'object_stream_required');
  const reader = stream.getReader();
  const collected = Buffer.allocUnsafe(limit);
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, {once:true});
  try {
    for (;;) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ApiError(422, 'object_stream_required');
      total += value.byteLength;
      if (total > limit) throw new ApiError(413, 'object_too_large');
      collected.set(value,total-value.length);
    }
    return collected.subarray(0,total);
  } catch (err) {
    abort();
    throw err;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function createPrivateStorage({origin, bucket, apiKey, bearer, verifyAbsent, fetchImpl = fetch}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' ||
      base.search || base.hash || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(bucket) || !apiKey || !bearer || typeof verifyAbsent !== 'function') {
    throw new Error('invalid_private_storage_configuration');
  }
  const failure = () => new ApiError(503, 'object_storage_unavailable');
  async function request(method, id, lane, data) {
    if (!UUID.test(id) || !['temp','final'].includes(lane)) throw new Error('invalid_object_key');
    const privateRead = method === 'GET' ? 'authenticated/' : '';
    const url = new URL('/storage/v1/object/' + privateRead + bucket + '/' + lane + '/' + id, base);
    const headers = {apikey:apiKey, authorization:'Bearer ' + bearer, 'cache-control':method === 'POST' ? 'max-age=0' : 'no-store'};
    if (method === 'POST') {
      headers['x-upsert'] = 'false';
      headers['content-type'] = 'application/octet-stream';
    }
    try {
      return await fetchImpl(url, {
        method, headers, body:data, redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000),
      });
    } catch { throw failure(); }
  }
  async function missing(response) {
    if (![400,404].includes(response.status)) return false;
    try {
      const error = JSON.parse((await boundedObjectBytes(response.body, 4096)).toString('utf8'));
      return error.code === 'NoSuchKey';
    } catch { return false; }
  }
  return {
    async create(id, lane, data) {
      const response = await request('POST', id, lane, data);
      if (!response.ok) { await response.body?.cancel(); throw failure(); }
      await response.body?.cancel();
    },
    async read(id, lane, cap) {
      const response = await request('GET', id, lane);
      if (response.status === 200) return boundedObjectBytes(response.body, cap);
      if (await missing(response)) {
        if (await verifyAbsent(bucket, lane + '/' + id) === true) return null;
        throw failure();
      }
      await response.body?.cancel();
      throw failure();
    },
    async remove(id, lane) {
      const response = await request('DELETE', id, lane);
      if (!response.ok && !await missing(response)) { await response.body?.cancel(); throw failure(); }
      await response.body?.cancel();
    },
  };
}

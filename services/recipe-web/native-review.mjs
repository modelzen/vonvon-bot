import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { createRecipeWeb } from './server.mjs';

export async function startNativeReview({ port = 49187 } = {}) {
  const webOrigin = 'http://127.0.0.1:' + port, attempts = new Map(), shutdown = new AbortController();
  const issuer = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/auth/v1/authorize' || url.searchParams.get('redirect_to') !== webOrigin + '/auth/native/callback' ||
        !['github', 'google', 'apple'].includes(url.searchParams.get('provider'))) return res.writeHead(400).end();
    res.writeHead(303, { Location: webOrigin + '/auth/native/callback?code=synthetic-native-review-code', 'Cache-Control': 'no-store' }); res.end();
  });
  await new Promise(resolve => issuer.listen(0, '127.0.0.1', resolve));
  const supabase = 'http://127.0.0.1:' + issuer.address().port;
  const web = createRecipeWeb({ RECIPE_WEB_ORIGIN: webOrigin, SUPABASE_URL: supabase, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_native_review' });
  try { await new Promise((resolve, reject) => web.once('error', reject).listen(port, '127.0.0.1', resolve)); }
  catch (error) { issuer.close(); throw error; }

  async function native(path, flow, method = 'GET', value) {
    const response = await fetch(webOrigin + '/auth/native/flows' + path, { method, cache: 'no-store',
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(5000)]),
      headers: { 'Content-Type': 'application/json', ...(flow && { Authorization: 'Bearer ' + flow.pollToken }) },
      ...(value !== undefined && { body: JSON.stringify(value) }) });
    if (!response.ok) throw new Error('Native review request failed with ' + response.status);
    return response.json();
  }

  const polling = (async () => {
    while (!shutdown.signal.aborted) {
      for (const attempt of attempts.values()) {
        if (attempt.done) continue;
        const view = await native('/' + attempt.flow.flowId, attempt.flow);
        if (view.status === 'provider' && !attempt.authorized) {
          const url = new URL('/auth/v1/authorize', supabase);
          url.searchParams.set('provider', view.provider); url.searchParams.set('redirect_to', webOrigin + '/auth/native/callback');
          url.searchParams.set('code_challenge', createHash('sha256').update(attempt.verifier).digest('base64url'));
          url.searchParams.set('code_challenge_method', 's256');
          await native('/' + attempt.flow.flowId + '/authorize', attempt.flow, 'PUT', { url: url.href });
          attempt.authorized = true;
        } else if (view.status === 'code') {
          if (view.code !== 'synthetic-native-review-code') throw new Error('Unexpected synthetic review code');
          await native('/' + attempt.flow.flowId + '/ack', attempt.flow, 'POST', {});
          attempt.done = true; attempt.status = 'completed';
        } else if (['cancelled', 'expired', 'failed'].includes(view.status)) { attempt.done = true; attempt.status = view.status; }
      }
      await setTimeout(200, undefined, { signal: shutdown.signal });
    }
  })().catch(error => { if (!shutdown.signal.aborted) throw error; });

  return {
    webOrigin,
    async create() {
      const flow = await native('', null, 'POST', { state: randomBytes(32).toString('base64url') });
      attempts.set(flow.flowId, { flow, verifier: randomBytes(32).toString('base64url'), done: false });
      return { launchUrl: flow.launchUrl, flowId: flow.flowId };
    },
    status(flowId) { return attempts.get(flowId)?.status || 'waiting'; },
    async stop() {
      shutdown.abort(); await polling;
      web.closeAllConnections(); issuer.closeAllConnections();
      await Promise.all([new Promise(resolve => web.close(resolve)), new Promise(resolve => issuer.close(resolve))]);
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const review = await startNativeReview();
  const flow = await review.create();
  console.log('Synthetic native login review ' + flow.launchUrl);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await review.stop(); });
}

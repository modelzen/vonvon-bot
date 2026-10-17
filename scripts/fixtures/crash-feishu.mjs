// Crash notifier fetches succeed or return 503; the SDK's HTTPS identity check always fails locally.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';

const dir = process.env.FAKE_FEISHU_DIR;
const realFetch = globalThis.fetch;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const record = (file, data) => appendFileSync(join(dir, `${file}.jsonl`), `${JSON.stringify(data)}\n`);
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
  if (!/^open\.(feishu\.cn|larksuite\.com)$/.test(url.hostname)) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
    record('tokens', { app_id: body.app_id, secret_ok: body.app_secret === `secret-${body.app_id}` });
    return json(200, { code: 0, tenant_access_token: `t-${body.app_id}`, expire: 7200 });
  }
  if (url.pathname === '/open-apis/im/v1/messages' && init?.method === 'POST') {
    const mode = readFileSync(join(dir, 'mode'), 'utf8').trim();
    record('sent', { mode, body: { ...body, content: JSON.parse(body.content) } });
    return mode === '503' ? new Response('unavailable', { status: 503 })
      : json(200, { code: 0, data: { message_id: `om_fake_${body.uuid}` } });
  }
  throw new Error(`Unexpected fake Feishu fetch: ${url.pathname}`);
};
const realRequest = https.request;
https.request = function (...args) {
  const first = args[0];
  const url = typeof first === 'string' || first instanceof URL ? new URL(first) : undefined;
  const host = url?.hostname ?? first?.hostname ?? first?.host;
  if (/^open\.(feishu\.cn|larksuite\.com)$/.test(String(host))) {
    record('blocked', { path: url?.pathname ?? first.path });
    args[0] = url ? `https://127.0.0.1:9${url.pathname}${url.search}`
      : { ...first, host: '127.0.0.1', hostname: '127.0.0.1', port: 9, servername: undefined };
  }
  return realRequest.apply(this, args);
};

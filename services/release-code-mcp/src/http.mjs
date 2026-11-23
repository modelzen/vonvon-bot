import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { publicUrl, SCOPE } from './auth.mjs';
import { QueryError } from './source.mjs';

function json(res, status, object, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(object));
}
const failed = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const readInput = {
  path: z.string().min(1).max(1024).describe('Release-relative path, e.g. packages/daemon/src/feedback/recipe.ts'),
  offset: z.number().int().min(1).max(16777216).optional().describe('Starting line, 1-based; default 1'),
  limit: z.number().int().min(1).max(500).optional().describe('Maximum lines; default 200'),
};
const rgInput = {
  argv: z
    .array(z.string().max(1024))
    .min(1)
    .max(40)
    .describe(
      'ripgrep arguments as separate strings, e.g. ["--files","-g","*feedback*"] or ["-n","-F","--","message","packages"].'
    ),
};
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
async function readRequest(req) {
  if (
    req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
    req.headers['content-encoding']
  ) {
    return { status: 415 };
  }
  if (Number(req.headers['content-length']) > 24576) return { status: 413 };
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 24576) return { status: 413 };
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { body };
  } catch {
    return { status: 400 };
  }
}

export function createHttpService({ audience, issuer, verify, library, usage }) {
  const resource = publicUrl(audience);
  publicUrl(issuer);
  const discovery = '/.well-known/oauth-protected-resource' + resource.pathname;
  const challenge = 'Bearer resource_metadata="' + resource.origin + discovery + '", scope="' + SCOPE + '"';
  const live = new Map();
  let running = 0;

  function toolsFor(account) {
    const mcp = new McpServer({ name: 'vonvon-release-code', version: '0.1.0' });
    const call = (tool) => async (args, extra) => {
      if (running >= 8 || (live.get(account) ?? 0) >= 2)
        return failed('Too many concurrent searches; retry in a moment.');
      if (!usage.take(account, tool)) return failed('Hourly code lookup limit reached; retry next hour.');
      running++;
      live.set(account, (live.get(account) ?? 0) + 1);
      try {
        const value = await library.query(tool, args, extra.signal);
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        return failed(error instanceof QueryError ? error.message : 'Release unavailable; retry later.');
      } finally {
        running--;
        const left = live.get(account) - 1;
        if (left) live.set(account, left);
        else live.delete(account);
      }
    };
    mcp.registerTool(
      'read',
      {
        description:
          'Read numbered lines of a text file in the latest official VonVon release. The result contains version, sourceSha and nextOffset.',
        inputSchema: readInput,
        annotations,
      },
      call('read')
    );
    mcp.registerTool(
      'rg',
      {
        description:
          'Search the latest official release or list files with --files. Supports -F, -i, -n, -w, -l, -e, -g, -C/-A/-B (≤10), --max-depth. Refine the query if truncated.',
        inputSchema: rgInput,
        annotations,
      },
      call('rg')
    );
    return mcp;
  }

  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (req.url === '/healthz' && req.method === 'GET') {
        try {
          return json(res, 200, { status: 'ok', ...(await library.info()) });
        } catch {
          return json(res, 503, { status: 'unavailable' });
        }
      }
      if ([discovery, '/.well-known/oauth-protected-resource'].includes(req.url) && req.method === 'GET') {
        return json(res, 200, {
          resource: audience,
          authorization_servers: [issuer],
          scopes_supported: [SCOPE],
          bearer_methods_supported: ['header'],
          resource_name: 'VonVon 发布版代码查阅',
        });
      }
      if (req.url !== resource.pathname) return json(res, 404, { error: 'not_found' });
      if (req.headers.origin !== undefined && req.headers.origin !== resource.origin)
        return json(res, 403, { error: 'invalid_origin' });
      let account;
      try {
        account = await verify(req);
      } catch {
        return json(res, 503, { error: 'identity_unavailable' });
      }
      if (!account) return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': challenge });
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });

      const parsed = await readRequest(req);
      if (parsed.status)
        return json(
          res,
          parsed.status,
          { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid request body' } },
          { connection: 'close' }
        );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = toolsFor(account);
      res.once('close', () => {
        void mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed.body);
    } catch {
      if (!res.headersSent && !res.destroyed) json(res, 500, { error: 'request_failed' });
      else if (!res.writableEnded) res.destroy();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 12000;
  return server;
}

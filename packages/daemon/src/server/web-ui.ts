import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = resolve(fileURLToPath(new URL('../../ui/dist/', import.meta.url)));
const assetName = /^\/assets\/[A-Za-z0-9_.-]+$/;
const publicAssetName = /^\/agent-icons\/[A-Za-z0-9_.-]+$/;
const publicRootName = /^\/vonvon-(?:logo\.png|tray\.(?:png|ico))$/;
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function serveWebUi(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  let pathname: string;
  try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; }
  catch { return false; }
  const relative = pathname === '/' ? 'index.html' : assetName.test(pathname) || publicAssetName.test(pathname) || publicRootName.test(pathname) ? pathname.slice(1) : null;
  if (!relative) return false;
  let data: Buffer;
  try { data = await readFile(join(uiRoot, relative)); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Web UI is not built. Run npm run build -w packages/ui.');
      return true;
    }
    throw error;
  }
  const extension = relative.slice(relative.lastIndexOf('.'));
  response.writeHead(200, {
    'Content-Type': contentTypes[extension] ?? 'application/octet-stream',
    'Content-Length': String(data.length),
    'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  response.end(request.method === 'HEAD' ? undefined : data);
  return true;
}

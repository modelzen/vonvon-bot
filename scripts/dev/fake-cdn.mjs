#!/usr/bin/env node
// A stand-in for dl.vonvon.cc while trying the standalone server update by hand (docs/plans/server-3-update-engine.md
// section 6). Development only: not packaged, not copied by build-server.mjs, listens on loopback only.
//
//   node scripts/dev/fake-cdn.mjs --root <dir> --key <ed25519-private.pem> [--port 0] [--version 1.0.1] [--published-at <ms>]
//
// <dir> holds the packages as `<version>/vonvon-server-<version>-<target>.tar.gz`. It serves them under
// /bot/server/ and signs /bot/server/stable/manifest.json for --version (default: the highest version in <dir>).
// A target with no package gets a placeholder entry, so the manifest still lists both: the standalone server is Linux
// only (owner 2026-11-01), and these are standalone-manifest.ts SERVER_TARGETS and build-server PUBLISHED_TARGETS.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

const TARGETS = ['linux-x64', 'linux-arm64'];
const VERSION = /^\d+\.\d+\.\d+$/;
const archiveName = (version, target) => `vonvon-server-${version}-${target}.tar.gz`;
const newer = (a, b) => { const [x, y] = [a, b].map(v => v.split('.').map(Number)); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

function options(args) {
  const out = { port: 0, publishedAt: Date.now() };
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i], args[i + 1]];
    if (!value) throw new Error(`${name} needs a value`);
    if (name === '--root') out.root = resolve(value);
    else if (name === '--key') out.key = createPrivateKey(readFileSync(value, 'utf8'));
    else if (name === '--port') out.port = Number(value);
    else if (name === '--version' && VERSION.test(value)) out.version = value;
    else if (name === '--published-at') out.publishedAt = Number(value);
    else throw new Error(`unknown option ${name}`);
  }
  if (!out.root || !out.key) throw new Error('usage: fake-cdn.mjs --root <dir> --key <private.pem> [--port 0] [--version x.y.z] [--published-at ms]');
  return out;
}

function manifest({ root, key, version, publishedAt }, base) {
  const chosen = version ?? readdirSync(root).filter(name => VERSION.test(name)).reduce((best, name) => (!best || newer(name, best) ? name : best), undefined);
  if (!chosen) throw new Error(`no <version>/ directory in ${root}`);
  const files = Object.fromEntries(TARGETS.map(target => {
    const file = join(root, chosen, archiveName(chosen, target));
    let bytes;
    try { bytes = readFileSync(file); } catch { bytes = undefined; }
    return [target, { url: `${base}/${chosen}/${archiveName(chosen, target)}`, sha512: bytes ? createHash('sha512').update(bytes).digest('hex') : '0'.repeat(128), size: bytes ? bytes.length : 1 }];
  }));
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version: chosen, publishedAt: publishedAt, files }));
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') });
}

const config = options(process.argv.slice(2));
const server = createServer((request, response) => {
  const base = `http://${request.headers.host}/bot/server`;
  const path = new URL(request.url ?? '/', 'http://x').pathname;
  try {
    if (path === '/bot/server/stable/manifest.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(manifest(config, base));
      return;
    }
    const match = /^\/bot\/server\/(\d+\.\d+\.\d+)\/(vonvon-server-\1-[a-z0-9-]+\.tar\.gz)$/.exec(path);
    const file = match && join(config.root, match[1], match[2]);
    if (!file || !statSync(file, { throwIfNoEntry: false })?.isFile()) { response.writeHead(404).end('missing'); return; }
    const bytes = readFileSync(file);
    response.writeHead(200, { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' }).end(bytes);
  } catch (error) {
    response.writeHead(500).end(String(error instanceof Error ? error.message : error));
  }
});
server.listen(config.port, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`fake CDN at http://127.0.0.1:${port}/bot/server`);
});

import { lstat, realpath, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { Tier } from '../model';
import type { EnforcementPlan } from '../policy/enforcement';
import { classifyAddress } from './address';

export type OutboundPlan = Pick<EnforcementPlan, 'grant' | 'readableRoots' | 'writableRoots'>;
export type PathOperation = 'read' | 'write' | 'glob';
export type PathDecision =
  | { allowed: true; canonical: string }
  | { allowed: false; reason: 'outside-roots' | 'unsafe-glob' }
  | { allowed: false; reason: 'unresolvable'; error: unknown };

export async function uploadPlan(input: { cwd: string; mode: Tier; network: boolean }): Promise<OutboundPlan> {
  const root = await realpath(input.cwd);
  if (input.mode === 'full') {
    return { grant: { tier: 'full', root, network: input.network }, readableRoots: 'unrestricted', writableRoots: 'unrestricted' };
  }
  return {
    grant: { tier: input.mode, root, readScope: 'project', network: input.network },
    readableRoots: [root],
    writableRoots: input.mode === 'qa' ? [] : [root],
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function writeTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!isMissing(error)) throw error;
    const missing: string[] = [];
    let ancestor = path;
    while (true) {
      try {
        await lstat(ancestor);
      } catch (inspectionError) {
        if (!isMissing(inspectionError)) throw inspectionError;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.unshift(basename(ancestor));
        ancestor = parent;
        continue;
      }
      // lstat preserves dangling links as existing entries; realpath must refuse them.
      const canonical = await realpath(ancestor);
      if (missing.length > 0 && !(await stat(canonical)).isDirectory()) throw error;
      return join(canonical, ...missing);
    }
  }
}

function parseGlobStaticDirectoryPrefix(pattern: string): string | undefined {
  if (pattern.startsWith('!')) return undefined;
  let decoded = '';
  let directoryEnd = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '/' || (sep === '\\' && character === '\\')) {
      decoded += sep;
      directoryEnd = decoded.length;
    } else if (sep !== '\\' && character === '\\') {
      const escaped = pattern[++index];
      if (escaped === undefined || escaped === '/') return undefined;
      decoded += escaped;
    } else if (character !== undefined && '*?[{('.includes(character)) {
      return decoded.slice(0, directoryEnd);
    } else {
      decoded += character;
    }
  }
  return decoded.length === 0 ? '' : dirname(decoded);
}

export async function judgePath(plan: OutboundPlan, op: PathOperation, path: string): Promise<PathDecision> {
  const roots = op === 'write' ? plan.writableRoots : plan.readableRoots;
  if (roots !== 'unrestricted' && roots.length === 0) return { allowed: false, reason: 'outside-roots' };
  let target = path;
  if (op === 'glob') {
    if (roots !== 'unrestricted' && (path.includes('..') || path.startsWith('/') || path.startsWith('~')
      || win32.isAbsolute(path) || /^[a-z]:/i.test(path))) {
      return { allowed: false, reason: 'unsafe-glob' };
    }
    const prefix = parseGlobStaticDirectoryPrefix(path);
    if (prefix === undefined) return { allowed: false, reason: 'unsafe-glob' };
    target = prefix;
  }
  try {
    const absolute = resolve(plan.grant.root, target);
    const canonical = op === 'write' ? await writeTarget(absolute) : await realpath(absolute);
    if (roots === 'unrestricted') return { allowed: true, canonical };
    const canonicalRoots = await Promise.all(roots.map(root => realpath(resolve(plan.grant.root, root))));
    for (const root of canonicalRoots) {
      const suffix = relative(root, canonical);
      if (suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))) {
        return { allowed: true, canonical };
      }
    }
    return { allowed: false, reason: 'outside-roots' };
  } catch (error) {
    return { allowed: false, reason: 'unresolvable', error };
  }
}

/** This path decision does not replace descriptor identity checks at open time. */
export async function checkUploadPath(plan: OutboundPlan, path: string): Promise<string | undefined> {
  const decision = await judgePath(plan, 'read', path);
  if (decision.allowed) return decision.canonical;
  if (decision.reason === 'unresolvable') throw decision.error;
  return undefined;
}

const MAX_REMOTE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface RemoteResponse { status: number; headers: { location?: string; contentType?: string; contentLength?: string }; body: Buffer }
export interface RemoteImageDeps {
  resolve(hostname: string): Promise<{ address: string; family: 4 | 6 }[]>;
  request(url: URL, address: string, signal: AbortSignal): Promise<RemoteResponse>;
}

const remoteDeps: RemoteImageDeps = {
  resolve: async hostname => {
    const family = isIP(hostname);
    if (family === 4 || family === 6) return [{ address: hostname, family }];
    return (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  },
  request: requestPinned,
};

export function requestPinned(url: URL, address: string, signal: AbortSignal): Promise<RemoteResponse> {
  return new Promise((resolveResponse, reject) => {
    const secure = url.protocol === 'https:';
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const tls = isIP(hostname)
      ? { servername: '', checkServerIdentity: (_: string, cert: PeerCertificate) => checkServerIdentity(hostname, cert) }
      : { servername: hostname };
    const request = (secure ? httpsRequest : httpRequest)({
      hostname: address,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { host: url.host },
      ...(secure ? tls : {}),
      agent: false,
      signal,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REMOTE_BYTES) {
          request.destroy(new Error('remote image exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => resolveResponse({
        status: response.statusCode ?? 0,
        headers: {
          location: response.headers.location,
          contentType: response.headers['content-type'],
          contentLength: response.headers['content-length'],
        },
        body: Buffer.concat(chunks),
      }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
}

export async function fetchRemoteImage(url: string, plan: OutboundPlan, deps: RemoteImageDeps = remoteDeps): Promise<Buffer | undefined> {
  if (!plan.grant.network) return undefined;
  const signal = AbortSignal.timeout(10_000);
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const target = new URL(current);
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) return undefined;
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    signal.throwIfAborted();
    let cancelDns = () => {};
    const dnsDeadline = new Promise<never>((_, reject) => {
      cancelDns = () => reject(signal.reason);
      signal.addEventListener('abort', cancelDns, { once: true });
    });
    let addresses: Awaited<ReturnType<RemoteImageDeps['resolve']>>;
    try {
      addresses = await Promise.race([deps.resolve(hostname), dnsDeadline]);
    } finally {
      signal.removeEventListener('abort', cancelDns);
    }
    signal.throwIfAborted();
    if (addresses.length === 0 || addresses.some(({ address }) => !classifyAddress(address).allowed)) return undefined;
    const pinned = addresses[0];
    if (!pinned) return undefined;
    const response = await deps.request(target, pinned.address, signal);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (redirects === MAX_REDIRECTS) return undefined;
      current = new URL(response.headers.location, target).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) return undefined;
    const type = response.headers.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (type && !type.startsWith('image/')) return undefined;
    const declared = Number(response.headers.contentLength ?? 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_REMOTE_BYTES
      || response.body.length === 0 || response.body.length > MAX_REMOTE_BYTES) return undefined;
    return response.body;
  }
  return undefined;
}

import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { Tier } from '../model';
import type { EnforcementPlan } from '../policy/enforcement';

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

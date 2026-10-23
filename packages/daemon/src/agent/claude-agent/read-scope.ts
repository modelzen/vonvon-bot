import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { ReadScope } from '../types';
import { log } from '../../core/logger';
import { inside } from './permission';

export class ReadScopeError extends Error {
  override name = 'ReadScopeError';
}

async function pathsFor(path: string, kind: 'deny' | 'allow'): Promise<string[]> {
  try { await lstat(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    return kind === 'deny' ? [path] : [];
  }
  try { return [...new Set([path, await realpath(path)])]; }
  catch { return kind === 'deny' ? [path] : []; }
}

export async function realScope(scope: ReadScope, cwd: string, realCwd: string): Promise<ReadScope> {
  const deny = [...new Set((await Promise.all(scope.deny.map(path => pathsFor(path, 'deny')))).flat())];
  const allow = [...new Set([cwd, realCwd, ...(await Promise.all(scope.allow.map(path => pathsFor(path, 'allow')))).flat()])];
  if (deny.some(path => inside(realCwd, path))) {
    throw new ReadScopeError('工作区放在了数据目录或它的上级，只读、工作区可写档没法把别的群隔开。请主人在群详情页换一个工作区。');
  }
  if (deny.some(path => basename(path) === 'bots' && inside(path, realCwd))) log.warn('claude-read-scope', 'cwd-in-bots');
  return { deny, allow };
}

export async function linuxReadScope(scope: ReadScope, realCwd: string): Promise<ReadScope> {
  const deny: string[] = [];
  for (const path of scope.deny) {
    // Failed canonicalization must never silently remove a restriction.
    let canonical: string;
    try { canonical = await realpath(path); }
    catch { deny.push(path); continue; }
    if (!inside(canonical, realCwd) || canonical === realCwd) { deny.push(path); continue; }
    let cursor = path;
    for (const component of relative(canonical, realCwd).split(sep)) {
      const entries = await readdir(cursor);
      if (entries.length > 2000) {
        log.warn('claude-read-scope', 'too-many-entries', { count: entries.length });
        throw new ReadScopeError('数据目录里的群太多，Linux 上的只读、工作区可写档没法把它们一一隔开。请主人在群详情页把这个群的工作区换到数据目录以外。');
      }
      for (const entry of entries) {
        if (entry !== component) deny.push(...await pathsFor(join(cursor, entry), 'deny'));
      }
      cursor = join(cursor, component);
    }
  }
  return { deny: [...new Set(deny)], allow: [...scope.allow] };
}

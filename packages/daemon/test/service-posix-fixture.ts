import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type * as Fs from 'node:fs/promises';

type Mapping = { logical: string; native: string };
const mappings: Mapping[] = [];

export function registerPosixFixture(native: string): string {
  const logical = `/vonvon-service-fixture/${randomUUID()}`;
  mappings.push({ logical, native: resolve(native) });
  return logical;
}

export function clearPosixFixtures(): void {
  mappings.length = 0;
}

export function logicalFixturePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const mapping = mappings.find(({ logical }) => normalized === logical || normalized.startsWith(`${logical}/`));
  if (!mapping) return path;
  nativeFixturePath(mapping, normalized);
  return normalized;
}

function nativeFixturePath(mapping: Mapping, path: string): string {
  const candidate = resolve(mapping.native, `.${path.slice(mapping.logical.length)}`);
  const suffix = relative(mapping.native, candidate);
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('POSIX fixture path escapes its backing directory');
  }
  return candidate;
}

function nativePath(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const path = logicalFixturePath(value);
  const mapping = mappings.find(({ logical }) => path === logical || path.startsWith(`${logical}/`));
  return mapping ? nativeFixturePath(mapping, path) : value;
}

export function mappedServiceFs(actual: typeof Fs): typeof Fs {
  function mapped<F extends (...args: never[]) => unknown>(fn: F, indexes = [0]): F {
    return new Proxy(fn, {
      apply(target, receiver, args: unknown[]) {
        return Reflect.apply(target, receiver, args.map((arg, index) => indexes.includes(index) ? nativePath(arg) : arg));
      },
    });
  }
  return {
    ...actual,
    mkdir: mapped(actual.mkdir), open: mapped(actual.open),
    lstat: mapped(actual.lstat), stat: mapped(actual.stat),
    readFile: mapped(actual.readFile), writeFile: mapped(actual.writeFile),
    readdir: mapped(actual.readdir), rm: mapped(actual.rm), unlink: mapped(actual.unlink),
    rename: mapped(actual.rename, [0, 1]), symlink: mapped(actual.symlink, [0, 1]),
    realpath: new Proxy(actual.realpath, {
      async apply(target, receiver, args: unknown[]) {
        const input = args[0];
        const path = typeof input === 'string' ? logicalFixturePath(input) : input;
        const mapping = mappings.find(({ logical }) => typeof path === 'string' && (path === logical || path.startsWith(`${logical}/`)));
        const result: string | Buffer = await Reflect.apply(target, receiver, [nativePath(input), ...args.slice(1)]);
        if (!mapping) return result;
        const canonical = result.toString();
        const suffix = relative(mapping.native, canonical);
        if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return result;
        const logical = mapping.logical + (suffix ? `/${suffix.split(sep).join('/')}` : '');
        return Buffer.isBuffer(result) ? Buffer.from(logical) : logical;
      },
    }),
  };
}

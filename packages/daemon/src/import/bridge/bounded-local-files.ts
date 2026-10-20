import { constants, type Stats } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';

export type LocalFileSafetyProblem =
  | 'not-regular-file'
  | 'not-directory'
  | 'too-large'
  | 'invalid-encoding'
  | 'timed-out';

export class LocalFileSafetyError extends Error {
  constructor(readonly problem: LocalFileSafetyProblem) {
    super(problem);
    this.name = 'LocalFileSafetyError';
  }
}

export interface BoundedFileOptions {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function readBoundedFile(file: string, options: BoundedFileOptions): Promise<Buffer> {
  const deadline = Date.now() + options.timeoutMs;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let abandoned = false;
  const opening = open(file, flags).then(async (handle) => {
    if (abandoned) {
      await handle.close().catch(() => undefined);
      throw new LocalFileSafetyError('timed-out');
    }
    return handle;
  });
  let handle;
  try {
    handle = await withinDeadline(opening, deadline, options.signal);
  } catch (error) {
    abandoned = true;
    throw error;
  }

  try {
    const metadata = await withinDeadline(handle.stat(), deadline, options.signal);
    if (!metadata.isFile()) throw new LocalFileSafetyError('not-regular-file');
    if (metadata.size > options.maxBytes) throw new LocalFileSafetyError('too-large');

    const output = Buffer.allocUnsafe(options.maxBytes + 1);
    let offset = 0;
    while (offset < output.length) {
      const result = await withinDeadline(
        handle.read(output, offset, output.length - offset, null),
        deadline,
        options.signal,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > options.maxBytes) throw new LocalFileSafetyError('too-large');
    return output.subarray(0, offset);
  } finally {
    await withinDeadline(handle.close(), deadline, options.signal).catch(() => {
      void handle.close().catch(() => undefined);
    });
  }
}

export async function readBoundedUtf8FileStrict(
  file: string,
  options: BoundedFileOptions,
): Promise<string> {
  const contents = await readBoundedFile(file, options);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    throw new LocalFileSafetyError('invalid-encoding');
  }
}

export async function statDirectoryBounded(
  path: string,
  timeoutMs: number,
  options: { followFinalSymlink?: boolean; signal?: AbortSignal } = {},
): Promise<Stats> {
  const metadata = await withTimeout(
    options.followFinalSymlink === false ? lstat(path) : stat(path),
    timeoutMs,
    options.signal,
  );
  if (!metadata.isDirectory()) throw new LocalFileSafetyError('not-directory');
  return metadata;
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return withinDeadline(operation, Date.now() + timeoutMs, signal);
}

async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted || Date.now() >= deadline) {
    void operation.catch(() => undefined);
    throw new LocalFileSafetyError('timed-out');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const blockers: Promise<never>[] = [new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new LocalFileSafetyError('timed-out')),
      Math.max(1, deadline - Date.now()),
    );
  })];
  if (signal) {
    blockers.push(new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(new LocalFileSafetyError('timed-out'));
      signal.addEventListener('abort', abortListener, { once: true });
    }));
  }
  try {
    return await Promise.race([operation, ...blockers]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}

/** Refuse linked ancestors too; callers supply an explicit absolute trust root. */
export async function inspectLocalPath(root: string, file: string, signal?: AbortSignal): Promise<Stats | undefined> {
  const { isAbsolute, join, parse, relative, resolve, sep } = await import('node:path');
  if (!isAbsolute(root) || !isAbsolute(file)) throw new LocalFileSafetyError('not-directory');
  const path = resolve(file);
  const inside = relative(resolve(root), path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new LocalFileSafetyError('not-directory');
  let component = parse(path).root;
  const parts = path.slice(component.length).split(sep).filter(Boolean);
  let metadata: Stats | undefined;
  for (const [index, part] of parts.entries()) {
    component = join(component, part);
    try { metadata = await withTimeout(lstat(component), 2_000, signal); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (metadata.isSymbolicLink() || (index < parts.length - 1 && !metadata.isDirectory())) {
      throw new LocalFileSafetyError('not-directory');
    }
  }
  return metadata;
}

export async function readLocalText(root: string, file: string, signal?: AbortSignal, maxBytes = 16 * 1024 * 1024): Promise<string | undefined> {
  if (!await inspectLocalPath(root, file, signal)) return undefined;
  const text = await readBoundedUtf8FileStrict(file, { maxBytes, timeoutMs: 2_000, signal });
  if (!await inspectLocalPath(root, file, signal)) throw new LocalFileSafetyError('not-regular-file');
  return text;
}

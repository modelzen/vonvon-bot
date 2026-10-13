import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkUploadPath, fetchRemoteImage, judgePath, requestPinned, uploadPlan, type OutboundPlan, type RemoteImageDeps } from '../../src/provider/outbound/policy';

describe('outbound path policy', () => {
  let temporary: string;
  let root: string;
  let outside: string;
  let plan: OutboundPlan;
  const directoryLink = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'outbound-policy-'));
    root = join(temporary, 'project');
    outside = join(temporary, 'project-sibling');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'inside.txt'), 'inside');
    await writeFile(join(outside, 'outside.txt'), 'outside');
    root = await realpath(root);
    outside = await realpath(outside);
    plan = await uploadPlan({ cwd: root, mode: 'write', network: false });
  });

  afterEach(async () => {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });

  it.each(['qa', 'write', 'full'] as const)('derives only outbound fields for %s and canonicalizes cwd', async mode => {
    const alias = join(temporary, 'alias');
    await directoryLink(root, alias);
    const result = await uploadPlan({ cwd: alias, mode, network: true });
    expect(result).toEqual({
      grant: mode === 'full' ? { tier: mode, root, network: true } : { tier: mode, root, network: true, readScope: 'project' },
      readableRoots: mode === 'full' ? 'unrestricted' : [root],
      writableRoots: mode === 'full' ? 'unrestricted' : mode === 'qa' ? [] : [root],
    });
  });

  it('rejects an unresolved adapter cwd with its filesystem error', async () => {
    await expect(uploadPlan({ cwd: join(root, 'absent'), mode: 'full', network: false })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves relative reads against the grant root and returns the canonical upload path', async () => {
    expect(await judgePath(plan, 'read', 'inside.txt')).toEqual({ allowed: true, canonical: join(root, 'inside.txt') });
    expect(await checkUploadPath(plan, './inside.txt')).toBe(join(root, 'inside.txt'));
    expect(await judgePath(plan, 'read', root)).toEqual({ allowed: true, canonical: root });
  });

  it('rejects a sibling with the same string prefix and a symlink escape', async () => {
    await directoryLink(outside, join(root, 'escape'));
    for (const path of [join(outside, 'outside.txt'), join(root, 'escape', 'outside.txt')]) {
      expect(await judgePath(plan, 'read', path)).toEqual({ allowed: false, reason: 'outside-roots' });
      expect(await checkUploadPath(plan, path)).toBeUndefined();
    }
  });

  it('canonicalizes configured root aliases and resolves relative configured roots', async () => {
    const alias = join(temporary, 'alias');
    await directoryLink(root, alias);
    expect(await judgePath({ ...plan, readableRoots: [alias] }, 'read', 'inside.txt'))
      .toEqual({ allowed: true, canonical: join(root, 'inside.txt') });
    expect(await judgePath({ ...plan, readableRoots: ['.'] }, 'read', 'inside.txt'))
      .toEqual({ allowed: true, canonical: join(root, 'inside.txt') });
    expect(await judgePath({ ...plan, readableRoots: [join(root, 'absent')] }, 'read', 'inside.txt'))
      .toMatchObject({ allowed: false, reason: 'unresolvable', error: { code: 'ENOENT' } });
  });

  it.each(['qa', 'write', 'full'] as const)('allows unrestricted outside reads for %s but still resolves paths', async mode => {
    const derived = await uploadPlan({ cwd: root, mode, network: false });
    const unrestricted: OutboundPlan = { ...derived, readableRoots: 'unrestricted' };
    expect(await judgePath(unrestricted, 'read', join(outside, 'outside.txt')))
      .toEqual({ allowed: true, canonical: join(outside, 'outside.txt') });
    expect(await judgePath(unrestricted, 'read', 'absent'))
      .toMatchObject({ allowed: false, reason: 'unresolvable', error: { code: 'ENOENT' } });
    await expect(checkUploadPath(unrestricted, 'absent')).rejects.toMatchObject({ code: 'ENOENT', syscall: 'realpath' });
  });

  it('denies all writes for empty roots, including qa and a missing leaf', async () => {
    const qa = await uploadPlan({ cwd: root, mode: 'qa', network: false });
    for (const path of ['inside.txt', 'missing/leaf', join(outside, 'outside.txt')]) {
      expect(await judgePath(qa, 'write', path)).toEqual({ allowed: false, reason: 'outside-roots' });
    }
    expect(await judgePath({ ...plan, writableRoots: [] }, 'write', 'inside.txt'))
      .toEqual({ allowed: false, reason: 'outside-roots' });
  });

  it('permits project writes and missing chains while rejecting existing and missing outside writes', async () => {
    expect(await judgePath(plan, 'write', 'inside.txt')).toEqual({ allowed: true, canonical: join(root, 'inside.txt') });
    expect(await judgePath(plan, 'write', 'new/deeper/file.txt'))
      .toEqual({ allowed: true, canonical: join(root, 'new', 'deeper', 'file.txt') });
    await directoryLink(outside, join(root, 'escape'));
    for (const path of [join(outside, 'outside.txt'), 'escape/new/deeper/file.txt']) {
      expect(await judgePath(plan, 'write', path)).toEqual({ allowed: false, reason: 'outside-roots' });
    }
    const full = await uploadPlan({ cwd: root, mode: 'full', network: false });
    expect(await judgePath(full, 'write', join(outside, 'new', 'file.txt')))
      .toEqual({ allowed: true, canonical: join(outside, 'new', 'file.txt') });
  });

  it('canonicalizes the nearest existing write ancestor through an inside alias', async () => {
    await mkdir(join(root, 'directory'));
    await directoryLink(join(root, 'directory'), join(root, 'alias'));
    expect(await judgePath(plan, 'write', 'alias/new/file.txt'))
      .toEqual({ allowed: true, canonical: join(root, 'directory', 'new', 'file.txt') });
  });

  it('refuses dangling links at the write leaf or inside a missing chain', async () => {
    await directoryLink(join(temporary, 'nonexistent-target'), join(root, 'dangling'));
    for (const path of ['dangling', 'dangling/new/file.txt']) {
      expect(await judgePath(plan, 'write', path))
        .toMatchObject({ allowed: false, reason: 'unresolvable', error: { code: 'ENOENT' } });
    }
    await expect(checkUploadPath(plan, 'dangling')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves non-missing filesystem failures instead of granting a fabricated write path', async () => {
    for (const operation of ['read', 'write'] as const) {
      expect(await judgePath(plan, operation, 'bad\0name'))
        .toMatchObject({ allowed: false, reason: 'unresolvable', error: { code: 'ERR_INVALID_ARG_VALUE' } });
    }
    await expect(checkUploadPath(plan, 'bad\0name')).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
    expect(await judgePath(plan, 'write', 'inside.txt/child'))
      .toMatchObject({ allowed: false, reason: 'unresolvable', error: expect.any(Error) });
  });

  it.each(['', '*.txt', '**/*.txt', 'file?.txt', '[ab].txt', '{a,b}.txt', '(a|b).txt'])('uses the root for empty static prefix %s', async pattern => {
    expect(await judgePath(plan, 'glob', pattern)).toEqual({ allowed: true, canonical: root });
  });

  it.each(['/tmp/*.txt', '~/a/*', '~user/*', '../*', 'a/../*', 'a..b/*', 'C:\\temp\\*', 'C:temp\\*', '\\\\server\\share\\*', '\\temp\\*', '//server/share/*'])('refuses project glob syntax %s', async pattern => {
    expect(await judgePath(plan, 'glob', pattern)).toEqual({ allowed: false, reason: 'unsafe-glob' });
  });

  it('checks the static directory prefix before every glob token and its symlinks', async () => {
    await mkdir(join(root, 'directory'));
    await directoryLink(outside, join(root, 'escape'));
    for (const suffix of ['*.txt', '**/*.txt', 'file?.txt', '[ab].txt', '{a,b}.txt', '(a|b).txt']) {
      expect(await judgePath(plan, 'glob', `directory/${suffix}`))
        .toEqual({ allowed: true, canonical: join(root, 'directory') });
      expect(await judgePath(plan, 'glob', `escape/${suffix}`)).toEqual({ allowed: false, reason: 'outside-roots' });
    }
  });

  it('honors native separators and POSIX escaped literal wildcard directory names', async () => {
    await mkdir(join(root, 'directory'));
    expect(await judgePath(plan, 'glob', `directory${sep}*.txt`))
      .toEqual({ allowed: true, canonical: join(root, 'directory') });
    if (process.platform === 'win32') {
      await directoryLink(outside, join(root, 'escape'));
      expect(await judgePath(plan, 'glob', 'escape\\*.txt')).toEqual({ allowed: false, reason: 'outside-roots' });
    } else {
      for (const token of ['*', '?', '[', '{', '(']) {
        await directoryLink(outside, join(root, `literal${token}`));
        expect(await judgePath(plan, 'glob', `literal\\${token}/*.txt`)).toEqual({ allowed: false, reason: 'outside-roots' });
      }
    }
  });

  it('does not apply project glob restrictions to unrestricted reads', async () => {
    await mkdir(join(root, 'a..b'));
    await mkdir(join(root, '~literal'));
    const unrestricted: OutboundPlan = { ...plan, readableRoots: 'unrestricted' };
    for (const [pattern, canonical] of [
      [join(outside, '*.txt'), outside],
      ['../project-sibling/*.txt', outside],
      ['a..b/*.txt', join(root, 'a..b')],
      ['~literal/*.txt', join(root, '~literal')],
    ] as const) {
      expect(await judgePath(unrestricted, 'glob', pattern)).toEqual({ allowed: true, canonical });
    }
  });

  it('refuses ambiguous glob negation and checks concrete matches separately', async () => {
    expect(await judgePath(plan, 'glob', '!escape/*.txt')).toEqual({ allowed: false, reason: 'unsafe-glob' });
    await directoryLink(outside, join(root, 'escape'));
    expect(await judgePath(plan, 'glob', '*/*.txt')).toEqual({ allowed: true, canonical: root });
    expect(await judgePath(plan, 'read', 'escape/outside.txt')).toEqual({ allowed: false, reason: 'outside-roots' });
    if (process.platform !== 'win32') {
      expect(await judgePath(plan, 'glob', 'directory\\')).toEqual({ allowed: false, reason: 'unsafe-glob' });
      expect(await judgePath(plan, 'glob', 'directory\\/*.txt')).toEqual({ allowed: false, reason: 'unsafe-glob' });
    }
  });
});

describe('outbound remote image policy', () => {
  const image = Buffer.from('image');
  const plan = (network: boolean, tier: 'qa' | 'write' | 'full'): OutboundPlan => ({
    grant: tier === 'full' ? { tier, root: '/project', network } : { tier, root: '/project', readScope: 'project', network },
    readableRoots: tier === 'full' ? 'unrestricted' : ['/project'],
    writableRoots: tier === 'full' ? 'unrestricted' : tier === 'qa' ? [] : ['/project'],
  });
  const deps = (addresses: { address: string; family: 4 | 6 }[] = [{ address: '8.8.8.8', family: 4 }]): RemoteImageDeps => ({
    resolve: vi.fn(async () => addresses),
    request: vi.fn(async () => ({ status: 200, headers: { contentType: 'image/png' }, body: image })),
  });

  describe('shared download deadline', () => {
    let deadline: AbortSignal;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
        const controller = new AbortController();
        deadline = controller.signal;
        setTimeout(() => controller.abort(new DOMException('Download timed out', 'TimeoutError')), milliseconds);
        return deadline;
      });
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('settles at the deadline when DNS never settles', async () => {
      const io = deps();
      io.resolve = vi.fn<RemoteImageDeps['resolve']>(() => new Promise(() => {}));
      let settled = false;
      let failure: unknown;
      void fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), io).then(
        () => { settled = true; },
        error => { settled = true; failure = error; },
      );
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(failure).toBe(deadline.reason);
      expect(io.request).not.toHaveBeenCalled();
      expect(getEventListeners(deadline, 'abort')).toHaveLength(0);
    });

    it.each(['resolve', 'reject'] as const)('ignores DNS that completes late with %s', async completion => {
      const io = deps();
      io.resolve = vi.fn<RemoteImageDeps['resolve']>(() => new Promise((resolve, reject) => {
        setTimeout(() => completion === 'resolve'
          ? resolve([{ address: '8.8.8.8', family: 4 }])
          : reject(new Error('Late DNS failure')), 11_000);
      }));
      let failure: unknown;
      const result = fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), io)
        .catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(failure).toBe(deadline.reason);
      expect(getEventListeners(deadline, 'abort')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(io.request).not.toHaveBeenCalled();
    });

    it.each(['resolve', 'reject', 'throw'] as const)('cleans up after DNS %s before the deadline', async completion => {
      const io = deps();
      const error = new Error('DNS failed');
      if (completion === 'reject') io.resolve = vi.fn(async () => { throw error; });
      if (completion === 'throw') io.resolve = vi.fn(() => { throw error; });
      const result = fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), io);
      if (completion === 'resolve') await expect(result).resolves.toEqual(image);
      else await expect(result).rejects.toBe(error);
      expect(getEventListeners(deadline, 'abort')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(io.request).toHaveBeenCalledTimes(completion === 'resolve' ? 1 : 0);
    });

    it('uses the remaining total deadline for redirect DNS', async () => {
      const io = deps();
      io.resolve = vi.fn<RemoteImageDeps['resolve']>(() => new Promise(resolve => {
        setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 6_000);
      }));
      io.request = vi.fn(async () => ({ status: 302, headers: { location: 'https://redirect.test/b.png' }, body: Buffer.alloc(0) }));
      let failure: unknown;
      const result = fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), io)
        .catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(io.resolve).toHaveBeenCalledTimes(2);
      expect(io.request).toHaveBeenCalledTimes(1);
      expect(getEventListeners(deadline, 'abort')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toBe(deadline.reason);
      expect(getEventListeners(deadline, 'abort')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await result;
      expect(io.request).toHaveBeenCalledTimes(1);
      expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    });
  });

  it.each(['qa', 'write', 'full'] as const)('returns before DNS with network off in %s', async tier => {
    const io = deps();
    expect(await fetchRemoteImage('https://example.com/a.png', plan(false, tier), io)).toBeUndefined();
    expect(io.resolve).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '::1', '10.0.0.5', '172.16.0.1', '192.168.1.1',
    '169.254.169.254', 'fe80::1', '100.64.0.1', '0.0.0.0', '::ffff:127.0.0.1'])
  ('rejects blocked DNS result %s before request', async address => {
    const io = deps([{ address, family: address.includes(':') ? 6 : 4 }]);
    expect(await fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), io)).toBeUndefined();
    expect(io.request).not.toHaveBeenCalled();
  });

  it('rejects a mixed public and private DNS answer and pins a safe connection', async () => {
    const mixed = deps([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    expect(await fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), mixed)).toBeUndefined();
    expect(mixed.request).not.toHaveBeenCalled();

    const safe = deps();
    expect(await fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), safe)).toEqual(image);
    expect(safe.request).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'example.com' }), '8.8.8.8', expect.any(AbortSignal));
  });

  it('checks a redirect destination before connecting and limits the chain to three', async () => {
    const blocked = deps();
    blocked.resolve = vi.fn(async (hostname: string) => [{ address: hostname === 'blocked.test' ? '127.0.0.1' : '8.8.8.8', family: 4 as const }]);
    blocked.request = vi.fn(async () => ({ status: 302, headers: { location: 'http://blocked.test/a.png' }, body: Buffer.alloc(0) }));
    expect(await fetchRemoteImage('https://example.com/a.png', plan(true, 'full'), blocked)).toBeUndefined();
    expect(blocked.request).toHaveBeenCalledTimes(1);

    const looping = deps();
    looping.request = vi.fn(async () => ({ status: 302, headers: { location: '/again.png' }, body: Buffer.alloc(0) }));
    expect(await fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), looping)).toBeUndefined();
    expect(looping.request).toHaveBeenCalledTimes(4);
  });

  it('rejects an HTML response', async () => {
    const io = deps();
    io.request = vi.fn(async () => ({ status: 200, headers: { contentType: 'text/html' }, body: image }));
    expect(await fetchRemoteImage('https://example.com/a.png', plan(true, 'write'), io)).toBeUndefined();
  });

  it('connects to the checked address while keeping the original HTTP host', async () => {
    let seenHost: string | undefined;
    const server = createServer((request, response) => {
      seenHost = request.headers.host;
      response.setHeader('content-type', 'image/png');
      response.end(image);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server port');
      const url = new URL(`http://example.test:${address.port}/a.png`);
      const response = await requestPinned(url, '127.0.0.1', AbortSignal.timeout(1000));
      expect(response.body).toEqual(image);
      expect(seenHost).toBe(`example.test:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

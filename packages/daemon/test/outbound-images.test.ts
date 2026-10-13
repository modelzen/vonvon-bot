import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadOutboundImages } from '../src/card/outbound-images';

vi.mock('node:dns/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // tiny but non-empty

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'outbound-img-'));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A LarkChannel stub whose image.create returns a fresh key and counts calls. */
function fakeChannel() {
  const state = { calls: 0 };
  const channel = {
    rawClient: {
      im: {
        v1: {
          image: {
            create: async () => {
              state.calls += 1;
              return { image_key: `img_key_${state.calls}` };
            },
          },
        },
      },
    },
  };
  return { channel: channel as any, state };
}

describe('uploadOutboundImages', () => {
  it('uploads a local file inside cwd and maps src → image_key', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'a.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['a.png'], cwd, 'write', false);
    expect(map.get('a.png')).toMatch(/^img_key_/);
    expect(state.calls).toBe(1);
  });

  it('caches by path+mtime+size — a repeat src does not re-upload', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'b.png'), PNG);
    const { channel, state } = fakeChannel();

    await uploadOutboundImages(channel, ['b.png'], cwd, 'write', false);
    const callsAfterFirst = state.calls;
    await uploadOutboundImages(channel, ['b.png'], cwd, 'write', false);
    expect(state.calls).toBe(callsAfterFirst); // cache hit, no second upload
  });

  it('rejects a path that escapes the run cwd (no upload, absent from map)', async () => {
    const cwd = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, [join(outside, 'secret.png'), '../escape.png'], cwd, 'write', false);
    expect(map.size).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('rejects an inside alias to an outside image before upload', async () => {
    const cwd = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret.png'), PNG);
    await symlink(join(outside, 'secret.png'), join(cwd, 'alias.png'));
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['alias.png'], cwd, 'write', false);
    expect(map.has('alias.png')).toBe(false);
    expect(state.calls).toBe(0);
  });

  it('uploads an inside alias using the canonical in-project file', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'target.png'), PNG);
    await symlink(join(cwd, 'target.png'), join(cwd, 'alias.png'));
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['alias.png'], cwd, 'write', false);
    expect(map.get('alias.png')).toMatch(/^img_key_/);
    expect(state.calls).toBe(1);
  });

  it('allows an outside image in full mode', async () => {
    const cwd = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'allowed.png'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, [join(outside, 'allowed.png')], cwd, 'full', false);
    expect(map.get(join(outside, 'allowed.png'))).toMatch(/^img_key_/);
    expect(state.calls).toBe(1);
  });

  it('skips a disallowed extension', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'note.txt'), PNG);
    const { channel, state } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['note.txt'], cwd, 'write', false);
    expect(map.size).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('skips a missing file but keeps a sibling that resolves', async () => {
    const cwd = await tmpDir();
    await writeFile(join(cwd, 'real.png'), PNG);
    const { channel } = fakeChannel();

    const map = await uploadOutboundImages(channel, ['gone.png', 'real.png'], cwd, 'write', false);
    expect(map.has('gone.png')).toBe(false);
    expect(map.get('real.png')).toMatch(/^img_key_/);
  });

  describe('remote sources', () => {
    let server: Server;
    let hits = 0;
    let sources: string[] = [];
    beforeEach(async () => {
      hits = 0;
      vi.mocked(lookup).mockClear();
      server = createServer((_request, response) => {
        hits += 1;
        response.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      });
      await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening));
      const { port } = server.address() as AddressInfo;
      sources = [`http://127.0.0.1:${port}/a.png`, `http://localhost:${port}/b.png`];
    });
    afterEach(() => new Promise<void>(closed => server.close(() => closed())));

    it.each([['write', false], ['full', false], ['write', true], ['full', true]] as const)(
      '%s, network %s: no DNS while off, and a blocked address is never fetched',
      async (mode, network) => {
        const { channel, state } = fakeChannel();
        const map = await uploadOutboundImages(channel, sources, await tmpDir(), mode, network);
        expect({ uploaded: map.size, hits, uploads: state.calls }).toEqual({ uploaded: 0, hits: 0, uploads: 0 });
        expect(vi.mocked(lookup).mock.calls.map(([host]) => host)).toEqual(network ? ['localhost'] : []);
      },
    );
  });
});

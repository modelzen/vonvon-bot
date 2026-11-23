import { accountAvatarMaxBytes } from '@vonvon/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAccountAvatar } from '../src/account-avatar.js';

const url = 'https://avatars.githubusercontent.com/u/123?v=4';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==', 'base64');
const jpg = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z', 'base64');
const webp = Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=', 'base64');
const image = (bytes = png, mime = 'image/png') => new Response(bytes, { headers: { 'Content-Type': mime } });
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

describe('account avatar transport', () => {
  it.each([['image/png', png], ['image/jpeg', jpg], ['image/webp', webp]] as const)(
    'publishes a bounded static %s using a credential-free request', async (mime, bytes) => {
      const transport = vi.fn<typeof fetch>(async (_input, init) => {
        expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', cache: 'no-store', method: 'GET' });
        expect([...new Headers(init?.headers)]).toEqual([['accept', 'image/png, image/jpeg, image/webp']]);
        return image(bytes, mime);
      });
      expect(await fetchAccountAvatar(url, signal(), transport)).toBe(`data:${mime};base64,${bytes.toString('base64')}`);
    });

  it.each(['https://127.0.0.1/x', 'http://avatars.githubusercontent.com/u/1', 'https://avatars.githubusercontent.com:444/u/1',
    'https://evil.example/x', 'https://user@avatars.githubusercontent.com/u/1',
    'https://lh3.googleusercontent.com.evil.example/x', 'https://avatars.githubusercontent.com/u/1?access_token=secret'])(
    'never requests the unsafe destination %s', async destination => {
      const transport = vi.fn<typeof fetch>(async () => image());
      expect(await fetchAccountAvatar(destination, signal(), transport)).toBeUndefined();
      expect(transport).not.toHaveBeenCalled();
      transport.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: destination } }));
      expect(await fetchAccountAvatar(url, signal(), transport)).toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);
    });

  it('checks every relative and absolute redirect and stops after three redirects', async () => {
    const transport = vi.fn<typeof fetch>(async () => image());
    transport.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/u/124?v=4' } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://lh3.googleusercontent.com/a/profile=s96-c' } }));
    expect(await fetchAccountAvatar(url, signal(), transport)).toBe('data:image/png;base64,' + png.toString('base64'));
    expect(transport.mock.calls.map(([input]) => String(input))).toEqual([url, 'https://avatars.githubusercontent.com/u/124?v=4',
      'https://lh3.googleusercontent.com/a/profile=s96-c']);
    transport.mockClear().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/u/125' } }));
    expect(await fetchAccountAvatar(url, signal(), transport)).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it('rejects an oversized declared response before reading, and caps streaming bytes without a length header', async () => {
    const cancelled = vi.fn();
    const body = () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(accountAvatarMaxBytes)); controller.enqueue(new Uint8Array(1)); },
      cancel: cancelled,
    });
    const transport = vi.fn<typeof fetch>(async () => new Response(body(), {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(accountAvatarMaxBytes + 1) },
    }));
    expect(await fetchAccountAvatar(url, signal(), transport)).toBeUndefined();
    expect(cancelled).toHaveBeenCalledOnce();
    transport.mockImplementation(async () => new Response(body(), { headers: { 'Content-Type': 'image/png' } }));
    expect(await fetchAccountAvatar(url, signal(), transport)).toBeUndefined();
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it('rejects active formats, MIME spoofing, truncation, animation and excessive raster dimensions', async () => {
    const huge = Buffer.from(png); huge.writeUInt32BE(1025, 16);
    const zero = Buffer.from(png); zero.writeUInt32BE(0, 20);
    const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
    const apng = Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]);
    const animatedWebp = Buffer.concat([webp, Buffer.from('ANIM\0\0\0\0')]); animatedWebp.writeUInt32LE(animatedWebp.length - 8, 4);
    for (const [bytes, mime] of [[Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'], [png, 'image/jpeg'],
      [Buffer.from('GIF89a'), 'image/png'], [png.subarray(0, 30), 'image/png'], [apng, 'image/png'],
      [animatedWebp, 'image/webp'], [huge, 'image/png'], [zero, 'image/png']] as const) {
      expect(await fetchAccountAvatar(url, signal(), async () => image(bytes, mime))).toBeUndefined();
    }
  });

  it('bounds both a stalled request and a stalled response body with the same timeout', async () => {
    for (const stalledBody of [false, true]) {
      const timeout = new AbortController();
      const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
      const cancelled = vi.fn();
      const transport = vi.fn<typeof fetch>(() => stalledBody
        ? Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'Content-Type': 'image/png' } }))
        : new Promise(() => {}));
      const result = fetchAccountAvatar(url, signal(), transport);
      await new Promise(resolve => setImmediate(resolve));
      expect(timer).toHaveBeenCalledWith(5000);
      timeout.abort(new DOMException('timeout', 'TimeoutError'));
      expect(await result).toBeUndefined();
      if (stalledBody) expect(cancelled).toHaveBeenCalledOnce();
      timer.mockRestore();
    }
  });
});

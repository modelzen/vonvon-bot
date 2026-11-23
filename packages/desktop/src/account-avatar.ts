import { accountAvatarMaxBytes, accountAvatarUrlSchema } from '@vonvon/protocol';
import { imageSize } from 'image-size';

const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const;
const redirects = new Set([301, 302, 303, 307, 308]);

function staticRaster(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return false;
    let image = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      const end = offset + 12 + length;
      if (end > bytes.length || kind === 'acTL' || (offset === 8 && (kind !== 'IHDR' || length !== 13))) return false;
      if (kind === 'IDAT') image = true;
      if (kind === 'IEND') return image && length === 0 && end === bytes.length;
      offset = end;
    }
    return false;
  }
  if (mime === 'image/webp') {
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' ||
        bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
    let image = false;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + length + (length % 2);
      if (end > bytes.length || kind === 'ANIM' || kind === 'ANMF' ||
          (kind === 'VP8X' && (length !== 10 || (bytes[offset + 8]! & 2) !== 0))) return false;
      if (kind === 'VP8 ' || kind === 'VP8L') image = true;
      offset = end;
    }
    return image && offset === bytes.length;
  }
  return mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

export async function fetchAccountAvatar(value: string, owner: AbortSignal, transport: typeof fetch = fetch): Promise<string | undefined> {
  const signal = AbortSignal.any([owner, AbortSignal.timeout(5000)]);
  let rejectAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
    let url = accountAvatarUrlSchema.parse(value);
    for (let hop = 0; hop <= 3; hop++) {
      const response = await Promise.race([transport(url, {
        method: 'GET', headers: { Accept: 'image/png, image/jpeg, image/webp' },
        credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'manual', cache: 'no-store', signal,
      }), aborted]);
      signal.throwIfAborted();
      if (redirects.has(response.status)) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location || hop === 3) return;
        url = accountAvatarUrlSchema.parse(new URL(location, url).href);
        continue;
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      const mime = Object.values(mimeTypes).find(type => type === contentType);
      const length = response.headers.get('content-length');
      if (!response.ok || !response.body || !mime ||
          (length !== null && (!/^\d+$/.test(length) || Number(length) > accountAvatarMaxBytes))) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await Promise.race([reader.read(), aborted]);
          signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > accountAvatarMaxBytes) return;
          chunks.push(part.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, size);
      if (!staticRaster(bytes, mime)) return;
      const dimensions = imageSize(bytes);
      if (!Object.entries(mimeTypes).some(([type, expected]) => dimensions.type === type && expected === mime) ||
          !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) ||
          dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 1024 || dimensions.height > 1024 ||
          dimensions.width * dimensions.height > 1_048_576) return;
      return `data:${mime};base64,${bytes.toString('base64')}`;
    }
  } catch { return; }
  finally { signal.removeEventListener('abort', rejectAbort); }
}

import { ApiError } from './errors.mjs';
import { staticLogoFormat } from './logo-format.mjs';

const maxInput = 2 * 1024 * 1024;
const maxOutput = 128 * 1024;
const dimension = 192;
const webp = 'image/webp';
const invalid = () => new ApiError(422, 'invalid_logo');
const unavailable = () => new ApiError(503, 'logo_decoder_unavailable');
const stream = bytes => new ReadableStream({
  start(controller) {
    controller.enqueue(bytes);
    controller.close();
  },
});

function inputFormat(bytes) {
  try {
    return staticLogoFormat(bytes);
  } catch {
    throw invalid();
  }
}

async function inputInfo(images, input) {
  try {
    return await images.info(stream(input));
  } catch (error) {
    if ([9402, 9412, 9413].includes(error?.code)) throw invalid();
    throw unavailable();
  }
}

async function readOutput(response) {
  if (!response.ok || response.headers.get('content-type') !== webp || !response.body) {
    throw unavailable();
  }
  let length = 0;
  const chunks = [];
  for await (const bytes of response.body) {
    length += bytes.length;
    if (length > maxOutput) throw unavailable();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

export async function normalizeWorkerAvatar(images, bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maxInput) throw invalid();
  const format = inputFormat(bytes);
  if (!images) throw unavailable();
  const info = await inputInfo(images, bytes);
  if (info.format !== 'image/' + format ||
      !Number.isInteger(info.width) || info.width < 1 || info.width > 2048 ||
      !Number.isInteger(info.height) || info.height < 1 || info.height > 2048) throw invalid();
  try {
    const optimized = await images.input(stream(bytes))
      .transform({ width: dimension, height: dimension, fit: 'cover' })
      .output({ format: webp, quality: 85, anim: false });
    const output = await readOutput(optimized.response());
    staticLogoFormat(output, true);
    const outputInfo = await images.info(stream(output));
    if (outputInfo.format !== webp || outputInfo.width !== dimension || outputInfo.height !== dimension) throw unavailable();
    return output;
  } catch (error) {
    if ([9402, 9412, 9413].includes(error?.code)) throw invalid();
    throw unavailable();
  }
}

export async function verifyWorkerNormalizedLogo(images, bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maxOutput) throw invalid();
  try {
    staticLogoFormat(bytes, true);
  } catch {
    throw invalid();
  }
  if (!images) throw unavailable();
  const info = await inputInfo(images, bytes);
  if (info.format !== webp || info.width !== dimension || info.height !== dimension) throw invalid();
  try {
    // Decode the stored image fully. Reading metadata alone misses truncated pixel data.
    const checked = await images.input(stream(bytes)).output({ format: webp, quality: 85, anim: false });
    await readOutput(checked.response());
  } catch (error) {
    if ([9402, 9412, 9413].includes(error?.code)) throw invalid();
    throw unavailable();
  }
}

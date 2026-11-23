export async function boundedJson(response: Response, limit = 16 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('社区响应无效');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('社区响应无效');
      chunks.push(value);
    }
  } catch {await reader.cancel().catch(() => {}); throw new Error('社区响应无效');}
  finally {reader.releaseLock();}
  const content = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) {content.set(chunk, offset); offset += chunk.byteLength;}
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(content));} catch {throw new Error('社区响应无效');}
}

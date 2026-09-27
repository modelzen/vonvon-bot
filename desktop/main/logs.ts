import type {HostHandle} from './host';

export const LOG_LIMIT = 128 * 1024;
export async function recentLogs(host:HostHandle):Promise<string> {
  const response = await host.request(`/api/logs?maxBytes=${LOG_LIMIT}`, {signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error(`日志读取失败 (${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > LOG_LIMIT + 4096) throw new Error('日志响应超出大小限制');
      text += decoder.decode(next.value,{stream:true});
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}

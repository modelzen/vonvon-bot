import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const proxyNames = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

function systemProxy(text, kind) {
  const value = key => text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
  if (value(`${kind}Enable`) !== '1') return undefined;
  const host = value(`${kind}Proxy`), port = Number(value(`${kind}Port`));
  if (!host || /[\\/?#@\s]/u.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  try {
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    const url = new URL(`http://${authority}:${port}`);
    if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch { return undefined; }
}

/** Use existing settings only for the GitHub artifact download child, never system-wide. */
export async function resolveDownloadEnvironment(env = process.env, { platform = process.platform, execute = exec } = {}) {
  const result = { ...env };
  // Explicit settings (including an intentionally empty value) win over macOS.
  // Go's HTTPS transport does not use HTTP_PROXY for HTTPS requests by itself.
  if (proxyNames.some(name => Object.hasOwn(env, name))) {
    const http = env.HTTP_PROXY || env.http_proxy;
    if (!['HTTPS_PROXY', 'https_proxy'].some(name => Object.hasOwn(env, name)) && http) result.HTTPS_PROXY = http;
    return result;
  }
  if (platform !== 'darwin') return result;
  let stdout;
  try { ({ stdout } = await execute('/usr/sbin/scutil', ['--proxy'], { env, timeout: 3000, maxBuffer: 64 * 1024 })); }
  catch { return result; }
  const proxy = systemProxy(stdout, 'HTTPS') ?? systemProxy(stdout, 'HTTP');
  if (!proxy) return result; // PAC and SOCKS-only settings are not guessed.
  result.HTTPS_PROXY = proxy;
  result.HTTP_PROXY = proxy;
  if (!Object.hasOwn(env, 'NO_PROXY') && !Object.hasOwn(env, 'no_proxy')) {
    const exceptions = stdout.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/s)?.[1] ?? '';
    const hosts = [...exceptions.matchAll(/^\s*\d+\s*:\s*(\S+)\s*$/gm)].map(match => match[1])
      .filter(host => host !== '<local>' && /^[\w.*:[\]/-]+$/u.test(host));
    if (hosts.length) result.NO_PROXY = hosts.join(',');
  }
  return result;
}

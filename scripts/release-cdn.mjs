// CDN policy is deliberately small: immutable objects follow their origin headers; mutable
// objects and their errors bypass the cache. This mode does not need a per-release purge.
export const NO_CDN = '未启用 CDN，未刷新';
export const BYPASS_CDN = '腾讯 CDN：可变对象不缓存，未执行刷新';

/** An explicit operator declaration, not proof of the remote CDN configuration. */
export function readReleaseCdnPolicy(cdn) {
  if (cdn === undefined) return undefined;
  if (!cdn || typeof cdn !== 'object' || Array.isArray(cdn)
    || Object.keys(cdn).sort().join(',') !== 'mutablePolicy,provider'
    || cdn.provider !== 'tencent' || cdn.mutablePolicy !== 'bypass') {
    throw new Error('CDN configuration supports only {provider:"tencent",mutablePolicy:"bypass"}; configure mutable and error responses not to cache before enabling it');
  }
  return { provider: 'tencent', mutablePolicy: 'bypass' };
}

export const releaseCdnDescription = cdn => readReleaseCdnPolicy(cdn) ? BYPASS_CDN : NO_CDN;

/** Check an ordinary client-visible response, without cache-busting that could hide stale data. */
export function assertMutableCdnResponse(response, cdn) {
  if (!readReleaseCdnPolicy(cdn) || ![200, 404].includes(response.status)) return;
  const cache = (response.headers.get('cache-control') ?? '').toLowerCase().split(',').map(value => value.trim());
  // For an absent object COS may omit Cache-Control. The separately configured error-cache
  // bypass is still required; known positive TTL / Age / hit evidence is refused for 404 too.
  if (response.status === 200 && !cache.includes('no-cache') && !cache.includes('no-store')) {
    throw new Error('CDN mutable response requires Cache-Control: no-cache or no-store');
  }
  if (cache.some(value => /^(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)\s*=/.test(value)
    && !/^(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)\s*=\s*"?0"?$/.test(value))) {
    throw new Error('CDN mutable response has a positive or invalid cache TTL');
  }
  const age = response.headers.get('age');
  if (age !== null && (!/^\s*0\s*$/.test(age))) throw new Error('CDN mutable response has a nonzero or invalid Age');
  const lookup = [response.headers.get('x-cache-lookup'), response.headers.get('x-cache'), response.headers.get('cf-cache-status')].filter(Boolean).join(',');
  if (/\bhit\b|cachehit|stale|updating/i.test(lookup)) throw new Error('CDN served a cached mutable response; verify bypass and purge existing cached copies');
}

/** The fixed public URLs allowed to change while their URL remains the same. */
export function isMutableReleaseURL(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.origin !== 'https://dl.vonvon.cc') return false;
  return url.pathname === '/bot/mac/stable/manifest.json'
    || /^\/bot\/windows\/stable\/(?:x64|arm64)\/update\.json$/.test(url.pathname)
    || /^\/bot\/server\/(?:stable\/manifest\.json|install\.sh|uninstall\.sh)$/.test(url.pathname);
}

export function withReleaseCdnVerification(fetchImpl, cdn) {
  const policy = readReleaseCdnPolicy(cdn);
  if (!policy) return fetchImpl;
  return async (url, options) => {
    const response = await fetchImpl(url, options);
    if (isMutableReleaseURL(url)) {
      try { assertMutableCdnResponse(response, policy); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    }
    return response;
  };
}

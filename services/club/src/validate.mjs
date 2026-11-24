export const TEMPLATE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,62}(?:\/[a-z0-9][a-z0-9-]{0,62})?$/;
export const ANON_KEY_REGEX = /^[a-f0-9]{64}$/;
export const MAX_JSON_BODY_BYTES = 32 * 1024;
export const MAX_COVER_UPLOAD_BYTES = 2 * 1024 * 1024;

export function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isFeishuDocUrl(value) {
  if (!isHttpsUrl(value)) return false;
  try {
    const url = new URL(value.trim());
    return /(?:^|\.)(?:feishu\.cn|larkoffice\.com|larksuite\.com)$/i.test(url.hostname)
      && /^\/(?:docx|wiki|docs)\/[A-Za-z0-9_-]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function cleanString(value, maxLen) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) return undefined;
  return trimmed;
}

function validateStringArray(value, fieldName, maxItems, maxItemLen) {
  if (value === undefined) return { ok: true, items: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${fieldName} 必须是数组` };
  if (value.length > maxItems) return { ok: false, error: `${fieldName} 数量超出上限（最多 ${maxItems} 项）` };
  const out = [];
  for (const item of value) {
    const cleaned = cleanString(item, maxItemLen);
    if (!cleaned) return { ok: false, error: `${fieldName} 包含空值或超长项` };
    out.push(cleaned);
  }
  return { ok: true, items: out };
}

/**
 * Validate `PublicPromoPayload` received from `vonvon template pack --publish` or `vonvon template stage`.
 * Requires explicit `public: true` publication grant and preserves exact validated items for Ed25519 verification.
 */
export function validatePromoPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'promo 必须是 JSON 对象' };
  }
  if (raw.schemaVersion !== 1) return { ok: false, error: '仅支持 schemaVersion=1' };
  if (raw.public !== true) return { ok: false, error: '仅接收明确开启 public=true 的公开配方' };

  const id = cleanString(raw.id, 128);
  if (!id || !TEMPLATE_ID_REGEX.test(id)) return { ok: false, error: 'id 格式不合法' };

  const version = cleanString(raw.version, 40);
  if (!version) return { ok: false, error: '缺少有效 version' };

  const name = cleanString(raw.name, 80);
  if (!name) return { ok: false, error: '缺少有效 name（1–80 字）' };

  const summary = cleanString(raw.summary, 300);
  if (!summary) return { ok: false, error: '缺少有效 summary（1–300 字）' };

  const docUrl = raw.docUrl !== undefined ? cleanString(raw.docUrl, 2048) : undefined;
  const repository = raw.repository !== undefined ? cleanString(raw.repository, 2048) : undefined;
  const targetUrl = docUrl ?? repository;
  if (!targetUrl || !isHttpsUrl(targetUrl)) {
    return { ok: false, error: '公开配方必须提供合法的 https:// 宣传文档链接（docUrl）' };
  }
  if (docUrl && !isHttpsUrl(docUrl)) return { ok: false, error: 'docUrl 必须以 https:// 开头' };
  if (repository && !isHttpsUrl(repository)) return { ok: false, error: 'repository 必须以 https:// 开头' };

  const installHint = raw.installHint !== undefined ? cleanString(raw.installHint, 300) : undefined;
  if (raw.installHint !== undefined && !installHint) return { ok: false, error: 'installHint 长度不合法' };

  if (!raw.author || typeof raw.author !== 'object' || Array.isArray(raw.author)) {
    return { ok: false, error: '缺少 author 对象' };
  }
  const authorName = cleanString(raw.author.name, 80);
  if (!authorName) return { ok: false, error: '缺少 author.name' };
  const authorUrl = raw.author.url !== undefined ? cleanString(raw.author.url, 2048) : undefined;
  if (raw.author.url !== undefined && (!authorUrl || !isHttpsUrl(authorUrl))) {
    return { ok: false, error: 'author.url 必须以 https:// 开头' };
  }
  const authorContact = raw.author.contact !== undefined ? cleanString(raw.author.contact, 120) : undefined;
  const publicKey = typeof raw.author.publicKey === 'string' ? raw.author.publicKey.trim() : '';

  let pricing = { kind: 'free' };
  if (raw.pricing && typeof raw.pricing === 'object') {
    if (raw.pricing.kind === 'free') {
      pricing = { kind: 'free' };
    } else if (raw.pricing.kind === 'external') {
      const pUrl = cleanString(raw.pricing.url, 2048);
      if (!pUrl || !isHttpsUrl(pUrl)) return { ok: false, error: 'external pricing 缺少有效 https:// url' };
      const displayPrice = raw.pricing.displayPrice !== undefined ? cleanString(raw.pricing.displayPrice, 40) : undefined;
      pricing = { kind: 'external', ...(displayPrice ? { displayPrice } : {}), url: pUrl };
    } else {
      return { ok: false, error: '未知 pricing.kind' };
    }
  }

  const tagsCheck = validateStringArray(raw.tags, 'tags', 12, 32);
  if (!tagsCheck.ok) return tagsCheck;
  const skillsCheck = validateStringArray(raw.skillNames, 'skillNames', 50, 64);
  if (!skillsCheck.ok) return skillsCheck;
  const acqCheck = validateStringArray(raw.acquisition, 'acquisition', 10, 40);
  if (!acqCheck.ok) return acqCheck;

  return {
    ok: true,
    promo: {
      schemaVersion: 1,
      public: true,
      id,
      version,
      name,
      summary,
      tags: tagsCheck.items,
      skillNames: skillsCheck.items,
      ...(docUrl ? { docUrl } : {}),
      ...(installHint ? { installHint } : {}),
      ...(repository ? { repository } : {}),
      author: {
        name: authorName,
        ...(authorUrl ? { url: authorUrl } : {}),
        ...(authorContact ? { contact: authorContact } : {}),
        publicKey,
      },
      pricing,
      acquisition: acqCheck.items.length ? acqCheck.items : ['local'],
    },
  };
}

/**
 * Bounded in-memory fixed-window IP rate limiter (O(1) eviction cap prevents memory/CPU exhaustion).
 */
export class RateLimiter {
  #buckets = new Map();
  #windowMs;
  #maxHits;
  #maxKeys;
  #lastSweepAt = 0;

  constructor({ windowMs = 60_000, maxHits = 60, maxKeys = 10_000 } = {}) {
    this.#windowMs = windowMs;
    this.#maxHits = maxHits;
    this.#maxKeys = maxKeys;
  }

  allow(key, now = Date.now()) {
    const existing = this.#buckets.get(key);
    if (existing && existing.resetAt > now) {
      if (existing.count >= this.#maxHits) return false;
      existing.count += 1;
      return true;
    }

    if (this.#buckets.size >= this.#maxKeys) {
      if (now - this.#lastSweepAt >= this.#windowMs) {
        this.#lastSweepAt = now;
        for (const [k, v] of this.#buckets) {
          if (v.resetAt <= now) this.#buckets.delete(k);
        }
      }
      while (this.#buckets.size >= this.#maxKeys) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest === undefined) break;
        this.#buckets.delete(oldest);
      }
    }

    this.#buckets.delete(key);
    this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
    return true;
  }
}

/** Detect PNG / JPEG / WebP by magic bytes so untrusted uploads cannot disguise HTML/SVG as covers. */
export function detectImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

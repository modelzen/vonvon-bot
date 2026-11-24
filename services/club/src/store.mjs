import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Hex } from './crypto.mjs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Compare dotted numeric version strings (e.g. `0.2.0` > `0.1.9`, `1.0.0` > `1.0.0-rc.1`).
 * Returns negative if `a < b`, 0 if equal, positive if `a > b`.
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  const parse = v => {
    const [core, pre = ''] = String(v).replace(/^v/i, '').split('-', 2);
    const nums = core.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : NaN));
    return { nums, pre, valid: nums.length > 0 && nums.every(Number.isFinite) };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa.valid || !pb.valid) return 0;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const da = pa.nums[i] ?? 0;
    const db = pb.nums[i] ?? 0;
    if (da !== db) return da - db;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Lightweight SQLite store for 「Vonvon 灵感 Club」 (`club.vonvon.cc`).
 * Uses Node's built-in `node:sqlite` (zero native npm builds).
 */
export class ClubStore {
  #db;
  #autoTrustKeys;

  constructor(dbPath, { autoTrustKeys = [] } = {}) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#autoTrustKeys = new Set(autoTrustKeys.filter(Boolean));
    this.#init();
  }

  #init() {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS authors (
        public_key TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        trusted INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS templates (
        id TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        version TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        skill_names_json TEXT NOT NULL,
        doc_url TEXT NOT NULL,
        install_hint TEXT,
        repository TEXT,
        cover_url TEXT,
        author_json TEXT NOT NULL,
        pricing_json TEXT NOT NULL,
        acquisition_json TEXT NOT NULL,
        promo_signature TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (id, author_public_key)
      );

      CREATE TABLE IF NOT EXISTS installs (
        template_id TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        anon_install_key TEXT NOT NULL,
        version TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (template_id, author_public_key, anon_install_key)
      );

      CREATE TABLE IF NOT EXISTS likes (
        template_id TEXT NOT NULL,
        author_public_key TEXT NOT NULL,
        voter_hash TEXT NOT NULL,
        liked_at INTEGER NOT NULL,
        PRIMARY KEY (template_id, author_public_key, voter_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_installs_recent ON installs (template_id, author_public_key, installed_at);
      CREATE INDEX IF NOT EXISTS idx_templates_updated ON templates (updated_at DESC);
    `);

    for (const key of this.#autoTrustKeys) {
      this.#db.prepare(`
        INSERT INTO authors (public_key, name, trusted, blocked, first_seen_at, note)
        VALUES (?, '', 1, 0, ?, 'auto-trust-env')
        ON CONFLICT(public_key) DO UPDATE SET trusted = 1
      `).run(key, Date.now());
    }
  }

  close() {
    this.#db.close();
  }

  #ensureAuthor(publicKey, authorName, now) {
    const existing = this.#db.prepare('SELECT public_key, trusted, blocked FROM authors WHERE public_key = ?').get(publicKey);
    if (existing) {
      if (authorName) {
        this.#db.prepare('UPDATE authors SET name = ? WHERE public_key = ? AND name = \'\'').run(authorName, publicKey);
      }
      return { trusted: Boolean(existing.trusted), blocked: Boolean(existing.blocked) };
    }
    const trusted = this.#autoTrustKeys.has(publicKey) ? 1 : 0;
    this.#db.prepare(`
      INSERT INTO authors (public_key, name, trusted, blocked, first_seen_at, note)
      VALUES (?, ?, ?, 0, ?, '')
    `).run(publicKey, authorName, trusted, now);
    return { trusted: Boolean(trusted), blocked: false };
  }

  #upsertTemplate(promo, authorPublicKey, signature, now, { skipIfExists = false } = {}) {
    const existing = this.#db.prepare(
      'SELECT version, cover_url FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(promo.id, authorPublicKey);

    if (existing && skipIfExists) {
      return { changed: false, existed: true, coverUrl: existing.cover_url ?? null };
    }

    const docUrl = promo.docUrl ?? promo.repository ?? '';
    this.#db.prepare(`
      INSERT INTO templates (
        id, author_public_key, version, name, summary, tags_json, skill_names_json,
        doc_url, install_hint, repository, cover_url, author_json, pricing_json,
        acquisition_json, promo_signature, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, author_public_key) DO UPDATE SET
        version = excluded.version,
        name = excluded.name,
        summary = excluded.summary,
        tags_json = excluded.tags_json,
        skill_names_json = excluded.skill_names_json,
        doc_url = excluded.doc_url,
        install_hint = excluded.install_hint,
        repository = excluded.repository,
        author_json = excluded.author_json,
        pricing_json = excluded.pricing_json,
        acquisition_json = excluded.acquisition_json,
        promo_signature = excluded.promo_signature,
        updated_at = excluded.updated_at
    `).run(
      promo.id,
      authorPublicKey,
      promo.version,
      promo.name,
      promo.summary,
      JSON.stringify(promo.tags ?? []),
      JSON.stringify(promo.skillNames ?? []),
      docUrl,
      promo.installHint ?? null,
      promo.repository ?? null,
      JSON.stringify(promo.author),
      JSON.stringify(promo.pricing),
      JSON.stringify(promo.acquisition ?? ['local']),
      signature ?? null,
      now,
      now,
    );
    return { changed: true, existed: Boolean(existing), coverUrl: existing?.cover_url ?? null };
  }

  /**
   * Called on `vonvon template pack --publish`: registers/updates the public promo card immediately
   * without adding a fake install count.
   */
  publish(promo, signature, now = Date.now()) {
    const authorPublicKey = promo.author.publicKey;
    const author = this.#ensureAuthor(authorPublicKey, promo.author.name, now);
    if (author.blocked) return { ok: false, blocked: true };

    const existing = this.#db.prepare(
      'SELECT version FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(promo.id, authorPublicKey);
    if (existing && compareVersions(promo.version, existing.version) < 0) {
      return { ok: false, downgrade: true, currentVersion: existing.version };
    }

    const { existed } = this.#upsertTemplate(promo, authorPublicKey, signature, now, { skipIfExists: false });
    return {
      ok: true,
      status: author.trusted ? (existed ? 'updated' : 'published') : 'pending_author_trust',
      id: promo.id,
      authorPublicKey,
      trusted: author.trusted,
    };
  }

  /**
   * Called on `vonvon template stage`: idempotently records deduplicated unique installs.
   * Seeds missing cards for unpublished public packs, but NEVER overwrites an existing card
   * (preventing older installed packages from rolling back newer author-published listings).
   */
  recordInstall(promo, signature, { sourceKind, anonInstallKey }, now = Date.now()) {
    const authorPublicKey = promo.author.publicKey
      || `unsigned:${sha256Hex(promo.docUrl ?? promo.repository ?? promo.id).slice(0, 24)}`;
    const author = this.#ensureAuthor(authorPublicKey, promo.author.name, now);
    if (author.blocked) return { ok: false, blocked: true };

    this.#upsertTemplate(promo, authorPublicKey, signature, now, { skipIfExists: true });

    const existingInstall = this.#db.prepare(
      'SELECT anon_install_key FROM installs WHERE template_id = ? AND author_public_key = ? AND anon_install_key = ?',
    ).get(promo.id, authorPublicKey, anonInstallKey);

    if (existingInstall) {
      this.#db.prepare(`
        UPDATE installs SET version = ?, updated_at = ?
        WHERE template_id = ? AND author_public_key = ? AND anon_install_key = ?
      `).run(promo.version, now, promo.id, authorPublicKey, anonInstallKey);
    } else {
      this.#db.prepare(`
        INSERT INTO installs (template_id, author_public_key, anon_install_key, version, source_kind, installed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(promo.id, authorPublicKey, anonInstallKey, promo.version, sourceKind, now, now);
    }

    return { ok: true, id: promo.id, authorPublicKey, deduplicated: Boolean(existingInstall), trusted: author.trusted };
  }

  #hydrateRow(row, voterHash) {
    const liked = voterHash
      ? Boolean(this.#db.prepare(
        'SELECT 1 FROM likes WHERE template_id = ? AND author_public_key = ? AND voter_hash = ?',
      ).get(row.id, row.author_public_key, voterHash))
      : false;
    return {
      id: row.id,
      authorPublicKey: row.author_public_key,
      version: row.version,
      name: row.name,
      summary: row.summary,
      tags: JSON.parse(row.tags_json),
      skillNames: JSON.parse(row.skill_names_json),
      docUrl: row.doc_url,
      installHint: row.install_hint ?? undefined,
      repository: row.repository ?? undefined,
      coverUrl: row.cover_url ?? null,
      author: JSON.parse(row.author_json),
      pricing: JSON.parse(row.pricing_json),
      acquisition: JSON.parse(row.acquisition_json),
      installCount: Number(row.install_count ?? 0),
      recentInstallCount: Number(row.recent_install_count ?? 0),
      likeCount: Number(row.like_count ?? 0),
      liked,
      trusted: Boolean(row.trusted),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listPublic({ sort = 'hot', q = '', tag = '', author = '', voterHash = '', now = Date.now() } = {}) {
    const since = now - SEVEN_DAYS_MS;
    const rows = this.#db.prepare(`
      SELECT
        t.*,
        a.trusted,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count,
        (SELECT COUNT(*) FROM likes l WHERE l.template_id = t.id AND l.author_public_key = t.author_public_key) AS like_count
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE a.trusted = 1 AND a.blocked = 0
    `).all(since);

    let items = rows.map(r => this.#hydrateRow(r, voterHash));
    const totalTemplates = items.length;
    const totalInstalls = items.reduce((s, item) => s + item.installCount, 0);
    const totalLikes = items.reduce((s, item) => s + item.likeCount, 0);

    const tagCounts = new Map();
    for (const item of items) {
      for (const t of item.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const popularTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));

    const query = q.trim().toLowerCase();
    if (query) {
      items = items.filter(item =>
        item.name.toLowerCase().includes(query)
        || item.summary.toLowerCase().includes(query)
        || item.id.toLowerCase().includes(query)
        || item.author.name.toLowerCase().includes(query)
        || item.tags.some(t => t.toLowerCase().includes(query))
        || item.skillNames.some(s => s.toLowerCase().includes(query)),
      );
    }
    const cleanTag = tag.trim().toLowerCase();
    if (cleanTag) items = items.filter(item => item.tags.some(t => t.toLowerCase() === cleanTag));
    const cleanAuthor = author.trim().toLowerCase();
    if (cleanAuthor) items = items.filter(item => item.author.name.toLowerCase() === cleanAuthor);

    if (sort === 'likes') {
      items.sort((a, b) => b.likeCount - a.likeCount || b.installCount - a.installCount || b.updatedAt - a.updatedAt);
    } else if (sort === 'new') {
      items.sort((a, b) => b.updatedAt - a.updatedAt || b.installCount - a.installCount);
    } else {
      items.sort((a, b) => b.installCount - a.installCount || b.likeCount - a.likeCount || b.updatedAt - a.updatedAt);
    }

    return {
      stats: { totalTemplates, totalInstalls, totalLikes },
      popularTags,
      items,
    };
  }

  /** Lookup by template id; public reads require trusted authors unless `includeUntrusted` is explicitly passed by admin. */
  getById(id, authorPublicKey, { includeUntrusted = false, now = Date.now() } = {}) {
    const since = now - SEVEN_DAYS_MS;
    const trustClause = includeUntrusted ? '' : 'AND a.trusted = 1';
    const rows = authorPublicKey
      ? this.#db.prepare(`
          SELECT t.*, a.trusted,
            (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
            (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count,
            (SELECT COUNT(*) FROM likes l WHERE l.template_id = t.id AND l.author_public_key = t.author_public_key) AS like_count
          FROM templates t JOIN authors a ON a.public_key = t.author_public_key
          WHERE t.id = ? AND t.author_public_key = ? AND a.blocked = 0 ${trustClause}
        `).all(since, id, authorPublicKey)
      : this.#db.prepare(`
          SELECT t.*, a.trusted,
            (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
            (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count,
            (SELECT COUNT(*) FROM likes l WHERE l.template_id = t.id AND l.author_public_key = t.author_public_key) AS like_count
          FROM templates t JOIN authors a ON a.public_key = t.author_public_key
          WHERE t.id = ? AND a.blocked = 0 ${trustClause}
          ORDER BY a.trusted DESC, install_count DESC
        `).all(since, id);
    return rows.map(r => this.#hydrateRow(r, ''));
  }

  toggleLike(templateId, authorPublicKey, voterHash, now = Date.now()) {
    const exists = this.#db.prepare(`
      SELECT 1 FROM templates t JOIN authors a ON a.public_key = t.author_public_key
      WHERE t.id = ? AND t.author_public_key = ? AND a.trusted = 1 AND a.blocked = 0
    `).get(templateId, authorPublicKey);
    if (!exists) return null;

    const already = this.#db.prepare(
      'SELECT 1 FROM likes WHERE template_id = ? AND author_public_key = ? AND voter_hash = ?',
    ).get(templateId, authorPublicKey, voterHash);

    let liked;
    if (already) {
      this.#db.prepare('DELETE FROM likes WHERE template_id = ? AND author_public_key = ? AND voter_hash = ?')
        .run(templateId, authorPublicKey, voterHash);
      liked = false;
    } else {
      this.#db.prepare('INSERT INTO likes (template_id, author_public_key, voter_hash, liked_at) VALUES (?, ?, ?, ?)')
        .run(templateId, authorPublicKey, voterHash, now);
      liked = true;
    }

    const row = this.#db.prepare('SELECT COUNT(*) AS cnt FROM likes WHERE template_id = ? AND author_public_key = ?')
      .get(templateId, authorPublicKey);
    return { liked, likeCount: Number(row.cnt ?? 0) };
  }

  setCoverUrl(templateId, authorPublicKey, coverUrl) {
    const prev = this.#db.prepare(
      'SELECT cover_url FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(templateId, authorPublicKey);
    const res = this.#db.prepare(
      'UPDATE templates SET cover_url = ? WHERE id = ? AND author_public_key = ?',
    ).run(coverUrl, templateId, authorPublicKey);
    const previousCoverUrl = prev?.cover_url && prev.cover_url !== coverUrl ? prev.cover_url : null;
    return { updated: res.changes > 0, previousCoverUrl };
  }

  isCoverPublic(coverUrl) {
    return Boolean(this.#db.prepare(`
      SELECT 1 FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE t.cover_url = ? AND a.trusted = 1 AND a.blocked = 0
      LIMIT 1
    `).get(coverUrl));
  }

  isCoverReferenced(coverUrl) {
    return Boolean(this.#db.prepare('SELECT 1 FROM templates WHERE cover_url = ? LIMIT 1').get(coverUrl));
  }

  setAuthorTrust(publicKey, trusted, note = '') {
    const existing = this.#db.prepare('SELECT public_key FROM authors WHERE public_key = ?').get(publicKey);
    if (!existing) {
      this.#db.prepare(
        'INSERT INTO authors (public_key, name, trusted, blocked, first_seen_at, note) VALUES (?, \'\', ?, 0, ?, ?)',
      ).run(publicKey, trusted ? 1 : 0, Date.now(), note);
      return true;
    }
    this.#db.prepare('UPDATE authors SET trusted = ?, note = CASE WHEN ? != \'\' THEN ? ELSE note END WHERE public_key = ?')
      .run(trusted ? 1 : 0, note, note, publicKey);
    return true;
  }

  setAuthorBlocked(publicKey, blocked, note = '') {
    const existing = this.#db.prepare('SELECT public_key FROM authors WHERE public_key = ?').get(publicKey);
    if (!existing) return false;
    this.#db.prepare('UPDATE authors SET blocked = ?, note = CASE WHEN ? != \'\' THEN ? ELSE note END WHERE public_key = ?')
      .run(blocked ? 1 : 0, note, note, publicKey);
    return true;
  }

  deleteTemplate(templateId, authorPublicKey) {
    const prev = this.#db.prepare(
      'SELECT cover_url FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(templateId, authorPublicKey);
    this.#db.prepare('DELETE FROM installs WHERE template_id = ? AND author_public_key = ?')
      .run(templateId, authorPublicKey);
    this.#db.prepare('DELETE FROM likes WHERE template_id = ? AND author_public_key = ?')
      .run(templateId, authorPublicKey);
    const res = this.#db.prepare('DELETE FROM templates WHERE id = ? AND author_public_key = ?')
      .run(templateId, authorPublicKey);
    const remaining = this.#db.prepare('SELECT COUNT(*) AS cnt FROM templates WHERE author_public_key = ?')
      .get(authorPublicKey);
    if (Number(remaining?.cnt ?? 0) === 0) {
      this.#db.prepare('DELETE FROM authors WHERE public_key = ? AND blocked = 0').run(authorPublicKey);
    }
    return { deleted: res.changes > 0, previousCoverUrl: prev?.cover_url ?? null };
  }

  listPending(now = Date.now()) {
    const since = now - SEVEN_DAYS_MS;
    const rows = this.#db.prepare(`
      SELECT t.*, a.trusted, a.blocked, a.first_seen_at, a.note,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count,
        (SELECT COUNT(*) FROM likes l WHERE l.template_id = t.id AND l.author_public_key = t.author_public_key) AS like_count
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE a.trusted = 0 AND a.blocked = 0
      ORDER BY install_count DESC, t.updated_at DESC
    `).all(since);
    return rows.map(r => ({ ...this.#hydrateRow(r, ''), authorNote: r.note ?? '' }));
  }
}

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
  const aParts = pa.pre.split('.');
  const bParts = pb.pre.split('.');
  const preLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < preLen; i++) {
    const x = aParts[i];
    const y = bParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Lightweight SQLite store for 「Vonvon 灵感 Club」 (`club.vonvon.cc`).
 * Uses Node's built-in `node:sqlite` (zero native npm builds).
 */
export class ClubStore {
  #db;
  #autoTrustKeys;
  #requireAuthorTrust;

  constructor(dbPath, { autoTrustKeys = [], requireAuthorTrust = false } = {}) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#autoTrustKeys = new Set(autoTrustKeys.filter(Boolean));
    this.#requireAuthorTrust = Boolean(requireAuthorTrust);
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
        doc_like_count INTEGER,
        doc_stats_synced_at INTEGER,
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

    const cols = new Set(this.#db.prepare('PRAGMA table_info(templates)').all().map(c => c.name));
    if (!cols.has('doc_like_count')) {
      this.#db.exec('ALTER TABLE templates ADD COLUMN doc_like_count INTEGER');
    }
    if (!cols.has('doc_stats_synced_at')) {
      this.#db.exec('ALTER TABLE templates ADD COLUMN doc_stats_synced_at INTEGER');
    }
    if (!cols.has('withdrawn_at')) {
      this.#db.exec('ALTER TABLE templates ADD COLUMN withdrawn_at INTEGER');
    }

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
    const trusted = !this.#requireAuthorTrust || this.#autoTrustKeys.has(publicKey) ? 1 : 0;
    this.#db.prepare(`
      INSERT INTO authors (public_key, name, trusted, blocked, first_seen_at, note)
      VALUES (?, ?, ?, 0, ?, '')
    `).run(publicKey, authorName, trusted, now);
    return { trusted: Boolean(trusted), blocked: false };
  }

  #upsertTemplate(promo, authorPublicKey, signature, now, { skipIfExists = false } = {}) {
    const existing = this.#db.prepare(
      'SELECT version, cover_url, withdrawn_at FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(promo.id, authorPublicKey);

    if (existing && skipIfExists) {
      return { changed: false, existed: true, withdrawn: Boolean(existing.withdrawn_at), coverUrl: existing.cover_url ?? null };
    }

    const docUrl = promo.docUrl ?? promo.repository ?? '';
    this.#db.prepare(`
      INSERT INTO templates (
        id, author_public_key, version, name, summary, tags_json, skill_names_json,
        doc_url, install_hint, repository, cover_url, author_json, pricing_json,
        acquisition_json, promo_signature, withdrawn_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)
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
        withdrawn_at = NULL,
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
    return {
      changed: true,
      existed: Boolean(existing && !existing.withdrawn_at),
      withdrawn: false,
      coverUrl: existing?.cover_url ?? null,
    };
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
      'SELECT version, withdrawn_at FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(promo.id, authorPublicKey);
    if (existing && !existing.withdrawn_at && compareVersions(promo.version, existing.version) < 0) {
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
   * When a user installs an unsigned GitHub repo whose manifest omits `author.publicKey`
   * (e.g. `modelzen/vonvon-assistant`), attribute the install to the author's published
   * signed card if `id` AND (`docUrl` or `repository`) match, instead of spawning a
   * duplicate unsigned ghost card on the catalog (and respect withdrawn signed cards so
   * installing an old unsigned repo cannot resurrect an author-unpublished listing).
   */
  #findMatchingSignedEntry(promo) {
    const docUrl = promo.docUrl ?? null;
    const repo = promo.repository ?? null;
    if (!docUrl && !repo) return null;
    const rows = this.#db.prepare(`
      SELECT t.author_public_key, t.doc_url, t.repository, t.withdrawn_at
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE t.id = ? AND t.author_public_key NOT LIKE 'unsigned:%' AND a.blocked = 0
      ORDER BY (t.withdrawn_at IS NULL) DESC, a.trusted DESC, t.updated_at DESC
    `).all(promo.id);
    const matched = new Map();
    for (const r of rows) {
      if ((docUrl && r.doc_url && r.doc_url === docUrl) || (repo && r.repository && r.repository === repo)) {
        matched.set(r.author_public_key, { key: r.author_public_key, withdrawn: Boolean(r.withdrawn_at) });
      }
    }
    return matched.size === 1 ? [...matched.values()][0] : null;
  }

  /**
   * Called on `vonvon template stage`: idempotently records deduplicated unique installs.
   * Seeds missing cards for unpublished public packs, but NEVER overwrites an existing card
   * and NEVER resurrects an author-withdrawn (unpublished) listing.
   */
  recordInstall(promo, signature, { sourceKind, anonInstallKey }, now = Date.now()) {
    const matchedSigned = !promo.author.publicKey ? this.#findMatchingSignedEntry(promo) : null;
    if (matchedSigned?.withdrawn) {
      return { ok: true, id: promo.id, authorPublicKey: matchedSigned.key, deduplicated: false, ignored: 'withdrawn', trusted: false };
    }
    const authorPublicKey = promo.author.publicKey
      || matchedSigned?.key
      || `unsigned:${sha256Hex(promo.docUrl ?? promo.repository ?? promo.id).slice(0, 24)}`;
    const author = this.#ensureAuthor(authorPublicKey, promo.author.name, now);
    if (author.blocked) return { ok: false, blocked: true };

    if (!matchedSigned) {
      const upsert = this.#upsertTemplate(promo, authorPublicKey, signature, now, { skipIfExists: true });
      if (upsert.withdrawn) {
        return { ok: true, id: promo.id, authorPublicKey, deduplicated: false, ignored: 'withdrawn', trusted: author.trusted };
      }
    }

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

  #hydrateRow(row) {
    const docLikeCount = row.doc_like_count === null || row.doc_like_count === undefined
      ? null
      : Number(row.doc_like_count);
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
      docLikeCount,
      docStatsSyncedAt: row.doc_stats_synced_at ? Number(row.doc_stats_synced_at) : null,
      trusted: Boolean(row.trusted),
      ...(row.blocked !== undefined ? { blocked: Boolean(row.blocked) } : {}),
      ...(row.withdrawn_at ? { withdrawnAt: Number(row.withdrawn_at) } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  listPublic({ sort = 'hot', q = '', tag = '', author = '', authorPublicKey = '', now = Date.now() } = {}) {
    const since = now - SEVEN_DAYS_MS;
    const rows = this.#db.prepare(`
      SELECT
        t.*,
        a.trusted,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE a.trusted = 1 AND a.blocked = 0 AND t.withdrawn_at IS NULL
    `).all(since);

    let items = rows.map(r => this.#hydrateRow(r));
    const totalTemplates = items.length;
    const totalInstalls = items.reduce((s, item) => s + item.installCount, 0);

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
    const cleanPubKey = authorPublicKey.trim();
    if (cleanPubKey) items = items.filter(item => item.authorPublicKey === cleanPubKey);

    if (sort === 'new') {
      items.sort((a, b) => b.updatedAt - a.updatedAt || b.installCount - a.installCount);
    } else {
      items.sort((a, b) =>
        b.installCount - a.installCount
        || (b.docLikeCount ?? 0) - (a.docLikeCount ?? 0)
        || b.updatedAt - a.updatedAt,
      );
    }

    return {
      stats: { totalTemplates, totalInstalls },
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
            (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count
          FROM templates t JOIN authors a ON a.public_key = t.author_public_key
          WHERE t.id = ? AND t.author_public_key = ? AND a.blocked = 0 AND t.withdrawn_at IS NULL ${trustClause}
        `).all(since, id, authorPublicKey)
      : this.#db.prepare(`
          SELECT t.*, a.trusted,
            (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
            (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count
          FROM templates t JOIN authors a ON a.public_key = t.author_public_key
          WHERE t.id = ? AND a.blocked = 0 AND t.withdrawn_at IS NULL ${trustClause}
          ORDER BY a.trusted DESC, install_count DESC
        `).all(since, id);
    return rows.map(r => this.#hydrateRow(r));
  }

  updateDocStats(templateId, authorPublicKey, { docLikeCount, syncedAt = Date.now() }) {
    if (typeof docLikeCount === 'number' && Number.isSafeInteger(docLikeCount) && docLikeCount >= 0) {
      this.#db.prepare(
        'UPDATE templates SET doc_like_count = ?, doc_stats_synced_at = ? WHERE id = ? AND author_public_key = ?',
      ).run(docLikeCount, syncedAt, templateId, authorPublicKey);
    } else {
      this.#db.prepare(
        'UPDATE templates SET doc_stats_synced_at = ? WHERE id = ? AND author_public_key = ?',
      ).run(syncedAt, templateId, authorPublicKey);
    }
  }

  listFeishuSyncCandidates(staleBeforeMs, limit = 20) {
    return this.#db.prepare(`
      SELECT t.id, t.author_public_key, t.doc_url, t.cover_url, t.doc_stats_synced_at
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE a.trusted = 1 AND a.blocked = 0 AND t.withdrawn_at IS NULL
        AND (t.doc_stats_synced_at IS NULL OR t.doc_stats_synced_at < ?)
      ORDER BY COALESCE(t.doc_stats_synced_at, 0) ASC, t.updated_at DESC
      LIMIT ?
    `).all(staleBeforeMs, limit).map(r => ({
      id: r.id,
      authorPublicKey: r.author_public_key,
      docUrl: r.doc_url,
      coverUrl: r.cover_url ?? null,
    }));
  }

  setCoverUrlIfMissing(templateId, authorPublicKey, coverUrl) {
    const res = this.#db.prepare(
      'UPDATE templates SET cover_url = ? WHERE id = ? AND author_public_key = ? AND cover_url IS NULL AND withdrawn_at IS NULL',
    ).run(coverUrl, templateId, authorPublicKey);
    return res.changes > 0;
  }

  listAllForAdmin(now = Date.now()) {
    const since = now - SEVEN_DAYS_MS;
    const rows = this.#db.prepare(`
      SELECT t.*, a.trusted, a.blocked, a.note,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      ORDER BY t.updated_at DESC
    `).all(since);
    return rows.map(r => ({ ...this.#hydrateRow(r), authorNote: r.note ?? '' }));
  }

  setCoverUrl(templateId, authorPublicKey, coverUrl) {
    const prev = this.#db.prepare(
      'SELECT cover_url FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(templateId, authorPublicKey);
    const res = this.#db.prepare(
      'UPDATE templates SET cover_url = ? WHERE id = ? AND author_public_key = ? AND withdrawn_at IS NULL',
    ).run(coverUrl, templateId, authorPublicKey);
    const previousCoverUrl = prev?.cover_url && prev.cover_url !== coverUrl ? prev.cover_url : null;
    return { updated: res.changes > 0, previousCoverUrl };
  }

  isCoverPublic(coverUrl) {
    return Boolean(this.#db.prepare(`
      SELECT 1 FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE t.cover_url = ? AND a.trusted = 1 AND a.blocked = 0 AND t.withdrawn_at IS NULL
      LIMIT 1
    `).get(coverUrl));
  }

  isCoverReferenced(coverUrl) {
    return Boolean(this.#db.prepare('SELECT 1 FROM templates WHERE cover_url = ? LIMIT 1').get(coverUrl));
  }

  countPendingCovers() {
    const row = this.#db.prepare(`
      SELECT COUNT(DISTINCT t.cover_url) AS cnt
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE t.cover_url IS NOT NULL AND a.trusted = 0 AND a.blocked = 0 AND t.withdrawn_at IS NULL
    `).get();
    return Number(row?.cnt ?? 0);
  }

  clearCoversForAuthor(publicKey) {
    const rows = this.#db.prepare(
      'SELECT DISTINCT cover_url FROM templates WHERE author_public_key = ? AND cover_url IS NOT NULL',
    ).all(publicKey);
    this.#db.prepare('UPDATE templates SET cover_url = NULL WHERE author_public_key = ?').run(publicKey);
    return rows.map(r => r.cover_url).filter(Boolean);
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

  /**
   * Author self-unpublish: persists withdrawal tombstone so subsequent `/api/install` reports from
   * previously distributed `.vonvon.zip` packages can NEVER resurrect a withdrawn listing.
   * Preserves historical install counts; only an explicit author `publish()` clears `withdrawn_at`.
   */
  withdrawTemplate(templateId, authorPublicKey, now = Date.now()) {
    const prev = this.#db.prepare(
      'SELECT cover_url, withdrawn_at FROM templates WHERE id = ? AND author_public_key = ?',
    ).get(templateId, authorPublicKey);
    if (!prev || prev.withdrawn_at) {
      return { deleted: false, previousCoverUrl: null };
    }
    const res = this.#db.prepare(
      'UPDATE templates SET withdrawn_at = ?, cover_url = NULL, updated_at = ? WHERE id = ? AND author_public_key = ? AND withdrawn_at IS NULL',
    ).run(now, now, templateId, authorPublicKey);
    return { deleted: res.changes > 0, previousCoverUrl: prev.cover_url ?? null };
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
      this.#db.prepare('DELETE FROM authors WHERE public_key = ? AND trusted = 0 AND blocked = 0').run(authorPublicKey);
    }
    return { deleted: res.changes > 0, previousCoverUrl: prev?.cover_url ?? null };
  }

  listPending(now = Date.now()) {
    const since = now - SEVEN_DAYS_MS;
    const rows = this.#db.prepare(`
      SELECT t.*, a.trusted, a.blocked, a.first_seen_at, a.note,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key) AS install_count,
        (SELECT COUNT(*) FROM installs i WHERE i.template_id = t.id AND i.author_public_key = t.author_public_key AND i.installed_at >= ?) AS recent_install_count
      FROM templates t
      JOIN authors a ON a.public_key = t.author_public_key
      WHERE a.trusted = 0 AND a.blocked = 0 AND t.withdrawn_at IS NULL
      ORDER BY install_count DESC, t.updated_at DESC
    `).all(since);
    return rows.map(r => ({ ...this.#hydrateRow(r), authorNote: r.note ?? '' }));
  }
}

import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { saveCoverBytes } from './covers.mjs';
import { fetchPublicFeishuDoc } from './feishu-public.mjs';
import { createClubServer } from './server.mjs';
import { ClubStore } from './store.mjs';
import { isFeishuDocUrl } from './validate.mjs';

const port = Number(process.env.CLUB_PORT ?? 8787);
const host = process.env.CLUB_HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.CLUB_DATA_DIR ?? join(process.cwd(), '.club-data'));
const adminToken = (process.env.CLUB_ADMIN_TOKEN ?? '').trim();
const publicBaseUrl = process.env.CLUB_PUBLIC_URL ?? 'https://club.vonvon.cc';
const autoTrustKeys = (process.env.CLUB_AUTO_TRUST_KEYS ?? '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);
const requireAuthorTrust = process.env.CLUB_REQUIRE_AUTHOR_TRUST === '1' || process.env.CLUB_REQUIRE_AUTHOR_TRUST === 'true';
const syncIntervalMs = Math.max(15 * 60 * 1000, Number(process.env.CLUB_FEISHU_SYNC_INTERVAL_MS ?? 6 * 60 * 60 * 1000));
const syncStaleMs = Math.max(15 * 60 * 1000, Number(process.env.CLUB_FEISHU_SYNC_STALE_MS ?? 4 * 60 * 60 * 1000));

const store = new ClubStore(join(dataDir, 'club.sqlite'), { autoTrustKeys, requireAuthorTrust });
const coversDir = join(dataDir, 'covers');
const server = createClubServer({
  store,
  coversDir,
  adminToken,
  publicBaseUrl,
  feishuPublicFetcher: fetchPublicFeishuDoc,
});

let syncing = false;
async function runFeishuStatsSync() {
  if (syncing) return;
  syncing = true;
  try {
    const staleBefore = Date.now() - syncStaleMs;
    const candidates = store.listFeishuSyncCandidates(staleBefore, 20);
    for (const item of candidates) {
      if (!isFeishuDocUrl(item.docUrl)) {
        store.updateDocStats(item.id, item.authorPublicKey, { docLikeCount: undefined });
        continue;
      }
      const needCover = !item.coverUrl;
      const fetched = await fetchPublicFeishuDoc(item.docUrl, { fetchCover: needCover });
      if (fetched.ok) {
        store.updateDocStats(item.id, item.authorPublicKey, { docLikeCount: fetched.docLikeCount });
        if (needCover && fetched.coverBytes) {
          try {
            const saved = await saveCoverBytes(coversDir, fetched.coverBytes);
            const applied = store.setCoverUrlIfMissing(item.id, item.authorPublicKey, saved.url);
            if (!applied && !store.isCoverReferenced(saved.url)) {
              await unlink(join(coversDir, saved.filename)).catch(() => undefined);
            }
          } catch {
            // Keep Plan A preview when cover bytes fail validation
          }
        }
      } else {
        store.updateDocStats(item.id, item.authorPublicKey, { docLikeCount: undefined });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.warn('[vonvon-club] feishu sync error:', err instanceof Error ? err.message : String(err));
  } finally {
    syncing = false;
  }
}

let initialSyncTimer = null;
let periodicSyncTimer = null;

server.listen(port, host, () => {
  console.log(`[vonvon-club] listening on http://${host}:${port} (data: ${dataDir})`);
  if (!adminToken) console.warn('[vonvon-club] CLUB_ADMIN_TOKEN 未设置，管理接口处于关闭状态');
  initialSyncTimer = setTimeout(() => { void runFeishuStatsSync(); }, 10_000);
  initialSyncTimer.unref();
  periodicSyncTimer = setInterval(() => { void runFeishuStatsSync(); }, syncIntervalMs);
  periodicSyncTimer.unref();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (initialSyncTimer) clearTimeout(initialSyncTimer);
    if (periodicSyncTimer) clearInterval(periodicSyncTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

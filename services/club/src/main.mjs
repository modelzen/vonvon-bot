import { join, resolve } from 'node:path';
import { createClubServer } from './server.mjs';
import { ClubStore } from './store.mjs';

const port = Number(process.env.CLUB_PORT ?? 8787);
const host = process.env.CLUB_HOST ?? '127.0.0.1';
const dataDir = resolve(process.env.CLUB_DATA_DIR ?? join(process.cwd(), '.club-data'));
const adminToken = (process.env.CLUB_ADMIN_TOKEN ?? '').trim();
const publicBaseUrl = process.env.CLUB_PUBLIC_URL ?? 'https://club.vonvon.cc';
const autoTrustKeys = (process.env.CLUB_AUTO_TRUST_KEYS ?? '')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

const store = new ClubStore(join(dataDir, 'club.sqlite'), { autoTrustKeys });
const coversDir = join(dataDir, 'covers');
const server = createClubServer({ store, coversDir, adminToken, publicBaseUrl });

server.listen(port, host, () => {
  console.log(`[vonvon-club] listening on http://${host}:${port} (data: ${dataDir})`);
  if (!adminToken) console.warn('[vonvon-club] CLUB_ADMIN_TOKEN 未设置，管理接口处于关闭状态');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

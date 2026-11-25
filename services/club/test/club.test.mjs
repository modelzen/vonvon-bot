import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalPromoBytes } from '../src/crypto.mjs';
import { parsePublicFeishuHtml } from '../src/feishu-public.mjs';
import { createClubServer } from '../src/server.mjs';
import { ClubStore } from '../src/store.mjs';

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VONVON_BIN = join(REPO_ROOT, 'packages/daemon/bin/vonvon.mjs');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Minimal valid 1x1 PNG bytes for cover upload validation.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
  'hex',
);

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(ED25519_SPKI_PREFIX.length);
  return {
    publicKey: rawPub.toString('base64url'),
    sign(promo) {
      return cryptoSign(null, canonicalPromoBytes(promo), privateKey).toString('base64url');
    },
    signCover(templateId, version, docUrl, coverBytes) {
      const hash = createHash('sha256').update(coverBytes).digest('hex');
      const msg = Buffer.from(`vonvon-template-cover/1\n${templateId}\n${version}\n${docUrl}\n${rawPub.toString('base64url')}\n${hash}`, 'utf8');
      return cryptoSign(null, msg, privateKey).toString('base64url');
    },
    signUnpublish(templateId, timestamp) {
      const msg = Buffer.from(`vonvon-template-unpublish/1\n${templateId}\n${rawPub.toString('base64url')}\n${timestamp}`, 'utf8');
      return cryptoSign(null, msg, privateKey).toString('base64url');
    },
  };
}

describe('Vonvon 灵感 Club server + vonvon CLI E2E', () => {
  const adminToken = 'test-club-admin-secret-token';
  let workDir;
  let store;
  let server;
  let baseUrl;

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'vonvon-club-test-'));
    store = new ClubStore(join(workDir, 'club.sqlite'));
    server = createClubServer({
      store,
      coversDir: join(workDir, 'covers'),
      adminToken,
      publicBaseUrl: 'https://club.vonvon.cc',
      coverFetcher: async (docUrl, coversDir) => {
        if (docUrl.includes('no-cover')) return { ok: false, reason: 'no_cover' };
        const { saveCoverBytes } = await import('../src/covers.mjs');
        const saved = await saveCoverBytes(coversDir, TINY_PNG);
        return { ok: true, ...saved };
      },
      feishuPublicFetcher: async (docUrl, { fetchCover }) => {
        if (docUrl.includes('AFKNdf4QaooL5OxSR8bc5H7vn7b')) {
          return { ok: true, docLikeCount: 7, ...(fetchCover ? { coverBytes: TINY_PNG } : {}) };
        }
        return { ok: false, reason: 'not_found' };
      },
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise(resolveClose => server.close(resolveClose));
    store.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('serves static frontend HTML/CSS/JS with security headers, weak/list ETag 304, HEAD, and robots.txt', async () => {
    for (const [path, ct] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'application/javascript']]) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', new RegExp(ct));
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      const etag = res.headers.get('etag');
      assert.ok(etag, path);
      const res304 = await fetch(`${baseUrl}${path}`, { headers: { 'if-none-match': `W/${etag}` } });
      assert.equal(res304.status, 304, path);
      const resList304 = await fetch(`${baseUrl}${path}`, { headers: { 'if-none-match': `"other", ${etag}` } });
      assert.equal(resList304.status, 304, path);
      const headRes = await fetch(`${baseUrl}${path}`, { method: 'HEAD' });
      assert.equal(headRes.status, 200, `HEAD ${path}`);
      assert.equal((await headRes.text()).length, 0);
    }
    const robots = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(await robots.text(), /Disallow: \/api\/admin\//);
    const logo = await fetch(`${baseUrl}/logo-224.webp`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/webp');
    const favicon = await fetch(`${baseUrl}/favicon-32.png`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/png');
    const skillDoc = await fetch(`${baseUrl}/skills/vonvon-template-creator/SKILL.md`);
    assert.equal(skillDoc.status, 200);
    assert.match(skillDoc.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(await skillDoc.text(), /name: vonvon-template-creator/);
    const schemaDoc = await fetch(`${baseUrl}/skills/vonvon-template-creator/references/manifest-schema.md`);
    assert.equal(schemaDoc.status, 200);
    assert.match(schemaDoc.headers.get('content-type') ?? '', /text\/markdown/);
  });

  it('runs real CLI pack --publish -> instant public listing -> multi-user stage dedup -> like -> cover -> delete', async () => {
    const creatorHome = join(workDir, 'creator-home');
    const userAHome = join(workDir, 'user-a-home');
    const userBHome = join(workDir, 'user-b-home');
    const draftDir = join(workDir, 'draft');
    const outZip = join(workDir, 'daily.vonvon.zip');
    const groupA = join(workDir, 'group-a');
    const groupB = join(workDir, 'group-b');

    await mkdir(join(draftDir, 'skills/daily-setup'), { recursive: true });
    await mkdir(join(draftDir, 'workspace'), { recursive: true });
    await writeFile(join(draftDir, 'vonvon-bot.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'modelzen/daily-brief',
      version: '0.1.0',
      public: true,
      name: '行业日报助手',
      summary: '每天定时抓取核心动态并输出飞书简报。',
      tags: ['日报', '效率'],
      docUrl: 'https://my.feishu.cn/docx/AFKNdf4QaooL5OxSR8bc5H7vn7b',
      installHint: '帮我照这个配方建群：https://github.com/modelzen/vonvon-assistant',
      author: { name: 'Clay Zhang', contact: '飞书灵感研究所' },
      group: { role: '你是专业行业情报助手。' },
    }));
    await writeFile(join(draftDir, 'skills/daily-setup/SKILL.md'), '---\nname: daily-setup\ndescription: 初始化\n---\nPRIVATE_SKILL_SECRET');
    await writeFile(join(draftDir, 'workspace/AGENTS.md'), '# Rules');

    // 1. Real CLI pack --publish sends signed promo -> auto-published immediately (zero pre-moderation).
    const packRun = await execFileAsync(process.execPath, [
      VONVON_BIN, 'template', 'pack', draftDir, '--out', outZip, '--publish', '--json',
    ], {
      env: { ...process.env, VONVON_HOME: creatorHome, VONVON_CLUB_API_URL: baseUrl, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' },
    });
    const packed = JSON.parse(packRun.stdout);
    assert.equal(packed.ok, true);
    assert.equal(packed.publish.ok, true);
    assert.equal(packed.publish.status, 'published');

    // Admin endpoint still enforces Bearer auth.
    const unauth = await fetch(`${baseUrl}/api/admin/pending`);
    assert.equal(unauth.status, 401);

    // 2. Immediately visible on public list and detail endpoint with 0 installs.
    const listAfterPublish = await (await fetch(`${baseUrl}/api/list`)).json();
    assert.equal(listAfterPublish.items.length, 1);
    assert.equal(listAfterPublish.items[0].installCount, 0);
    const detailAfterPublish = await fetch(`${baseUrl}/api/templates/${encodeURIComponent('modelzen/daily-brief')}`);
    assert.equal(detailAfterPublish.status, 200);

    // 3. User A installs via real CLI `vonvon template stage` -> installCount becomes 1.
    const stageA1 = await execFileAsync(process.execPath, [
      VONVON_BIN, 'template', 'stage', outZip, '--dest', groupA, '--mode', 'fresh', '--json',
    ], {
      env: { ...process.env, VONVON_HOME: userAHome, VONVON_CLUB_API_URL: baseUrl, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' },
    });
    assert.equal(JSON.parse(stageA1.stdout).telemetry.ok, true);

    // User A re-runs merge upgrade -> deduplicated, installCount stays 1.
    await execFileAsync(process.execPath, [
      VONVON_BIN, 'template', 'stage', outZip, '--dest', groupA, '--mode', 'merge', '--update-skills', '--json',
    ], {
      env: { ...process.env, VONVON_HOME: userAHome, VONVON_CLUB_API_URL: baseUrl, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' },
    });

    // User B installs on another VONVON_HOME -> installCount becomes 2.
    await execFileAsync(process.execPath, [
      VONVON_BIN, 'template', 'stage', outZip, '--dest', groupB, '--mode', 'fresh', '--json',
    ], {
      env: { ...process.env, VONVON_HOME: userBHome, VONVON_CLUB_API_URL: baseUrl, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' },
    });

    const listAfterInstalls = await (await fetch(`${baseUrl}/api/list`)).json();
    assert.equal(listAfterInstalls.items[0].installCount, 2);
    assert.equal(listAfterInstalls.items[0].docLikeCount, 7);
    assert.match(listAfterInstalls.items[0].coverUrl ?? '', /^\/covers\/[a-f0-9]+\.png$/);
    assert.equal(listAfterInstalls.stats.totalInstalls, 2);

    // On-demand click-return refresh respects per-doc cooldown cache and rejects missing items.
    const refCached = await (await fetch(`${baseUrl}/api/refresh-doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'modelzen/daily-brief', authorPublicKey: packed.authorPublicKey }),
    })).json();
    assert.equal(refCached.ok, true);
    assert.equal(refCached.docLikeCount, 7);
    assert.equal(refCached.cached, true);
    assert.equal((await fetch(`${baseUrl}/api/refresh-doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nonexistent', authorPublicKey: packed.authorPublicKey }),
    })).status, 404);

    // 4. Site /api/like endpoint is removed (405/404) and public Feishu HTML parser extracts stats + cover URL.
    const removedLike = await fetch(`${baseUrl}/api/like`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'modelzen/daily-brief', authorPublicKey: packed.authorPublicKey }),
    });
    assert.equal(removedLike.status, 405);
    const parsedHtml = parsePublicFeishuHtml(
      `%22like_count%22%3A12%2C%22pv%22%3A45%2C%22uv%22%3A9%7D window.SERVER_DATA = Object({"meta":{"token":"DocTok1234567890"}}) "cover":{"token":"CovTok1234567890"}`,
      'https://my.feishu.cn/wiki/Abc',
    );
    assert.equal(parsedHtml.docLikeCount, 12);
    assert.equal(parsedHtml.docPv, 45);
    assert.equal(parsedHtml.docUv, 9);
    assert.equal(parsedHtml.coverUrls.length, 1);
    assert.match(parsedHtml.coverUrls[0], /CovTok1234567890/);

    // 5. Creator lists own published templates via CLI (`vonvon template published`) without needing to remember IDs.
    const pubListRun = await execFileAsync(process.execPath, [
      VONVON_BIN, 'template', 'published', '--json',
    ], {
      env: { ...process.env, VONVON_HOME: creatorHome, VONVON_CLUB_API_URL: baseUrl, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' },
    });
    const pubList = JSON.parse(pubListRun.stdout);
    assert.equal(pubList.ok, true);
    assert.equal(pubList.items.length, 1);
    assert.equal(pubList.items[0].id, 'modelzen/daily-brief');
    assert.equal(pubList.items[0].docLikeCount, 7);

    // Another user cannot unpublish creator's template (forged / wrong key -> 403 or 404).
    const otherKey = makeKeypair();
    const nowTs = Date.now();
    assert.equal((await fetch(`${baseUrl}/api/unpublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'modelzen/daily-brief',
        authorPublicKey: packed.authorPublicKey,
        timestamp: nowTs,
        signature: otherKey.signUnpublish('modelzen/daily-brief', nowTs),
      }),
    })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/unpublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'modelzen/daily-brief',
        authorPublicKey: otherKey.publicKey,
        timestamp: nowTs,
        signature: otherKey.signUnpublish('modelzen/daily-brief', nowTs),
      }),
    })).status, 404);

    // Admin templates list sees full listing.
    const adminList = await (await fetch(`${baseUrl}/api/admin/templates`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })).json();
    assert.equal(adminList.ok, true);
    assert.equal(adminList.items.length, 1);

    // 6. Admin cover validation rejects fake SVG bytes and accepts real PNG / stubbed Feishu cover fetch.
    const badCover = await fetch(`${baseUrl}/api/admin/cover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: 'modelzen/daily-brief',
        authorPublicKey: packed.authorPublicKey,
        imageBase64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
      }),
    });
    assert.equal(badCover.status, 400);

    const goodCover = await (await fetch(`${baseUrl}/api/admin/cover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        id: 'modelzen/daily-brief',
        authorPublicKey: packed.authorPublicKey,
        fetchFeishuCover: true,
      }),
    })).json();
    assert.equal(goodCover.ok, true);
    assert.match(goodCover.coverUrl, /^\/covers\/[a-f0-9]+\.png$/);

    const imgRes = await fetch(`${baseUrl}${goodCover.coverUrl}`);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get('content-type'), 'image/png');

    // 7. Creator self-unpublishes via real CLI `vonvon template unpublish <id> --json`.
    const unpubRun = await execFileAsync(process.execPath, [
      VONVON_BIN, 'template', 'unpublish', 'modelzen/daily-brief', '--json',
    ], {
      env: { ...process.env, VONVON_HOME: creatorHome, VONVON_CLUB_API_URL: baseUrl, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '' },
    });
    const unpub = JSON.parse(unpubRun.stdout);
    assert.equal(unpub.ok, true);
    assert.equal(unpub.deleted, true);
    const listAfterUnpub = await (await fetch(`${baseUrl}/api/list`)).json();
    assert.equal(listAfterUnpub.items.length, 0);
    assert.equal((await fetch(`${baseUrl}${goodCover.coverUrl}`)).status, 404);
  });

  it('rejects tampered signatures, non-https URLs, and isolates hijacked same-id packages by authorPublicKey', async () => {
    const legKey = makeKeypair();
    const evilKey = makeKeypair();

    const basePromo = {
      schemaVersion: 1,
      public: true,
      id: 'star/top-template',
      version: '1.0.0',
      name: '原版爆款',
      summary: '正版简介',
      tags: ['热门'],
      skillNames: ['s1'],
      docUrl: 'https://my.feishu.cn/docx/original',
      author: { name: '原作者', publicKey: legKey.publicKey },
      pricing: { kind: 'free' },
      acquisition: ['local'],
    };
    const legSig = legKey.sign(basePromo);

    // Missing `public: true` publication grant -> 400 on both /api/publish and /api/install.
    const { public: _dropPub, ...withoutPublic } = basePromo;
    assert.equal((await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promo: withoutPublic, signature: legKey.sign(withoutPublic) }),
    })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        promo: withoutPublic,
        signature: legKey.sign(withoutPublic),
        sourceKind: 'zip',
        anonInstallKey: 'a'.repeat(64),
      }),
    })).status, 400);

    // Publish v1.0.0 with signed cover -> immediately published & cover immediately 200 under default auto-approve mode.
    const firstPub = await (await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        promo: basePromo,
        signature: legSig,
        coverBase64: TINY_PNG.toString('base64'),
        coverSignature: legKey.signCover(basePromo.id, basePromo.version, basePromo.docUrl, TINY_PNG),
      }),
    })).json();
    assert.equal(firstPub.ok, true);
    assert.equal(firstPub.status, 'published');
    assert.match(firstPub.coverUrl, /^\/covers\/[a-f0-9]+\.png$/);
    assert.equal((await fetch(`${baseUrl}${firstPub.coverUrl}`)).status, 200, 'first card cover should be immediately public');
    const v2Promo = { ...basePromo, version: '2.0.0', name: '原版爆款 v2' };
    // Forged cover signature on publish is silently ignored; valid author-signed cover (bound to version & docUrl) is stored.
    const forgedCoverRes = await (await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        promo: v2Promo,
        signature: legKey.sign(v2Promo),
        coverBase64: TINY_PNG.toString('base64'),
        coverSignature: evilKey.signCover(v2Promo.id, v2Promo.version, v2Promo.docUrl, TINY_PNG),
      }),
    })).json();
    assert.equal(forgedCoverRes.ok, true);
    assert.equal(forgedCoverRes.coverUrl, undefined);

    // Version downgrade via stale v1.0.0 signature on /api/publish -> 409 Conflict.
    assert.equal((await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promo: basePromo, signature: legSig }),
    })).status, 409);

    const validCoverRes = await (await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        promo: v2Promo,
        signature: legKey.sign(v2Promo),
        coverBase64: TINY_PNG.toString('base64'),
        coverSignature: legKey.signCover(v2Promo.id, v2Promo.version, v2Promo.docUrl, TINY_PNG),
      }),
    })).json();
    assert.equal(validCoverRes.ok, true);
    assert.match(validCoverRes.coverUrl, /^\/covers\/[a-f0-9]+\.png$/);
    assert.equal((await fetch(`${baseUrl}${validCoverRes.coverUrl}`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        promo: basePromo,
        signature: legSig,
        sourceKind: 'zip',
        anonInstallKey: 'b'.repeat(64),
      }),
    })).status, 200);
    const afterStaleInstall = await (await fetch(`${baseUrl}/api/list?q=star/top-template`)).json();
    assert.equal(afterStaleInstall.items[0].version, '2.0.0');
    assert.equal(afterStaleInstall.items[0].name, '原版爆款 v2');
    assert.equal(afterStaleInstall.items[0].installCount, 1);

    // Tampered docUrl with original signature -> 403.
    const tampered = { ...basePromo, docUrl: 'https://evil.example/phish' };
    assert.equal((await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promo: tampered, signature: legSig }),
    })).status, 403);

    // Non-https URL -> 400.
    const jsUrl = { ...basePromo, docUrl: 'javascript:alert(1)' };
    assert.equal((await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promo: jsUrl, signature: legKey.sign(jsUrl) }),
    })).status, 400);

    // Attacker keeps identical id `star/top-template` but signs with evilKey -> isolated by authorPublicKey, never overwrites original!
    const hijackPromo = {
      ...basePromo,
      docUrl: 'https://evil.example/steal',
      author: { name: '盗版者', publicKey: evilKey.publicKey },
      pricing: { kind: 'external', displayPrice: '¥1', url: 'https://evil.example/pay' },
    };
    assert.equal((await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promo: hijackPromo, signature: evilKey.sign(hijackPromo) }),
    })).status, 200);

    const list = await (await fetch(`${baseUrl}/api/list?q=star/top-template`)).json();
    assert.equal(list.items.length, 2);
    const original = list.items.find(item => item.authorPublicKey === legKey.publicKey);
    assert.ok(original);
    assert.equal(original.docUrl, 'https://my.feishu.cn/docx/original');
    assert.equal(original.version, '2.0.0');

    // Blocking an author removes their cards immediately, hides their cover (404), and rejects subsequent publishes.
    assert.equal((await fetch(`${baseUrl}/api/admin/authors/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ publicKey: legKey.publicKey, blocked: true }),
    })).status, 200);
    assert.equal((await fetch(`${baseUrl}${validCoverRes.coverUrl}`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/admin/authors/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ publicKey: evilKey.publicKey, blocked: true }),
    })).status, 200);
    const listAfterBlock = await (await fetch(`${baseUrl}/api/list?q=star/top-template`)).json();
    assert.equal(listAfterBlock.items.length, 0);
    assert.equal((await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ promo: basePromo, signature: legSig }),
    })).status, 403);
  });

  it('supports optional strict requireAuthorTrust mode when enabled via config', async () => {
    const strictDir = await mkdtemp(join(tmpdir(), 'vonvon-club-strict-'));
    const strictStore = new ClubStore(join(strictDir, 'club.sqlite'), { requireAuthorTrust: true });
    const strictServer = createClubServer({
      store: strictStore,
      coversDir: join(strictDir, 'covers'),
      adminToken,
      publicBaseUrl: 'https://club.vonvon.cc',
    });
    await new Promise(resolveListen => strictServer.listen(0, '127.0.0.1', resolveListen));
    const strictUrl = `http://127.0.0.1:${strictServer.address().port}`;
    try {
      const k = makeKeypair();
      const promo = {
        schemaVersion: 1, public: true, id: 'strict/demo', version: '0.1.0', name: '严格模式', summary: '需首次信任',
        tags: [], skillNames: ['s1'], docUrl: 'https://my.feishu.cn/docx/strict',
        author: { name: '新作者', publicKey: k.publicKey }, pricing: { kind: 'free' }, acquisition: ['local'],
      };
      const pub = await (await fetch(`${strictUrl}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          promo, signature: k.sign(promo),
          coverBase64: TINY_PNG.toString('base64'),
          coverSignature: k.signCover(promo.id, promo.version, promo.docUrl, TINY_PNG),
        }),
      })).json();
      assert.equal(pub.status, 'pending_author_trust');
      assert.equal((await fetch(`${strictUrl}${pub.coverUrl}`)).status, 404);
      assert.equal((await (await fetch(`${strictUrl}/api/list`)).json()).items.length, 0);

      await fetch(`${strictUrl}/api/admin/authors/trust`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ publicKey: k.publicKey, trusted: true }),
      });
      assert.equal((await fetch(`${strictUrl}${pub.coverUrl}`)).status, 200);
      assert.equal((await (await fetch(`${strictUrl}/api/list`)).json()).items.length, 1);
    } finally {
      await new Promise(resolveClose => strictServer.close(resolveClose));
      strictStore.close();
      await rm(strictDir, { recursive: true, force: true });
    }
  });
});

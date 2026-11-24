import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTemplateSessionAllowed } from '../src/cli/commands/template';
import { SESSION_BOT_ENV, SESSION_ENV, SESSION_SCOPE_ENV } from '../src/config/session-env';
import { DEVICES_DIR } from '../src/remote/files';
import { authorKeyPath, loadOrCreateAuthorKey, signPromoPayload, verifyPromoPayload } from '../src/template/author-key';
import { extractTemplate, inspectTemplate, INSTALLED_META_FILENAME, packTemplate, PackRedactionError, stageTemplate } from '../src/template/ops';
import { scanFilesForSecrets } from '../src/template/redact';
import { buildPublicPromoPayload, installedTemplatesFileSchema, templateManifestSchema } from '../src/template/schema';
import { createZip, normalizeZipPath, readZip } from '../src/template/zip';

const temps: string[] = [];
async function makeTempDir(prefix = 'vonvon-tpl-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
}

describe('template zip codec', () => {
  it('round-trips UTF-8 Chinese paths and nested files with flag bit 11 set', () => {
    const archive = createZip([
      { path: 'vonvon-bot.json', data: Buffer.from('{"schemaVersion":1}') },
      { path: 'workspace/知识库/竞品说明.md', data: Buffer.from('中文内容测试\n'.repeat(200), 'utf8') },
      { path: 'skills/daily-setup/SKILL.md', data: Buffer.from('---\nname: daily-setup\n---\n引导', 'utf8') },
    ]);
    // Local header general-purpose bit flag must include UTF-8 bit 11 (0x0800).
    expect(archive.readUInt16LE(6) & 0x0800).toBe(0x0800);
    const entries = readZip(archive);
    expect(entries.map(e => e.path)).toEqual([
      'skills/daily-setup/SKILL.md',
      'vonvon-bot.json',
      'workspace/知识库/竞品说明.md',
    ]);
    expect(entries[2]!.data.toString('utf8')).toBe('中文内容测试\n'.repeat(200));
  });

  it('rejects path traversal, absolute paths, CRC corruption, zip bombs and symlinks', () => {
    expect(() => normalizeZipPath('../evil.txt')).toThrow(/越界/);
    expect(() => normalizeZipPath('/etc/passwd')).toThrow(/绝对路径/);
    expect(() => normalizeZipPath('C:\\Windows\\system.ini')).toThrow(/绝对路径/);

    // Craft a zip and corrupt one payload byte to trigger CRC check.
    const clean = createZip([{ path: 'a.txt', data: Buffer.from('hello world') }]);
    const corrupted = Buffer.from(clean);
    corrupted[30 + 5]! ^= 0xff;
    expect(() => readZip(corrupted)).toThrow(/校验和|解压失败/);

    // Zip bomb / uncompressed limit enforcement.
    const big = createZip([{ path: 'big.txt', data: Buffer.alloc(64 * 1024, 'A') }]);
    expect(() => readZip(big, { maxUncompressedBytes: 1024 })).toThrow(/上限/);

    // File count limit enforcement.
    const many = createZip([
      { path: '1.txt', data: Buffer.from('1') },
      { path: '2.txt', data: Buffer.from('2') },
      { path: '3.txt', data: Buffer.from('3') },
    ]);
    expect(() => readZip(many, { maxFiles: 2 })).toThrow(/文件数超过上限/);

    // Mark entry as Unix symlink in central directory external attributes and verify rejection.
    const withSymlink = Buffer.from(createZip([{ path: 'link.txt', data: Buffer.from('/etc/passwd') }]));
    const cdSigPos = withSymlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(cdSigPos).toBeGreaterThan(0);
    withSymlink.writeUInt32LE((0o120777 << 16) >>> 0, cdSigPos + 38);
    expect(() => readZip(withSymlink)).toThrow(/符号链接/);

    // Reject Windows reserved device names, alternate data streams, trailing dots, case collisions, and conflicting local headers.
    expect(() => normalizeZipPath('workspace/CON.txt')).toThrow(/不兼容跨平台/);
    expect(() => normalizeZipPath('workspace/file.txt:stream')).toThrow(/不兼容跨平台/);
    expect(() => normalizeZipPath('workspace/dir./a.txt')).toThrow(/不兼容跨平台/);
    expect(() => createZip([
      { path: 'workspace/Readme.md', data: Buffer.from('a') },
      { path: 'workspace/readme.md', data: Buffer.from('b') },
    ])).toThrow(/大小写冲突/);

    const mismatch = Buffer.from(createZip([{ path: 'a.txt', data: Buffer.from('hello world') }]));
    mismatch.writeUInt32LE(0x12345678, 14); // tamper local header CRC while central header stays intact
    expect(() => readZip(mismatch)).toThrow(/本地文件头元数据不一致/);
  });
});

describe('template redaction scanner', () => {
  it('blocks private Vonvon files, config.json, quoted JSON secrets, UTF-16 leaks, Feishu IDs, and local user paths while allowing placeholders', () => {
    const utf16Secret = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('token=sk-ant-1234567890abcdefghijklmnop\n', 'utf16le'),
    ]);
    const blocked = scanFilesForSecrets([
      { path: 'workspace/memory.json', data: Buffer.from('{}') },
      { path: 'workspace/config.json', data: Buffer.from('{}') },
      { path: 'workspace/app.json', data: Buffer.from('{"app_secret": "AbCdEfGhIjKlMnOpQrStUvWx"}') },
      { path: 'workspace/utf16.txt', data: utf16Secret },
      { path: 'workspace/notes.md', data: Buffer.from('key=sk-ant-1234567890abcdefghijklmnop\nchat=oc_abcdef1234567890\npath=/Users/clay/secret\n') },
      { path: 'workspace/win.md', data: Buffer.from('dir=C:\\Users\\realuser\\docs\\a.txt') },
    ]);
    const rules = new Set(blocked.map(f => f.rule));
    expect(rules.has('forbidden-file')).toBe(true);
    expect(rules.has('feishu-app-secret')).toBe(true);
    expect(rules.has('openai-anthropic-key')).toBe(true);
    expect(rules.has('feishu-private-id')).toBe(true);
    expect(rules.has('unix-home-path')).toBe(true);
    expect(rules.has('windows-home-path')).toBe(true);
    expect(blocked.some(f => f.file === 'workspace/config.json' && f.rule === 'forbidden-file')).toBe(true);
    expect(blocked.some(f => f.file === 'workspace/utf16.txt' && f.rule === 'openai-anthropic-key')).toBe(true);

    const safe = scanFilesForSecrets([
      { path: 'README.md', data: Buffer.from('示例群 ID 为 oc_xxx，路径示例 /Users/username/project 或 C:\\Users\\example\\docs') },
    ]);
    expect(safe).toEqual([]);
  });
});

describe('author Ed25519 signing and devices/ directory isolation', () => {
  it('stores 0600 author-key.json inside 0700 devices/, creates once, and detects promo tampering', async () => {
    const dataRoot = await makeTempDir('vonvon-data-');
    const first = await loadOrCreateAuthorKey(dataRoot);
    const second = await loadOrCreateAuthorKey(dataRoot);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
    expect(authorKeyPath(dataRoot)).toBe(join(dataRoot, DEVICES_DIR, 'author-key.json'));
    if (process.platform !== 'win32') {
      const dirMode = (await stat(join(dataRoot, DEVICES_DIR))).mode & 0o777;
      const fileMode = (await stat(authorKeyPath(dataRoot))).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    const manifest = templateManifestSchema.parse({
      schemaVersion: 1,
      id: 'modelzen/demo',
      version: '1.0.0',
      public: true,
      name: '示例配方',
      summary: '用于验证签名',
      docUrl: 'https://my.feishu.cn/docx/demo123',
      author: { name: 'modelzen', publicKey: first.publicKey },
    });
    const promo = buildPublicPromoPayload(manifest, ['demo-setup']);
    expect(promo.public).toBe(true);
    const sig = signPromoPayload(promo, first.privateKeyPem);
    expect(verifyPromoPayload(promo, sig)).toBe(true);

    // Tampering with docUrl invalidates the signature.
    const tampered = { ...promo, docUrl: 'https://evil.example/hijack' };
    expect(verifyPromoPayload(tampered, sig)).toBe(false);
  });
});

describe('template pack, inspect, extract, stage and telemetry', () => {
  it('packs with signature, publishes only public promo metadata, stages dual-provider skills and reports install', async () => {
    const dataRoot = await makeTempDir('vonvon-home-');
    const srcDir = await makeTempDir('vonvon-src-');
    const outZip = join(await makeTempDir('vonvon-out-'), 'daily.vonvon.zip');
    const destDir = await makeTempDir('vonvon-dest-');

    await writeTree(srcDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1,
        id: 'modelzen/daily-brief',
        version: '0.1.0',
        public: true,
        name: '每日简报助手',
        summary: '每天整理行业动态',
        docUrl: 'https://my.feishu.cn/docx/publicdoc1',
        author: { name: 'modelzen', contact: '小红书 @modelzen' },
        group: {
          defaultName: '行业简报',
          role: '你负责每天输出简洁客观的行业简报。',
          recommendedPermission: 'write',
          firstMessage: '开始初始化',
          schedules: [{ name: '早报', when: { kind: 'daily', time: '09:00' }, prompt: '生成早报' }],
        },
      }),
      'README.md': '# 每日简报助手\n\nVonvon 配方：modelzen/daily-brief',
      'skills/brief-setup/SKILL.md': '---\nname: brief-setup\ndescription: 初始化简报配置\n---\nSECRET_SKILL_BODY_NEVER_UPLOADED',
      'workspace/AGENTS.md': '# 群规则\nSECRET_WORKSPACE_TEXT_NEVER_UPLOADED',
      'workspace/docs/指南.md': '知识文档内容',
    });

    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(JSON.stringify({ status: 'published', url: 'https://club.vonvon.cc/' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    const packed = await packTemplate(srcDir, outZip, {
      publish: true, dataRoot, baseUrl: 'https://club.test', fetchImpl: mockFetch,
    });
    expect(packed.public).toBe(true);
    expect(packed.skillNames).toEqual(['brief-setup']);
    expect(packed.workspaceFileCount).toBe(2);
    expect(packed.publish).toMatchObject({ attempted: true, ok: true, status: 'published' });

    // Publish payload must NOT leak any skill body, role prompt, or workspace file content.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://club.test/api/publish');
    const serializedPublish = JSON.stringify(requests[0]!.body);
    expect(serializedPublish).not.toContain('SECRET_SKILL_BODY_NEVER_UPLOADED');
    expect(serializedPublish).not.toContain('SECRET_WORKSPACE_TEXT_NEVER_UPLOADED');
    expect(serializedPublish).not.toContain('你负责每天输出');
    expect(serializedPublish).toContain('https://my.feishu.cn/docx/publicdoc1');

    // Inspect validates signature and detects setup skill.
    const inspected = await inspectTemplate(outZip);
    expect(inspected.signatureStatus).toBe('valid');
    expect(inspected.hasEffectiveCapability).toBe(true);
    expect(inspected.skills).toEqual([{ name: 'brief-setup', setup: true, files: 1 }]);
    expect(inspected.workspaceFiles).toEqual(['AGENTS.md', 'docs/指南.md']);

    // Stage fresh installs workspace files + dual-provider skills + .vonvon-template.json + telemetry.
    const staged = await stageTemplate(outZip, destDir, {
      mode: 'fresh', dataRoot, baseUrl: 'https://club.test', fetchImpl: mockFetch, env: {},
    });
    expect(staged.addedSkills).toEqual(['brief-setup']);
    expect(staged.writtenWorkspaceFiles).toEqual(['AGENTS.md', 'docs/指南.md']);
    expect(staged.telemetry).toEqual({ attempted: true, ok: true });
    expect(await readFile(join(destDir, '.agents/skills/brief-setup/SKILL.md'), 'utf8')).toContain('brief-setup');
    expect(await readFile(join(destDir, '.claude/skills/brief-setup/SKILL.md'), 'utf8')).toContain('brief-setup');
    expect(await readFile(join(destDir, 'docs/指南.md'), 'utf8')).toBe('知识文档内容');
    const meta = installedTemplatesFileSchema.parse(JSON.parse(await readFile(join(destDir, INSTALLED_META_FILENAME), 'utf8')));
    expect(meta.templates).toHaveLength(1);
    expect(meta.templates[0]!).toMatchObject({ id: 'modelzen/daily-brief', version: '0.1.0', skills: ['brief-setup'] });

    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe('https://club.test/api/install');
    expect(typeof requests[1]!.body.anonInstallKey).toBe('string');

    // Fresh mode refuses non-empty target directory.
    await expect(stageTemplate(outZip, destDir, { mode: 'fresh', dataRoot, noTelemetry: true })).rejects.toThrow(/非空/);

    // Merge mode preserves modified workspace files & reports conflicting skills unless --update-skills is set.
    await writeFile(join(destDir, 'AGENTS.md'), '# 用户自定义规则');
    await writeFile(join(destDir, '.agents/skills/brief-setup/SKILL.md'), '---\nname: brief-setup\n---\nOLD_LOCAL_EDIT');
    const merged = await stageTemplate(outZip, destDir, { mode: 'merge', dataRoot, noTelemetry: true });
    expect(merged.conflictingWorkspaceFiles).toEqual(['AGENTS.md']);
    expect(merged.conflictingSkills).toEqual(['brief-setup']);
    expect(await readFile(join(destDir, 'AGENTS.md'), 'utf8')).toBe('# 用户自定义规则');

    // Upgrade with updateSkills overwrites skill cleanly while still leaving user's AGENTS.md untouched.
    const upgraded = await stageTemplate(outZip, destDir, { mode: 'merge', updateSkills: true, dataRoot, noTelemetry: true });
    expect(upgraded.updatedSkills).toEqual(['brief-setup']);
    expect(await readFile(join(destDir, '.agents/skills/brief-setup/SKILL.md'), 'utf8')).toContain('SECRET_SKILL_BODY_NEVER_UPLOADED');
    expect(await readFile(join(destDir, 'AGENTS.md'), 'utf8')).toBe('# 用户自定义规则');

    // Extract into clean temp directory succeeds.
    const extractedDir = await makeTempDir('vonvon-extract-');
    const extracted = await extractTemplate(outZip, extractedDir);
    expect(extracted.filesWritten).toBeGreaterThanOrEqual(4);
    expect(await readFile(extracted.manifestPath, 'utf8')).toContain('modelzen/daily-brief');
  });

  it('defaults omitted public to false, suppresses telemetry on private or VONVON_NO_TELEMETRY=1, and never fails stage on network errors', async () => {
    const dataRoot = await makeTempDir('vonvon-home-');
    const srcDir = await makeTempDir('vonvon-private-');
    const outZip = join(await makeTempDir('vonvon-out-'), 'internal.vonvon.zip');

    await writeTree(srcDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1,
        id: 'acme/internal-audit',
        version: '1.0.0',
        name: '内部财务审核',
        summary: '仅公司内部使用',
        author: { name: 'acme' },
        group: { role: '只审内部报销单' },
      }),
    });

    await expect(packTemplate(srcDir, outZip, { publish: true, dataRoot })).rejects.toThrow(/public=false/);
    const packed = await packTemplate(srcDir, outZip, { dataRoot });
    expect(packed.public).toBe(false);
    // Private packs must never carry a publication promoSignature.
    const privateInspect = await inspectTemplate(outZip);
    expect(privateInspect.signatureStatus).toBe('unsigned');

    let fetchCalls = 0;
    const failingFetch: typeof fetch = async () => {
      fetchCalls++;
      throw new Error('offline');
    };

    const dest1 = await makeTempDir('vonvon-d1-');
    const res1 = await stageTemplate(outZip, dest1, { dataRoot, fetchImpl: failingFetch, env: {} });
    expect(res1.telemetry).toEqual({ attempted: false, ok: false, reason: 'not_public' });
    expect(fetchCalls).toBe(0);

    // Now test public package with VONVON_NO_TELEMETRY=1 and with offline network error.
    await writeFile(join(srcDir, 'vonvon-bot.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'acme/public-ok',
      version: '1.0.0',
      public: true,
      name: '公开测试',
      summary: '测试离线容错',
      docUrl: 'https://my.feishu.cn/docx/ok123',
      author: { name: 'acme' },
      group: { role: '测试角色' },
    }));
    const pubZip = join(await makeTempDir('vonvon-out2-'), 'pub.vonvon.zip');
    await packTemplate(srcDir, pubZip, { dataRoot });

    const dest2 = await makeTempDir('vonvon-d2-');
    const res2 = await stageTemplate(pubZip, dest2, {
      dataRoot, fetchImpl: failingFetch, env: { VONVON_NO_TELEMETRY: '1' },
    });
    expect(res2.telemetry).toEqual({ attempted: false, ok: false, reason: 'telemetry_disabled' });
    expect(fetchCalls).toBe(0);

    const dest3 = await makeTempDir('vonvon-d3-');
    const res3 = await stageTemplate(pubZip, dest3, {
      dataRoot, fetchImpl: failingFetch, env: {},
    });
    expect(res3.telemetry.attempted).toBe(true);
    expect(res3.telemetry.ok).toBe(false);
    expect(fetchCalls).toBe(1);
  });

  it('rejects empty shell templates and secret leaks on pack, and supports repo-root layout like vonvon-assistant', async () => {
    const dataRoot = await makeTempDir('vonvon-home-');
    const emptyDir = await makeTempDir('vonvon-empty-');
    await writeTree(emptyDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1, id: 'spam/empty', version: '0.1.0', name: '空壳', summary: '没有能力', author: { name: 'x' },
      }),
    });
    await expect(packTemplate(emptyDir, join(emptyDir, 'out.vonvon.zip'), { dataRoot })).rejects.toThrow(/空壳配方/);

    const leakyDir = await makeTempDir('vonvon-leaky-');
    await writeTree(leakyDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1, id: 'dev/leaky', version: '0.1.0', name: '漏密钥', summary: '测脱敏', author: { name: 'dev' },
      }),
      'skills/s/SKILL.md': '---\nname: s\n---\n请用密钥 sk-ant-secretvalue1234567890abcd',
    });
    await expect(packTemplate(leakyDir, join(leakyDir, 'out.vonvon.zip'), { dataRoot })).rejects.toBeInstanceOf(PackRedactionError);

    // Repo-root layout matching modelzen/vonvon-assistant (legacy defaults, .agents/skills + .claude/skills).
    const repoDir = await makeTempDir('vonvon-repo-');
    await writeTree(repoDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1,
        id: 'vonvon-assistant',
        version: '0.1.0',
        name: 'vonvon 帮助与反馈',
        summary: '答疑与排错',
        author: { name: 'modelzen', url: 'https://github.com/modelzen' },
        repository: 'https://github.com/modelzen/vonvon-assistant',
        defaults: {
          groupName: 'vonvon 帮助与反馈',
          conversation: 'multi',
          response: 'all',
          permission: 'full',
          permissionNote: '仅限个人私有群',
          firstMessage: '开始初始化',
        },
      }),
      'README.md': '# Assistant',
      'AGENTS.md': '# Rules',
      '.agents/skills/vonvon-setup/SKILL.md': '---\nname: vonvon-setup\n---\n初始化',
      '.claude/skills/vonvon-setup/SKILL.md': '---\nname: vonvon-setup\n---\n初始化',
    });

    const inspected = await inspectTemplate(repoDir);
    expect(inspected.layout).toBe('repo-root');
    expect(inspected.group.defaultName).toBe('vonvon 帮助与反馈');
    expect(inspected.group.recommendedPermission).toBe('full');
    expect(inspected.skills.map(s => s.name)).toEqual(['vonvon-setup']);

    const packedZip = join(await makeTempDir('vonvon-repo-out-'), 'assistant.vonvon.zip');
    await packTemplate(repoDir, packedZip, { dataRoot });
    const packedInspect = await inspectTemplate(packedZip);
    expect(packedInspect.layout).toBe('standard');
    expect(packedInspect.skills.map(s => s.name)).toEqual(['vonvon-setup']);
    expect(packedInspect.workspaceFiles).toContain('AGENTS.md');
  });

  it('rejects executable provider configs in workspace and refuses symlink escape during merge staging', async () => {
    const dataRoot = await makeTempDir('vonvon-home-');
    const evilDir = await makeTempDir('vonvon-evil-cfg-');
    await writeTree(evilDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1, id: 'evil/hook-inject', version: '0.1.0', name: '恶意配置', summary: '试图写 settings.json', author: { name: 'x' },
      }),
      'workspace/.claude/settings.json': '{"hooks":{}}',
    });
    await expect(inspectTemplate(evilDir)).rejects.toThrow(/可执行环境配置/);
    await expect(packTemplate(evilDir, join(evilDir, 'out.vonvon.zip'), { dataRoot })).rejects.toThrow(/可执行环境配置/);

    if (process.platform !== 'win32') {
      const goodDir = await makeTempDir('vonvon-good-');
      await writeTree(goodDir, {
        'vonvon-bot.json': JSON.stringify({
          schemaVersion: 1, id: 'safe/doc', version: '0.1.0', name: '安全文档', summary: '测符号链接拦截', author: { name: 'ok' },
        }),
        'workspace/docs/a.md': 'hello',
      });
      const goodZip = join(await makeTempDir('vonvon-good-out-'), 'safe.vonvon.zip');
      await packTemplate(goodDir, goodZip, { dataRoot });

      const outsideDir = await makeTempDir('vonvon-outside-');
      const mergeDest = await makeTempDir('vonvon-merge-dest-');
      await symlink(outsideDir, join(mergeDest, 'docs'));
      await expect(stageTemplate(goodZip, mergeDest, { mode: 'merge', dataRoot, noTelemetry: true })).rejects.toThrow(/符号链接/);

      // File-vs-directory collision in merge mode is reported as a conflict without throwing mid-way.
      const collideDest = await makeTempDir('vonvon-collide-');
      await writeFile(join(collideDest, 'docs'), 'existing file occupying dir path');
      const collided = await stageTemplate(goodZip, collideDest, { mode: 'merge', dataRoot, noTelemetry: true });
      expect(collided.conflictingWorkspaceFiles).toEqual(['docs/a.md']);
      expect(await readFile(join(collideDest, 'docs'), 'utf8')).toBe('existing file occupying dir path');
    }

    // Top-level skills/ without workspace/ must still retain root files like AGENTS.md.
    const mixedDir = await makeTempDir('vonvon-mixed-');
    await writeTree(mixedDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1, id: 'safe/mixed', version: '0.1.0', name: '混合目录', summary: '保留根文档', author: { name: 'ok' },
      }),
      'AGENTS.md': '# Root Rules',
      'skills/mixed-setup/SKILL.md': '---\nname: mixed-setup\n---\nBody',
    });
    const mixedInspected = await inspectTemplate(mixedDir);
    expect(mixedInspected.skills.map(s => s.name)).toEqual(['mixed-setup']);
    expect(mixedInspected.workspaceFiles).toContain('AGENTS.md');
  });
});

describe('template CLI session authorization', () => {
  it('allows local terminal and DM sessions, refuses group and comment sessions', () => {
    expect(() => assertTemplateSessionAllowed({})).not.toThrow();
    expect(() => assertTemplateSessionAllowed({ [SESSION_ENV]: 'vs1.x', [SESSION_BOT_ENV]: 'cli_bot' })).not.toThrow();
    expect(() => assertTemplateSessionAllowed({ [SESSION_ENV]: 'vs1.x', [SESSION_SCOPE_ENV]: 'bot=cli_bot,group=oc_g' })).toThrow(/群聊和云文档评论/);
    expect(() => assertTemplateSessionAllowed({ [SESSION_ENV]: 'vs1.x', [SESSION_SCOPE_ENV]: 'bot=cli_bot' })).toThrow(/群聊和云文档评论/);
    expect(() => assertTemplateSessionAllowed({ [SESSION_ENV]: 'vs1.x', [SESSION_BOT_ENV]: 'cli_bot' }, 'bot=cli_bot,group=oc_g')).toThrow(/群聊和云文档评论/);
    expect(() => assertTemplateSessionAllowed({ FEISHU_CODEX_BRIDGE: '1' })).toThrow(/群聊和云文档评论/);
  });
});

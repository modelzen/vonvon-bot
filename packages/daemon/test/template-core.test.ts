import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import { discoverLocalGroupSkills } from '../src/agent/group-skills';
import { TurnCardEvents } from '../src/bot/turn-card-events';
import { buildRunCard } from '../src/card/run-card';
import { RunRender } from '../src/card/run-render';
import { assertTemplateSessionAllowed, verifyTemplateSessionAllowed } from '../src/cli/commands/template';
import { SESSION_BOT_ENV, SESSION_ENV, SESSION_SCOPE_ENV } from '../src/config/session-env';
import { appendLarkCliToPath, resolveLarkCliBin } from '../src/platform/lark-cli';
import { DEVICES_DIR } from '../src/remote/files';
import { authorKeyPath, loadOrCreateAuthorKey, signPromoPayload, verifyPromoPayload } from '../src/template/author-key';
import { extractFeishuDocSourceHints, fetchTemplateSource, parseGitHubRepoUrl } from '../src/template/fetch';
import {
  draftTemplateFromDirectory, extractTemplate, inspectTemplate, INSTALLED_META_FILENAME, packTemplate, PackRedactionError, stageTemplate,
} from '../src/template/ops';
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
    // Both local header and central directory header must include UTF-8 bit 11 (0x0800).
    expect(archive.readUInt16LE(6) & 0x0800).toBe(0x0800);
    const cdPos = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(cdPos).toBeGreaterThan(0);
    expect(archive.readUInt16LE(cdPos + 8) & 0x0800).toBe(0x0800);
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
    // Real daemon skill discovery must detect the staged skill on both Codex and Claude backends.
    const emptyHome = await makeTempDir('vonvon-oshome-');
    const codexFound = await discoverLocalGroupSkills({ backendId: 'codex-appserver', cwd: destDir, home: emptyHome, env: {} });
    const claudeFound = await discoverLocalGroupSkills({ backendId: 'claude-agent', cwd: destDir, home: emptyHome, env: {} });
    expect(codexFound.map(s => s.name)).toEqual(['brief-setup']);
    expect(claudeFound.map(s => s.name)).toEqual(['brief-setup']);
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
      'skills/s/SKILL.md': '---\nname: s\ndescription: 测脱敏\n---\n请用密钥 sk-ant-secretvalue1234567890abcd',
    });
    await expect(packTemplate(leakyDir, join(leakyDir, 'out.vonvon.zip'), { dataRoot })).rejects.toBeInstanceOf(PackRedactionError);

    // SKILL.md without required YAML frontmatter (name + description) warns on inspect and fails pack.
    const badSkillDir = await makeTempDir('vonvon-bad-skill-');
    await writeTree(badSkillDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1, id: 'dev/bad-skill', version: '0.1.0', name: '坏技能', summary: '缺少 frontmatter', author: { name: 'dev' },
      }),
      'skills/broken/SKILL.md': '# Missing YAML frontmatter\n',
    });
    const badSkillInspect = await inspectTemplate(badSkillDir);
    expect(badSkillInspect.warnings.some(w => w.includes('frontmatter'))).toBe(true);
    await expect(packTemplate(badSkillDir, join(badSkillDir, 'out.vonvon.zip'), { dataRoot })).rejects.toThrow(/frontmatter/);

    // Passing a URL directly gives an actionable clone/download message.
    await expect(inspectTemplate('https://github.com/modelzen/vonvon-assistant')).rejects.toThrow(/git clone --depth 1/);

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
      '.agents/skills/vonvon-setup/SKILL.md': '---\nname: vonvon-setup\ndescription: 环境预准备\n---\n初始化',
      '.claude/skills/vonvon-setup/SKILL.md': '---\nname: vonvon-setup\ndescription: 环境预准备\n---\n初始化',
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
      'skills/mixed-setup/SKILL.md': '---\nname: mixed-setup\ndescription: 初始化\n---\nBody',
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

  it('negotiates exactly once in a DM bot session and rejects non-DM principals', async () => {
    const makeFakeClient = (principal: 'bot-session:dm' | 'bot-session:group') => {
      let negotiates = 0;
      const client = {
        async admin(payload: { type: string }) {
          if (payload.type === 'negotiate') {
            negotiates++;
            if (negotiates > 1) throw new RpcError('invalid_request', 'negotiate 只能发一次。');
            return { kind: 'negotiated', principal, capabilities: ['cli'] };
          }
          throw new Error(`unexpected admin call: ${payload.type}`);
        },
        async close() {},
      } as unknown as VonvonClient;
      return { client, count: () => negotiates };
    };

    const dmFake = makeFakeClient('bot-session:dm');
    await expect(verifyTemplateSessionAllowed(
      { [SESSION_ENV]: 'vs1.token', [SESSION_BOT_ENV]: 'cli_bot' },
      undefined,
      await makeTempDir('vonvon-home-'),
      async () => dmFake.client,
    )).resolves.toBeUndefined();
    expect(dmFake.count()).toBe(1);

    const groupFake = makeFakeClient('bot-session:group');
    await expect(verifyTemplateSessionAllowed(
      { [SESSION_ENV]: 'vs1.token', [SESSION_BOT_ENV]: 'cli_bot' },
      undefined,
      await makeTempDir('vonvon-home-'),
      async () => groupFake.client,
    )).rejects.toThrow(/群聊和云文档评论/);
    expect(groupFake.count()).toBe(1);
  });
});

describe('draftTemplateFromDirectory', () => {
  it('extracts real group workspace, local skills, and existing manifest while skipping runtime/builtin/forbidden files', async () => {
    const groupDir = await makeTempDir('vonvon-src-group-');
    const destDir = join(await makeTempDir('vonvon-draft-out-'), 'draft');
    const dataRoot = await makeTempDir('vonvon-draft-data-');

    await writeTree(groupDir, {
      '.gitignore': '# runtime state\nworkspace/\n*.log\n',
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1,
        id: 'vonvon-assistant',
        name: 'vonvon 帮助与反馈',
        summary: '4 个真实 Skill 帮用户初始化、答疑、排错和反馈。',
        version: '0.1.0',
        public: true,
        docUrl: 'https://example.feishu.cn/docx/existingdoc',
        author: { name: 'modelzen' },
        defaults: {
          groupName: 'vonvon 帮助与反馈',
          permission: 'full',
          permissionNote: '本地排错需要完全访问',
          firstMessage: '开始初始化',
        },
        skills: [
          { name: 'vonvon-setup', title: '环境预准备与更新', description: '一次性体检' },
        ],
      }, null, 2),
      'README.md': '# vonvon 帮助与反馈\n',
      'AGENTS.md': '# Group Rules\n',
      'scripts/sync-skills.mjs': 'console.log("ok");\n',
      '.env': 'SECRET_KEY=topsecret\n',
      '.mcp.json': '{"mcpServers":{}}\n',
      'debug.log': 'ignored log\n',
      'workspace/setup-state.json': '{"step":1}\n',
      'workspace/vonvon-bot/.git/HEAD': 'ref: refs/heads/main\n',
      'workspace/vonvon-bot/README.md': 'nested repo\n',
      'nested-clone/.git/HEAD': 'ref: refs/heads/main\n',
      'nested-clone/index.ts': 'export {};\n',
      '.agents/skills/vonvon-setup/SKILL.md': '---\nname: vonvon-setup\ndescription: 初始化技能\n---\nSetup body\n',
      '.agents/skills/vonvon-qa/SKILL.md': '---\nname: vonvon-qa\ndescription: 源码答疑\n---\nQA body\n',
      '.agents/skills/vonvon-diagnose/SKILL.md': '---\nname: vonvon-diagnose\ndescription: 本地排错\n---\nDiagnose body\n',
      '.agents/skills/vonvon-feedback/SKILL.md': '---\nname: vonvon-feedback\ndescription: 脱敏反馈\n---\nFeedback body\n',
      '.agents/skills/vonvon-template/SKILL.md': '---\nname: vonvon-template\ndescription: 系统内置技能不应复制\n---\nBuiltin\n',
      '.agents/skills/disabled-one/SKILL.md': '---\nname: disabled-one\ndescription: 已停用技能\n---\nDisabled\n',
      '.claude/skills/vonvon-setup/SKILL.md': '---\nname: vonvon-setup\ndescription: 重复副本\n---\nDup\n',
    });

    const draft = await draftTemplateFromDirectory({
      sourceDir: groupDir,
      destDir,
      groupName: 'vonvon 帮助与反馈',
      roleSupplement: '优先依据工作区源码回答问题。',
      recommendedPermission: 'full',
      disabledSkillPaths: [join(groupDir, '.agents/skills/disabled-one/SKILL.md')],
    });

    expect(draft.reusedExistingManifest).toBe(true);
    expect(draft.id).toBe('vonvon-assistant');
    expect(draft.skills.map(s => s.name)).toEqual(['vonvon-diagnose', 'vonvon-feedback', 'vonvon-qa', 'vonvon-setup']);
    expect(draft.skills.find(s => s.name === 'vonvon-setup')?.title).toBe('环境预准备与更新');
    expect(draft.workspaceFiles).toEqual(['.gitignore', 'AGENTS.md', 'scripts/sync-skills.mjs']);
    expect(draft.hasReadme).toBe(true);
    expect(draft.roleIncluded).toBe(true);
    expect(draft.skippedEntries).toEqual(expect.arrayContaining([
      { path: '.agents/skills/vonvon-template', reason: 'builtin-skill' },
      { path: '.agents/skills/disabled-one', reason: 'disabled-skill' },
      { path: 'workspace/', reason: 'gitignored' },
      { path: 'debug.log', reason: 'gitignored' },
      { path: 'nested-clone/', reason: 'nested-git-repo' },
      { path: '.env', reason: 'forbidden' },
      { path: '.mcp.json', reason: 'forbidden' },
    ]));

    // Draft forces `public: false` until creator opts in, and passes inspect + pack cleanly!
    const inspected = await inspectTemplate(destDir);
    expect(inspected.public).toBe(false);
    expect(inspected.docUrl).toBe('https://example.feishu.cn/docx/existingdoc');
    expect(inspected.skills.map(s => s.name)).toEqual(['vonvon-diagnose', 'vonvon-feedback', 'vonvon-qa', 'vonvon-setup']);
    expect(inspected.group.role).toBe('优先依据工作区源码回答问题。');
    expect(inspected.group.firstMessage).toBe('开始初始化');

    const outZip = join(await makeTempDir('vonvon-draft-zip-'), 'assistant.vonvon.zip');
    const packed = await packTemplate(destDir, outZip, { dataRoot });
    expect(packed.skillNames).toEqual(['vonvon-diagnose', 'vonvon-feedback', 'vonvon-qa', 'vonvon-setup']);
    expect(packed.public).toBe(false);

    // Rejects destination nested inside sourceDir or non-empty destination.
    await expect(draftTemplateFromDirectory({
      sourceDir: groupDir,
      destDir: join(groupDir, 'sub-draft'),
      groupName: 'vonvon 帮助与反馈',
    })).rejects.toThrow(/不能位于源群工作区内部/);
    await expect(draftTemplateFromDirectory({
      sourceDir: groupDir,
      destDir,
      groupName: 'vonvon 帮助与反馈',
    })).rejects.toThrow(/必须为空目录/);
  });

  it('synthesizes a valid manifest from scratch when the group has no existing vonvon-bot.json', async () => {
    const groupDir = await makeTempDir('vonvon-plain-group-');
    const destDir = join(await makeTempDir('vonvon-plain-out-'), 'draft');
    await writeTree(groupDir, {
      'AGENTS.md': '# 每日复盘群规则\n',
      '.agents/skills/daily-recap/SKILL.md': '---\nname: daily-recap\ndescription: 整理每日工作复盘\n---\nBody\n',
    });

    const draft = await draftTemplateFromDirectory({
      sourceDir: groupDir,
      destDir,
      groupName: '每日复盘',
      authorName: 'Clay',
      roleSupplement: '每天 18:00 汇总当天进展与风险。',
      recommendedPermission: 'write',
      schedules: [{ name: '晚间复盘', when: { kind: 'daily', time: '18:00' }, prompt: '总结今天进展', enabledByDefault: true }],
    });

    expect(draft.reusedExistingManifest).toBe(false);
    expect(draft.id).toBe('group-recipe');
    expect(draft.skills.map(s => s.name)).toEqual(['daily-recap']);
    expect(draft.scheduleCount).toBe(1);
    const inspected = await inspectTemplate(destDir);
    expect(inspected.author.name).toBe('Clay');
    expect(inspected.group.recommendedPermission).toBe('write');
    expect(inspected.group.schedules).toHaveLength(1);
  });
});

describe('lark-cli resolution & post-ask run card rotation primitives', () => {
  it('resolves lark-cli from NVM highest version and appends its directory to PATH without shadowing', async () => {
    if (process.platform === 'win32') return;
    const fakeHome = await makeTempDir('vonvon-lark-home-');
    const fakeData = await makeTempDir('vonvon-lark-data-');
    const oldBin = join(fakeHome, '.nvm', 'versions', 'node', 'v20.10.0', 'bin', 'lark-cli');
    const newBin = join(fakeHome, '.nvm', 'versions', 'node', 'v24.14.1', 'bin', 'lark-cli');
    await mkdir(join(oldBin, '..'), { recursive: true });
    await mkdir(join(newBin, '..'), { recursive: true });
    await writeFile(oldBin, '#!/bin/sh\necho old\n');
    await writeFile(newBin, '#!/bin/sh\necho new\n');
    await chmod(oldBin, 0o755);
    await chmod(newBin, 0o755);

    const resolved = resolveLarkCliBin({ dataRoot: fakeData, home: fakeHome, env: { PATH: '/usr/bin:/bin' }, platform: 'darwin' });
    expect(resolved).toBe(newBin);

    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
    appendLarkCliToPath(newBin, env, 'darwin');
    expect(env.PATH).toBe(`/usr/bin:/bin:${join(fakeHome, '.nvm', 'versions', 'node', 'v24.14.1', 'bin')}`);
    // Idempotent second call does not duplicate the entry.
    appendLarkCliToPath(newBin, env, 'darwin');
    expect(env.PATH).toBe(`/usr/bin:/bin:${join(fakeHome, '.nvm', 'versions', 'node', 'v24.14.1', 'bin')}`);
  });

  it('queues ask_answered on TurnCardEvents and renders frozen card with choice-continuation label', async () => {
    const events = new TurnCardEvents();
    const collected: string[] = [];
    async function* source() {
      yield { type: 'turn_started' as const, turnId: 't1' };
      events.askAnswered('om_ask_123');
      yield { type: 'done' as const, turnId: 't1' };
    }
    for await (const ev of events.consume(source())) {
      collected.push(ev.type === 'ask_answered' ? `${ev.type}:${ev.messageId}` : ev.type);
    }
    expect(collected).toEqual(['turn_started', 'ask_answered:om_ask_123', 'done']);

    const render = new RunRender();
    const frozen = buildRunCard({
      rs: { ...render.snapshot(), terminal: 'done', footer: null, completedAt: Date.now() },
      continued: 'ask',
    });
    expect(JSON.stringify(frozen)).toContain('已收到选择，后续输出见下一张卡片');
  });
});

describe('wave-1 template reliability upgrades (+x mode, repo hygiene, skill pruning, template fetch)', () => {
  it('preserves POSIX executable permissions across draft-group -> pack -> readZip -> extract -> stage', async () => {
    if (process.platform === 'win32') return;
    const dataRoot = await makeTempDir('vonvon-exec-home-');
    const groupDir = await makeTempDir('vonvon-exec-group-');
    await writeTree(groupDir, {
      'AGENTS.md': '# Exec Test\n',
      'scripts/run.sh': '#!/bin/sh\necho workspace-ok\n',
      '.agents/skills/demo-tool/SKILL.md': '---\nname: demo-tool\ndescription: 执行脚本测试\n---\nBody\n',
      '.agents/skills/demo-tool/scripts/cli': '#!/bin/sh\necho skill-ok\n',
    });
    await chmod(join(groupDir, 'scripts/run.sh'), 0o755);
    await chmod(join(groupDir, '.agents/skills/demo-tool/scripts/cli'), 0o755);

    const draftDir = join(await makeTempDir('vonvon-exec-draft-'), 'draft');
    await draftTemplateFromDirectory({ sourceDir: groupDir, destDir: draftDir, groupName: 'exec-group' });
    expect((await stat(join(draftDir, 'workspace/scripts/run.sh'))).mode & 0o111).toBeGreaterThan(0);
    expect((await stat(join(draftDir, 'skills/demo-tool/scripts/cli'))).mode & 0o111).toBeGreaterThan(0);

    const outZip = join(await makeTempDir('vonvon-exec-out-'), 'exec.vonvon.zip');
    await packTemplate(draftDir, outZip, { dataRoot });

    const zipEntries = readZip(await readFile(outZip));
    expect(zipEntries.find(e => e.path === 'workspace/scripts/run.sh')?.executable).toBe(true);
    expect(zipEntries.find(e => e.path === 'skills/demo-tool/scripts/cli')?.executable).toBe(true);
    expect(zipEntries.find(e => e.path === 'workspace/AGENTS.md')?.executable).toBe(false);

    const extractDir = join(await makeTempDir('vonvon-exec-ext-'), 'ext');
    await extractTemplate(outZip, extractDir);
    expect((await stat(join(extractDir, 'workspace/scripts/run.sh'))).mode & 0o111).toBeGreaterThan(0);
    expect((await stat(join(extractDir, 'skills/demo-tool/scripts/cli'))).mode & 0o111).toBeGreaterThan(0);

    const stageDir = await makeTempDir('vonvon-exec-stage-');
    await stageTemplate(outZip, stageDir, { mode: 'fresh', dataRoot, noTelemetry: true });
    expect((await stat(join(stageDir, 'scripts/run.sh'))).mode & 0o111).toBeGreaterThan(0);
    expect((await stat(join(stageDir, '.agents/skills/demo-tool/scripts/cli'))).mode & 0o111).toBeGreaterThan(0);
    expect((await stat(join(stageDir, '.claude/skills/demo-tool/scripts/cli'))).mode & 0o111).toBeGreaterThan(0);

    // Merge mode repairs missing +x on unchanged script without flagging a conflict.
    await chmod(join(stageDir, 'scripts/run.sh'), 0o644);
    const merged = await stageTemplate(outZip, stageDir, { mode: 'merge', dataRoot, noTelemetry: true });
    expect(merged.conflictingWorkspaceFiles).toEqual([]);
    expect((await stat(join(stageDir, 'scripts/run.sh'))).mode & 0o111).toBeGreaterThan(0);
  });

  it('ignores top-level .github/ in cloned repos, allows .env.example, rejects secrets in skills/, and prunes stale files on --update-skills', async () => {
    const dataRoot = await makeTempDir('vonvon-hygiene-home-');
    const repoDir = await makeTempDir('vonvon-hygiene-repo-');
    await writeTree(repoDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1,
        id: 'hygiene-demo',
        version: '0.1.0',
        name: '仓库规范测试',
        summary: '验证 .github 和 .env.example 以及复合协议长度',
        license: 'MIT (code) / CC-BY-4.0 (docs) / CC0-1.0 (awesome-code-animation)',
        author: { name: 'Tester' },
        group: {
          schedules: [{ name: '每周五团队复盘汇总', when: { kind: 'weekly', days: [5], time: '17:00' }, prompt: '复盘' }],
        },
      }),
      '.github/workflows/ci.yml': 'name: ci\n',
      '.env.example': 'API_KEY=replace-me\n',
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: 示例技能\n---\nExample path /home/user2/work\n',
      'skills/demo/old-helper.py': 'print("old")\n',
    });

    const inspected = await inspectTemplate(repoDir);
    expect(inspected.workspaceFiles).toContain('.env.example');
    expect(inspected.workspaceFiles).not.toContain('.github/workflows/ci.yml');

    const v1Zip = join(await makeTempDir('vonvon-hygiene-z1-'), 'v1.vonvon.zip');
    await packTemplate(repoDir, v1Zip, { dataRoot });

    const stageDir = await makeTempDir('vonvon-hygiene-stage-');
    await stageTemplate(v1Zip, stageDir, { mode: 'fresh', dataRoot, noTelemetry: true });
    expect(await readFile(join(stageDir, '.agents/skills/demo/old-helper.py'), 'utf8')).toContain('old');

    // Upgrade skill v0.2.0 removing old-helper.py and adding new-helper.py
    await rm(join(repoDir, 'skills/demo/old-helper.py'));
    await writeFile(join(repoDir, 'skills/demo/new-helper.py'), 'print("new")\n');
    const v2Zip = join(await makeTempDir('vonvon-hygiene-z2-'), 'v2.vonvon.zip');
    await packTemplate(repoDir, v2Zip, { dataRoot });

    const upgraded = await stageTemplate(v2Zip, stageDir, { mode: 'merge', updateSkills: true, dataRoot, noTelemetry: true });
    expect(upgraded.updatedSkills).toEqual(['demo']);
    // Existing user/local files inside a skill directory are preserved safely on upgrade instead of blindly deleted.
    expect(await readFile(join(stageDir, '.agents/skills/demo/old-helper.py'), 'utf8')).toContain('old');
    expect(await readFile(join(stageDir, '.agents/skills/demo/new-helper.py'), 'utf8')).toContain('new');

    // Rejects forbidden .env / .mcp.json smuggled inside skills/
    const evilSkillDir = await makeTempDir('vonvon-evil-skill-');
    await writeTree(evilSkillDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1, id: 'evil-skill', version: '0.1.0', name: '恶意技能', summary: '尝试夹带 .env', author: { name: 'x' },
      }),
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: x\n---\nbody',
      'skills/demo/.mcp.json': '{}',
    });
    await expect(inspectTemplate(evilSkillDir)).rejects.toThrow(/Skill 目录不允许包含/);

    // Rejects real credentials placed in .env.example while allowing clean placeholders.
    expect(scanFilesForSecrets([{ path: '.env.example', data: Buffer.from('DB_PASSWORD=replace-me\nAPI_KEY=\n') }])).toEqual([]);
    expect(scanFilesForSecrets([{ path: '.env.example', data: Buffer.from('DB_PASSWORD=S3cr3tPr0dPass99!\n') }])).toHaveLength(1);

    // Preserves v1 backward compatibility for 41–80 char schedule names while still rejecting >80 chars.
    const longSched45 = templateManifestSchema.safeParse({
      schemaVersion: 1, id: 'sched-45', version: '0.1.0', name: '定时名45字', summary: 'x', author: { name: 'x' },
      group: { schedules: [{ name: '超'.repeat(45), when: { kind: 'daily', time: '09:00' }, prompt: 'go' }] },
    });
    expect(longSched45.success).toBe(true);
    const badSched85 = templateManifestSchema.safeParse({
      schemaVersion: 1, id: 'sched-85', version: '0.1.0', name: '定时名85字', summary: 'x', author: { name: 'x' },
      group: { schedules: [{ name: '超'.repeat(85), when: { kind: 'daily', time: '09:00' }, prompt: 'go' }] },
    });
    expect(badSched85.success).toBe(false);

    // Numeric placeholders like /home/user2 are allowed while real paths stay blocked.
    expect(scanFilesForSecrets([{ path: 'doc.md', data: Buffer.from('/home/user2/demo') }])).toEqual([]);
    expect(scanFilesForSecrets([{ path: 'doc.md', data: Buffer.from('/Users/clay/secret') }])).toHaveLength(1);
  });

  it('extracts Feishu DocxXML/SSR template hints, blocks SSRF loopback, and routes GitHub release zips directly', async () => {
    const xmlHints = extractFeishuDocSourceHints(
      '<title>人生指南</title><p>仓库 https://github.com/Lark-Base-Team/dashboard-page-preview https://github.com/modelzen/vonvon-assistant</p><source token="boxcnAbc1234567890" name="how-to-live-better-0.1.0.vonvon.zip"/>',
    );
    expect(xmlHints.repositories).toEqual(['https://github.com/modelzen/vonvon-assistant']);
    expect(xmlHints.title).toBe('人生指南');

    // SSRF guard blocks loopback direct zip download when using real network check
    const ssrfDest = join(await makeTempDir('vonvon-ssrf-'), 'out');
    const ssrfRes = await fetchTemplateSource('https://127.0.0.1/evil.vonvon.zip', ssrfDest);
    expect(ssrfRes.resolved).toBe(false);
    expect(ssrfRes.reason).toBe('private_address_blocked');

    // GitHub release .vonvon.zip asset downloads directly instead of trying to git-clone the repo
    const relDest = join(await makeTempDir('vonvon-ghrel-'), 'out');
    const relFakeZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    const relRes = await fetchTemplateSource('https://github.com/org/repo/releases/download/v1.0/demo.vonvon.zip', relDest, {
      fetchImpl: async () => new Response(relFakeZip, { status: 200 }),
    });
    expect(relRes.resolved).toBe(true);
    expect(relRes.via).toBe('direct-download');
    expect(relRes.sourceKind).toBe('zip');
    expect(xmlHints.repositories).toEqual(['https://github.com/modelzen/vonvon-assistant']);
    expect(xmlHints.embeddedZips).toEqual([{ name: 'how-to-live-better-0.1.0.vonvon.zip', token: 'boxcnAbc1234567890' }]);

    const ssrHtml = `<html><title>配方页</title><script>window.SERVER_DATA=Object({"meta":{"token":"DocTok123456789012"}});var x={"file":{"name":"demo-0.1.0.vonvon.zip","token":"boxcnSsr1234567890"}};</script></html>`;
    const ssrHints = extractFeishuDocSourceHints(ssrHtml);
    expect(ssrHints.docToken).toBe('DocTok123456789012');
    expect(ssrHints.embeddedZips).toEqual([{ name: 'demo-0.1.0.vonvon.zip', token: 'boxcnSsr1234567890' }]);
    expect(parseGitHubRepoUrl('https://github.com/modelzen/vonvon-assistant/tree/main/sub')).toEqual({
      repoUrl: 'https://github.com/modelzen/vonvon-assistant',
      branch: 'main',
      subdir: 'sub',
    });

    // Mock anonymous guest fetch succeeding on embedded `.vonvon.zip`
    const fakeZip = createZip([{ path: 'vonvon-bot.json', data: Buffer.from('{}') }]);
    const destOk = join(await makeTempDir('vonvon-fetch-ok-'), 'in');
    const fetchedOk = await fetchTemplateSource('https://my.feishu.cn/docx/DocTok123456789012', destOk, {
      skipLarkCli: true,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/docx/')) return new Response(ssrHtml, { status: 200, headers: { 'content-type': 'text/html' } });
        if (url.includes('/download/all/boxcnSsr1234567890/')) {
          return new Response(new Uint8Array(fakeZip), { status: 200, headers: { 'content-type': 'application/zip' } });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    });
    expect(fetchedOk.resolved).toBe(true);
    expect(fetchedOk.sourceKind).toBe('zip');
    expect(fetchedOk.attachmentName).toBe('demo-0.1.0.vonvon.zip');
    expect(fetchedOk.localPath?.endsWith('demo-0.1.0.vonvon.zip')).toBe(true);

    // Mock login-gated embedded attachment -> graceful fallback without throwing
    const destGated = join(await makeTempDir('vonvon-fetch-gated-'), 'in');
    const fetchedGated = await fetchTemplateSource('https://my.feishu.cn/docx/DocTok123456789012', destGated, {
      skipLarkCli: true,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/docx/')) return new Response(ssrHtml, { status: 200, headers: { 'content-type': 'text/html' } });
        return new Response('login required', { status: 403 });
      }) as typeof fetch,
    });
    expect(fetchedGated.resolved).toBe(false);
    expect(fetchedGated.reason).toBe('attachment_requires_login');
    expect(fetchedGated.attachmentName).toBe('demo-0.1.0.vonvon.zip');
    expect(fetchedGated.hint).toContain('demo-0.1.0.vonvon.zip');
  });

  it('hardens inspect warnings, partial merge versioning, stage frontmatter gate, draft-group private skips, and odd UTF-16BE', async () => {
    // Odd-length UTF-16BE must not crash swap16; JSON-escaped Windows home paths must be caught.
    const oddUtf16Be = Buffer.from([0xfe, 0xff, 0x00, 0x41, 0x00]);
    expect(scanFilesForSecrets([{ path: 'odd.txt', data: oddUtf16Be }])).toEqual([]);
    const escapedWin = scanFilesForSecrets([{ path: 'cfg.json', data: Buffer.from('{"dir":"C:\\\\Users\\\\realuser\\\\docs"}') }]);
    expect(escapedWin.some(f => f.rule === 'windows-home-path')).toBe(true);

    // Inspect warns explicitly when author writes group.permission instead of group.recommendedPermission.
    const typoDir = await makeTempDir('vonvon-typo-');
    await writeTree(typoDir, {
      'vonvon-bot.json': JSON.stringify({
        schemaVersion: 1, id: 'typo-check', version: '0.1.0', name: '测试', summary: '简介',
        author: { name: 'Tester' }, group: { permission: 'qa', role: '助手' },
      }),
      'skills/bad-skill/SKILL.md': '# missing frontmatter',
    });
    const insp = await inspectTemplate(typoDir);
    expect(insp.warnings.some(w => w.includes('group.permission'))).toBe(true);
    // Stage refuses invalid skill frontmatter before mutating destination.
    const badDest = join(await makeTempDir('vonvon-bad-stage-'), 'dest');
    await expect(stageTemplate(typoDir, badDest, { mode: 'fresh', noTelemetry: true })).rejects.toThrow(/frontmatter/);

    // Partial merge conflict keeps previous installed version and skips telemetry.
    const v1Dir = await makeTempDir('vonvon-v1-');
    const v2Dir = await makeTempDir('vonvon-v2-');
    const mergeDest = join(await makeTempDir('vonvon-merge-'), 'ws');
    await writeTree(v1Dir, {
      'vonvon-bot.json': JSON.stringify({ schemaVersion: 1, id: 'merge-test', version: '0.1.0', public: true, docUrl: 'https://my.feishu.cn/docx/abc', name: 'M', summary: 'S', author: { name: 'A' } }),
      'skills/s1/SKILL.md': '---\nname: s1\ndescription: d1\n---\nbody1',
      'workspace/tool.py': 'v1',
    });
    await writeTree(v2Dir, {
      'vonvon-bot.json': JSON.stringify({ schemaVersion: 1, id: 'merge-test', version: '0.2.0', public: true, docUrl: 'https://my.feishu.cn/docx/abc', name: 'M', summary: 'S', author: { name: 'A' } }),
      'skills/s1/SKILL.md': '---\nname: s1\ndescription: d2\n---\nbody2',
      'workspace/tool.py': 'v2',
    });
    const s1 = await stageTemplate(v1Dir, mergeDest, { mode: 'fresh', noTelemetry: true });
    expect(s1.partial).toBe(false);
    expect(s1.version).toBe('0.1.0');
    const s2 = await stageTemplate(v2Dir, mergeDest, { mode: 'merge', updateSkills: true });
    expect(s2.partial).toBe(true);
    expect(s2.conflictingWorkspaceFiles).toEqual(['tool.py']);
    expect(s2.version).toBe('0.1.0');
    expect(s2.telemetry.reason).toBe('partial_conflict');
    const metaAfter = JSON.parse(await readFile(join(mergeDest, INSTALLED_META_FILENAME), 'utf8'));
    expect(metaAfter.templates[0].version).toBe('0.1.0');

    // draftTemplateFromDirectory skips memory.json, honors explicit id/author, and respects cleared live role.
    const srcGroup = await makeTempDir('vonvon-srcgrp-');
    const draftDest = join(await makeTempDir('vonvon-draftdst-'), 'draft');
    await writeTree(srcGroup, {
      'vonvon-bot.json': JSON.stringify({ schemaVersion: 1, id: 'old-id', version: '0.1.0', name: 'Old', summary: 'Old', author: { name: 'OldAuthor' }, group: { role: 'StaleRole' } }),
      'memory.json': '{"secret":"private"}',
      'AGENTS.md': '# Guide',
      '.agents/skills/helper/SKILL.md': '---\nname: helper\ndescription: helps\n---\nhello',
    });
    const drafted = await draftTemplateFromDirectory({
      sourceDir: srcGroup,
      destDir: draftDest,
      groupName: '测试群',
      id: 'new-slug',
      authorName: 'Clay Zhang',
      roleReadOk: true,
      schedulesReadOk: true,
    });
    expect(drafted.id).toBe('new-slug');
    expect(drafted.roleIncluded).toBe(false);
    expect(drafted.skippedEntries.some(e => e.path === 'memory.json' && e.reason === 'forbidden')).toBe(true);
    const draftedManifest = JSON.parse(await readFile(join(draftDest, 'vonvon-bot.json'), 'utf8'));
    expect(draftedManifest.author.name).toBe('Clay Zhang');
    expect(draftedManifest.group.role).toBeUndefined();
  });
});

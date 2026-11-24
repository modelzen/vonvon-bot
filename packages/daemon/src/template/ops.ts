import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { paths } from '../config/paths';
import { loadOrCreateAuthorKey, signCoverBytes, signPromoPayload, verifyPromoPayload } from './author-key';
import {
  fetchLocalFeishuCover, publishTemplatePromo, reportTemplateInstall,
  type InstallReportResult, type PublishResult, type TemplateSourceKind,
} from './club-client';
import { scanFilesForSecrets, type RedactionFinding } from './redact';
import {
  buildPublicPromoPayload, effectiveAcquisition, effectiveDocUrl, effectiveGroupSpec, effectivePricing,
  installedTemplatesFileSchema, isPublicTemplate, templateManifestSchema,
  type InstalledTemplateRecord, type InstalledTemplatesFile, type TemplateGroupSpec, type TemplateManifest, type TemplatePricing,
} from './schema';
import { createZip, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, MAX_UNCOMPRESSED_BYTES, normalizeZipPath, readZip } from './zip';

export const MANIFEST_FILENAME = 'vonvon-bot.json';
export const INSTALLED_META_FILENAME = '.vonvon-template.json';

export type TemplateLayout = 'standard' | 'repo-root';
export type SignatureStatus = 'valid' | 'invalid' | 'unsigned';

interface LoadedFile {
  path: string;
  data: Buffer;
}

interface ParsedTemplatePackage {
  sourceKind: TemplateSourceKind;
  layout: TemplateLayout;
  manifest: TemplateManifest;
  rawManifestText: string;
  readme?: Buffer;
  /** Map from skillName -> relative path inside skill dir -> file Buffer. */
  skills: Map<string, LoadedFile[]>;
  /** Workspace files relative to target group `<cwd>`. */
  workspaceFiles: LoadedFile[];
  /** All raw entries (excluding OS junk) for inspection / extraction. */
  allFiles: LoadedFile[];
}

export interface InspectResult {
  sourceKind: TemplateSourceKind;
  layout: TemplateLayout;
  id: string;
  version: string;
  name: string;
  summary: string;
  public: boolean;
  docUrl?: string;
  installHint?: string;
  author: TemplateManifest['author'];
  pricing: TemplatePricing;
  acquisition: string[];
  license?: string;
  credits: NonNullable<TemplateManifest['credits']>;
  prerequisites: string[];
  group: TemplateGroupSpec;
  skills: { name: string; setup: boolean; files: number; title?: string; description?: string }[];
  workspaceFiles: string[];
  signatureStatus: SignatureStatus;
  hasEffectiveCapability: boolean;
  warnings: string[];
}

export interface ExtractResult {
  dest: string;
  filesWritten: number;
  manifestPath: string;
  id: string;
  version: string;
}

export interface StageResult {
  dest: string;
  mode: 'fresh' | 'merge';
  id: string;
  version: string;
  writtenWorkspaceFiles: string[];
  conflictingWorkspaceFiles: string[];
  addedSkills: string[];
  updatedSkills: string[];
  conflictingSkills: string[];
  installedMetaPath: string;
  telemetry: InstallReportResult;
}

export interface PackResult {
  out: string;
  id: string;
  version: string;
  public: boolean;
  docUrl?: string;
  authorPublicKey: string;
  sha256: string;
  sizeBytes: number;
  skillNames: string[];
  workspaceFileCount: number;
  publish?: PublishResult;
}

function isOsJunk(relPath: string): boolean {
  const parts = relPath.split('/');
  return parts[0] === '__MACOSX' || parts.some(p => p === '.DS_Store' || p === 'Thumbs.db');
}

/**
 * Executable provider configs, repository internals, and local environment files must never be
 * silently staged into a group workspace (Claude/Codex auto-load project settings and hooks).
 */
const FORBIDDEN_WORKSPACE_ROOTS = new Set([
  '.claude',
  '.codex',
  '.agents',
  '.git',
  '.github',
  '.cursor',
  '.vscode',
  '.idea',
  'node_modules',
]);

const FORBIDDEN_WORKSPACE_FILES = new Set([
  '.mcp.json',
  'mcp.json',
  '.vonvon-template.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.env',
]);

function isForbiddenWorkspacePath(relPath: string): boolean {
  const parts = relPath.split('/').map(p => p.toLowerCase());
  const first = parts[0] ?? '';
  const leaf = parts.at(-1) ?? '';
  if (FORBIDDEN_WORKSPACE_ROOTS.has(first)) return true;
  if (parts.some(p => p === '.git' || p === 'node_modules')) return true;
  if (FORBIDDEN_WORKSPACE_FILES.has(leaf)) return true;
  if (leaf.startsWith('.env.')) return true;
  return false;
}

function isSkillPath(relPath: string): { root: 'skills' | '.agents/skills' | '.claude/skills'; skillName: string; innerPath: string } | undefined {
  for (const root of ['skills', '.agents/skills', '.claude/skills'] as const) {
    const prefix = `${root}/`;
    if (!relPath.startsWith(prefix)) continue;
    const rest = relPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return undefined;
    const skillName = rest.slice(0, slash);
    const innerPath = rest.slice(slash + 1);
    if (!innerPath) return undefined;
    return { root, skillName, innerPath };
  }
  return undefined;
}

async function readDirectoryFiles(rootDir: string): Promise<LoadedFile[]> {
  const files: LoadedFile[] = [];
  let totalBytes = 0;

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
      const full = join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new Error(`配方目录内不允许符号链接：${relative(rootDir, full)}`);
      }
      if (info.isDirectory()) {
        await walk(full);
      } else if (info.isFile()) {
        if (files.length + 1 > MAX_ARCHIVE_FILES) {
          throw new Error(`配方文件数量超过上限（最多 ${MAX_ARCHIVE_FILES} 个）`);
        }
        totalBytes += info.size;
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error(`配方总大小超过上限（最大 ${Math.round(MAX_UNCOMPRESSED_BYTES / (1024 * 1024))} MB）`);
        }
        const rel = normalizeZipPath(relative(rootDir, full).split(sep).join('/'));
        files.push({ path: rel, data: await readFile(full) });
      }
    }
  }

  await walk(rootDir);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function unwrapSingleTopDir(entries: LoadedFile[]): LoadedFile[] {
  const cleaned = entries.filter(e => !isOsJunk(e.path));
  if (cleaned.some(e => e.path === MANIFEST_FILENAME)) return cleaned;
  const firstSegments = new Set(cleaned.map(e => e.path.split('/')[0]));
  if (firstSegments.size === 1) {
    const prefix = `${[...firstSegments][0]!}/`;
    if (cleaned.some(e => e.path === `${prefix}${MANIFEST_FILENAME}`)) {
      return cleaned
        .filter(e => e.path.startsWith(prefix) && e.path.length > prefix.length)
        .map(e => ({ path: normalizeZipPath(e.path.slice(prefix.length)), data: e.data }));
    }
  }
  return cleaned;
}

async function loadRawEntries(source: string, sourceUrl?: string): Promise<{ sourceKind: TemplateSourceKind; files: LoadedFile[] }> {
  const resolved = resolve(source);
  const info = await stat(resolved).catch(() => {
    throw new Error(`找不到配方路径：${source}`);
  });
  if (info.isFile()) {
    if (info.size > MAX_ARCHIVE_BYTES) {
      throw new Error(`压缩包体积超过上限（最大 ${Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024))} MB）`);
    }
    const raw = await readFile(resolved);
    const entries = unwrapSingleTopDir(readZip(raw));
    return { sourceKind: 'zip', files: entries };
  }
  if (info.isDirectory()) {
    const entries = unwrapSingleTopDir(await readDirectoryFiles(resolved));
    const kind: TemplateSourceKind = sourceUrl && /github\.com/i.test(sourceUrl) ? 'github' : 'dir';
    return { sourceKind: kind, files: entries };
  }
  throw new Error(`不支持的配方路径类型：${source}`);
}

function parseLoadedPackage(sourceKind: TemplateSourceKind, files: LoadedFile[]): ParsedTemplatePackage {
  const manifestEntry = files.find(f => f.path === MANIFEST_FILENAME);
  if (!manifestEntry) {
    throw new Error(`缺少必需的清单文件 ${MANIFEST_FILENAME}`);
  }
  const rawManifestText = manifestEntry.data.toString('utf8');
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawManifestText);
  } catch (err) {
    throw new Error(`${MANIFEST_FILENAME} 不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = templateManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('；');
    throw new Error(`${MANIFEST_FILENAME} 校验失败：${detail}`);
  }
  const manifest = parsed.data;
  const hasWorkspaceDir = files.some(f => f.path.startsWith('workspace/'));
  const layout: TemplateLayout = hasWorkspaceDir ? 'standard' : 'repo-root';

  const skillBuckets = new Map<string, Map<string, Buffer>>();
  const addSkillFile = (skillName: string, innerPath: string, data: Buffer, priority: boolean) => {
    let bucket = skillBuckets.get(skillName);
    if (!bucket) {
      bucket = new Map();
      skillBuckets.set(skillName, bucket);
    }
    if (priority || !bucket.has(innerPath)) bucket.set(innerPath, data);
  };

  const workspaceFiles: LoadedFile[] = [];
  let readme: Buffer | undefined;

  for (const file of files) {
    if (file.path === MANIFEST_FILENAME) continue;
    if (file.path === 'README.md') {
      readme = file.data;
      if (layout === 'repo-root') workspaceFiles.push({ path: file.path, data: file.data });
      continue;
    }

    const skillMatch = isSkillPath(file.path);
    if (skillMatch) {
      // Top-level `skills/` takes priority over `.agents/skills/` or `.claude/skills/` duplicates.
      addSkillFile(skillMatch.skillName, skillMatch.innerPath, file.data, skillMatch.root === 'skills');
      continue;
    }

    if (layout === 'standard') {
      if (file.path.startsWith('workspace/')) {
        const inner = file.path.slice('workspace/'.length);
        if (inner) {
          const cleanInner = normalizeZipPath(inner);
          if (isForbiddenWorkspacePath(cleanInner)) {
            throw new Error(`工作区不允许包含可执行环境配置或隐藏内部文件：${cleanInner}`);
          }
          workspaceFiles.push({ path: cleanInner, data: file.data });
        }
      } else if (isForbiddenWorkspacePath(file.path)) {
        throw new Error(`配方包不允许包含可执行环境配置或隐藏内部文件：${file.path}`);
      }
    } else {
      if (isForbiddenWorkspacePath(file.path)) {
        throw new Error(`工作区不允许包含可执行环境配置或隐藏内部文件：${file.path}`);
      }
      workspaceFiles.push({ path: file.path, data: file.data });
    }
  }

  // Only keep valid skill folders containing `SKILL.md`.
  const skills = new Map<string, LoadedFile[]>();
  for (const [name, bucket] of [...skillBuckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!bucket.has('SKILL.md')) continue;
    const entries = [...bucket.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, data]) => ({ path, data }));
    skills.set(name, entries);
  }

  workspaceFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { sourceKind, layout, manifest, rawManifestText, readme, skills, workspaceFiles, allFiles: files };
}

function hasEffectiveCapability(pkg: ParsedTemplatePackage): boolean {
  if (pkg.skills.size > 0) return true;
  if (pkg.workspaceFiles.some(f => f.path !== 'README.md' && f.path !== '.gitignore')) return true;
  const group = effectiveGroupSpec(pkg.manifest);
  if (group.role?.trim()) return true;
  return false;
}

function checkSignature(pkg: ParsedTemplatePackage): SignatureStatus {
  const { manifest } = pkg;
  if (!manifest.promoSignature || !manifest.author.publicKey) return 'unsigned';
  if (!isPublicTemplate(manifest)) return 'invalid';
  const promo = buildPublicPromoPayload(manifest, [...pkg.skills.keys()]);
  return verifyPromoPayload(promo, manifest.promoSignature) ? 'valid' : 'invalid';
}

export async function inspectTemplate(source: string, options: { sourceUrl?: string } = {}): Promise<InspectResult> {
  const { sourceKind, files } = await loadRawEntries(source, options.sourceUrl);
  const pkg = parseLoadedPackage(sourceKind, files);
  const { manifest } = pkg;
  const group = effectiveGroupSpec(manifest);
  const docUrl = effectiveDocUrl(manifest);
  const signatureStatus = checkSignature(pkg);
  const capable = hasEffectiveCapability(pkg);
  const warnings: string[] = [];

  if (!capable) {
    warnings.push('配方不包含有效 Skill、预置工作区文件或本群角色（空壳配方无法对外发布）');
  }
  if (signatureStatus === 'invalid') {
    warnings.push('公开宣传签名校验失败：清单内容可能已被修改');
  }
  if (isPublicTemplate(manifest) && !docUrl) {
    warnings.push('已标记 public=true，但缺少宣传文档链接（docUrl）');
  }
  if (group.recommendedPermission === 'full') {
    warnings.push('配方建议「完全访问」权限，仅限个人私密群使用；多人已有群请勿直接提权');
  }

  const skillMetaByName = new Map((manifest.skills ?? []).map(s => [s.name, s]));
  const skills = [...pkg.skills.entries()].map(([name, entries]) => {
    const meta = skillMetaByName.get(name);
    return {
      name,
      setup: /setup/i.test(name),
      files: entries.length,
      ...(meta?.title ? { title: meta.title } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
    };
  });

  return {
    sourceKind,
    layout: pkg.layout,
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    summary: manifest.summary,
    public: isPublicTemplate(manifest),
    ...(docUrl ? { docUrl } : {}),
    ...(manifest.installHint ? { installHint: manifest.installHint } : {}),
    author: manifest.author,
    pricing: effectivePricing(manifest),
    acquisition: effectiveAcquisition(manifest),
    ...(manifest.license ? { license: manifest.license } : {}),
    credits: manifest.credits ?? [],
    prerequisites: manifest.prerequisites ?? [],
    group,
    skills,
    workspaceFiles: pkg.workspaceFiles.map(f => f.path),
    signatureStatus,
    hasEffectiveCapability: capable,
    warnings,
  };
}

async function ensureSafeDestDir(destDir: string): Promise<string> {
  const resolved = resolve(destDir);
  try {
    const info = await lstat(resolved);
    if (info.isSymbolicLink()) throw new Error(`目标目录不能是符号链接：${destDir}`);
    if (!info.isDirectory()) throw new Error(`目标路径不是目录：${destDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    await mkdir(resolved, { recursive: true });
  }
  return realpath(resolved);
}

/**
 * Walk every path component under `rootDir` using `lstat` so symlinks or Windows junctions inside
 * an existing merge target can never redirect reads or writes outside `rootDir`.
 */
async function assertNoSymlinksAlongPath(rootDir: string, cleanRel: string): Promise<string> {
  const parts = cleanRel.split('/');
  let cursor = rootDir;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    if (!cursor.startsWith(rootDir + sep)) {
      throw new Error(`目标路径越界：${cleanRel}`);
    }
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`目标路径包含符号链接，已拒绝读写：${parts.slice(0, i + 1).join('/')}`);
      }
      const isLast = i === parts.length - 1;
      if (!isLast && !info.isDirectory()) {
        throw new Error(`目标父路径不是目录：${parts.slice(0, i + 1).join('/')}`);
      }
      if (isLast && !info.isFile()) {
        throw new Error(`目标路径不是普通文件：${cleanRel}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') break;
      throw err;
    }
  }
  return resolve(rootDir, ...parts);
}

async function ensureSafeParentDirs(rootDir: string, cleanRel: string): Promise<string> {
  const parts = cleanRel.split('/');
  let cursor = rootDir;
  for (let i = 0; i < parts.length - 1; i++) {
    cursor = join(cursor, parts[i]!);
    if (!cursor.startsWith(rootDir + sep)) throw new Error(`写入路径越界：${cleanRel}`);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`目标父目录异常或为符号链接：${parts.slice(0, i + 1).join('/')}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      await mkdir(cursor);
    }
  }
  return resolve(rootDir, ...parts);
}

async function writeSafeFile(rootDir: string, relPath: string, data: Buffer, options: { exclusive?: boolean } = {}): Promise<string> {
  const cleanRel = normalizeZipPath(relPath);
  await assertNoSymlinksAlongPath(rootDir, cleanRel);
  const full = await ensureSafeParentDirs(rootDir, cleanRel);
  if (!full.startsWith(rootDir + sep)) {
    throw new Error(`写入路径越界：${relPath}`);
  }
  if (options.exclusive) {
    await writeFile(full, data, { flag: 'wx' });
    return full;
  }
  const tmp = join(dirname(full), `.vonvon-stage-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(tmp, data, { flag: 'wx' });
    await assertNoSymlinksAlongPath(rootDir, cleanRel);
    await rename(tmp, full);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  return full;
}

export async function extractTemplate(source: string, destDir: string, options: { sourceUrl?: string } = {}): Promise<ExtractResult> {
  const { sourceKind, files } = await loadRawEntries(source, options.sourceUrl);
  const pkg = parseLoadedPackage(sourceKind, files);
  const dest = await ensureSafeDestDir(destDir);
  const existing = await readdir(dest);
  if (existing.length > 0) {
    throw new Error(`解包目标目录非空（请指定空目录）：${dest}`);
  }
  for (const file of pkg.allFiles) {
    await writeSafeFile(dest, file.path, file.data);
  }
  return {
    dest,
    filesWritten: pkg.allFiles.length,
    manifestPath: join(dest, MANIFEST_FILENAME),
    id: pkg.manifest.id,
    version: pkg.manifest.version,
  };
}

async function readInstalledMeta(dest: string): Promise<InstalledTemplatesFile> {
  const file = await assertNoSymlinksAlongPath(dest, INSTALLED_META_FILENAME);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const parsed = installedTemplatesFileSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  return { schemaVersion: 1, templates: [] };
}

async function writeInstalledMeta(dest: string, record: InstalledTemplateRecord): Promise<string> {
  const current = await readInstalledMeta(dest);
  const filtered = current.templates.filter(
    item => !(item.id === record.id && (item.authorPublicKey ?? '') === (record.authorPublicKey ?? '')),
  );
  const next: InstalledTemplatesFile = {
    schemaVersion: 1,
    templates: [...filtered, record],
  };
  return writeSafeFile(dest, INSTALLED_META_FILENAME, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'));
}

async function fileMatches(rootDir: string, cleanRel: string, expected: Buffer): Promise<'missing' | 'same' | 'different'> {
  const parts = cleanRel.split('/');
  let cursor = rootDir;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    if (!cursor.startsWith(rootDir + sep)) {
      throw new Error(`目标路径越界：${cleanRel}`);
    }
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`目标路径包含符号链接，已拒绝读写：${parts.slice(0, i + 1).join('/')}`);
      }
      const isLast = i === parts.length - 1;
      if (!isLast && !info.isDirectory()) return 'different';
      if (isLast && !info.isFile()) return 'different';
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing';
      throw err;
    }
  }
  const fullPath = resolve(rootDir, ...parts);
  try {
    const current = await readFile(fullPath);
    return current.equals(expected) ? 'same' : 'different';
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing';
    throw err;
  }
}

export async function stageTemplate(
  source: string,
  destDir: string,
  options: {
    mode?: 'fresh' | 'merge';
    updateSkills?: boolean;
    sourceUrl?: string;
    noTelemetry?: boolean;
    dataRoot?: string;
    env?: NodeJS.ProcessEnv;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<StageResult> {
  const mode = options.mode ?? 'fresh';
  const { sourceKind, files } = await loadRawEntries(source, options.sourceUrl);
  const pkg = parseLoadedPackage(sourceKind, files);
  const dest = await ensureSafeDestDir(destDir);

  if (mode === 'fresh') {
    const existing = (await readdir(dest)).filter(name => name !== '.DS_Store' && name !== 'Thumbs.db');
    if (existing.length > 0) {
      throw new Error(`目标工作区非空，fresh 模式拒绝覆写已有文件（如需增量合并请用 --mode merge）：${dest}`);
    }
  }

  // Pre-scan all workspace files and skills before writing anything so symlink or type errors
  // never leave partial mutations behind.
  const workspacePlan: { file: LoadedFile; status: 'missing' | 'same' | 'different' }[] = [];
  for (const file of pkg.workspaceFiles) {
    const status = await fileMatches(dest, file.path, file.data);
    workspacePlan.push({ file, status });
  }

  const skillTargets = ['.agents/skills', '.claude/skills'] as const;
  const skillPlan: { skillName: string; skillFiles: LoadedFile[]; existed: boolean; hasDiff: boolean }[] = [];
  for (const [skillName, skillFiles] of pkg.skills.entries()) {
    let existed = false;
    let hasDiff = false;
    for (const root of skillTargets) {
      for (const sf of skillFiles) {
        const rel = `${root}/${skillName}/${sf.path}`;
        const status = await fileMatches(dest, rel, sf.data);
        if (status !== 'missing') existed = true;
        if (status === 'different') hasDiff = true;
      }
    }
    skillPlan.push({ skillName, skillFiles, existed, hasDiff });
  }

  const writtenWorkspaceFiles: string[] = [];
  const conflictingWorkspaceFiles: string[] = [];

  for (const { file, status } of workspacePlan) {
    if (status === 'missing') {
      await writeSafeFile(dest, file.path, file.data, { exclusive: true });
      writtenWorkspaceFiles.push(file.path);
    } else if (status === 'different') {
      conflictingWorkspaceFiles.push(file.path);
    }
  }

  const addedSkills: string[] = [];
  const updatedSkills: string[] = [];
  const conflictingSkills: string[] = [];

  for (const { skillName, skillFiles, existed, hasDiff } of skillPlan) {
    if (existed && hasDiff && !options.updateSkills) {
      conflictingSkills.push(skillName);
      continue;
    }

    for (const root of skillTargets) {
      for (const sf of skillFiles) {
        await writeSafeFile(dest, `${root}/${skillName}/${sf.path}`, sf.data);
      }
    }
    if (!existed) addedSkills.push(skillName);
    else if (hasDiff) updatedSkills.push(skillName);
  }

  const docUrl = effectiveDocUrl(pkg.manifest);
  const installedMetaPath = await writeInstalledMeta(dest, {
    id: pkg.manifest.id,
    ...(pkg.manifest.author.publicKey ? { authorPublicKey: pkg.manifest.author.publicKey } : {}),
    version: pkg.manifest.version,
    ...(options.sourceUrl ?? pkg.manifest.repository ? { sourceUrl: options.sourceUrl ?? pkg.manifest.repository } : {}),
    ...(docUrl ? { docUrl } : {}),
    skills: [...pkg.skills.keys()],
    installedAt: new Date().toISOString(),
  });

  let telemetry: InstallReportResult = { attempted: false, ok: false, reason: 'not_public' };
  if (isPublicTemplate(pkg.manifest)) {
    const promo = buildPublicPromoPayload(pkg.manifest, [...pkg.skills.keys()]);
    telemetry = await reportTemplateInstall(promo, pkg.manifest.promoSignature, sourceKind, {
      dataRoot: options.dataRoot,
      env: options.env,
      noTelemetry: options.noTelemetry,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
  }

  return {
    dest,
    mode,
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    writtenWorkspaceFiles,
    conflictingWorkspaceFiles,
    addedSkills,
    updatedSkills,
    conflictingSkills,
    installedMetaPath,
    telemetry,
  };
}

export class PackRedactionError extends Error {
  readonly findings: readonly RedactionFinding[];
  constructor(findings: readonly RedactionFinding[]) {
    const lines = findings.slice(0, 10).map(f => `- ${f.file}${f.line ? `:${f.line}` : ''}：${f.message} (${f.rule})`);
    super(`脱敏检查未通过，已拒绝打包：\n${lines.join('\n')}${findings.length > 10 ? `\n…共 ${findings.length} 处问题` : ''}`);
    this.name = 'PackRedactionError';
    this.findings = findings;
  }
}

export async function packTemplate(
  sourceDir: string,
  outFile: string,
  options: {
    publish?: boolean;
    fetchCover?: boolean;
    dataRoot?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PackResult> {
  const resolvedDir = resolve(sourceDir);
  const info = await stat(resolvedDir).catch(() => {
    throw new Error(`找不到配方草稿目录：${sourceDir}`);
  });
  if (!info.isDirectory()) throw new Error(`打包源必须是目录：${sourceDir}`);

  const rawFiles = unwrapSingleTopDir(await readDirectoryFiles(resolvedDir));
  const pkg = parseLoadedPackage('dir', rawFiles);

  if (!hasEffectiveCapability(pkg)) {
    throw new Error('配方必须至少包含 1 个有效 Skill、预置工作区文件或本群角色（role），拒绝打包空壳配方');
  }

  const publicFlag = isPublicTemplate(pkg.manifest);
  const docUrl = effectiveDocUrl(pkg.manifest);
  if (publicFlag && !docUrl) {
    throw new Error('公开宣传配方（public=true）必须提供宣传文档链接（docUrl），请在 vonvon-bot.json 中补充后重试');
  }
  if (options.publish && !publicFlag) {
    throw new Error('当前配方未开启公开宣传（public=false），无法执行 --publish；如需在 Vonvon 灵感 Club 展示宣传文档，请先将 public 设为 true');
  }

  // Canonicalize into clean standard `.vonvon.zip` layout:
  // top-level `vonvon-bot.json`, optional `README.md`, top-level `skills/<name>/...`, optional `workspace/...`.
  // Only public packs receive a signed publication grant (`promoSignature`); private packs never carry one.
  const skillNames = [...pkg.skills.keys()];
  const authorKey = await loadOrCreateAuthorKey(options.dataRoot ?? paths.appDir);
  const promo = publicFlag ? buildPublicPromoPayload(pkg.manifest, skillNames, authorKey.publicKey) : undefined;
  const promoSignature = promo ? signPromoPayload(promo, authorKey.privateKeyPem) : undefined;

  const { promoSignature: _oldSig, ...manifestWithoutSig } = pkg.manifest;
  const signedManifest: TemplateManifest = {
    ...manifestWithoutSig,
    public: publicFlag,
    author: {
      ...pkg.manifest.author,
      publicKey: authorKey.publicKey,
    },
    ...(promoSignature ? { promoSignature } : {}),
  };

  const archiveFiles: LoadedFile[] = [
    { path: MANIFEST_FILENAME, data: Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`, 'utf8') },
  ];
  if (pkg.readme) {
    archiveFiles.push({ path: 'README.md', data: pkg.readme });
  }
  for (const [skillName, skillEntries] of pkg.skills.entries()) {
    for (const entry of skillEntries) {
      archiveFiles.push({ path: `skills/${skillName}/${entry.path}`, data: entry.data });
    }
  }
  let workspaceFileCount = 0;
  for (const wf of pkg.workspaceFiles) {
    // Avoid duplicating README.md into workspace/ when coming from repo-root layout.
    if (pkg.layout === 'repo-root' && wf.path === 'README.md') continue;
    archiveFiles.push({ path: `workspace/${wf.path}`, data: wf.data });
    workspaceFileCount++;
  }

  const findings = scanFilesForSecrets(archiveFiles);
  if (findings.length > 0) {
    throw new PackRedactionError(findings);
  }

  const zipBytes = createZip(archiveFiles);
  if (zipBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`打包后的压缩包体积超过上限（最大 ${Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024))} MB）`);
  }
  const resolvedOut = resolve(outFile);
  await mkdir(dirname(resolvedOut), { recursive: true });
  const tmp = `${resolvedOut}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, zipBytes);
  await rename(tmp, resolvedOut);

  const sha256 = createHash('sha256').update(zipBytes).digest('hex');

  let publish: PublishResult | undefined;
  if (options.publish && promo && promoSignature) {
    let cover: { bytes: Uint8Array; signature: string } | undefined;
    if (options.fetchCover !== false && !options.fetchImpl) {
      const coverBytes = await fetchLocalFeishuCover(docUrl, options.dataRoot ?? paths.appDir);
      if (coverBytes && docUrl) {
        cover = {
          bytes: coverBytes,
          signature: signCoverBytes(promo.id, promo.version, docUrl, authorKey.publicKey, coverBytes, authorKey.privateKeyPem),
        };
      }
    }
    publish = await publishTemplatePromo(promo, promoSignature, {
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      ...(cover ? { cover } : {}),
    });
  }

  return {
    out: resolvedOut,
    id: signedManifest.id,
    version: signedManifest.version,
    public: publicFlag,
    ...(docUrl ? { docUrl } : {}),
    authorPublicKey: authorKey.publicKey,
    sha256,
    sizeBytes: zipBytes.length,
    skillNames,
    workspaceFileCount,
    ...(publish ? { publish } : {}),
  };
}

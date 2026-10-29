import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { paths } from '../config/paths';
import { REASONING_EFFORTS, type ModelInfo } from '../agent/types';
import { OFFLINE_CODEX_MODELS } from '../agent/codex-appserver/backend';
import { OFFLINE_CLAUDE_MODELS } from '../agent/claude-agent/backend';
import { createBackend } from '../agent';
import type { AgentBackend } from '../agent/types';

/** Discover native models without a Bot. A backend's listModels may return its static fallback on failure;
 * only peekModels is populated after a successful provider discovery. */
export async function discoverProviderModels(backendId: 'codex-appserver' | 'claude-agent', backendFor: (id: string) => AgentBackend = createBackend): Promise<{ models: ModelInfo[]; message?: string }> {
  try {
    const backend = backendFor(backendId);
    if (!(await backend.doctor({ force: true })).ok) return { models: [], message: 'Provider 尚未安装或无法运行。' };
    await backend.listModels();
    const models = backend.peekModels?.();
    if (!models?.length) return { models: [], message: '暂时无法读取 Provider 实时模型列表。' };
    return { models };
  } catch {
    return { models: [], message: '暂时无法读取 Provider 实时模型列表。' };
  }
}
const model = z.object({ id: z.string().min(1).max(1000), displayName: z.string(), description: z.string(), hidden: z.boolean(), isDefault: z.boolean(), supportedEfforts: z.array(z.enum(REASONING_EFFORTS)), defaultEffort: z.enum(REASONING_EFFORTS), serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).optional() });
const snapshot = z.object({ backend: z.string(), observedAt: z.string(), models: z.array(model).max(1000) });
const pathFor = (backend: string) => join(paths.appDir, 'model-catalog', `${createHash('sha256').update(backend).digest('hex').slice(0, 24)}.json`);
async function readJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid model metadata'); return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
/** Observed model metadata only; never account tokens or provider settings. */
export async function rememberModelCatalog(backend: string, models: ModelInfo[], observedAt: string): Promise<void> {
  const value = snapshot.parse({ backend, models, observedAt });
  const file = pathFor(backend); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { const handle = await open(temp, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(value)); } finally { await handle.close(); } await rename(temp, file); }
  finally { await unlink(temp).catch(() => undefined); }
}
export async function offlineModelCatalog(backend: string): Promise<{ models: ModelInfo[]; observedAt: string; message: string }> {
  try {
    const cached = snapshot.parse(await readJson(pathFor(backend)));
    if (cached.backend === backend && cached.models.length) return { models: cached.models.map(({serviceTiers: _tiers, ...model}) => model), observedAt: cached.observedAt, message: '使用本机保存的模型目录，启动后可刷新' };
  } catch { /* a missing or malformed cache never causes a provider launch */ }
  if (backend === 'codex-appserver') {
    try {
      const data = await readJson(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json')) as { fetched_at?: string; models?: Array<Record<string, unknown>> };
      const models = (data.models ?? []).flatMap(raw => {
        const id = typeof raw.slug === 'string' ? raw.slug : raw.id;
        const efforts = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels.map(v => typeof v === 'object' && v ? (v as Record<string, unknown>).effort : undefined).filter(v => REASONING_EFFORTS.includes(v as never)) : [];
        const parsed = model.safeParse({ id, displayName: raw.display_name ?? id, description: raw.description ?? '', hidden: raw.visibility === 'hide', isDefault: false, supportedEfforts: efforts, defaultEffort: raw.default_reasoning_level ?? efforts[0] ?? 'medium' });
        return parsed.success ? [parsed.data] : [];
      });
      if (models.length) return { models, observedAt: data.fetched_at ?? '', message: '使用 Codex 本机模型缓存，启动后可刷新' };
    } catch { /* use the provider integration's existing fallback below */ }
  }
  return { models: backend === 'codex-appserver' ? OFFLINE_CODEX_MODELS : backend === 'claude-agent' ? OFFLINE_CLAUDE_MODELS : [], observedAt: '', message: '内置模型列表，尚未验证本机可用性；启动后可刷新' };
}

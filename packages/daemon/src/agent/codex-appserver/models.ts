import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { REASONING_EFFORTS, type ModelInfo, type ReasoningEffort } from '../types';
import { binFingerprint, withModelDiscoveryClient } from './client-pool';

interface RawModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: ReasoningEffort }[];
  defaultReasoningEffort?: ReasoningEffort;
}

interface ModelConfig {
  model?: string | null;
  model_reasoning_effort?: ReasoningEffort | null;
  model_catalog_json?: string | null;
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

function fileVersion(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return 'missing'; }
}

/** Config/auth contents never enter the cache key or logs. A changed catalog
 * invalidates even when config.toml still points at the same file. */
export function codexModelCacheKey(bin: string, catalogPath?: string): string {
  const home = codexHome();
  return JSON.stringify([bin, binFingerprint(bin), home,
    fileVersion(join(home, 'config.toml')), fileVersion(join(home, 'auth.json')),
    catalogPath, catalogPath ? fileVersion(catalogPath) : '']);
}

function mapModel(model: RawModel): ModelInfo {
  return {
    // Native picker IDs and the model sent to inference need not be identical.
    id: model.model || model.id,
    displayName: model.displayName ?? model.model ?? model.id,
    description: model.description ?? '',
    hidden: model.hidden ?? false,
    isDefault: model.isDefault ?? false,
    supportedEfforts: (model.supportedReasoningEfforts ?? []).map(effort => effort.reasoningEffort),
    defaultEffort: model.defaultReasoningEffort ?? 'medium',
  };
}

/** The CLI displays its configured current model separately from its catalog.
 * model/list alone can omit it and mark a different catalog default. */
function withConfiguredModel(models: ModelInfo[], config: ModelConfig): ModelInfo[] {
  const configured = config.model?.trim();
  if (!configured) return models;
  const hit = models.find(model => model.id === configured);
  const effort = REASONING_EFFORTS.find(value => value === config.model_reasoning_effort);
  const row: ModelInfo = hit ? { ...hit, isDefault: true, hidden: false,
    ...(effort && hit.supportedEfforts.includes(effort) ? { defaultEffort: effort } : {}) }
    : { id: configured, displayName: configured, description: '来自本机 Codex 配置',
        isDefault: true, hidden: false, supportedEfforts: [], defaultEffort: effort ?? 'medium' };
  return [row, ...models.filter(model => model !== hit).map(model => ({ ...model, isDefault: false }))];
}

export async function discoverCodexModels(bin: string): Promise<{ models: ModelInfo[]; catalogPath?: string }> {
  return withModelDiscoveryClient(bin, async client => {
    const reply = await client.request<{ config?: ModelConfig }>('config/read', { includeLayers: false, cwd: homedir() });
    const config = reply.config ?? {};
    const path = config.model_catalog_json;
    const catalogPath = path ? path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(codexHome(), path) : undefined;
    const catalogVersion = catalogPath ? fileVersion(catalogPath) : undefined;
    const models = new Map<string, ModelInfo>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.request<{ data?: RawModel[]; nextCursor?: string | null }>('model/list', { limit: 50, ...(cursor ? { cursor } : {}) });
      for (const raw of page.data ?? []) {
        const model = mapModel(raw);
        models.set(model.id, model);
      }
      cursor = page.nextCursor || undefined;
      if ((cursor && cursors.has(cursor)) || models.size > 1000 || cursors.size >= 100) throw new Error('Invalid Codex model catalog pagination');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const discovered = withConfiguredModel([...models.values()], config);
    if (discovered.length > 1000 || (catalogPath && fileVersion(catalogPath) !== catalogVersion)) throw new Error('Codex model catalog changed during discovery');
    return { models: discovered, ...(catalogPath ? { catalogPath } : {}) };
  });
}

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelInfo, ReasoningEffort } from '../types';
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
  serviceTiers?: { id: string; name: string; description: string }[];
  /** Older Codex catalogs predate serviceTiers. */
  additionalSpeedTiers?: string[];
}

interface ModelConfig {
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
    ...(model.serviceTiers ? { serviceTiers: model.serviceTiers } :
      model.additionalSpeedTiers?.length ? { serviceTiers: model.additionalSpeedTiers.map(id => ({ id, name: id, description: '' })) } : {}),
  };
}

/** Mirror the CLI /model catalog: fetch native presets, hide non-picker rows,
 * and preserve native order, names, capabilities and default flags. A current
 * config.model that is absent from the picker must not become an extra choice. */
export async function discoverCodexModels(bin: string): Promise<{ models: ModelInfo[]; catalogPath?: string }> {
  return withModelDiscoveryClient(bin, async client => {
    const reply = await client.request<{ config?: ModelConfig }>('config/read', { includeLayers: false, cwd: homedir() });
    const config = reply.config ?? {};
    const path = config.model_catalog_json;
    const catalogPath = path ? path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(codexHome(), path) : undefined;
    const catalogVersion = catalogPath ? fileVersion(catalogPath) : undefined;
    const models: ModelInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      // The TUI also fetches hidden rows and applies !hidden before rendering.
      const page = await client.request<{ data?: RawModel[]; nextCursor?: string | null }>('model/list', { limit: 50, includeHidden: true, ...(cursor ? { cursor } : {}) });
      for (const raw of page.data ?? []) {
        if (!raw.hidden) models.push(mapModel(raw));
      }
      cursor = page.nextCursor || undefined;
      if ((cursor && cursors.has(cursor)) || models.length > 1000 || cursors.size >= 100) throw new Error('Invalid Codex model catalog pagination');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (catalogPath && fileVersion(catalogPath) !== catalogVersion) throw new Error('Codex model catalog changed during discovery');
    return { models, ...(catalogPath ? { catalogPath } : {}) };
  });
}

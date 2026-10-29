import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelInfo, ReasoningEffort } from '../types';
import { binFingerprint, withModelDiscoveryClient } from './client-pool';
import { codexVersionAsync } from './locate';

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
  model_provider?: string;
  model_providers?: Record<string, unknown>;
  cli_auth_credentials_store?: string;
  features?: Record<string, boolean>;
}

type Requirements = { requirements?: { featureRequirements?: Record<string, boolean> | null } | null; supportsIndependentSpeedModes?: boolean };
type RemoteCatalog = { fetched_at: string; client_version: string; identity: string; models: { slug: string; service_tiers?: RawModel['serviceTiers']; additional_speed_tiers?: string[] }[] };
export const MODEL_CATALOG_TTL_MS = 300_000;

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

export function codexRemoteCacheKey(): string {
  return fileVersion(join(codexHome(), 'models_cache.json'));
}

function officialRouting(config: ModelConfig): boolean {
  const provider = config.model_provider ?? 'openai';
  return !config.model_catalog_json && provider === 'openai' && !config.model_providers?.[provider];
}

function enabledTier(id: string, config: ModelConfig, requirements: Requirements): boolean {
  const flags = requirements.requirements?.featureRequirements ?? {};
  const fast = config.features?.fast_mode !== false && flags.fast_mode !== false;
  return id === 'fast' ? fast : config.features?.ultrafast_mode !== false && flags.ultrafast_mode !== false
    && (requirements.supportsIndependentSpeedModes === true || fast);
}

/** Project config can narrow global account access, never expand it. */
export async function constrainCodexModelTiers(bin: string, models: ModelInfo[], cwd: string): Promise<ModelInfo[]> {
  const ordinary = () => models.map(({ serviceTiers: _tiers, ...model }) => model);
  if (!models.some(model => model.serviceTiers?.length)) return models;
  try {
    return await withModelDiscoveryClient(bin, async client => {
      const reply = await client.request<{config?: ModelConfig}>('config/read', {includeLayers: false, cwd});
      const requirements = await client.request<Requirements>('configRequirements/read');
      if (!reply.config || !Object.hasOwn(requirements, 'requirements')) throw new Error('Unconfirmed session configuration');
      if (!officialRouting(reply.config)) return ordinary();
      return models.map(model => ({ ...model, serviceTiers: model.serviceTiers?.filter(tier => enabledTier(tier.id, reply.config!, requirements)) }));
    });
  } catch { throw new Error('无法确认会话的加速权限'); }
}

/** A bundled/offline catalog is model capability data, not account access.
 * Native caches are account-bound; also reject entries older than this login,
 * keychain-only auth, custom catalogs, and custom OpenAI routes. Never read tokens. */
function remoteCatalog(config: ModelConfig, version: string | null): RemoteCatalog | undefined {
  if (!officialRouting(config)
    || !version || (config.cli_auth_credentials_store && config.cli_auth_credentials_store !== 'file')) return;
  let fd: number | undefined;
  try {
    const auth = statSync(join(codexHome(), 'auth.json'));
    if (!auth.isFile()) return;
    fd = openSync(join(codexHome(), 'models_cache.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return;
    const cache = JSON.parse(readFileSync(fd, 'utf8')) as RemoteCatalog;
    const fetched = Date.parse(cache.fetched_at);
    if (!Number.isFinite(fetched) || fetched > Date.now() + 1000 || Date.now() - fetched >= MODEL_CATALOG_TTL_MS
      || fetched < Math.floor(Math.max(auth.mtimeMs, auth.ctimeMs))
      || cache.client_version !== version.match(/\b\d+\.\d+\.\d+\b/)?.[0] || typeof cache.identity !== 'string' || !cache.identity
      || !Array.isArray(cache.models)) return;
    return cache;
  } catch { return; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function normalizedTiers(model: Pick<RawModel, 'serviceTiers' | 'additionalSpeedTiers'>): NonNullable<ModelInfo['serviceTiers']> {
  const tiers = model.serviceTiers ?? model.additionalSpeedTiers?.map(id => ({ id, name: id, description: '' })) ?? [];
  return tiers.flatMap(tier => tier.id === 'priority' || tier.id === 'fast'
    ? [{ ...tier, id: 'fast', name: 'Fast' }]
    : tier.id === 'ultrafast' ? [{ ...tier, name: 'Ultrafast' }] : []);
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

/** Mirror the CLI /model catalog: fetch native presets, hide non-picker rows,
 * and preserve native order, names, capabilities and default flags. A current
 * config.model that is absent from the picker must not become an extra choice. */
export async function discoverCodexModels(bin: string): Promise<{ models: ModelInfo[]; catalogPath?: string; expiresAt: number }> {
  return withModelDiscoveryClient(bin, async client => {
    const reply = await client.request<{ config?: ModelConfig }>('config/read', { includeLayers: false, cwd: homedir() });
    const config = reply.config ?? {};
    const path = config.model_catalog_json;
    const catalogPath = path ? path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(codexHome(), path) : undefined;
    const catalogVersion = catalogPath ? fileVersion(catalogPath) : undefined;
    const rawModels: RawModel[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      // The TUI also fetches hidden rows and applies !hidden before rendering.
      const page = await client.request<{ data?: RawModel[]; nextCursor?: string | null }>('model/list', { limit: 50, includeHidden: true, ...(cursor ? { cursor } : {}) });
      for (const raw of page.data ?? []) {
        if (!raw.hidden) rawModels.push(raw);
      }
      cursor = page.nextCursor || undefined;
      if ((cursor && cursors.has(cursor)) || rawModels.length > 1000 || cursors.size >= 100) throw new Error('Invalid Codex model catalog pagination');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (catalogPath && fileVersion(catalogPath) !== catalogVersion) throw new Error('Codex model catalog changed during discovery');
    let cache: RemoteCatalog | undefined;
    let requirements: Requirements | undefined;
    try {
      const account = await client.request<{ requiresOpenaiAuth?: boolean; account?: { type?: string } | null }>('account/read', { refreshToken: false });
      if (account.requiresOpenaiAuth === true && account.account?.type === 'chatgpt') {
        requirements = await client.request<Requirements>('configRequirements/read');
        if (Object.hasOwn(requirements, 'requirements')) cache = remoteCatalog(config, await codexVersionAsync(bin));
      }
    } catch { /* Unknown access never exposes an acceleration option. */ }
    const models = rawModels.map(raw => {
      const model = mapModel(raw);
      const observed = cache?.models.find(item => item.slug === model.id);
      if (!observed) return model;
      const declared = normalizedTiers({ serviceTiers: observed.service_tiers, additionalSpeedTiers: observed.additional_speed_tiers });
      model.serviceTiers = normalizedTiers(raw).filter(tier => declared.some(item => item.id === tier.id)
        && requirements && enabledTier(tier.id, config, requirements));
      return model;
    });
    return { models, ...(catalogPath ? { catalogPath } : {}), expiresAt: cache
      ? Date.parse(cache.fetched_at) + MODEL_CATALOG_TTL_MS : Date.now() + 30_000 };
  });
}

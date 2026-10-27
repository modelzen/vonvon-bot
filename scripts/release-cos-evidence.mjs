import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join } from 'node:path';

// Read-only: no upload, object mutation, CDN action, or credential output.
// Changing the pinned SDK version is a reviewed code change, never a runtime option.
export const COS_SDK_VERSION = '3.0.0';
const defaultReadJSON = async path => JSON.parse(await readFile(path, 'utf8'));

/** The stable bucket identity shared by the read-only enumeration config and the separate write config. */
export function isStableCosTarget(config) {
  return /^[a-z0-9-]+-\d+$/.test(config?.bucket ?? '') && /^[a-z]+-[a-z]+(?:-\d+)?$/.test(config?.region ?? '')
    && config.prefix === 'bot/mac/stable/' && config.publicManifestURL === 'https://dl.vonvon.cc/bot/mac/stable/manifest.json';
}

export function assertCredentialEnvNames(config) {
  for (const key of ['secretIdEnv', 'secretKeyEnv', 'securityTokenEnv']) {
    if (config[key] !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(config[key])) throw new Error('COS credential settings must be environment variable names, never inline credentials');
  }
}

export async function readCosConfig(configPath, { readJSON = defaultReadJSON } = {}) {
  if (!isAbsolute(configPath ?? '')) throw new Error('Formal releases require an absolute --cos-config file');
  let config;
  try { config = await readJSON(configPath); } catch { throw new Error('Cannot read COS read-only configuration'); }
  if (!isStableCosTarget(config) || !isAbsolute(config.ledgerFile ?? '')) throw new Error('COS configuration must identify the stable bucket, prefix, public URL and absolute ledgerFile');
  assertCredentialEnvNames(config);
  return config;
}

/** Names of the environment variables holding the read-only COS key; callers strip them from child processes. */
export const cosCredentialEnvNames = config => [config.secretIdEnv, config.secretKeyEnv, config.securityTokenEnv].filter(Boolean);

export async function loadPinnedSdk(sdkModule, readJSON = defaultReadJSON) {
  if (!isAbsolute(sdkModule ?? '') || basename(sdkModule) !== 'cos-nodejs-sdk-v5' || basename(dirname(sdkModule)) !== 'node_modules') {
    throw new Error(`Set sdkModule to the absolute node_modules/cos-nodejs-sdk-v5 directory of a tool prefix installed with cos-nodejs-sdk-v5@${COS_SDK_VERSION}`);
  }
  let manifest;
  try { manifest = await readJSON(join(sdkModule, 'package.json')); } catch { throw new Error('Cannot read the COS SDK package.json'); }
  if (manifest?.name !== 'cos-nodejs-sdk-v5' || manifest.version !== COS_SDK_VERSION) throw new Error(`sdkModule must be the pinned cos-nodejs-sdk-v5@${COS_SDK_VERSION}`);
  try { return createRequire(import.meta.url)(sdkModule); } catch { throw new Error('Cannot load the pinned COS SDK; reinstall it privately'); }
}

export async function readCosReleaseEvidence(configPath, { env = process.env, client, readJSON = defaultReadJSON, config } = {}) {
  config ??= await readCosConfig(configPath, { readJSON });
  if (!client) {
    if (!config.secretIdEnv || !config.secretKeyEnv) throw new Error('Configure COS credential environment variable names, never inline credentials');
    for (const name of cosCredentialEnvNames(config)) if (!env[name]) throw new Error('Required COS credential environment variable is unavailable');
    const COS = await loadPinnedSdk(config.sdkModule, readJSON);
    client = new COS({ SecretId: env[config.secretIdEnv], SecretKey: env[config.secretKeyEnv], ...(config.securityTokenEnv ? { SecurityToken: env[config.securityTokenEnv] } : {}), Protocol: 'https:', Timeout: 15000 });
  }
  let ledger;
  try { ledger = await readJSON(config.ledgerFile); } catch { throw new Error('A readable local publication ledger is required, including for first release'); }
  if (!Array.isArray(ledger.versions) || ledger.versions.some(v => typeof v !== 'string')) throw new Error('Publication ledger requires a versions array');
  const keys = [], seen = new Set();
  let marker = '';
  do {
    const data = await new Promise((resolve, reject) => client.getBucket({ Bucket: config.bucket, Region: config.region, Prefix: config.prefix, Marker: marker, MaxKeys: 1000 }, (error, result) => error ? reject(new Error('COS prefix enumeration failed; inspect credentials privately')) : resolve(result)));
    if (!Array.isArray(data.Contents) || !['true', 'false', true, false].includes(data.IsTruncated)) throw new Error('COS returned an incomplete or unrecognized listing');
    for (const item of data.Contents) {
      if (typeof item.Key !== 'string' || !item.Key.startsWith(config.prefix)) throw new Error('COS listing escaped the stable prefix');
      keys.push(item.Key);
    }
    if (data.IsTruncated === true || data.IsTruncated === 'true') {
      const next = data.NextMarker;
      if (typeof next !== 'string' || !next || seen.has(next) || next === marker) throw new Error('COS listing pagination did not advance');
      seen.add(next); marker = next;
    } else marker = '';
  } while (marker);
  const versions = [...ledger.versions];
  for (const key of keys) {
    const name = key.slice(config.prefix.length);
    const match = /^(?:feed-(.+)\.json|Vonvon-Bot-(.+)-universal\.(?:zip|dmg))$/.exec(name);
    if (match) versions.push(match[1] ?? match[2]);
    else if (name.startsWith('feed-') || name.startsWith('Vonvon-Bot-')) throw new Error('Unrecognized historical release object; investigate before release');
  }
  return { keys, versions, checkedAt: new Date().toISOString() };
}

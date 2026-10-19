import { API_KEY_MAX, API_KEY_SHAPE, type AdminReply, type AdminRequest, type SecretService, type SecretUse } from '@vonvon/protocol';
import { catalogBackendIds } from '../agent/catalog';
import { loadBots } from '../config/bots';
import { DataAccessError } from '../config/data-access';
import { groupBackendId } from '../config/execution';
import { getSecret, removeSecret, setSecret } from '../config/keystore';
import { botPaths } from '../config/paths';
import { loadConfig } from '../config/store';
import { log } from '../core/logger';
import { decisionProviders, type DecisionProvider } from '../judge/decision';
import { parseStoredJudge, resolveJudgeModel } from '../judge/model';
import { listProjectsIn, sessionModeOf } from '../project/registry';

/** The key page's requests (s23g): the same for the daemon's RPC and for the command line without a daemon. */
export type SecretsRequest = Extract<AdminRequest, { type: 'secrets' | 'setSecret' | 'removeSecret' | 'testSecret' }>;
export type SecretsView = Extract<AdminReply, { kind: 'secrets' }>;
export type KeyStatus = Pick<SecretService, 'status' | 'last4' | 'problem' | 'code'>;
export interface SecretsDeps {
  getSecret?: typeof getSecret;
  setSecret?: typeof setSecret;
  removeSecret?: typeof removeSecret;
  fetch?: typeof fetch;
}

/** Shorter than this, four characters are too much of it to show (Claude 定, v1-plan s23g 做法). */
const LAST4_MIN = 12;
const MASTER_KEY_GONE = 'master.key 不在了，secrets.enc 解不开。不要删 secrets.enc，里面还有 Bot 的 App Secret';
/** By the error's code, never by its words: those carry paths. */
const PROBLEMS: Record<string, string> = {
  KEYSTORE_STORE_FORMAT: 'secrets.enc 的格式不对',
  KEYSTORE_MASTER_KEY_MODE: 'master.key 不对：要是本人所有、权限 0600、32 字节的普通文件',
  KEYSTORE_MASTER_KEY_MISSING: MASTER_KEY_GONE,
  // secrets.enc itself reads as empty when it is gone, so a missing file after it is master.key
  ENOENT: MASTER_KEY_GONE,
  KEYSTORE_DECRYPT: 'secrets.enc 解不开：master.key 和它对不上',
  KEYSTORE_BUSY: '密钥库被别的进程占着，30 秒没等到',
  EACCES: '没有权限读写密钥库的文件',
  EPERM: '没有权限读写密钥库的文件',
  ENOSPC: '磁盘满了',
};

/** A keystore error as the key page and the command line say it: a fixed sentence and a short code. */
export function describeKeystoreError(error: unknown): { problem: string; code: string } {
  const own = (error as { code?: unknown } | undefined)?.code;
  const code = error instanceof DataAccessError ? 'KEYSTORE_BUSY' : typeof own === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(own) ? own : 'UNKNOWN';
  return { problem: PROBLEMS[code] ?? '密钥库读不了', code };
}

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? '';

/** Whether a key is in, by the judge's own rule (judge.ts readKey): decrypted, and as a header carries it. An
 * unreadable keystore is logged with the error's first line, which the page and the command line point to. */
export async function keyStatus(provider: Pick<DecisionProvider, 'keyId'>, read: typeof getSecret = getSecret): Promise<KeyStatus> {
  let key: string | undefined;
  try { key = await read(provider.keyId); }
  catch (error) {
    const described = describeKeystoreError(error);
    log.warn('secrets', 'unreadable', { keyId: provider.keyId, code: described.code, reason: firstLine(error) });
    return { status: 'unreadable', ...described };
  }
  if (!key) return { status: 'missing' };
  if (!API_KEY_SHAPE.test(key)) return { status: 'invalid' };
  return { status: 'set', ...(key.length >= LAST4_MIN ? { last4: key.slice(-4) } : {}) };
}

/** Why a key cannot be saved, or nothing; the words never quote it. */
export function keyProblem(value: string): string | undefined {
  if (!value) return '没有读到 key';
  if (value.length > API_KEY_MAX) return `key 太长了，最多 ${API_KEY_MAX} 个字符`;
  if (!API_KEY_SHAPE.test(value)) return 'key 只能是一串可见的英文字符，不能有空格、换行或中文';
  return undefined;
}

const stored = (value: unknown) => parseStoredJudge(value, catalogBackendIds()).value;

/**
 * Who chose each decision provider, read from every bot's files as the judge reads them (judge.ts, resolveJudgeModel):
 * the bot's default when it is one, and each group whose judgement uses one — a group's own choice, else the bot's.
 * A group outside 智能 judges nothing, so one that only follows the bot is left out; one that chose it itself is
 * listed and marked (Claude 定, v1-plan s23g 做法). A bot whose files cannot be read counts in `unreadBots`.
 */
async function keyUses(): Promise<{ uses: Map<string, SecretUse[]>; unreadBots: number }> {
  const uses = new Map<string, SecretUse[]>();
  const add = (provider: string, use: SecretUse): void => { uses.set(provider, [...uses.get(provider) ?? [], use]); };
  let unreadBots = 0;
  for (const bot of (await loadBots()).bots) {
    const files = botPaths(bot.appId);
    let read;
    try { read = await Promise.all([loadConfig(files.configFile), listProjectsIn(files.projectsFile)]); }
    catch (error) {
      unreadBots++;
      log.warn('secrets', 'bot-unreadable', { agentId: bot.appId, reason: firstLine(error) });
      continue;
    }
    const [cfg, projects] = read;
    const owner = { agentId: bot.appId, agentName: bot.botName || bot.name };
    const botJudge = stored(cfg.preferences?.judge);
    if (botJudge?.kind === 'decision') add(botJudge.provider, owner);
    for (const p of projects) {
      const groupJudge = stored(p.judge);
      // without a decision model in either layer the default small model is used, which needs no key
      if (!p.chatId || (groupJudge?.kind !== 'decision' && botJudge?.kind !== 'decision')) continue;
      const { provider, modelSource } = resolveJudgeModel(groupBackendId(p), { group: groupJudge, bot: botJudge }, undefined);
      const smart = sessionModeOf(p) === 'smart';
      if (!provider || (!smart && modelSource !== 'group')) continue;
      add(provider, { ...owner, groupId: p.chatId, groupName: p.name, ...(modelSource === 'bot' ? { inherited: true } : {}), ...(smart ? {} : { notSmart: true }) });
    }
  }
  return { uses, unreadBots };
}

/** Every service that takes a key: its state, last four and who chose it. Never the key itself. */
export async function secretsView(deps: SecretsDeps = {}): Promise<SecretsView> {
  const { uses, unreadBots } = await keyUses();
  const services: SecretService[] = [];
  for (const p of decisionProviders()) {
    const status = await keyStatus(p, deps.getSecret);
    services.push({ provider: p.id, displayName: p.displayName, keyId: p.keyId, models: p.models.map(m => ({ ...m })), ...status, inUse: uses.get(p.id) ?? [] });
  }
  return { kind: 'secrets', services, unreadBots };
}

const refused = (code: string, message: string): AdminReply => ({ kind: 'refused', code, message });
const keystoreRefused = (doing: string, keyId: string, error: unknown): AdminReply => {
  const { problem, code } = describeKeystoreError(error);
  log.warn('secrets', `${doing}-failed`, { keyId, code });
  return refused('keystore', `${problem}（${code}）`);
};

/** One key page request. Only a decision provider's key is named here; `vonvon secrets set --raw` keeps the rest. */
export async function secretsAction(request: SecretsRequest, deps: SecretsDeps = {}): Promise<AdminReply> {
  if (request.type === 'secrets') return secretsView(deps);
  const provider = decisionProviders().find(p => p.keyId === request.keyId);
  if (!provider) return refused('unknown_service', '不认识的服务');
  const { keyId } = provider;
  switch (request.type) {
    case 'setSecret': {
      const value = request.value.trim();
      const problem = keyProblem(value);
      if (problem) return refused('invalid_key', problem);
      try { await (deps.setSecret ?? setSecret)(keyId, value); }
      catch (error) { return keystoreRefused('set', keyId, error); }
      log.info('secrets', 'set', { keyId });
      return secretsView(deps);
    }
    case 'removeSecret': {
      let removed: boolean;
      try { removed = await (deps.removeSecret ?? removeSecret)(keyId); }
      catch (error) { return keystoreRefused('remove', keyId, error); }
      log.info('secrets', 'remove', { keyId, removed });
      return { ...await secretsView(deps), removed };
    }
    case 'testSecret': {
      let key: string | undefined;
      try { key = await (deps.getSecret ?? getSecret)(keyId); }
      catch (error) { return keystoreRefused('test', keyId, error); }
      if (!key) return refused('missing_key', `还没填 ${provider.displayName} 的 key`);
      if (!API_KEY_SHAPE.test(key)) return refused('invalid_key', `存着的 ${provider.displayName} 的 key 不是一串可见字符，重新填一次`);
      const result = await provider.probe(key, new AbortController().signal, deps.fetch);
      log.info('secrets', 'test', { keyId, outcome: result.outcome, ...(result.status ? { status: result.status } : {}) });
      return { kind: 'secretTested', keyId, ...result };
    }
  }
}

import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { groupIdSchema, recipeAuthorizationSchema, recipeBinary32Schema, recipeManifestSchema, recipeSetupSchema,
  type RecipeAuthorization, type RecipeInstallReply, type RecipeInstallRequest, type RecipeManifest, type RecipeSetup } from '@vonvon/protocol';
import { supplementOf } from '../bot/context-assembly';
import { withRegisteredBot } from '../config/bots';
import { botPaths, paths } from '../config/paths';
import { mutateProjectStore, type Project, type RegistryLocation } from '../project/registry';
import { operationUuid, parseManifest, sha256 } from './manifest';
import type { RecipeOperation } from './types';

type Prepare = Extract<RecipeInstallRequest, {type: 'prepare'}>;
const uuid = z.string().uuid();
const binary32 = z.string().refine(value => recipeBinary32Schema.safeParse(value).success);
const operationSchema = z.object({
  operationId: uuid, accountId: uuid,
  bot: z.object({appId: z.string(), tenant: z.enum(['feishu', 'lark']), createdAt: z.number(), registrationId: uuid.optional()}).strict(),
  groupId: z.string(), bindingIncarnation: uuid, projectSettingsRevision: z.number().int().nonnegative(), settingsSha256: z.string(),
  manifest: z.string(), manifestSha256: z.string(), incoming: z.custom<RecipeManifest>(value => recipeManifestSchema.safeParse(value).success),
  role: z.string(), setup: z.custom<RecipeSetup>(value => recipeSetupSchema.safeParse(value).success).optional(),
  nonce: binary32, nonceCommitment: binary32, targetPublicKey: binary32,
  createdAt: z.number(), status: z.enum(['prepared', 'in_progress', 'applied', 'rejected']),
  authorization: z.custom<RecipeAuthorization>(value => recipeAuthorizationSchema.safeParse(value).success).optional(), reason: z.string().optional(), completedAt: z.number().optional(),
}).strict();
const operations = (stored: Record<string, unknown>): Record<string, RecipeOperation> => {
  const parsed = z.record(uuid, operationSchema).parse(stored.recipeInstallOperations ?? {});
  for (const [id, operation] of Object.entries(parsed)) {
    if (id !== operation.operationId || (operation.status === 'in_progress' && !operation.authorization)
      || (['applied', 'rejected'].includes(operation.status) && operation.completedAt === undefined)) throw new Error('配方安装记录损坏');
  }
  return parsed as Record<string, RecipeOperation>;
};
const copy = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const settingsHash = (row: Project): string => sha256(JSON.stringify(row));
const terminal = (operation: RecipeOperation): RecipeInstallReply => ({kind: 'status', operationId: operation.operationId,
  groupId: groupIdSchema.parse(operation.groupId), status: operation.status,
  ...('reason' in operation && operation.reason ? {reason: operation.reason} : {})});

export interface RecipeStoreOptions {
  targetPublicKey: string;
  location?: (botId: string) => RegistryLocation;
  now?: () => number;
  beforeCommit?: () => void;
}

/** Every transaction holds bots before projects, including operation retries after a group was unbound. */
export class RecipeStore {
  constructor(private readonly options: RecipeStoreOptions) {}
  private location(botId: string): RegistryLocation {
    return this.options.location?.(botId) ?? {file: botPaths(botId).projectsFile, dataRoot: paths.appDir};
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  async prepare(input: Prepare): Promise<RecipeInstallReply> {
    const request = copy(input);
    const incoming = parseManifest(request.manifest, request.manifestSha256);
    return withRegisteredBot(request.botId, async bot => mutateProjectStore(this.location(request.botId), async (stored, rows) => {
      const row = rows.find(row => row.chatId === request.groupId && !row.dm);
      if (!row) throw new Error('请选择这个 Bot 已绑定的现有群');
      const existing = row.recipeInstall;
      if (existing && existing.recipeId !== incoming.recipeId) throw new Error('这个群已使用另一份配方');
      if (existing?.versionId === incoming.versionId) return {changed: false, value: {
        kind: 'alreadyInstalled', groupId: row.chatId, recipeId: incoming.recipeId, versionId: incoming.versionId,
      } as RecipeInstallReply};
      const localRole = supplementOf(row), localSetup = existing?.setup;
      const roleConflict = !existing ? !localRole || localRole !== incoming.role : localRole !== existing.base.role && localRole !== incoming.role && incoming.role !== existing.base.role;
      const setupConflict = Boolean(existing && !same(localSetup, existing.base.setup) && !same(localSetup, incoming.setup) && !same(incoming.setup, existing.base.setup));
      const review = {groupId: row.chatId, currentRole: localRole, incomingRole: incoming.role,
        ...(existing ? {baseRole: existing.base.role} : {}), ...(localSetup ? {currentSetup: localSetup} : {}),
        ...(incoming.setup ? {incomingSetup: incoming.setup} : {}), ...(existing?.base.setup ? {baseSetup: existing.base.setup} : {}),
        roleChoiceRequired: roleConflict, setupChoiceRequired: setupConflict};
      if ((roleConflict && !request.resolution?.role) || (setupConflict && !request.resolution?.setup)) return {changed: false, value: {kind: 'review', ...review} as RecipeInstallReply};
      const roleChoice = request.resolution?.role;
      const role = roleChoice?.kind === 'keep' ? localRole : roleChoice?.kind === 'custom' ? roleChoice.text
        : roleChoice?.kind === 'replace' || !existing || localRole === existing.base.role ? incoming.role : localRole;
      if ([...role].length > 5000) throw new Error('补充职责最多 5000 字');
      const setup = request.resolution?.setup === 'keep' ? localSetup
        : request.resolution?.setup === 'replace' || !existing || same(localSetup, existing.base.setup) ? incoming.setup : localSetup;
      row.bindingIncarnation ??= randomUUID();
      row.projectSettingsRevision ??= 0;
      const nonce = randomBytes(32), operationId = operationUuid(this.now());
      const operation: RecipeOperation = {
        operationId, accountId: request.accountId, bot, groupId: row.chatId,
        bindingIncarnation: row.bindingIncarnation, projectSettingsRevision: row.projectSettingsRevision,
        settingsSha256: settingsHash(row), manifest: request.manifest, manifestSha256: request.manifestSha256,
        incoming, role, ...(setup ? {setup: copy(setup)} : {}), nonce: nonce.toString('base64url'),
        nonceCommitment: Buffer.from(sha256(nonce), 'hex').toString('base64url'), targetPublicKey: this.options.targetPublicKey,
        createdAt: this.now(), status: 'prepared',
      };
      const history = operations(stored); history[operationId] = operation; stored.recipeInstallOperations = history;
      return {changed: true, value: {kind: 'prepared', operationId, targetPublicKey: operation.targetPublicKey,
        nonceCommitment: operation.nonceCommitment, versionId: incoming.versionId, manifestSha256: operation.manifestSha256, ...review} as RecipeInstallReply};
    }, this.options.beforeCommit));
  }
  async get(botId: string, operationId: string): Promise<RecipeOperation> {
    return mutateProjectStore(this.location(botId), async stored => {
      const operation = operations(stored)[operationId];
      if (!operation || operation.bot.appId !== botId) throw new Error('配方安装记录不存在');
      return {changed: false, value: copy(operation)};
    });
  }
  async status(botId: string, operationId: string): Promise<RecipeInstallReply> { return terminal(await this.get(botId, operationId)); }
  async authorize(botId: string, operationId: string, supplied?: RecipeAuthorization): Promise<RecipeOperation> {
    return mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId) throw new Error('配方安装记录不存在');
      if (supplied) {
        const authorization = recipeAuthorizationSchema.parse(supplied);
        if (authorization.operationId !== operationId || authorization.accountId !== operation.accountId
          || authorization.versionId !== operation.incoming.versionId || authorization.manifestSha256 !== operation.manifestSha256
          || authorization.targetPublicKey !== operation.targetPublicKey || authorization.nonceCommitment !== operation.nonceCommitment
          || (operation.authorization && !same({...operation.authorization, status: 'authorized'}, {...authorization, status: 'authorized'}))) throw new Error('配方安装授权与本机准备不一致');
        if (!operation.authorization && operation.status === 'prepared') {
          operation.authorization = authorization; stored.recipeInstallOperations = history;
          return {changed: true, value: copy(operation)};
        }
      }
      if (!operation.authorization && !['applied', 'rejected'].includes(operation.status)) throw new Error('缺少配方安装授权');
      return {changed: false, value: copy(operation)};
    }, this.options.beforeCommit);
  }
  async redeemed(botId: string, operationId: string): Promise<void> {
    await mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId || !operation.authorization) throw new Error('配方安装授权不存在');
      if (operation.status !== 'prepared') return {changed: false, value: undefined};
      history[operationId] = {...operation, status: 'in_progress', authorization: operation.authorization}; stored.recipeInstallOperations = history;
      return {changed: true, value: undefined};
    }, this.options.beforeCommit);
  }
  /** Membership is checked by the live Bot process while the registration and project locks remain held. */
  async apply(botId: string, operationId: string, isInChat: (botId: string, groupId: string) => Promise<void>): Promise<RecipeInstallReply> {
    const captured = await this.get(botId, operationId);
    if (captured.status === 'applied' || captured.status === 'rejected') return terminal(captured);
    try {
      return await withRegisteredBot(botId, async () => mutateProjectStore(this.location(botId), async (stored, rows) => {
        const history = operations(stored), operation = history[operationId];
        if (!operation || operation.status !== 'in_progress') throw new Error('配方尚未完成在线核验');
        const row = rows.find(row => row.chatId === operation.groupId && !row.dm);
        let reason: string | undefined;
        if (!row || row.bindingIncarnation !== operation.bindingIncarnation) reason = '群绑定已改变';
        else if (row.projectSettingsRevision !== operation.projectSettingsRevision || settingsHash(row) !== operation.settingsSha256) reason = '群设置已改变';
        if (!reason) {
          try { await isInChat(botId, operation.groupId); }
          catch { reason = '无法确认 Bot 仍在此群中'; }
        }
        if (reason) {
          history[operationId] = {...operation, status: 'rejected', reason, completedAt: this.now()};
        } else {
          const manifest: RecipeManifest = operation.incoming;
          row!.supplement = operation.role;
          row!.recipeInstall = {recipeId: manifest.recipeId, versionId: manifest.versionId, authorId: manifest.authorId,
            revision: manifest.revision, access: manifest.access, manifestSha256: operation.manifestSha256, installedAt: this.now(),
            base: {role: manifest.role, ...(manifest.setup ? {setup: copy(manifest.setup)} : {})}, ...(operation.setup ? {setup: copy(operation.setup)} : {})};
          history[operationId] = {...operation, status: 'applied', completedAt: this.now()};
        }
        stored.recipeInstallOperations = history;
        return {changed: true, value: terminal(history[operationId]!)};
      }, this.options.beforeCommit), captured.bot);
    } catch (error) {
      const recovered = await this.get(botId, operationId);
      if (recovered.status === 'applied' || recovered.status === 'rejected') return terminal(recovered);
      if (error instanceof Error && error.message === '机器人已移除或重新注册') return this.reject(botId, operationId, '机器人已移除或重新注册');
      throw error;
    }
  }
  async reject(botId: string, operationId: string, reason: string): Promise<RecipeInstallReply> {
    return mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId) throw new Error('配方安装记录不存在');
      if (operation.status === 'applied' || operation.status === 'rejected') return {changed: false, value: terminal(operation)};
      history[operationId] = {...operation, status: 'rejected', reason, completedAt: this.now()}; stored.recipeInstallOperations = history;
      return {changed: true, value: terminal(history[operationId]!)};
    }, this.options.beforeCommit);
  }
}

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { groupIdSchema, recipeAuthorizationSchema, recipeBinary32Schema, recipeManifestSchema, recipeSetupSchema,
  type RecipeAuthorization, type RecipeInstallReply, type RecipeInstallRequest, type RecipeManifest, type RecipeSetup } from '@vonvon/protocol';
import { supplementOf } from '../bot/context-assembly';
import { loadBots, withRegisteredBot, type BotIdentity } from '../config/bots';
import { botPaths, paths } from '../config/paths';
import { mutateProjectStore, readDurableProjectStore, type Project, type RegistryLocation } from '../project/registry';
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
  cloudCompletion: z.enum(['none', 'required', 'confirmed']).optional(),
  preparationSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  issuerState: z.enum(['unissued', 'issuing', 'authorized']).optional(),
  authorization: z.custom<RecipeAuthorization>(value => recipeAuthorizationSchema.safeParse(value).success).optional(), reason: z.string().optional(), completedAt: z.number().optional(),
}).strict();
const operations = (stored: Record<string, unknown>): Record<string, RecipeOperation> => {
  const parsed = z.record(uuid, operationSchema).parse(stored.recipeInstallOperations ?? {});
  for (const [id, operation] of Object.entries(parsed)) {
    if (id !== operation.operationId || (operation.status === 'in_progress' && !operation.authorization)
      || (['applied', 'rejected'].includes(operation.status) && operation.completedAt === undefined)) throw new Error('配方安装记录损坏');
    operation.cloudCompletion ??= operation.status === 'in_progress' || operation.status === 'applied'
      || (operation.status === 'rejected' && operation.authorization) ? 'required' : 'none';
    operation.issuerState ??= operation.authorization ? 'authorized' : 'issuing';
    if (Boolean(operation.authorization) !== (operation.issuerState === 'authorized')) throw new Error('配方安装记录损坏');
    if ((operation.status === 'prepared' && operation.cloudCompletion !== 'none')
      || (operation.status === 'in_progress' && operation.cloudCompletion !== 'required')
      || (operation.status === 'applied' && operation.cloudCompletion === 'none')
      || (operation.cloudCompletion !== 'none' && !operation.authorization)) throw new Error('配方安装记录损坏');
  }
  return parsed as Record<string, RecipeOperation>;
};
const copy = <T>(value: T): T => structuredClone(value);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const settingsHash = (row: Project): string => sha256(JSON.stringify(row));
const PREPARATION_MS = 300000, RETENTION_MS = 8 * 86400000, MAX_OPERATIONS = 512, MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const budgetSchema = z.record(uuid, z.object({day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().min(1).max(60)}).strict());
const budgetsOf = (stored: Record<string, unknown>) => budgetSchema.parse(stored.recipeInstallDaily ?? {});
const unissuedExpired = (operation: RecipeOperation, now: number): boolean => operation.status === 'prepared' && operation.issuerState === 'unissued'
  && !operation.authorization && now - operation.createdAt >= PREPARATION_MS;
const expire = (operation: RecipeOperation): RecipeOperation => ({...operation, status: 'rejected', reason: '本机准备已过期', completedAt: operation.createdAt + PREPARATION_MS});
const active = (operation: RecipeOperation, now: number): boolean => operation.cloudCompletion === 'required'
  || ((operation.status === 'prepared' || operation.status === 'in_progress') && !unissuedExpired(operation, now));
function maintain(history: Record<string, RecipeOperation>, now: number): boolean {
  let changed = false;
  for (const [id, original] of Object.entries(history)) {
    const operation = unissuedExpired(original, now) ? expire(original) : original;
    if (operation !== original) {history[id] = operation; changed = true;}
    if ((operation.status === 'applied' || operation.status === 'rejected') && operation.cloudCompletion !== 'required'
      && now - operation.completedAt > RETENTION_MS) {delete history[id]; changed = true;}
  }
  return changed;
}
const terminal = (operation: RecipeOperation): RecipeInstallReply => ({kind: 'status', operationId: operation.operationId,
  groupId: groupIdSchema.parse(operation.groupId), status: operation.status === 'prepared' && operation.authorization ? 'in_progress' : operation.status,
  issuerState: operation.issuerState, stillNeedsTicket: operation.status === 'prepared' && !operation.authorization,
  ...('reason' in operation && operation.reason ? {reason: operation.reason} : {})});

export class RecipeRecoveryRequired extends Error {}
export function assertRecipeRemovalSafe(target: RegistryLocation): Promise<void> {
  return mutateProjectStore(target, async stored => {
    const unsafe = Object.values(operations(stored)).some(operation => operation.cloudCompletion === 'required'
      || ((operation.status === 'prepared' || operation.status === 'in_progress') && (operation.issuerState !== 'unissued' || operation.authorization)));
    const pendingRich=Object.values((stored.richInstallJournal??{}) as Record<string,{settled:boolean}>).some(op=>!op.settled);
    if (unsafe || pendingRich) throw new RecipeRecoveryRequired('这个 Bot 还有待恢复的配方安装，请先恢复或取消原操作后再移除。');
    return {changed: false, value: undefined};
  });
}

export interface RecipeStoreOptions {
  targetPublicKey: string;
  isInChat: (botId: string, groupId: string, identity: BotIdentity) => Promise<void>;
  membershipTimeoutMs?: number;
  location?: (botId: string) => RegistryLocation;
  now?: () => number;
  beforeCommit?: () => void;
}

export class RecipeStore {
  constructor(private readonly options: RecipeStoreOptions) {}
  private location(botId: string): RegistryLocation {
    return this.options.location?.(botId) ?? {file: botPaths(botId).projectsFile, dataRoot: paths.appDir};
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  async foreignUsage(botId: string, accountId: string, day: string, now: number): Promise<{active: number; created: number}> {
    const usage = {active: 0, created: 0};
    for (const bot of (await loadBots()).bots) {
      if (bot.appId === botId) continue;
      let stored: Record<string, unknown>;
      try {stored = JSON.parse(await readFile(this.location(bot.appId).file, 'utf8'));}
      catch (error) {if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error;}
      usage.active+=Object.values((stored.richInstallJournal??{}) as Record<string,{account:string;settled:boolean}>).filter(o=>o.account===accountId&&!o.settled).length;
      usage.active += Object.values(operations(stored)).filter(operation => operation.accountId === accountId && active(operation, now)).length;
      const budget = budgetsOf(stored)[accountId];
      if (budget?.day === day) usage.created += budget.count;
    }
    return usage;
  }
  private async requireMembership(botId: string, groupId: string, identity: BotIdentity, check = this.options.isInChat): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Bot 群成员核验超时')), this.options.membershipTimeoutMs ?? 10000);
    });
    try { await Promise.race([Promise.resolve().then(() => check(botId, groupId, identity)), expired]); }
    finally { clearTimeout(timer); }
  }
  async reserveRichBudget(stored:Record<string,unknown>,botId:string,account:string,now:number):Promise<void>{
    const day=new Date(now).toISOString().slice(0,10),foreign=await this.foreignUsage(botId,account,day,now);
    const legacy=Object.values(operations(stored)).filter(o=>o.accountId===account&&active(o,now)).length;
    const rich=Object.values((stored.richInstallJournal??{}) as Record<string,{account:string;settled:boolean}>).filter(o=>o.account===account&&!o.settled).length;
    if(legacy+rich+foreign.active>=3)throw new Error('这个账号已有 3 个待完成安装');
    const daily=Object.fromEntries(Object.entries(budgetsOf(stored)).filter(([,v])=>v.day===day));
    if((daily[account]?.count??0)+foreign.created>=60)throw new Error('本日配方安装准备已达上限');
    daily[account]={day,count:(daily[account]?.count??0)+1};stored.recipeInstallDaily=daily;
  }
  async prepare(input: Prepare): Promise<RecipeInstallReply> {
    const request = copy(input);
    const incoming = parseManifest(request.manifest, request.manifestSha256);
    return withRegisteredBot(request.botId, async bot => {
      const result = await mutateProjectStore(this.location(request.botId), async (stored, rows) => {
        const row = rows.find(row => row.chatId === request.groupId && !row.dm);
        if (!row) throw new Error('请选择这个 Bot 已绑定的现有群');
        await this.requireMembership(request.botId, row.chatId, bot);
        if(row.richRecipe)throw new Error('此群已安装完整配方，请使用对应的版本更新入口');
        const existing = row.recipeInstall;
        if (existing && existing.recipeId !== incoming.recipeId) throw new Error('这个群已使用另一份配方');
        if (existing && incoming.revision < existing.revision) throw new Error('不能安装旧版本配方');
        if (existing?.versionId === incoming.versionId) return {changed: false, durableRead: true, value: {
          kind: 'alreadyInstalled', groupId: row.chatId, recipeId: incoming.recipeId, versionId: incoming.versionId,
        } as RecipeInstallReply};
        const backfilled = row.bindingIncarnation === undefined || row.projectSettingsRevision === undefined;
        row.bindingIncarnation ??= randomUUID();
        row.projectSettingsRevision ??= 0;
        const localRole = supplementOf(row), localSetup = existing?.setup;
        const roleConflict = !existing ? Boolean(localRole && localRole !== incoming.role) : localRole !== existing.base.role && localRole !== incoming.role && incoming.role !== existing.base.role;
        const setupConflict = Boolean(existing && !same(localSetup, existing.base.setup) && !same(localSetup, incoming.setup) && !same(incoming.setup, existing.base.setup));
        const reviewToken = sha256(JSON.stringify([bot, row.bindingIncarnation, row.projectSettingsRevision,
          settingsHash(row), request.accountId, request.manifestSha256, this.options.targetPublicKey]));
        const review = {reviewToken, groupId: row.chatId, currentRole: localRole, incomingRole: incoming.role,
          ...(existing ? {baseRole: existing.base.role} : {}), ...(localSetup ? {currentSetup: localSetup} : {}),
          ...(incoming.setup ? {incomingSetup: incoming.setup} : {}), ...(existing?.base.setup ? {baseSetup: existing.base.setup} : {}),
          roleChoiceRequired: roleConflict, setupChoiceRequired: setupConflict};
        if ((request.resolution && request.reviewToken !== reviewToken) || (roleConflict && !request.resolution?.role)
          || (setupConflict && !request.resolution?.setup)) return {changed: backfilled, value: {kind: 'review', ...review} as RecipeInstallReply};
        const roleChoice = request.resolution?.role;
        const role = roleChoice?.kind === 'keep' ? localRole : roleChoice?.kind === 'custom' ? roleChoice.text
          : roleChoice?.kind === 'replace' || !existing || localRole === existing.base.role ? incoming.role : localRole;
        if ([...role].length > 5000) throw new Error('补充职责最多 5000 字');
        const setup = request.resolution?.setup === 'keep' ? localSetup
          : request.resolution?.setup === 'replace' || !existing || same(localSetup, existing.base.setup) ? incoming.setup : localSetup;
        const now = this.now(), history = operations(stored), maintained = maintain(history, now);
        const resolution = [request.resolution?.role?.kind ?? null, request.resolution?.role?.kind === 'custom' ? request.resolution.role.text : null,
          request.resolution?.setup ?? null];
        const preparationSha256 = sha256(JSON.stringify([request.accountId, bot, row.chatId, row.bindingIncarnation,
          row.projectSettingsRevision, settingsHash(row), request.manifestSha256, request.manifest, resolution,
          role, setup ?? null, this.options.targetPublicKey]));
        const reused = Object.values(history).find(operation => operation.status === 'prepared' && operation.issuerState === 'unissued' && !operation.authorization
          && operation.createdAt <= now && !unissuedExpired(operation, now) && operation.preparationSha256 === preparationSha256);
        if (reused) {
          if (maintained) stored.recipeInstallOperations = history;
          return {changed: backfilled || maintained, durableRead: true, value: {kind: 'prepared', operationId: reused.operationId,
            targetPublicKey: reused.targetPublicKey, nonceCommitment: reused.nonceCommitment, versionId: incoming.versionId,
            manifestSha256: reused.manifestSha256, ...review} as RecipeInstallReply};
        }
        const day = new Date(now).toISOString().slice(0, 10), foreign = await this.foreignUsage(request.botId, request.accountId, day, now);
        const hereRich=Object.values((stored.richInstallJournal??{}) as Record<string,{account:string;settled:boolean}>).filter(o=>o.account===request.accountId&&!o.settled).length;
        if (foreign.active + hereRich + Object.values(history).filter(operation => operation.accountId === request.accountId && active(operation, now)).length >= 3) throw new Error('这个账号已有 3 个待完成安装，请先完成或取消');
        const daily = Object.fromEntries(Object.entries(budgetsOf(stored)).filter(([, budget]) => budget.day === day));
        if (foreign.created + (daily[request.accountId]?.count ?? 0) >= 60) throw new Error('这个账号今天的本机准备次数已达上限');
        if (Object.keys(history).length >= MAX_OPERATIONS) throw new Error('本机安装记录已达上限，请先恢复待完成操作');
        const nonce = randomBytes(32), operationId = operationUuid(now);
        const operation: RecipeOperation = {
          operationId, accountId: request.accountId, bot, groupId: row.chatId,
          bindingIncarnation: row.bindingIncarnation, projectSettingsRevision: row.projectSettingsRevision,
          settingsSha256: settingsHash(row), manifest: request.manifest, manifestSha256: request.manifestSha256,
          incoming, role, ...(setup ? {setup: copy(setup)} : {}), nonce: nonce.toString('base64url'),
          nonceCommitment: Buffer.from(sha256(nonce), 'hex').toString('base64url'), targetPublicKey: this.options.targetPublicKey,
          createdAt: now, status: 'prepared', cloudCompletion: 'none', preparationSha256, issuerState: 'unissued',
        };
        history[operationId] = operation;
        daily[request.accountId] = {day, count: (daily[request.accountId]?.count ?? 0) + 1};
        const ledgerBytes = Buffer.byteLength(JSON.stringify({recipeInstallOperations: history, recipeInstallDaily: daily}, null, 2));
        if (ledgerBytes + 2048 * Object.keys(history).length > MAX_LEDGER_BYTES) throw new Error('本机安装记录已达容量上限，请先恢复待完成操作');
        stored.recipeInstallOperations = history; stored.recipeInstallDaily = daily;
        return {changed: true, value: {kind: 'prepared', operationId, targetPublicKey: operation.targetPublicKey,
          nonceCommitment: operation.nonceCommitment, versionId: incoming.versionId, manifestSha256: operation.manifestSha256, ...review} as RecipeInstallReply};
      }, this.options.beforeCommit);
      if (result.kind === 'review') await readDurableProjectStore(this.location(request.botId), () => undefined);
      return result;
    });
  }
  async source(request:Extract<RecipeInstallRequest,{type:'source'|'ignoreVersion'}>):Promise<RecipeInstallReply> {
    return withRegisteredBot(request.botId, bot => mutateProjectStore(this.location(request.botId), async (_stored, rows) => {
      const row = rows.find(r => r.chatId === request.groupId && !r.dm);
      if (!row) throw new Error('群绑定已改变');
      const active=row.richRecipe;
      if(active){
        const release=active.pointer.release, token=()=>sha256(JSON.stringify([this.options.targetPublicKey,bot,row.bindingIncarnation,active.pointer,active.ignoredVersionId]));
        if(request.type==='ignoreVersion'){
          if(request.sourceToken!==token()||request.recipeId!==release.recipeId||request.installedVersionId!==release.versionId||request.versionId===release.versionId)throw new Error('配方来源已改变');
          active.ignoredVersionId=request.versionId;
        }
        return {changed:request.type==='ignoreVersion',value:{kind:'source',groupId:request.groupId,source:{recipeId:release.recipeId,versionId:release.versionId,revision:release.revision,authorId:release.authorId,installedAt:active.installedAt,sourceToken:token(),ignoredVersionId:active.ignoredVersionId}} as RecipeInstallReply};
      }
      const source = row.recipeInstall;
      if (!source) {
        if (request.type === 'ignoreVersion') throw new Error('安装来源已改变，请重新检查。');
        return {changed:false, value:{kind:'source', groupId:request.groupId, source:null} as RecipeInstallReply};
      }
      const backfill = !row.bindingIncarnation;
      row.bindingIncarnation ??= randomUUID();
      const token = () => sha256(JSON.stringify([this.options.targetPublicKey, bot.appId, bot.tenant, bot.createdAt,
        bot.registrationId, row.chatId, row.bindingIncarnation, source]));
      if (request.type === 'ignoreVersion') {
        if (request.sourceToken !== token() || source.recipeId !== request.recipeId ||
          source.versionId !== request.installedVersionId || source.versionId === request.versionId)
          throw new Error('安装来源已改变，请重新检查。');
        source.ignoredVersionId = request.versionId;
      }
      return {changed:backfill || request.type === 'ignoreVersion', value:{kind:'source', groupId:request.groupId, source:{
        sourceToken:token(), recipeId:source.recipeId, versionId:source.versionId, revision:source.revision,
        authorId:source.authorId, installedAt:source.installedAt, ...(source.setup && {setup:source.setup}),
        ...(source.ignoredVersionId && {ignoredVersionId:source.ignoredVersionId}),
      }} as RecipeInstallReply};
    }));
  }
  async createdGroup(botId: string, requestId: string): Promise<RecipeInstallReply> {
    return withRegisteredBot(botId, () => mutateProjectStore(this.location(botId), async (_stored, rows) => ({changed:false, value:{
      kind: 'createdGroup' as const, groupId: groupIdSchema.nullable().parse(rows.find(row => !row.dm && row.creationRequestId === requestId)?.chatId ?? null),
    }})));
  }
  async get(botId: string, operationId: string): Promise<RecipeOperation> {
    return mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId) throw new Error('配方安装记录不存在');
      if (unissuedExpired(operation, this.now())) {
        history[operationId] = expire(operation); stored.recipeInstallOperations = history;
        return {changed: true, value: copy(history[operationId]!)};
      }
      return {changed: false, durableRead: true, value: copy(operation)};
    }, this.options.beforeCommit);
  }
  async status(botId: string, operationId: string): Promise<RecipeInstallReply> { return terminal(await this.get(botId, operationId)); }
  async issuing(botId: string, operationId: string): Promise<RecipeInstallReply> {
    const captured = await this.get(botId, operationId);
    if (captured.status === 'applied' || captured.status === 'rejected') return terminal(captured);
    await withRegisteredBot(botId, () => mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId) throw new Error('配方安装记录不存在');
      if (unissuedExpired(operation, this.now())) {
        history[operationId] = expire(operation); stored.recipeInstallOperations = history;
        return {changed: true, value: undefined};
      }
      if (operation.status !== 'prepared' || operation.issuerState !== 'unissued') return {changed: false, value: undefined};
      operation.issuerState = 'issuing'; stored.recipeInstallOperations = history;
      return {changed: true, value: undefined};
    }, this.options.beforeCommit), captured.bot);
    return this.status(botId, operationId);
  }
  async authorize(botId: string, operationId: string, supplied?: RecipeAuthorization): Promise<RecipeOperation> {
    const captured = await this.get(botId, operationId);
    const perform = () => mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId) throw new Error('配方安装记录不存在');
      if (unissuedExpired(operation, this.now())) {
        history[operationId] = expire(operation); stored.recipeInstallOperations = history;
        return {changed: true, value: copy(history[operationId]!)};
      }
      if (supplied) {
        const authorization = recipeAuthorizationSchema.parse(supplied);
        if (authorization.operationId !== operationId || authorization.accountId !== operation.accountId
          || authorization.versionId !== operation.incoming.versionId || authorization.manifestSha256 !== operation.manifestSha256
          || authorization.targetPublicKey !== operation.targetPublicKey || authorization.nonceCommitment !== operation.nonceCommitment
          || (operation.authorization && !same({...operation.authorization, status: 'authorized'}, {...authorization, status: 'authorized'}))) throw new Error('配方安装授权与本机准备不一致');
        if (!operation.authorization && operation.status === 'prepared') {
          operation.authorization = authorization; operation.issuerState = 'authorized'; stored.recipeInstallOperations = history;
          return {changed: true, value: copy(operation)};
        }
      }
      if (!operation.authorization && !['applied', 'rejected'].includes(operation.status)) throw new Error('缺少配方安装授权');
      return {changed: false, value: copy(operation)};
    }, this.options.beforeCommit);
    const result = captured.status === 'applied' || captured.status === 'rejected' ? await perform() : await withRegisteredBot(botId, perform);
    return result.status === 'applied' || result.status === 'rejected' ? this.get(botId, operationId) : result;
  }
  async redeemed(botId: string, operationId: string): Promise<void> {
    await mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId || !operation.authorization) throw new Error('配方安装授权不存在');
      if (operation.status !== 'prepared') return {changed: false, value: undefined};
      history[operationId] = {...operation, status: 'in_progress', cloudCompletion: 'required', authorization: operation.authorization}; stored.recipeInstallOperations = history;
      return {changed: true, value: undefined};
    }, this.options.beforeCommit);
  }
  async apply(botId: string, operationId: string, isInChat: RecipeStoreOptions['isInChat']): Promise<RecipeInstallReply> {
    const captured = await this.get(botId, operationId);
    if (captured.status === 'applied' || captured.status === 'rejected') return terminal(captured);
    try {
      return await withRegisteredBot(botId, async () => mutateProjectStore(this.location(botId), async (stored, rows) => {
        const history = operations(stored), operation = history[operationId];
        if (!operation) throw new Error('配方安装记录不存在');
        if (operation.status === 'applied' || operation.status === 'rejected') return {changed: false, durableRead: true, value: terminal(operation)};
        if (operation.status !== 'in_progress') throw new Error('配方尚未完成在线核验');
        const row = rows.find(row => row.chatId === operation.groupId && !row.dm);
        let reason: string | undefined;
        if (!row || row.bindingIncarnation !== operation.bindingIncarnation) reason = '群绑定已改变';
        else if (row.recipeInstall?.recipeId === operation.incoming.recipeId && row.recipeInstall.revision > operation.incoming.revision) reason = '已经安装更新的配方版本';
        else if (row.projectSettingsRevision !== operation.projectSettingsRevision || settingsHash(row) !== operation.settingsSha256) reason = '群设置已改变';
        if (!reason) {
          try { await this.requireMembership(botId, operation.groupId, operation.bot, isInChat); }
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
  async cancel(botId: string, operationId: string): Promise<RecipeInstallReply> {
    return this.rejectWhen(botId, operationId, '主人已取消', operation => !operation.authorization && operation.issuerState === 'unissued' && operation.status === 'prepared');
  }
  async rejectUnredeemed(botId: string, operationId: string, reason: string): Promise<RecipeInstallReply> {
    return this.rejectWhen(botId, operationId, reason, operation => operation.cloudCompletion === 'none' && operation.status === 'prepared');
  }
  async reject(botId: string, operationId: string, reason: string): Promise<RecipeInstallReply> {
    return this.rejectWhen(botId, operationId, reason, () => true);
  }
  private async rejectWhen(botId: string, operationId: string, reason: string, eligible: (operation: RecipeOperation) => boolean): Promise<RecipeInstallReply> {
    await mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId) throw new Error('配方安装记录不存在');
      if (operation.status === 'applied' || operation.status === 'rejected' || !eligible(operation)) return {changed: false, value: undefined};
      history[operationId] = {...operation, status: 'rejected', reason, completedAt: this.now()}; stored.recipeInstallOperations = history;
      return {changed: true, value: undefined};
    }, this.options.beforeCommit);
    return this.status(botId, operationId);
  }
  async confirmCompletion(botId: string, operationId: string): Promise<void> {
    await mutateProjectStore(this.location(botId), async stored => {
      const history = operations(stored), operation = history[operationId];
      if (!operation || operation.bot.appId !== botId || !['applied', 'rejected'].includes(operation.status)) throw new Error('配方安装尚未完成');
      if (operation.cloudCompletion !== 'required') return {changed: false, value: undefined};
      operation.cloudCompletion = 'confirmed'; stored.recipeInstallOperations = history;
      return {changed: true, value: undefined};
    }, this.options.beforeCommit);
  }
}

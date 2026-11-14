import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  recipeRichContentSchema,
  verifyRichRecipeRelease,
  type RecipeInstallReply,
  type RecipeInstallRequest,
  type RecipeRichContent,
  type RecipeRichInstallAuthorization,
  type RecipeRichText,
} from '@vonvon/protocol';
import type { ScheduleStore } from '../bot/schedule/store';
import { managedId, type ManagedTaskDefinition } from '../bot/schedule/managed';
import { botDir, botPaths, paths } from '../config/paths';
import { withRegisteredBot, type BotIdentity } from '../config/bots';
import { mutateProjectStore, readDurableProjectStore, type Project } from '../project/registry';
import { operationUuid, sha256 } from './manifest';
import { openRichRecipeGeneration, stageRichRecipeGeneration, type RecipeGenerationPointer } from './rich-generation';
import { recipeSnapshot, mergeRecipeItems, type LocalRecipeItem } from './rich-merge';
import { applyNativeRecipeFields, localRecipeItems } from './rich-settings';
import { canonicalLocal, releasedItemSources } from './rich-source-lineage';
import { recipeAdmissions, recipeSlot } from './rich-admission';
import { verifiedDocumentText } from './rich-source-files';
import type { RichRecipeState } from './rich-state';

type Req<K extends string> = Extract<RecipeInstallRequest, { type: K }>;
export type RichRequest = Req<'richPrepare' | 'richCommit' | 'richStatus' | 'richSetup'>;
type Intent = Extract<RecipeInstallReply, { kind: 'richPrepared' }>['intent'];
export interface RichJournal {
  id: string;
  bot: BotIdentity;
  group: string;
  account: string;
  rowDigest: string;
  reviewToken: string;
  nonce: string;
  intent: Intent;
  preview: Req<'richPrepare'>['preview'];
  choices: Record<string, 'local' | 'incoming'>;
  install: string;
  generation: string;
  staging: string;
  status: 'prepared' | 'redeemed' | 'applied' | 'rejected';
  settled: boolean;
  authorization?: RecipeRichInstallAuthorization;
  reason?: string;
  createdAt: number;
}
const location = (id: string) => ({ file: botPaths(id).projectsFile, dataRoot: paths.appDir });
const history = (stored: Record<string, unknown>) => (stored.richInstallJournal ??= {}) as Record<string, RichJournal>;
const hash = (v: unknown) => sha256(canonicalLocal(v));
const frozen = (row: Project) => hash(row);
export const richStatus = (op: RichJournal): RecipeInstallReply => ({
  kind: 'richStatus',
  operationId: op.id,
  status: op.status,
  settled: op.settled,
  ...(op.reason ? { reason: op.reason } : {}),
});
function getOp(stored: Record<string, unknown>, id: string): RichJournal {
  const op = history(stored)[id];
  if (!op) throw new Error('配方操作不存在');
  return op;
}
export const readRichJournal = (bot: string, id: string) =>
  readDurableProjectStore(location(bot), (stored) => structuredClone(getOp(stored, id)));
export async function editRichJournal<T>(bot: string, id: string, fn: (op: RichJournal) => T) {
  return mutateProjectStore(location(bot), async (stored) => ({ changed: true, value: fn(getOp(stored, id)) }));
}
function selectedSkills(items: LocalRecipeItem[]) {
  return {
    skills: items
      .filter((x) => x.kind === 'skills')
      .map(({ itemId, originId, value }) =>
        recipeRichContentSchema.shape.skills.element.parse({ itemId, originId, ...value }),
      ),
    files: items
      .filter((x) => x.kind === 'files')
      .map(({ itemId, originId, value }) => {
        const text = { kind: 'inline' as const, value: String(value.text) };
        return { ...recipeRichContentSchema.shape.files.element.parse({ itemId, originId, ...value, text }), text };
      }),
  };
}
async function baseline(row: Project, root: string) {
  if (!row.richRecipe) return [];
  const { pointer } = row.richRecipe,
    prev = await openRichRecipeGeneration({ ...pointer, expected: pointer, botDataRoot: root });
  return recipeSnapshot(structuredClone(prev.content) as RecipeRichContent, (v) => prev.resolveText(v));
}
function reviewParts(content: RecipeRichContent, encoded: Record<string, string>) {
  if (Object.keys(encoded).length !== content.parts.length) throw new Error('配方附件数量不符');
  const text = new Map<string, string>();
  for (const d of content.parts) {
    const wire = encoded[d.objectId];
    if (wire === undefined) throw new Error('配方附件缺失');
    const bytes = Buffer.from(wire, 'base64url');
    if (bytes.toString('base64url') !== wire || bytes.length !== d.bytes || sha256(bytes) !== d.sha256)
      throw new Error('配方附件校验失败');
    if (d.kind === 'text') text.set(d.objectId, verifiedDocumentText(bytes));
  }
  return (v: RecipeRichText) => {
    if (v.kind === 'inline') return v.value;
    const value = text.get(v.objectId);
    if (value === undefined) throw new Error('缺少文本附件');
    return value;
  };
}
export async function prepareRich(
  request: Req<'richPrepare'>,
  key: string,
  member: (id: BotIdentity, chat: string) => Promise<void>,
  reserve: (store: Record<string, unknown>, bot: string, account: string, now: number) => Promise<void>,
): Promise<RecipeInstallReply> {
  const { preview, botId, groupId } = request,
    { release, manifest } = preview;
  const canonical = await verifyRichRecipeRelease(release, request.canonical);
  if (manifest.sha256 !== release.contentSha256 || manifest.bytes !== canonical.canonicalUTF8.length)
    throw new Error('清单与版本不符');
  const incoming = recipeSnapshot(canonical.content, reviewParts(canonical.content, request.parts));
  return withRegisteredBot(botId, async (bot) => {
    await member(bot, groupId);
    return mutateProjectStore<RecipeInstallReply>(location(botId), async (stored, rows) => {
      const row = rows.find((r) => r.chatId === groupId && !r.dm);
      if (!row) throw new Error('请选择这个 Bot 已绑定的群');
      const missing = !row.bindingIncarnation || row.projectSettingsRevision === undefined;
      row.bindingIncarnation ??= randomUUID();
      row.projectSettingsRevision ??= 0;
      const old = row.richRecipe?.pointer.release ?? row.recipeInstall;
      if (old && old.recipeId !== release.recipeId) throw new Error('这个群已安装另一配方');
      if (old?.versionId === release.versionId)
        return {
          changed: false,
          value: { kind: 'alreadyInstalled', groupId, recipeId: release.recipeId, versionId: release.versionId },
        };
      if (old && old.revision >= release.revision) throw new Error('不能回退已安装版本');
      const base = await baseline(row, botDir(botId));
      if (!row.richRecipe && row.recipeInstall && canonical.content.role)
        base.push({
          kind: 'role',
          itemId: canonical.content.role.itemId,
          originId: canonical.content.role.originId,
          value: { text: row.recipeInstall.base.role },
        });
      const local = localRecipeItems(row, incoming);
      const token = hash([bot, groupId, frozen(row), preview, key]);
      if (request.choices && request.reviewToken !== token) throw new Error('预览已变化');
      const merged = mergeRecipeItems(base, local, incoming, request.choices);
      if (merged.conflicts.length || request.reviewToken !== token)
        return {
          changed: missing,
          value: {
            kind: 'richReview',
            groupId,
            reviewToken: token,
            conflicts: merged.conflicts.map((c) => ({
              itemId: c.itemId,
              kind: (c.incoming ?? c.local ?? c.base)!.kind,
              base: c.base ? canonicalLocal(c.base.value) : null,
              local: c.local ? canonicalLocal(c.local.value) : null,
              incoming: c.incoming ? canonicalLocal(c.incoming.value) : null,
            })),
          },
        };
      const choices = request.choices ?? {},
        plan = hash([token, choices, merged.resolved]);
      const ledger = history(stored);
      const reused = Object.values(ledger).find(
        (o) => o.reviewToken === token && isDeepStrictEqual(o.choices, choices) && o.status === 'prepared',
      );
      if (reused)
        return {
          changed: false,
          durableRead: true,
          value: { kind: 'richPrepared', operationId: reused.id, intent: reused.intent, reviewToken: token },
        };
      const now = Date.now();
      for (const [id, o] of Object.entries(ledger)) if (o.settled && now - o.createdAt > 8 * 86400000) delete ledger[id];
      if (
        Object.keys(ledger).length >= 512 ||
        Object.values(ledger).filter((o) => !o.settled && o.account === preview.accountId).length >= 3
      )
        throw new Error('本机仍有待完成的配方操作');
      await reserve(stored, botId, preview.accountId, now);
      const nonce = randomBytes(32),
        id = operationUuid(now),
        intent: Intent = {
          ...(old && release.access === 'direct'
            ? { purpose: 'updateDirectRichRecipe', fromVersionId: old.versionId, localPlanSha256: plan }
            : { purpose: 'installRichRecipe' }),
          format: 'rich-v2',
          generation: 2,
          versionId: release.versionId,
          manifestSha256: release.contentSha256,
          targetPublicKey: key,
          nonceCommitment: Buffer.from(sha256(nonce), 'hex').toString('base64url'),
        };
      ledger[id] = {
        id,
        bot,
        group: groupId,
        account: preview.accountId,
        rowDigest: frozen(row),
        reviewToken: token,
        nonce: nonce.toString('base64url'),
        intent,
        preview,
        choices,
        install: row.richRecipe?.pointer.installationId ?? randomUUID(),
        generation: randomUUID(),
        staging: randomUUID(),
        status: 'prepared',
        settled: false,
        createdAt: now,
      };
      return { changed: true, value: { kind: 'richPrepared', operationId: id, intent, reviewToken: token } };
    });
  });
}
export interface Activation {
  generation: RecipeGenerationPointer;
  operationId: string;
}
export async function applyRich(bot: BotIdentity, input: Activation, schedules: ScheduleStore, member: () => Promise<void>) {
  const op = await readRichJournal(bot.appId, input.operationId),
    root = botDir(bot.appId),
    loc = location(bot.appId);
  if (op.status === 'applied' || op.status === 'rejected') return;
  if (
    op.status !== 'redeemed' ||
    !isDeepStrictEqual(op.bot, bot) ||
    op.install !== input.generation.installationId ||
    !isDeepStrictEqual(op.preview.release, input.generation.release)
  )
    throw new Error('配方授权与本机记录不符');
  await recipeAdmissions.exclusive(recipeSlot(bot.appId, op.group), async () => {
    await member();
    const staged = await openRichRecipeGeneration({ ...input.generation, expected: input.generation, botDataRoot: root });
    const content = structuredClone(staged.content) as RecipeRichContent;
    const incoming = recipeSnapshot(content, (v) => staged.resolveText(v));
    const row = await readDurableProjectStore(loc, (stored) =>
      (stored.projects as Project[]).find((r) => r.chatId === op.group && !r.dm),
    );
    const stale = () =>
      editRichJournal(bot.appId, op.id, (j) => {
        j.status = 'rejected';
        j.reason = '群设置或绑定已改变';
      });
    if (!row || frozen(row) !== op.rowDigest) {
      await stale();
      return;
    }
    const previousBase = await baseline(row, root);
    if (!row.richRecipe && row.recipeInstall && content.role)
      previousBase.push({
        kind: 'role',
        itemId: content.role.itemId,
        originId: content.role.originId,
        value: { text: row.recipeInstall.base.role },
      });
    const merged = mergeRecipeItems(previousBase, localRecipeItems(row, incoming), incoming, op.choices);
    if (merged.conflicts.length) throw new Error('配方仍有待处理冲突');
    const { resolved } = merged;
    const package_ = await stageRichRecipeGeneration({
      installationId: op.install,
      generationId: op.generation,
      botDataRoot: root,
      release: op.preview.release,
      canonicalUTF8: canonicalLocal(content),
      readMember: async (_r, d) => staged.readPart(d.objectId),
      effectiveSkills: selectedSkills(resolved),
    });
    const sources = releasedItemSources(content, op.preview.release);
    for (const item of resolved) {
      const old = row.richRecipe?.sources[item.itemId],
        current = sources[item.itemId];
      if (
        old &&
        (!current ||
          !isDeepStrictEqual(
            item,
            incoming.find((i) => i.itemId === item.itemId),
          ))
      )
        sources[item.itemId] = current
          ? {
              ...current,
              parents: [...old.parents, ...current.parents].filter(
                (p, i, a) => a.findIndex((x) => x.itemId === p.itemId && x.versionId === p.versionId) === i,
              ),
            }
          : old;
      if (!sources[item.itemId]) throw new Error('配方条目来源不明');
    }
    const prev = row.richRecipe?.resolved ?? [];
    const setup: RichRecipeState['setup'] = {};
    for (const step of resolved.filter((i) => i.kind === 'setup')) {
      const held = row.richRecipe?.setup[step.itemId];
      if (held?.contract === hash(step.value)) setup[step.itemId] = held;
    }
    if (!schedules.managed) throw new Error('本机调度器不支持配方任务');
    const now = Date.now();
    const definitions: ManagedTaskDefinition[] = resolved
      .filter((i) => i.kind === 'tasks')
      .map((item) => {
        const t = recipeRichContentSchema.shape.tasks.element.parse({
          ...item.value,
          itemId: item.itemId,
          originId: item.originId,
          instruction: { kind: 'inline', value: item.value.instruction },
        });
        return {
          itemId: item.itemId,
          contract: hash([
            item.value,
            op.group,
            op.bot,
            resolved.filter((i) => ['rules', 'skills', 'files', 'memories', 'role', 'settings'].includes(i.kind)),
          ]),
          task: {
            id: managedId(op.install, item.itemId),
            chatId: op.group,
            revision: randomUUID(),
            name: t.name,
            instruction: String(item.value.instruction),
            spec: t.spec.kind === 'every' ? { ...t.spec, anchor: Math.ceil(now / 60000) * 60000 } : t.spec,
            timeZone: t.timeZone.kind === 'recommended' ? t.timeZone.iana : 'UTC',
            placement: { kind: t.placement },
            state: 'paused',
            createdBy: { via: 'desktop' },
            createdAt: now,
            updatedAt: now,
            cursor: now,
            counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 },
            recent: [],
          },
        };
      });
    await schedules.managed.stage(op.install, op.generation, definitions);
    await withRegisteredBot(
      bot.appId,
      () =>
        mutateProjectStore(loc, async (stored, rows) => {
          const j = getOp(stored, op.id);
          if (j.status !== 'redeemed') throw new Error('配方操作状态已改变');
          const current = rows.find((r) => r.chatId === op.group && !r.dm);
          if (!current || frozen(current) !== op.rowDigest) {
            j.status = 'rejected';
            j.reason = '群设置或绑定已改变';
          } else {
            await member();
            applyNativeRecipeFields(current, resolved, prev);
            current.richRecipe = {
              pointer: package_.pointer,
              bindingIncarnation: current.bindingIncarnation!,
              resolved,
              sources,
              choices: op.choices,
              setup,
              installedAt: now,
              receipt: op.id,
            };
            j.status = 'applied';
          }
          return { changed: true, value: undefined };
        }),
      bot,
    );
    schedules.managed.wake();
  });
}

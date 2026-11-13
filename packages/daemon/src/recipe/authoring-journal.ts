import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuthoringAuthorization, AuthoringOperation, RecipeSetup } from '@vonvon/protocol';
import { acquireMutex, closeMutex } from '../config/data-access';
import { ensureDurableDirectory, syncDirectory } from '../config/bot-namespace';
import { readLocalText } from '../import/bridge/bounded-local-files';
import { writeFileAtomic } from '../server/atomic-file';
import { digest } from './authoring-wire';
import type { CardMode } from './authoring-im';

export const DAY = 86_400_000;
export interface Recipient { openId: string; chatId: string; tenantKey: string }
export function sameRecipient(a: Recipient | undefined, b: Recipient | undefined) {
  return Boolean(a && b && a.openId === b.openId && a.chatId === b.chatId && a.tenantKey === b.tenantKey);
}
export interface Source { groupId: string; reviewToken: string; setup?: RecipeSetup }
export interface Link { bot: string; binding: string; recipient: Recipient; sources: Source[]; context?: {operationId: string; until: number} }
export interface Carrier {
  ref: string; sendUuid: string; generation: number; seq: number; mode: CardMode; dirty: boolean;
  cardId?: string; messageId?: string; firstSend?: number;
}
export const newCarrier = (mode: CardMode, generation = 1): Carrier => ({
  ref: randomUUID(), sendUuid: randomUUID(), generation, seq: 0, mode, dirty: false,
});
export interface LocalOperation {
  view: AuthoringOperation;
  accountId: string; scope: string; bot: string; binding: string; recipient: Recipient; carrier: Carrier;
  secret?: string; nonce?: string; source?: Source; payload?: string; proposalDigest?: string;
  dispatchAuthorization?: AuthoringAuthorization;
  dispatched: boolean; contextOpen?: boolean; instructionId?: string; seenInstructions?: string[]; terminalAt?: number; contextUntil?: number;
}
export interface AuthoringLedger {
  version: 1; links: Record<string, Link>; operations: Record<string, LocalOperation>;
  daily: Record<string, {day: string; count: number}>;
}
export const active = (op: LocalOperation) => op.terminalAt === undefined;
export function retire(op: LocalOperation, state: 'completed' | 'cancelled' | 'expired', now: number) {
  op.view.state = state;
  op.view.deliveryUnknown = false;
  op.terminalAt = now;
  delete op.secret; delete op.nonce; delete op.dispatchAuthorization; delete op.payload; delete op.source;
  delete op.view.payloadDigest; delete op.proposalDigest;
}
export function maintain(ledger: AuthoringLedger, now: number) {
  for (const [id, op] of Object.entries(ledger.operations)) {
    if (active(op) && op.view.createdAt + DAY <= now) {
      // An accept response may have been lost. Only an authoritative cloud receipt settles it.
      if (op.view.state === 'pendingCloud' || op.view.state === 'cancelPending') {
        op.view.state = 'cancelPending';
        if (op.view.createdAt + 8 * DAY <= now) delete ledger.operations[id];
      } else retire(op, 'expired', op.view.createdAt + DAY);
    } else if (op.terminalAt !== undefined && op.terminalAt + 7 * DAY <= now) delete ledger.operations[id];
  }
  const day = new Date(now).toISOString().slice(0,10);
  for (const [key, budget] of Object.entries(ledger.daily)) if (budget.day !== day) delete ledger.daily[key];
}
export function reserve(ledger: AuthoringLedger, account: string, now: number) {
  const day = new Date(now).toISOString().slice(0,10);
  const count = ledger.daily[account]?.day === day ? ledger.daily[account]!.count : 0;
  if (count >= 60 || Object.values(ledger.operations).filter(op => op.accountId === account && active(op)).length >= 3)
    throw new Error('进行中的配方请求或今日请求数已到上限。');
  ledger.daily[account] = {day, count: count + 1};
}
export function linkKey(scope: string, account: string) { return digest(JSON.stringify([scope, account])); }
export class AuthoringJournal {
  constructor(private readonly root: string, private readonly now: () => number) {}
  async run<T>(edit: (ledger: AuthoringLedger) => T): Promise<T> {
    const dir = join(this.root, 'recipe-authoring');
    await ensureDurableDirectory(dir);
    const file = join(dir, 'journal.json');
    const lock = await acquireMutex(dir, 'creation', 10000);
    try {
      const before = await readLocalText(dir, file, undefined, 8 * 1024 * 1024);
      const ledger: AuthoringLedger = before === undefined ? {version: 1, links: {}, operations: {}, daily: {}} : JSON.parse(before);
      if (ledger.version !== 1 || !ledger.links || !ledger.operations || !ledger.daily) throw new Error('配方操作记录无法读取。');
      maintain(ledger, this.now());
      const result = edit(ledger);
      const after = JSON.stringify(ledger);
      if (after !== before) {
        if (Buffer.byteLength(after) > 8 * 1024 * 1024) throw new Error('本机配方操作记录已满。');
        await writeFileAtomic(file, after, {durable: true});
      }
      // The atomic writer allows a best-effort directory fsync. Authoring's next irreversible action needs a durable result.
      await syncDirectory(dir);
      return structuredClone(result);
    } finally { await closeMutex(lock); }
  }
}

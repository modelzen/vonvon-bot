import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { directoryFields, ObjectSchema, SafeAppIdSchema, type Allocation } from './bot-namespace';

const account = { version: z.literal(1), appId: SafeAppIdSchema, tenant: z.enum(['feishu', 'lark']) };
const chat = { ...account, chatId: z.string().regex(/^oc_[\w-]{1,200}$/), initialName: z.string().min(1).max(2000) };
const ContainerSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...account, ...directoryFields, state: z.literal('reserved') }),
  z.strictObject({ ...account, ...directoryFields, state: z.literal('ready'), object: ObjectSchema }),
]);
const GroupSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...chat, ...directoryFields, state: z.literal('reserved') }),
  z.strictObject({ ...chat, ...directoryFields, state: z.literal('ready'), object: ObjectSchema }),
]);
const StateSchema = z.strictObject({
  groupContainers: z.record(z.string(), ContainerSchema).optional(),
  groupAllocations: z.record(z.string(), GroupSchema).optional(),
});
export type GroupNamespaceState = z.infer<typeof StateSchema>;
export function groupAllocationKey(input: { appId: string; tenant: string; chatId: string }): string {
  return JSON.stringify([input.appId, input.tenant, input.chatId]);
}
export function parseGroupNamespaces(raw: unknown, bots: Record<string, Allocation> | undefined): GroupNamespaceState {
  const state = StateSchema.parse(raw);
  if (Object.keys(state.groupContainers ?? {}).length > 4096 || Object.keys(state.groupAllocations ?? {}).length > 4096) throw new Error('Group allocation limit reached');
  for (const [key, claim] of Object.entries(state.groupContainers ?? {})) {
    const bot = bots && Object.hasOwn(bots, key) ? bots[key] : undefined;
    if (key !== claim.appId || !bot || bot.state !== 'ready' || bot.tenant !== claim.tenant
      || claim.parent !== bot.namespaceRoot || claim.namespaceRoot !== join(claim.parent, 'groups')
      || claim.parentIdentity.dev !== bot.object.dev || claim.parentIdentity.ino !== bot.object.ino) throw new Error('Invalid group container claim');
  }
  const occupied = new Set<string>();
  for (const [key, claim] of Object.entries(state.groupAllocations ?? {})) {
    const container = state.groupContainers?.[claim.appId];
    const component = JSON.stringify([claim.parent, basename(claim.namespaceRoot).normalize('NFKC').toLowerCase()]);
    if (key !== groupAllocationKey(claim) || !container || container.state !== 'ready' || container.tenant !== claim.tenant
      || claim.parent !== container.namespaceRoot || dirname(claim.namespaceRoot) !== claim.parent
      || claim.parentIdentity.dev !== container.object.dev || claim.parentIdentity.ino !== container.object.ino || occupied.has(component)) throw new Error('Invalid group directory claim');
    occupied.add(component);
  }
  return state;
}

import {z} from 'zod';
import {agentIdSchema, groupIdSchema} from './domain.js';

export const groupConfigurationLocatorSchema = z.object({
  botAppId: agentIdSchema,
  groupId: groupIdSchema,
}).strict();
export type GroupConfigurationLocator = z.infer<typeof groupConfigurationLocatorSchema>;
const groupConfigurationLinkSchema = groupConfigurationLocatorSchema.extend({scheme: z.enum(['vonvon', 'vonvon-preview'])});
const groupRoute = /^([a-z-]+):\/\/groups\/(cli_[A-Za-z0-9_-]{1,200})\/(oc_[A-Za-z0-9_-]{1,200})$/;

export function parseGroupConfigurationLink(raw: unknown): z.infer<typeof groupConfigurationLinkSchema> | undefined {
  if (typeof raw !== 'string') return;
  const match = groupRoute.exec(raw);
  if (!match || match[0] !== raw) return;
  const parsed = groupConfigurationLinkSchema.safeParse({scheme: match[1], botAppId: match[2], groupId: match[3]});
  return parsed.success ? parsed.data : undefined;
}

export const groupNavigationIdSchema = z.string().uuid();
export const groupConfigurationNavigationSchema = groupConfigurationLocatorSchema.extend({
  navigationId: groupNavigationIdSchema,
}).strict();
export type GroupConfigurationNavigation = z.infer<typeof groupConfigurationNavigationSchema>;
export interface GroupNavigationShell {
  pending(): Promise<GroupConfigurationNavigation[]>;
  onOpen(listener: (navigation: GroupConfigurationNavigation) => void): () => void;
  acknowledge(navigationId: string): Promise<void>;
}

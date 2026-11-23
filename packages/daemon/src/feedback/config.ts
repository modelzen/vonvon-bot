import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {Project} from '../project/registry';
import {feedbackDestinationSchema, type FeedbackDestination} from './types';

const config = z.object({
  revision: z.string().uuid(), registration: z.string().min(1), bindingIncarnation: z.string().min(1),
  destination: feedbackDestinationSchema,
}).strict();
export type GroupFeedbackConfig = z.infer<typeof config>;

/** Only canonical Feishu Base and form-share URLs from an explicit SDK command. */
export function setupDestination(text: string): FeedbackDestination | undefined {
  const base = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.feishu\.cn\/base\/([a-zA-Z0-9]+)\?table=(tbl[a-zA-Z0-9]+)(?:&view=vew[a-zA-Z0-9]+)?$/;
  const form = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.feishu\.cn\/share\/base\/(shr[a-zA-Z0-9]+)$/;
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 4 || parts[0] !== '/feedback' || parts[1] !== 'setup') return;
  const match = base.exec(parts[2]!);
  return feedbackDestinationSchema.safeParse({baseToken: match?.[1], tableId: match?.[2], shareToken: form.exec(parts[3]!)?.[1]}).data;
}

export type FeedbackBinding = Pick<Project, 'createdAt' | 'bindingIncarnation'>;

export function feedbackBinding(project?: Project): FeedbackBinding | undefined {
  if (project && !project.dm && project.enabled !== false)
    return {createdAt: project.createdAt, bindingIncarnation: project.bindingIncarnation};
}

export function configuredFeedback(project: Project | undefined, registration: string): GroupFeedbackConfig | undefined {
  const saved = config.safeParse(project?.feedback).data;
  if (saved && saved.registration === registration && saved.bindingIncarnation === feedbackBinding(project)?.bindingIncarnation) return saved;
}

export function configureFeedback(project: Project, registration: string, destination: FeedbackDestination, expected: FeedbackBinding): void {
  if (!isDeepStrictEqual(feedbackBinding(project), expected)) throw new Error('群绑定已变化，请在当前群重新配置。');
  const prior = configuredFeedback(project, registration);
  if (prior && isDeepStrictEqual(prior.destination, destination)) return;
  // Pre-existing ordinary groups can acquire their first incarnation in the same registry commit as setup.
  const bindingIncarnation = project.bindingIncarnation ?? randomUUID();
  const saved = config.parse({revision: randomUUID(), registration, bindingIncarnation, destination});
  project.bindingIncarnation = bindingIncarnation;
  project.feedback = saved;
}

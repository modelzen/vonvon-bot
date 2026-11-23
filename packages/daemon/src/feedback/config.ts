import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {Project} from '../project/registry';
import {feedbackDestinationSchema, type FeedbackDestination} from './types';

const config = z.object({
  revision: z.string().uuid(), registration: z.string().min(1), installation: z.string().regex(/^[0-9a-f]{64}$/),
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

export function feedbackInstallation(project: Project | undefined): string | undefined {
  const state = project?.richRecipe;
  if (!project || project.dm || project.enabled === false || !project.bindingIncarnation || !state?.pointer
    || state.bindingIncarnation !== project.bindingIncarnation || state.pointer.format !== 'recipe-generation-1') return;
  const {installationId, generationId, resolvedSha256, release} = state.pointer;
  if (!installationId || !generationId || !resolvedSha256 || !release?.versionId || !release.contentSha256) return;
  return createHash('sha256').update(JSON.stringify([project.bindingIncarnation, installationId, generationId, resolvedSha256,
    release.recipeId, release.versionId, release.authorId, release.revision, release.contentSha256])).digest('hex');
}

export function configuredFeedback(project: Project | undefined, registration: string): GroupFeedbackConfig | undefined {
  const saved = config.safeParse(project?.feedback).data;
  if (saved && saved.registration === registration && saved.installation === feedbackInstallation(project)) return saved;
}

export function configureFeedback(project: Project, registration: string, destination: FeedbackDestination): void {
  const binding = feedbackInstallation(project);
  if (!binding) throw new Error('请先在本群安装反馈配方并启用本群。');
  const prior = configuredFeedback(project, registration);
  if (prior && isDeepStrictEqual(prior.destination, destination)) return;
  project.feedback = {revision: randomUUID(), registration, installation: binding, destination};
}

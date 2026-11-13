import type { RecipeAuthorization, RecipeManifest, RecipeSetup } from '@vonvon/protocol';
import type { BotIdentity } from '../config/bots';

export interface RecipeInstallation {
  recipeId: string;
  versionId: string;
  authorId: string;
  revision: number;
  access: 'direct' | 'coded';
  manifestSha256: string;
  installedAt: number;
  base: {role: string; setup?: RecipeSetup};
  setup?: RecipeSetup;
}
export interface RecipePreparation {
  operationId: string;
  accountId: string;
  bot: BotIdentity;
  groupId: string;
  bindingIncarnation: string;
  projectSettingsRevision: number;
  settingsSha256: string;
  manifest: string;
  manifestSha256: string;
  incoming: RecipeManifest;
  role: string;
  setup?: RecipeSetup;
  nonce: string;
  nonceCommitment: string;
  targetPublicKey: string;
  createdAt: number;
  cloudCompletion: 'none' | 'required' | 'confirmed';
  preparationSha256?: string;
  issuerState: 'unissued' | 'issuing' | 'authorized';
}
export type RecipeOperation = RecipePreparation & (
  | {status: 'prepared'; authorization?: RecipeAuthorization}
  | {status: 'in_progress'; authorization: RecipeAuthorization}
  | {status: 'applied' | 'rejected'; authorization?: RecipeAuthorization; reason?: string; completedAt: number}
);

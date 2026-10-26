import type { BackendAccount } from '@vonvon/protocol';

/** Project only safe metadata from account/read; never return email or credentials. */
export function codexAccountMetadata(value: unknown): BackendAccount | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const account = value as Record<string, unknown>;
  if (account.type === 'apiKey') return {kind: 'api', apiProvider: 'openai'};
  if (account.type === 'amazonBedrock') return {kind: 'api', apiProvider: 'amazonBedrock'};
  if (account.type !== 'chatgpt') return {kind: 'unknown'};
  const plan = typeof account.planType === 'string' ? account.planType.toLowerCase() : '';
  // Usage-based business/enterprise plans do not imply a subscription quota.
  const kind = plan === 'free' ? 'free' : ['go', 'plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu'].includes(plan) ? 'subscription' : 'unknown';
  return {kind, ...(/^[a-z0-9_-]{1,80}$/.test(plan) ? {planType: plan} : {}), apiProvider: 'chatgpt'};
}

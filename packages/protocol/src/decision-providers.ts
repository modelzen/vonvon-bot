/** Hosted decisions use the Jev/System One wire format; native language-model providers are unchanged. */
export const DECISION_API_PROVIDERS = ['typesafe', 'openrouter', 'vercel', 'custom'] as const;
export const JUDGE_PROVIDER_IDS = ['codex-appserver', 'claude-agent', ...DECISION_API_PROVIDERS] as const;
export const decisionApiProviderLabel = (id: string): string =>
  ({typesafe: 'TypeSafe', openrouter: 'OpenRouter', vercel: 'Vercel', custom: '自定义 Jev'} as Record<string, string>)[id] ?? id;

/** A complete endpoint, never a URL carrying a credential. Error text must not echo the supplied URL. */
export function decisionEndpointProblem(value: string | undefined): string | undefined {
  if (!value?.trim()) return '请填写自定义决策接口地址。';
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value.trim())) return '接口地址格式不正确。';
  try {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#]/u.test(value))
      return '接口地址须为 HTTP 或 HTTPS，不能含账号、密码、查询参数或片段。';
  } catch { return '请填写完整的 HTTP 或 HTTPS 接口地址。'; }
}

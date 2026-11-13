declare const __VONVON_ACCOUNT_API_ORIGIN__: string | undefined;

export function configuredRecipeApiOrigin(): string | undefined {
  const value = typeof __VONVON_ACCOUNT_API_ORIGIN__ === 'undefined'
    ? process.env.VONVON_ACCOUNT_API_ORIGIN : __VONVON_ACCOUNT_API_ORIGIN__;
  if (!value || !URL.canParse(value)) return;
  const url = new URL(value);
  if (url.protocol !== 'https:' || (value !== url.origin && value !== url.origin + '/')) return;
  return url.origin;
}

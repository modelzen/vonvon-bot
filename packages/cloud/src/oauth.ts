import { z } from "zod";
import type { Provider } from "./store/repository.js";

export interface OAuthIdentity {
  subject: string;
  name: string;
  avatarUrl?: string;
}

export interface OAuthProviderConfig {
  appId: string;
  appSecret: string;
}

const tokenBodySchema = z.object({
  code: z.number().optional(),
  msg: z.string().nullish(),
  access_token: z.string().nullish(),
});

const userBodySchema = z.object({
  code: z.number().optional(),
  msg: z.string().nullish(),
  data: z.object({
    union_id: z.string().nullish(),
    open_id: z.string().nullish(),
    name: z.string().nullish(),
    en_name: z.string().nullish(),
    avatar_url: z.string().nullish(),
  }).nullish(),
});

export class FeishuOAuth {
  readonly #publicBaseUrl: string;
  readonly #providers: Partial<Record<Provider, OAuthProviderConfig>>;
  readonly #fetch: typeof fetch;

  constructor(options: {
    publicBaseUrl: string;
    providers: Partial<Record<Provider, OAuthProviderConfig>>;
    fetch?: typeof fetch;
  }) {
    this.#publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.#providers = options.providers;
    this.#fetch = options.fetch ?? fetch;
  }

  available(provider: Provider): boolean {
    const config = this.#providers[provider];
    return Boolean(config?.appId && config.appSecret);
  }

  authorizationUrl(provider: Provider, state: string): string {
    const config = this.#required(provider);
    const host = provider === 'feishu' ? 'accounts.feishu.cn' : 'accounts.larksuite.com';
    const url = new URL(`https://${host}/open-apis/authen/v1/authorize`);
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', this.#redirectUri(provider));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchange(provider: Provider, code: string): Promise<OAuthIdentity> {
    const config = this.#required(provider);
    const apiHost = provider === 'feishu' ? 'open.feishu.cn' : 'open.larksuite.com';
    const tokenResponse = await this.#fetch(
      `https://${apiHost}/open-apis/authen/v2/oauth/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: config.appId,
          client_secret: config.appSecret,
          code,
          redirect_uri: this.#redirectUri(provider),
        }),
      },
    );
    const tokenResult = tokenBodySchema.safeParse(await tokenResponse.json().catch(() => undefined));
    if (!tokenResult.success || !tokenResponse.ok) {
      throw new Error(`SSO_TOKEN_EXCHANGE_FAILED:${tokenResponse.status}`);
    }
    const tokenBody = tokenResult.data;
    if (tokenBody.code !== undefined && tokenBody.code !== 0 || !tokenBody.access_token) {
      throw new Error(`SSO_TOKEN_EXCHANGE_FAILED:${tokenResponse.status}`);
    }
    const userResponse = await this.#fetch(
      `https://${apiHost}/open-apis/authen/v1/user_info`,
      { headers: { authorization: `Bearer ${tokenBody.access_token}` } },
    );
    const userResult = userBodySchema.safeParse(await userResponse.json().catch(() => undefined));
    if (!userResult.success || !userResponse.ok) {
      throw new Error(`SSO_USER_INFO_FAILED:${userResponse.status}`);
    }
    const userBody = userResult.data;
    const subject = userBody.data?.union_id ?? userBody.data?.open_id;
    if (userBody.code !== 0 || !subject) {
      throw new Error(`SSO_USER_INFO_FAILED:${userResponse.status}`);
    }
    return {
      subject,
      name: userBody.data?.name ?? userBody.data?.en_name ?? 'Vonvon 用户',
      ...(userBody.data?.avatar_url ? { avatarUrl: userBody.data.avatar_url } : {}),
    };
  }

  #redirectUri(provider: Provider): string {
    return `${this.#publicBaseUrl}/v1/auth/callback/${provider}`;
  }

  #required(provider: Provider): OAuthProviderConfig {
    const config = this.#providers[provider];
    if (!config?.appId || !config.appSecret) {
      throw new Error(`SSO_PROVIDER_UNAVAILABLE:${provider}`);
    }
    return config;
  }
}

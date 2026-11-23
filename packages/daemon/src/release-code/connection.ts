import { z } from 'zod';

declare const __VONVON_RELEASE_CODE_MCP_URL__: string | undefined;
declare const __VONVON_RELEASE_CODE_ISSUER__: string | undefined;

export type ReleaseCodeTool = 'rg' | 'read';
const CLIENT = 'vonvon-feedback-bot';
const scope = 'release-code:read offline_access';
const device = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});
const tokens = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
});
type Tokens = { access: string; refresh?: string; expires: number };
type Pending = {
  code: string;
  verification: string;
  userCode: string;
  expires: number;
  interval: number;
  next: number;
};

export function releaseCodeDeployment() {
  return {
    url:
      typeof __VONVON_RELEASE_CODE_MCP_URL__ === 'string'
        ? __VONVON_RELEASE_CODE_MCP_URL__
        : 'https://code.vonvon.cc/mcp',
    issuer:
      typeof __VONVON_RELEASE_CODE_ISSUER__ === 'string'
        ? __VONVON_RELEASE_CODE_ISSUER__
        : 'https://code.vonvon.cc/release-code/oauth',
  };
}
export class CodeAccessError extends Error {}

/** Credentials belong to one verified Bot registration and one actual Feishu sender.
 * Keep them out of group workspaces, transcripts, child-process environments and logs. */
export class ReleaseCodeConnections {
  private readonly accounts = new Map<string, Tokens>();
  private readonly pending = new Map<string, Pending>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly deployment = releaseCodeDeployment(),
    private readonly send = fetch
  ) {
    for (const raw of [deployment.url, deployment.issuer]) {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new Error('Invalid release-code endpoint');
    }
  }

  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(key) ?? Promise.resolve()).then(() => {
      this.lifetime.signal.throwIfAborted();
      return work();
    });
    const tail = run
      .then(
        () => {},
        () => {}
      )
      .finally(() => {
        if (this.lanes.get(key) === tail) this.lanes.delete(key);
      });
    this.lanes.set(key, tail);
    return run;
  }
  private async post(route: string, fields: Record<string, string>) {
    const response = await this.send(this.deployment.issuer + route, {
      method: 'POST',
      redirect: 'error',
      body: new URLSearchParams({ client_id: CLIENT, resource: this.deployment.url, ...fields }),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(12000)]),
    });
    const body: unknown = await response.json();
    this.lifetime.signal.throwIfAborted();
    return { ok: response.ok, body };
  }
  private save(key: string, body: unknown, previous?: Tokens) {
    const token = tokens.parse(body);
    const value = {
      access: token.access_token,
      refresh: token.refresh_token ?? previous?.refresh,
      expires: Date.now() + 1000 * token.expires_in,
    };
    this.accounts.set(key, value);
    return value;
  }
  begin(key: string) {
    return this.serial(key, async () => {
      const existing = this.accounts.get(key);
      if (existing && existing.expires > Date.now()) return '已连接本人的 VonVon 账号。';
      for (const [id, p] of this.pending) if (Date.now() >= p.expires) this.pending.delete(id);
      let p = this.pending.get(key);
      if (!p) {
        if (this.pending.size >= 256) throw new CodeAccessError('正在进行的授权较多，请稍后再试。');
        const response = await this.post('/device/auth', { scope });
        if (!response.ok) throw new CodeAccessError('VonVon 账号服务暂不可用，请稍后重试。');
        const d = device.parse(response.body);
        const url = new URL(d.verification_uri);
        if (url.origin !== new URL(this.deployment.issuer).origin || url.username || url.password)
          throw new Error('Invalid verification origin');
        p = {
          code: d.device_code,
          userCode: d.user_code,
          verification: url.href,
          interval: 1000 * d.interval,
          expires: Date.now() + 1000 * d.expires_in,
          next: Date.now() + 1000 * d.interval,
        };
        this.pending.set(key, p);
      }
      return (
        '请在浏览器打开 ' +
        p.verification +
        '，用本人 VonVon 账号登录并核对验证码 ' +
        p.userCode +
        '。完成后在本私聊发送 /feedback code ready。'
      );
    });
  }
  finish(key: string) {
    return this.serial(key, async () => {
      const p = this.pending.get(key);
      if (!p && this.accounts.has(key)) return '已连接本人的 VonVon 账号。';
      if (!p || Date.now() >= p.expires) {
        this.pending.delete(key);
        throw new CodeAccessError('请发送 /feedback code login 获取新的授权码。');
      }
      if (Date.now() < p.next) throw new CodeAccessError('请稍等片刻，再发送 /feedback code ready。');
      p.next = Date.now() + p.interval;
      const result = await this.post('/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: p.code,
      });
      if (result.ok) {
        this.save(key, result.body);
        this.pending.delete(key);
        return '已连接本人的 VonVon 账号，可以回帮助群查阅发布版代码。';
      }
      const error = z.object({ error: z.string() }).safeParse(result.body).data?.error;
      if (error === 'slow_down') {
        p.interval += 5000;
        p.next = Date.now() + p.interval;
      }
      if (error === 'authorization_pending' || error === 'slow_down')
        throw new CodeAccessError('授权尚未完成，请在浏览器确认后再发送 /feedback code ready。');
      if (error === 'expired_token' || error === 'access_denied' || error === 'invalid_grant')
        this.pending.delete(key);
      throw new CodeAccessError('授权未完成，请重新发送 /feedback code login。');
    });
  }
  logout(key: string) {
    return this.serial(key, async () => {
      const credential = this.accounts.get(key);
      this.accounts.delete(key);
      this.pending.delete(key);
      if (credential?.refresh) {
        try {
          const response = await this.send(this.deployment.issuer + '/token/revocation', {
            method: 'POST',
            redirect: 'error',
            body: new URLSearchParams({
              client_id: CLIENT,
              token: credential.refresh,
              token_type_hint: 'refresh_token',
            }),
            signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(5000)]),
          });
          if (!response.ok) throw new Error('Revocation unavailable');
        } catch {
          return '本机已断开；账号服务暂未确认撤销，如需撤销服务端授权，请在 VonVon 账号网站退出。';
        }
      }
      return '已断开本人的代码查阅连接。';
    });
  }
  private token(key: string) {
    return this.serial(key, async () => {
      const value = this.accounts.get(key);
      if (value && value.expires > Date.now() + 5000) return value;
      if (value?.refresh) {
        const r = await this.post('/token', { grant_type: 'refresh_token', refresh_token: value.refresh });
        if (r.ok) return this.save(key, r.body, value);
        if (z.object({ error: z.literal('invalid_grant') }).safeParse(r.body).success) this.accounts.delete(key);
        else throw new CodeAccessError('暂时无法续签，请稍后重试。');
      }
      throw new CodeAccessError('请本人在 Bot 私聊发送 /feedback code login，完成 VonVon 账号授权。');
    });
  }
  async call(
    key: string,
    name: ReleaseCodeTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
    check: () => void
  ) {
    const credentials = await this.token(key);
    const stop = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(25000)]);
    const guard = () => {
      stop.throwIfAborted();
      check();
      if (this.accounts.get(key) !== credentials) throw new CodeAccessError('账号连接已变化，请重新发起查询。');
    };
    guard();
    const [{ Client }, { StreamableHTTPClientTransport, StreamableHTTPError }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    const client = new Client({ name: 'vonvon-feedback', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(this.deployment.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + credentials.access }, redirect: 'error' },
      fetch: (url, init) => {
        guard();
        return this.send(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([stop, ...(init?.signal ? [init.signal] : [])]),
        });
      },
    });
    try {
      await client.connect(transport, { signal: stop });
      const result = await client.callTool({ name, arguments: args }, undefined, { signal: stop });
      guard();
      const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(result.content);
      const text = content.map((c) => c.text).join('\n');
      if (result.isError) throw new CodeAccessError(text || '发布版代码查询未完成。');
      return text;
    } catch (error) {
      if (error instanceof StreamableHTTPError && error.code === 401) {
        if (this.accounts.get(key) === credentials) this.accounts.delete(key);
        throw new CodeAccessError('VonVon 账号授权已失效，请在本人 Bot 私聊发送 /feedback code login 重新连接。');
      }
      throw error;
    } finally {
      await client.close();
    }
  }
  close() {
    this.lifetime.abort();
    this.accounts.clear();
    this.pending.clear();
  }
}

import { describe, expect, it, vi } from "vitest";
import { FeishuOAuth } from "../src/oauth.js";
import type { Provider } from "../src/store/repository.js";

const hosts: Record<Provider, { accounts: string; api: string }> = {
  feishu: { accounts: "accounts.feishu.cn", api: "open.feishu.cn" },
  lark: { accounts: "accounts.larksuite.com", api: "open.larksuite.com" },
};

function oauth(fetcher?: typeof fetch) {
  return new FeishuOAuth({
    publicBaseUrl: "https://vonvon.example/",
    providers: {
      feishu: { appId: "feishu-app", appSecret: "feishu-secret" },
      lark: { appId: "lark-app", appSecret: "lark-secret" },
    },
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}

for (const provider of ["feishu", "lark"] as const) {
  describe(`${provider} OAuth`, () => {
    it("builds its own authorization host and callback with an unchanged state", () => {
      const client = oauth();
      const state = "opaque + state/?";
      const url = new URL(client.authorizationUrl(provider, state));
      expect(client.available(provider)).toBe(true);
      expect(url.origin).toBe(`https://${hosts[provider].accounts}`);
      expect(url.pathname).toBe("/open-apis/authen/v1/authorize");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: `${provider}-app`,
        redirect_uri: `https://vonvon.example/v1/auth/callback/${provider}`,
        state,
      });
    });

    it("exchanges a code and reads union identity with a token on the right host", async () => {
      const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
      const fakeFetch: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json(requests.length === 1
          ? { code: 0, access_token: "synthetic-access-token" }
          : { code: 0, data: { union_id: "synthetic-union", open_id: "synthetic-open", name: "Test User", avatar_url: "https://example.invalid/avatar" } });
      };
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code")).resolves.toEqual({
        subject: "synthetic-union", name: "Test User", avatarUrl: "https://example.invalid/avatar",
      });
      expect(requests.map((request) => request.url)).toEqual([
        `https://${hosts[provider].api}/open-apis/authen/v2/oauth/token`,
        `https://${hosts[provider].api}/open-apis/authen/v1/user_info`,
      ]);
      expect(requests[0]?.init).toEqual({
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: `${provider}-app`,
          client_secret: `${provider}-secret`,
          code: "synthetic-code",
          redirect_uri: `https://vonvon.example/v1/auth/callback/${provider}`,
        }),
      });
      expect(requests[1]?.init).toEqual({ headers: { authorization: "Bearer synthetic-access-token" } });
    });

    it("uses open_id and the fallback name when union_id and name are absent", async () => {
      const fakeFetch: typeof fetch = vi.fn()
        .mockResolvedValueOnce(Response.json({ access_token: "synthetic-access-token" }))
        .mockResolvedValueOnce(Response.json({ code: 0, data: { open_id: "synthetic-open", en_name: "English Name" } }));
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code")).resolves.toEqual({
        subject: "synthetic-open", name: "English Name",
      });
    });

    it("accepts unrelated fields and preserves nullish identity fallbacks", async () => {
      const fakeFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "synthetic-access-token", msg: null, extra: {} }))
        .mockResolvedValueOnce(Response.json({ code: 0, extra: [], data: {
          union_id: null, open_id: "synthetic-open", name: null, en_name: null, avatar_url: null, extra: true,
        } }));
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code")).resolves.toEqual({
        subject: "synthetic-open", name: "Vonvon 用户",
      });
    });

    it.each([
      ["number token", { access_token: 17 }],
      ["object token", { access_token: {} }],
      ["array token", { access_token: [] }],
      ["boolean token", { access_token: true }],
      ["null token", { access_token: null }],
      ["empty token", { access_token: "" }],
      ["string code", { code: "0", access_token: "synthetic-access-token" }],
      ["nonstring message", { msg: {}, access_token: "synthetic-access-token" }],
      ["null body", null],
      ["array body", []],
    ])("rejects malformed token response %s before user info", async (_case, body) => {
      const fakeFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(body))
        .mockResolvedValueOnce(Response.json({ code: 0, data: { union_id: "synthetic-union" } }));
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code"))
        .rejects.toThrow(/^SSO_TOKEN_EXCHANGE_FAILED:/);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["object union_id", { code: 0, data: { union_id: {}, name: 17, avatar_url: [] } }],
      ["number union_id", { code: 0, data: { union_id: 17 } }],
      ["array open_id", { code: 0, data: { open_id: [] } }],
      ["invalid unused open_id", { code: 0, data: { union_id: "synthetic-union", open_id: true } }],
      ["number name", { code: 0, data: { union_id: "synthetic-union", name: 17 } }],
      ["object en_name", { code: 0, data: { union_id: "synthetic-union", en_name: {} } }],
      ["array avatar", { code: 0, data: { union_id: "synthetic-union", avatar_url: [] } }],
      ["nonstring message", { code: 0, msg: [], data: { union_id: "synthetic-union" } }],
      ["string code", { code: "0", data: { union_id: "synthetic-union" } }],
      ["missing code", { data: { union_id: "synthetic-union" } }],
      ["null data", { code: 0, data: null }],
      ["array data", { code: 0, data: [] }],
      ["null body", null],
      ["array body", []],
    ])("rejects malformed user response %s", async (_case, body) => {
      const fakeFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ access_token: "synthetic-access-token" }))
        .mockResolvedValueOnce(Response.json(body));
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code"))
        .rejects.toThrow(/^SSO_USER_INFO_FAILED:/);
      expect(fakeFetch).toHaveBeenCalledTimes(2);
    });

    it.each(["token", "user"])("does not echo provider messages from %s failures", async (stage) => {
      const failure = Response.json({ code: 7, msg: "synthetic-secret synthetic-access-token", access_token: "synthetic-access-token", data: { union_id: "synthetic-union" } });
      const fakeFetch = vi.fn<typeof fetch>();
      if (stage === "user") fakeFetch.mockResolvedValueOnce(Response.json({ access_token: "synthetic-access-token" }));
      fakeFetch.mockResolvedValueOnce(failure);
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code"))
        .rejects.toThrow(stage === "token" ? /^SSO_TOKEN_EXCHANGE_FAILED:200$/ : /^SSO_USER_INFO_FAILED:200$/);
    });

    it.each(["token", "user"])("maps invalid JSON at the %s boundary to its safe failure prefix", async (stage) => {
      const fakeFetch = vi.fn<typeof fetch>();
      if (stage === "user") fakeFetch.mockResolvedValueOnce(Response.json({ access_token: "synthetic-access-token" }));
      fakeFetch.mockResolvedValueOnce(new Response("invalid synthetic-secret JSON"));
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code"))
        .rejects.toThrow(stage === "token" ? /^SSO_TOKEN_EXCHANGE_FAILED:200$/ : /^SSO_USER_INFO_FAILED:200$/);
    });

    it.each([
      ["HTTP failure", Response.json({ code: 0, access_token: "synthetic-access-token", msg: "rejected" }, { status: 401 })],
      ["provider error", Response.json({ code: 7, access_token: "synthetic-access-token", msg: "rejected" })],
      ["missing token", Response.json({ code: 0 })],
    ])("rejects token %s before requesting user info", async (_case, response) => {
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code"))
        .rejects.toThrow(/^SSO_TOKEN_EXCHANGE_FAILED:/);
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["HTTP failure", Response.json({ code: 0, data: { union_id: "synthetic-union" }, msg: "rejected" }, { status: 403 })],
      ["provider error", Response.json({ code: 7, data: { union_id: "synthetic-union" }, msg: "rejected" })],
      ["missing subject", Response.json({ code: 0, data: {} })],
    ])("rejects user info %s", async (_case, userResponse) => {
      const fakeFetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ code: 0, access_token: "synthetic-access-token" }))
        .mockResolvedValueOnce(userResponse);
      await expect(oauth(fakeFetch).exchange(provider, "synthetic-code"))
        .rejects.toThrow(/^SSO_USER_INFO_FAILED:/);
      expect(fakeFetch).toHaveBeenCalledTimes(2);
    });
  });
}

it("reports an unavailable provider before authorization or network exchange", async () => {
  const fakeFetch = vi.fn<typeof fetch>();
  const client = new FeishuOAuth({
    publicBaseUrl: "https://vonvon.example",
    providers: { feishu: { appId: "", appSecret: "synthetic-secret" } },
    fetch: fakeFetch,
  });
  expect(client.available("feishu")).toBe(false);
  expect(client.available("lark")).toBe(false);
  expect(() => client.authorizationUrl("feishu", "state")).toThrow("SSO_PROVIDER_UNAVAILABLE:feishu");
  await expect(client.exchange("lark", "synthetic-code")).rejects.toThrow("SSO_PROVIDER_UNAVAILABLE:lark");
  expect(fakeFetch).not.toHaveBeenCalled();
});

import { expect, it, vi } from "vitest";
import { allowedExternalUrl, groupUrl, openExternalUrl, copyAuthorizationUrl } from "../src/url-actions";

it("accepts each old main process destination for its own action", () => {
  for (const host of ["accounts.feishu.cn", "accounts.larksuite.com", "open.feishu.cn", "open.larksuite.com"]) {
    expect(allowedExternalUrl(`https://${host}/authorize?x=1`, "registration")).toBe(`https://${host}/authorize?x=1`);
  }
  expect(allowedExternalUrl("https://auth.openai.com/authorize", "authorization")).toBe("https://auth.openai.com/authorize");
  expect(allowedExternalUrl("https://claude.ai/verify", "verification")).toBe("https://claude.ai/verify");
  expect(allowedExternalUrl("https://open.feishu.cn/app/cli_1/event", "event-settings")).toBe("https://open.feishu.cn/app/cli_1/event");
  expect(allowedExternalUrl("https://open.feishu.cn/app/cli_1", "app-console")).toBe("https://open.feishu.cn/app/cli_1");
  expect(allowedExternalUrl("https://open.larksuite.com/app/cli_1/auth?q=im%3Aresource&op_from=openapi", "app-console"))
    .toBe("https://open.larksuite.com/app/cli_1/auth?q=im%3Aresource&op_from=openapi");
  expect(allowedExternalUrl("https://github.com/modelzen/vonvon-bot/releases", "releases"))
    .toBe("https://github.com/modelzen/vonvon-bot/releases");
  expect(groupUrl("oc_a/b", "omt_topic#admin"))
    .toBe("https://applink.feishu.cn/client/thread/open?open_chat_id=oc_a%2Fb&open_thread_id=omt_topic&thread_position=0");
  expect(groupUrl("oc_a/b", "invalid"))
    .toBe("https://applink.feishu.cn/client/chat/open?openChatId=oc_a%2Fb");
  expect(allowedExternalUrl(groupUrl("oc_a/b"), "group")).toBe(groupUrl("oc_a/b"));
});

it("opens on the client's machine and copies the validated job URL", async () => {
  const open = vi.fn();
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("window", {open});
  vi.stubGlobal("navigator", {clipboard: {writeText}});
  try {
    const registration = "https://accounts.feishu.cn/qr/abc";
    await openExternalUrl(registration, "registration");
    expect(open).toHaveBeenCalledWith(registration, "_blank", "noopener");
    await copyAuthorizationUrl(registration, "registration");
    expect(writeText).toHaveBeenCalledWith(registration);
    const openExternal = vi.fn(async () => {});
    await openExternalUrl("https://auth.openai.com/authorize", "authorization", {openExternal});
    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/authorize");
    expect(open).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

it("rejects non-HTTPS, credentials, ports, host confusion, and unrelated GitHub paths", () => {
  for (const value of [
    "javascript:alert(1)", "http://auth.openai.com", "https://auth.openai.com.evil.test",
    "https://user@auth.openai.com", "https://auth.openai.com:443/path",
    "https://auth.openai.com./path", "https://AUTH.OPENAI.COM.evil.test/path",
    "https://github.com/unrelated/repository", "https://auth.openai.com\\@evil.test/path",
  ]) expect(allowedExternalUrl(value, "authorization")).toBeNull();
  expect(allowedExternalUrl("https://auth.openai.com/authorize", "registration")).toBeNull();
  expect(allowedExternalUrl("https://github.com/modelzen/vonvon-bot/issues", "releases")).toBeNull();
  expect(allowedExternalUrl("https://open.feishu.cn/app/cli_1/other", "event-settings")).toBeNull();
  expect(allowedExternalUrl("https://open.feishu.cn/app/cli_1/event", "app-console")).toBeNull();
  expect(allowedExternalUrl("https://open.feishu.cn/app/", "app-console")).toBeNull();
  expect(allowedExternalUrl("https://accounts.feishu.cn/app/cli_1", "app-console")).toBeNull();
});

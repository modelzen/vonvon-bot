import { expect, it, vi } from "vitest";
import { allowedExternalUrl, botChatUrl, groupUrl, openExternalUrl, copyAuthorizationUrl, copyFeedback, copyShortcut } from "../src/url-actions";

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
  expect(allowedExternalUrl("https://vonvon.cc/changelog/", "releases")).toBe("https://vonvon.cc/changelog/");
  expect(allowedExternalUrl("https://vonvon.cc/get/", "download")).toBe("https://vonvon.cc/get/");
  expect(groupUrl("oc_a/b", "omt_topic"))
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
    expect(await copyAuthorizationUrl(registration, "registration")).toBe("copied");
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
  expect(allowedExternalUrl("https://github.com/modelzen/vonvon-bot/releases", "releases")).toBeNull();
  expect(allowedExternalUrl("https://vonvon.cc/get/", "releases")).toBeNull();
  expect(allowedExternalUrl("https://vonvon.cc/changelog/", "download")).toBeNull();
  expect(allowedExternalUrl("https://vonvon.cc.evil.test/get/", "download")).toBeNull();
  expect(allowedExternalUrl("http://vonvon.cc/get/", "download")).toBeNull();
  // 0.7.0 包里写的旧官网 bot.vonvon.cc 由服务器 301 到 vonvon.cc；新版本只放行 vonvon.cc 本身，子域名一律拒绝。
  for (const value of ["https://bot.vonvon.cc/get/", "https://www.vonvon.cc/get/", "https://evil.vonvon.cc/changelog/"]) {
    expect(allowedExternalUrl(value, "download")).toBeNull();
    expect(allowedExternalUrl(value, "releases")).toBeNull();
  }
  expect(allowedExternalUrl("https://open.feishu.cn/app/cli_1/other", "event-settings")).toBeNull();
  expect(allowedExternalUrl("https://open.feishu.cn/app/cli_1/event", "app-console")).toBeNull();
  expect(allowedExternalUrl("https://open.feishu.cn/app/", "app-console")).toBeNull();
  expect(allowedExternalUrl("https://accounts.feishu.cn/app/cli_1", "app-console")).toBeNull();
});

it("selects the link for a manual copy when the clipboard refuses", async () => {
  const registration = "https://accounts.feishu.cn/qr/abc";
  const writeText = vi.fn(async () => { throw new DOMException("Write permission denied.", "NotAllowedError"); });
  vi.stubGlobal("navigator", {clipboard: {writeText}, platform: "MacIntel"});
  try {
    const select = vi.fn();
    const outcome = await copyAuthorizationUrl(registration, "registration", select);
    expect(outcome).toBe("selected");
    expect(select).toHaveBeenCalledOnce();
    expect(copyFeedback(outcome)).toBe("已选中链接，按 ⌘C 复制");
    await expect(copyAuthorizationUrl(registration, "registration")).rejects.toThrow("Write permission denied.");
    vi.stubGlobal("navigator", {platform: "Win32"});
    expect(await copyAuthorizationUrl(registration, "registration", select)).toBe("selected");
    expect(copyFeedback("selected")).toBe("已选中链接，按 Ctrl+C 复制");
    await expect(copyAuthorizationUrl("https://accounts.feishu.cn.evil.test/qr", "registration", select)).rejects.toThrow("链接不是受支持的官方地址。");
    expect(select).toHaveBeenCalledTimes(2);
  } finally { vi.unstubAllGlobals(); }
  expect(copyFeedback("copied")).toBe("已复制");
  expect([copyShortcut("MacIntel"), copyShortcut("iPad"), copyShortcut("Win32"), copyShortcut("Linux x86_64")]).toEqual(["⌘C", "⌘C", "Ctrl+C", "Ctrl+C"]);
});

it('opens the intended Bot private chat without prefilled messages or other destinations', () => {
  const url=botChatUrl('cli_example','feishu');
  expect(allowedExternalUrl(url,'bot-chat')).toBe(url);
  for (const suffix of ['&text=send-this','#message','&redirect=https://evil.test']) expect(allowedExternalUrl(url+suffix,'bot-chat')).toBeNull();
  expect(allowedExternalUrl(botChatUrl('oc_group','feishu'),'bot-chat')).toBeNull();
});

it('accepts HTTP(S) recipe documents only through the explicit document purpose', async () => {
  const openExternal=vi.fn(async()=>{});
  for(const url of ['https://my.feishu.cn/share/base/shrcn3x5xZv5jqYAt2uNIFRr0be','https://vonvon.cc/docs/troubleshooting/','http://example.com/guide']) {
    expect(allowedExternalUrl(url,'recipe-document')).toBe(url);
    await openExternalUrl(url,'recipe-document',{openExternal});
    expect(openExternal).toHaveBeenLastCalledWith(url,'recipe-document');
  }
  for(const url of ['javascript:alert(1)','data:text/html,test','file:///tmp/private','//example.com','https://user:pass@example.com','https://user@example.com','https://','not a URL','https://example.com\\@other.com']) {
    expect(allowedExternalUrl(url,'recipe-document')).toBeNull();
    await expect(openExternalUrl(url,'recipe-document',{openExternal})).rejects.toThrow();
  }
  expect(openExternal).toHaveBeenCalledTimes(3);
  expect(allowedExternalUrl('http://auth.openai.com/authorize','authorization')).toBeNull();
});

it('opens a Lark bot on its own domain', () => {
  const url=botChatUrl('cli_example','lark');
  expect(url).toBe('https://applink.larksuite.com/client/bot/open?appId=cli_example');
  expect(allowedExternalUrl(url,'bot-chat')).toBe(url);
  expect(allowedExternalUrl('https://applink.example.com/client/bot/open?appId=cli_example','bot-chat')).toBeNull();
});

it('devices-ui-1b: opens Tailscale\'s download page and nothing else', () => {
  expect(allowedExternalUrl('https://tailscale.com/download', 'tailscale')).toBe('https://tailscale.com/download');
  for (const url of ['https://tailscale.com/download?x=1', 'http://tailscale.com/download', 'https://evil.com', 'https://tailscale.com/download/']) expect(allowedExternalUrl(url, 'tailscale')).toBeNull();
});

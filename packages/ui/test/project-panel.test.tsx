import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { membershipSchema, type ProjectSettingsView } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import { ConversationRow, conversationNote } from "../src/management/ProjectPanel";
import { membershipSettingsKey, ProjectPanel as GroupSettings } from "../src/settings/SettingsPanel";

const client = createClient({ isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {} });
const section = <T,>(stored: T) => ({ stored, effective: stored, revision: "r", access: { kind: "writable" as const }, apply: [] });
const view = (kind: string): ProjectSettingsView => ({
  scope: { kind: "project", botId: "cli_fixture" as ProjectSettingsView["scope"]["botId"], projectName: "demo" },
  sections: {
    permission: section({ mode: "full" as const, guestMode: "full" as const, network: false }),
    response: section({ noMention: true }),
    model: section({ selection: { kind: "default" as const } }),
  } as unknown as ProjectSettingsView["sections"],
  identity: { chatId: "oc_demo", backend: "codex-appserver", cwd: "/tmp/demo", kind },
  members: { openIds: [], revision: "m" },
});
const settings = (kind: string) => renderToStaticMarkup(<ClientProvider client={client}><GroupSettings view={view(kind)} refresh={async () => {}} /></ClientProvider>);

it("s25c: a 智能 group's settings show 免 @ as the Bot's call, with no switch; other groups keep the switch", () => {
  const smart = settings("smart");
  expect(smart).not.toContain("不 @ 也能发起任务");
  expect(smart).toContain("由 Bot 判断");
  expect(smart).toContain('id="setting-%E7%BE%A4%E5%86%85%E5%93%8D%E5%BA%94"');
  for (const kind of ["multi", "single"]) {
    expect(settings(kind)).toContain("不 @ 也能发起任务");
    expect(settings(kind)).not.toContain("由 Bot 判断");
  }
});

it("s25c: the group page picks among the three 会话方式 in 3.4's order", () => {
  const html = renderToStaticMarkup(<ConversationRow target="smart" current="smart" disabled={false} onChange={() => {}} />);
  const options = [...html.matchAll(/<option value="(\w+)"( selected="")?>([^<]+)<\/option>/g)].map(match => [match[1], match[3], Boolean(match[2])]);
  expect(options).toEqual([["threads", "@ 我开新会话", false], ["shared", "整群一条会话", false], ["smart", "智能开话题", true]]);
  expect(html).toContain("主区一条会话，不用 @ 我也会看情况接话；聊到新的事，我自己开话题、起新会话");
});

it("s25c: says what a switch does to 免 @", () => {
  expect(conversationNote("smart", "shared")).toBe("智能开话题没有免 @，回不回由 Bot 判断；以后切回多会话或单会话时免 @ 是关。");
  expect(conversationNote("shared", "smart")).toBe("切过去以后免 @ 是关，需要时在本页的「不 @ 也能发起任务」里改。");
  expect(conversationNote("threads", "smart")).toBe("切过去以后免 @ 是关，需要时在本页的「不 @ 也能发起任务」里改。");
  expect(conversationNote("threads", "shared")).toBe("切换会话方式不改免 @，需要时在本页的「不 @ 也能发起任务」里改。");
});

it("s25c: switching 会话方式 remounts the group settings, which read once, so 免 @ follows it (审查 M2)", () => {
  const member = membershipSchema.parse({ id: '["cli_fixture","oc_demo"]', agentId: "cli_fixture", groupId: "oc_demo", name: "demo", directory: "/tmp/demo", backend: "codex-appserver",
    conversation: "shared", response: "mention", permission: { administrator: "full", member: "full", network: false }, stale: false });
  expect(membershipSettingsKey({ ...member, conversation: "smart" })).not.toBe(membershipSettingsKey(member));
  expect(membershipSettingsKey(member)).toBe(membershipSettingsKey({ ...member }));
});

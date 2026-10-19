import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { agentIdSchema, membershipSchema, type ProjectSettingsView } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import { appliedNotice, ConversationRow, conversationNote } from "../src/management/ProjectPanel";
import { groupJudgeVisible, membershipSettingsKey, ProjectPanel as GroupSettings } from "../src/settings/SettingsPanel";

const client = createClient({ isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {} });
const section = <const T,>(stored: T) => ({ stored, effective: stored, revision: "r", access: { kind: "writable" as const }, apply: [] });
type ViewOptions = Pick<ProjectSettingsView, "decisionModels"> & Pick<ProjectSettingsView["sections"], "run" | "judge"> & { backend?: string };
const view = (kind: string, options: ViewOptions = {}): ProjectSettingsView => ({
  scope: { kind: "project", botId: agentIdSchema.parse("cli_fixture"), projectName: "demo" },
  sections: {
    permission: section({ mode: "full" as const, guestMode: "full" as const, network: false }),
    response: section({ noMention: true }),
    model: section({ selection: { kind: "default" as const } }),
    ...(options.run ? { run: options.run } : {}),
    ...(options.judge ? { judge: options.judge } : {}),
  },
  decisionModels: options.decisionModels,
  identity: { chatId: "oc_demo", backend: options.backend ?? "codex-appserver", cwd: "/tmp/demo", kind },
  members: { openIds: [], revision: "m" },
});
const settings = (kind: string, options: ViewOptions = {}) => renderToStaticMarkup(<ClientProvider client={client}><GroupSettings view={view(kind, options)} refresh={async () => {}} /></ClientProvider>);

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

it("s25c: a save's warning is its own sentence; a removal's failed group step keeps its lead (审查低)", () => {
  expect(appliedNotice("项目已更新。", { warning: "已改成智能开话题，但没能在群里说一句：send refused" }, ""))
    .toBe("项目已更新。 已改成智能开话题，但没能在群里说一句：send refused");
  expect(appliedNotice("项目绑定已解除，目录已保留。", { warning: "permission denied" }))
    .toBe("项目绑定已解除，目录已保留。 飞书群后续操作未完成：permission denied");
  expect(appliedNotice("项目已更新。", {}, "")).toBe("项目已更新。");
});

const judge: NonNullable<ProjectSettingsView["sections"]["judge"]> = {
  ...section({ selection: { kind: "default" } }),
  effective: { selection: { kind: "llm", model: "gpt-6-luna", effort: "low" } },
};
const run: NonNullable<ProjectSettingsView["sections"]["run"]> = {
  ...section({ pendingPolicy: "default" }), effective: { pendingPolicy: "steer" },
};

it("s28a: only smart groups with a judge section expose the judge model", () => {
  expect(settings("smart", { judge })).toContain('aria-label="判断模型"');
  expect(settings("smart", { judge })).toContain("现在判断用：gpt-6-luna（推理强度 low）");
  expect(groupJudgeVisible(view("smart", { judge }))).toBe(true);
  for (const kind of ["multi", "single"]) {
    expect(settings(kind, { judge })).not.toContain('aria-label="判断模型"');
    expect(groupJudgeVisible(view(kind, { judge }))).toBe(false);
  }
  expect(settings("smart")).not.toContain('aria-label="判断模型"');
  expect(groupJudgeVisible(view("smart"))).toBe(false);
});

it("s28a: following the Bot's decision model still explains a missing key", () => {
  const html = settings("smart", {
    judge: { ...judge, effective: { selection: { kind: "decision", provider: "typesafe", model: "jev-latest" } } },
    decisionModels: [{ provider: "typesafe", displayName: "TypeSafe", keyId: "typesafe-api-key", keySet: false,
      models: [{ id: "jev-latest", displayName: "Jev" }] }],
  });
  expect(html).toContain("还没填 key");
  expect(html).toContain("vonvon secrets set typesafe-api-key");
});

it("s28a: Codex groups offer run policy choices and show the effective policy", () => {
  const html = settings("multi", { run });
  const select = html.match(/<select[^>]*aria-label="运行中来了消息"[^>]*>(.*?)<\/select>/s)?.[1];
  expect(select).toBeDefined();
  const options = [...(select ?? "").matchAll(/<option value="([^"]+)"( selected="")?>([^<]+)<\/option>/g)]
    .map(match => [match[1], match[3], Boolean(match[2])]);
  expect(options).toEqual([["default", "跟着 Bot 默认", true], ["steer", "插话", false], ["queue", "排队", false]]);
  expect(html).toContain("现在是插话");
});

it("s28a: Claude groups explain queueing without a selector; old daemons omit the row", () => {
  const html = settings("multi", { run: { ...run, effective: { pendingPolicy: "queue" } }, backend: "claude-agent" });
  expect(html).not.toContain('aria-label="运行中来了消息"');
  expect(html).toContain("Claude 不支持插话");
  expect(html).toContain("排队");
  expect(settings("multi")).not.toContain("运行中来了消息");
});


it('s28c: the conversation row recommends smart with other bots, including when already smart', () => {
  const hint = '群里还有别的 bot。几个 bot 都选智能，它们才能互相 @、各自判断接不接话。';
  for (const target of ['threads', 'shared', 'smart'] as const) {
    expect(renderToStaticMarkup(<ConversationRow target={target} current={target} disabled={false} onChange={() => {}} otherBots />)).toContain(hint);
    expect(renderToStaticMarkup(<ConversationRow target={target} current={target} disabled={false} onChange={() => {}} />)).not.toContain(hint);
  }
});

import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { agentIdSchema, membershipSchema, type ProjectSettingsView } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import { appliedNotice, ConversationRow, conversationNote, removalNotice } from "../src/management/ProjectPanel";
import { groupJudgeVisible, membershipSettingsKey, ProjectPanel as GroupSettings } from "../src/settings/SettingsPanel";
import {AnnouncedReadonlyMessages, OFFLINE_SETTINGS_MESSAGE} from "../src/settings/readonly-messages";

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
const radioOptions = (html: string) => [...html.matchAll(/<input\b[^>]*type="radio"[^>]*\/>/g)]
  .map(([input]) => [input.match(/value="([^"]+)"/)?.[1], input.includes('checked=""')]);

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
  expect(html).toContain('role="radiogroup" aria-label="项目会话方式"');
  expect(radioOptions(html)).toEqual([["threads", false], ["shared", false], ["smart", true]]);
  for (const label of ['@ 我开新会话', '整群一条会话', '智能开话题']) expect(html).toContain(label);
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

it('distinguishes removal of the local binding from the Feishu group outcome', () => {
  expect(removalNotice({groupEffect: 'left'})).toContain('Bot 已退出飞书群');
  expect(removalNotice({groupEffect: 'transferred'})).toContain('已转交飞书群主');
  const failed = removalNotice({groupEffect: 'failed', warning: 'permission denied'});
  expect(failed).toContain('群绑定已解除，工作目录和文件已保留');
  expect(failed).toContain('飞书群后续操作未完成：permission denied');
  expect(failed).not.toContain('Bot 已退出');
  expect(removalNotice({groupEffect: 'failed'})).toContain('请在飞书中检查');
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
  const policy = html.match(/role="radiogroup" aria-label="运行中来了消息">(.*?)<\/span><\/label><\/span>/s)?.[1];
  expect(policy).toBeDefined();
  expect(radioOptions(policy ?? '')).toEqual([["default", true], ["steer", false], ["queue", false]]);
  for (const label of ['跟着 Bot 默认', '插话', '排队']) expect(policy).toContain(label);
  expect(html).toContain("当前：插话");
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


it('announces repeated readonly reasons once without hiding field-specific restrictions', () => {
  const blocked = view('multi', {run});
  for (const section of Object.values(blocked.sections)) {
    if (section) section.access = {kind: 'readonly', ...OFFLINE_SETTINGS_MESSAGE};
  }
  blocked.sections.model.access = {kind: 'readonly', reason: 'owner-offline', message: '模型配置正在恢复，请稍后重试。'};
  const html = renderToStaticMarkup(<ClientProvider client={client}><GroupSettings view={blocked} refresh={async () => {}} /></ClientProvider>);
  expect(html.split(OFFLINE_SETTINGS_MESSAGE.message)).toHaveLength(2);
  expect(html).toContain('模型配置正在恢复，请稍后重试。');
  expect(html).toContain('Bot 管理员与所有者始终可用');
  for (const input of html.matchAll(/<input\b[^>]*type="radio"[^>]*\/>/g)) expect(input[0]).toContain('disabled=""');
});

it('retains distinct readonly warnings when a parent already explains the stopped Bot', () => {
  const blocked = view('multi');
  for (const section of Object.values(blocked.sections)) {
    if (section) section.access = {kind: 'readonly', ...OFFLINE_SETTINGS_MESSAGE};
  }
  blocked.sections.model.access = {kind: 'readonly', reason: 'owner-offline', message: '模型配置恢复失败，文件已保留。'};
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <AnnouncedReadonlyMessages.Provider value={[OFFLINE_SETTINGS_MESSAGE]}>
      <GroupSettings view={blocked} refresh={async () => {}} />
    </AnnouncedReadonlyMessages.Provider>
  </ClientProvider>);
  expect(html).not.toContain(OFFLINE_SETTINGS_MESSAGE.message);
  expect(html).toContain('模型配置恢复失败，文件已保留。');
});

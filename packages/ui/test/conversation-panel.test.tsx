import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps, MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentIdSchema, groupIdSchema, type CollaborationClient, type CollaborationReply, type Conversation } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import { ConversationPanel } from "../src/management/ConversationPanel";
import type { Button } from "../src/reference/components/ui";

type ButtonProps = ComponentProps<typeof Button>;
type Context = Extract<CollaborationReply, { kind: "context" }>;
const harness = vi.hoisted(() => ({
  state: [] as unknown[], index: 0,
  effects: [] as Array<{ callback: () => (() => void) | void; dependencies?: readonly unknown[] }>,
  buttons: [] as ButtonProps[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.index++;
    if (!Object.hasOwn(harness.state, index)) harness.state[index] = typeof initial === "function" ? initial() : initial;
    return [harness.state[index], (next: unknown) => {
      harness.state[index] = typeof next === "function" ? next(harness.state[index]) : next;
    }];
  },
  useEffect: (callback: () => (() => void) | void, dependencies?: readonly unknown[]) => { harness.effects.push({ callback, dependencies }); },
}));
vi.mock("../src/reference/components/ui", async (original) => {
  const actual = await original<typeof import("../src/reference/components/ui")>();
  return { ...actual, Button: (props: ButtonProps) => {
    harness.buttons.push(props);
    return <actual.Button {...props} />;
  } };
});
const client = createClient({ isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {} });
const target = { agentId: agentIdSchema.parse("cli_fixture"), projectName: "demo", groupId: groupIdSchema.parse("oc_fixture") };
const history: Extract<CollaborationReply, { kind: "history" }> = {
  kind: "history", sessions: [{ threadId: "thread", summary: "demo", sessionId: "session", backend: "codex-appserver", cwd: "/fixture", createdAt: 1, updatedAt: 1 }], threads: [], backend: "codex-appserver",
};
const subagents = [
  { id: "one", name: "数文件", task: "检查源码", status: "running", stoppable: true },
  { id: "two", name: "数测试", task: "检查测试", status: "completed", stoppable: true },
  { id: "three", name: "只读检查", task: "暂不支持停止", status: "running", stoppable: false },
] satisfies NonNullable<NonNullable<Context["run"]>["subagents"]>;
const context: Context = {
  kind: "context", threadId: "thread", usage: null,
  run: { id: "run", goal: false, canStop: true, canEndGoal: false, canRemind: false, reminderRequested: false, subagents },
};
function render(request: CollaborationClient, current = context, options: { busy?: boolean; conversation?: Conversation; preserve?: boolean } = {}) {
  if (!options.preserve) harness.state = [history, "thread", current, "", "all", options.busy ?? false, "", "", ""];
  harness.index = 0;
  harness.effects = [];
  harness.buttons = [];
  return renderToStaticMarkup(<ClientProvider client={client}><ConversationPanel {...target} conversation={options.conversation ?? "shared"} request={request} /></ClientProvider>);
}
function button(label: string): ButtonProps {
  const found = harness.buttons.find(item => item["aria-label"] === label || item.children === label);
  if (!found) throw new Error("Missing button: " + label);
  return found;
}
function pollEffect() {
  const effect = harness.effects.find(item => item.dependencies?.length === 3 && typeof item.dependencies[0] === "boolean");
  if (!effect) throw new Error("Missing live context poll");
  return effect.callback;
}
function requestFixture(current = context) {
  return vi.fn<CollaborationClient>(async request => request.action === "context" ? current : request.action === "history" ? history : { kind: "applied" });
}
async function click(label: string) {
  const action = button(label);
  expect(action.disabled).toBeFalsy();
  action.onClick?.({} as MouseEvent<HTMLButtonElement>);
  await vi.waitFor(() => expect(harness.state[5]).toBe(false));
}
afterEach(() => { vi.useRealTimers(); });

it("shows child names, tasks and statuses, and stops only the selected stoppable running child", async () => {
  const request = requestFixture();
  const html = render(request);
  for (const text of ["数文件", "检查源码", "运行中", "数测试", "检查测试", "已完成"]) expect(html).toContain(text);
  const childButtons = harness.buttons.filter(item => item["aria-label"]?.startsWith("停止子 agent "));
  expect(childButtons).toHaveLength(1);
  expect(childButtons[0]?.["aria-label"]).toBe("停止子 agent 数文件");
  await click("停止子 agent 数文件");
  expect(request).toHaveBeenCalledWith({ action: "stopSubagent", ...target, threadId: "thread", runId: "run", subagentId: "one" });
});

it("honors run capabilities and pending operations", () => {
  const request = requestFixture();
  render(request);
  expect(button("停止").disabled).toBe(false);
  expect(button("结束目标").disabled).toBe(true);
  expect(button("开启提醒").disabled).toBe(true);

  render(request, { ...context, run: { ...context.run!, canStop: false } });
  expect(button("停止").disabled).toBe(true);

  render(request, context, { busy: true });
  for (const label of ["停止", "停止子 agent 数文件", "结束目标", "开启提醒"])
    expect(button(label).disabled).toBe(true);
});

it("keeps clear restricted to the main conversation and disables mutations while pending", () => {
  const request = requestFixture();
  render(request, context);
  expect(button("清空会话").disabled).toBe(false);
  render(request, context, { conversation: "threads" });
  expect(button("清空会话").disabled).toBe(true);
  expect(button("压缩上下文").disabled).toBe(false);
  render(request, context, { busy: true });
  expect(button("清空会话").disabled).toBe(true);
  expect(button("压缩上下文").disabled).toBe(true);
});

it("keeps successful mutation feedback and shows an unconfirmed Feishu receipt separately", async () => {
  const warning = "操作已生效，但未能确认飞书回执已送达。无需重复执行。";
  const request = requestFixture();
  request.mockImplementation(async command => command.action === "context" ? context : command.action === "history" ? history : { kind: "applied", message: "上下文已压缩。", warning });
  render(request);
  await click("压缩上下文");
  const html = render(request, context, { preserve: true });
  expect(html).toContain("上下文已压缩。");
  expect(html).toContain("飞书回执未确认");
  expect(html).toContain(warning);
  expect(html).not.toContain("会话操作未完成");
  expect(request.mock.calls.filter(([command]) => command.action === "compact")).toHaveLength(1);
});

it("keeps controls for an existing goal without offering to create a goal", async () => {
  const current = { ...context, run: { ...context.run!, goal: true, canEndGoal: true } };
  const request = requestFixture(current);
  const html = render(request, current);
  expect(html).not.toContain("自主任务目标");
  expect(harness.buttons.some(item => item.children === "开始")).toBe(false);
  expect(html).toContain("自主目标运行中");
  await click("结束目标");
  expect(request).toHaveBeenCalledWith({ action: "endGoal", ...target, threadId: "thread", runId: "run" });
  expect(request.mock.calls.some(([command]) => command.action === "startGoal")).toBe(false);

  const idle = render(request, { ...context, run: null });
  expect(idle).not.toContain("自主任务目标");
  expect(harness.buttons.some(item => item.children === "开始")).toBe(false);
});

it.each([
  ["压缩上下文", { action: "compact" }],
  ["清空会话", { action: "clear" }],
  ["停止", { action: "stop", runId: "run" }],
  ["结束目标", { action: "endGoal", runId: "run" }],
  ["开启提醒", { action: "reminder", runId: "run", requested: true }],
] as const)("keeps the selected conversation and run in the %s request", async (label, action) => {
  const current = { ...context, run: { ...context.run!, canEndGoal: true, canRemind: true } };
  const request = requestFixture(current);
  render(request, current);
  await click(label);
  expect(request).toHaveBeenCalledWith({ ...action, ...target, threadId: "thread" });
});

it("polls live context every three seconds and cancels on cleanup or idle", async () => {
  vi.useFakeTimers();
  const request = requestFixture();
  render(request);
  const cleanup = pollEffect()();
  await vi.advanceTimersByTimeAsync(2999);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledExactlyOnceWith({ action: "context", ...target, threadId: "thread" });
  cleanup?.();
  await vi.advanceTimersByTimeAsync(6000);
  expect(request).toHaveBeenCalledTimes(1);
  render(request, { ...context, run: null });
  expect(pollEffect()()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(6000);
  expect(request).toHaveBeenCalledTimes(1);
});

it("ignores an in-flight context reply after the poll is cleaned up", async () => {
  vi.useFakeTimers();
  let resolve!: (reply: CollaborationReply) => void;
  const request = vi.fn<CollaborationClient>(() => new Promise(done => { resolve = done; }));
  render(request);
  const cleanup = pollEffect()();
  await vi.advanceTimersByTimeAsync(3000);
  cleanup?.();
  resolve({ ...context, run: null });
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.state[2]).toBe(context);
});

it("shows run status immediately and removes it when the run ends", () => {
  const request = requestFixture();
  const active = render(request);
  expect(active).toContain('role="status"');
  expect(active).toContain("当前任务运行中");
  expect(active).not.toContain("<canvas");
  expect(render(request, { ...context, run: { ...context.run!, goal: true } })).toContain("自主目标运行中");
  expect(render(request, { ...context, run: null })).not.toContain('aria-label="正在运行"');
});

it("does not display or poll another thread's retained run and context usage", () => {
  const request = requestFixture();
  const html = render(request, { ...context, threadId: "previous-thread", usage: { used: 32123, window: 100000 } });
  expect(html).toContain("暂无可用统计");
  expect(html).not.toContain('aria-label="正在运行"');
  expect(html).not.toContain("<progress");
  expect(harness.buttons.some(item => item.children === "停止")).toBe(false);
  expect(pollEffect()()).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});

it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])("shows measured tokens without a misleading percentage when the window is %s", window => {
  const html = render(requestFixture(), { ...context, usage: { used: 32123, window } });
  expect(html).toContain((32123).toLocaleString());
  expect(html).toContain("窗口未知");
  expect(html).not.toContain("<progress");
  expect(html).not.toMatch(/<small>[^<]*%<\/small>/);
});

it("shows usage against the reported context window", () => {
  const html = render(requestFixture(), { ...context, usage: { used: 32000, window: 100000 } });
  expect(html).toContain("32%");
  expect(html).toContain('<progress aria-label="上下文使用量" value="32000" max="100000"');
  expect(html).not.toContain("窗口未知");
});

import { afterEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { agentIdSchema, groupIdSchema, type CollaborationClient, type CollaborationReply } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import { ClientProvider } from "../src/client-context";
import { ConversationPanel } from "../src/management/ConversationPanel";

const harness = vi.hoisted(() => ({
  state: [] as unknown[], index: 0,
  effects: [] as Array<() => (() => void) | void>,
  rows: [] as Array<{ title: unknown; trailing?: unknown }>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.index++;
    const value = index < harness.state.length ? harness.state[index] : initial;
    return [value, (next: unknown) => { harness.state[index] = next; }];
  },
  useEffect: (effect: () => (() => void) | void) => { harness.effects.push(effect); },
}));
vi.mock("../src/reference/components/system-settings", async (original) => {
  const actual = await original<typeof import("../src/reference/components/system-settings")>();
  return { ...actual, SettingsRow: (props: Parameters<typeof actual.SettingsRow>[0]) => {
    harness.rows.push(props);
    return <actual.SettingsRow {...props} />;
  } };
});
const client = createClient({ isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {} });
const target = { agentId: agentIdSchema.parse("cli_fixture"), projectName: "demo", groupId: groupIdSchema.parse("oc_fixture") };
const subagents = [
  { id: "one", name: "数文件", task: "检查源码", status: "running", stoppable: true },
  { id: "two", name: "数测试", task: "检查测试", status: "completed", stoppable: true },
] satisfies NonNullable<NonNullable<Extract<CollaborationReply, { kind: "context" }>["run"]>["subagents"]>;
const context: Extract<CollaborationReply, { kind: "context" }> = {
  kind: "context", threadId: "thread", usage: null,
  run: { id: "run", goal: false, canStop: true, canEndGoal: false, canRemind: false, reminderRequested: false, subagents },
};
function render(request: CollaborationClient, current = context) {
  harness.state = [{ kind: "history", sessions: [{ threadId: "thread", summary: "demo", sessionId: "session", backend: "codex-appserver", cwd: "/fixture", updatedAt: 1 }], threads: [], backend: "codex-appserver" }, "thread", current];
  harness.index = 0;
  harness.effects = [];
  harness.rows = [];
  return renderToStaticMarkup(<ClientProvider client={client}><ConversationPanel {...target} conversation="shared" request={request} /></ClientProvider>);
}
afterEach(() => { vi.useRealTimers(); });

it("s34b: shows child names and statuses, and stops only the selected running child", async () => {
  const request = vi.fn<CollaborationClient>(async request => request.action === "context" ? context : request.action === "history" ? { kind: "history", sessions: [], threads: [], backend: "codex-appserver" } : { kind: "applied" });
  const html = render(request);
  expect(html).toContain("数文件：检查源码");
  expect(html).toContain("运行中");
  expect(html).toContain("数测试：检查测试");
  expect(html).toContain("已完成");
  expect(harness.rows.find(row => row.title === "数测试：检查测试")?.trailing).toBeUndefined();
  const stop = harness.rows.find(row => row.title === "数文件：检查源码")?.trailing;
  expect(isValidElement(stop)).toBe(true);
  if (!isValidElement<{ onClick: () => void; children: ReactNode }>(stop)) throw new Error("Missing child stop button");
  expect(stop.props.children).toBe("停止");
  stop.props.onClick();
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ action: "stopSubagent", ...target, threadId: "thread", runId: "run", subagentId: "one" }));
});

it("s34b: polls live context every three seconds and cancels on cleanup or idle", async () => {
  vi.useFakeTimers();
  const request = vi.fn<CollaborationClient>(async () => context);
  render(request);
  const poll = harness.effects[2];
  expect(poll).toBeDefined();
  const cleanup = poll?.();
  await vi.advanceTimersByTimeAsync(2999);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledExactlyOnceWith({ action: "context", ...target, threadId: "thread" });
  cleanup?.();
  await vi.advanceTimersByTimeAsync(6000);
  expect(request).toHaveBeenCalledTimes(1);
  render(request, { ...context, run: null });
  expect(harness.effects[2]?.()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(6000);
  expect(request).toHaveBeenCalledTimes(1);
});

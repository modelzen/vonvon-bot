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
    if (!Object.hasOwn(harness.state, index)) harness.state[index] = initial;
    const value = harness.state[index];
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
function render(request: CollaborationClient, current = context, preserveState = false) {
  if (!preserveState) harness.state = [];
  harness.state[0] = { kind: "history", sessions: [{ threadId: "thread", summary: "demo", sessionId: "session", backend: "codex-appserver", cwd: "/fixture", updatedAt: 1 }], threads: [], backend: "codex-appserver" };
  harness.state[1] = "thread";
  harness.state[2] = current;
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
  const poll = harness.effects[3];
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
  expect(harness.effects[3]?.()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(6000);
  expect(request).toHaveBeenCalledTimes(1);
});

it("shows one inline orb only after two seconds and clears it with the run", async () => {
  vi.useFakeTimers();
  const request = vi.fn<CollaborationClient>(async () => context);
  expect(render(request)).not.toContain("<canvas");
  const cleanup = harness.effects[2]?.();
  await vi.advanceTimersByTimeAsync(1999);
  expect(render(request, context, true)).not.toContain("<canvas");
  await vi.advanceTimersByTimeAsync(1);
  expect(render(request, context, true).match(/<canvas/g)).toHaveLength(1);
  cleanup?.();
  expect(render(request, { ...context, run: null }, true)).not.toContain("<canvas");
});

it("does not reveal an orb after a short run has ended", async () => {
  vi.useFakeTimers();
  const request = vi.fn<CollaborationClient>(async () => context);
  render(request);
  const cleanup = harness.effects[2]?.();
  await vi.advanceTimersByTimeAsync(1000);
  cleanup?.();
  expect(render(request, { ...context, run: null }, true)).not.toContain("<canvas");
  harness.effects[2]?.();
  await vi.advanceTimersByTimeAsync(2000);
  expect(render(request, { ...context, run: null }, true)).not.toContain("<canvas");
});

it("cancels the old delay and starts a fresh one when the run changes", async () => {
  vi.useFakeTimers();
  const request = vi.fn<CollaborationClient>(async () => context);
  render(request);
  const cleanup = harness.effects[2]?.();
  await vi.advanceTimersByTimeAsync(1500);
  cleanup?.();
  const replacement = { ...context, run: { ...context.run!, id: "replacement" } };
  expect(render(request, replacement, true)).not.toContain("<canvas");
  harness.effects[2]?.();
  await vi.advanceTimersByTimeAsync(500);
  expect(render(request, replacement, true)).not.toContain("<canvas");
  await vi.advanceTimersByTimeAsync(1500);
  expect(render(request, replacement, true).match(/<canvas/g)).toHaveLength(1);
});

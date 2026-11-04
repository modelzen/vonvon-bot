import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HostSettingsView } from "@vonvon/protocol";
import { createClient } from "../../client/src/client";
import type {VonvonClient} from '@vonvon/client/browser';
import { ClientProvider } from "../src/client-context";
import { CodexPathPanel, CodexPathSettings, HostPanel, readCodexPathView } from "../src/settings/SettingsPanel";
import {settingAnchor} from '../src/search';

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});

it('keeps a stable search target and a manual reread action while loading', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}><CodexPathSettings/></ClientProvider>);
  expect(html).toContain(`id="${settingAnchor('Codex 可执行文件')}"`);
  expect(html).toContain('正在读取路径配置');
  expect(html).toContain('重新读取路径配置');
});

it('times out an unanswered path read and allows a fresh read to recover', async () => {
  vi.useFakeTimers();
  try {
    const settings = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({kind: 'view', view});
    const reader = {settings} as unknown as Pick<VonvonClient, 'settings'>;
    const pending = readCodexPathView(reader, undefined, 10000);
    const failure = expect(pending).rejects.toThrow('读取超时，请重新读取路径配置。');
    await vi.advanceTimersByTimeAsync(10000);
    await failure;
    expect(await readCodexPathView(reader)).toBe(view);
    expect(settings).toHaveBeenCalledTimes(2);
  } finally {vi.useRealTimers();}
});

it('cancels an obsolete path read before a later result can replace it', async () => {
  const controller = new AbortController();
  const reader = {settings: vi.fn(() => new Promise(() => {}))} as unknown as Pick<VonvonClient, 'settings'>;
  const pending = readCodexPathView(reader, controller.signal);
  const failure = expect(pending).rejects.toThrow('读取已取消。');
  controller.abort();
  await failure;
});
const view: HostSettingsView = {
  scope: {kind: "host"},
  sections: {execution: {stored: {codexBin: "/opt/codex"}, effective: {codexBin: "/opt/codex"}, revision: "revision-1", access: {kind: "writable"}, apply: []}},
  runtime: {codexBin: "/opt/codex", fallbackCwd: "/tmp", platform: "darwin"},
};

it("keeps the executable row visible with a browser path dialog or a native chooser", () => {
  const web = renderToStaticMarkup(<ClientProvider client={client}><CodexPathPanel view={view} refresh={async () => {}} /></ClientProvider>);
  const desktop = renderToStaticMarkup(<ClientProvider client={client} shell={{chooseExecutablePath: async () => null}}><CodexPathPanel view={view} refresh={async () => {}} /></ClientProvider>);
  expect(web).toContain("输入 Codex 可执行文件路径");
  expect(web).toContain("/opt/codex");
  expect(web).toContain("恢复自动检测");
  expect(desktop).toContain("选择 Codex 可执行文件");
  expect(desktop).toContain("/opt/codex");
  const application = renderToStaticMarkup(<ClientProvider client={client}><HostPanel view={view}/></ClientProvider>);
  expect(application).toContain("未绑定工作目录时的运行后备");
  expect(application).not.toContain("Codex 可执行文件");
});

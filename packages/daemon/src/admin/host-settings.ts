import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { paths } from '../config/paths';
import { loadBots } from '../config/bots';
import { loadConfig } from '../config/store';
import { getCliBridgePreferences, isComplete, resolveOwner } from '../config/schema';
import { cliBridgeRouteRevision, readCliBridgeRoute, saveCliBridgeRoute, selectCliBridgeHookBot } from '../cli-bridge/route';
import { inspectCliBridgeHooks, inspectCliBridgeHookTargets, installCliBridgeHooks, resolveBridgeHookCommand } from '../cli-bridge/hooks';
import { readServiceCodexBin, saveServiceCodexBin } from '../service/codex-bin';
import { customAcpCommand, parseCustomAcpCommand, resolveCustomAcpCommand, saveCustomAcpCommand, type CustomAcpCommandState } from '../agent/custom-acp-command';
import type { ApplyEffect, HostSettings, HostSettingsView, SettingsActionResult, SettingsSave, SettingsSectionView } from './settings-types';

export function createHostSettings(options: {
  appDir?: string;
  readonly?: boolean;
  runningCodexBin?: string | null;
  runningCustomAcpState?: CustomAcpCommandState;
} = {}): Pick<HostSettings, 'read' | 'save' | 'act'> {
  const appDir = options.appDir ?? paths.appDir;
  const runningCodexBin = options.runningCodexBin === undefined
    ? process.env.CODEX_BIN || null
    : options.runningCodexBin;
  const runningCustomAcpState = options.runningCustomAcpState ?? customAcpCommand();
  let writes: Promise<unknown> = Promise.resolve();
  const effect: ApplyEffect = { fields: ['codexBin', 'customAcpCommand'], when: 'restart', detail: '已保存，重启后使用新的执行设置。' };
  function storedCustomAcp() {
    const state = resolveCustomAcpCommand(appDir);
    if (state.kind !== 'invalid') return { state, fingerprint: state };
    let sha256: string;
    try { sha256 = createHash('sha256').update(readFileSync(state.file)).digest('hex'); }
    catch { sha256 = 'unreadable'; }
    return { state, fingerprint: { configured: 'invalid', sha256 } };
  }
  function view(): HostSettingsView {
    const stored = readServiceCodexBin(appDir);
    const customAcp = storedCustomAcp();
    return {
      scope: { kind: 'host' },
      sections: {
        execution: {
          stored: { codexBin: stored ?? null, customAcpCommand: customAcp.state.kind === 'set' ? customAcp.state.command : null },
          effective: { codexBin: runningCodexBin, customAcpCommand: runningCustomAcpState.kind === 'set' ? runningCustomAcpState.command : null },
          revision: createHash('sha256').update(JSON.stringify({ configured: stored !== undefined, codexBin: stored ?? null, customAcpCommand: customAcp.fingerprint })).digest('hex'),
          access: options.readonly
            ? { kind: 'readonly', reason: 'preview', message: '只读预览不能更改执行程序，请先启动 Bridge。' }
            : { kind: 'writable' },
          apply: [effect],
        },
      },
      runtime: { codexBin: runningCodexBin, fallbackCwd: process.env.FEISHU_CODEX_CWD || process.cwd(), platform: process.platform },
    };
  }
  const section = (current: HostSettingsView): SettingsSectionView => ({ scope: { kind: 'host' }, section: 'execution', value: current.sections.execution });
  async function fullView(): Promise<HostSettingsView> {
    const route = readCliBridgeRoute(appDir);
    const registry = await loadBots();
    const agents = await Promise.all(registry.bots.map(async bot => {
      const cfg = await loadConfig(join(appDir, 'bots', bot.appId, 'config.json')).catch(() => undefined);
      return {
        botId: bot.appId,
        name: bot.name,
        enabled: bot.active !== false && !!cfg && isComplete(cfg) && getCliBridgePreferences(cfg).enabled,
        hasOwner: !!cfg && isComplete(cfg) && Boolean(resolveOwner(cfg)),
      };
    }));
    const pins = await inspectCliBridgeHookTargets().catch(() => null);
    const targets = {codex: [] as string[], claude: [] as string[]};
    for (const tool of ['codex', 'claude'] as const) {
      const requests = route.kind === 'agent' ? [route.botId] : route.kind === 'none' || pins === null ? [] : pins[tool].length ? pins[tool] : [null];
      for (const requested of requests) {
        const target = await selectCliBridgeHookBot(registry, {
          requested: requested ?? undefined,
          route: {kind: 'legacy'},
          loadConfigForBot: appId => loadConfig(join(appDir, 'bots', appId, 'config.json')),
        });
        if (target && !targets[tool].includes(target.appId)) targets[tool].push(target.appId);
      }
    }
    const dormant = route.kind === 'none' ? await selectCliBridgeHookBot(registry, {route: {kind: 'legacy'}, loadConfigForBot: appId => loadConfig(join(appDir, 'bots', appId, 'config.json'))}) : undefined;
    const botId = targets.codex[0] ?? targets.claude[0] ?? null;
    const hooks = await inspectCliBridgeHooks().catch(() => ({
      claude: { agent: 'claude' as const, status: 'needs_repair' as const, details: ['读取 Hook 状态失败'] },
      codex: { agent: 'codex' as const, status: 'needs_repair' as const, details: ['读取 Hook 状态失败'] },
    }));
    return {
      ...view(),
      runtime: {
        ...view().runtime,
        coffee: {
          route: route.kind,
          botId,
          editorBotId: botId ?? dormant?.appId ?? null,
          targets,
          targetsReadable: pins !== null,
          revision: cliBridgeRouteRevision(route),
          agents,
          hooks,
        },
      },
    };
  }
  return {
    async read(scope) {
      if (scope.kind !== 'host') throw new Error('Host settings require the host scope');
      return fullView();
    },
    async act(action): Promise<SettingsActionResult> {
      if (action.kind !== 'setHostCliRoute' && action.kind !== 'repairHostCliHooks') throw new Error('Host action required');
      if (options.readonly) return { kind: 'unavailable', reason: { kind: 'readonly', reason: 'preview', message: '只读预览不能修改本机 Hook。' } };
      if (action.kind === 'setHostCliRoute') {
        if (action.botId !== null) {
          const registry = await loadBots();
          if (!registry.bots.some(bot => bot.appId === action.botId))
            return { kind: 'rejected', fields: [{ field: 'botId', message: '所选通知 Agent 已不存在。' }] };
        }
        if (!saveCliBridgeRoute(action.botId, action.revision, appDir))
          return { kind: 'conflict', view: await fullView() };
        return { kind: 'saved', view: await fullView(), effects: [{ fields: ['notificationBotId'], when: 'next-hook', detail: '通知目标已保存，下一次本机 CLI 活动使用新目标。请确保所选 Agent 已启用本机 CLI 转发。' }], warnings: [] };
      }
      const route = readCliBridgeRoute(appDir);
      const pins = route.kind === 'legacy' ? await inspectCliBridgeHookTargets().catch(() => null) : {codex: [], claude: []};
      const warnings: string[] = [];
      for (const agent of action.agents) {
        try {
          if (!pins || pins[agent].length > 1) {
            warnings.push(`${agent} Hook 的通知目标不一致或无法读取，请选择通知 Agent 后再修复。`);
            continue;
          }
          await installCliBridgeHooks({ command: resolveBridgeHookCommand(pins[agent][0] ?? undefined), agents: { claude: agent === 'claude', codex: agent === 'codex' } });
        } catch {
          warnings.push(`${agent} Hook 修复失败，请检查配置权限后重试。`);
        }
      }
      return { kind: 'saved', view: await fullView(), effects: [], warnings };
    },
    save(edit) {
      const run = writes.then(async (): Promise<SettingsSave> => {
        if (edit.scope.kind !== 'host' || edit.section !== 'execution') throw new Error('Host settings require the execution section');
        let current = view();
        if (current.sections.execution.access.kind === 'readonly') return { kind: 'unavailable', reason: current.sections.execution.access };
        const value = edit.patch.codexBin;
        const command = edit.patch.customAcpCommand;
        if (value === undefined && command === undefined) return { kind: 'rejected', fields: [{ field: 'execution', message: '请选择要修改的执行设置。' }] };
        const sameCodex = value === undefined || readServiceCodexBin(appDir) === value;
        const savedCommand = storedCustomAcp().state;
        const sameCommand = command === undefined || savedCommand.kind !== 'invalid' && JSON.stringify(savedCommand.kind === 'set' ? savedCommand.command : null) === JSON.stringify(command);
        if (sameCodex && sameCommand) return { kind: 'saved', section: section(current), effects: [] };
        if (current.sections.execution.revision !== edit.revision) return { kind: 'conflict', current: section(current) };
        if (command !== undefined) {
          try { parseCustomAcpCommand(command); }
          catch { return { kind: 'rejected', fields: [{ field: 'customAcpCommand', message: '命令必须包含 1 到 64 个有效参数，程序需为绝对路径或命令名。' }] }; }
        }
        if (value !== undefined && value !== null) {
          if (!isAbsolute(value) || /[\r\n\0]/.test(value)) return { kind: 'rejected', fields: [{ field: 'codexBin', message: '执行程序必须是有效的绝对文件路径。' }] };
          try {
            if (!(await stat(value)).isFile()) throw new Error('not a file');
            await access(value, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          } catch {
            return { kind: 'rejected', fields: [{ field: 'codexBin', message: '所选执行程序不存在或不可执行，请重新选择。' }] };
          }
        }
        current = view();
        if (current.sections.execution.revision !== edit.revision) return { kind: 'conflict', current: section(current) };
        if (!sameCodex) saveServiceCodexBin(value, appDir);
        if (!sameCommand) saveCustomAcpCommand(command, appDir);
        return { kind: 'saved', section: section(view()), effects: [effect] };
      });
      writes = run.catch(() => undefined);
      return run;
    },
  };
}

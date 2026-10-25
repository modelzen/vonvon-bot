import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { parseModelId } from '../agent/model-id';
import { getSessionTitleEfforts } from '../config/schema';
import { discoverProviderModels } from './model-catalog';
import { decisionProvider } from '../judge/decision';
import { JUDGE_PROVIDERS, effectiveJudgeModels, readJudgeModels, writeJudgeModels, type JudgeModels } from '../judge/global-models';
import { readServiceCodexBin, saveServiceCodexBin } from '../service/codex-bin';
import type { ApplyEffect, HostSettings, HostSettingsView, SettingsSave, SettingsSectionView } from './settings-types';

export function createHostSettings(options: {
  appDir?: string;
  readonly?: boolean;
  runningCodexBin?: string | null;
} = {}): Pick<HostSettings, 'read' | 'save'> {
  const appDir = options.appDir ?? paths.appDir;
  const runningCodexBin = options.runningCodexBin === undefined
    ? process.env.CODEX_BIN || null
    : options.runningCodexBin;
  let writes: Promise<unknown> = Promise.resolve();
  const effect: ApplyEffect = { fields: ['codexBin'], when: 'restart', detail: '已保存，下次启动 daemon 时使用；当前会话保持原来的执行程序。' };
  const judgeEffect: ApplyEffect = { fields: ['byProvider', 'defaultProvider'], when: 'next-message', detail: '跟随统一配置的智能群在下一次判断使用最新模型设置。' };
  async function view(): Promise<HostSettingsView> {
    const stored = readServiceCodexBin(appDir);
    const judge = await readJudgeModels(appDir);
    return {
      scope: { kind: 'host' },
      sections: {
        execution: {
          stored: { codexBin: stored ?? null },
          effective: { codexBin: runningCodexBin },
          revision: createHash('sha256').update(JSON.stringify({ configured: stored !== undefined, codexBin: stored ?? null })).digest('hex'),
          access: options.readonly
            ? { kind: 'readonly', reason: 'preview', message: '只读预览不能更改执行程序，请先启动 daemon。' }
            : { kind: 'writable' },
          apply: [effect],
        },
        judge: {
          stored: judge,
          effective: effectiveJudgeModels(judge),
          revision: createHash('sha256').update(JSON.stringify(judge)).digest('hex'),
          access: options.readonly
            ? { kind: 'readonly', reason: 'preview', message: '只读预览不能更改决策模型。' }
            : { kind: 'writable' },
          apply: [judgeEffect],
        },
      },
      runtime: { codexBin: runningCodexBin, fallbackCwd: process.env.FEISHU_CODEX_CWD || process.cwd(), platform: process.platform },
    };
  }
  const section = (current: HostSettingsView, name: 'execution' | 'judge'): SettingsSectionView =>
    name === 'execution' ? { scope: { kind: 'host' }, section: name, value: current.sections.execution }
      : { scope: { kind: 'host' }, section: name, value: current.sections.judge };
  async function validateJudge(value: JudgeModels, prior: JudgeModels): Promise<string | undefined> {
    for (const [provider, choice] of Object.entries(value.byProvider)) {
      if (!JUDGE_PROVIDERS.includes(provider as typeof JUDGE_PROVIDERS[number])) {
        if (JSON.stringify(choice) === JSON.stringify(prior.byProvider[provider])) continue;
        return `不认识决策 Provider ${provider}`;
      }
      const parsed = parseModelId(choice.model);
      if (!parsed.ok) return parsed.message;
      if (provider === 'typesafe') {
        if (choice.effort) return 'TypeSafe 不支持 Effort';
        if (!choice.custom && !decisionProvider('typesafe')!.models.some(model => model.id === choice.model)) return 'TypeSafe 没有这个模型；手填模型请启用 custom';
        continue;
      }
      if (choice.effort && !getSessionTitleEfforts(provider).includes(choice.effort)) return `${provider} 不支持这个 Effort`;
      if (choice.custom) continue;
      const catalog = await discoverProviderModels(provider as 'codex-appserver' | 'claude-agent');
      if (!catalog.models.length) return `${provider} 的实时模型列表不可用；手填模型请启用 custom`;
      const info = catalog.models.find(item => item.id === choice.model && !item.hidden);
      if (!info) return `${provider} 的可用列表没有这个模型`;
      if (choice.effort && !info.supportedEfforts.includes(choice.effort)) return '这个模型不支持所选 Effort';
    }
  }
  return {
    async read(scope) {
      if (scope.kind !== 'host') throw new Error('Host settings require the host scope');
      return view();
    },
    save(edit) {
      const run = writes.then(async (): Promise<SettingsSave> => {
        if (edit.scope.kind !== 'host' || (edit.section !== 'execution' && edit.section !== 'judge')) throw new Error('Unsupported host section');
        let current = await view();
        if (edit.section === 'judge') {
          const patch = edit.patch as Partial<JudgeModels>;
          if (current.sections.judge.access.kind === 'readonly') return { kind: 'unavailable', reason: current.sections.judge.access };
          if ((patch.byProvider !== undefined && (!patch.byProvider || typeof patch.byProvider !== 'object' || Array.isArray(patch.byProvider))) || (patch.byProvider === undefined && patch.defaultProvider === undefined))
            return { kind: 'rejected', fields: [{ field: 'byProvider', message: '请提供各 Provider 的模型设置。' }] };
          if (patch.defaultProvider !== undefined && !JUDGE_PROVIDERS.includes(patch.defaultProvider))
            return { kind: 'rejected', fields: [{ field: 'defaultProvider', message: '请选择有效的默认决策 Provider。' }] };
          // Older clients do not send this field; their model edits must preserve the current default.
          const defaultProvider = patch.defaultProvider ?? current.sections.judge.stored.defaultProvider;
          const proposed: JudgeModels = { ...(defaultProvider ? { defaultProvider } : {}), byProvider: patch.byProvider ?? current.sections.judge.stored.byProvider };
          if (JSON.stringify(current.sections.judge.stored) === JSON.stringify(proposed)) return { kind: 'saved', section: section(current, 'judge'), effects: [] };
          if (current.sections.judge.revision !== edit.revision) return { kind: 'conflict', current: section(current, 'judge') };
          const message = await validateJudge(proposed, current.sections.judge.stored);
          if (message) return { kind: 'rejected', fields: [{ field: 'byProvider', message }] };
          const mutex = await acquireMutex(appDir, 'judge-models', 3000);
          try {
            current = await view();
            if (current.sections.judge.revision !== edit.revision) return { kind: 'conflict', current: section(current, 'judge') };
            // A newer daemon may have added another provider. Preserve it when this client saves known choices.
            const newer = Object.fromEntries(Object.entries(current.sections.judge.stored.byProvider)
              .filter(([provider]) => !JUDGE_PROVIDERS.includes(provider as typeof JUDGE_PROVIDERS[number])));
            await writeJudgeModels({ ...proposed, byProvider: { ...newer, ...proposed.byProvider } }, appDir);
          } finally { await closeMutex(mutex); }
          return { kind: 'saved', section: section(await view(), 'judge'), effects: [judgeEffect] };
        }
        if (current.sections.execution.access.kind === 'readonly') return { kind: 'unavailable', reason: current.sections.execution.access };
        const value = edit.patch.codexBin;
        if (value === undefined) return { kind: 'rejected', fields: [{ field: 'codexBin', message: '请选择执行程序或恢复自动查找。' }] };
        if (readServiceCodexBin(appDir) === value) return { kind: 'saved', section: section(current, 'execution'), effects: [] };
        if (current.sections.execution.revision !== edit.revision) return { kind: 'conflict', current: section(current, 'execution') };
        if (value !== null) {
          if (!isAbsolute(value) || /[\r\n\0]/.test(value)) return { kind: 'rejected', fields: [{ field: 'codexBin', message: '执行程序必须是有效的绝对文件路径。' }] };
          try {
            if (!(await stat(value)).isFile()) throw new Error('not a file');
            await access(value, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          } catch {
            return { kind: 'rejected', fields: [{ field: 'codexBin', message: '所选执行程序不存在或不可执行，请重新选择。' }] };
          }
        }
        current = await view();
        if (current.sections.execution.revision !== edit.revision) return { kind: 'conflict', current: section(current, 'execution') };
        saveServiceCodexBin(value, appDir);
        return { kind: 'saved', section: section(await view(), 'execution'), effects: [effect] };
      });
      writes = run.catch(() => undefined);
      return run;
    },
  };
}

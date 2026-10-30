import { realpathSync } from 'node:fs';
import type { EnvironmentToolState } from '@vonvon/protocol';

/** Describe the executable actually selected for future sessions, never a separate install. */
export function codexSource(executable: string, managed: boolean): Pick<EnvironmentToolState, 'source' | 'updateInstructions'> {
  if (process.env.CODEX_BIN) return { source: 'explicit', updateInstructions: '当前使用指定的 Codex 路径。请通过原安装方式更新这份 Codex，然后点击「刷新模型」。' };
  if (managed) return { source: 'managed' };
  let physical = executable;
  try { physical = realpathSync(executable); } catch { /* preserve the observed spelling */ }
  const path = `${executable}\n${physical}`.replace(/\\/g, '/');
  if (/(?:Codex|ChatGPT)\.app\/Contents\//i.test(path)) return { source: 'app', updateInstructions: '请在 Codex App 或 ChatGPT App 中检查更新，更新完成后点击「刷新模型」。无需另外安装 CLI。' };
  if (/\/(?:Cellar|Caskroom)\/codex\//i.test(path)) return { source: 'homebrew', updateInstructions: `请在终端运行 ${/\/Caskroom\//i.test(path) ? 'brew upgrade --cask codex' : 'brew upgrade codex'}，完成后点击「刷新模型」。` };
  if (/\/node_modules\/@openai\/codex(?:\/|$)/i.test(path) || /\/(?:npm|node\/(?:v[\d.]+)\/bin)\/codex(?:\.cmd|\.ps1)?(?:\n|$)/i.test(path)) return { source: 'npm', updateInstructions: '请在安装 Codex 的终端环境运行 npm install -g @openai/codex@latest，完成后点击「刷新模型」。' };
  return { source: 'unknown', updateInstructions: '请通过原安装方式更新这份 Codex，完成后点击「刷新模型」。' };
}

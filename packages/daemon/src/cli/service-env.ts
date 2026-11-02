import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `<data dir>/env` (owner 2026-11-02): `NAME=value` lines a daemon run reads when it starts. A service manager does not
 * pass on what a terminal set, so a server behind a proxy writes `HTTPS_PROXY` here. Applied to this process before any
 * bot starts, so every bot child, and the Codex or Claude it runs, gets them. The file wins over what the process has,
 * except the names the service sets itself.
 */
export const SERVICE_ENV_FILE = 'env';
/** The names applied from the file last time: a restart that inherits this process's environment drops them first. */
export const SERVICE_ENV_MARKER = 'VONVON_ENV_FILE_NAMES';
const OWN = /^(?:VONVON_.*|PATH|ELECTRON_RUN_AS_NODE)$/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ServiceEnv = { values: [string, string][]; ignored: number[]; own: string[] };

/** One `NAME=value` per line; `#` starts a comment line; `export ` and one pair of outer quotes are allowed. */
export function parseServiceEnv(text: string): ServiceEnv {
  const result: ServiceEnv = { values: [], ignored: [], own: [] };
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = line.indexOf('=');
    const name = at < 0 ? '' : line.slice(0, at).trim().replace(/^export\s+/, '');
    if (!NAME.test(name)) { result.ignored.push(index + 1); return; }
    if (OWN.test(name)) { result.own.push(name); return; }
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    result.values.push([name, value]);
  });
  return result;
}

/**
 * Applies `<root>/env` to `env` and says what it did in one line, or nothing when there is no file. Never prints a
 * value: a line may hold an API key.
 */
export function applyServiceEnv(root: string, env: NodeJS.ProcessEnv = process.env, read = (path: string) => readFileSync(path, 'utf8')): string | undefined {
  const file = join(root, SERVICE_ENV_FILE);
  for (const name of env[SERVICE_ENV_MARKER]?.split(',') ?? []) if (NAME.test(name) && !OWN.test(name)) delete env[name];
  delete env[SERVICE_ENV_MARKER];
  let text: string;
  try { text = read(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? undefined : `读不了 ${file}（${code ?? String(error)}），里面的环境变量没用上。`;
  }
  const { values, ignored, own } = parseServiceEnv(text);
  for (const [name, value] of values) env[name] = value;
  const names = [...new Set(values.map(([name]) => name))];
  if (names.length) env[SERVICE_ENV_MARKER] = names.join(',');
  return [
    names.length ? `已从 ${file} 读入环境变量：${names.join('、')}。` : `${file} 里没有环境变量。`,
    ...ignored.length ? [`第 ${ignored.join('、')} 行不是"名字=值"，没用。`] : [],
    ...own.length ? [`${[...new Set(own)].join('、')} 由服务自己设，文件里的不用。`] : [],
  ].join('');
}

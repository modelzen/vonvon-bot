import { print, want, withDaemon, type Daemon, type Io } from '../daemon-client';
import { folderPath, thisHost, type Host } from './group';

/**
 * `vonvon dir list` (cli-3-groups 4.2): the folders under a path on the daemon's computer, as the web page's folder
 * picker browses them, any folder that user can read (devices-ui-2 4.3). No path is the home folder. Hidden folders only with --all; --json
 * always has them all.
 */
export async function runDirList(raw: string | undefined, options: { all?: boolean }, io: Io, daemon: Daemon = withDaemon, host: Host = thisHost()): Promise<void> {
  const path = raw === undefined ? undefined : folderPath(raw, host);
  const listed = await daemon(async call => want('读取目录', await call('读取目录', c => c.directory(path === undefined ? { type: 'list' } : { type: 'list', path })), 'entries'));
  const shown = options.all ? listed.entries : listed.entries.filter(entry => !entry.hidden);
  const human = shown.map(entry => entry.path);
  const hidden = listed.entries.length - shown.length;
  if (!shown.length) human.push(`${listed.path} 下没有子文件夹${hidden ? `（另有 ${hidden} 个隐藏的，加 --all 列出）` : ''}。`);
  if (listed.truncated) human.push(`只列了前 ${listed.entries.length} 个`);
  const { kind: _kind, ...json } = listed;
  print(io, human, json);
}

/** `vonvon dir suggest`: the web page's folder box completing what was typed, `~/` and names deeper down alike. */
export async function runDirSuggest(query: string, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const found = await daemon(async call => want('查找文件夹', await call('查找文件夹', c => c.directory({ type: 'suggest', query })), 'suggestions'));
  const human = found.entries.map(entry => entry.path);
  if (!human.length) human.push('没有找到匹配的文件夹。');
  if (found.truncated) human.push(`只列了前 ${found.entries.length} 个`);
  const { kind: _kind, ...json } = found;
  print(io, human, json);
}

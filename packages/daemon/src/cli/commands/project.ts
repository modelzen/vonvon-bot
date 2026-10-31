import type { LibraryOverview } from '../../admin/library';
import { print, type Io } from '../daemon-client';

const readOverview = async (): Promise<LibraryOverview> => (await import('../../admin/library')).libraryOverview();

/** Reads the files directly, so it works with the daemon stopped; a group bound since the last start has no project yet. */
export async function runProjectList(io: Io, read: () => Promise<LibraryOverview> = readOverview): Promise<void> {
  const overview = await read();
  const human: string[] = [];
  for (const project of overview.projects) {
    human.push(`${project.name}  ${project.id}  ${project.workspace.primary}`);
    // A project outlives its last group (owner D4); the owner deletes it by hand.
    if (!project.bindings.length) human.push('  没有群');
    for (const binding of project.bindings) human.push(`  ${binding.botName} 在 ${binding.name}  ${binding.chatId}${binding.enabled ? '' : '（群已停用）'}`);
  }
  if (!overview.projects.length && !overview.unlinked.length) human.push('还没有项目。绑定群以后，daemon 启动时给每个群建好项目。');
  if (overview.unlinked.length) {
    human.push(`还有 ${overview.unlinked.length} 个群没有项目，daemon 下次启动时会建好：${overview.unlinked.map(binding => `${binding.botName} 在 ${binding.name}`).join('、')}`);
  }
  for (const bot of overview.unreadable) human.push(`读不了 ${bot.botName}（${bot.botId}）的群：${bot.error}`);
  // devices 8.3: read from the files, not the daemon
  print(io, human, { source: 'files', ...overview });
}

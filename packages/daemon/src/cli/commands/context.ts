import type { ContextPreviewReply, ContextPreviewRequest, ContextSectionKey } from '@vonvon/protocol';
import { badArgs, CommandError } from '../command-error';
import { localTime, pickBot, pickGroup, print, withDaemon, type Daemon, type Io } from '../daemon-client';

export type ContextOptions = { bot?: string | undefined; group?: string | undefined; comment?: boolean | undefined; session?: string | undefined };
/** The web page's row names (context-model.ts). */
const LABEL: Record<ContextSectionKey, string> = {
  identity: '身份行', role: '角色设定', supplement: '本项目的补充职责', botMemory: 'Bot 记忆', projectMemory: '项目记忆',
};
const chars = (count: number): string => count ? `${count.toLocaleString('en-US')} 字` : '没有';

function nextLines({ next }: ContextPreviewReply): string[] {
  const cell = (section: ContextPreviewReply['next']['sections'][number]): string =>
    section.key === 'botMemory' ? `${next.items.bot} 条（${section.branches ?? 0} 个分支）`
      : section.key === 'projectMemory' ? `可信 ${next.items.trusted} 条 / 待确认 ${next.items.untrusted} 条（${section.branches ?? 0} 个分支）`
        : chars(section.chars);
  return ['下一次新会话会拿到：', ...next.sections.map(section => `  ${LABEL[section.key]}  ${cell(section)}`), `  工具  ${next.tools.join('、') || '没有'}`];
}

function sessionLines({ session, running }: ContextPreviewReply): string[] {
  if (!session) return [running ? '这里还没有会话。' : 'Bot 没在运行，没有在用的会话。'];
  const lines = [`这条会话上次拿到（${session.threadId}，${localTime(session.updatedAt)}）：`];
  if (session.legacy) lines.push('  旧版（升级前开场），下一轮全部重给');
  else {
    for (const section of session.sections) {
      const what = section.key === 'botMemory' || section.key === 'projectMemory' ? `${section.items ?? 0} 条` : `版本 ${section.version.slice(0, 6)}`;
      lines.push(`  ${LABEL[section.key]}  ${what}${section.stale ? '，下一轮会换新的' : ''}`);
    }
    if (session.redeliverDue) lines.push('  压缩过，下一轮全部重给');
  }
  const turn = session.lastTurn;
  if (turn) {
    lines.push(`上一轮（${localTime(turn.at)}）注入 ${turn.injected} 条，模型说用了 ${turn.used.length} 条`);
    if (turn.missed?.length) lines.push(`  有 ${turn.missed.length} 条没记上：${[...new Set(turn.missed)].join('、')}`);
  }
  return lines;
}

/** Who gets the smart mode's question and what goes in it (the web page's judgeLines). */
function judgeLine({ judge }: ContextPreviewReply): string {
  const who = judge.via === 'third-party' ? `发给决策模型（${judge.label ?? '第三方'}，第三方）` : `交给${judge.label ? `本机决策模型（${judge.label}）` : '本机决策模型'}`;
  return `智能判断${who}：补充职责和身份 ${judge.roleChars} 字，本群可信记忆 ${judge.memoryItems} 条`;
}

/**
 * `vonvon context show` (cli-8-machine): the web page's 模型看到什么, vonvon's own parts only. Exactly one of --group
 * and --comment; --session defaults to the group's latest session (the daemon picks it).
 */
export async function runContextShow(options: ContextOptions, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  if ((options.group === undefined) === !options.comment) throw badArgs('写 --group <群> 或 --comment 其中一个。');
  const preview = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const bot = pickBot(snapshot.agents, options.bot);
    const place: ContextPreviewRequest['place'] = options.group === undefined ? { kind: 'comment' } : { kind: 'group', groupId: pickGroup(snapshot.memberships, bot, options.group).groupId };
    const reply = await call('读模型看到什么', c => c.contextPreview({ type: 'get', agentId: bot.id, place, ...(options.session === undefined ? {} : { threadId: options.session }) }));
    if (reply.kind !== 'preview') throw new CommandError('failed', `读模型看到什么没有完成：daemon 回了意外的结果（${String(reply.kind)}）。`);
    return reply;
  });
  print(io, [...nextLines(preview), ...sessionLines(preview), judgeLine(preview), '模型还会读项目自己的 AGENTS.md / CLAUDE.md，vonvon 不显示也不改。'], { preview });
}

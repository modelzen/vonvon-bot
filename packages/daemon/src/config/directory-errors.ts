/** A refused workspace or a stable directory that cannot be used, told as the person sees it (s36c2d). */
export class DirectoryError extends Error {}

const REFUSED = '不能是 Vonvon 的数据目录或它里面的文件夹（projects/ 下面的除外），也不能是数据目录的上级';
const repairStep = (bot?: string): string => `在终端运行 vonvon bot repair-dir ${bot ?? '<bot>'}，按现在的位置重新记录`;

function message(error: Error, bot?: string): string | undefined {
  const settings = /^Invalid directory settings: directories\.([\w.]+)(?: \((.+)\))?/.exec(error.message);
  if (settings) {
    const [, field, detail] = settings;
    if (detail === 'duplicate') return '工作目录选重复了';
    if (detail === 'cwd unavailable' || detail === 'must match cwd') return '工作目录不存在或刚被换掉了，请重新选择';
    if (field === 'repositories') return `代码仓库要是本机 Git 仓库的根目录，${REFUSED}`;
    return `所选文件夹不能当工作目录：${REFUSED}`;
  }
  if (error.message === 'Invalid namespace location') return `项目根目录不能用：${REFUSED}`;
  if (/^(Namespace (directory|parent|path) changed|Directory changed during allocation)$/.test(error.message)) {
    return `${bot ? `「${bot}」` : '这个 bot '}的目录和记录的不一致，可能整机迁移过或从备份恢复过。确认目录没问题后，${repairStep(bot)}`;
  }
  if (error.message.startsWith('Reserved namespace already exists')) return `上次分配目录时中断了，目录建好了但没登记完。确认里面没有别人的文件后，${repairStep(bot)}`;
  if (error.message === 'Invalid namespace directory') return '目录被换成了文件或链接，请把它恢复成普通文件夹';
  if (error.message === 'Namespace collision limit reached') return '同名的目录太多，分配不出新目录，请换个名字';
  if (/allocation limit reached$/.test(error.message)) return '目录记录已满（最多 4096 条），没有分配新目录';
  if (error.message === 'Bot allocation account conflict') return '目录记录和这个机器人的账号对不上，没有改动它';
  if (/^Invalid (bot allocation ledger|group (container|directory) claim)$/.test(error.message)) return 'bots.json 里的目录记录损坏了，没有改动它';
  if (!('code' in error) || typeof error.code !== 'string') return undefined;
  if (error.code === 'ENOENT') return '目录所在的位置不在了（外接盘没接上的话，接上后重试）';
  return error.code === 'EACCES' || error.code === 'EPERM' ? '没有权限访问目录' : `访问目录失败（${error.code}）`;
}

/**
 * What the card, the page or the terminal says for a directory error: Chinese and without an absolute path, since a
 * group card can show it to everyone in the group. `bot` names the bot whose stable directories failed, for the repair
 * command. The internal error stays as `cause` for the log; one not recognized is returned as it is.
 */
export function directoryFailure(error: unknown, bot?: string): unknown {
  if (!(error instanceof Error) || error instanceof DirectoryError) return error;
  const text = message(error, bot);
  return text === undefined ? error : new DirectoryError(text, { cause: error });
}

/** Runs directory work and throws its failure as {@link directoryFailure} tells it. */
export async function directoryError<T>(bot: string | undefined, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw directoryFailure(error, bot); }
}

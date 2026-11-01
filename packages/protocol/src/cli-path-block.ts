/**
 * The PATH block the desktop app and the script-installed server both write into the shell startup files (devices 7.2,
 * COEX-2): one text and one way to splice it, so the two never leave two blocks. Pure strings: the callers read and
 * write the files.
 */
export const CLI_PATH_BLOCK_BEGIN = '# >>> Vonvon Bot CLI >>>';
export const CLI_PATH_BLOCK_END = '# <<< Vonvon Bot CLI <<<';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const under = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`;

/** Puts `bin` first in PATH, once, whatever PATH held before; plain sh, so zsh, bash and dash all read it. */
export function startupBlock(bin: string): string {
  return `${CLI_PATH_BLOCK_BEGIN}\n_vv_rest=$PATH\n_vv_path=\n_vv_first=1\nwhile :; do\n  case $_vv_rest in *:*) _vv_part=\${_vv_rest%%:*}; _vv_rest=\${_vv_rest#*:}; _vv_more=1 ;; *) _vv_part=$_vv_rest; _vv_more=0 ;; esac\n  if [ "$_vv_part" != ${quote(bin)} ]; then\n    if [ "$_vv_first" = 1 ]; then _vv_path=$_vv_part; _vv_first=0; else _vv_path=$_vv_path:$_vv_part; fi\n  fi\n  [ "$_vv_more" = 0 ] && break\ndone\nPATH=${quote(bin)}\${_vv_path:+:$_vv_path}; export PATH\nunset _vv_rest _vv_path _vv_first _vv_part _vv_more\n${CLI_PATH_BLOCK_END}\n`;
}

/**
 * zsh's two files (under an absolute ZDOTDIR when one is given), bash's login file (the first of `.bash_profile`,
 * `.bash_login`, `.profile` that exists, else `.profile`) and `.bashrc`.
 */
export async function shellStartupFiles(home: string, options: { zdotdir?: string; exists: (path: string) => Promise<boolean> }): Promise<string[]> {
  const zsh = options.zdotdir ?? home;
  let bash = '.profile';
  for (const candidate of ['.bash_profile', '.bash_login', '.profile']) {
    if (await options.exists(under(home, candidate))) { bash = candidate; break; }
  }
  return [under(zsh, '.zshrc'), under(zsh, '.zprofile'), under(home, bash), under(home, '.bashrc')];
}

/**
 * Where the block is: the first end marker with a begin marker before it, from the nearest such begin. A lone begin
 * or end marker someone left is text, not a block, and stays as it is.
 */
export function findCliPathBlock(content: string): { start: number; end: number; text: string } | undefined {
  for (let finish = content.indexOf(CLI_PATH_BLOCK_END); finish >= 0; finish = content.indexOf(CLI_PATH_BLOCK_END, finish + 1)) {
    const start = content.lastIndexOf(CLI_PATH_BLOCK_BEGIN, finish);
    if (start < 0) continue;
    const end = finish + CLI_PATH_BLOCK_END.length + (content[finish + CLI_PATH_BLOCK_END.length] === '\n' ? 1 : 0);
    return { start, end, text: content.slice(start, end) };
  }
  return undefined;
}

/**
 * Takes the block out and, unless `block` is null, adds `block` at the end on a line of its own: PATH set last wins
 * over earlier lines. The rest of the file, its trailing newline included, is kept.
 */
export function spliceBlock(content: string, block: string | null): string {
  const found = findCliPathBlock(content);
  const without = found ? content.slice(0, found.start) + content.slice(found.end) : content;
  if (block === null) return without;
  return `${without}${without && !without.endsWith('\n') ? '\n' : ''}${block}`;
}

import { describe, expect, it } from "vitest";
import { CLI_PATH_BLOCK_BEGIN, CLI_PATH_BLOCK_END, findCliPathBlock, shellStartupFiles, spliceBlock, startupBlock } from "../src/index.js";

// main 必败: the block lived in the desktop package only, out of the daemon's reach (server-2 4.3)
describe("the shared PATH block", () => {
  // The text desktop/src/cli-registration.ts wrote before it moved here, byte for byte: both sides must keep writing one block.
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const before = (bin: string): string => `# >>> Vonvon Bot CLI >>>\n_vv_rest=$PATH\n_vv_path=\n_vv_first=1\nwhile :; do\n  case $_vv_rest in *:*) _vv_part=\${_vv_rest%%:*}; _vv_rest=\${_vv_rest#*:}; _vv_more=1 ;; *) _vv_part=$_vv_rest; _vv_more=0 ;; esac\n  if [ "$_vv_part" != ${quote(bin)} ]; then\n    if [ "$_vv_first" = 1 ]; then _vv_path=$_vv_part; _vv_first=0; else _vv_path=$_vv_path:$_vv_part; fi\n  fi\n  [ "$_vv_more" = 0 ] && break\ndone\nPATH=${quote(bin)}\${_vv_path:+:$_vv_path}; export PATH\nunset _vv_rest _vv_path _vv_first _vv_part _vv_more\n# <<< Vonvon Bot CLI <<<\n`;

  it("is the text the desktop app wrote", () => {
    for (const bin of ["/home/u/.local/share/vonvon-bot/bin", "/home/o'neil/.local/share/vonvon-bot/server/bin"]) expect(startupBlock(bin)).toBe(before(bin));
    expect(startupBlock("/b").startsWith(`${CLI_PATH_BLOCK_BEGIN}\n`)).toBe(true);
    expect(startupBlock("/b").endsWith(`${CLI_PATH_BLOCK_END}\n`)).toBe(true);
  });

  it("adds the block on a line of its own, replaces it at the end, and takes it out keeping the rest", () => {
    const block = startupBlock("/srv/bin");
    expect(spliceBlock("", block)).toBe(block);
    expect(spliceBlock("export A=1", block)).toBe(`export A=1\n${block}`);
    const once = spliceBlock("export A=1\n", block);
    expect(once).toBe(`export A=1\n${block}`);
    expect(spliceBlock(once, block)).toBe(once);
    // another bin's block (the desktop app's) is replaced, and a line after it stays before the new one
    const other = `export A=1\n${startupBlock("/desk/bin")}export B=2\n`;
    expect(spliceBlock(other, block)).toBe(`export A=1\nexport B=2\n${block}`);
    expect(spliceBlock(once, null)).toBe("export A=1\n");
    expect(spliceBlock(`export A=1\n${block}export B=2\n`, null)).toBe("export A=1\nexport B=2\n");
    expect(spliceBlock("export A=1\n", null)).toBe("export A=1\n");
  });

  it("leaves a lone marker where it is and adds a whole block, which a second run then finds", () => {
    const block = startupBlock("/srv/bin");
    const lone = `${CLI_PATH_BLOCK_BEGIN}\nexport KEEP=1\n`;
    const first = spliceBlock(lone, block);
    expect(first).toBe(`${lone}${block}`);
    expect(spliceBlock(first, block)).toBe(first);
    expect(spliceBlock(first, null)).toBe(lone);
    const stray = `${CLI_PATH_BLOCK_END}\nexport KEEP=1\n`;
    expect(spliceBlock(spliceBlock(stray, block), block)).toBe(`${stray}${block}`);
    expect(findCliPathBlock(lone)).toBeUndefined();
    expect(findCliPathBlock(first)?.text).toBe(block);
  });

  it("picks zsh's files under an absolute ZDOTDIR and bash's first login file that exists", async () => {
    const present = (...names: string[]) => async (path: string) => names.includes(path);
    expect(await shellStartupFiles("/h", { exists: present() })).toEqual(["/h/.zshrc", "/h/.zprofile", "/h/.profile", "/h/.bashrc"]);
    expect(await shellStartupFiles("/h/", { zdotdir: "/z", exists: present("/h/.bash_login", "/h/.profile") })).toEqual(["/z/.zshrc", "/z/.zprofile", "/h/.bash_login", "/h/.bashrc"]);
    expect(await shellStartupFiles("/h", { exists: present("/h/.bash_profile", "/h/.bash_login") })).toContain("/h/.bash_profile");
  });
});

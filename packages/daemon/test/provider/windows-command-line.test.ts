import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { quoteCmdArg, windowsCommandLine } from '../../src/provider/process/windows-command-line';

const escape = createRequire(import.meta.url)('cross-spawn/lib/util/escape') as {
  command(arg: string): string; argument(arg: string, doubleEscape: boolean): string;
};

describe('windowsCommandLine for an executable (libuv quote_cmd_arg)', () => {
  const cases: Array<[string, string]> = [
    ['plain', 'plain'],
    ['', '""'],
    ['has space', '"has space"'],
    ['tab\there', '"tab\there"'],
    ['C:\\path\\no\\quotes', 'C:\\path\\no\\quotes'],
    ['C:\\with space\\dir', '"C:\\with space\\dir"'],
    ['trailing\\', 'trailing\\'],
    ['trailing space\\', '"trailing space\\\\"'],
    ['two\\\\ at end', '"two\\\\ at end"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\"slash', '"back\\\\\\"slash"'],
    ['many\\\\\\"q', '"many\\\\\\\\\\\\\\"q"'],
    ['"', '"\\""'],
    ['a"b\\', '"a\\"b\\\\"'],
    ['& | < > ^ % !', '"& | < > ^ % !"'],
  ];
  for (const [input, quoted] of cases) {
    it(`quotes ${JSON.stringify(input)} as ${JSON.stringify(quoted)}`, () => {
      expect(quoteCmdArg(input)).toBe(quoted);
    });
  }

  it('joins the quoted argv[0] and arguments with single spaces, so a node provider sees every argument intact', () => {
    const line = windowsCommandLine('C:\\Program Files\\nodejs\\node.exe', ['-e', 'console.log("a b")', '', 'end\\'], { shim: false });
    expect(line).toBe('"C:\\Program Files\\nodejs\\node.exe" -e "console.log(\\"a b\\")" "" end\\');
  });
});

describe('windowsCommandLine for a .cmd or .bat shim (cross-spawn 7.0.6)', () => {
  const tricky = ['plain', '', 'has space', 'say "hi"', 'back\\"slash', 'trailing\\', '& | < > ^ % !', '(paren) [br] ; , * ? `tick`', 'c:\\dir\\'];

  it('escapes the normalized command and every argument the way cross-spawn does, then wraps them for cmd.exe /d /s /c', () => {
    const file = 'C:\\tools/npm.cmd';
    const expected = `cmd.exe /d /s /c "${[escape.command('C:\\tools\\npm.cmd'), ...tricky.map(arg => escape.argument(arg, false))].join(' ')}"`;
    expect(windowsCommandLine(file, tricky, { shim: true })).toBe(expected);
  });

  it('double-escapes metacharacters for a node_modules/.bin cmd-shim, which re-interprets them once more', () => {
    const file = 'D:\\repo\\node_modules\\.bin\\tsc.cmd';
    const expected = `cmd.exe /d /s /c "${[escape.command(file), ...tricky.map(arg => escape.argument(arg, true))].join(' ')}"`;
    expect(windowsCommandLine(file, tricky, { shim: true })).toBe(expected);
    expect(expected).toContain('^^^&');
  });

  it('pins the rules the oracle encodes: metacharacters get a caret, quotes a backslash, trailing backslashes double', () => {
    expect(windowsCommandLine('run.bat', ['a&b', 'q"x', 'end\\', '%PATH%', '!v!'], { shim: true }))
      .toBe('cmd.exe /d /s /c "run.bat ^"a^&b^" ^"q\\^"x^" ^"end\\\\^" ^"^%PATH^%^" ^"^!v^!^""');
  });
});

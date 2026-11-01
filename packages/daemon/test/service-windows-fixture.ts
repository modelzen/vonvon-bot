import type { WindowsCommandResult } from '../src/service/windows-command';

/** A made-up SID; never a real one (I4a §8). */
export const SID = 'S-1-5-21-1000000001-2000000002-3000000003-1001';
export const INSTALL_ROOT = 'C:\\Users\\U\\AppData\\Local\\VonvonBot\\server';
export const LAUNCHER = `${INSTALL_ROOT}\\bin\\vonvon-server.cmd`;
export const CURRENT_TXT = `${INSTALL_ROOT}\\current.txt`;
export const standalone = { kind: 'standalone' as const, executable: LAUNCHER, entry: CURRENT_TXT };

export const ok = (stdout: string | Uint8Array = ''): WindowsCommandResult => ({ ok: true, status: 0, stdout, stderr: '' });
export const fail = (stderr = 'ERROR: injected failure', status: number | null = 1): WindowsCommandResult => ({ ok: false, status, stdout: '', stderr });
/** What `schtasks /Query` says for a task that is not there, in English; the code reads only the exit code. */
export const NO_TASK = fail('ERROR: The system cannot find the file specified.');
export const WHOAMI = ok(`"host\\u","${SID}"\r\n`);

export const utf16 = (text: string, bom = true): Buffer => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);

/** A task someone else made under our name: the shape Task Scheduler exports, running Notepad. */
export function foreignTaskXml(): Buffer {
  return utf16(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>someone</Author><Description>notes</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>${SID}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Actions Context="Author"><Exec><Command>notepad.exe</Command><Arguments>x.txt</Arguments></Exec></Actions>
</Task>
`);
}

/**
 * Re-serializes our XML the way Task Scheduler may give it back: no BOM, other indentation and attribute order, `"`
 * unescaped in text, a Command in other case and quoted, and RunLevel left out (its default).
 */
export function reserialized(text: string): Buffer {
  const command = /<Command>([^<]*)<\/Command>/.exec(text)?.[1] ?? '';
  const out = text
    .replace(/^<\?xml[^>]*\?>\r\n/, '<?xml version="1.0" encoding="UTF-16"?>\n')
    .replace(/\r\n\s*/g, '\n\t')
    .replace('<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">', '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.4">')
    .replace(/&quot;/g, '"')
    .replace(`<Command>${command}</Command>`, `<Command>"${command.toUpperCase()}"</Command>`)
    .replace('<RunLevel>LeastPrivilege</RunLevel>', '')
    .replace('<Principal id="Author">', '<Principal id="Author" >');
  return utf16(out, false);
}

/** Records every call as `command arg arg…`, and answers through `reply`. */
export function recorder(reply: (command: string, args: readonly string[]) => WindowsCommandResult | Promise<WindowsCommandResult>) {
  const calls: string[] = [];
  return {
    calls,
    run: async (command: string, args: readonly string[]) => { calls.push([command, ...args].join(' ')); return reply(command, args); },
  };
}

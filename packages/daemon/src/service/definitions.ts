import { posix, win32 } from 'node:path';
import type { CanonicalRoot, Target } from './identity';
import { decodeConsoleText } from './windows-command';

export type DistributionInput =
  | { kind: 'npm'; executable: string; entry: string }
  | { kind: 'desktop'; executable: string; entry: string }
  /** Rendered like `npm`; told apart by its `current` link paths (devices 7.2). */
  | { kind: 'standalone'; executable: string; entry: string }
  | { kind: 'development' }
  | { kind: 'unknown' };
export type Definition = Readonly<{
  root: CanonicalRoot;
  port: number;
  distribution: Exclude<DistributionInput, { kind: 'development' | 'unknown' }>;
  capturedPath: string;
}>;
type DecodedDefinition = Omit<Definition, 'root'> & { root: string };
export type SerializedDefinition =
  | { platform: 'darwin'; plist: Uint8Array }
  | { platform: 'linux'; unit: Uint8Array }
  /** The task XML: UTF-16LE with a BOM as written; `schtasks /Query /XML` gives back its own serialization (I4a §4.2). */
  | { platform: 'win32'; xml: Uint8Array };

export class InvalidDefinitionInput extends Error {
  constructor(reason: string) { super(reason); this.name = 'InvalidDefinitionInput'; }
}

function literal(value: string): void {
  if (/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(value)) {
    throw new InvalidDefinitionInput('Unsupported control character or malformed Unicode');
  }
}
function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}
function unxml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)|[<>]/u.test(value)) throw new Error('Invalid XML literal');
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '');
}
function unitLiteral(value: string, exec = false): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => exec ? '$$' : '$');
}
function ununit(value: string, exec = false): string {
  const pattern = exec ? /\\[\\"]|%%|\$\$|[^\\%$]/g : /\\[\\"]|%%|[^\\%]/g;
  const tokens = value.match(pattern) ?? [];
  if (tokens.join('') !== value) throw new Error('Invalid systemd escape');
  return tokens.map((token) => token.startsWith('\\') ? token.slice(1) : token === '%%' ? '%' : exec && token === '$$' ? '$' : token).join('');
}
type RenderInput<T extends Target> = { target: T; root: CanonicalRoot; port: number; distribution: DistributionInput; capturedPath: string };
export function renderDefinition(input: RenderInput<Extract<Target, { platform: 'win32' }>>): Extract<SerializedDefinition, { platform: 'win32' }>;
export function renderDefinition(input: RenderInput<Exclude<Target, { platform: 'win32' }>>): Exclude<SerializedDefinition, { platform: 'win32' }>;
export function renderDefinition(input: RenderInput<Target>): SerializedDefinition;
export function renderDefinition(input: RenderInput<Target>): SerializedDefinition {
  if (input.distribution.kind === 'development' || input.distribution.kind === 'unknown') {
    throw new InvalidDefinitionInput('Distribution cannot install a service');
  }
  return render(input.target, { ...input, distribution: input.distribution });
}

function render(target: Target, definition: DecodedDefinition): SerializedDefinition {
  const { root, port, distribution, capturedPath } = definition;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidDefinitionInput('Port must be an integer from 1 to 65535');
  for (const value of [root, distribution.executable, distribution.entry, capturedPath]) {
    literal(value);
  }
  if (target.platform === 'win32') return { platform: 'win32', xml: renderTask(target, definition) };
  for (const value of [root, distribution.executable, distribution.entry]) {
    if (!posix.isAbsolute(value)) {
      throw new InvalidDefinitionInput('Service paths must be fully absolute');
    }
  }
  const out = posix.join(root, 'service.log');
  const err = posix.join(root, 'service.err.log');
  const desktop = distribution.kind === 'desktop';
  switch (target.platform) {
    case 'darwin': {
      const string = (value: string) => `<string>${xml(value)}</string>`;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n<key>Label</key>${string(target.label)}\n<key>ProgramArguments</key><array>${[distribution.executable, distribution.entry, 'daemon', 'run', '--port', String(port)].map(string).join('')}</array>\n<key>EnvironmentVariables</key><dict>\n<key>VONVON_HOME</key>${string(root)}\n<key>VONVON_SERVICE</key>${string('launchd')}\n<key>PATH</key>${string(capturedPath)}\n${desktop ? '<key>ELECTRON_RUN_AS_NODE</key><string>1</string>\n' : ''}</dict>\n<key>StandardOutPath</key>${string(out)}\n<key>StandardErrorPath</key>${string(err)}\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n</dict>\n</plist>\n`;
      return { platform: target.platform, plist: Buffer.from(plist) };
    }
    case 'linux': {
      const unit = `[Unit]\nDescription=Vonvon Bot daemon\n\n[Service]\nType=simple\nExecStart="${unitLiteral(distribution.executable)}" "${unitLiteral(distribution.entry, true)}" daemon run --port ${port}\nEnvironment="VONVON_HOME=${unitLiteral(root)}"\nEnvironment="VONVON_SERVICE=systemd"\nEnvironment="PATH=${unitLiteral(capturedPath)}"\n${desktop ? 'Environment="ELECTRON_RUN_AS_NODE=1"\n' : ''}StandardOutput=append:${out.replace(/%/g, '%%')}\nStandardError=append:${err.replace(/%/g, '%%')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\n\n[Install]\nWantedBy=default.target\n`;
      return { platform: target.platform, unit: Buffer.from(unit) };
    }
  }
}

/** I4a §4.2: what the task's `Description` starts with; a JSON of the four definition fields follows. */
export const WINDOWS_TASK_MARKER = 'vonvon-bot service v1 ';
const LAUNCHER = '\\bin\\vonvon-server.cmd';
const CURRENT = '\\current.txt';

/** The install root a Windows definition's launcher sits in; only the standalone server installs a task. */
function windowsInstallRoot(distribution: DecodedDefinition['distribution']): string {
  if (distribution.kind !== 'standalone') throw new InvalidDefinitionInput('Windows 只支持 standalone 的服务');
  const { executable, entry } = distribution;
  if (!executable.toLowerCase().endsWith(LAUNCHER)) throw new InvalidDefinitionInput(`The Windows service runs the launcher ${LAUNCHER}`);
  const installRoot = executable.slice(0, -LAUNCHER.length);
  if (entry.toLowerCase() !== `${installRoot}${CURRENT}`.toLowerCase()) throw new InvalidDefinitionInput('The Windows service entry is the install root\'s current.txt');
  return installRoot;
}

/** `cmd.exe` reads the task's command line: no `%` (variable expansion) or `"`, and no trailing `\` before a closing quote. */
function windowsPath(value: string): void {
  if (!win32.isAbsolute(value)) throw new InvalidDefinitionInput('Service paths must be fully absolute');
  if (/["%]/.test(value) || value.endsWith('\\')) throw new InvalidDefinitionInput(`Unsupported character in a Windows service path: ${value}`);
}

/**
 * What the task runs: `conhost.exe --headless`, which gives the launcher a console no one sees. A `.cmd` started straight
 * from an InteractiveToken task opens a console window on the desktop, and closing it ends cmd, the supervisor and the
 * daemon together (I4a review F3). `Hidden` only hides the task in the Task Scheduler UI.
 */
export const WINDOWS_TASK_HOST = '%SystemRoot%\\System32\\conhost.exe';
/** The task's arguments: the launcher, then the data root, since a task has no environment of its own. */
const windowsArguments = (launcher: string, port: number, root: string): string => `--headless "${launcher}" __win-supervise --port ${port} --home "${root}"`;

/** JSON with every non-ASCII character escaped, so the field reads the same whatever code page `schtasks` answers in. */
const asciiJson = (value: unknown): string => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

function renderTask(target: Extract<Target, { platform: 'win32' }>, definition: DecodedDefinition): Uint8Array {
  const { root, port, distribution, capturedPath } = definition;
  if (!/^S-1-[0-9-]+$/.test(target.sid)) throw new InvalidDefinitionInput('The task needs the user SID');
  const installRoot = windowsInstallRoot(distribution);
  for (const value of [root, installRoot]) windowsPath(value);
  const description = `${WINDOWS_TASK_MARKER}${asciiJson({ root, port, distribution: { kind: distribution.kind, executable: distribution.executable, entry: distribution.entry }, capturedPath })}`;
  const sid = xml(target.sid);
  const text = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xml(description)}</Description>`,
    '  </RegistrationInfo>',
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    // Normal priority: the default 7 is below normal for CPU, I/O and memory, and the daemon's agents inherit it.
    '    <Priority>4</Priority>',
    '    <Hidden>true</Hidden>',
    '    <Enabled>true</Enabled>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author"><Exec>',
    `    <Command>${xml(WINDOWS_TASK_HOST)}</Command>`,
    `    <Arguments>${xml(windowsArguments(distribution.executable, port, root))}</Arguments>`,
    `    <WorkingDirectory>${xml(installRoot)}</WorkingDirectory>`,
    '  </Exec></Actions>',
    '</Task>',
    '',
  ].join('\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/** Task Scheduler serializes text its own way: entities, character references, or the bare character. */
function unxmlText(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/u.test(value)) throw new Error('Invalid XML literal');
  return value.replace(/&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g, (_, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name] ?? '';
  });
}

/** One element's text, unescaped; it must appear exactly once in `scope`, and the error names it. */
function element(scope: string, name: string): string {
  const matches = [...scope.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, 'g'))];
  if (matches.length !== 1) throw new Error(`Task ${name} is ${matches.length === 0 ? 'missing' : 'repeated'}`);
  return unxmlText(matches[0]?.[1] ?? '').trim();
}

const unquote = (value: string): string => /^".*"$/.test(value) ? value.slice(1, -1) : value;

/**
 * Piped, `schtasks /Query /XML` writes the console's code page, not UTF-16 (I4a review F1): a non-ASCII character of a
 * path comes back as one to four bytes, `?` or a best-fit letter. Read one byte per character, the ASCII around it must
 * still match; each run of non-ASCII characters in `expected` stands for any one to four characters per character.
 */
function lossyEqual(actual: string, expected: string): boolean {
  if (!/[^\x00-\x7f]/.test(expected) || expected.length > 4096) return false;
  const pattern = expected.replace(/[^\x00-\x7f]+|[\x00-\x7f]/g, part => /[^\x00-\x7f]/.test(part)
    ? `[^\\r\\n]{1,${part.length * 4}}` : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${pattern}$`, 'i').test(actual);
}

/**
 * I4a §4.2: the XML `schtasks` gives back is its own serialization, so nothing is compared byte for byte. Five fixed
 * elements decide: the Description marker and its JSON (ASCII, so exact in any code page), the Command (conhost, any
 * case), the Arguments (the launcher, port and data root; see lossyEqual), the Principal's UserId (this user, when it is
 * a SID) and RunLevel (LeastPrivilege, its default when left out).
 */
function decodeTask(target: Extract<Target, { platform: 'win32' }>, bytes: Uint8Array): DecodedDefinition {
  const text = decodeConsoleText(bytes);
  const description = element(text, 'Description');
  if (!description.startsWith(WINDOWS_TASK_MARKER)) throw new Error('Task Description lacks the vonvon-bot service marker');
  let recorded: unknown;
  try { recorded = JSON.parse(description.slice(WINDOWS_TASK_MARKER.length)); }
  catch { throw new Error('Task Description JSON is malformed'); }
  const fields = recorded as Partial<{ root: unknown; port: unknown; capturedPath: unknown; distribution: Partial<Record<'kind' | 'executable' | 'entry', unknown>> }> | null;
  const d = fields?.distribution;
  if (typeof fields?.root !== 'string' || typeof fields.port !== 'number' || typeof fields.capturedPath !== 'string'
    || typeof d !== 'object' || d === null || d.kind !== 'standalone' || typeof d.executable !== 'string' || typeof d.entry !== 'string') {
    throw new Error('Task Description JSON lacks root, port, distribution or capturedPath');
  }
  const definition: DecodedDefinition = { root: fields.root, port: fields.port, capturedPath: fields.capturedPath, distribution: { kind: 'standalone', executable: d.executable, entry: d.entry } };
  // Checks the recorded fields as install would; throws on any it would refuse.
  render(target, definition);
  const command = unquote(element(text, 'Command'));
  if (command.toLowerCase() !== WINDOWS_TASK_HOST.toLowerCase()) throw new Error(`Task Command runs ${command}, not ${WINDOWS_TASK_HOST}`);
  const spaced = (value: string): string => value.replace(/[ \t\r\n]+/g, ' ').trim();
  const args = element(text, 'Arguments');
  const expected = spaced(windowsArguments(d.executable, definition.port, definition.root));
  const bytewise = (): string => { try { return spaced(element(Buffer.from(bytes).toString('latin1'), 'Arguments')); } catch { return ''; } };
  if (spaced(args).toLowerCase() !== expected.toLowerCase() && !lossyEqual(bytewise(), expected)) throw new Error(`Task Arguments are ${args}`);
  const principal = /<Principal(?:\s[^>]*)?>([\s\S]*?)<\/Principal>/.exec(text)?.[1];
  if (principal === undefined) throw new Error('Task Principal is missing');
  const user = element(principal, 'UserId');
  if (/^S-1-/i.test(user) && user.toUpperCase() !== target.sid.toUpperCase()) throw new Error(`Task runs as ${user}, not this user`);
  const level = /<RunLevel>/.test(principal) ? element(principal, 'RunLevel') : 'LeastPrivilege';
  if (level !== 'LeastPrivilege') throw new Error(`Task RunLevel is ${level}`);
  return definition;
}

/** Whether Task Scheduler has the task enabled: `<Settings><Enabled>false` is a disabled task, whatever the UI language. */
export function windowsTaskEnabled(bytes: Uint8Array): boolean {
  const settings = /<Settings(?:\s[^>]*)?>([\s\S]*?)<\/Settings>/.exec(decodeConsoleText(bytes))?.[1] ?? '';
  // Settings' own Enabled, not one nested in IdleSettings or elsewhere.
  const own = settings.replace(/<(\w+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, (whole, name: string) => name === 'Enabled' ? whole : '');
  return !/<Enabled>\s*false\s*<\/Enabled>/.test(own);
}

/** `<installRoot>/current/node/bin/node <installRoot>/current/app/bin/vonvon.mjs`, as distribution.ts serviceProgram writes it. */
function isStandaloneProgram(executable: string, entry: string): boolean {
  const suffix = '/current/app/bin/vonvon.mjs';
  return entry.endsWith(suffix) && executable === `${entry.slice(0, -suffix.length)}/current/node/bin/node`;
}

function capture(text: string, pattern: RegExp): string[] {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Missing or duplicate definition field');
  const match = matches[0];
  if (!match) throw new Error('Missing definition field');
  return match.slice(1);
}
function field(text: string, pattern: RegExp): string {
  const value = capture(text, pattern)[0];
  if (value === undefined) throw new Error('Missing definition value');
  return value;
}

export function decodeGeneratedDefinition(target: Target, bytes: SerializedDefinition): DecodedDefinition {
  if (target.platform !== bytes.platform) throw new Error('Platform mismatch');
  if (target.platform === 'win32' && bytes.platform === 'win32') return decodeTask(target, bytes.xml);
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let root: string;
  let capturedPath: string;
  let executable: string;
  let entry: string;
  let port: number;
  let desktop: boolean;
  switch (bytes.platform) {
    case 'win32': throw new Error('Platform mismatch');
    case 'darwin': {
      const text = utf8.decode(bytes.plist);
      root = unxml(field(text, /<key>VONVON_HOME<\/key><string>([^<]*)<\/string>/g));
      capturedPath = unxml(field(text, /<key>PATH<\/key><string>([^<]*)<\/string>/g));
      const args = capture(text, /<key>ProgramArguments<\/key><array><string>([^<]*)<\/string><string>([^<]*)<\/string><string>daemon<\/string><string>run<\/string><string>--port<\/string><string>([0-9]+)<\/string><\/array>/g);
      executable = unxml(args[0] ?? ''); entry = unxml(args[1] ?? ''); port = Number(args[2]);
      desktop = text.includes('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>\n');
      break;
    }
    case 'linux': {
      const text = utf8.decode(bytes.unit);
      root = ununit(field(text, /^Environment="VONVON_HOME=((?:\\.|[^"\\])*)"$/gm));
      capturedPath = ununit(field(text, /^Environment="PATH=((?:\\.|[^"\\])*)"$/gm));
      const args = capture(text, /^ExecStart="((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)" daemon run --port ([0-9]+)$/gm);
      executable = ununit(args[0] ?? ''); entry = ununit(args[1] ?? '', true); port = Number(args[2]);
      desktop = text.includes('Environment="ELECTRON_RUN_AS_NODE=1"\n');
      break;
    }
  }
  const standalone = !desktop && isStandaloneProgram(executable, entry);
  const definition: DecodedDefinition = { root, capturedPath, port, distribution: { kind: desktop ? 'desktop' : standalone ? 'standalone' : 'npm', executable, entry } };
  const expected = render(target, definition);
  if (bytes.platform === 'darwin' && expected.platform === 'darwin' && Buffer.from(bytes.plist).equals(expected.plist)) return definition;
  if (bytes.platform === 'linux' && expected.platform === 'linux' && Buffer.from(bytes.unit).equals(expected.unit)) return definition;
  throw new Error('Definition does not match the complete generated format');
}
